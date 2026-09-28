/**
 * Eval suites for metric functions - this platform's slice of AIP Evals.
 *
 * A suite is a set of named cases; a case is a set of assertions over what a
 * function's SQL returns. Assertions are deterministic and cheap: bounds, row
 * counts, null checks. What a suite gives a function is what a build gives a
 * repository - a recorded answer to "does this still compute what it computed
 * when someone approved it", run again by anyone, any time.
 *
 * There is no LLM judge here, deliberately. A scorer that is itself a model
 * makes a passing suite a matter of opinion; these assertions either hold on
 * the result or name why they do not. (The assistant has its own eval suites,
 * run by the AI-FDE service against the live agent; they share these tables,
 * and their evaluators are likewise structural.)
 *
 * Case specs:
 *   scalar functions:  {"assertions": [{"kind": "equals", "value": 90.5, "tolerance": 0.01},
 *                                      {"kind": "between", "min": 0, "max": 100},
 *                                      {"kind": "gt", "value": 0}, {"kind": "lt", "value": 10},
 *                                      {"kind": "not_null"} | {"kind": "is_null"}]}
 *   table functions:   {"assertions": [{"kind": "rows_between", "min": 1, "max": 500},
 *                                      {"kind": "column_not_null", "column": "lane"},
 *                                      {"kind": "column_min", "column": "orders", "value": 1},
 *                                      {"kind": "column_max", "column": "weight_kg", "value": 1e9}]}
 */

import { query, queryOne } from "./db";
import { BadRequest, NotFound } from "./registry";
import { getFunction, runFunction } from "./functions";

export interface EvalAssertion {
	kind: string;
	[key: string]: unknown;
}

export interface EvalCaseSpec {
	assertions: EvalAssertion[];
}

export interface EvalCaseOutcome {
	case: string;
	ok: boolean;
	assertions: Array<{ kind: string; ok: boolean; detail: string }>;
	error?: string;
}

// ── assertion evaluation ────────────────────────────────────────────────────
// Pure functions, so a score means the same thing twice and the tests can
// exercise every kind without a database.

function num(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return null;
}

function assertScalar(assertion: EvalAssertion, value: unknown): { ok: boolean; detail: string } {
	switch (assertion.kind) {
		case "equals": {
			const expected = num(assertion.value);
			const actual = num(value);
			if (expected === null || actual === null) {
				return { ok: false, detail: `expected ${String(assertion.value)}, got ${String(value)}` };
			}
			const tolerance = num(assertion.tolerance) ?? 0;
			const ok = Math.abs(actual - expected) <= tolerance;
			return { ok, detail: `expected ${expected} (±${tolerance}), got ${actual}` };
		}
		case "between": {
			const actual = num(value);
			if (actual === null) return { ok: false, detail: `got non-numeric ${String(value)}` };
			const min = num(assertion.min);
			const max = num(assertion.max);
			const ok = (min === null || actual >= min) && (max === null || actual <= max);
			return { ok, detail: `expected in [${min ?? "-inf"}, ${max ?? "+inf"}], got ${actual}` };
		}
		case "gt":
		case "lt": {
			const actual = num(value);
			const bound = num(assertion.value);
			if (actual === null || bound === null) {
				return { ok: false, detail: `non-numeric comparison: ${String(value)}` };
			}
			const ok = assertion.kind === "gt" ? actual > bound : actual < bound;
			return { ok, detail: `expected ${assertion.kind} ${bound}, got ${actual}` };
		}
		case "not_null":
			return { ok: value !== null && value !== undefined, detail: `got ${String(value)}` };
		case "is_null":
			return { ok: value === null || value === undefined, detail: `got ${String(value)}` };
		default:
			return { ok: false, detail: `unknown assertion kind '${assertion.kind}'` };
	}
}

