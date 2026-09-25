/**
 * Connections: reaching a database that is not this one, and bringing rows
 * across from it.
 *
 * A connection used to be a business card. It could be registered and it could
 * be tested, and that was the whole of it — nothing could come through it, and
 * the preview that claimed to list "every table this connection can read"
 * actually listed the tables of the platform's own database, whichever host
 * the connection pointed at. Both are fixed here.
 *
 * The model is Foundry's: a SOURCE holds the host and the reference to a
 * credential; a SYNC is a named, re-runnable pull from one table on that
 * source into one dataset here; a RUN is what happened the last time it ran.
 *
 * ── on credentials ──────────────────────────────────────────────────────────
 * A password is never stored. The connection records the NAME of an
 * environment variable or the path of a Docker secret, and it is resolved at
 * the moment of use. A password in platform.resource would be readable by
 * anyone who can read the workspace, would land in every backup, and would
 * survive in the row's history.
 *
 * ── on SQL safety ───────────────────────────────────────────────────────────
 * A sync names a schema, a table and a cursor column, and all three end up as
 * SQL syntax rather than as parameters — there is no way to bind an identifier.
 * So none of them is ever taken on trust: each is checked against the far
 * side's catalogue first and re-emitted quoted. The landing table's name is
 * derived by this module from the connection and the source, never supplied by
 * the caller. Remote column TYPES are mapped through a fixed table, so a type
 * name from someone else's catalogue never reaches a CREATE TABLE.
 *
 * ── on reading in one go ────────────────────────────────────────────────────
 * A run reads up to `rowLimit` rows into memory and then writes them. That is
 * a real bound, and it is why the limit exists and why a run that reaches it
 * is reported as `truncated` rather than quietly reported as complete. The
 * alternative — a server-side cursor — needs parameters in a DECLARE through
 * the extended protocol, which is not a guarantee worth building on.
 */

import type { Pool } from "pg";
import { pool, query, queryOne } from "./db";
import { columnsOfRows, normaliseColumnName } from "./inferTypes";
import { BadRequest, NotFound, quoteIdentifier } from "./registry";

/** Where synced tables land. Never tms_raw: that is the captured snapshot. */
export const LANDING_SCHEMA = "connection_raw";

/** Rows per INSERT is bounded by PostgreSQL's 65535 parameters per statement. */
const MAX_PARAMS_PER_INSERT = 60_000;

// ── the source ──────────────────────────────────────────────────────────────

/**
 * The connectors this platform can register.
 *
 * `rest` is not decoration: every payload this whole platform is built on came
 * from a TMS REST API, and until it existed the one source that demonstrably
 * matters could not be registered at all.
 */
export type ConnectorKind = "postgresql" | "rest";

export interface ConnectionSpec {
	name: string;
	description?: string | null;
	folderId?: number | null;
	engine: ConnectorKind;

	// ── postgresql ────────────────────────────────────────────────────────────
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	sslMode?: "disable" | "require" | "prefer";

	// ── rest ──────────────────────────────────────────────────────────────────
	/** Scheme, host and any common prefix: https://api.example.com/v1 */
	baseUrl?: string;
	/**
	 * How the credential is presented. `none` is a real choice — a public or
	 * network-restricted endpoint needs no secret, and pretending it does
	 * would make it unregisterable.
	 */
	authScheme?: "none" | "bearer" | "header" | "basic";
	/** For `header`: which header carries it, e.g. X-API-Key. */
	headerName?: string;
	/** A path this connection can be tested against, when / is not one. */
	healthPath?: string;

	/**
	 * The NAME of an environment variable or the path of a Docker secret file
	 * holding the password or token — never the credential itself.
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
	if (spec.engine === "rest") {
		const auth =
			spec.authScheme && spec.authScheme !== "none"
				? ` (${spec.authScheme}${spec.headerName ? ` ${spec.headerName}` : ""})`
				: "";
		return `${spec.baseUrl ?? ""}${auth}`;
	}
	const secret = spec.secretRef ? ":***" : "";
	return `postgresql://${spec.username}${secret}@${spec.host}:${spec.port}/${spec.database}`;
}

/** The connector a stored connection uses, defaulting to the original one. */
export function connectorOf(properties: Record<string, unknown>): ConnectorKind {
	const engine = String(properties?.engine ?? "").toLowerCase();
	return engine === "rest" ? "rest" : "postgresql";
}

/**
 * The spec a stored connection resource describes.
 *
 * Returns null for a connection with no host — the one the sandbox seeds to
 * describe the platform's own database, which is reached through the service's
 * own pool and has nothing to dial.
 */
export function specFromProperties(
	name: string,
	properties: Record<string, unknown>,
): ConnectionSpec | null {
	if (connectorOf(properties) === "rest") {
		const baseUrl = typeof properties?.baseUrl === "string" ? properties.baseUrl.trim() : "";
		if (!baseUrl) return null;
		return {
			name,
			engine: "rest",
			baseUrl,
			authScheme: (properties.authScheme as ConnectionSpec["authScheme"]) ?? "none",
			headerName: (properties.headerName as string | undefined) ?? undefined,
			healthPath: (properties.healthPath as string | undefined) ?? undefined,
			username: (properties.username as string | undefined) ?? undefined,
			secretRef: (properties.secretRef as string | null) ?? null,
		};
	}
	const host = typeof properties?.host === "string" ? properties.host.trim() : "";
	if (!host) return null;
	return {
		name,
		engine: "postgresql",
		host,
		port: Number(properties.port) || 5432,
		database: String(properties.database ?? ""),
		username: String(properties.username ?? ""),
		secretRef: (properties.secretRef as string | null) ?? null,
		sslMode: (properties.sslMode as ConnectionSpec["sslMode"]) ?? "prefer",
	};
}

// ── REST ────────────────────────────────────────────────────────────────────

/** Join a base URL and a path without doubling or dropping the separator. */
export function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	if (!path) return base;
	return `${base}/${path.replace(/^\/+/, "")}`;
}

