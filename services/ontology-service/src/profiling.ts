/**
 * Profiling a table, and deciding what each column IS.
 *
 * The step that makes an ontology useful rather than a list of columns: a
 * column's SQL type says it is numeric, not whether summing it means anything.
 * `amount` sums; `latitude` does not; `status_code` is an identifier that
 * happens to be an integer; `customer_id` is a reference to another object.
 * The pipeline makes the same distinction for the TMS views, and this module
 * makes it for any table a person connects.
 *
 * The decision is made from the column's name and type AND from measured
 * facts - how many distinct values it holds, whether it is unique, whether the
 * source declared it a key - never from the name alone. Each profile carries
 * the reason for its role, because a person reviewing a modelled object type
 * should be able to see why `zip` is not a measure.
 */

import { query } from "./db";
import { BadRequest, quoteIdentifier, quoteQualified } from "./registry";

export type SemanticRole =
	| "identity"
	| "title"
	| "measure"
	| "dimension"
	| "temporal"
	| "geo"
	| "flag"
	| "attribute";

export type ValueKind = "integer" | "decimal" | "boolean" | "date" | "datetime" | "text" | "json" | "other";

export type ValueFormat = "number" | "integer" | "currency" | "percent";

export interface ColumnInfo {
	name: string;
	/** information_schema data_type, e.g. "numeric", "timestamp with time zone". */
	dataType: string;
	udtName: string;
}

export interface ColumnStats {
	nonNull: number;
	distinct: number | null;
	min: string | null;
	max: string | null;
}

export interface ColumnProfile extends ColumnInfo, ColumnStats {
	kind: ValueKind;
	role: SemanticRole;
	/** ontograph DataType for the ontology document. */
	datatype: string;
	defaultAggregation: "sum" | "avg" | null;
	format: ValueFormat;
	unit: string | null;
	isKey: boolean;
	isForeignKey: boolean;
	isTitle: boolean;
	/** Why the role was chosen, in a sentence a reviewer can check. */
	reason: string;
}

export interface TableKeys {
	/** The source's declared primary key, when it has a single-column one. */
	primaryKey: string[] | null;
	/** Columns the source declares as foreign keys. */
	foreignKeyColumns: Set<string>;
	/** Columns the source declares unique. */
	uniqueColumns?: Set<string>;
}

export function kindOf(dataType: string, udtName = ""): ValueKind {
	const t = dataType.toLowerCase();
	const u = udtName.toLowerCase();
	if (["smallint", "integer", "bigint"].includes(t) || ["int2", "int4", "int8"].includes(u)) return "integer";
	if (["numeric", "real", "double precision", "money"].includes(t) || ["float4", "float8", "numeric", "money"].includes(u)) {
		return "decimal";
	}
	if (t === "boolean" || u === "bool") return "boolean";
	if (t === "date") return "date";
	if (t.startsWith("timestamp")) return "datetime";
	if (t === "json" || t === "jsonb") return "json";
	if (["text", "character varying", "character", "uuid", "citext", "name"].includes(t) || ["varchar", "bpchar", "uuid", "text"].includes(u)) {
		return "text";
	}
	return "other";
}

export function ontographDatatype(kind: ValueKind): string {
	switch (kind) {
		case "integer":
			return "integer";
		case "decimal":
			return "decimal";
		case "boolean":
			return "boolean";
		case "date":
			return "date";
		case "datetime":
			return "datetime";
		case "json":
			return "object";
		default:
			return "string";
	}
}

