/**
 * Importing tables from a PostgreSQL connection, all the way to the ontology.
 *
 * Until now a connection stopped at a dataset: a sync landed one table in
 * connection_raw and registered a card for it, and nothing downstream - no
 * object type, no metric, no dashboard, no answer from the assistant - could
 * use it. This is the rest of the path, in one call:
 *
 *   pick tables  ->  one snapshot sync each  ->  run them  ->  read the
 *   source's primary and foreign keys  ->  model every table into the ontology
 *
 * One table failing does not stop the others: an import of twelve tables in
 * which one is unreadable is eleven imported tables and one named error, not
 * nothing.
 */

import {
	createSync,
	type RemoteKey,
	remoteKeys,
	runSync,
	specFromProperties,
	LANDING_SCHEMA,
} from "./connections";
import { query, queryOne } from "./db";
import { type ModelOutcome, type ModelSource, modelSources } from "./modeling";
import { BadRequest, NotFound } from "./registry";

export interface ImportRequest {
	tables: Array<{ schema: string; table: string }>;
	/** Rows to read per table; the sync's own ceiling still applies. */
	rowLimit?: number;
}

export interface ImportedTable {
	source: string;
	status: "synced" | "failed";
	rows?: number;
	truncated?: boolean;
	landedAs?: string;
	syncId?: number;
	error?: string;
}

export interface ImportOutcome {
	connection: string;
	tables: ImportedTable[];
	model: ModelOutcome | null;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_TABLES = 50;

export function validateImport(request: unknown): ImportRequest {
	const body = (request ?? {}) as Partial<ImportRequest>;
	if (!Array.isArray(body.tables) || body.tables.length === 0) {
		throw new BadRequest("Choose at least one table to import.");
	}
	if (body.tables.length > MAX_TABLES) {
		throw new BadRequest(`At most ${MAX_TABLES} tables can be imported at once.`);
	}
	const seen = new Set<string>();
	const tables = body.tables.map((entry, index) => {
		const schema = String(entry?.schema ?? "").trim();
		const table = String(entry?.table ?? "").trim();
		if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(table)) {
			throw new BadRequest(`tables[${index}] must name a plain schema and table (got '${schema}.${table}').`);
		}
		const key = `${schema}.${table}`;
		if (seen.has(key)) throw new BadRequest(`${key} is listed twice.`);
		seen.add(key);
		return { schema, table };
	});
	const rowLimit = body.rowLimit === undefined ? undefined : Math.floor(Number(body.rowLimit));
	if (rowLimit !== undefined && (!Number.isFinite(rowLimit) || rowLimit < 1 || rowLimit > 1_000_000)) {
		throw new BadRequest("rowLimit must be between 1 and 1,000,000 rows.");
	}
	return { tables, rowLimit };
}

/** The keys of one table, from everything remoteKeys returned. */
export function keysFor(keys: RemoteKey[], schema: string, table: string): {
	primaryKey: string[] | null;
	uniqueColumns: string[];
	foreignKeys: ModelSource["foreignKeys"];
} {
	const own = keys.filter((k) => k.schema === schema && k.table === table);
	const primary = own.find((k) => k.kind === "primary");
	return {
		primaryKey: primary ? primary.columns : null,
		uniqueColumns: own.filter((k) => k.kind === "unique" && k.columns.length === 1).map((k) => k.columns[0]!),
		foreignKeys: own
			.filter((k) => k.kind === "foreign" && k.refSchema && k.refTable)
			.map((k) => ({
				columns: k.columns,
				refSchema: k.refSchema!,
				refTable: k.refTable!,
				refColumns: k.refColumns,
			})),
	};
}

async function connectionRow(resourceId: number): Promise<{ name: string; properties: Record<string, unknown> }> {
	const row = await queryOne<{ name: string; properties: Record<string, unknown> }>(
		"SELECT name, properties FROM platform.resource WHERE resource_id = $1 AND kind = 'connection'",
		[resourceId],
	);
	if (!row) throw new NotFound(`No connection resource ${resourceId}.`);
	return row;
}

