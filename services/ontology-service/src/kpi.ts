import { assertSimulationAllowed } from "./dataPolicy";
import { query } from "./db";
import { BadRequest, getRegistry, type KpiMeta, NotFound, quoteIdentifier, quoteQualified } from "./registry";

/**
 * KPI execution.
 *
 * A KPI is never free-form SQL. It names a metric view, a measure column and an
 * aggregation, all recorded in platform.kpi_definition, and this module turns
 * that into a query. The consequence worth stating: the assistant can ask for
 * "on-time percentage by carrier" and cannot ask for anything nobody defined.
 * Every number the platform shows traces to a catalogue row.
 */

interface ColumnMeta {
	name: string;
	sqlType: string;
}

// Metric views are not object types, so their columns are not in the registry.
// Cached on first use; the set only changes when the pipeline reruns.
const columnCache = new Map<string, Map<string, ColumnMeta>>();

async function metricViewColumns(view: string): Promise<Map<string, ColumnMeta>> {
	const cached = columnCache.get(view);
	if (cached) return cached;

	const [schema, name] = view.split(".");
	if (!schema || !name) throw new BadRequest(`Malformed view name '${view}'.`);

	const rows = await query<{ column_name: string; data_type: string }>(
		`SELECT column_name, data_type FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2`,
		[schema, name],
	);
	if (rows.length === 0) {
		throw new BadRequest(`Metric view '${view}' has no columns or does not exist.`);
	}
	const map = new Map(rows.map((r) => [r.column_name, { name: r.column_name, sqlType: r.data_type }]));
	columnCache.set(view, map);
	return map;
}

/**
 * Clamp a caller-supplied row limit into [1, ceiling].
 *
 * Interpolated into the SQL text rather than bound, because Postgres will not
 * take a parameter for LIMIT in every position these builders emit. The
 * explicit Number() and finite check are therefore part of the safety story:
 * a non-numeric limit becomes the default rather than reaching the query as
 * NaN.
 */
function clampLimit(supplied: unknown, fallback: number, ceiling: number): number {
	const requested = supplied === undefined || supplied === null ? fallback : Number(supplied);
	if (!Number.isFinite(requested)) return fallback;
	return Math.min(Math.max(1, Math.floor(requested)), ceiling);
}

export function clearColumnCache(): void {
	columnCache.clear();
}

export interface KpiExecuteRequest {
	/** Column to group by; defaults to the KPI's default dimension. */
	dimension?: string | null;
	/** Equality filters on the metric view, e.g. {transportation_mode: "Truckload"}. */
	filters?: Record<string, unknown>;
	limit?: number;
	sort?: "value_desc" | "value_asc" | "dimension_asc" | "dimension_desc";
	/** Skip grouping entirely and return the single headline figure. */
	totalOnly?: boolean;
}

export interface KpiExecuteResult {
	kpi: string;
	label: string;
	unit: string | null;
	valueFormat: string;
	higherIsBetter: boolean | null;
	target: number | null;
	warningThreshold: number | null;
	criticalThreshold: number | null;
	businessQuestion: string | null;
	description: string | null;
	/** The headline number across everything matching the filters. */
	total: number | null;
	/** Per-dimension breakdown; empty when totalOnly or no dimension applies. */
	dimension: string | null;
	dimensionLabel: string | null;
	series: Array<{ label: string; value: number | null }>;
	rowCount: number;
	dependsOnSimulation: boolean;
	coverageNote: string | null;
	/** How the number was computed, so a tile can always be audited. */
	sql: string;
	appliedFilters: Record<string, unknown>;
}

export function resolveKpi(apiName: string): KpiMeta {
	const registry = getRegistry();
	const exact = registry.kpiByApiName.get(apiName);
	if (exact) return exact;
	const lowered = apiName.toLowerCase();
	const found = registry.kpis.find((k) => k.apiName.toLowerCase() === lowered);
	if (found) return found;
	throw new NotFound(
		`Unknown KPI '${apiName}'. Available: ${registry.kpis.map((k) => k.apiName).join(", ")}`,
	);
}

/**
 * Build the SQL expression for the KPI's value.
 *
 * `ratio` is the interesting case: a percentage must be computed as
 * sum(numerator)/sum(denominator) over the group, never as the average of a
 * per-row percentage. Averaging pre-computed percentages weights a lane with two
 * stops the same as one with two hundred, which is how an on-time figure ends up
 * quietly wrong.
 */
