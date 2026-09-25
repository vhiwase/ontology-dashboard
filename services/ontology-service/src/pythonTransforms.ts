/**
 * Running a Python transform from a code repository.
 *
 * A SQL transform compiles to one SELECT and the database does the work. A
 * Python transform is code, and code has to run somewhere — so this is the
 * honest description of where: a `python3` subprocess inside this container,
 * given the rows it declared and nothing else.
 *
 * ── the two passes, and why ─────────────────────────────────────────────────
 * The service cannot know which relations to read until it has seen the
 * decorator, and cannot hand rows over until it has read them:
 *
 *   1. declare  — import the module, report its Input(...)s and its Output(...)
 *   2. read     — HERE, in Node, against the platform's own pool
 *   3. execute  — run the function with those rows, take back what it wrote
 *   4. write    — materialise the result as a table, register it as a dataset
 *
 * Step 2 is deliberately on this side of the boundary. The transform never
 * holds a database handle, so the relations it may read are decided here,
 * against the same allow-list a dataset resource is checked against, and a
 * transform naming anything else is refused by name before any of it runs.
 *
 * ── what this is and is not ─────────────────────────────────────────────────
 * It is an ordinary process with an empty environment, a time limit, an output
 * cap and no credentials. It is NOT a sandbox against a determined adversary:
 * it shares a container with the service, and anyone who can commit to a
 * repository and press Build can run code here. That is the same trust as
 * being able to write a SQL node, and the route is gated at the same role —
 * but it is a larger surface, and pretending otherwise would be the dishonest
 * half of the feature.
 *
 * ── the rule that makes the kind coherent ───────────────────────────────────
 * A transform MUST produce a dataset. No Output declared, or an Output that is
 * never written to, fails the build and says which. A repository whose build
 * goes green without producing anything is precisely the outcome this rule
 * exists to prevent.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isPlatformWrittenRelation, PLATFORM_WRITTEN_SCHEMAS } from "./connections";
import { columnsOfRows, columnTypeFor } from "./inferTypes";
import { pool, query, queryOne } from "./db";
import { BadRequest, currentSpace, getRegistry, hasOntology, quoteIdentifier } from "./registry";

const run = promisify(execFile);

/** Where the runner lives in the image, beside the compiled service. */
const RUNNER = process.env.PYTHON_RUNNER_PATH ?? join(__dirname, "..", "python", "runner.py");
const PYTHON = process.env.PYTHON_BIN ?? "python3";

/** How long one transform may run before the engine gives up on it. */
const TIMEOUT_MS = Number(process.env.PYTHON_TRANSFORM_TIMEOUT_MS ?? 60_000);

/** How many rows one transform may read, and write. Both are real bounds. */
const MAX_INPUT_ROWS = Number(process.env.PYTHON_TRANSFORM_MAX_INPUT_ROWS ?? 200_000);
const MAX_OUTPUT_ROWS = Number(process.env.PYTHON_TRANSFORM_MAX_OUTPUT_ROWS ?? 200_000);

/** The most JSON the runner may hand back, so a runaway cannot exhaust memory. */
const MAX_OUTPUT_BYTES = Number(process.env.PYTHON_TRANSFORM_MAX_OUTPUT_BYTES ?? 64 * 1024 * 1024);

/** Rows per INSERT is bounded by PostgreSQL's 65535 parameters per statement. */
const MAX_PARAMS_PER_INSERT = 60_000;

export const PYTHON_OUTPUT_SCHEMA = "repo_out";

export interface TransformDeclaration {
	output: string | null;
	inputs: Record<string, string>;
	functionName: string;
	log: string;
}

export interface TransformResult {
	output: string;
	outputTable: string;
	rowsWritten: number;
	rowsRead: number;
	columns: Array<{ name: string; type: string }>;
	/** Anything the transform printed, which is where print() is useful. */
	log: string;
}

type RunnerResponse = {
	ok: boolean;
	error?: string;
	traceback?: string;
	output?: string | null;
	inputs?: Record<string, string>;
	function?: string;
	rows?: Array<Record<string, unknown>>;
	rowCount?: number;
	log?: string;
};