function assertRows(assertion: EvalAssertion, rows: Array<Record<string, unknown>>): { ok: boolean; detail: string } {
	switch (assertion.kind) {
		case "rows_between": {
			const min = num(assertion.min);
			const max = num(assertion.max);
			const ok = (min === null || rows.length >= min) && (max === null || rows.length <= max);
			return { ok, detail: `expected ${min ?? 0}..${max ?? "∞"} rows, got ${rows.length}` };
		}
		case "column_not_null": {
			const column = String(assertion.column ?? "");
			const offenders = rows.filter((row) => row[column] === null || row[column] === undefined).length;
			return { ok: offenders === 0 && column !== "", detail: column ? `${offenders} null(s) in '${column}'` : "no column named" };
		}
		case "column_min":
		case "column_max": {
			const column = String(assertion.column ?? "");
			const bound = num(assertion.value);
			if (!column || bound === null) return { ok: false, detail: "column_min/column_max need column and value" };
			const values = rows.map((row) => num(row[column])).filter((v): v is number => v !== null);
			if (!values.length) return { ok: false, detail: `no numeric values in '${column}'` };
			const worst = assertion.kind === "column_min" ? Math.min(...values) : Math.max(...values);
			const ok = assertion.kind === "column_min" ? worst >= bound : worst <= bound;
			return { ok, detail: `${assertion.kind} of '${column}' is ${worst}, bound ${bound}` };
		}
		default:
			return { ok: false, detail: `unknown assertion kind '${assertion.kind}'` };
	}
}

export function evaluateCase(
	spec: EvalCaseSpec,
	result: { returns: string; value: unknown; rows: Array<Record<string, unknown>>; rowCount: number },
): EvalCaseOutcome["assertions"] {
	return spec.assertions.map((assertion) => {
		const outcome =
			result.returns === "table"
				? assertRows(assertion, result.rows)
				: assertScalar(assertion, result.value);
		return { kind: assertion.kind, ok: outcome.ok, detail: outcome.detail };
	});
}

// ── suite CRUD ──────────────────────────────────────────────────────────────

const SELECT_SUITES = `
	SELECT es.eval_suite_id, es.space_id, sp.slug AS space_slug, es.name,
	       es.target_kind, es.target_ref, es.description, es.created_by, es.created_at,
	       (SELECT count(*) FROM platform.eval_case c WHERE c.suite_id = es.eval_suite_id)::int AS case_count,
	       (SELECT count(*) FROM platform.eval_run r WHERE r.suite_id = es.eval_suite_id)::int AS run_count
	  FROM platform.eval_suite es
	  JOIN platform.space sp ON sp.space_id = es.space_id`;

export async function listSuites(
	targetKind: "function" | "assistant",
	spaceSlug?: string,
): Promise<Array<Record<string, unknown>>> {
	return query(
		`${SELECT_SUITES}
		  WHERE es.target_kind = $1 AND ($2::text IS NULL OR sp.slug = $2)
		  ORDER BY es.name`,
		[targetKind, spaceSlug ?? null],
	);
}

export async function getSuite(suiteId: number, spaceSlug?: string): Promise<Record<string, unknown>> {
	const suite = await queryOne<Record<string, unknown>>(
		`${SELECT_SUITES} WHERE es.eval_suite_id = $1 AND ($2::text IS NULL OR sp.slug = $2)`,
		[suiteId, spaceSlug ?? null],
	);
	if (!suite) throw new NotFound(`No eval suite ${suiteId}.`);
	const cases = await query(
		`SELECT eval_case_id, name, spec, ordinal FROM platform.eval_case
		  WHERE suite_id = $1 ORDER BY ordinal, eval_case_id`,
		[suiteId],
	);
	return { ...suite, cases };
}

export async function createSuite(
	body: Record<string, unknown>,
	createdBy: string,
	spaceSlug?: string,
): Promise<Record<string, unknown>> {
	const name = String(body.name ?? "").trim();
	if (!name) throw new BadRequest("A suite needs a name.");
	const targetKind = String(body.targetKind ?? "function");
	if (targetKind !== "function" && targetKind !== "assistant") {
		throw new BadRequest("targetKind must be 'function' or 'assistant'.");
	}
	const targetRef = String(body.targetRef ?? "").trim();
	if (!targetRef) {
		throw new BadRequest(
			targetKind === "function"
				? "A function suite needs targetRef: the function's api name."
				: "An assistant suite carries targetRef 'assistant'.",
		);
	}
	const cases = Array.isArray(body.cases) ? body.cases : [];
	if (!cases.length) throw new BadRequest("A suite needs at least one case.");

	// A function suite is validated against the catalogue now, not on the
	// first run: naming a function that does not exist is refused here, where
	// the fix is obvious, rather than in a run report.
	if (targetKind === "function") {
		await getFunction(targetRef);
		for (const entry of cases as Array<Record<string, unknown>>) {
			const assertions = (entry.assertions as EvalAssertion[] | undefined) ?? [];
			if (!String(entry.name ?? "").trim() || !assertions.length) {
				throw new BadRequest("Every case needs a name and at least one assertion.");
			}
		}
	}

	const space = spaceSlug ?? "sandbox";
	const suite = await queryOne<{ eval_suite_id: number }>(
		`INSERT INTO platform.eval_suite (space_id, name, target_kind, target_ref, description, created_by)
		 SELECT space_id, $2, $3, $4, $5, $6 FROM platform.space WHERE slug = $1
		 RETURNING eval_suite_id`,
		[space, name, targetKind, targetRef, String(body.description ?? "").trim() || null, createdBy],
	);
	if (!suite) throw new NotFound(`No space '${space}'.`);

	await insertCases(suite.eval_suite_id, cases);
	return getSuite(suite.eval_suite_id, space);
}

