/**
 * Caller-written SQL: the one place it runs, and what it may touch.
 *
 * A function's definition is SQL written by a person or drafted by the
 * assistant. It is restricted rather than trusted, in three layers, each of
 * which would stop a different mistake on its own:
 *
 *   1. Shape. One SELECT (or WITH ... SELECT), checked after comments are
 *      stripped, so `-- x` cannot hide a second statement.
 *   2. Reach. Every relation it reads is resolved BY THE PLANNER, through
 *      EXPLAIN, and must be a synced dataset in connection_raw. Reading the
 *      planner's answer rather than parsing the SQL is the point: a view, an
 *      alias or a schema-qualified name cannot disguise what is really read.
 *      So a definition cannot reach platform.app_user or pg_catalog, however
 *      it is spelled.
 *   3. Effect. It runs as a subquery inside a READ ONLY transaction with a
 *      statement timeout. A non-SELECT is a syntax error in that position, a
 *      data-modifying CTE is refused by PostgreSQL outside the top level, and
 *      anything that slipped past both still cannot write.
 *
 * Server-side functions that reach outside the database (files, other
 * servers, other sessions) are refused by name, because the planner reports
 * them as a function call, not as a relation.
 */

import type { PoolClient } from "pg";
import { pool } from "./db";
import { BadRequest } from "./registry";

/** Where synced datasets live: the only schema a function may read. */
export const DATASET_SCHEMA = "connection_raw";

const STATEMENT_TIMEOUT_MS = 30_000;

/** Server functions a definition may not call, whatever it reads. */
const FORBIDDEN_CALLS =
	/\b(pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_file_\w+|lo_\w+|dblink\w*|pg_sleep\w*|set_config|current_setting|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory\w*|query_to_xml\w*|table_to_xml\w*)\s*\(/i;

/**
 * The statement with comments and one trailing semicolon removed, or a
 * BadRequest saying why it is not a single read-only query.
 */
export function assertSingleSelect(statement: string): string {
	const stripped = String(statement ?? "")
		.replace(/--[^\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.trim()
		.replace(/;\s*$/, "");

	if (!stripped) throw new BadRequest("The definition is empty.");
	if (stripped.includes(";")) {
		throw new BadRequest("A definition is one statement; remove the extra ';'.");
	}
	if (!/^(select|with)\b/i.test(stripped)) {
		throw new BadRequest("A definition must be a single SELECT (or WITH ... SELECT). It runs read-only.");
	}
	const forbidden = FORBIDDEN_CALLS.exec(stripped);
	if (forbidden) {
		throw new BadRequest(`'${forbidden[1]}' reaches outside the data and cannot be used in a definition.`);
	}
	return stripped;
}

/** Run `fn` on one client inside a READ ONLY transaction, always rolled back. */
async function readOnly<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN READ ONLY");
		await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
		return await fn(client);
	} finally {
		// Rolled back even on success: nothing here is meant to persist, and a
		// rollback is the cheapest way to say so.
		await client.query("ROLLBACK").catch(() => {});
		client.release();
	}
}

type PlanNode = {
	"Relation Name"?: string;
	Schema?: string;
	Plans?: PlanNode[];
	[key: string]: unknown;
};

/** Every schema.relation a plan reads, walking every sub-plan. */
export function relationsInPlan(plan: PlanNode): string[] {
	const found = new Set<string>();
	const walk = (node: PlanNode) => {
		if (node["Relation Name"]) {
			found.add(`${node.Schema ?? "?"}.${node["Relation Name"]}`);
		}
		for (const child of node.Plans ?? []) walk(child);
	};
	walk(plan);
	return [...found].sort();
}

/**
 * What a statement reads, as PostgreSQL resolved it, and the columns it
 * returns. Throws a BadRequest carrying the database's own message when the
 * statement does not plan - an unknown column, a bad cast - because that
 * message names the fix.
 */
export async function inspectSelect(statement: string): Promise<{ relations: string[]; columns: string[] }> {
	const sql = assertSingleSelect(statement);
	try {
		return await readOnly(async (client) => {
			const explained = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
				`EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM (${sql}) AS _probe`,
			);
			const plan = explained.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
			const relations = plan ? relationsInPlan(plan) : [];

			const outside = relations.filter((relation) => !relation.startsWith(`${DATASET_SCHEMA}.`));
			if (outside.length > 0) {
				throw new BadRequest(
					`A definition may read only synced datasets (${DATASET_SCHEMA}.*). ` +
						`This one reads ${outside.join(", ")}.`,
				);
			}

			// LIMIT 0 plans and executes without materialising rows, which is how
			// the result's columns are learned without running the whole thing.
			const probe = await client.query(`SELECT * FROM (${sql}) AS _probe LIMIT 0`);
			return { relations, columns: probe.fields.map((field) => field.name) };
		});
	} catch (error) {
		if (error instanceof BadRequest) throw error;
		throw new BadRequest((error as Error).message);
	}
}

/** Run a checked statement read-only, returning at most `limit` rows. */
export async function runSelect(
	statement: string,
	limit: number,
): Promise<{ sql: string; rows: Array<Record<string, unknown>> }> {
	const sql = assertSingleSelect(statement);
	const bounded = Math.min(Math.max(1, Math.floor(limit)), 5000);
	const rows = await readOnly(
		async (client) => (await client.query(`SELECT * FROM (${sql}) AS _fn LIMIT ${bounded}`)).rows,
	);
	return { sql, rows };
}
