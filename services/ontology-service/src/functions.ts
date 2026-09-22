/**
 * Functions: named computations over the ontology that a person approved.
 *
 * The problem this solves is narrow and concrete. The assistant may only use
 * metrics that already exist — it is forbidden from inventing an object type
 * or a KPI, and rightly so. But asked for something the catalogue does not
 * cover ("distance travelled by month") it can only say no, and the
 * conversation dead-ends.
 *
 * A function is the way out. The assistant DRAFTS one and it lands as
 * `proposed`; nothing computes from it and no dashboard may use it. A person
 * reads the definition, sees which views it touches, and approves it. Only
 * then does it become usable.
 *
 * ── what is frozen ─────────────────────────────────────────────────────────
 * function_rid and api_name never change after creation. Dashboards, saved
 * queries and the assistant all reference a function by one of them, so an
 * edit would silently repoint or break every one of those. The UI shows them
 * as read-only and this module refuses to update them — the guarantee has to
 * hold on the server, since a read-only input is only a hint.
 */

import { query, queryOne } from "./db";
import { compileNode, type InputRelation, NotExecutable } from "./compile";
import { BadRequest, currentSpace, getRegistry, NotFound } from "./registry";

export interface FunctionParameter {
	name: string;
	type: string;
	description?: string | null;
	required?: boolean;
	default?: unknown;
}

export interface FunctionRecord {
	id: number;
	rid: string;
	apiName: string;
	name: string;
	description: string | null;
	businessQuestion: string | null;
	language: "sql" | "python" | "typescript";
	definition: string;
	returns: "scalar" | "table";
	returnType: string | null;
	unit: string | null;
	valueFormat: string;
	parameters: FunctionParameter[];
	readsViews: string[];
	readsObjectTypes: string[];
	status: "proposed" | "active" | "rejected" | "archived";
	proposedBy: string;
	proposedFrom: string | null;
	approvedBy: string | null;
	approvedAt: string | null;
	version: number;
	createdAt: string;
	createdBy: string;
	updatedAt: string;
	spaceSlug: string;
	/** False for python/typescript: no sandbox exists here to run them in. */
	isExecutable: boolean;
	/** Why, when it is not. Shown in the UI rather than left to be guessed. */
	notExecutableReason: string | null;
}

type Row = {
	function_id: number;
	function_rid: string;
	api_name: string;
	name: string;
	description: string | null;
	business_question: string | null;
	language: FunctionRecord["language"];
	definition: string;
	returns: FunctionRecord["returns"];
	return_type: string | null;
	unit: string | null;
	value_format: string;
	parameters: FunctionParameter[];
	reads_views: string[];
	reads_object_types: string[];
	status: FunctionRecord["status"];
	proposed_by: string;
	proposed_from: string | null;
	approved_by: string | null;
	approved_at: Date | null;
	version: number;
	created_at: Date;
	created_by: string;
	updated_at: Date;
	space_slug: string;
};

const NOT_EXECUTABLE: Record<string, string> = {
	python:
		"Python functions are stored and reviewable, but this deployment has no sandboxed " +
		"runtime to execute them in. Use a SQL function for anything that must produce a number.",
	typescript:
		"TypeScript functions are stored and reviewable, but this deployment has no sandboxed " +
		"runtime to execute them in. Use a SQL function for anything that must produce a number.",
};

function toRecord(row: Row): FunctionRecord {
	return {
		id: row.function_id,
		rid: row.function_rid,
		apiName: row.api_name,
		name: row.name,
		description: row.description,
		businessQuestion: row.business_question,
		language: row.language,
		definition: row.definition,
		returns: row.returns,
		returnType: row.return_type,
		unit: row.unit,
		valueFormat: row.value_format,
		parameters: row.parameters ?? [],
		readsViews: row.reads_views ?? [],
		readsObjectTypes: row.reads_object_types ?? [],
		status: row.status,
		proposedBy: row.proposed_by,
		proposedFrom: row.proposed_from,
		approvedBy: row.approved_by,
		approvedAt: row.approved_at?.toISOString() ?? null,
		version: row.version,
		createdAt: row.created_at.toISOString(),
		createdBy: row.created_by,
		updatedAt: row.updated_at.toISOString(),
		spaceSlug: row.space_slug,
		isExecutable: row.language === "sql",
		notExecutableReason: NOT_EXECUTABLE[row.language] ?? null,
	};
}

