import { query } from "./db";
import {
	BadRequest,
	getRegistry,
	type LinkTypeMeta,
	type ObjectTypeMeta,
	type PropertyMeta,
	quoteIdentifier,
	quoteQualified,
	resolveColumn,
	resolveObjectType,
} from "./registry";

/**
 * Object-set queries over the semantic views.
 *
 * Modelled on Palantir's ObjectSet: filter, order, page, aggregate and traverse
 * links, all in terms of ontology property names rather than SQL. Every
 * identifier is resolved through the registry first (see resolveColumn), so the
 * only caller-supplied values that reach Postgres are bound parameters.
 */

const MAX_PAGE_SIZE = Number(process.env.ONTOLOGY_MAX_PAGE_SIZE ?? 500);
const DEFAULT_PAGE_SIZE = 50;

export type FilterOperator =
	| "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
	| "in" | "notIn" | "contains" | "startsWith" | "endsWith"
	| "isNull" | "isNotNull" | "between";

export interface FilterClause {
	property: string;
	op: FilterOperator;
	value?: unknown;
}

export interface SearchRequest {
	where?: FilterClause[];
	/** Free-text search across the title and every string dimension. */
	search?: string;
	orderBy?: Array<{ property: string; direction?: "asc" | "desc" }>;
	select?: string[];
	limit?: number;
	offset?: number;
	/** Resolve MANY_TO_ONE links to the target's title, for display. */
	includeLinkTitles?: boolean;
}

export interface SearchResult {
	objectType: string;
	label: string;
	totalCount: number;
	returned: number;
	limit: number;
	offset: number;
	properties: Array<{
		apiName: string;
		label: string;
		datatype: string;
		semanticRole: string;
		unit: string | null;
	}>;
	data: Array<Record<string, unknown>>;
	/** SQL actually executed, so a number in the UI can always be traced. */
	sql: string;
}

interface Bindings {
	values: unknown[];
	bind(value: unknown): string;
}

function makeBindings(): Bindings {
	const values: unknown[] = [];
	return {
		values,
		bind(value: unknown) {
			values.push(value);
			return `$${values.length}`;
		},
	};
}

function buildPredicate(
	type: ObjectTypeMeta,
	clause: FilterClause,
	bindings: Bindings,
): string {
	const property = resolveColumn(type, clause.property);
	const column = quoteIdentifier(property.sqlColumn);

	switch (clause.op) {
		case "isNull":
			return `${column} IS NULL`;
		case "isNotNull":
			return `${column} IS NOT NULL`;
		case "eq":
			// Explicit NULL handling: eq with a null value means IS NULL, which is
			// what a caller filtering "carrier is unset" actually wants.
			return clause.value === null
				? `${column} IS NULL`
				: `${column} = ${castTo(property, bindings.bind(clause.value))}`;
		case "ne":
			return clause.value === null
				? `${column} IS NOT NULL`
				: `(${column} IS DISTINCT FROM ${castTo(property, bindings.bind(clause.value))})`;
		case "gt":
			return `${column} > ${castTo(property, bindings.bind(clause.value))}`;
		case "gte":
			return `${column} >= ${castTo(property, bindings.bind(clause.value))}`;
		case "lt":
			return `${column} < ${castTo(property, bindings.bind(clause.value))}`;
		case "lte":
			return `${column} <= ${castTo(property, bindings.bind(clause.value))}`;
		case "in":
		case "notIn": {
			const list = Array.isArray(clause.value) ? clause.value : [clause.value];
			if (list.length === 0) {
				// An empty IN list is a contradiction; say so rather than emitting
				// invalid SQL or silently matching everything.
				return clause.op === "in" ? "false" : "true";
			}
			const placeholders = list.map((v) => castTo(property, bindings.bind(v))).join(", ");
			return `${column} ${clause.op === "in" ? "IN" : "NOT IN"} (${placeholders})`;
		}
		case "contains":
			return `${column}::text ILIKE ${bindings.bind(`%${String(clause.value)}%`)}`;
		case "startsWith":
			return `${column}::text ILIKE ${bindings.bind(`${String(clause.value)}%`)}`;
		case "endsWith":
			return `${column}::text ILIKE ${bindings.bind(`%${String(clause.value)}`)}`;
		case "between": {
			const range = clause.value as [unknown, unknown];
			if (!Array.isArray(range) || range.length !== 2) {
				throw new BadRequest("'between' needs a two-element [from, to] value.");
			}
			return `${column} BETWEEN ${castTo(property, bindings.bind(range[0]))} AND ${castTo(
				property,
				bindings.bind(range[1]),
			)}`;
		}
		default:
			throw new BadRequest(`Unsupported filter operator '${clause.op}'.`);
	}
}

