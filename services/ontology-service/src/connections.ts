/**
 * Connections: reaching a PostgreSQL database, and bringing a view across
 * from it as it is.
 *
 *     connection  --sync-->  connection_raw.<table>  -->  dataset card
 *     (host, credential         (rebuilt on every run,       (what object
 *      REFERENCE)                exactly the source)          types are made from)
 *
 * A CONNECTION holds the host and the reference to a credential; a SYNC is a
 * named, re-runnable copy of one view or table on that source; a RUN is what
 * happened the last time it ran. A schedule (schedules.ts) runs a sync on a
 * cadence. Every sync is a snapshot: the landing table is rebuilt from the
 * source each time, so the dataset is what the source holds now - no rows the
 * source has since deleted, nothing added or reshaped on the way.
 *
 * ── on credentials ──────────────────────────────────────────────────────────
 * A password is never stored. The connection records the NAME of an
 * environment variable or the path of a Docker secret, and it is resolved at
 * the moment of use. A password in platform.resource would be readable by
 * anyone who can read the workspace and would land in every backup.
 *
 * ── on SQL safety ───────────────────────────────────────────────────────────
 * A sync names a schema and a table, and both end up as SQL syntax rather than
 * as parameters. So neither is taken on trust: each is checked against the far
 * side's catalogue first and re-emitted quoted. The landing table's name is
 * derived here from the connection and the source, never supplied by the
 * caller. Remote column TYPES are mapped through a fixed table, so a type name
 * from someone else's catalogue never reaches a CREATE TABLE.
 *
 * ── on reading in one go ────────────────────────────────────────────────────
 * A run reads up to `rowLimit` rows into memory and then writes them. That is
 * a real bound, and it is why the limit exists and why a run that reaches it
 * is reported as `truncated` rather than quietly reported as complete.
 */

import type { Pool } from "pg";
import { ownDatabase, pool, query, queryOne } from "./db";
import { clearColumnCache } from "./kpi";
import { BadRequest, loadRegistry, NotFound, quoteIdentifier } from "./registry";

/** Where synced tables land. Never tms_raw: that is the captured snapshot. */
export const LANDING_SCHEMA = "connection_raw";

/** Rows per INSERT is bounded by PostgreSQL's 65535 parameters per statement. */
const MAX_PARAMS_PER_INSERT = 60_000;

// ── the source ──────────────────────────────────────────────────────────────

export interface ConnectionSpec {
	name: string;
	description?: string | null;
	folderId?: number | null;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	sslMode?: "disable" | "require" | "prefer";
	/**
	 * The NAME of an environment variable or the path of a Docker secret file
	 * holding the password - never the credential itself.
	 */
	secretRef?: string | null;
}

export interface ConnectionTest {
	ok: boolean;
	latencyMs: number;
	detail: string;
	serverVersion?: string | null;
	testedAt: string;
}

/** Read a password from the referenced env var or secret file, never storage. */
function resolveSecret(secretRef: string | null | undefined): string | null {
	if (!secretRef) return null;
	// A path is treated as a Docker secret; anything else as an env var.
	if (secretRef.startsWith("/")) {
		try {
			const { readFileSync } = require("node:fs") as typeof import("node:fs");
			return readFileSync(secretRef, "utf8").trim();
		} catch {
			return null;
		}
	}
	return process.env[secretRef] ?? null;
}

function buildDsn(spec: ConnectionSpec, password: string | null): string {
	const user = encodeURIComponent(spec.username ?? "");
	const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
	const ssl = spec.sslMode && spec.sslMode !== "prefer" ? `?sslmode=${spec.sslMode}` : "";
	return `postgresql://${auth}@${spec.host}:${spec.port}/${spec.database}${ssl}`;
}

/** How a connection is safe to display and store: never with its credential. */
export function displayDsn(spec: ConnectionSpec): string {
	const secret = spec.secretRef ? ":***" : "";
	return `postgresql://${spec.username}${secret}@${spec.host}:${spec.port}/${spec.database}`;
}

/**
 * The spec a stored connection resource describes.
 *
 * Returns null for a connection with no host: one describing the platform's
 * own database, which is reached through the service's own pool.
 */
export function specFromProperties(
	name: string,
	properties: Record<string, unknown>,
): ConnectionSpec | null {
	const host = typeof properties?.host === "string" ? properties.host.trim() : "";
	if (!host) return null;
	return {
		name,
		host,
		port: Number(properties.port) || 5432,
		database: String(properties.database ?? ""),
		username: String(properties.username ?? ""),
		secretRef: (properties.secretRef as string | null) ?? null,
		sslMode: (properties.sslMode as ConnectionSpec["sslMode"]) ?? "prefer",
	};
}

/**
 * Schemas that are this platform's own bookkeeping rather than source data:
 * users and their password hashes, the ontology, and the datasets syncs have
 * already landed. Reached through a connection to this platform's database,
 * they are hidden from the catalogue and refused as a sync's source - copying
 * platform.app_user into a dataset would put password hashes where functions
 * and dashboards can read them.
 */
const PLATFORM_SCHEMAS = ["platform", LANDING_SCHEMA];

/**
 * Whether a connection points at the database this service runs on.
 *
 * A connection with no host describes it outright; one with a host is
 * compared with the service's own DSN, because the sandbox's connection names
 * the host and a credential like any other, and still lands here.
 */