/**
 * Raised for a fault in the transform, as opposed to a fault in this service.
 *
 * Carries the build's message verbatim: whoever reads a failed build needs the
 * line number and the exception, not a summary of them.
 */
export class TransformFailed extends Error {
	readonly status = 400;
	constructor(
		message: string,
		readonly detail: string | null = null,
	) {
		super(message);
	}
}

/**
 * Invoke the runner.
 *
 * The environment is replaced, not extended: DATABASE_URL, the JWT secret and
 * every other variable this process holds would otherwise be readable by
 * `os.environ` inside the transform. PATH is kept because python3 needs it,
 * and PYTHONDONTWRITEBYTECODE because the image runs read-only-ish and a
 * __pycache__ write failure is not worth a build failure.
 */
async function invoke(args: string[]): Promise<RunnerResponse> {
	try {
		const { stdout, stderr } = await run(PYTHON, [RUNNER, ...args], {
			timeout: TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			env: {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONIOENCODING: "utf-8",
				HOME: "/tmp",
			},
			windowsHide: true,
		});
		void stderr;
		return JSON.parse(stdout) as RunnerResponse;
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			killed?: boolean;
			code?: string | number;
		};

		// A non-zero exit is how the runner reports a transform's own failure,
		// and it still printed its JSON. That is a result, not a crash.
		if (failure.stdout) {
			try {
				return JSON.parse(failure.stdout) as RunnerResponse;
			} catch {
				/* fall through to the harder failures below */
			}
		}

		if (failure.killed) {
			throw new TransformFailed(
				`The transform was still running after ${Math.round(TIMEOUT_MS / 1000)} s and was stopped. ` +
					"Narrow what it reads, or move the heavy part into SQL.",
			);
		}
		if (failure.code === "ENOENT") {
			throw new TransformFailed(
				`No Python runtime on this service (${PYTHON}). A Python repository cannot be built here; ` +
					"rebuild the ontology-service image, which installs it.",
			);
		}
		if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new TransformFailed(
				"The transform returned more data than a build may carry. Aggregate before writing.",
			);
		}
		throw new TransformFailed(
			`The transform could not be run: ${failure.message}`,
			failure.stderr ?? null,
		);
	}
}

// ── which relations a transform may read ────────────────────────────────────

/**
 * Check a declared Input against what this space actually exposes.
 *
 * The same rule a dataset resource is held to, and for the same reason: a
 * relation name is the one thing here that becomes SQL syntax, so it is
 * checked against the published ontology or against the schemas this platform
 * writes itself, and nothing else is reachable.
 */
export async function assertReadableRelation(relation: string): Promise<void> {
	const parts = relation.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new TransformFailed(
			`Input('${relation}') is not a schema-qualified relation, e.g. 'tms_views.v_order'.`,
		);
	}

	if (await isPlatformWrittenRelation(relation)) return;

	if (hasOntology(currentSpace())) {
		const registry = getRegistry();
		const published =
			registry.objectTypes.some((type) => type.sourceView === relation) ||
			registry.kpis.some((kpi) => kpi.sourceView === relation);
		if (published) return;
	}

	throw new TransformFailed(
		`Input('${relation}') is not readable. A transform may read a view the published ontology ` +
			`exposes, or a table this platform wrote itself (${PLATFORM_WRITTEN_SCHEMAS.join(", ")}).`,
	);
}

/** The output must land in repo_out, and must be a plain table name. */
export function assertWritableOutput(relation: string | null, path: string): {
	relation: string;
	table: string;
} {
	if (!relation) {
		throw new TransformFailed(
			`${path} declares no Output, so it can produce no dataset. Add one: ` +
				`@transform(output=Output("${PYTHON_OUTPUT_SCHEMA}.<table>"), ...).`,
		);
	}
	const [schema, table, ...rest] = relation.split(".");
	if (rest.length > 0 || !schema || !table) {
		throw new TransformFailed(`Output('${relation}') in ${path} is not a schema-qualified table.`);
	}
	if (schema !== PYTHON_OUTPUT_SCHEMA) {
		throw new TransformFailed(
			`${path} writes to '${relation}'. A transform may only write into ${PYTHON_OUTPUT_SCHEMA}: ` +
				"the view layer is the contract the ontology is generated from, and a build does not " +
				"get to overwrite it.",
		);
	}
	if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
		throw new TransformFailed(
			`'${table}' in ${path} is not a plain lower-case identifier, so it cannot be a table name.`,
		);
	}
	return { relation: `${schema}.${table}`, table };
}