/**
 * Cast a bound parameter to the column's type.
 *
 * Needed because node-postgres sends everything as text and Postgres will not
 * compare text to uuid, date or numeric without help. Without this, filtering
 * Order by accountKey fails with "operator does not exist: uuid = text".
 */
function castTo(property: PropertyMeta, placeholder: string): string {
	switch (property.sqlType) {
		case "uuid":
			return `${placeholder}::uuid`;
		case "integer":
		case "bigint":
		case "smallint":
			return `${placeholder}::bigint`;
		case "numeric":
			return `${placeholder}::numeric`;
		case "double precision":
		case "real":
			return `${placeholder}::double precision`;
		case "boolean":
			return `${placeholder}::boolean`;
		case "date":
			return `${placeholder}::date`;
		case "timestamp with time zone":
		case "timestamp without time zone":
			return `${placeholder}::timestamptz`;
		default:
			return placeholder;
	}
}

function searchPredicate(
	type: ObjectTypeMeta,
	term: string,
	bindings: Bindings,
): string {
	// Search the title plus every text-ish dimension. Numeric and boolean columns
	// are excluded: casting them to text so "2" matches a status code produces
	// results nobody asked for.
	const searchable = type.properties.filter(
		(p) =>
			p.isTitle ||
			p.isIdentity ||
			(p.datatype === "string" &&
				["title", "identity", "dimension", "attribute"].includes(p.semanticRole)),
	);
	if (searchable.length === 0) return "true";
	const placeholder = bindings.bind(`%${term}%`);
	return (
		"(" +
		searchable
			.map((p) => `${quoteIdentifier(p.sqlColumn)}::text ILIKE ${placeholder}`)
			.join(" OR ") +
		")"
	);
}

export async function searchObjects(
	apiName: string,
	request: SearchRequest,
): Promise<SearchResult> {
	const type = resolveObjectType(apiName);
	const bindings = makeBindings();

	const predicates: string[] = [];
	for (const clause of request.where ?? []) {
		predicates.push(buildPredicate(type, clause, bindings));
	}
	if (request.search && request.search.trim()) {
		predicates.push(searchPredicate(type, request.search.trim(), bindings));
	}
	const whereSql = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";

	const selected: PropertyMeta[] =
		request.select && request.select.length
			? request.select.map((field) => resolveColumn(type, field))
			: type.properties;
	// The key and title always come back, whatever was selected: without them the
	// UI cannot link a row to its object.
	for (const property of type.properties) {
		if ((property.isIdentity || property.isTitle) && !selected.includes(property)) {
			selected.unshift(property);
		}
	}

	const orderParts: string[] = [];
	for (const order of request.orderBy ?? []) {
		const property = resolveColumn(type, order.property);
		const direction = order.direction === "desc" ? "DESC" : "ASC";
		orderParts.push(`${quoteIdentifier(property.sqlColumn)} ${direction} NULLS LAST`);
	}
	if (orderParts.length === 0) {
		const fallback = type.titleColumn ?? type.primaryKeyColumn;
		orderParts.push(`${quoteIdentifier(fallback)} ASC NULLS LAST`);
	}

	const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
	const offset = Math.max(0, request.offset ?? 0);

	const view = quoteQualified(type.sourceView);
	const selectList = selected
		.map((p) => `${quoteIdentifier(p.sqlColumn)} AS ${quoteIdentifier(p.apiName)}`)
		.join(", ");

	const dataSql =
		`SELECT ${selectList} FROM ${view} ${whereSql} ` +
		`ORDER BY ${orderParts.join(", ")} LIMIT ${limit} OFFSET ${offset}`;
	const countSql = `SELECT count(*)::bigint AS n FROM ${view} ${whereSql}`;

	const [rows, countRows] = await Promise.all([
		query(dataSql, bindings.values),
		query<{ n: string }>(countSql, bindings.values),
	]);

	let data = rows as Array<Record<string, unknown>>;
	if (request.includeLinkTitles) {
		data = await decorateWithLinkTitles(type, data);
	}

	return {
		objectType: type.apiName,
		label: type.label,
		totalCount: Number(countRows[0]?.n ?? 0),
		returned: data.length,
		limit,
		offset,
		properties: selected.map((p) => ({
			apiName: p.apiName,
			label: p.label,
			datatype: p.datatype,
			semanticRole: p.semanticRole,
			unit: p.unit,
		})),
		data,
		sql: dataSql,
	};
}

