import { Pool, type QueryResultRow } from "pg";

/**
 * One pool for the process. The service is read-mostly; writes are confined to
 * dashboards, the action audit trail and chat history.
 */
export const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL ??
		"postgresql://ontology:ontology@127.0.0.1:55432/tms_ontology",
	max: Number(process.env.PG_POOL_MAX ?? 10),
	idleTimeoutMillis: 30_000,
	// A query that has not returned in 30 s is a bug, not slow hardware: the
	// largest view in this dataset has 2,269 rows.
	statement_timeout: 30_000,
});

pool.on("error", (error) => {
	console.error("[db] idle client error:", error.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
	sql: string,
	params: unknown[] = [],
): Promise<T[]> {
	const result = await pool.query<T>(sql, params);
	return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
	sql: string,
	params: unknown[] = [],
): Promise<T | null> {
	const rows = await query<T>(sql, params);
	return rows[0] ?? null;
}

/** Wait for Postgres, then for the pipeline to have published an ontology. */
export async function waitForOntology(timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let reportedWaiting = false;

	while (Date.now() < deadline) {
		try {
			const row = await queryOne<{ n: string }>(
				"SELECT count(*)::text AS n FROM platform.ontology_version WHERE is_active",
			);
			if (row && Number(row.n) > 0) return;
			if (!reportedWaiting) {
				console.log("[db] connected; waiting for the pipeline to publish an ontology...");
				reportedWaiting = true;
			}
		} catch (error) {
			if (!reportedWaiting) {
				console.log(`[db] waiting for Postgres (${(error as Error).message})`);
				reportedWaiting = true;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(
		"No active ontology after waiting. Run the pipeline:\n" +
			"    docker compose run --rm pipeline python -m pipeline.run",
	);
}