// ── column types for what came back ─────────────────────────────────────────
//
//  Python has no schema to read a type from, so the types are inferred from
//  the values. That is the same problem a REST response poses, and it is
//  solved once, in inferTypes.ts, rather than twice slightly differently.

export { columnsOfRows, columnTypeFor };

/** A column name a transform produced, checked before it becomes an identifier. */
function assertColumnName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 63) {
		throw new TransformFailed(
			`'${name}' cannot be a column name. Use letters, digits and underscores, ` +
				"starting with a letter, at most 63 characters.",
		);
	}
	return name;
}

/**
 * Read a relation for a transform, with its numbers as numbers.
 *
 * The driver returns `bigint` and `numeric` as STRINGS — deliberately, because
 * neither fits a JavaScript double without loss. Handed to Python unchanged,
 * that turns `order["accessorial_count"] > 2` into a comparison between a str
 * and an int, which is a TypeError, and `sum(...)` into a concatenation. The
 * author did nothing wrong: the column IS a number, and it should arrive as
 * one.
 *
 * So the conversion is driven by the column's real type, read from the result
 * metadata, rather than by guessing from the value. Guessing would corrupt a
 * text column that happens to hold digits — an order number like "0012" would
 * arrive as 12 — and that is a wrong answer that looks right.
 *
 * A bigint outside JavaScript's safe integer range is LEFT as a string, since
 * converting it would silently change the value. That is rare enough to be
 * worth the inconsistency and dangerous enough to be worth the check.
 */
async function readRelationForPython(
	relation: string,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	const qualified = relation
		.split(".")
		.map((part) => quoteIdentifier(part))
		.join(".");
	const result = await pool.query(`SELECT * FROM ${qualified} LIMIT ${limit}`);

	// int8, numeric, float4, float8, int2, int4 — the OIDs pg assigns them.
	const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);
	const numericFields = result.fields
		.filter((field) => NUMERIC_OIDS.has(field.dataTypeID))
		.map((field) => field.name);
	if (numericFields.length === 0) return result.rows;

	return result.rows.map((row) => {
		const converted: Record<string, unknown> = { ...row };
		for (const name of numericFields) {
			const value = converted[name];
			if (typeof value !== "string") continue;
			const asNumber = Number(value);
			if (Number.isNaN(asNumber)) continue;
			if (Number.isInteger(asNumber) && !Number.isSafeInteger(asNumber)) continue;
			converted[name] = asNumber;
		}
		return converted;
	});
}

// ── the run ─────────────────────────────────────────────────────────────────