/**
 * The headers a REST connection presents, with the credential resolved.
 *
 * Built at the moment of use and never stored: what the connection holds is
 * the NAME of the variable or the PATH of the secret, exactly as a PostgreSQL
 * connection holds its password reference.
 */
function restHeaders(spec: ConnectionSpec): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	const scheme = spec.authScheme ?? "none";
	if (scheme === "none") return headers;

	const credential = resolveSecret(spec.secretRef);
	if (credential === null) {
		throw new BadRequest(
			spec.secretRef
				? unreadableSecret(spec.secretRef)
				: `This connection uses ${scheme} authentication but names no secret to read it from.`,
		);
	}

	if (scheme === "bearer") headers.authorization = `Bearer ${credential}`;
	else if (scheme === "basic") {
		headers.authorization = `Basic ${Buffer.from(`${spec.username ?? ""}:${credential}`).toString("base64")}`;
	} else if (scheme === "header") {
		if (!spec.headerName) {
			throw new BadRequest("A header credential needs the header's name, e.g. X-API-Key.");
		}
		headers[spec.headerName.toLowerCase()] = credential;
	}
	return headers;
}

/** One request to a REST source, bounded in time and in size. */
async function restFetch(
	spec: ConnectionSpec,
	path: string,
	timeoutMs: number,
): Promise<{ status: number; body: string; contentType: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(joinUrl(spec.baseUrl ?? "", path), {
			method: "GET",
			headers: restHeaders(spec),
			signal: controller.signal,
			redirect: "follow",
		});
		const body = await response.text();
		if (body.length > REST_MAX_BYTES) {
			throw new BadRequest(
				`The response is larger than the ${Math.round(REST_MAX_BYTES / 1024 / 1024)} MB a sync may read in one request.`,
			);
		}
		return {
			status: response.status,
			body,
			contentType: response.headers.get("content-type") ?? "",
		};
	} finally {
		clearTimeout(timer);
	}
}

/** How much of a REST response one request may carry. */
const REST_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The records inside a response.
 *
 * A REST payload is rarely a bare array, and guessing which key holds the rows
 * is how a sync silently lands one row containing the whole document. So the
 * path is declared — "data.items" — and when it is not, a bare array is taken
 * as the records and anything else is refused with what was actually found.
 */
export function extractRecords(
	payload: unknown,
	recordsPath: string | null,
): Array<Record<string, unknown>> {
	let current: unknown = payload;

	if (recordsPath) {
		for (const key of recordsPath.split(".").filter(Boolean)) {
			if (current === null || typeof current !== "object") {
				throw new BadRequest(
					`The response has no '${recordsPath}': it stopped being an object at '${key}'.`,
				);
			}
			current = (current as Record<string, unknown>)[key];
			if (current === undefined) {
				throw new BadRequest(`The response has no '${recordsPath}': '${key}' is not in it.`);
			}
		}
	}

	if (Array.isArray(current)) {
		const rows = current.filter(
			(row): row is Record<string, unknown> =>
				row !== null && typeof row === "object" && !Array.isArray(row),
		);
		if (rows.length !== current.length) {
			throw new BadRequest(
				"Some records are not objects. A dataset row is a set of named fields, so an " +
					"array of numbers or strings cannot become one - name a path that reaches the objects.",
			);
		}
		return rows;
	}

	if (current !== null && typeof current === "object") {
		// A single object is a single row — the normal shape for a "current
		// state" endpoint — UNLESS it looks like an envelope, in which case the
		// records path was almost certainly forgotten. Landing the whole
		// document as one row and calling the sync successful is the exact
		// failure this function exists to prevent, so the candidates are found
		// and offered instead.
		const candidates = recordArrayPaths(current as Record<string, unknown>);
		if (!recordsPath && candidates.length > 0) {
			throw new BadRequest(
				`The response is an object, not a list of records. Its records look like they are at ` +
					`${candidates.map((path) => `'${path}'`).join(" or ")} — set the records path to one of those. ` +
					"Without it this would land the whole document as a single row.",
			);
		}
		return [current as Record<string, unknown>];
	}

	const found = current === null ? "null" : `a ${typeof current}`;
	throw new BadRequest(
		`The records are ${found}, not a list of objects. Set the records path to the ` +
			"field holding them, e.g. 'data.items'.",
	);
}

/**
 * Where inside an envelope the records probably are.
 *
 * Two levels deep, which covers `items`, `data.items` and `result.records`
 * without turning into a search. Offered as a suggestion, never applied:
 * guessing which key holds the rows is how a sync lands the wrong thing
 * confidently, so the caller is told and decides.
 */
function recordArrayPaths(envelope: Record<string, unknown>, prefix = "", depth = 0): string[] {
	const found: string[] = [];
	for (const [key, value] of Object.entries(envelope)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
		) {
			found.push(path);
		} else if (depth < 1 && value !== null && typeof value === "object" && !Array.isArray(value)) {
			found.push(...recordArrayPaths(value as Record<string, unknown>, path, depth + 1));
		}
	}
	return found;
}

/**
 * Reach the REST source and say what came back.
 *
 * A 401 and a wrong base URL and an unreadable secret are three different
 * problems with the same symptom — "it did not work" — so each is named. The
 * status code is reported as-is rather than judged: a 404 on the base URL of an
 * API whose root is not a route is a perfectly healthy source, and saying
 * "reachable, but / answered 404" is more use than calling it broken.
 */