const SELECT = `
	SELECT f.*, s.slug AS space_slug
	  FROM platform.function f
	  JOIN platform.space s ON s.space_id = f.space_id`;

// ── naming ──────────────────────────────────────────────────────────────────

/**
 * Turn a human name into the two identifiers that are then frozen forever.
 *
 * Derived rather than accepted from the caller: an api name is a
 * programmatic handle, and letting a proposal supply one invites a collision
 * with an existing metric or an object type property.
 */
export function deriveNames(name: string): { rid: string; apiName: string } {
	const words = name
		.trim()
		.replace(/[^A-Za-z0-9\s_-]/g, " ")
		.split(/[\s_-]+/)
		.filter(Boolean);

	if (words.length === 0) {
		throw new BadRequest("A function needs a name with at least one letter or digit.");
	}

	const snake = words.map((w) => w.toLowerCase()).join("_");
	const camel = words
		.map((word, index) =>
			index === 0
				? word.toLowerCase()
				: word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
		)
		.join("");

	return { rid: `fn:${snake}`, apiName: camel };
}

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Check a SQL definition really runs, without saving anything.
 *
 * Compiled through the same path as a pipeline node, so a function gets the
 * identical guarantees: single SELECT, no stacked statements, and every
 * relation it names checked against the published ontology. A proposal that
 * does not compile is refused at draft time rather than discovered later by
 * whoever opens the dashboard.
 */