export function isOwnDatabase(spec: ConnectionSpec | null): boolean {
	if (!spec) return true;
	const own = ownDatabase();
	if (!own) return false;
	return (
		(spec.host ?? "").trim().toLowerCase() === own.host &&
		(Number(spec.port) || 5432) === own.port &&
		(spec.database ?? "") === own.database
	);
}

/**
 * A short-lived pool of its own.
 *
 * Never the platform's: a connection points wherever someone aimed it, and a
 * bad host must fail in seconds rather than hold a shared client open.
 */
function openRemote(spec: ConnectionSpec, password: string | null, statementTimeoutMs: number): Pool {
	const { Pool: PgPool } = require("pg") as typeof import("pg");
	return new PgPool({
		connectionString: buildDsn(spec, password),
		max: 1,
		connectionTimeoutMillis: 5000,
		idleTimeoutMillis: 1000,
		statement_timeout: statementTimeoutMs,
	});
}

/** The message for a credential the service was told about but cannot read. */
function unreadableSecret(secretRef: string): string {
	return (
		`The secret '${secretRef}' is not readable by this service. ` +
		"For a Docker secret, use its path under /run/secrets and mount it on " +
		"the ontology-service container; for an environment variable, use its name."
	);
}

/**
 * Actually connect, and say what happened.
 *
 * Wrong host, wrong password, no route and SSL required are indistinguishable
 * from each other until something tries, so this tries.
 */
export async function testConnection(spec: ConnectionSpec): Promise<ConnectionTest> {
	const started = Date.now();
	const password = resolveSecret(spec.secretRef);

	if (spec.secretRef && password === null) {
		return {
			ok: false,
			latencyMs: 0,
			detail: unreadableSecret(spec.secretRef),
			testedAt: new Date().toISOString(),
		};
	}

	const probe = openRemote(spec, password, 5000);
	try {
		const result = await probe.query<{ version: string }>("SELECT version()");
		return {
			ok: true,
			latencyMs: Date.now() - started,
			detail: "Connected.",
			serverVersion: (result.rows[0]?.version ?? "").split(" on ")[0] ?? null,
			testedAt: new Date().toISOString(),
		};
	} catch (error) {
		// The driver's message is the useful part - "password authentication
		// failed", "no pg_hba.conf entry", "ECONNREFUSED" each point somewhere
		// different - so it is passed through rather than replaced.
		return {
			ok: false,
			latencyMs: Date.now() - started,
			detail: (error as Error).message,
			testedAt: new Date().toISOString(),
		};
	} finally {
		await probe.end().catch(() => {
			/* the probe is disposable */
		});
	}
}

// ── what is on the far side ─────────────────────────────────────────────────

export interface RemoteRelation {
	schema: string;
	name: string;
	kind: string;
	estimatedRows: number | null;
	size: string | null;
}

export interface RemoteDatabaseInfo {
	database: string;
	version: string;
	sizePretty: string;
	relationCount: number;
	schemas: Array<{ schema: string; relations: number }>;
}

// Views first: a view is what a source usually publishes for others to read,
// so it is what a sync most often names. On the platform's own database its
// bookkeeping schemas are left out - they are not a source - which is the
// only difference between reading this database and reading any other.
const catalogSql = (own: boolean) => `
	SELECT n.nspname AS schema,
	       c.relname AS name,
	       CASE c.relkind
	         WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
	         WHEN 'v' THEN 'view'  WHEN 'm' THEN 'materialized view'
	       END AS kind,
	       -- reltuples is -1 for a table never analysed, and meaningless for a
	       -- view. Both are reported as unknown rather than as 0: "no rows" and
	       -- "not counted" are different claims.
	       CASE WHEN c.relkind = 'v' OR c.reltuples < 0
	            THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
	       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
	  FROM pg_class c
	  JOIN pg_namespace n ON n.oid = c.relnamespace
	 WHERE c.relkind IN ('r','p','v','m')
	   AND n.nspname NOT IN ('pg_catalog','information_schema'${
			own ? PLATFORM_SCHEMAS.map((schema) => `,'${schema}'`).join("") : ""
		})
	   AND n.nspname NOT LIKE 'pg\\_toast%'
	   AND has_schema_privilege(n.oid, 'USAGE')
	   AND has_table_privilege(c.oid, 'SELECT')
	 ORDER BY n.nspname, (c.relkind = 'v') DESC, c.relname`;

type CatalogRow = {
	schema: string;
	name: string;
	kind: string;
	estimated_rows: string | null;
	size: string | null;
};

function toRemoteRelation(row: CatalogRow): RemoteRelation {
	return {
		schema: row.schema,
		name: row.name,
		kind: row.kind,
		estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
		size: row.size,
	};
}

/** Every view and table the connection's own user can read, on the host it points at. */
export async function remoteCatalog(spec: ConnectionSpec | null): Promise<RemoteRelation[]> {
	if (!spec) {
		const rows = await query<CatalogRow>(catalogSql(true));
		return rows.map(toRemoteRelation);
	}
	const password = resolveSecret(spec.secretRef);
	if (spec.secretRef && password === null) throw new BadRequest(unreadableSecret(spec.secretRef));

	const probe = openRemote(spec, password, 15_000);
	try {
		const result = await probe.query<CatalogRow>(catalogSql(isOwnDatabase(spec)));
		return result.rows.map(toRemoteRelation);
	} catch (error) {
		throw new BadRequest(`Could not read the catalogue on ${spec.host}: ${(error as Error).message}`);
	} finally {
		await probe.end().catch(() => {});
	}
}