/** Where every table already synced through this connection landed. */
async function landedTables(resourceId: number): Promise<Map<string, string>> {
	const rows = await query<{ source_schema: string; source_table: string; target_table: string }>(
		`SELECT s.source_schema, s.source_table, s.target_table
		   FROM platform.connection_sync s
		  WHERE s.resource_id = $1 AND s.source_schema <> 'rest'
		    AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		                 WHERE n.nspname = $2 AND c.relname = s.target_table)`,
		[resourceId, LANDING_SCHEMA],
	);
	return new Map(rows.map((row) => [`${row.source_schema}.${row.source_table}`, `${LANDING_SCHEMA}.${row.target_table}`]));
}

export async function importTables(resourceId: number, body: unknown, username: string): Promise<ImportOutcome> {
	const request = validateImport(body);
	const connection = await connectionRow(resourceId);
	const spec = specFromProperties(connection.name, connection.properties ?? {});
	if (spec?.engine === "rest") {
		throw new BadRequest(
			"Importing tables needs a PostgreSQL connection. A REST source has no tables or keys to read; declare a sync on one of its paths instead.",
		);
	}

	const keys = await remoteKeys(spec, request.tables);
	const tables: ImportedTable[] = [];
	const sources: ModelSource[] = [];

	for (const { schema, table } of request.tables) {
		const source = `${schema}.${table}`;
		try {
			const sync = await createSync(
				resourceId,
				{ name: source, sourceSchema: schema, sourceTable: table, mode: "snapshot", rowLimit: request.rowLimit },
				username,
			);
			const tableKeys = keysFor(keys, schema, table);
			await query(
				`UPDATE platform.connection_sync
				    SET source_primary_key = $2, source_foreign_keys = $3::jsonb
				  WHERE sync_id = $1`,
				[sync.id, tableKeys.primaryKey, JSON.stringify(tableKeys.foreignKeys)],
			);
			const outcome = await runSync(sync.id, username);
			const relation = `${LANDING_SCHEMA}.${outcome.sync.targetTable}`;
			tables.push({
				source,
				status: "synced",
				rows: outcome.run.rowsAfter ?? outcome.run.rowsWritten ?? 0,
				truncated: outcome.run.truncated,
				landedAs: relation,
				syncId: sync.id,
			});
			sources.push({
				relation,
				sourceName: source,
				tableName: table,
				datasetResourceId: outcome.datasetResourceId,
				primaryKey: tableKeys.primaryKey,
				uniqueColumns: tableKeys.uniqueColumns,
				foreignKeys: tableKeys.foreignKeys,
				group: connection.name,
			});
		} catch (error) {
			tables.push({ source, status: "failed", error: (error as Error).message });
		}
	}

	const model = sources.length > 0 ? await modelSources(sources, username, await landedTables(resourceId)) : null;
	return { connection: connection.name, tables, model };
}

/**
 * Model again everything already imported through a connection.
 *
 * For after a re-sync that changed a table's columns, or when the rules that
 * classify columns have improved: keys are read back from the syncs, so the
 * source is not dialled again.
 */
export async function remodelConnection(resourceId: number, username: string): Promise<ModelOutcome> {
	const connection = await connectionRow(resourceId);
	const landed = await landedTables(resourceId);
	const rows = await query<{
		source_schema: string;
		source_table: string;
		target_table: string;
		source_primary_key: string[] | null;
		source_foreign_keys: ModelSource["foreignKeys"] | null;
		dataset_resource_id: string | null;
	}>(
		`SELECT source_schema, source_table, target_table, source_primary_key, source_foreign_keys,
		        dataset_resource_id::text
		   FROM platform.connection_sync WHERE resource_id = $1 AND source_schema <> 'rest'`,
		[resourceId],
	);
	const sources: ModelSource[] = rows
		.filter((row) => landed.has(`${row.source_schema}.${row.source_table}`))
		.map((row) => ({
			relation: `${LANDING_SCHEMA}.${row.target_table}`,
			sourceName: `${row.source_schema}.${row.source_table}`,
			tableName: row.source_table,
			datasetResourceId: row.dataset_resource_id === null ? null : Number(row.dataset_resource_id),
			primaryKey: row.source_primary_key,
			foreignKeys: row.source_foreign_keys ?? [],
			group: connection.name,
		}));
	if (sources.length === 0) throw new BadRequest(`Nothing has been imported through '${connection.name}' yet.`);
	return modelSources(sources, username, landed);
}
