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
	/**
	 * Column to group by; defaults to the KPI's default dimension. A date column
	 * may carry a grain, `order_date:month`, to group by month rather than by
	 * the exact timestamp.
	 */
	dimension?: string | null;
	/**
	 * Filters on the metric view. A value is matched for equality, a list is
	 * any-of, and {gte, gt, lte, lt} is a range, e.g.
	 * {region: "West", order_date: {gte: "2024-01-01"}}. Keys may carry a
	 * grain too: {"order_date:month": "2024-03-01"}.
	 */
	filters?: Record<string, unknown>;
	limit?: number;
	sort?: "value_desc" | "value_asc" | "dimension_asc" | "dimension_desc";
	/** Skip grouping entirely and return the single headline figure. */
	totalOnly?: boolean;
	/**
	 * Also compute the metric over its time column, for a sparkline and the
	 * change between the last two periods. Ignored for a metric with no time
	 * column.
	 */
	trend?: { grain?: TimeGrain; periods?: number } | boolean;
}

export type TimeGrain = "day" | "week" | "month" | "quarter" | "year";
const TIME_GRAINS: ReadonlySet<string> = new Set(["day", "week", "month", "quarter", "year"]);

export interface KpiTrend {
	grain: TimeGrain;
	timeColumn: string;
	points: Array<{ label: string; value: number | null }>;
	/**
	 * The change between the last two COMPLETE periods; null with fewer than
	 * two. A period the data stops part-way through is not compared: a month
	 * holding six days of orders is not a fall in orders.
	 */
	delta: number | null;
	deltaPct: number | null;
	lastPeriod: string | null;
	previousPeriod: string | null;
	/** The latest date in the data, which is where "now" is for a snapshot. */
	dataThrough: string | null;
	/** True when the newest period in `points` ends after the data does. */
	lastPointPartial: boolean;
}

const GRAIN_INTERVAL: Record<TimeGrain, string> = {
	day: "1 day",
	week: "7 days",
	month: "1 month",
	quarter: "3 months",
	year: "1 year",
};

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
	/** The grain of the dimension when it is a date grouped by period. */
	dimensionGrain: TimeGrain | null;
	/** Filters that are part of the metric's own definition. */
	baseFilters: Record<string, unknown>;
	/** count, sum, avg, ...: whether the parts of a breakdown add up to the total. */
	aggregation?: string;
	trend?: KpiTrend | null;
	/** For a date grouped by period: the latest date in the data. */
	dataThrough?: string | null;
	/**
	 * For a date grouped by period: the label of the newest period when the
	 * data stops part-way through it (a month holding six days of orders), so
	 * a chart or a sentence does not read it as a fall. Null when complete.
	 */
	partialPeriod?: string | null;
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
			// "*" as the denominator means per row: revenue per order is
			// sum(amount) over count(*), not over the sum of some column.
			if (kpi.denominatorColumn === "*") {
				const scale = kpi.valueFormat === "percent" ? "100.0 * " : "";
				return `${scale}sum(${numerator}) / NULLIF(count(*), 0)`;
			}
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

/** A dimension or filter key: a column, optionally with a time grain. */
export interface DimensionRef {
	column: string;
	grain: TimeGrain | null;
}

export function parseDimension(dimension: string): DimensionRef {
	const [column, grain, ...rest] = String(dimension).split(":");
	if (!column || rest.length > 0) throw new BadRequest(`'${dimension}' is not a column or column:grain.`);
	if (grain !== undefined && !TIME_GRAINS.has(grain)) {
		throw new BadRequest(`'${grain}' is not a time grain. Use day, week, month, quarter or year.`);
	}
	return { column, grain: (grain as TimeGrain | undefined) ?? null };
}

function isTemporalType(sqlType: string | undefined): boolean {
	return /date|timestamp/i.test(sqlType ?? "");
}

/**
 * The SQL for a dimension: the quoted column, or its truncation to a period.
 *
 * The grain is checked against a fixed list and the column against the
 * view's catalogue, so neither reaches the statement as caller text.
 */