/** What a stored connection can read, asked of the host it names. */
export async function connectionCatalog(resourceId: number): Promise<{
	connection: string;
	isPlatformDatabase: boolean;
	relations: RemoteRelation[];
}> {
	const row = await queryOne<{ name: string; properties: Record<string, unknown> }>(
		"SELECT name, properties FROM platform.resource WHERE resource_id = $1 AND kind = 'connection'",
		[resourceId],
	);
	if (!row) throw new NotFound(`No connection resource ${resourceId}.`);

	const spec = specFromProperties(row.name, row.properties ?? {});
	return {
		connection: row.name,
		isPlatformDatabase: isOwnDatabase(spec),
		relations: await remoteCatalog(spec),
	};
}

/** Size, version and schema breakdown of the database a connection points at. */
export async function remoteDatabaseInfo(spec: ConnectionSpec): Promise<RemoteDatabaseInfo> {
	const password = resolveSecret(spec.secretRef);
	if (spec.secretRef && password === null) throw new BadRequest(unreadableSecret(spec.secretRef));

	const probe = openRemote(spec, password, 15_000);
	try {
		const meta = await probe.query<{ version: string; database: string; size: string }>(
			`SELECT version() AS version,
			        current_database() AS database,
			        pg_size_pretty(pg_database_size(current_database())) AS size`,
		);
		const relations = await probe.query<CatalogRow>(catalogSql(isOwnDatabase(spec)));
		const bySchema = new Map<string, number>();
		for (const row of relations.rows) {
			bySchema.set(row.schema, (bySchema.get(row.schema) ?? 0) + 1);
		}
		return {
			database: meta.rows[0]?.database ?? spec.database ?? "",
			version: (meta.rows[0]?.version ?? "").split(" on ")[0] ?? "",
			sizePretty: meta.rows[0]?.size ?? "",
			relationCount: relations.rows.length,
			schemas: [...bySchema.entries()]
				.map(([schema, count]) => ({ schema, relations: count }))
				.sort((a, b) => a.schema.localeCompare(b.schema)),
		};
	} catch (error) {
		throw new BadRequest(`Could not read ${spec.host}: ${(error as Error).message}`);
	} finally {
		await probe.end().catch(() => {});
	}
}

// ── mapping a remote column to a local one ──────────────────────────────────

/**
 * Remote type -> the type the landing table uses.
 *
 * A fixed table, because `format_type()` on the far side returns a string from
 * someone else's catalogue that would otherwise be spliced into a CREATE TABLE.
 * Anything not listed widens to text, which is lossless for display - the
 * driver hands unknown types back as strings anyway - and the columns that
 * widened are recorded on the dataset so nobody has to guess why a number
 * arrived as text.
 */
const TYPE_MAP: Record<string, string> = {
	bool: "boolean",
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	float4: "real",
	float8: "double precision",
	numeric: "numeric",
	money: "text",
	text: "text",
	varchar: "text",
	bpchar: "text",
	char: "text",
	name: "text",
	uuid: "uuid",
	date: "date",
	timestamp: "timestamp",
	timestamptz: "timestamptz",
	time: "time",
	timetz: "timetz",
	interval: "interval",
	json: "json",
	jsonb: "jsonb",
	bytea: "bytea",
	inet: "text",
	cidr: "text",
	macaddr: "text",
	xml: "text",
};

export interface MappedColumn {
	name: string;
	remoteType: string;
	localType: string;
	/** True where the remote type has no local equivalent and became text. */
	widened: boolean;
}

/** The local type for one remote column, and whether it lost anything. */
export function localTypeFor(udtName: string): { type: string; widened: boolean } {
	const direct = TYPE_MAP[udtName];
	if (direct) return { type: direct, widened: direct === "text" && udtName !== "text" };

	// An array's udt_name is the element type with a leading underscore.
	if (udtName.startsWith("_")) {
		const element = TYPE_MAP[udtName.slice(1)];
		if (element) return { type: `${element}[]`, widened: element === "text" };
		return { type: "text[]", widened: true };
	}

	// Enums, domains, composite types, PostGIS geometry. The driver returns
	// them as strings, so text holds them exactly as they arrive.
	return { type: "text", widened: true };
}

// ── naming the landing table ────────────────────────────────────────────────

/** A name reduced to what a SQL identifier may hold, or "" if nothing is left. */
function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/**
 * Where a sync lands, derived rather than accepted.
 *
 * `<connection>__<schema>__<table>`, so the table says where it came from
 * without needing the sync row to explain it. Truncated to 63 characters -
 * PostgreSQL's identifier limit - from the RIGHT, keeping the table name,
 * which is the part that distinguishes two syncs of the same shape.
 */
export function syncTargetTableName(
	connectionName: string,
	sourceSchema: string,
	sourceTable: string,
): string {
	const parts = [slugify(connectionName), slugify(sourceSchema), slugify(sourceTable)].filter(Boolean);
	if (parts.length < 3) {
		throw new BadRequest(
			"The connection name, schema and table must each contain a letter or a digit.",
		);
	}
	const full = parts.join("__");
	return full.length <= 63 ? full : full.slice(full.length - 63).replace(/^_+/, "");
}

