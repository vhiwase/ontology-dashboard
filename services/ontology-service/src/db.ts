import { readFileSync } from "node:fs";
import { Pool, type QueryResultRow } from "pg";

/**
 * A value from NAME, or from the file NAME_FILE.
 *
 * Docker secrets arrive as files under /run/secrets rather than as
 * environment variables, and an environment variable is visible to anyone who
 * can run `docker inspect` on the container. The _FILE form wins when both are
 * set.
 */
function secret(name: string, fallback: string): string {
	const path = process.env[`${name}_FILE`];
	if (path) {
		try {
			return readFileSync(path, "utf8").trim();
		} catch (error) {
			throw new Error(`Could not read ${name}_FILE (${path}): ${(error as Error).message}`);
		}
	}
	return process.env[name] ?? fallback;
}

const DSN = secret("DATABASE_URL", "postgresql://ontology:ontology@127.0.0.1:55432/tms_ontology");

/**
 * Where this service's own database is: host, port and name, never the
 * password. A connection pointing here reads the platform's own bookkeeping
 * as well as its source data, so it is treated differently (connections.ts).
 */
export function ownDatabase(): { host: string; port: number; database: string } | null {
	try {
		const url = new URL(DSN);
		return {
			host: url.hostname.toLowerCase(),
			port: Number(url.port) || 5432,
			database: decodeURIComponent(url.pathname.replace(/^\//, "")),
		};
	} catch {
		return null;
	}
}

/**
 * One pool for the process. The service is read-mostly; writes are confined to
 * dashboards, the action audit trail and chat history.
 */
export const pool = new Pool({
	connectionString: DSN,
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

/**
 * Wait for Postgres, then for the migrations to have run.
 *
 * The pipeline container runs the migrations before this service starts, but
 * a restart of Postgres alone can leave this waiting on a database that is up
 * and not yet accepting queries, so both are waited for.
 */
export async function waitForDatabase(timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let reportedWaiting = false;

	while (Date.now() < deadline) {
		try {
			const row = await queryOne<{ n: string; migrated: boolean }>(
				`SELECT (SELECT count(*) FROM platform.space)::text AS n,
				        EXISTS (SELECT 1 FROM platform.schema_migration WHERE version = '0030') AS migrated`,
			);
			if (row && Number(row.n) > 0 && row.migrated) return;
			if (!reportedWaiting) {
				console.log("[db] connected; waiting for the migrations to run...");
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
		"The database is not migrated after waiting. Run:\n" +
			"    docker compose run --rm pipeline python -m pipeline.migrate",
	);
}