function dimensionSql(kpi: KpiMeta, ref: DimensionRef, columns: Map<string, ColumnMeta>): string {
	const column = columns.get(ref.column);
	if (!column) {
		throw new BadRequest(`${kpi.apiName} has no column '${ref.column}'. ${kpi.sourceView} exposes: ${[...columns.keys()].join(", ")}`);
	}
	const quoted = quoteIdentifier(ref.column);
	if (!ref.grain) return quoted;
	if (!isTemporalType(column.sqlType)) {
		throw new BadRequest(`'${ref.column}' is not a date, so it has no ${ref.grain}.`);
	}
	return ref.grain === "day" ? `(${quoted})::date` : `date_trunc('${ref.grain}', ${quoted})::date`;
}

/** The cast a range bound is compared under, from the column's real type. */
function boundCast(sqlType: string | undefined, grain: TimeGrain | null): string {
	if (grain) return "date";
	const type = (sqlType ?? "").toLowerCase();
	if (type === "date") return "date";
	if (type.startsWith("timestamp")) return "timestamptz";
	if (/int|numeric|double|real|decimal|money/.test(type)) return "numeric";
	return "text";
}

const RANGE_OPERATORS: Record<string, string> = { gte: ">=", gt: ">", lte: "<=", lt: "<" };

function isRange(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length > 0 &&
		Object.keys(value).every((key) => key in RANGE_OPERATORS)
	);
}

function buildFilters(
	kpi: KpiMeta,
	columns: Map<string, ColumnMeta>,
	filters: Record<string, unknown>,
	startAt = 0,
): { sql: string; values: unknown[]; applied: Record<string, unknown>; predicates: string[] } {
	const predicates: string[] = [];
	const values: unknown[] = [];
	const applied: Record<string, unknown> = {};
	const next = (value: unknown): string => {
		values.push(value);
		return `$${startAt + values.length}`;
	};

	for (const [rawKey, value] of Object.entries(filters)) {
		if (value === undefined || value === null || value === "" || value === "__all__") continue;
		let ref: DimensionRef;
		try {
			ref = parseDimension(rawKey);
		} catch (error) {
			throw new BadRequest(`Cannot filter ${kpi.apiName} on '${rawKey}': ${(error as Error).message}`);
		}
		if (!columns.has(ref.column)) {
			throw new BadRequest(
				`Cannot filter ${kpi.apiName} on '${ref.column}'. ${kpi.sourceView} exposes: ` +
					[...columns.keys()].join(", "),
			);
		}
		const expression = dimensionSql(kpi, ref, columns);
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			predicates.push(`${expression}::text IN (${value.map((v) => next(String(v))).join(", ")})`);
		} else if (isRange(value)) {
			const cast = boundCast(columns.get(ref.column)?.sqlType, ref.grain);
			for (const [op, bound] of Object.entries(value)) {
				if (bound === undefined || bound === null || bound === "") continue;
				predicates.push(`${expression} ${RANGE_OPERATORS[op]} ${next(String(bound))}::${cast}`);
			}
		} else if (typeof value === "object") {
			throw new BadRequest(
				`The filter on '${rawKey}' must be a value, a list of values, or a range with gte/gt/lte/lt.`,
			);
		} else {
			predicates.push(`${expression}::text = ${next(String(value))}::text`);
		}
		applied[rawKey] = value;
	}

	return {
		sql: predicates.length ? `WHERE ${predicates.join(" AND ")}` : "",
		values,
		applied,
		predicates,
	};
}

/** The columns of a KPI's source view, for checking which filters apply. */
export async function kpiColumns(apiName: string): Promise<Set<string>> {
	const kpi = resolveKpi(apiName);
	return new Set((await metricViewColumns(kpi.sourceView)).keys());
}

export async function executeKpi(
	apiName: string,
	request: KpiExecuteRequest = {},
): Promise<KpiExecuteResult> {
	return executeKpiWith(resolveKpi(apiName), request);
}

/**
 * Execute a metric from its definition rather than its name.
 *
 * For a metric that does not exist yet: a proposal shows the number its
 * definition would produce before anyone approves it. The definition's source
 * view and columns are still checked against the catalogue, exactly as for a
 * published metric, so a draft cannot reach a relation a published one could not.
 */