/** A plain SQL identifier, as the far side reported it. */
function assertIdentifier(value: string, what: string): string {
	const trimmed = String(value ?? "").trim();
	if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
		throw new BadRequest(
			`'${trimmed}' is not a plain identifier, so it cannot be used as a ${what}. ` +
				"Quoted or mixed-case names are not supported here.",
		);
	}
	return trimmed;
}

// ── syncs ───────────────────────────────────────────────────────────────────

export interface SyncRecord {
	id: number;
	resourceId: number;
	connectionName: string;
	name: string;
	description: string | null;
	sourceSchema: string;
	sourceTable: string;
	targetTable: string;
	/** Fully qualified, as it is referenced from SQL: connection_raw.<table>. */
	targetRelation: string;
	rowLimit: number;
	datasetResourceId: number | null;
	enabled: boolean;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	lastRun: SyncRunRecord | null;
	/** The schedule that runs it, if any: one cadence per sync. */
	schedule: { id: number; intervalSeconds: number; enabled: boolean; nextRunAt: string | null } | null;
}

export interface SyncRunRecord {
	id: number;
	syncId: number;
	status: "running" | "success" | "failed";
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	rowsRead: number | null;
	rowsWritten: number | null;
	rowsBefore: number | null;
	rowsAfter: number | null;
	truncated: boolean;
	errorMessage: string | null;
	triggeredBy: string;
}

type SyncRow = {
	sync_id: number;
	resource_id: number;
	connection_name: string;
	name: string;
	description: string | null;
	source_schema: string;
	source_table: string;
	target_table: string;
	row_limit: number;
	dataset_resource_id: number | null;
	enabled: boolean;
	created_by: string;
	created_at: Date;
	updated_at: Date;
	schedule_id: number | null;
	interval_seconds: number | null;
	schedule_enabled: boolean | null;
	next_run_at: Date | null;
};

type RunRow = {
	sync_run_id: number;
	sync_id: number;
	status: SyncRunRecord["status"];
	started_at: Date;
	finished_at: Date | null;
	duration_ms: number | null;
	rows_read: string | null;
	rows_written: string | null;
	rows_before: string | null;
	rows_after: string | null;
	truncated: boolean;
	error_message: string | null;
	triggered_by: string;
};

const SYNC_SELECT = `
	SELECT s.*, r.name AS connection_name,
	       sc.schedule_id, sc.interval_seconds, sc.enabled AS schedule_enabled, sc.next_run_at
	  FROM platform.connection_sync s
	  JOIN platform.resource r ON r.resource_id = s.resource_id
	  LEFT JOIN platform.schedule sc ON sc.kind = 'sync' AND sc.target_ref = s.sync_id::text`;

function toRun(row: RunRow): SyncRunRecord {
	return {
		// BIGINT arrives from the driver as a string; coerced once, here.
		id: Number(row.sync_run_id),
		syncId: Number(row.sync_id),
		status: row.status,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		durationMs: row.duration_ms,
		rowsRead: row.rows_read === null ? null : Number(row.rows_read),
		rowsWritten: row.rows_written === null ? null : Number(row.rows_written),
		rowsBefore: row.rows_before === null ? null : Number(row.rows_before),
		rowsAfter: row.rows_after === null ? null : Number(row.rows_after),
		truncated: row.truncated,
		errorMessage: row.error_message,
		triggeredBy: row.triggered_by,
	};
}

function toSync(row: SyncRow, lastRun: SyncRunRecord | null): SyncRecord {
	return {
		id: Number(row.sync_id),
		resourceId: Number(row.resource_id),
		connectionName: row.connection_name,
		name: row.name,
		description: row.description,
		sourceSchema: row.source_schema,
		sourceTable: row.source_table,
		targetTable: row.target_table,
		targetRelation: `${LANDING_SCHEMA}.${row.target_table}`,
		rowLimit: row.row_limit,
		datasetResourceId:
			row.dataset_resource_id === null ? null : Number(row.dataset_resource_id),
		enabled: row.enabled,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		lastRun,
		schedule:
			row.schedule_id === null
				? null
				: {
						id: Number(row.schedule_id),
						intervalSeconds: Number(row.interval_seconds),
						enabled: Boolean(row.schedule_enabled),
						nextRunAt: row.next_run_at?.toISOString() ?? null,
					},
	};
}

async function lastRunOf(syncId: number): Promise<SyncRunRecord | null> {
	const row = await queryOne<RunRow>(
		`SELECT * FROM platform.connection_sync_run
		  WHERE sync_id = $1 ORDER BY started_at DESC, sync_run_id DESC LIMIT 1`,
		[syncId],
	);
	return row ? toRun(row) : null;
}

export async function listSyncs(resourceId: number): Promise<SyncRecord[]> {
	const rows = await query<SyncRow>(
		`${SYNC_SELECT} WHERE s.resource_id = $1 ORDER BY s.name`,
		[resourceId],
	);
	return Promise.all(rows.map(async (row) => toSync(row, await lastRunOf(row.sync_id))));
}