async function testRestConnection(spec: ConnectionSpec): Promise<ConnectionTest> {
	const started = Date.now();
	const at = new Date().toISOString();

	if (!spec.baseUrl) {
		return { ok: false, latencyMs: 0, detail: "This connection has no base URL.", testedAt: at };
	}

	try {
		const response = await restFetch(spec, spec.healthPath ?? "", 10_000);
		const latencyMs = Date.now() - started;
		const kind = response.contentType.split(";")[0] || "an unstated type";

		if (response.status === 401 || response.status === 403) {
			return {
				ok: false,
				latencyMs,
				detail:
					`The source answered ${response.status}: the credential was rejected or is missing. ` +
					(spec.authScheme === "none"
						? "This connection presents no credential — set an auth scheme."
						: `Check the secret '${spec.secretRef}' holds the right ${spec.authScheme} value.`),
				testedAt: at,
			};
		}
		if (response.status >= 500) {
			return {
				ok: false,
				latencyMs,
				detail: `The source answered ${response.status}. It is reachable but not healthy.`,
				testedAt: at,
			};
		}
		return {
			ok: response.status < 400,
			latencyMs,
			detail:
				response.status < 400
					? `Reached it: HTTP ${response.status}, ${kind}, ${response.body.length.toLocaleString("en-US")} bytes.`
					: `Reachable, but ${spec.healthPath || "/"} answered ${response.status}. ` +
						"That can be correct — name a path that exists to be sure.",
			serverVersion: kind,
			testedAt: at,
		};
	} catch (error) {
		const failure = error as Error;
		return {
			ok: false,
			latencyMs: Date.now() - started,
			detail:
				failure.name === "AbortError"
					? "The source did not answer within 10 s."
					: failure.message,
			testedAt: at,
		};
	}
}

/**
 * What a REST sync landed, as rows ready for a table.
 *
 * JSON keys are not SQL identifiers, so they are normalised and the mapping is
 * returned: a build that silently renamed `orderNumber` to `order_number`
 * without saying so would leave someone hunting for a column that is there
 * under another name.
 */
export function shapeRestRecords(records: Array<Record<string, unknown>>): {
	rows: Array<Record<string, unknown>>;
	renamed: Array<{ from: string; to: string }>;
} {
	const mapping = new Map<string, string>();
	const renamed: Array<{ from: string; to: string }> = [];
	const taken = new Set<string>();

	const keys: string[] = [];
	for (const record of records) {
		for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key);
	}

	keys.forEach((key, index) => {
		let name = normaliseColumnName(key, index);
		// Two different keys can normalise to the same column. Suffixed rather
		// than dropped, because losing a field silently is the worse outcome.
		let suffix = 2;
		while (taken.has(name)) name = `${normaliseColumnName(key, index)}_${suffix++}`;
		taken.add(name);
		mapping.set(key, name);
		if (name !== key) renamed.push({ from: key, to: name });
	});

	const rows = records.map((record) => {
		const row: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			row[mapping.get(key) ?? key] =
				value !== null && typeof value === "object" ? JSON.stringify(value) : value;
		}
		return row;
	});

	return { rows, renamed };
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
 * A connection that has never been tested is a guess, which is the whole
 * reason this exists: wrong host, wrong password, no route and SSL required
 * are indistinguishable from each other until something tries.
 */