function valueExpression(kpi: KpiMeta, columns: Map<string, ColumnMeta>): string {
	const requireColumn = (name: string | null, role: string): string => {
		if (!name) throw new BadRequest(`KPI ${kpi.apiName} has no ${role} column defined.`);
		if (!columns.has(name)) {
			throw new BadRequest(`KPI ${kpi.apiName} names ${role} column '${name}', which ${kpi.sourceView} does not have.`);
		}
		return quoteIdentifier(name);
	};

	switch (kpi.aggregation) {
		case "ratio": {
			const numerator = requireColumn(kpi.numeratorColumn, "numerator");
			const denominator = requireColumn(kpi.denominatorColumn, "denominator");
			const scale = kpi.valueFormat === "percent" ? "100.0 * " : "";
			return `${scale}sum(${numerator}) / NULLIF(sum(${denominator}), 0)`;
		}
		case "count":
			return "count(*)";
		case "count_distinct": {
			const column = requireColumn(kpi.measureColumn, "measure");
			return `count(DISTINCT ${column})`;
		}
		case "passthrough": {
			// The view already computed one value per grain, so collapsing with max
			// returns that value rather than inventing an aggregate of it.
			const column = requireColumn(kpi.measureColumn, "measure");
			return `max(${column})`;
		}
		case "sum":
		case "avg":
		case "min":
		case "max": {
			const column = requireColumn(kpi.measureColumn, "measure");
			return `${kpi.aggregation}(${column})`;
		}
		default:
			throw new BadRequest(`KPI ${kpi.apiName} has unsupported aggregation '${kpi.aggregation}'.`);
	}
}

function buildFilters(
	kpi: KpiMeta,
	columns: Map<string, ColumnMeta>,
	filters: Record<string, unknown>,
): { sql: string; values: unknown[]; applied: Record<string, unknown> } {
	const predicates: string[] = [];
	const values: unknown[] = [];
	const applied: Record<string, unknown> = {};

	for (const [rawColumn, value] of Object.entries(filters)) {
		if (value === undefined || value === null || value === "" || value === "__all__") continue;
		if (!columns.has(rawColumn)) {
			throw new BadRequest(
				`Cannot filter ${kpi.apiName} on '${rawColumn}'. ${kpi.sourceView} exposes: ` +
					[...columns.keys()].join(", "),
			);
		}
		const column = quoteIdentifier(rawColumn);
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			const placeholders = value.map((v) => {
				values.push(v);
				return `$${values.length}`;
			});
			predicates.push(`${column}::text IN (${placeholders.join(", ")})`);
		} else {
			values.push(value);
			predicates.push(`${column}::text = $${values.length}::text`);
		}
		applied[rawColumn] = value;
	}

	return {
		sql: predicates.length ? `WHERE ${predicates.join(" AND ")}` : "",
		values,
		applied,
	};
}