export async function executeKpiWith(
	kpi: KpiMeta,
	request: KpiExecuteRequest = {},
): Promise<KpiExecuteResult> {
	// Every KPI read reaches this function - the API, a dashboard widget and
	// the assistant's execute_kpi tool all come through here - so this is the
	// one place the policy has to hold.
	assertSimulationAllowed(`KPI ${kpi.apiName}`, kpi.dependsOnSimulation);
	const columns = await metricViewColumns(kpi.sourceView);
	const expression = valueExpression(kpi, columns);
	// The metric's own filters first, then the caller's: both hold, so a
	// request cannot widen "revenue from completed orders" to every order.
	const base = buildFilters(kpi, columns, kpi.baseFilters ?? {});
	const requested = buildFilters(kpi, columns, request.filters ?? {}, base.values.length);
	const predicates = [...base.predicates, ...requested.predicates];
	const whereSql = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
	const values = [...base.values, ...requested.values];
	const applied = requested.applied;
	const view = quoteQualified(kpi.sourceView);

	// Headline figure first: it is what a stat tile needs and what the assistant
	// quotes, and it must not depend on the grouping or the row limit.
	const totalSql = `SELECT ${expression} AS value FROM ${view} ${whereSql}`;
	const totalRows = await query<{ value: string | null }>(totalSql, values);
	const total = totalRows[0]?.value === null || totalRows[0]?.value === undefined
		? null
		: Number(totalRows[0].value);

	let dimension: string | null = null;
	let dimensionRef: DimensionRef | null = null;
	if (!request.totalOnly) {
		const wanted = request.dimension === undefined ? kpi.defaultDimension : request.dimension;
		if (wanted) {
			if (!kpi.dimensions.includes(wanted)) {
				throw new BadRequest(
					`${kpi.apiName} cannot be grouped by '${wanted}'. Allowed: ` +
						kpi.dimensions.join(", "),
				);
			}
			dimensionRef = parseDimension(wanted);
			if (!columns.has(dimensionRef.column)) {
				throw new BadRequest(
					`${kpi.apiName} declares dimension '${wanted}' but ${kpi.sourceView} has no such column.`,
				);
			}
			dimension = wanted;
		}
	}

	let series: Array<{ label: string; value: number | null }> = [];
	let seriesSql = totalSql;

	if (dimension && dimensionRef) {
		const dimensionColumn = dimensionSql(kpi, dimensionRef, columns);
		const limit = clampLimit(request.limit, dimensionRef.grain ? 120 : 25, 500);
		// A period is read in time order unless the caller asked otherwise.
		const sort = request.sort ?? (dimensionRef.grain ? "dimension_asc" : "value_desc");
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

	let dataThrough: string | null = null;
	let partialPeriod: string | null = null;
	const periodGrain = dimensionRef?.grain;
	if (dimensionRef && periodGrain && isTemporalType(columns.get(dimensionRef.column)?.sqlType)) {
		const column = quoteIdentifier(dimensionRef.column);
		const where = [...predicates, `${column} IS NOT NULL`].join(" AND ");
		const [coverage] = await query<{ through: string | null; period_start: string | null; period_end: string | null }>(
			`SELECT max(${column})::date::text AS through,
			        date_trunc('${periodGrain}', max(${column}))::date::text AS period_start,
			        (date_trunc('${periodGrain}', max(${column})) + interval '${GRAIN_INTERVAL[periodGrain]}' - interval '1 day')::date::text AS period_end
			   FROM ${view} WHERE ${where}`,
			values,
		);
		dataThrough = coverage?.through ?? null;
		if (coverage?.through && coverage.period_end && coverage.through < coverage.period_end) {
			partialPeriod = coverage.period_start;
		}
	}

	let trend: KpiTrend | null = null;
	if (request.trend && kpi.timeColumn && isTemporalType(columns.get(kpi.timeColumn)?.sqlType)) {
		const options = typeof request.trend === "object" ? request.trend : {};
		const grain: TimeGrain = options.grain && TIME_GRAINS.has(options.grain) ? options.grain : "month";
		const periods = clampLimit(options.periods, 12, 60);
		const bucket = dimensionSql(kpi, { column: kpi.timeColumn, grain }, columns);
		const trendWhere = [...predicates, `${quoteIdentifier(kpi.timeColumn)} IS NOT NULL`].join(" AND ");
		const trendRows = await query<{ label: string; value: string | null }>(
			`SELECT label, value FROM (
			   SELECT ${bucket}::text AS label, ${expression} AS value
			     FROM ${view} WHERE ${trendWhere}
			    GROUP BY ${bucket} ORDER BY ${bucket} DESC LIMIT ${periods}
			 ) recent ORDER BY label ASC`,
			values,
		);
		const points = trendRows.map((row) => ({
			label: row.label,
			value: row.value === null ? null : Number(row.value),
		}));
		const timeColumn = quoteIdentifier(kpi.timeColumn);
		const [coverage] = await query<{ through: string | null; period_end: string | null }>(
			`SELECT max(${timeColumn})::date::text AS through,
			        (date_trunc('${grain}', max(${timeColumn})) + interval '${GRAIN_INTERVAL[grain]}' - interval '1 day')::date::text AS period_end
			   FROM ${view} WHERE ${trendWhere}`,
			values,
		);
		const lastPointPartial = Boolean(
			coverage?.through && coverage.period_end && coverage.through < coverage.period_end,
		);
		const complete = lastPointPartial ? points.slice(0, -1) : points;
		const last = complete[complete.length - 1];
		const previous = complete[complete.length - 2];
		const delta =
			last?.value !== null && last?.value !== undefined && previous?.value !== null && previous?.value !== undefined
				? last.value - previous.value
				: null;
		trend = {
			grain,
			timeColumn: kpi.timeColumn,
			points,
			delta,
			deltaPct: delta !== null && previous?.value ? (delta / Math.abs(previous.value)) * 100 : null,
			lastPeriod: last?.label ?? null,
			previousPeriod: previous?.label ?? null,
			dataThrough: coverage?.through ?? null,
			lastPointPartial,
		};
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
		dimensionLabel: dimension ? dimensionLabelOf(dimension) : null,
		series,
		rowCount: series.length,
		dependsOnSimulation: kpi.dependsOnSimulation,
		coverageNote: kpi.coverageNote,
		sql: dimension ? seriesSql : totalSql,
		appliedFilters: applied,
		dimensionGrain: dimensionRef?.grain ?? null,
		baseFilters: kpi.baseFilters ?? {},
		aggregation: kpi.aggregation,
		trend,
		dataThrough,
		partialPeriod,
	};
}

/** "Shipper Company Name" reads "Shipper": a linked type's name stands for the type. */
export function dimensionLabelOf(dimension: string): string {
	const label = humanizeColumn(dimension);
	const match = /^(.+?) (Company Name|Last Name|Full Name|Name)$/.exec(label);
	if (!match) return label;
	const prefix = match[1]!.toLowerCase();
	const isType = getRegistry().objectTypes.some(
		(type) => type.origin !== "combination" && [type.label, type.pluralLabel ?? ""].some((name) => name.toLowerCase() === prefix),
	);
	return isType ? match[1]! : label;
}

export function humanizeColumn(dimension: string): string {
	const [column = "", grain] = dimension.split(":");
	const label = column
		.split("_")
		.filter(Boolean)
		.map((word) => (word === "pct" ? "%" : word[0]!.toUpperCase() + word.slice(1)))
		.join(" ");
	return grain ? `${label} (${grain})` : label;
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
	const ref = parseDimension(dimension);
	if (!columns.has(ref.column)) {
		throw new BadRequest(`${kpi.sourceView} has no column '${ref.column}'.`);
	}
	const column = dimensionSql(kpi, ref, columns);
	// Periods are offered in time order; categories by how common they are.
	const order = ref.grain ? `${column} DESC` : `count(*) DESC, ${column}`;
	const rows = await query<{ value: string; n: string }>(
		`SELECT ${column}::text AS value, count(*)::bigint AS n
		   FROM ${quoteQualified(kpi.sourceView)}
		  WHERE ${quoteIdentifier(ref.column)} IS NOT NULL
		  GROUP BY ${column}
		  ORDER BY ${order}
		  LIMIT ${clampLimit(limit, 100, 1000)}`,
	);
	return rows.map((r) => ({ value: r.value, count: Number(r.n) }));
}

/**
 * Internals exposed for tests only. Nothing in src/ imports this.
 */
export const __testing = { clampLimit, valueExpression, buildFilters, dimensionSql, parseDimension, boundCast };