/** Every sync in a space, across all of its projects and connections. */
export async function listSyncsInSpace(spaceSlug?: string): Promise<SyncRecord[]> {
	const rows = await query<SyncRow>(
		`${SYNC_SELECT}
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space sp ON sp.space_id = p.space_id
		  WHERE ($1::text IS NULL OR sp.slug = $1)
		  ORDER BY s.name`,
		[spaceSlug ?? null],
	);
	return Promise.all(rows.map(async (row) => toSync(row, await lastRunOf(row.sync_id))));
}

export async function getSync(syncId: number): Promise<SyncRecord> {
	const row = await queryOne<SyncRow>(`${SYNC_SELECT} WHERE s.sync_id = $1`, [syncId]);
	if (!row) throw new NotFound(`No sync ${syncId}.`);
	return toSync(row, await lastRunOf(row.sync_id));
}

export async function listSyncRuns(syncId: number, limit = 25): Promise<SyncRunRecord[]> {
	const rows = await query<RunRow>(
		`SELECT * FROM platform.connection_sync_run
		  WHERE sync_id = $1 ORDER BY started_at DESC, sync_run_id DESC LIMIT $2`,
		[syncId, Math.min(Math.max(1, limit), 200)],
	);
	return rows.map(toRun);
}

export interface SyncRequest {
	name?: string;
	description?: string | null;
	sourceSchema: string;
	sourceTable: string;
	rowLimit?: number;
}

export interface ValidatedSync {
	name: string;
	description: string | null;
	sourceSchema: string;
	sourceTable: string;
	rowLimit: number;
}

/**
 * Everything about a sync request that can be judged without a network.
 * Kept apart from creating one so it is testable.
 */
export function validateSyncRequest(request: SyncRequest): ValidatedSync {
	const sourceSchema = assertIdentifier(request.sourceSchema ?? "", "schema name");
	const sourceTable = assertIdentifier(request.sourceTable ?? "", "view or table name");

	// A sync is named for what it copies unless told otherwise.
	const name = String(request.name ?? "").trim() || `${sourceSchema}.${sourceTable}`;
	if (name.length > 120) throw new BadRequest("A sync name is at most 120 characters.");

	const rowLimit = Math.floor(Number(request.rowLimit ?? 50_000));
	if (!Number.isFinite(rowLimit) || rowLimit < 1 || rowLimit > 1_000_000) {
		throw new BadRequest("rowLimit must be between 1 and 1,000,000 rows.");
	}

	return {
		name,
		description: request.description ?? null,
		sourceSchema,
		sourceTable,
		rowLimit,
	};
}

type ConnectionResourceRow = {
	resource_id: number;
	project_id: number;
	folder_id: number | null;
	name: string;
	properties: Record<string, unknown>;
};

async function connectionResource(resourceId: number): Promise<ConnectionResourceRow> {
	const row = await queryOne<ConnectionResourceRow>(
		`SELECT resource_id, project_id, folder_id, name, properties
		   FROM platform.resource WHERE resource_id = $1 AND kind = 'connection'`,
		[resourceId],
	);
	if (!row) throw new NotFound(`No connection resource ${resourceId}.`);
	return row;
}

/**
 * Define a sync, after checking the view really exists on the far side.
 *
 * The check is the point: a sync that names a view nobody can read is found
 * now, with the name in the message, rather than the first time somebody runs
 * it and gets a driver error.
 */
export async function createSync(
	resourceId: number,
	request: SyncRequest,
	createdBy: string,
): Promise<SyncRecord> {
	const connection = await connectionResource(resourceId);
	const valid = validateSyncRequest(request);
	const spec = specFromProperties(connection.name, connection.properties ?? {});

	if (isOwnDatabase(spec) && PLATFORM_SCHEMAS.includes(valid.sourceSchema)) {
		throw new BadRequest(
			`${valid.sourceSchema} is this platform's own bookkeeping, not source data, so it cannot be synced.`,
		);
	}

	const columns = await sourceColumns(spec, valid.sourceSchema, valid.sourceTable);
	if (columns.length === 0) {
		throw new BadRequest(
			`${valid.sourceSchema}.${valid.sourceTable} is not readable through this connection. ` +
				"Either it does not exist, or the connection's user cannot select from it.",
		);
	}

	const targetTable = syncTargetTableName(connection.name, valid.sourceSchema, valid.sourceTable);

	// One sync owns one landing table, and the table's name is derived from the
	// connection and the source - so a second sync of the same source would
	// collide. Refused with what to do about it, rather than as a
	// unique-violation from the insert below.
	const existing = await queryOne<{ sync_id: number; resource_id: number; name: string }>(
		"SELECT sync_id, resource_id, name FROM platform.connection_sync WHERE target_table = $1",
		[targetTable],
	);
	if (existing && Number(existing.resource_id) !== Number(resourceId)) {
		throw new BadRequest(
			`Another connection already syncs into ${LANDING_SCHEMA}.${targetTable}. ` +
				"Rename one of the connections so the two landing tables differ.",
		);
	}
	if (existing && existing.name !== valid.name) {
		throw new BadRequest(
			`'${existing.name}' already syncs ${valid.sourceSchema}.${valid.sourceTable} through this ` +
				`connection, into ${LANDING_SCHEMA}.${targetTable}. Two syncs cannot share a landing ` +
				`table, so change '${existing.name}' rather than adding a second one beside it.`,
		);
	}

	const row = await queryOne<{ sync_id: number }>(
		`INSERT INTO platform.connection_sync
		   (resource_id, name, description, source_schema, source_table, target_table, row_limit, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 ON CONFLICT (resource_id, name) DO UPDATE
		    SET description   = EXCLUDED.description,
		        source_schema = EXCLUDED.source_schema,
		        source_table  = EXCLUDED.source_table,
		        target_table  = EXCLUDED.target_table,
		        row_limit     = EXCLUDED.row_limit,
		        updated_at    = now()
		 RETURNING sync_id`,
		[
			resourceId,
			valid.name,
			valid.description,
			valid.sourceSchema,
			valid.sourceTable,
			targetTable,
			valid.rowLimit,
			createdBy,
		],
	);
	if (!row) throw new BadRequest("The sync could not be created.");
	return getSync(Number(row.sync_id));
}

