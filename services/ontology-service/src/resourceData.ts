/**
 * The data behind any workspace resource, one page at a time.
 *
 * The resource preview used to show rows only for datasets. An object type
 * with four real objects showed none; a metric, a link, an action type, a
 * connection and a pipeline showed nothing at all - even though every one of
 * them has real data behind it. This module answers "what does this contain"
 * for every kind, and answers it with the thing that genuinely IS its content:
 *
 *   dataset, object type, metric  the rows of the backing view
 *   link type                     the link instances: source -> target pairs
 *   action type                   its execution log
 *   connection                    the tables and views in that database
 *   pipeline                      its latest run's output table
 *   dashboard                     its widgets and the view each one reads
 *
 * Every page reports its `source`, so the reader can always see what the rows
 * were read from - tms_views.v_kpi_mode_mix, pipeline_out.lane_volume_analytics__out -
 * rather than taking a grid on trust.
 *
 * ── on safety ───────────────────────────────────────────────────────────────
 * Relation names come from the registry or from the platform's own tables,
 * never from the request, and are quoted segment by segment. The sort column
 * must be one the relation actually returns. The search text is a bound
 * parameter matched against the row cast to text. Nothing the caller sends
 * reaches SQL as syntax.
 */

import { pool, query, queryOne } from "./db";
import { connectionCatalog, isPlatformWrittenRelation } from "./connections";
import {
	BadRequest,
	currentSpace,
	getRegistry,
	hasOntology,
	NotFound,
	quoteIdentifier,
	quoteQualified,
} from "./registry";

export interface DataColumn {
	name: string;
	type: string;
}

export interface DataPage {
	/** What the rows were read from, shown to the reader as-is. */
	source: string;
	sourceKind: "view" | "join" | "audit" | "catalog" | "output" | "layout";
	columns: DataColumn[];
	rows: Array<Record<string, unknown>>;
	total: number;
	offset: number;
	limit: number;
	/** Why the page looks the way it does, when that is not obvious. */
	note: string | null;
}

export interface DataQuery {
	offset?: number;
	limit?: number;
	sort?: string;
	dir?: string;
	q?: string;
}

const MAX_LIMIT = 500;

interface Relation {
	sql: string;
	params: unknown[];
	source: string;
	sourceKind: DataPage["sourceKind"];
	note?: string | null;
	/** Applied when the caller did not ask for a sort, so pages are stable. */
	defaultSort?: string;
}

// ── the one paging routine every kind goes through ──────────────────────────

/**
 * The column names and types of a relation, without reading any rows.
 *
 * Read from the result metadata of a LIMIT 0 query and resolved against
 * pg_type, so it works for a join or an audit query as well as a view.
 */
async function describe(relation: Relation): Promise<DataColumn[]> {
	const result = await pool.query(
		`SELECT * FROM (${relation.sql}) AS _r LIMIT 0`,
		relation.params as never[],
	);
	const oids = [...new Set(result.fields.map((field) => field.dataTypeID))];
	const types = await query<{ oid: number; typname: string }>(
		"SELECT oid::int AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])",
		[oids],
	);
	const nameOf = new Map(types.map((row) => [Number(row.oid), row.typname]));
	return result.fields.map((field) => ({
		name: field.name,
		type: nameOf.get(field.dataTypeID) ?? "unknown",
	}));
}