async function insertCases(suiteId: number, cases: unknown[]): Promise<void> {
	let ordinal = 0;
	for (const entry of cases as Array<Record<string, unknown>>) {
		ordinal += 1;
		await query(
			`INSERT INTO platform.eval_case (suite_id, name, spec, ordinal) VALUES ($1, $2, $3, $4)`,
			[suiteId, String(entry.name ?? `Case ${ordinal}`), JSON.stringify(entry), ordinal],
		);
	}
}

export async function deleteSuite(suiteId: number, spaceSlug?: string): Promise<void> {
	const found = await queryOne<{ eval_suite_id: number }>(
		`SELECT es.eval_suite_id FROM platform.eval_suite es
		  JOIN platform.space sp ON sp.space_id = es.space_id
		 WHERE es.eval_suite_id = $1 AND ($2::text IS NULL OR sp.slug = $2)`,
		[suiteId, spaceSlug ?? null],
	);
	if (!found) throw new NotFound(`No eval suite ${suiteId}.`);
	await query(`DELETE FROM platform.eval_suite WHERE eval_suite_id = $1`, [suiteId]);
}

// ── running a suite ─────────────────────────────────────────────────────────

export async function runSuite(
	suiteId: number,
	startedBy: string,
	spaceSlug?: string,
): Promise<Record<string, unknown>> {
	const suite = await getSuite(suiteId, spaceSlug);
	if (suite.target_kind !== "function") {
		throw new BadRequest(
			"This suite targets the assistant and is run by the AI-FDE service at /api/assistant/evals.",
		);
	}
	const cases = suite.cases as Array<{ eval_case_id: number; name: string; spec: EvalCaseSpec }>;
	const run = await queryOne<{ eval_run_id: number }>(
		`INSERT INTO platform.eval_run (suite_id, started_by, status) VALUES ($1, $2, 'running') RETURNING eval_run_id`,
		[suiteId, startedBy],
	);

	const outcomes: EvalCaseOutcome[] = [];
	for (const entry of cases) {
		try {
			// Preview semantics: a proposed function can be evaluated before
			// approval, which is part of what reviewing a proposal should mean.
			const result = await runFunction(suite.target_ref as string, `eval:${startedBy}`, true);
			if (result.status === "failed") {
				outcomes.push({
					case: entry.name,
					ok: false,
					assertions: [],
					error: result.error ?? "the function failed to run",
				});
				continue;
			}
			const assertions = evaluateCase(entry.spec, result);
			outcomes.push({
				case: entry.name,
				ok: assertions.every((a) => a.ok),
				assertions,
			});
		} catch (error) {
			outcomes.push({
				case: entry.name,
				ok: false,
				assertions: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const passed = outcomes.filter((o) => o.ok).length;
	const finished = await queryOne<Record<string, unknown>>(
		`UPDATE platform.eval_run
		    SET status = 'succeeded', passed = $2, failed = $3, total = $4,
		        detail = $5, finished_at = now()
		  WHERE eval_run_id = $1
		 RETURNING eval_run_id, suite_id, started_by, status, passed, failed, total, detail, started_at, finished_at`,
		[
			run!.eval_run_id,
			passed,
			outcomes.length - passed,
			outcomes.length,
			JSON.stringify(outcomes),
		],
	);
	return finished!;
}

export async function listRuns(suiteId: number, limit = 10): Promise<unknown[]> {
	return query(
		`SELECT eval_run_id, started_by, status, passed, failed, total, detail, started_at, finished_at
		   FROM platform.eval_run
		  WHERE suite_id = $1
		  ORDER BY started_at DESC LIMIT $2`,
		[suiteId, Math.min(Math.max(limit, 1), 50)],
	);
}