const ID_NAME = /(^id$|_id$|^id_|_key$|^key$|uuid|guid|_code$|^code$|_no$|_number$|_num$|^sku$|_sku$|_ref$|^ref$)/;
const GEO_NAME = /^(lat|lng|lon|long|latitude|longitude)$|_(lat|lng|lon|latitude|longitude)$/;
const TIME_PART_NAME = /^(year|month|day|week|quarter|hour|weekday|dow)$|_(year|month|day|week|quarter|hour|yr|mo)$|^fiscal_/;
const CATEGORY_NAME = /(status|type|kind|level|category|class|tier|grade|priority|segment|group|region|stage|channel|code|flag|mode|bucket|band)/;
const CODE_LIKE_NAME = /(zip|postal|postcode|phone|fax|mobile|tel|ssn|iban|account_number|card)/;
const AVERAGE_NAME = /(price|rate|ratio|pct|percent|percentage|score|rating|age|avg|average|mean|margin|discount|unit_cost|unit_price|temperature|latency|duration|tenure|probability|share)/;
const CURRENCY_NAME = /(amount|price|cost|revenue|sales|charge|fee|payment|spend|budget|salary|wage|income|profit|freight|tax|balance|paid|due|invoice|total_value|gmv|arr|mrr|ltv|refund|commission|premium|value_usd|usd|eur|gbp|inr)/;
const COUNT_LIKE_NAME = /(count|qty|quantity|number_of|units|items|num_|_num|pieces|seats)/;
const PERCENT_NAME = /(pct|percent|percentage)$|(^|_)(rate|ratio|share)$/;
const TITLE_NAME = /^(name|title|label|full_name|display_name|company|company_name|description|subject)$|_(name|title)$/;

function unitFor(name: string): string | null {
	if (/_kg$|_kgs$|weight_kg/.test(name)) return "kg";
	if (/_lb$|_lbs$/.test(name)) return "lb";
	if (/_km$/.test(name)) return "km";
	if (/_mi$|_miles$/.test(name)) return "mi";
	if (/_hours$|_hrs$|_h$/.test(name)) return "h";
	if (/_minutes$|_mins$/.test(name)) return "min";
	if (/_days$/.test(name)) return "days";
	if (/(pct|percent|percentage)$/.test(name)) return "%";
	return null;
}