export async function executeKpi(
	apiName: string,
	request: KpiExecuteRequest = {},
): Promise<KpiExecuteResult> {
	const kpi = resolveKpi(apiName);
	// Every KPI read reaches this function - the API, a dashboard widget and
	// the assistant's execute_kpi tool all come through here - so this is the
	// one place the policy has to hold.
	assertSimulationAllowed(`KPI ${kpi.apiName}`, kpi.dependsOnSimulation);
	const columns = await metricViewColumns(kpi.sourceView);
	const expression = valueExpression(kpi, columns);
	const { sql: whereSql, values, applied } = buildFilters(kpi, columns, request.filters ?? {});
	const view = quoteQualified(kpi.sourceView);

	// Headline figure first: it is what a stat tile needs and what the assistant
	// quotes, and it must not depend on the grouping or the row limit.
	const totalSql = `SELECT ${expression} AS value FROM ${view} ${whereSql}`;
	const totalRows = await query<{ value: string | null }>(totalSql, values);
	const total = totalRows[0]?.value === null || totalRows[0]?.value === undefined
		? null
		: Number(totalRows[0].value);

	let dimension: string | null = null;
	if (!request.totalOnly) {
		const requested = request.dimension === undefined ? kpi.defaultDimension : request.dimension;
		if (requested) {
			if (!kpi.dimensions.includes(requested)) {
				throw new BadRequest(
					`${kpi.apiName} cannot be grouped by '${requested}'. Allowed: ` +
						kpi.dimensions.join(", "),
				);
			}
			if (!columns.has(requested)) {
				throw new BadRequest(
					`${kpi.apiName} declares dimension '${requested}' but ${kpi.sourceView} has no such column.`,
				);
			}
			dimension = requested;
		}
	}

	let series: Array<{ label: string; value: number | null }> = [];
	let seriesSql = totalSql;

	if (dimension) {
		const dimensionColumn = quoteIdentifier(dimension);
		const limit = clampLimit(request.limit, 25, 500);
		const sort = request.sort ?? "value_desc";
		const orderSql =
			sort === "value_asc"
				? "ORDER BY value ASC NULLS LAST"
				: sort === "dimension_asc"
					? `ORDER BY ${dimensionColumn} ASC NULLS LAST`
					: sort === "dimension_desc"
						? `ORDER BY ${dimensionColumn} DESC NULLS LAST`
						: "ORDER BY value DESC NULLS LAST";

		seriesSql =
			`SELECT ${dimensionColumn}::text AS label, ${expression} AS value ` +
			`FROM ${view} ${whereSql} ` +
			`GROUP BY ${dimensionColumn} ` +
			// A NULL dimension is a real bucket (an order with no mode), but it is
			// never what someone means by "top 10 lanes", so it is excluded here and
			// still counted in the total above.
			`HAVING ${dimensionColumn} IS NOT NULL ` +
			`${orderSql} LIMIT ${limit}`;

		const rows = await query<{ label: string | null; value: string | null }>(seriesSql, values);
		series = rows.map((row) => ({
			label: row.label ?? "(none)",
			value: row.value === null ? null : Number(row.value),
		}));
	}

	return {
		kpi: kpi.apiName,
		label: kpi.label,
		unit: kpi.unit,
		valueFormat: kpi.valueFormat,
		higherIsBetter: kpi.higherIsBetter,
		target: kpi.targetValue,
		warningThreshold: kpi.warningThreshold,
		criticalThreshold: kpi.criticalThreshold,
		businessQuestion: kpi.businessQuestion,
		description: kpi.description,
		total,
		dimension,
		dimensionLabel: dimension ? humanizeColumn(dimension) : null,
		series,
		rowCount: series.length,
		dependsOnSimulation: kpi.dependsOnSimulation,
		coverageNote: kpi.coverageNote,
		sql: dimension ? seriesSql : totalSql,
		appliedFilters: applied,
	};
}

export function humanizeColumn(column: string): string {
	return column
		.split("_")
		.filter(Boolean)
		.map((word) => (word === "pct" ? "%" : word[0]!.toUpperCase() + word.slice(1)))
		.join(" ");
}

/** Distinct values for a dimension, to populate a filter dropdown. */
export async function dimensionValues(
	apiName: string,
	dimension: string,
	limit = 200,
): Promise<Array<{ value: string; count: number }>> {
	const kpi = resolveKpi(apiName);
	if (!kpi.dimensions.includes(dimension)) {
		throw new BadRequest(
			`${kpi.apiName} has no dimension '${dimension}'. Allowed: ${kpi.dimensions.join(", ")}`,
		);
	}
	const columns = await metricViewColumns(kpi.sourceView);
	if (!columns.has(dimension)) {
		throw new BadRequest(`${kpi.sourceView} has no column '${dimension}'.`);
	}
	const column = quoteIdentifier(dimension);
	const rows = await query<{ value: string; n: string }>(
		`SELECT ${column}::text AS value, count(*)::bigint AS n
		   FROM ${quoteQualified(kpi.sourceView)}
		  WHERE ${column} IS NOT NULL
		  GROUP BY ${column}
		  ORDER BY count(*) DESC, ${column}
		  LIMIT ${clampLimit(limit, 100, 1000)}`,
	);
	return rows.map((r) => ({ value: r.value, count: Number(r.n) }));
}

/**
 * Internals exposed for tests only. Nothing in src/ imports this.
 */
export const __testing = { clampLimit, valueExpression, buildFilters };