/** Delete a sync and its schedule. Its dataset and landed table stay. */
export async function deleteSync(syncId: number): Promise<void> {
	await query("DELETE FROM platform.schedule WHERE kind = 'sync' AND target_ref = $1", [String(syncId)]);
	const row = await queryOne<{ sync_id: number }>(
		"DELETE FROM platform.connection_sync WHERE sync_id = $1 RETURNING sync_id",
		[syncId],
	);
	if (!row) throw new NotFound(`No sync ${syncId}.`);
}

// ── running one ─────────────────────────────────────────────────────────────

interface SourceColumn {
	name: string;
	udtName: string;
	remoteType: string;
}

/**
 * The columns of the source view, read from the far side's catalogue.
 *
 * This is also the check that it exists and that the connection's user can
 * see it: information_schema.columns only shows what the caller has some
 * privilege on.
 */
async function sourceColumns(
	spec: ConnectionSpec | null,
	schema: string,
	table: string,
): Promise<SourceColumn[]> {
	const sql = `
		SELECT column_name, udt_name, data_type
		  FROM information_schema.columns
		 WHERE table_schema = $1 AND table_name = $2
		 ORDER BY ordinal_position`;
	type Row = { column_name: string; udt_name: string; data_type: string };

	const rows: Row[] = spec
		? await (async () => {
				const password = resolveSecret(spec.secretRef);
				if (spec.secretRef && password === null) {
					throw new BadRequest(unreadableSecret(spec.secretRef));
				}
				const probe = openRemote(spec, password, 15_000);
				try {
					return (await probe.query<Row>(sql, [schema, table])).rows;
				} catch (error) {
					throw new BadRequest(
						`Could not read ${schema}.${table} on ${spec.host}: ${(error as Error).message}`,
					);
				} finally {
					await probe.end().catch(() => {});
				}
			})()
		: await query<Row>(sql, [schema, table]);

	return rows.map((row) => ({
		name: row.column_name,
		udtName: row.udt_name,
		remoteType: row.data_type,
	}));
}

export interface SyncOutcome {
	run: SyncRunRecord;
	sync: SyncRecord;
	/** Columns whose type had no local equivalent and landed as text. */
	widenedColumns: string[];
	datasetResourceId: number | null;
	/** Object types whose counts were refreshed from the new rows. */
	objectTypesRefreshed: number;
	/**
	 * Properties that named a column the source no longer has. Reported, not
	 * repaired: the object type still describes the old shape, and queries on
	 * that property will fail until it is removed or the source restores it.
	 */
	brokenProperties: string[];
}

/**
 * Copy the source view across, as it is.
 *
 * Reads into memory up to the sync's row limit, then rebuilds the landing
 * table inside one transaction - so a failure part way through leaves the
 * previous table in place rather than half of a new one.
 */