/**
 * Replace foreign-key values with the target object's title.
 *
 * Done as one extra query per link type rather than a join per link, because an
 * object like Order has nine references and joining all of them produces a query
 * plan far more expensive than nine keyed lookups against small views.
 */
async function decorateWithLinkTitles(
	type: ObjectTypeMeta,
	rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
	if (rows.length === 0) return rows;
	const registry = getRegistry();
	const links = registry.linksBySourceRid.get(type.rid) ?? [];

	for (const link of links) {
		const target = registry.objectTypeByRid.get(link.targetObjectType);
		if (!target || !target.titleColumn) continue;
		const sourceProperty = type.propertyBySqlColumn.get(link.sourceColumn);
		if (!sourceProperty) continue;

		const keys = [
			...new Set(
				rows
					.map((row) => row[sourceProperty.apiName])
					.filter((value) => value !== null && value !== undefined),
			),
		];
		if (keys.length === 0) continue;

		const titleRows = await query<Record<string, unknown>>(
			`SELECT ${quoteIdentifier(target.primaryKeyColumn)} AS key,
			        ${quoteIdentifier(target.titleColumn)} AS title
			   FROM ${quoteQualified(target.sourceView)}
			  WHERE ${quoteIdentifier(target.primaryKeyColumn)} = ANY($1)`,
			[keys],
		);
		const titles = new Map(titleRows.map((r) => [String(r.key), r.title]));
		const displayField = `${sourceProperty.apiName}__display`;
		for (const row of rows) {
			const value = row[sourceProperty.apiName];
			if (value !== null && value !== undefined) {
				row[displayField] = titles.get(String(value)) ?? null;
			}
		}
	}
	return rows;
}

export async function getObject(
	apiName: string,
	key: string,
): Promise<Record<string, unknown> | null> {
	const type = resolveObjectType(apiName);
	const keyProperty = type.propertyBySqlColumn.get(type.primaryKeyColumn);
	const bindings = makeBindings();
	const placeholder = keyProperty
		? castTo(keyProperty, bindings.bind(key))
		: bindings.bind(key);

	const selectList = type.properties
		.map((p) => `${quoteIdentifier(p.sqlColumn)} AS ${quoteIdentifier(p.apiName)}`)
		.join(", ");

	const rows = await query<Record<string, unknown>>(
		`SELECT ${selectList} FROM ${quoteQualified(type.sourceView)}
		  WHERE ${quoteIdentifier(type.primaryKeyColumn)} = ${placeholder} LIMIT 1`,
		bindings.values,
	);
	const row = rows[0];
	if (!row) return null;
	const [decorated] = await decorateWithLinkTitles(type, [row]);
	return decorated ?? row;
}

export interface LinkTraversal {
	linkType: string;
	label: string;
	direction: "forward" | "inverse";
	targetObjectType: string;
	matchRatio: number;
	totalCount: number;
	data: Array<Record<string, unknown>>;
}

/**
 * Follow a link from one object.
 *
 * Handles both directions: the forward link resolves the reference this object
 * holds; the inverse finds every object pointing back at it. The UI needs both to
 * expand a node in either direction.
 */