export async function testConnection(spec: ConnectionSpec): Promise<ConnectionTest> {
	if (spec.engine === "rest") return testRestConnection(spec);

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
		// The driver's message is the useful part — "password authentication
		// failed", "no pg_hba.conf entry", "ECONNREFUSED" each point somewhere
		// different — so it is passed through rather than replaced.
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

const CATALOG_SQL = `
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
	   AND n.nspname NOT IN ('pg_catalog','information_schema')
	   AND n.nspname NOT LIKE 'pg\\_toast%'
	   AND has_schema_privilege(n.oid, 'USAGE')
	   AND has_table_privilege(c.oid, 'SELECT')
	 ORDER BY n.nspname, c.relname`;

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

/**
 * Every relation the connection's own user can read, on the host it points at.
 *
 * Asked of the far side, not of this database. The previous implementation
 * queried the platform's own pg_class over three hardcoded schemas, so a
 * connection to another host showed this platform's tables under a heading
 * that said they were the connection's.
 */
export async function remoteCatalog(spec: ConnectionSpec | null): Promise<RemoteRelation[]> {
	if (!spec) {
		const rows = await query<CatalogRow>(CATALOG_SQL);
		return rows.map(toRemoteRelation);
	}
	const password = resolveSecret(spec.secretRef);
	if (spec.secretRef && password === null) throw new BadRequest(unreadableSecret(spec.secretRef));

	const probe = openRemote(spec, password, 15_000);
	try {
		const result = await probe.query<CatalogRow>(CATALOG_SQL);
		return result.rows.map(toRemoteRelation);
	} catch (error) {
		throw new BadRequest(`Could not read the catalogue on ${spec.host}: ${(error as Error).message}`);
	} finally {
		await probe.end().catch(() => {});
	}
}

/**
 * What a stored connection can read, asked of the host it names.
 *
 * The entry point for "show me what is on the other side", which is the first
 * thing anyone needs before they can declare a sync.
 */
export async function connectionCatalog(resourceId: number): Promise<{
	connection: string;
	isPlatformDatabase: boolean;
	connector: ConnectorKind;
	relations: RemoteRelation[];
	note: string | null;
}> {
	const row = await queryOne<{ name: string; properties: Record<string, unknown> }>(
		"SELECT name, properties FROM platform.resource WHERE resource_id = $1 AND kind = 'connection'",
		[resourceId],
	);
	if (!row) throw new NotFound(`No connection resource ${resourceId}.`);

	const spec = specFromProperties(row.name, row.properties ?? {});

	// A REST source has no catalogue to read: there is no standard way to ask
	// an HTTP API what it exposes. Saying so plainly is better than an empty
	// list that reads as "this source has nothing in it".
	if (spec?.engine === "rest") {
		return {
			connection: row.name,
			isPlatformDatabase: false,
			connector: "rest" as const,
			relations: [],
			note:
				"A REST source has no catalogue to list. Name the path in the sync instead, " +
				"e.g. /orders, and the records path if the rows are nested in the response.",
		};
	}

	return {
		connection: row.name,
		isPlatformDatabase: spec === null,
		connector: "postgresql" as const,
		relations: await remoteCatalog(spec),
		note: null,
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
		const relations = await probe.query<CatalogRow>(CATALOG_SQL);
		const bySchema = new Map<string, number>();
		for (const row of relations.rows) {
			bySchema.set(row.schema, (bySchema.get(row.schema) ?? 0) + 1);
		}
		return {
			// `database` is optional on the spec now that a REST connection has no
			// such field; this path is PostgreSQL-only, so it falls back to "".
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
 * Remote type → the type the landing table uses.
 *
 * A fixed table, and the reason for it is not tidiness: `format_type()` on the
 * far side returns a string from someone else's catalogue, and that string
 * would otherwise be spliced into a CREATE TABLE. Anything not listed widens
 * to text, which is lossless for display — the driver hands unknown types back
 * as strings anyway — and the columns that widened are recorded on the dataset
 * so nobody has to guess why a number arrived as text.
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
 * without needing the sync row to explain it. Derived here because a table
 * name is the one thing in a statement that cannot be a bound parameter, and
 * the safe way to handle that is to never let the caller write it.
 *
 * Truncated to 63 characters — PostgreSQL's identifier limit — from the RIGHT,
 * keeping the table name, which is the part that distinguishes two syncs of
 * the same shape.
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
	/** REST only: the path on the source, appended to its base URL. */
	sourcePath: string | null;
	/** REST only: dotted path to the array of records in the response. */
	recordsPath: string | null;
	mode: "snapshot" | "incremental";
	cursorColumn: string | null;
	lastCursorValue: string | null;
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
}

export interface SyncRunRecord {
	id: number;
	syncId: number;
	status: "running" | "success" | "failed";
	mode: "snapshot" | "incremental";
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	rowsRead: number | null;
	rowsWritten: number | null;
	rowsBefore: number | null;
	rowsAfter: number | null;
	cursorFrom: string | null;
	cursorTo: string | null;
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
	source_path: string | null;
	records_path: string | null;
	mode: "snapshot" | "incremental";
	cursor_column: string | null;
	last_cursor_value: string | null;
	target_table: string;
	row_limit: number;
	dataset_resource_id: number | null;
	enabled: boolean;
	created_by: string;
	created_at: Date;
	updated_at: Date;
};

type RunRow = {
	sync_run_id: number;
	sync_id: number;
	status: SyncRunRecord["status"];
	mode: SyncRunRecord["mode"];
	started_at: Date;
	finished_at: Date | null;
	duration_ms: number | null;
	rows_read: string | null;
	rows_written: string | null;
	rows_before: string | null;
	rows_after: string | null;
	cursor_from: string | null;
	cursor_to: string | null;
	truncated: boolean;
	error_message: string | null;
	triggered_by: string;
};

const SYNC_SELECT = `
	SELECT s.*, r.name AS connection_name
	  FROM platform.connection_sync s
	  JOIN platform.resource r ON r.resource_id = s.resource_id`;

function toRun(row: RunRow): SyncRunRecord {
	return {
		// BIGINT arrives from the driver as a string, and these are compared
		// and used as ids downstream. Coerced once, here, rather than at every
		// place that reads one.
		id: Number(row.sync_run_id),
		syncId: Number(row.sync_id),
		status: row.status,
		mode: row.mode,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		durationMs: row.duration_ms,
		rowsRead: row.rows_read === null ? null : Number(row.rows_read),
		rowsWritten: row.rows_written === null ? null : Number(row.rows_written),
		rowsBefore: row.rows_before === null ? null : Number(row.rows_before),
		rowsAfter: row.rows_after === null ? null : Number(row.rows_after),
		cursorFrom: row.cursor_from,
		cursorTo: row.cursor_to,
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
		sourcePath: row.source_path,
		recordsPath: row.records_path,
		mode: row.mode,
		cursorColumn: row.cursor_column,
		lastCursorValue: row.last_cursor_value,
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
	name: string;
	description?: string | null;
	/** PostgreSQL: the schema and table. */
	sourceSchema?: string;
	sourceTable?: string;
	/** REST: the path on the source, and where the records sit in the response. */
	sourcePath?: string;
	recordsPath?: string | null;
	mode?: "snapshot" | "incremental";
	cursorColumn?: string | null;
	rowLimit?: number;
}

export interface ValidatedSync {
	name: string;
	description: string | null;
	sourceSchema: string;
	sourceTable: string;
	sourcePath: string | null;
	recordsPath: string | null;
	mode: "snapshot" | "incremental";
	cursorColumn: string | null;
	rowLimit: number;
}

/**
 * A REST path, checked before it is joined to a base URL.
 *
 * Traversal is refused outright: a path is a route on the source, and `..` in
 * one is either a mistake or an attempt to leave the prefix the connection was
 * registered for. A query string is allowed — plenty of endpoints need one.
 */
export function assertRestPath(value: string): string {
	const path = String(value ?? "").trim();
	if (!path) throw new BadRequest("A REST sync needs a path, e.g. /orders.");
	if (path.length > 500) throw new BadRequest("A path is at most 500 characters.");
	if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
		throw new BadRequest(
			`'${path}' is a whole URL. Give a path relative to the connection's base URL, ` +
				"so the source stays the one that was registered and tested.",
		);
	}
	if (path.split(/[/?#]/).includes("..")) {
		throw new BadRequest(`'${path}' walks out of the connection's base URL.`);
	}
	if (/\s/.test(path)) throw new BadRequest("A path cannot contain spaces; percent-encode them.");
	return path;
}

/** The dotted path to the records, or null. Keys only: no indexes, no wildcards. */
export function assertRecordsPath(value: string | null | undefined): string | null {
	const path = String(value ?? "").trim();
	if (!path) return null;
	if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
		throw new BadRequest(
			`'${path}' is not a records path. Use dotted field names, e.g. 'data.items'.`,
		);
	}
	return path;
}

/**
 * Everything about a sync request that can be judged without a network.
 *
 * Kept apart from creating one so it is testable, and so the same checks run
 * whether the request came from the dialog or from a `.sync.json` file in a
 * repository.
 */
export function validateSyncRequest(
	request: SyncRequest,
	connector: ConnectorKind = "postgresql",
): ValidatedSync {
	const name = String(request.name ?? "").trim();
	if (!name) throw new BadRequest("A sync needs a name.");
	if (name.length > 120) throw new BadRequest("A sync name is at most 120 characters.");

	// A REST source has no schema or table to name. `rest` goes in the schema
	// column as the marker the run path branches on, and the table column holds
	// the slug the landing table is named for — derived from the path, so a
	// sync on /orders lands somewhere called ..._orders.
	let sourceSchema: string;
	let sourceTable: string;
	let sourcePath: string | null = null;
	let recordsPath: string | null = null;

	if (connector === "rest") {
		sourceSchema = "rest";
		sourcePath = assertRestPath(request.sourcePath ?? "");
		recordsPath = assertRecordsPath(request.recordsPath);
		const slug = sourcePath
			.split("?")[0]!
			.split("/")
			.filter(Boolean)
			.join("_")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "");
		sourceTable = slug || "root";
	} else {
		sourceSchema = assertIdentifier(request.sourceSchema ?? "", "schema name");
		sourceTable = assertIdentifier(request.sourceTable ?? "", "table name");
	}

	const mode = request.mode ?? "snapshot";
	if (mode !== "snapshot" && mode !== "incremental") {
		throw new BadRequest(`'${mode}' is not a sync mode. Use 'snapshot' or 'incremental'.`);
	}

	let cursorColumn: string | null = null;
	if (mode === "incremental") {
		if (!request.cursorColumn) {
			throw new BadRequest(
				connector === "rest"
					? "An incremental REST sync needs a cursor field — the field whose increasing " +
						"value says which records are new. It is sent back as a query parameter of " +
						"the same name, and read from each record to find the next one."
					: "An incremental sync needs a cursor column — the column whose increasing " +
						"value says which rows are new. Without one every run would re-read the " +
						"whole table and append it.",
			);
		}
		cursorColumn = assertIdentifier(request.cursorColumn, "cursor column");
	}

	const rowLimit = Math.floor(Number(request.rowLimit ?? 50_000));
	if (!Number.isFinite(rowLimit) || rowLimit < 1 || rowLimit > 1_000_000) {
		throw new BadRequest("rowLimit must be between 1 and 1,000,000 rows.");
	}

	return {
		name,
		description: request.description ?? null,
		sourceSchema,
		sourceTable,
		sourcePath,
		recordsPath,
		mode,
		cursorColumn,
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
 * Define a sync, after checking the source really exists on the far side.
 *
 * The check is the point: a sync that names a table nobody can read is found
 * now, with the name of the table in the message, rather than the first time
 * somebody runs it and gets a driver error.
 */
export async function createSync(
	resourceId: number,
	request: SyncRequest,
	createdBy: string,
): Promise<SyncRecord> {
	const connection = await connectionResource(resourceId);
	const connector = connectorOf(connection.properties ?? {});
	const valid = validateSyncRequest(request, connector);
	const spec = specFromProperties(connection.name, connection.properties ?? {});

	// The source is checked NOW, with its name in the message, rather than the
	// first time somebody runs it and gets a driver error or a 404.
	if (connector === "rest") {
		if (!spec) throw new BadRequest("This connection has no base URL to reach.");
		const probe = await restFetch(spec, valid.sourcePath ?? "", 15_000);
		if (probe.status >= 400) {
			throw new BadRequest(
				`${valid.sourcePath} answered HTTP ${probe.status} on ${spec.baseUrl}. ` +
					"Check the path, and that the connection's credential reaches it.",
			);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(probe.body);
		} catch {
			throw new BadRequest(
				`${valid.sourcePath} did not return JSON (${probe.contentType || "no content type"}). ` +
					"A sync lands records, so the response has to be a JSON document.",
			);
		}
		// Throws with what was actually found if the records path is wrong,
		// which is the failure worth catching before anything is stored.
		const records = extractRecords(payload, valid.recordsPath);
		if (valid.cursorColumn && records.length > 0 && !(valid.cursorColumn in records[0]!)) {
			throw new BadRequest(
				`'${valid.cursorColumn}' is not a field of the records at ${valid.sourcePath}. ` +
					`They have: ${Object.keys(records[0]!).join(", ")}.`,
			);
		}
	} else {
		const columns = await sourceColumns(spec, valid.sourceSchema, valid.sourceTable);
		if (columns.length === 0) {
			throw new BadRequest(
				`${valid.sourceSchema}.${valid.sourceTable} is not readable through this connection. ` +
					"Either it does not exist, or the connection's user cannot select from it.",
			);
		}
		if (valid.cursorColumn && !columns.some((column) => column.name === valid.cursorColumn)) {
			throw new BadRequest(
				`'${valid.cursorColumn}' is not a column of ${valid.sourceSchema}.${valid.sourceTable}. ` +
					`It has: ${columns.map((c) => c.name).join(", ")}.`,
			);
		}
	}

	const targetTable = syncTargetTableName(connection.name, valid.sourceSchema, valid.sourceTable);

	// One sync owns one landing table, and the table's name is derived from the
	// connection and the source — so a second sync of the same source, under a
	// different name, would collide. Refused here with what to do about it,
	// rather than surfacing as a unique-violation from the insert below.
	//
	// Number() on both sides: resource_id is a BIGINT and reaches here as a
	// string, so a strict comparison against the numeric route parameter would
	// always be unequal and every sync would be reported as a clash.
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

	const row = await queryOne<SyncRow>(
		`INSERT INTO platform.connection_sync
		   (resource_id, name, description, source_schema, source_table, source_path,
		    records_path, mode, cursor_column, target_table, row_limit, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		 ON CONFLICT (resource_id, name) DO UPDATE
		    SET description   = EXCLUDED.description,
		        source_schema = EXCLUDED.source_schema,
		        source_table  = EXCLUDED.source_table,
		        source_path   = EXCLUDED.source_path,
		        records_path  = EXCLUDED.records_path,
		        mode          = EXCLUDED.mode,
		        cursor_column = EXCLUDED.cursor_column,
		        target_table  = EXCLUDED.target_table,
		        row_limit     = EXCLUDED.row_limit,
		        updated_at    = now()
		 RETURNING *`,
		[
			resourceId,
			valid.name,
			valid.description,
			valid.sourceSchema,
			valid.sourceTable,
			valid.sourcePath,
			valid.recordsPath,
			valid.mode,
			valid.cursorColumn,
			targetTable,
			valid.rowLimit,
			createdBy,
		],
	);
	if (!row) throw new BadRequest("The sync could not be created.");
	return getSync(row.sync_id);
}

export async function deleteSync(syncId: number): Promise<void> {
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
 * The columns of the source table, read from the far side's catalogue.
 *
 * This is also the check that the table exists and that the connection's user
 * can see it: information_schema.columns only shows what the caller has some
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

/** A cursor value as it is stored: text, and comparable by the far side. */
function cursorText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

/** The columns of a local table, so an incremental run can check they still match. */
async function landedColumns(table: string): Promise<string[]> {
	const rows = await query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		[LANDING_SCHEMA, table],
	);
	return rows.map((row) => row.column_name);
}

export interface SyncOutcome {
	run: SyncRunRecord;
	sync: SyncRecord;
	/** Columns whose type had no local equivalent and landed as text. */
	widenedColumns: string[];
	datasetResourceId: number | null;
}

/**
 * Pull the source across.
 *
 * Reads into memory up to the sync's row limit, then writes locally inside one
 * transaction — so a failure part way through leaves the previous table in
 * place rather than half of a new one.
 */
export async function runSync(syncId: number, triggeredBy: string): Promise<SyncOutcome> {
	const sync = await getSync(syncId);
	if (!sync.enabled) throw new BadRequest(`The sync '${sync.name}' is disabled.`);

	const connection = await connectionResource(sync.resourceId);
	const spec = specFromProperties(connection.name, connection.properties ?? {});

	const started = Date.now();
	const runRow = await queryOne<RunRow>(
		`INSERT INTO platform.connection_sync_run (sync_id, status, mode, cursor_from, triggered_by)
		 VALUES ($1,'running',$2,$3,$4) RETURNING *`,
		[syncId, sync.mode, sync.lastCursorValue, triggeredBy],
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
		// ── REST: fetch, find the records, shape them into rows ───────────────
		if (sync.sourceSchema === "rest") {
			if (!spec) return await fail("This connection has no base URL to reach.");
			return await runRestSync(sync, spec, runRow, started, fail, connection, triggeredBy);
		}

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

		let where = "";
		let order = "";
		const params: unknown[] = [];
		if (sync.mode === "incremental") {
			const cursor = quoteIdentifier(sync.cursorColumn!);
			// Ordered so the last row read holds the highest cursor value, which
			// is what the next run starts from. The parameter is sent untyped,
			// so the server resolves it against the column's real type.
			order = ` ORDER BY ${cursor} ASC`;
			if (sync.lastCursorValue !== null) {
				params.push(sync.lastCursorValue);
				where = ` WHERE ${cursor} > $1`;
			}
		}

		// One more than the limit, so a run can tell "exactly the limit" from
		// "there was more and we stopped".
		const readSql = `SELECT ${selectList} FROM ${from}${where}${order} LIMIT ${sync.rowLimit + 1}`;

		let rows: Array<Record<string, unknown>>;
		if (spec) {
			const password = resolveSecret(spec.secretRef);
			if (spec.secretRef && password === null) return await fail(unreadableSecret(spec.secretRef));
			const probe = openRemote(spec, password, 120_000);
			try {
				rows = (await probe.query(readSql, params)).rows;
			} catch (error) {
				return await fail(`Reading ${sync.sourceSchema}.${sync.sourceTable} failed: ${(error as Error).message}`);
			} finally {
				await probe.end().catch(() => {});
			}
		} else {
			rows = await query(readSql, params);
		}

		const truncated = rows.length > sync.rowLimit;
		if (truncated) rows = rows.slice(0, sync.rowLimit);

		let landed: { rowsBefore: number; rowsAfter: number };
		try {
			landed = await writeLanding(sync.targetTable, sync.mode, mapped, rows);
		} catch (error) {
			return await fail((error as Error).message);
		}
		const { rowsBefore, rowsAfter } = landed;

		const cursorTo =
			sync.mode === "incremental" && rows.length > 0
				? cursorText(rows[rows.length - 1]![sync.cursorColumn!])
				: sync.lastCursorValue;

		await query(
			`UPDATE platform.connection_sync
			    SET last_cursor_value = $2, updated_at = now()
			  WHERE sync_id = $1`,
			[syncId, cursorTo],
		);

		const datasetResourceId = await ensureSyncDataset(connection, sync, mapped, rowsAfter);

		const finished = await queryOne<RunRow>(
			`UPDATE platform.connection_sync_run
			    SET status = 'success', finished_at = now(), duration_ms = $2,
			        rows_read = $3, rows_written = $3, rows_before = $4, rows_after = $5,
			        cursor_to = $6, truncated = $7
			  WHERE sync_run_id = $1
			 RETURNING *`,
			[
				runRow.sync_run_id,
				Date.now() - started,
				rows.length,
				rowsBefore,
				rowsAfter,
				cursorTo,
				truncated,
			],
		);

		return {
			run: toRun(finished ?? runRow),
			sync: await getSync(syncId),
			widenedColumns: mapped.filter((column) => column.widened).map((column) => column.name),
			datasetResourceId,
		};
	} catch (error) {
		// A BadRequest here already has its run row marked failed by fail().
		if (error instanceof BadRequest) throw error;
		return await fail((error as Error).message);
	}
}

/**
 * Write what a run read into the landing table, in one transaction.
 *
 * Shared by both connectors, because the difference between them ends the
 * moment the rows are in hand: a snapshot rebuilds, an incremental run appends,
 * and either way a failure part way through must leave the previous table
 * standing rather than half of a new one.
 */
async function writeLanding(
	targetTable: string,
	mode: "snapshot" | "incremental",
	columns: Array<{ name: string; localType: string }>,
	rows: Array<Record<string, unknown>>,
): Promise<{ rowsBefore: number; rowsAfter: number }> {
	const target = `${quoteIdentifier(LANDING_SCHEMA)}.${quoteIdentifier(targetTable)}`;
	const definition = columns
		.map((column) => `${quoteIdentifier(column.name)} ${column.localType}`)
		.join(", ");

	const client = await pool.connect();
	let rowsBefore = 0;
	let rowsAfter = 0;
	try {
		await client.query("BEGIN");

		const existingColumns = await landedColumns(targetTable);
		if (existingColumns.length > 0) {
			const counted = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${target}`);
			rowsBefore = Number(counted.rows[0]?.n ?? 0);
		}

		if (mode === "snapshot") {
			// Rebuilt, not appended to: a snapshot is what the source holds now,
			// and keeping rows the source has since deleted would make it
			// something else.
			await client.query(`DROP TABLE IF EXISTS ${target}`);
			await client.query(`CREATE TABLE ${target} (${definition})`);
		} else if (existingColumns.length === 0) {
			await client.query(`CREATE TABLE ${target} (${definition})`);
		} else {
			// An incremental run appends into a table that already exists, so the
			// two column sets have to still agree. Reported rather than worked
			// around: silently inserting a subset would produce a table whose
			// newer rows are missing a column that its older rows have.
			const missing = columns.filter((column) => !existingColumns.includes(column.name));
			const extra = existingColumns.filter(
				(name) => !columns.some((column) => column.name === name),
			);
			if (missing.length > 0 || extra.length > 0) {
				await client.query("ROLLBACK");
				throw new BadRequest(
					`The source's fields have changed since ${LANDING_SCHEMA}.${targetTable} was created ` +
						`(${missing.length > 0 ? `new: ${missing.map((c) => c.name).join(", ")}` : ""}` +
						`${missing.length > 0 && extra.length > 0 ? "; " : ""}` +
						`${extra.length > 0 ? `gone: ${extra.join(", ")}` : ""}). ` +
						"Run this sync once in snapshot mode to rebuild the table.",
				);
			}
		}

		if (rows.length > 0 && columns.length > 0) {
			// Batched multi-row inserts. The batch size is chosen from the column
			// count so a statement never exceeds PostgreSQL's parameter limit.
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
		rowsAfter = Number(after.rows[0]?.n ?? 0);
		await client.query("COMMIT");
		return { rowsBefore, rowsAfter };
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		if (error instanceof BadRequest) throw error;
		throw new BadRequest(`Writing ${LANDING_SCHEMA}.${targetTable} failed: ${(error as Error).message}`);
	} finally {
		client.release();
	}
}

/**
 * Pull a REST source across.
 *
 * One request per run. Paging would be the obvious next thing, and it is
 * deliberately absent rather than half-present: every API spells it
 * differently, and guessing wrong means silently landing page one and
 * reporting it as the whole collection. The row limit and `truncated` say
 * plainly when the response was larger than the run took.
 */
async function runRestSync(
	sync: SyncRecord,
	spec: ConnectionSpec,
	runRow: RunRow,
	started: number,
	fail: (message: string) => Promise<never>,
	connection: ConnectionResourceRow,
	triggeredBy: string,
): Promise<SyncOutcome> {
	void triggeredBy;

	// An incremental REST sync sends the last cursor back as a query parameter
	// of the same name. That is the convention this platform picks and states,
	// because there is no standard one.
	let path = sync.sourcePath ?? "";
	if (sync.mode === "incremental" && sync.cursorColumn && sync.lastCursorValue !== null) {
		const separator = path.includes("?") ? "&" : "?";
		path = `${path}${separator}${encodeURIComponent(sync.cursorColumn)}=${encodeURIComponent(sync.lastCursorValue)}`;
	}

	let records: Array<Record<string, unknown>>;
	try {
		const response = await restFetch(spec, path, 120_000);
		if (response.status >= 400) {
			return await fail(`${path} answered HTTP ${response.status} on ${spec.baseUrl}.`);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(response.body);
		} catch {
			return await fail(
				`${path} did not return JSON (${response.contentType || "no content type"}).`,
			);
		}
		records = extractRecords(payload, sync.recordsPath);
	} catch (error) {
		return await fail(`Reading ${path} failed: ${(error as Error).message}`);
	}

	const truncated = records.length > sync.rowLimit;
	if (truncated) records = records.slice(0, sync.rowLimit);

	const { rows, renamed } = shapeRestRecords(records);
	const columns = columnsOfRows(rows).map((column) => ({
		name: column.name,
		localType: column.type,
		remoteType: "json",
		// A REST field has no declared type at all, so "widened" is not a
		// meaningful claim about it: the type here is inferred from the values
		// and nothing was lost relative to a type that never existed.
		widened: false,
	}));

	if (rows.length > 0 && columns.length === 0) {
		return await fail(`${path} returned ${rows.length} records with no fields in them.`);
	}

	let landed: { rowsBefore: number; rowsAfter: number };
	try {
		landed = await writeLanding(sync.targetTable, sync.mode, columns, rows);
	} catch (error) {
		return await fail((error as Error).message);
	}

	const cursorTo =
		sync.mode === "incremental" && rows.length > 0
			? cursorText(rows[rows.length - 1]![normaliseColumnName(sync.cursorColumn!, 0)])
			: sync.lastCursorValue;

	await query(
		"UPDATE platform.connection_sync SET last_cursor_value = $2, updated_at = now() WHERE sync_id = $1",
		[sync.id, cursorTo],
	);

	const datasetResourceId = await ensureSyncDataset(connection, sync, columns, landed.rowsAfter);

	const finished = await queryOne<RunRow>(
		`UPDATE platform.connection_sync_run
		    SET status = 'success', finished_at = now(), duration_ms = $2,
		        rows_read = $3, rows_written = $3, rows_before = $4, rows_after = $5,
		        cursor_to = $6, truncated = $7
		  WHERE sync_run_id = $1
		 RETURNING *`,
		[
			runRow.sync_run_id,
			Date.now() - started,
			rows.length,
			landed.rowsBefore,
			landed.rowsAfter,
			cursorTo,
			truncated,
		],
	);

	return {
		run: toRun(finished ?? runRow),
		sync: await getSync(sync.id),
		// Reused to carry the renames: the caller shows it as "these fields
		// arrived under another name", which is the same kind of fact.
		widenedColumns: renamed.map((entry) => `${entry.from} → ${entry.to}`),
		datasetResourceId,
	};
}

/**
 * The dataset a sync produces, created once and refreshed after every run.
 *
 * Written with SQL rather than through createResource so this module does not
 * depend on spaces.ts — spaces.ts depends on this one, for the preview of a
 * connection, and a cycle between them would be a worse problem than the
 * dozen lines duplicated here.
 */
async function ensureSyncDataset(
	connection: ConnectionResourceRow,
	sync: SyncRecord,
	columns: Array<{ name: string; localType: string; remoteType: string; widened: boolean }>,
	rowCount: number,
): Promise<number | null> {
	const relation = `${LANDING_SCHEMA}.${sync.targetTable}`;
	const properties = {
		sourceView: relation,
		backing: "sync" as const,
		connectionResourceId: connection.resource_id,
		connectionName: connection.name,
		syncId: sync.id,
		syncName: sync.name,
		syncMode: sync.mode,
		source:
			sync.sourceSchema === "rest"
				? `${sync.sourcePath} (REST)`
				: `${sync.sourceSchema}.${sync.sourceTable}`,
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
		await query(
			"UPDATE platform.connection_sync SET dataset_resource_id = $2 WHERE sync_id = $1",
			[sync.id, existing.resource_id],
		);
		return Number(existing.resource_id);
	}

	const created = await queryOne<{ resource_id: number }>(
		`INSERT INTO platform.resource
		   (project_id, folder_id, kind, name, description, target_ref, properties, created_by)
		 VALUES ($1,$2,'dataset',$3,$4,$5,$6::jsonb,'system')
		 ON CONFLICT DO NOTHING
		 RETURNING resource_id`,
		[
			connection.project_id,
			connection.folder_id,
			sync.targetTable,
			`Synced from ${sync.sourceSchema}.${sync.sourceTable} through the '${connection.name}' connection.`,
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
 * Whether a relation is one the platform itself wrote.
 *
 * The published ontology is not the only honest source of rows any more: a
 * synced table and a built transform are both real, both traceable, and
 * neither is in the registry. This is how a reader is allowed to see them
 * without opening the door to an arbitrary relation name.
 */
export const PLATFORM_WRITTEN_SCHEMAS = [LANDING_SCHEMA, "repo_out", "pipeline_out"];

export async function isPlatformWrittenRelation(qualified: string): Promise<boolean> {
	const [schema, name, ...rest] = qualified.split(".");
	if (!schema || !name || rest.length > 0) return false;
	if (!PLATFORM_WRITTEN_SCHEMAS.includes(schema)) return false;
	const row = await queryOne<{ exists: boolean }>(
		`SELECT true AS exists
		   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m')`,
		[schema, name],
	);
	return Boolean(row);
}