/** Pass 1: what does this file declare? */
export async function declareTransform(code: string, path: string): Promise<TransformDeclaration> {
	const directory = await mkdtemp(join(tmpdir(), "transform-"));
	try {
		const file = join(directory, "transform.py");
		await writeFile(file, code, "utf-8");
		const response = await invoke(["declare", file]);
		if (!response.ok) {
			throw new TransformFailed(`${path}: ${response.error ?? "could not be loaded."}`, response.traceback ?? null);
		}
		return {
			output: response.output ?? null,
			inputs: response.inputs ?? {},
			functionName: response.function ?? "?",
			log: response.log ?? "",
		};
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Run one Python transform and materialise what it wrote.
 *
 * Every failure mode below is reported with the file that caused it, because a
 * build acts on several files and "it failed" is not a useful thing to read.
 */
export async function runPythonTransform(code: string, path: string): Promise<TransformResult> {
	const declaration = await declareTransform(code, path);
	const { relation: outputRelation, table } = assertWritableOutput(declaration.output, path);

	// Read the inputs HERE, against the allow-list, so the transform never gets
	// to name a relation this service would not have read for it.
	const supplied: Record<string, Array<Record<string, unknown>>> = {};
	let rowsRead = 0;
	for (const relation of new Set(Object.values(declaration.inputs))) {
		await assertReadableRelation(relation);
		const rows = await readRelationForPython(relation, MAX_INPUT_ROWS + 1);
		if (rows.length > MAX_INPUT_ROWS) {
			throw new TransformFailed(
				`${path} reads ${relation}, which has more than ${MAX_INPUT_ROWS.toLocaleString("en-US")} rows. ` +
					"Aggregate it in SQL first, and read the result here.",
			);
		}
		supplied[relation] = rows;
		rowsRead += rows.length;
	}

	const directory = await mkdtemp(join(tmpdir(), "transform-"));
	let response: RunnerResponse;
	try {
		const file = join(directory, "transform.py");
		const data = join(directory, "inputs.json");
		await writeFile(file, code, "utf-8");
		await writeFile(data, JSON.stringify(supplied), "utf-8");
		response = await invoke(["execute", file, data]);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}

	if (!response.ok) {
		throw new TransformFailed(`${path}: ${response.error ?? "failed."}`, response.traceback ?? null);
	}

	const rows = response.rows ?? [];
	if (rows.length > MAX_OUTPUT_ROWS) {
		throw new TransformFailed(
			`${path} wrote ${rows.length.toLocaleString("en-US")} rows, over the ` +
				`${MAX_OUTPUT_ROWS.toLocaleString("en-US")} a build may materialise.`,
		);
	}

	const columns = columnsOfRows(rows);
	if (rows.length > 0 && columns.length === 0) {
		throw new TransformFailed(
			`${path} wrote ${rows.length} rows with no columns in them. Each row is a dict ` +
				"whose keys are the column names.",
		);
	}
	for (const column of columns) assertColumnName(column.name);

	await materialise(table, columns, rows);

	return {
		output: outputRelation,
		outputTable: table,
		rowsWritten: rows.length,
		rowsRead,
		columns,
		log: [declaration.log, response.log].filter(Boolean).join("").trim(),
	};
}

/**
 * Write the result.
 *
 * Replaced rather than appended to, in one transaction: a transform's output is
 * the result of the latest build, and a half-written table read by something
 * downstream is worse than no table.
 */
async function materialise(
	table: string,
	columns: Array<{ name: string; type: string }>,
	rows: Array<Record<string, unknown>>,
): Promise<void> {
	const target = `${quoteIdentifier(PYTHON_OUTPUT_SCHEMA)}.${quoteIdentifier(table)}`;

	// A transform that legitimately produced nothing still gets its table, with
	// no columns to describe it. Reported as such rather than left as last
	// build's table, which would quietly answer with stale rows.
	const definition =
		columns.length > 0
			? columns.map((column) => `${quoteIdentifier(column.name)} ${column.type}`).join(", ")
			: "_empty boolean";

	await query(`DROP TABLE IF EXISTS ${target}`);
	await query(`CREATE TABLE ${target} (${definition})`);
	if (rows.length === 0 || columns.length === 0) return;

	const perBatch = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS_PER_INSERT / columns.length)));
	const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");

	for (let start = 0; start < rows.length; start += perBatch) {
		const batch = rows.slice(start, start + perBatch);
		const values: unknown[] = [];
		const tuples = batch.map((row) => {
			const placeholders = columns.map((column) => {
				const value = row[column.name];
				values.push(
					value !== null && typeof value === "object" ? JSON.stringify(value) : (value ?? null),
				);
				return `$${values.length}`;
			});
			return `(${placeholders.join(", ")})`;
		});
		await query(`INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`, values);
	}
}

/** Whether a Python runtime is actually present, for the UI to say so up front. */
export async function pythonAvailable(): Promise<{ available: boolean; version: string | null }> {
	try {
		const { stdout } = await run(PYTHON, ["--version"], { timeout: 5000 });
		return { available: true, version: stdout.trim() };
	} catch {
		return { available: false, version: null };
	}
}

/** Kept for symmetry with the SQL path, which registers its dataset the same way. */
export async function relationRowCount(relation: string): Promise<number> {
	const row = await queryOne<{ n: string }>(
		`SELECT count(*)::text AS n FROM ${relation
			.split(".")
			.map((part) => quoteIdentifier(part))
			.join(".")}`,
	);
	return Number(row?.n ?? 0);
}