export async function traverseLink(
	apiName: string,
	key: string,
	linkApiName: string,
	limit = 100,
): Promise<LinkTraversal> {
	const registry = getRegistry();
	const type = resolveObjectType(apiName);

	const forward = (registry.linksBySourceRid.get(type.rid) ?? []).find(
		(l) => l.apiName === linkApiName,
	);
	const inverse = (registry.linksByTargetRid.get(type.rid) ?? []).find(
		(l) => l.inverseApiName === linkApiName,
	);
	const link = forward ?? inverse;
	if (!link) {
		const available = [
			...(registry.linksBySourceRid.get(type.rid) ?? []).map((l) => l.apiName),
			...(registry.linksByTargetRid.get(type.rid) ?? [])
				.map((l) => l.inverseApiName)
				.filter((n): n is string => Boolean(n)),
		];
		throw new BadRequest(
			`${type.apiName} has no link '${linkApiName}'. Available: ${available.join(", ")}`,
		);
	}

	const isForward = link === forward;
	const otherRid = isForward ? link.targetObjectType : link.sourceObjectType;
	const other = registry.objectTypeByRid.get(otherRid);
	if (!other) throw new BadRequest(`Link '${linkApiName}' points at an unknown object type.`);

	const selectList = other.properties
		.map((p) => `o.${quoteIdentifier(p.sqlColumn)} AS ${quoteIdentifier(p.apiName)}`)
		.join(", ");

	const keyProperty = type.propertyBySqlColumn.get(type.primaryKeyColumn);
	const bindings = makeBindings();
	const keyPlaceholder = keyProperty
		? castTo(keyProperty, bindings.bind(key))
		: bindings.bind(key);

	// Forward: this object's reference column identifies the target row.
	// Inverse: the other view's reference column points back at this object's key.
	const joinSql = isForward
		? `JOIN ${quoteQualified(type.sourceView)} s
		        ON s.${quoteIdentifier(link.sourceColumn)} = o.${quoteIdentifier(link.targetColumn)}
		    WHERE s.${quoteIdentifier(type.primaryKeyColumn)} = ${keyPlaceholder}`
		: `WHERE o.${quoteIdentifier(link.sourceColumn)} = ${keyPlaceholder}`;

	const dataSql =
		`SELECT ${selectList} FROM ${quoteQualified(other.sourceView)} o ${joinSql} ` +
		`ORDER BY o.${quoteIdentifier(other.titleColumn ?? other.primaryKeyColumn)} ` +
		`LIMIT ${Math.min(Math.max(1, limit), MAX_PAGE_SIZE)}`;
	const countSql = `SELECT count(*)::bigint AS n FROM ${quoteQualified(other.sourceView)} o ${joinSql}`;

	const [rows, countRows] = await Promise.all([
		query<Record<string, unknown>>(dataSql, bindings.values),
		query<{ n: string }>(countSql, bindings.values),
	]);

	return {
		linkType: linkApiName,
		label: (isForward ? link.label : link.inverseLabel) ?? linkApiName,
		direction: isForward ? "forward" : "inverse",
		targetObjectType: other.apiName,
		matchRatio: link.matchRatio,
		totalCount: Number(countRows[0]?.n ?? 0),
		data: rows,
	};
}

export interface AggregateRequest {
	groupBy?: string[];
	metrics: Array<{
		property?: string;
		aggregation: "count" | "countDistinct" | "sum" | "avg" | "min" | "max";
		alias?: string;
	}>;
	where?: FilterClause[];
	orderBy?: { alias: string; direction?: "asc" | "desc" };
	limit?: number;
}

export interface AggregateResult {
	objectType: string;
	groupBy: string[];
	rows: Array<Record<string, unknown>>;
	sql: string;
}