async function page(relation: Relation, request: DataQuery): Promise<DataPage> {
	const columns = await describe(relation);
	const limit = Math.min(Math.max(1, Math.floor(Number(request.limit) || 100)), MAX_LIMIT);
	const offset = Math.max(0, Math.floor(Number(request.offset) || 0));

	// The sort column must be one this relation returns. Anything else is
	// refused rather than silently ignored, so a stale link to a renamed
	// column says so.
	const wantedSort = String(request.sort ?? "").trim() || relation.defaultSort || "";
	let orderBy = "";
	if (wantedSort) {
		const column = columns.find((c) => c.name === wantedSort);
		if (!column) {
			throw new BadRequest(
				`'${wantedSort}' is not a column here. Available: ${columns.map((c) => c.name).join(", ")}.`,
			);
		}
		// Direction is chosen from two literals, never taken from the request.
		const direction = String(request.dir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
		orderBy = ` ORDER BY ${quoteIdentifier(column.name)} ${direction} NULLS LAST`;
	}

	// Search matches the whole row cast to text, with the needle bound as a
	// parameter. One box that finds a value in any column is what a
	// spreadsheet-style view needs; per-column filters can come later.
	const params = [...relation.params];
	let where = "";
	const needle = String(request.q ?? "").trim();
	if (needle) {
		params.push(`%${needle}%`);
		where = ` WHERE _r::text ILIKE $${params.length}`;
	}

	const rows = await query(
		`SELECT * FROM (${relation.sql}) AS _r${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`,
		params,
	);
	const counted = await queryOne<{ n: string }>(
		`SELECT count(*)::text AS n FROM (${relation.sql}) AS _r${where}`,
		params,
	);

	return {
		source: relation.source,
		sourceKind: relation.sourceKind,
		columns,
		rows,
		total: Number(counted?.n ?? 0),
		offset,
		limit,
		note: relation.note ?? null,
	};
}

// ── per kind ────────────────────────────────────────────────────────────────

/**
 * A view the published ontology knows about, as a relation.
 *
 * The only way a view name reaches SQL here: it must be the source view of an
 * object type or a metric in this space's registry.
 */
function publishedView(view: string, note?: string | null): Relation {
	const registry = getRegistry();
	const known =
		registry.objectTypes.some((type) => type.sourceView === view) ||
		registry.kpis.some((kpi) => kpi.sourceView === view);
	if (!known) {
		throw new BadRequest(`'${view}' is not a view the published ontology exposes.`);
	}
	return {
		sql: `SELECT * FROM ${quoteQualified(view)}`,
		params: [],
		source: view,
		sourceKind: "view",
		note: note ?? null,
	};
}

function linkRelation(apiName: string): Relation {
	const registry = getRegistry();
	const link = registry.linkTypeByApiName.get(apiName);
	if (!link) throw new NotFound(`No link type '${apiName}' in this space.`);

	const source = registry.objectTypeByRid.get(link.sourceObjectType);
	const target = registry.objectTypeByRid.get(link.targetObjectType);
	if (!source || !target) {
		throw new NotFound(`Link '${apiName}' joins an object type this space no longer has.`);
	}

	// Title columns make the pairs readable; the key is used where a type has
	// no title. Every identifier comes from the registry.
	const sourceTitle = source.titleColumn ?? source.primaryKeyColumn;
	const targetTitle = target.titleColumn ?? target.primaryKeyColumn;

	return {
		sql:
			`SELECT s.${quoteIdentifier(source.primaryKeyColumn)}::text AS source_key,` +
			` s.${quoteIdentifier(sourceTitle)}::text AS source_title,` +
			` s.${quoteIdentifier(link.sourceColumn)}::text AS link_value,` +
			` t.${quoteIdentifier(target.primaryKeyColumn)}::text AS target_key,` +
			` t.${quoteIdentifier(targetTitle)}::text AS target_title,` +
			` (t.${quoteIdentifier(link.targetColumn)} IS NOT NULL) AS resolved` +
			` FROM ${quoteQualified(source.sourceView)} s` +
			` LEFT JOIN ${quoteQualified(target.sourceView)} t` +
			`   ON s.${quoteIdentifier(link.sourceColumn)}::text = t.${quoteIdentifier(link.targetColumn)}::text` +
			` WHERE s.${quoteIdentifier(link.sourceColumn)} IS NOT NULL`,
		params: [],
		source: `${source.sourceView} ⟶ ${target.sourceView}`,
		sourceKind: "join",
		note:
			`Each row is one ${source.apiName} and the ${target.apiName} it points to. ` +
			`resolved = false where the value matched nothing on the other side ` +
			`(${Math.round(link.matchRatio * 100)}% resolve).`,
	};
}

async function actionRelation(apiName: string): Promise<Relation> {
	const counted = await queryOne<{ n: string }>(
		"SELECT count(*)::text AS n FROM platform.action_audit WHERE api_name = $1",
		[apiName],
	);
	const executed = Number(counted?.n ?? 0);

	return {
		sql:
			"SELECT created_at, actor, actor_role, status, object_type_rid, object_key," +
			" parameters::text AS parameters, result::text AS result, error_message, duration_ms" +
			" FROM platform.action_audit WHERE api_name = $1",
		params: [apiName],
		source: "platform.action_audit",
		sourceKind: "audit",
		defaultSort: "created_at",
		// Said plainly rather than left as an empty grid: an action type that has
		// never run is a normal state, and an unexplained empty table reads as a
		// fault.
		note:
			executed === 0
				? "This action type has not been executed yet, so its log is empty. Run it from Actions."
				: null,
	};
}

/**
 * A page built from rows already in hand, rather than from a SQL relation.
 *
 * Needed where the rows do not come from this database at all — a connection's
 * catalogue is read from the host it points at — so the sort, the search and
 * the paging happen here instead of in a query. The sets are small: a
 * catalogue is hundreds of rows, a repository is tens of files.
 */
function pageFromRows(
	rows: Array<Record<string, unknown>>,
	columns: DataColumn[],
	relation: Omit<Relation, "sql" | "params">,
	request: DataQuery,
): DataPage {
	const limit = Math.min(Math.max(1, Math.floor(Number(request.limit) || 100)), MAX_LIMIT);
	const offset = Math.max(0, Math.floor(Number(request.offset) || 0));

	const needle = String(request.q ?? "").trim().toLowerCase();
	let matched = needle
		? rows.filter((row) =>
				Object.values(row).some((value) =>
					String(value ?? "").toLowerCase().includes(needle),
				),
			)
		: rows;

	const wantedSort = String(request.sort ?? "").trim() || relation.defaultSort || "";
	if (wantedSort) {
		if (!columns.some((column) => column.name === wantedSort)) {
			throw new BadRequest(
				`'${wantedSort}' is not a column here. Available: ${columns.map((c) => c.name).join(", ")}.`,
			);
		}
		const direction = String(request.dir ?? "asc").toLowerCase() === "desc" ? -1 : 1;
		matched = [...matched].sort((a, b) => {
			const left = a[wantedSort];
			const right = b[wantedSort];
			// Nulls last in both directions, matching the SQL path's NULLS LAST.
			if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
			if (right === null || right === undefined) return -1;
			if (typeof left === "number" && typeof right === "number") {
				return (left - right) * direction;
			}
			return String(left).localeCompare(String(right)) * direction;
		});
	}

	return {
		source: relation.source,
		sourceKind: relation.sourceKind,
		columns,
		rows: matched.slice(offset, offset + limit),
		total: matched.length,
		offset,
		limit,
		note: relation.note ?? null,
	};
}

/**
 * What a connection can read — asked of the database it points at.
 *
 * This used to query the platform's own pg_class over three hardcoded schemas,
 * so a connection registered against another host listed THIS platform's
 * tables under a heading that said they were the connection's. A confident
 * wrong answer is worse than no answer, and it is why this now dials the host.
 */
async function connectionPage(resourceId: number, request: DataQuery): Promise<DataPage> {
	const catalog = await connectionCatalog(resourceId);
	const rows = catalog.relations.map((relation) => ({
		schema: relation.schema,
		name: relation.name,
		kind: relation.kind,
		estimated_rows: relation.estimatedRows,
		size: relation.size,
	}));

	return pageFromRows(
		rows,
		[
			{ name: "schema", type: "text" },
			{ name: "name", type: "text" },
			{ name: "kind", type: "text" },
			{ name: "estimated_rows", type: "int8" },
			{ name: "size", type: "text" },
		],
		{
			source: catalog.isPlatformDatabase
				? "this platform's own database"
				: `the database '${catalog.connection}' points at`,
			sourceKind: "catalog",
			defaultSort: "schema",
			note:
				"Every table and view this connection's user can read. estimated_rows is the " +
				"planner's statistic; it is blank for views, which store no rows, and for " +
				"tables not yet analysed. Declare a sync against one of these to bring it across.",
		},
		request,
	);
}

/**
 * A table the platform itself wrote: a synced landing table, a built transform,
 * a pipeline output.
 *
 * The published ontology is no longer the only honest source of rows, so
 * `publishedView` alone would refuse a dataset this platform created itself.
 * The relation is still never taken on trust: its schema must be one of the
 * three the platform writes, and it must exist in the catalogue.
 */
async function platformWrittenRelation(qualified: string, note: string | null): Promise<Relation> {
	if (!(await isPlatformWrittenRelation(qualified))) {
		throw new BadRequest(
			`'${qualified}' is not a relation this platform wrote, and the published ontology ` +
				"does not expose it either.",
		);
	}
	return {
		sql: `SELECT * FROM ${quoteQualified(qualified)}`,
		params: [],
		source: qualified,
		sourceKind: "output",
		note,
	};
}

/** The files in a repository, which is what a repository resource contains. */
async function repoPage(slug: string, request: DataQuery): Promise<DataPage> {
	const rows = await query<{
		path: string;
		language: string;
		lines: string;
		updated_by: string;
		updated_at: Date;
	}>(
		`SELECT f.path, f.language,
		        (length(f.content) - length(replace(f.content, E'\\n', '')) + 1)::text AS lines,
		        f.updated_by, f.updated_at
		   FROM platform.code_file f
		   JOIN platform.code_repo r ON r.repo_id = f.repo_id
		   JOIN platform.space s ON s.space_id = r.space_id
		  WHERE s.slug = $1 AND r.slug = $2
		  ORDER BY f.path`,
		[currentSpace(), slug],
	);

	return pageFromRows(
		rows.map((row) => ({
			path: row.path,
			language: row.language,
			lines: Number(row.lines),
			updated_by: row.updated_by,
			updated_at: row.updated_at.toISOString(),
		})),
		[
			{ name: "path", type: "text" },
			{ name: "language", type: "text" },
			{ name: "lines", type: "int8" },
			{ name: "updated_by", type: "text" },
			{ name: "updated_at", type: "timestamptz" },
		],
		{
			source: `platform.code_file (${slug})`,
			sourceKind: "catalog",
			defaultSort: "path",
			note:
				rows.length === 0
					? "This repository has no files yet."
					: "Open the repository to read or edit a file, and to build it.",
		},
		request,
	);
}

async function pipelineRelation(slug: string): Promise<Relation> {
	// The most recent successful run's final output. Found through the
	// platform's own run records, so the table name is one this engine wrote.
	const output = await queryOne<{ output_table: string; finished_at: Date }>(
		`SELECT nr.output_table, r.finished_at
		   FROM platform.pipeline p
		   JOIN platform.space s ON s.space_id = p.space_id
		   JOIN platform.pipeline_run r ON r.pipeline_id = p.pipeline_id AND r.status = 'success'
		   JOIN platform.pipeline_node_run nr ON nr.pipeline_run_id = r.pipeline_run_id
		  WHERE s.slug = $1 AND p.slug = $2 AND nr.status = 'success' AND nr.output_table IS NOT NULL
		  ORDER BY r.pipeline_run_id DESC,
		           (nr.node_kind = 'output') DESC,
		           nr.pipeline_node_run_id DESC
		  LIMIT 1`,
		[currentSpace(), slug],
	);

	if (!output) {
		return {
			sql: "SELECT NULL::text AS nothing WHERE false",
			params: [],
			source: "no run yet",
			sourceKind: "output",
			note: "This pipeline has not run successfully yet, so it has produced no data. Run it from the Pipeline builder.",
		};
	}

	const [schema, table] = output.output_table.split(".");
	if (schema !== "pipeline_out" || !table) {
		throw new BadRequest(`Unexpected output location '${output.output_table}'.`);
	}

	return {
		sql: `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
		params: [],
		source: output.output_table,
		sourceKind: "output",
		note: `The output of the last successful run, finished ${output.finished_at.toISOString().slice(0, 16).replace("T", " ")}.`,
	};
}

function dashboardRelation(slug: string): Relation {
	return {
		sql:
			"SELECT w.ordinality::int AS position, w.value->>'type' AS widget," +
			" coalesce(w.value->>'title', w.value->>'kpi') AS title," +
			" w.value->>'kpi' AS metric, w.value->>'dimension' AS grouped_by," +
			" k.source_view AS reads_view" +
			" FROM platform.dashboard d" +
			" JOIN platform.space s ON s.space_id = d.space_id" +
			" CROSS JOIN LATERAL jsonb_array_elements(d.layout) WITH ORDINALITY AS w(value, ordinality)" +
			" LEFT JOIN platform.kpi_definition k" +
			"   ON k.space_id = d.space_id AND k.api_name = w.value->>'kpi'" +
			" WHERE s.slug = $1 AND d.slug = $2",
		params: [currentSpace(), slug],
		source: "platform.dashboard",
		sourceKind: "layout",
		defaultSort: "position",
		note: "What this dashboard charts and which view each widget reads. Open it to see the charts.",
	};
}

// ── entry point ─────────────────────────────────────────────────────────────

export async function resourceData(resourceId: number, request: DataQuery): Promise<DataPage> {
	if (!Number.isFinite(resourceId)) throw new BadRequest("A numeric resource id is required.");

	// Scoped to the requesting space, so a resource id from another space is
	// not found rather than read.
	const resource = await queryOne<{
		kind: string;
		target_ref: string | null;
		properties: Record<string, unknown>;
	}>(
		`SELECT r.kind, r.target_ref, r.properties
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE r.resource_id = $1 AND s.slug = $2`,
		[resourceId, currentSpace()],
	);
	if (!resource) throw new NotFound(`No resource ${resourceId} in the '${currentSpace()}' space.`);

	const ref = resource.target_ref ?? "";
	const backing =
		typeof resource.properties?.sourceView === "string"
			? String(resource.properties.sourceView)
			: ref;
	// A dataset the platform wrote itself — a synced landing table, a built
	// transform — is readable without a published ontology, because nothing
	// about it resolves through the registry. Only the kinds that genuinely
	// need the ontology are gated on it.
	const platformWritten = resource.kind === "dataset" && (await isPlatformWrittenRelation(backing));
	const needsOntology =
		!platformWritten && ["dataset", "objectType", "kpi", "linkType"].includes(resource.kind);
	if (needsOntology && !hasOntology(currentSpace())) {
		throw new BadRequest(`No ontology is published in '${currentSpace()}', so there is nothing to read.`);
	}

	switch (resource.kind) {
		case "dataset": {
			if (platformWritten) {
				const origin = String(resource.properties?.backing ?? "");
				return page(
					await platformWrittenRelation(
						backing,
						origin === "sync"
							? `Landed by the '${resource.properties?.syncName ?? "?"}' sync from ` +
									`${resource.properties?.source ?? "the source"} through the ` +
									`'${resource.properties?.connectionName ?? "?"}' connection.`
							: origin === "transform"
								? `Built by ${resource.properties?.repo ?? "a repository"}/${resource.properties?.repoPath ?? "?"}.`
								: null,
					),
					request,
				);
			}
			return page(publishedView(backing), request);
		}

		case "codeRepo":
			return repoPage(ref, request);
		case "objectType": {
			const type = getRegistry().objectTypeByApiName.get(ref);
			if (!type) throw new NotFound(`No object type '${ref}' in this space.`);
			return page(
				publishedView(type.sourceView, `Every ${type.apiName} object, read from its backing view.`),
				request,
			);
		}
		case "kpi": {
			const kpi = getRegistry().kpiByApiName.get(ref);
			if (!kpi) throw new NotFound(`No metric '${ref}' in this space.`);
			return page(
				publishedView(
					kpi.sourceView,
					`The rows ${kpi.label} is computed from. It aggregates ` +
						`${kpi.aggregation}${kpi.measureColumn ? ` of ${kpi.measureColumn}` : ""}.`,
				),
				request,
			);
		}
		case "linkType":
			return page(linkRelation(ref), request);
		case "actionType":
			return page(await actionRelation(ref), request);
		case "connection":
			return connectionPage(resourceId, request);
		case "pipeline":
			return page(await pipelineRelation(ref), request);
		case "dashboard":
			return page(dashboardRelation(ref), request);
		default:
			throw new BadRequest(`A ${resource.kind} has no data to show.`);
	}
}