function numericRange(stats: ColumnStats): { min: number; max: number } | null {
	const min = stats.min === null ? Number.NaN : Number(stats.min);
	const max = stats.max === null ? Number.NaN : Number(stats.max);
	return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/**
 * Assign every column a role.
 *
 * Pure: everything it knows is in its arguments, so the rules are tested
 * without a database.
 */
export function inferRoles(
	rowCount: number,
	columns: Array<ColumnInfo & ColumnStats>,
	keys: TableKeys,
): ColumnProfile[] {
	const pk = keys.primaryKey && keys.primaryKey.length === 1 ? keys.primaryKey[0]! : null;
	const unique = keys.uniqueColumns ?? new Set<string>();

	// The key: declared first, else the first column that is complete and
	// unique and looks like an identifier, else the first complete unique one.
	const isUniqueComplete = (c: ColumnInfo & ColumnStats) =>
		rowCount > 0 && c.nonNull === rowCount && c.distinct === rowCount;
	let keyColumn = pk;
	if (!keyColumn) {
		const candidates = columns.filter(
			(c) => isUniqueComplete(c) && ["integer", "text"].includes(kindOf(c.dataType, c.udtName)),
		);
		keyColumn =
			candidates.find((c) => ID_NAME.test(c.name.toLowerCase()))?.name ??
			candidates.find((c) => unique.has(c.name))?.name ??
			candidates[0]?.name ??
			null;
	}

	const profiles = columns.map((column): ColumnProfile => {
		const name = column.name.toLowerCase();
		const kind = kindOf(column.dataType, column.udtName);
		const base = {
			...column,
			kind,
			datatype: ontographDatatype(kind),
			defaultAggregation: null as ColumnProfile["defaultAggregation"],
			format: (kind === "integer" ? "integer" : "number") as ValueFormat,
			unit: unitFor(name),
			isKey: column.name === keyColumn,
			isForeignKey: keys.foreignKeyColumns.has(column.name),
			isTitle: false,
		};
		const distinct = column.distinct ?? 0;
		const filled = Math.max(column.nonNull, 1);

		if (base.isKey) {
			return { ...base, role: "identity", reason: pk === column.name ? "The source declares it the primary key." : "Every row has a different, non-empty value, so it identifies the row." };
		}
		if (base.isForeignKey) {
			return { ...base, role: "identity", reason: "The source declares it a foreign key: it refers to another table's rows." };
		}
		if (kind === "boolean") return { ...base, role: "flag", reason: "True or false." };
		if (kind === "date" || kind === "datetime") {
			return { ...base, role: "temporal", reason: "A date or time, so it can place a metric on a timeline." };
		}
		if (kind === "json" || kind === "other") {
			return { ...base, role: "attribute", reason: "A structured or unusual type, kept but neither summed nor grouped." };
		}
		if (ID_NAME.test(name) && !CODE_LIKE_NAME.test(name) && (kind === "integer" || kind === "text")) {
			return { ...base, role: "identity", reason: "Named like an identifier; adding identifiers up means nothing." };
		}

		if (kind === "integer" || kind === "decimal") {
			if (GEO_NAME.test(name)) return { ...base, role: "geo", reason: "A coordinate; summing coordinates means nothing." };
			if (TIME_PART_NAME.test(name)) {
				return { ...base, role: "dimension", reason: "A part of a date (year, month, ...), used to group rather than to add." };
			}
			if (CODE_LIKE_NAME.test(name)) return { ...base, role: "attribute", reason: "A code stored as a number (postal code, phone)." };
			if (kind === "integer" && distinct > 0 && distinct <= 12 && CATEGORY_NAME.test(name)) {
				return { ...base, role: "dimension", reason: `Only ${distinct} distinct values and named like a category.` };
			}
			const range = numericRange(column);
			const averaged = AVERAGE_NAME.test(name);
			const currency = CURRENCY_NAME.test(name) && !COUNT_LIKE_NAME.test(name);
			const percent =
				PERCENT_NAME.test(name) && range !== null && range.min >= 0 && range.max <= 100;
			return {
				...base,
				role: "measure",
				defaultAggregation: averaged || percent ? "avg" : "sum",
				format: percent ? "percent" : currency ? "currency" : base.format,
				unit: percent ? "%" : base.unit,
				reason: averaged || percent
					? "A number that is averaged rather than added (a price, a rate, a score)."
					: "A number that adds up across rows.",
			};
		}

		// Text.
		if (CODE_LIKE_NAME.test(name)) return { ...base, role: "attribute", reason: "A contact detail or code, not a category to group by." };
		const ratio = distinct / filled;
		// A column with a different value on every row cannot group anything,
		// however few rows there are: it names rows rather than sorting them.
		const allDifferent = column.nonNull > 1 && distinct === column.nonNull;
		if (distinct > 0 && distinct <= 200 && (ratio <= 0.5 || distinct <= 12) && !allDifferent) {
			return { ...base, role: "dimension", reason: `${distinct} distinct values across ${column.nonNull} rows: a category to group by.` };
		}
		return { ...base, role: "attribute", reason: "Mostly unique text: describes a row rather than grouping rows." };
	});

	// One title per type: the most name-like text column that is not the key.
	const titleCandidates = profiles.filter(
		(p) => p.kind === "text" && !p.isKey && !p.isForeignKey && !CODE_LIKE_NAME.test(p.name.toLowerCase()) && !/email|url|password|token/.test(p.name.toLowerCase()),
	);
	const title =
		titleCandidates.find((p) => TITLE_NAME.test(p.name.toLowerCase())) ??
		titleCandidates
			.filter((p) => p.role === "attribute")
			.sort((a, b) => (b.distinct ?? 0) - (a.distinct ?? 0))[0];
	if (title) {
		title.isTitle = true;
		if (title.role === "attribute") {
			title.role = "title";
			title.reason = "The most name-like text column: it is what a row is called.";
		}
	}
	return profiles;
}

// ── measuring a relation ────────────────────────────────────────────────────

function splitRelation(relation: string): [string, string] {
	const [schema, name, ...rest] = relation.split(".");
	if (!schema || !name || rest.length > 0) throw new BadRequest(`'${relation}' is not schema.table.`);
	return [schema, name];
}

/** The columns of a local relation, in order. */
export async function relationColumns(relation: string): Promise<ColumnInfo[]> {
	const [schema, name] = splitRelation(relation);
	const rows = await query<{ column_name: string; data_type: string; udt_name: string }>(
		`SELECT column_name, data_type, udt_name FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		[schema, name],
	);
	return rows.map((row) => ({ name: row.column_name, dataType: row.data_type, udtName: row.udt_name }));
}

/**
 * Count, completeness, cardinality and range of every column, in ONE scan.
 *
 * Identifiers come from the catalogue and are quoted, so nothing from a
 * caller reaches the statement. Structured columns are skipped for distinct
 * and range: json has no equality operator, and its "range" means nothing.
 */
export async function profileRelation(
	relation: string,
): Promise<{ rowCount: number; columns: Array<ColumnInfo & ColumnStats> }> {
	const columns = await relationColumns(relation);
	if (columns.length === 0) throw new BadRequest(`${relation} has no columns or does not exist.`);

	const parts: string[] = ["count(*)::text AS n"];
	columns.forEach((column, index) => {
		const kind = kindOf(column.dataType, column.udtName);
		const col = quoteIdentifier(column.name);
		parts.push(`count(${col})::text AS nn_${index}`);
		if (kind === "json" || kind === "other") {
			parts.push(`NULL::text AS d_${index}`, `NULL::text AS mn_${index}`, `NULL::text AS mx_${index}`);
		} else {
			parts.push(`count(DISTINCT ${col})::text AS d_${index}`);
			if (kind === "boolean") {
				parts.push(`NULL::text AS mn_${index}`, `NULL::text AS mx_${index}`);
			} else {
				parts.push(`min(${col})::text AS mn_${index}`, `max(${col})::text AS mx_${index}`);
			}
		}
	});
	const [row] = await query<Record<string, string | null>>(
		`SELECT ${parts.join(", ")} FROM ${quoteQualified(relation)}`,
	);
	const rowCount = Number(row?.n ?? 0);
	return {
		rowCount,
		columns: columns.map((column, index) => ({
			...column,
			nonNull: Number(row?.[`nn_${index}`] ?? 0),
			distinct: row?.[`d_${index}`] === null || row?.[`d_${index}`] === undefined ? null : Number(row[`d_${index}`]),
			min: row?.[`mn_${index}`] ?? null,
			max: row?.[`mx_${index}`] ?? null,
		})),
	};
}

// ── names ───────────────────────────────────────────────────────────────────

const IRREGULAR: Record<string, string> = {
	people: "person",
	children: "child",
	men: "man",
	women: "woman",
	data: "data",
	media: "media",
	series: "series",
	species: "species",
	criteria: "criterion",
	analyses: "analysis",
};

/** "order_items" -> "order_item", "categories" -> "category". */
export function singular(word: string): string {
	const lower = word.toLowerCase();
	if (IRREGULAR[lower]) return IRREGULAR[lower]!;
	if (/ies$/.test(lower) && lower.length > 4) return `${word.slice(0, -3)}y`;
	if (/(sses|uses|xes|ches|shes|zes)$/.test(lower)) return word.slice(0, -2);
	if (/(ss|us|is)$/.test(lower)) return word;
	if (/s$/.test(lower) && lower.length > 2) return word.slice(0, -1);
	return word;
}

/** The last segment of snake_case pluralised: "order_item" -> "order_items". */
export function plural(word: string): string {
	if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
	if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
	return `${word}s`;
}

function words(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** "order_items" -> "OrderItem": an object type's api name. */
export function typeApiName(table: string): string {
	const parts = words(table);
	if (parts.length === 0) return "Dataset";
	parts[parts.length - 1] = singular(parts[parts.length - 1]!);
	const name = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
	return /^[A-Z]/.test(name) ? name : `T${name}`;
}

/** "customer_id" -> "customerId": a property's api name. */
export function propertyApiName(column: string): string {
	const parts = words(column);
	if (parts.length === 0) return "field";
	const name = parts[0]! + parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
	return /^[a-z]/.test(name) ? name : `f${name}`;
}

/** "customer_id" -> "Customer Id", "amount_pct" -> "Amount %". */
export function humanize(name: string): string {
	return words(name)
		.map((w) => (w === "pct" ? "%" : w === "id" ? "ID" : w[0]!.toUpperCase() + w.slice(1)))
		.join(" ");
}

/** "OrderItem" -> "order_item". */
export function snake(apiName: string): string {
	return words(apiName).join("_");
}