export async function runSync(syncId: number, triggeredBy: string): Promise<SyncOutcome> {
	const sync = await getSync(syncId);
	if (!sync.enabled) throw new BadRequest(`The sync '${sync.name}' is disabled.`);

	const connection = await connectionResource(sync.resourceId);
	const spec = specFromProperties(connection.name, connection.properties ?? {});
	if (isOwnDatabase(spec) && PLATFORM_SCHEMAS.includes(sync.sourceSchema)) {
		throw new BadRequest(
			`${sync.sourceSchema} is this platform's own bookkeeping, not source data, so it cannot be synced.`,
		);
	}

	const started = Date.now();
	const runRow = await queryOne<RunRow>(
		`INSERT INTO platform.connection_sync_run (sync_id, status, mode, triggered_by)
		 VALUES ($1,'running','snapshot',$2) RETURNING *`,
		[syncId, triggeredBy],
	);
	if (!runRow) throw new BadRequest("The run could not be recorded.");

	const fail = async (message: string): Promise<never> => {
		await query(
			`UPDATE platform.connection_sync_run
			    SET status = 'failed', finished_at = now(), duration_ms = $2, error_message = $3
			  WHERE sync_run_id = $1`,
			[runRow.sync_run_id, Date.now() - started, message],
		);
		throw new BadRequest(message);
	};

	try {
		const columns = await sourceColumns(spec, sync.sourceSchema, sync.sourceTable);
		if (columns.length === 0) {
			return await fail(
				`${sync.sourceSchema}.${sync.sourceTable} is no longer readable through this connection.`,
			);
		}

		const mapped: MappedColumn[] = columns.map((column) => {
			const { type, widened } = localTypeFor(column.udtName);
			return { name: column.name, remoteType: column.remoteType, localType: type, widened };
		});

		// Every identifier below came from the far side's catalogue and is
		// re-emitted quoted; nothing from the request reaches SQL as syntax.
		const selectList = columns.map((column) => quoteIdentifier(column.name)).join(", ");
		const from = `${quoteIdentifier(sync.sourceSchema)}.${quoteIdentifier(sync.sourceTable)}`;

		// One more than the limit, so a run can tell "exactly the limit" from
		// "there was more and we stopped".
		const readSql = `SELECT ${selectList} FROM ${from} LIMIT ${sync.rowLimit + 1}`;

		let rows: Array<Record<string, unknown>>;
		if (spec) {
			const password = resolveSecret(spec.secretRef);
			if (spec.secretRef && password === null) return await fail(unreadableSecret(spec.secretRef));
			const probe = openRemote(spec, password, 120_000);
			try {
				rows = (await probe.query(readSql)).rows;
			} catch (error) {
				return await fail(`Reading ${sync.sourceSchema}.${sync.sourceTable} failed: ${(error as Error).message}`);
			} finally {
				await probe.end().catch(() => {});
			}
		} else {
			rows = await query(readSql);
		}

		const truncated = rows.length > sync.rowLimit;
		if (truncated) rows = rows.slice(0, sync.rowLimit);

		let landed: { rowsBefore: number; rowsAfter: number };
		try {
			landed = await writeLanding(sync.targetTable, mapped, rows);
		} catch (error) {
			return await fail((error as Error).message);
		}

		const datasetResourceId = await ensureSyncDataset(connection, sync, mapped, landed.rowsAfter);
		const refreshed = await refreshObjectTypes(sync.targetRelation, landed.rowsAfter, mapped);

		const finished = await queryOne<RunRow>(
			`UPDATE platform.connection_sync_run
			    SET status = 'success', finished_at = now(), duration_ms = $2,
			        rows_read = $3, rows_written = $3, rows_before = $4, rows_after = $5,
			        truncated = $6
			  WHERE sync_run_id = $1
			 RETURNING *`,
			[runRow.sync_run_id, Date.now() - started, rows.length, landed.rowsBefore, landed.rowsAfter, truncated],
		);

		return {
			run: toRun(finished ?? runRow),
			sync: await getSync(syncId),
			widenedColumns: mapped.filter((column) => column.widened).map((column) => column.name),
			datasetResourceId,
			objectTypesRefreshed: refreshed.count,
			brokenProperties: refreshed.broken,
		};
	} catch (error) {
		// A BadRequest here already has its run row marked failed by fail().
		if (error instanceof BadRequest) throw error;
		return await fail((error as Error).message);
	}
}

/** Rebuild the landing table from the rows a run read, in one transaction. */
async function writeLanding(
	targetTable: string,
	columns: Array<{ name: string; localType: string }>,
	rows: Array<Record<string, unknown>>,
): Promise<{ rowsBefore: number; rowsAfter: number }> {
	const target = `${quoteIdentifier(LANDING_SCHEMA)}.${quoteIdentifier(targetTable)}`;
	const definition = columns
		.map((column) => `${quoteIdentifier(column.name)} ${column.localType}`)
		.join(", ");

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const exists = await client.query(
			`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE n.nspname = $1 AND c.relname = $2`,
			[LANDING_SCHEMA, targetTable],
		);
		let rowsBefore = 0;
		if (exists.rowCount) {
			const counted = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${target}`);
			rowsBefore = Number(counted.rows[0]?.n ?? 0);
		}

		// Rebuilt, not appended to: the dataset is what the source holds now.
		await client.query(`DROP TABLE IF EXISTS ${target}`);
		await client.query(`CREATE TABLE ${target} (${definition})`);

		if (rows.length > 0 && columns.length > 0) {
			// Batched multi-row inserts, sized from the column count so a statement
			// never exceeds PostgreSQL's parameter limit.
			const perBatch = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS_PER_INSERT / columns.length)));
			const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");
			for (let start = 0; start < rows.length; start += perBatch) {
				const batch = rows.slice(start, start + perBatch);
				const values: unknown[] = [];
				const tuples = batch.map((row) => {
					const placeholders = columns.map((column) => {
						values.push(row[column.name] ?? null);
						return `$${values.length}`;
					});
					return `(${placeholders.join(", ")})`;
				});
				await client.query(`INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`, values);
			}
		}

		const after = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${target}`);
		const rowsAfter = Number(after.rows[0]?.n ?? 0);
		await client.query("COMMIT");
		return { rowsBefore, rowsAfter };
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw new BadRequest(`Writing ${LANDING_SCHEMA}.${targetTable} failed: ${(error as Error).message}`);
	} finally {
		client.release();
	}
}

/**
 * Bring the object types built on a dataset up to date with its new rows.
 *
 * Their counts change with every run; their shape does not change on its own,
 * so a property whose column the source dropped is named rather than hidden.
 */