export async function aggregateObjects(
	apiName: string,
	request: AggregateRequest,
): Promise<AggregateResult> {
	const type = resolveObjectType(apiName);
	const bindings = makeBindings();

	const groupProperties = (request.groupBy ?? []).map((f) => resolveColumn(type, f));
	const predicates = (request.where ?? []).map((c) => buildPredicate(type, c, bindings));
	const whereSql = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";

	if (request.metrics.length === 0) {
		throw new BadRequest("At least one metric is required.");
	}

	const selectParts: string[] = groupProperties.map(
		(p) => `${quoteIdentifier(p.sqlColumn)} AS ${quoteIdentifier(p.apiName)}`,
	);
	const aliases: string[] = [];

	request.metrics.forEach((metric, index) => {
		let expression: string;
		if (metric.aggregation === "count" && !metric.property) {
			expression = "count(*)";
		} else {
			if (!metric.property) {
				throw new BadRequest(`Metric ${index} needs a property for ${metric.aggregation}.`);
			}
			const property = resolveColumn(type, metric.property);
			// Refuse to sum something that is not a measure. This is the guard that
			// stops an agent averaging a status code or summing a latitude.
			if (
				["sum", "avg"].includes(metric.aggregation) &&
				property.semanticRole !== "measure"
			) {
				throw new BadRequest(
					`${property.apiName} is a ${property.semanticRole}, not a measure; ` +
						`${metric.aggregation} of it would not mean anything. ` +
						`Measures on ${type.apiName}: ` +
						type.properties
							.filter((p) => p.semanticRole === "measure")
							.map((p) => p.apiName)
							.join(", "),
				);
			}
			const column = quoteIdentifier(property.sqlColumn);
			expression =
				metric.aggregation === "countDistinct"
					? `count(DISTINCT ${column})`
					: `${metric.aggregation}(${column})`;
		}
		const alias = metric.alias ?? `${metric.aggregation}_${metric.property ?? "all"}`;
		aliases.push(alias);
		selectParts.push(`${expression} AS ${quoteIdentifier(alias)}`);
	});

	const groupSql = groupProperties.length
		? `GROUP BY ${groupProperties.map((p) => quoteIdentifier(p.sqlColumn)).join(", ")}`
		: "";

	let orderSql = "";
	if (request.orderBy) {
		if (!aliases.includes(request.orderBy.alias)) {
			throw new BadRequest(
				`Cannot order by '${request.orderBy.alias}'; it is not one of the metrics ` +
					`(${aliases.join(", ")}).`,
			);
		}
		orderSql = `ORDER BY ${quoteIdentifier(request.orderBy.alias)} ${
			request.orderBy.direction === "asc" ? "ASC" : "DESC"
		} NULLS LAST`;
	} else if (groupProperties.length && aliases[0]) {
		orderSql = `ORDER BY ${quoteIdentifier(aliases[0])} DESC NULLS LAST`;
	}

	const limit = Math.min(Math.max(1, request.limit ?? 100), MAX_PAGE_SIZE);
	const sql =
		`SELECT ${selectParts.join(", ")} FROM ${quoteQualified(type.sourceView)} ` +
		`${whereSql} ${groupSql} ${orderSql} LIMIT ${limit}`;

	const rows = await query<Record<string, unknown>>(sql, bindings.values);
	return {
		objectType: type.apiName,
		groupBy: groupProperties.map((p) => p.apiName),
		rows,
		sql,
	};
}

/** Cross-type search: used by the explorer's global search box. */
export async function globalSearch(
	term: string,
	perTypeLimit = 5,
): Promise<Array<{ objectType: string; label: string; icon: string | null; color: string | null; hits: Array<Record<string, unknown>> }>> {
	const registry = getRegistry();
	const trimmed = term.trim();
	if (!trimmed) return [];

	const results: Array<{
		objectType: string;
		label: string;
		icon: string | null;
		color: string | null;
		hits: Array<Record<string, unknown>>;
	}> = [];

	// Searched in registry order (transactional types first), which is the order
	// a user is most likely to want.
	for (const type of registry.objectTypes) {
		if (!type.titleColumn) continue;
		const bindings = makeBindings();
		const predicate = searchPredicate(type, trimmed, bindings);
		if (predicate === "true") continue;

		const sql =
			`SELECT ${quoteIdentifier(type.primaryKeyColumn)} AS "key", ` +
			`${quoteIdentifier(type.titleColumn)} AS "title" ` +
			`FROM ${quoteQualified(type.sourceView)} WHERE ${predicate} ` +
			`ORDER BY ${quoteIdentifier(type.titleColumn)} LIMIT ${perTypeLimit}`;
		try {
			const rows = await query<Record<string, unknown>>(sql, bindings.values);
			if (rows.length) {
				results.push({
					objectType: type.apiName,
					label: type.label,
					icon: type.icon,
					color: type.color,
					hits: rows,
				});
			}
		} catch (error) {
			// One unsearchable type must not sink the whole search.
			console.warn(`[search] ${type.apiName} skipped: ${(error as Error).message}`);
		}
	}
	return results;
}