export async function validateDefinition(
	definition: string,
	language: string,
): Promise<{ valid: boolean; error: string | null; readsViews: string[]; columns: string[] }> {
	if (language !== "sql") {
		// Nothing to validate: it will not be executed here, and pretending to
		// syntax-check another language would be theatre.
		return { valid: true, error: null, readsViews: [], columns: [] };
	}

	// 1. Shape. Single SELECT, no stacked statements, no writes.
	let compiledSql: string;
	try {
		compiledSql = compileNode(
			{
				id: "fn",
				kind: "sql",
				name: "function",
				position: { x: 0, y: 0 },
				config: { sql: definition },
			} as never,
			[] as InputRelation[],
		).sql;
	} catch (error) {
		return { valid: false, error: (error as Error).message, readsViews: [], columns: [] };
	}

	// 2. Which published views it names. Shown to the approver, and a
	//    definition that reads nothing published is not traceable to real data.
	const registry = getRegistry();
	const known = [
		...new Set([
			...registry.objectTypes.map((t) => t.sourceView),
			...registry.kpis.map((k) => k.sourceView),
		]),
	];
	const readsViews = known.filter((view) =>
		// The view name is escaped before it becomes a pattern: it contains a dot,
		// which would otherwise match any character and report a view the
		// definition does not actually read.
		new RegExp(`\\b${view.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(definition),
	);

	if (readsViews.length === 0) {
		return {
			valid: false,
			error:
				"This definition does not read any view the published ontology exposes. " +
				"A function has to be traceable to real data.",
			readsViews: [],
			columns: [],
		};
	}

	// 3. IT ACTUALLY RUNS. Checking the shape is not enough and the gap was not
	//    hypothetical: the assistant's first real proposal used the ontology's
	//    camelCase api names (plannedStartMonth) where the view has snake_case
	//    columns (planned_start_month). It passed every check above and failed
	//    the moment anyone ran it — which is precisely the reviewer's time this
	//    validation exists to protect.
	//
	//    LIMIT 0 plans and executes without materialising rows, so an unknown
	//    column, a bad cast or a type mismatch is caught here, cheaply.
	try {
		const probe = await query(`SELECT * FROM (${compiledSql}) AS _probe LIMIT 0`);
		return {
			valid: true,
			error: null,
			readsViews,
			// The fields the result will have, which the dialog can show.
			columns: probe.length > 0 ? Object.keys(probe[0]!) : [],
		};
	} catch (error) {
		return {
			valid: false,
			error: (error as Error).message,
			readsViews,
			columns: [],
		};
	}
}

/** The columns a definition returns, read from the catalogue after a probe. */
export async function definitionColumns(definition: string): Promise<string[]> {
	const check = await validateDefinition(definition, "sql");
	return check.columns;
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function listFunctions(status?: string): Promise<FunctionRecord[]> {
	const rows = await query<Row>(
		`${SELECT}
		  WHERE s.slug = $1
		    AND ($2::text IS NULL OR f.status = $2)
		  ORDER BY
		    -- Proposals first: they are the ones waiting on somebody.
		    CASE f.status WHEN 'proposed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
		    f.updated_at DESC`,
		[currentSpace(), status ?? null],
	);
	return rows.map(toRecord);
}

export async function getFunction(apiName: string): Promise<FunctionRecord> {
	const row = await queryOne<Row>(
		`${SELECT} WHERE s.slug = $1 AND (f.api_name = $2 OR f.function_rid = $2)`,
		[currentSpace(), apiName],
	);
	if (!row) throw new NotFound(`No function '${apiName}' in the '${currentSpace()}' space.`);
	return toRecord(row);
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface ProposeFunctionRequest {
	name: string;
	description?: string;
	businessQuestion?: string;
	language?: string;
	definition: string;
	returns?: string;
	returnType?: string;
	unit?: string;
	valueFormat?: string;
	parameters?: FunctionParameter[];
	readsObjectTypes?: string[];
	proposedFrom?: string;
}

/**
 * Record a draft. Deliberately creates nothing usable.
 *
 * Status is always 'proposed' here, whoever calls it — the assistant and a
 * human drafting by hand land in the same place. Approval is a separate,
 * explicit act with a separate audit trail.
 */
export async function proposeFunction(
	request: ProposeFunctionRequest,
	proposedBy: string,
): Promise<FunctionRecord> {
	const name = String(request.name ?? "").trim();
	if (!name) throw new BadRequest("A function needs a name.");

	const definition = String(request.definition ?? "").trim();
	if (!definition) throw new BadRequest("A function needs a definition.");

	const language = String(request.language ?? "sql").toLowerCase();
	if (!["sql", "python", "typescript"].includes(language)) {
		throw new BadRequest(`'${language}' is not a supported language.`);
	}

	const check = await validateDefinition(definition, language);
	if (!check.valid) {
		throw new BadRequest(`This definition will not run: ${check.error}`);
	}

	const { rid, apiName } = deriveNames(name);

	// A name that collides with a published metric would make "which one did
	// this dashboard mean" unanswerable.
	const registry = getRegistry();
	if (registry.kpiByApiName.has(apiName)) {
		throw new BadRequest(
			`'${apiName}' is already a published KPI. Give the function a distinct name.`,
		);
	}

	const existing = await queryOne<{ status: string }>(
		`SELECT f.status FROM platform.function f
		   JOIN platform.space s ON s.space_id = f.space_id
		  WHERE s.slug = $1 AND f.api_name = $2`,
		[currentSpace(), apiName],
	);
	if (existing) {
		throw new BadRequest(
			`A function called '${apiName}' already exists here (${existing.status}). ` +
				`Open it rather than proposing a second one.`,
		);
	}

	const row = await queryOne<Row>(
		`INSERT INTO platform.function
		   (space_id, function_rid, api_name, name, description, business_question,
		    language, definition, returns, return_type, unit, value_format,
		    parameters, reads_views, reads_object_types, status, proposed_by,
		    proposed_from, created_by)
		 SELECT s.space_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
		        $13::jsonb, $14::text[], $15::text[], 'proposed', $16, $17, $16
		   FROM platform.space s WHERE s.slug = $1
		 RETURNING function_id`,
		[
			currentSpace(),
			rid,
			apiName,
			name,
			request.description ?? null,
			request.businessQuestion ?? null,
			language,
			definition,
			request.returns ?? "scalar",
			request.returnType ?? null,
			request.unit ?? null,
			request.valueFormat ?? "number",
			JSON.stringify(request.parameters ?? []),
			check.readsViews,
			request.readsObjectTypes ?? [],
			proposedBy,
			request.proposedFrom ?? null,
		],
	);
	if (!row) throw new BadRequest(`No space '${currentSpace()}' to create the function in.`);

	return getFunction(apiName);
}

/** Fields a person may change. rid and apiName are deliberately absent. */
export interface UpdateFunctionRequest {
	name?: string;
	description?: string;
	businessQuestion?: string;
	definition?: string;
	returns?: string;
	returnType?: string;
	unit?: string;
	valueFormat?: string;
	parameters?: FunctionParameter[];
}

/**
 * Edit a proposal before approving it.
 *
 * Note what cannot be passed: rid and api_name are not on the request type and
 * are not written below. The UI renders them read-only, but a read-only input
 * is a hint to a browser, not a rule — the rule lives here.
 *
 * Editing the definition bumps the version, so a function_run recorded against
 * version 2 is not attributed to the text of version 3.
 */
export async function updateFunction(
	apiName: string,
	request: UpdateFunctionRequest,
	updatedBy: string,
): Promise<FunctionRecord> {
	const current = await getFunction(apiName);

	if (current.status === "active") {
		// An approved function is what a dashboard already renders. Changing it
		// in place would alter numbers nobody re-approved.
		throw new BadRequest(
			`'${current.apiName}' is active. Archive it and propose a replacement rather than ` +
				`editing a definition other things already use.`,
		);
	}

	const definition = request.definition?.trim() ?? current.definition;
	const check = await validateDefinition(definition, current.language);
	if (!check.valid) {
		throw new BadRequest(`This definition will not run: ${check.error}`);
	}

	const definitionChanged = definition !== current.definition;

	await query(
		`UPDATE platform.function
		    SET name = $3, description = $4, business_question = $5, definition = $6,
		        returns = $7, return_type = $8, unit = $9, value_format = $10,
		        parameters = $11::jsonb, reads_views = $12::text[],
		        version = version + $13, updated_at = now(), updated_by = $14
		  WHERE function_id = $1 AND space_id = (SELECT space_id FROM platform.space WHERE slug = $2)`,
		[
			current.id,
			currentSpace(),
			request.name?.trim() || current.name,
			request.description ?? current.description,
			request.businessQuestion ?? current.businessQuestion,
			definition,
			request.returns ?? current.returns,
			request.returnType ?? current.returnType,
			request.unit ?? current.unit,
			request.valueFormat ?? current.valueFormat,
			JSON.stringify(request.parameters ?? current.parameters),
			check.readsViews.length ? check.readsViews : current.readsViews,
			definitionChanged ? 1 : 0,
			updatedBy,
		],
	);

	return getFunction(current.apiName);
}

/**
 * Approve a proposal, making it usable.
 *
 * The approver is recorded separately from the proposer so the audit can say
 * "the assistant drafted this and a named person approved it" — which is the
 * whole point of the proposed/active split.
 */
export async function approveFunction(
	apiName: string,
	approvedBy: string,
): Promise<FunctionRecord> {
	const current = await getFunction(apiName);

	if (current.status === "active") return current;
	if (current.status === "archived") {
		throw new BadRequest(`'${current.apiName}' is archived. Propose a replacement instead.`);
	}

	// Re-checked at approval, not just at proposal: the ontology may have been
	// republished since the draft was written, and a view it reads may be gone.
	const check = await validateDefinition(current.definition, current.language);
	if (!check.valid) {
		throw new BadRequest(
			`This function no longer runs against the current ontology: ${check.error}`,
		);
	}

	await query(
		`UPDATE platform.function
		    SET status = 'active', approved_by = $2, approved_at = now(),
		        updated_at = now(), updated_by = $2
		  WHERE function_id = $1`,
		[current.id, approvedBy],
	);
	return getFunction(current.apiName);
}

export async function setFunctionStatus(
	apiName: string,
	status: "rejected" | "archived",
	actor: string,
): Promise<FunctionRecord> {
	const current = await getFunction(apiName);
	await query(
		`UPDATE platform.function
		    SET status = $2, updated_at = now(), updated_by = $3
		  WHERE function_id = $1`,
		[current.id, status, actor],
	);
	return getFunction(current.apiName);
}

// ── execution ───────────────────────────────────────────────────────────────

export interface FunctionResult {
	apiName: string;
	status: "success" | "failed";
	returns: "scalar" | "table";
	value: unknown;
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	durationMs: number;
	sql: string | null;
	error: string | null;
	runId: number | null;
}

const MAX_ROWS = 500;
/** Kept small: this goes into every audit row, not just the response. */
const MAX_RECORDED_ROWS = 20;

/**
 * Run an approved function.
 *
 * Only `active` functions run. A proposal is explicitly not executable, so a
 * dashboard cannot start rendering numbers from something nobody signed off —
 * which would defeat the approval step entirely.
 */
export async function runFunction(
	apiName: string,
	triggeredBy: string,
	allowProposed = false,
): Promise<FunctionResult> {
	const fn = await getFunction(apiName);
	const started = Date.now();

	if (!fn.isExecutable) {
		throw new BadRequest(fn.notExecutableReason ?? `'${fn.apiName}' cannot be executed here.`);
	}
	if (fn.status !== "active" && !allowProposed) {
		throw new BadRequest(
			`'${fn.apiName}' is ${fn.status}, not active. Approve it before running it.`,
		);
	}

	let sql: string | null = null;
	try {
		const compiled = compileNode(
			{
				id: "fn",
				kind: "sql",
				name: fn.name,
				position: { x: 0, y: 0 },
				config: { sql: fn.definition },
			} as never,
			[] as InputRelation[],
		);
		sql = compiled.sql;

		// Wrapped as a subquery for the same reason the pipeline engine wraps
		// node SQL: a non-SELECT is a syntax error in that position, and a
		// data-modifying CTE is rejected by Postgres outside the top level.
		const rows = await query(`SELECT * FROM (${compiled.sql}) AS _fn LIMIT ${MAX_ROWS}`);
		const durationMs = Date.now() - started;

		// A scalar function returns the first column of the first row: that is
		// what a KPI tile renders.
		const firstRow = rows[0];
		const value =
			fn.returns === "scalar" && firstRow ? Object.values(firstRow)[0] ?? null : null;

		const run = await queryOne<{ function_run_id: number }>(
			`INSERT INTO platform.function_run
			   (function_id, version, status, finished_at, duration_ms, row_count,
			    result, sql_text, triggered_by)
			 VALUES ($1,$2,'success',now(),$3,$4,$5::jsonb,$6,$7)
			 RETURNING function_run_id`,
			[
				fn.id,
				fn.version,
				durationMs,
				rows.length,
				JSON.stringify(
					fn.returns === "scalar" ? { value } : rows.slice(0, MAX_RECORDED_ROWS),
				),
				sql,
				triggeredBy,
			],
		);

		return {
			apiName: fn.apiName,
			status: "success",
			returns: fn.returns,
			value,
			rows,
			rowCount: rows.length,
			durationMs,
			sql,
			error: null,
			runId: run?.function_run_id ?? null,
		};
	} catch (error) {
		const durationMs = Date.now() - started;
		const message = (error as Error).message;

		// A failure is recorded, not just thrown: "this metric has failed on
		// every run since Tuesday" is only answerable if failures are rows.
		const run = await queryOne<{ function_run_id: number }>(
			`INSERT INTO platform.function_run
			   (function_id, version, status, finished_at, duration_ms, sql_text,
			    error_message, triggered_by)
			 VALUES ($1,$2,'failed',now(),$3,$4,$5,$6)
			 RETURNING function_run_id`,
			[fn.id, fn.version, durationMs, sql, message, triggeredBy],
		);

		return {
			apiName: fn.apiName,
			status: "failed",
			returns: fn.returns,
			value: null,
			rows: [],
			rowCount: 0,
			durationMs,
			sql,
			error: message,
			runId: run?.function_run_id ?? null,
		};
	}
}

/** Execution history for one function — §11's "execution history and logs". */
export async function functionRuns(
	apiName: string,
	limit = 25,
): Promise<Array<Record<string, unknown>>> {
	const fn = await getFunction(apiName);
	const bounded = Math.min(Math.max(1, limit), 100);
	const rows = await query<{
		function_run_id: number;
		version: number;
		status: string;
		started_at: Date;
		duration_ms: number | null;
		row_count: string | null;
		result: unknown;
		error_message: string | null;
		triggered_by: string;
	}>(
		`SELECT function_run_id, version, status, started_at, duration_ms, row_count,
		        result, error_message, triggered_by
		   FROM platform.function_run
		  WHERE function_id = $1
		  ORDER BY started_at DESC
		  LIMIT ${bounded}`,
		[fn.id],
	);

	return rows.map((row) => ({
		id: row.function_run_id,
		version: row.version,
		status: row.status,
		startedAt: row.started_at.toISOString(),
		durationMs: row.duration_ms,
		rowCount: row.row_count === null ? null : Number(row.row_count),
		result: row.result,
		error: row.error_message,
		triggeredBy: row.triggered_by,
	}));
}