async function refreshObjectTypes(
	relation: string,
	rowCount: number,
	columns: MappedColumn[],
): Promise<{ count: number; broken: string[] }> {
	const updated = await query<{ object_type_rid: string }>(
		`UPDATE platform.object_type t
		    SET row_count = $2
		   FROM platform.ontology_version v
		  WHERE v.ontology_version_id = t.ontology_version_id AND v.is_active
		    AND t.source_view = $1
		RETURNING t.object_type_rid`,
		[relation, rowCount],
	);
	if (updated.length === 0) return { count: 0, broken: [] };

	const broken = await query<{ api_name: string; property: string; sql_column: string }>(
		`SELECT t.api_name, p.api_name AS property, p.sql_column
		   FROM platform.object_property p
		   JOIN platform.object_type t
		     ON t.ontology_version_id = p.ontology_version_id AND t.object_type_rid = p.object_type_rid
		   JOIN platform.ontology_version v ON v.ontology_version_id = t.ontology_version_id AND v.is_active
		  WHERE t.source_view = $1 AND NOT (p.sql_column = ANY($2::text[]))`,
		[relation, columns.map((column) => column.name)],
	);

	// The registry holds row counts in memory, and the metric column cache
	// holds this table's columns: both are stale the moment it is rebuilt.
	clearColumnCache();
	await loadRegistry();
	return {
		count: updated.length,
		broken: broken.map((row) => `${row.api_name}.${row.property} (${row.sql_column})`),
	};
}

/** A folder by path in a project, created if it is missing. */
async function ensureFolder(projectId: number, name: string): Promise<number> {
	const found = await queryOne<{ folder_id: number }>(
		"SELECT folder_id FROM platform.folder WHERE project_id = $1 AND path = $2",
		[projectId, `/${name}`],
	);
	if (found) return Number(found.folder_id);
	const created = await queryOne<{ folder_id: number }>(
		`INSERT INTO platform.folder (project_id, parent_id, name, path, created_by)
		 VALUES ($1, NULL, $2, $3, 'system') RETURNING folder_id`,
		[projectId, name, `/${name}`],
	);
	return Number(created!.folder_id);
}

/**
 * The dataset a sync produces, created once and refreshed after every run.
 *
 * Written with SQL rather than through createResource so this module does not
 * depend on spaces.ts - spaces.ts depends on this one, for the preview of a
 * connection, and a cycle between them would be worse than these lines.
 */
async function ensureSyncDataset(
	connection: ConnectionResourceRow,
	sync: SyncRecord,
	columns: MappedColumn[],
	rowCount: number,
): Promise<number | null> {
	const relation = `${LANDING_SCHEMA}.${sync.targetTable}`;
	const properties = {
		sourceView: relation,
		backing: "sync" as const,
		connectionResourceId: Number(connection.resource_id),
		connectionName: connection.name,
		syncId: sync.id,
		syncName: sync.name,
		source: `${sync.sourceSchema}.${sync.sourceTable}`,
		columnCount: columns.length,
		rowCount,
		columnsWidened: columns.filter((column) => column.widened).map((column) => column.name),
		schemaAtRegistration: columns.map((column) => ({
			name: column.name,
			type: column.localType,
			remoteType: column.remoteType,
		})),
		lastSyncedAt: new Date().toISOString(),
	};

	const existing = await queryOne<{ resource_id: number }>(
		`SELECT resource_id FROM platform.resource
		  WHERE project_id = $1 AND kind = 'dataset' AND target_ref = $2`,
		[connection.project_id, relation],
	);

	if (existing) {
		await query(
			"UPDATE platform.resource SET properties = $2::jsonb, updated_at = now() WHERE resource_id = $1",
			[existing.resource_id, JSON.stringify(properties)],
		);
		await query("UPDATE platform.connection_sync SET dataset_resource_id = $2 WHERE sync_id = $1", [
			sync.id,
			existing.resource_id,
		]);
		return Number(existing.resource_id);
	}

	const folderId = await ensureFolder(Number(connection.project_id), "Datasets");
	const created = await queryOne<{ resource_id: number }>(
		`INSERT INTO platform.resource
		   (project_id, folder_id, kind, name, description, target_ref, properties, created_by)
		 VALUES ($1,$2,'dataset',$3,$4,$5,$6::jsonb,'system')
		 ON CONFLICT DO NOTHING
		 RETURNING resource_id`,
		[
			connection.project_id,
			folderId,
			sync.sourceTable,
			`${sync.sourceSchema}.${sync.sourceTable}, synced as it is through the '${connection.name}' connection.`,
			relation,
			JSON.stringify(properties),
		],
	);
	if (!created) return null;

	await query("UPDATE platform.connection_sync SET dataset_resource_id = $2 WHERE sync_id = $1", [
		sync.id,
		created.resource_id,
	]);
	return Number(created.resource_id);
}

/**
 * Whether a relation is a dataset a sync landed.
 *
 * How a reader is allowed to see a synced table that no object type is built
 * on yet, without opening the door to an arbitrary relation name.
 */
export async function isPlatformWrittenRelation(qualified: string): Promise<boolean> {
	const [schema, name, ...rest] = qualified.split(".");
	if (!schema || !name || rest.length > 0) return false;
	if (schema !== LANDING_SCHEMA) return false;
	const row = await queryOne<{ exists: boolean }>(
		`SELECT true AS exists
		   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m')`,
		[schema, name],
	);
	return Boolean(row);
}
