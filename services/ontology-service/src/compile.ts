/**
 * Turning a pipeline graph into SQL that really runs.
 *
 * Until this module existed a "run" walked the graph and estimated row counts
 * from fixed ratios — a filter kept 60%, an aggregate collapsed 50:1. That
 * exercised the graph's shape and nothing else, so the builder could not
 * answer what a pipeline actually produces.
 *
 * Each node here compiles to one SELECT over the relations its inputs
 * produced. The executor materialises each result, so a node's output is a
 * real table that can be previewed, counted and versioned.
 *
 * ── on injection ────────────────────────────────────────────────────────────
 * Node configuration is user input: a filter's column comes from a form, a
 * join's key from a dropdown someone can edit. NOTHING from a config reaches
 * SQL as text. Columns are resolved against the registry or against the
 * upstream node's real column list and re-emitted quoted; operators are looked
 * up in a fixed table; literals become bound parameters. The one exception is
 * the raw SQL node, which is deliberately gated — see compileSql below.
 */

import { query } from "./db";
import {
	BadRequest,
	getRegistry,
	quoteIdentifier,
	quoteQualified,
	resolveColumn,
	resolveObjectType,
} from "./registry";
import type { NodeKind, PipelineGraph, PipelineNode } from "./pipelines";

/** A node's compiled output: the SQL, its parameters, and the columns it emits. */
export interface CompiledNode {
	sql: string;
	params: unknown[];
	columns: string[];
}

/** What a node needs to know about each of its inputs. */
export interface InputRelation {
	/** The materialised table this input was written to, already quoted. */
	relation: string;
	columns: string[];
	nodeId: string;
	name: string;
	/** Rows the input really produced, for reporting rows-in on this node. */
	rowCount: number;
}

/**
 * Raised where a node cannot be compiled at all.
 *
 * Distinct from a SQL error: the graph is asking for something this engine
 * does not implement, and the run should say so rather than fail obscurely.
 */
export class NotExecutable extends Error {
	readonly status = 400;
	constructor(
		readonly nodeId: string,
		message: string,
	) {
		super(message);
	}
}

// ── comparison operators ────────────────────────────────────────────────────
//  A fixed table, so an operator is never string-built from config. Anything
//  not listed here is refused rather than passed through.
const OPERATORS: Record<string, { sql: string; arity: 0 | 1 | 2 }> = {
	eq: { sql: "=", arity: 1 },
	ne: { sql: "<>", arity: 1 },
	gt: { sql: ">", arity: 1 },
	gte: { sql: ">=", arity: 1 },
	lt: { sql: "<", arity: 1 },
	lte: { sql: "<=", arity: 1 },
	contains: { sql: "ILIKE", arity: 1 },
	startsWith: { sql: "ILIKE", arity: 1 },
	isNull: { sql: "IS NULL", arity: 0 },
	isNotNull: { sql: "IS NOT NULL", arity: 0 },
	between: { sql: "BETWEEN", arity: 2 },
};

const AGGREGATIONS: Record<string, string> = {
	sum: "sum",
	avg: "avg",
	min: "min",
	max: "max",
	count: "count",
	countDistinct: "count",
};

/** Arithmetic a calculated column may use. Deliberately tiny. */
const ARITHMETIC: Record<string, string> = {
	add: "+",
	subtract: "-",
	multiply: "*",
	divide: "/",
};

// ── helpers ─────────────────────────────────────────────────────────────────

function configString(node: PipelineNode, key: string): string {
	const value = node.config?.[key];
	return typeof value === "string" ? value.trim() : "";
}

function configList(node: PipelineNode, key: string): string[] {
	const value = node.config?.[key];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	// A comma-separated string is what the inspector's text inputs produce.
	if (typeof value === "string" && value.trim()) {
		return value.split(",").map((part) => part.trim()).filter(Boolean);
	}
	return [];
}

/**
 * Resolve a caller-supplied column name against what the input really emits.
 *
 * This is the whole defence for transform nodes: a name that is not in the
 * upstream column list never reaches SQL, and the error names the columns that
 * are available, so a typo is self-correcting rather than a 500.
 */
function resolveAgainst(input: InputRelation, field: string, nodeId: string): string {
	const wanted = field.trim();
	if (!wanted) throw new NotExecutable(nodeId, "A column name is required here.");
	const exact = input.columns.find((c) => c === wanted);
	if (exact) return exact;
	const loose = input.columns.find((c) => c.toLowerCase() === wanted.toLowerCase());
	if (loose) return loose;
	throw new NotExecutable(
		nodeId,
		`'${wanted}' is not a column of ${input.name}. Available: ${input.columns.join(", ")}.`,
	);
}

/**
 * Project every column except the named one.
 *
 * `SELECT *, <expr> AS x` is invalid where the input already has an `x`, and
 * Postgres's "column specified more than once" does not say which node or
 * which name. A node that adds a column therefore either replaces the
 * existing one explicitly or is refused with a message naming the clash.
 */
function projectionExcept(input: InputRelation, exclude: string): string {
	const kept = input.columns.filter((c) => c !== exclude);
	return kept.length ? kept.map(quoteIdentifier).join(", ") : "";
}

/**
 * Decide how a node that adds `alias` should treat an input that already has it.
 *
 * Returns the projection to use. Refusing by default matters: silently
 * shadowing a column the source already publishes would make a pipeline
 * disagree with the view it reads, and that is very hard to notice downstream.
 */
function additiveProjection(
	input: InputRelation,
	alias: string,
	node: PipelineNode,
	replaceFlag = "replace",
): { projection: string; columns: string[]; replaced: boolean } {
	const existing = input.columns.find((c) => c.toLowerCase() === alias.toLowerCase());
	if (!existing) {
		return { projection: "*", columns: [...input.columns, alias], replaced: false };
	}
	if (node.config?.[replaceFlag] !== true) {
		throw new NotExecutable(
			node.id,
			`${input.name} already has a column called '${existing}'. Choose a different ` +
				`name, or set "${replaceFlag}": true on this node to overwrite it.`,
		);
	}
	const projection = projectionExcept(input, existing);
	return {
		projection: projection || "",
		columns: [...input.columns.filter((c) => c !== existing), alias],
		replaced: true,
	};
}

function only(inputs: InputRelation[], node: PipelineNode): InputRelation {
	if (inputs.length !== 1) {
		throw new NotExecutable(
			node.id,
			`${node.kind} takes exactly one input; this one has ${inputs.length}.`,
		);
	}
	return inputs[0]!;
}

// ── source nodes ────────────────────────────────────────────────────────────

/**
 * A dataset or data source reads a view the ontology published.
 *
 * assertKnownView is what keeps this safe: the view name comes from config,
 * and only a name the registry vouches for is ever quoted into SQL.
 */
function compileSource(node: PipelineNode): CompiledNode {
	const registry = getRegistry();
	const declared = configString(node, "sourceView") || configString(node, "view");

	if (!declared) {
		throw new NotExecutable(
			node.id,
			"This source has no view selected, so there is nothing to read. " +
				"Pick one in the inspector.",
		);
	}

	const known =
		registry.objectTypes.some((t) => t.sourceView === declared) ||
		registry.kpis.some((k) => k.sourceView === declared);
	if (!known) {
		throw new NotExecutable(
			node.id,
			`'${declared}' is not a view the published ontology exposes.`,
		);
	}

	return { sql: `SELECT * FROM ${quoteQualified(declared)}`, params: [], columns: [] };
}

/** An object type reads its backing view — the ontology's own definition of it. */
function compileObjectType(node: PipelineNode): CompiledNode {
	const apiName = configString(node, "objectType");
	if (!apiName) {
		throw new NotExecutable(node.id, "This node has no object type selected.");
	}
	const type = resolveObjectType(apiName);
	const columns = type.properties.map((p) => p.sqlColumn);
	return {
		sql: `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteQualified(type.sourceView)}`,
		params: [],
		columns,
	};
}

// ── transforms ──────────────────────────────────────────────────────────────

function compileFilter(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const raw = node.config?.conditions;
	const conditions = Array.isArray(raw) ? raw : [];

	if (conditions.length === 0) {
		// A filter with no conditions is a pass-through, not an error: it is a
		// normal half-finished state while someone is building the graph.
		return { sql: `SELECT * FROM ${input.relation}`, params: [], columns: input.columns };
	}

	const params: unknown[] = [];
	const clauses: string[] = [];

	for (const entry of conditions) {
		const condition = entry as Record<string, unknown>;
		const column = resolveAgainst(input, String(condition.field ?? ""), node.id);
		const operatorKey = String(condition.operator ?? "eq");
		const operator = OPERATORS[operatorKey];
		if (!operator) {
			throw new NotExecutable(
				node.id,
				`'${operatorKey}' is not a filter operator. Use one of: ${Object.keys(OPERATORS).join(", ")}.`,
			);
		}

		const quoted = quoteIdentifier(column);
		if (operator.arity === 0) {
			clauses.push(`${quoted} ${operator.sql}`);
			continue;
		}
		if (operator.arity === 2) {
			const values = Array.isArray(condition.value) ? condition.value : [];
			if (values.length !== 2) {
				throw new NotExecutable(node.id, "'between' needs exactly two values.");
			}
			params.push(values[0], values[1]);
			clauses.push(`${quoted} BETWEEN $${params.length - 1} AND $${params.length}`);
			continue;
		}

		// The value is always bound, never interpolated - including the wildcards
		// for a contains/startsWith, which are added to the PARAMETER rather than
		// to the SQL.
		let value = condition.value;
		if (operatorKey === "contains") value = `%${String(value ?? "")}%`;
		if (operatorKey === "startsWith") value = `${String(value ?? "")}%`;
		params.push(value);
		clauses.push(`${quoted} ${operator.sql} $${params.length}`);
	}

	const joiner = String(node.config?.combine ?? "and").toLowerCase() === "or" ? " OR " : " AND ";
	return {
		sql: `SELECT * FROM ${input.relation} WHERE ${clauses.join(joiner)}`,
		params,
		columns: input.columns,
	};
}

/** Select Columns (§5): narrow the relation to a chosen list. */
function compileSelect(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const wanted = configList(node, "columns");
	if (wanted.length === 0) {
		return { sql: `SELECT * FROM ${input.relation}`, params: [], columns: input.columns };
	}
	const columns = wanted.map((c) => resolveAgainst(input, c, node.id));
	return {
		sql: `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${input.relation}`,
		params: [],
		columns,
	};
}

function compileJoin(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	if (inputs.length !== 2) {
		throw new NotExecutable(
			node.id,
			`A join needs exactly two inputs; this one has ${inputs.length}.`,
		);
	}
	const [left, right] = inputs as [InputRelation, InputRelation];

	const leftKey = resolveAgainst(left, configString(node, "leftKey"), node.id);
	const rightKey = resolveAgainst(right, configString(node, "rightKey"), node.id);

	const kinds: Record<string, string> = {
		inner: "INNER JOIN",
		left: "LEFT JOIN",
		right: "RIGHT JOIN",
		full: "FULL JOIN",
	};
	const joinKind = kinds[String(node.config?.joinType ?? "inner").toLowerCase()];
	if (!joinKind) {
		throw new NotExecutable(
			node.id,
			`'${node.config?.joinType}' is not a join type. Use inner, left, right or full.`,
		);
	}

	// A column present on both sides would be ambiguous downstream, so the
	// right side's duplicates are suffixed rather than silently dropped.
	const projected: string[] = [];
	const columns: string[] = [];
	for (const column of left.columns) {
		projected.push(`l.${quoteIdentifier(column)}`);
		columns.push(column);
	}
	for (const column of right.columns) {
		if (columns.includes(column)) {
			const alias = `${column}_right`;
			projected.push(`r.${quoteIdentifier(column)} AS ${quoteIdentifier(alias)}`);
			columns.push(alias);
		} else {
			projected.push(`r.${quoteIdentifier(column)}`);
			columns.push(column);
		}
	}

	return {
		sql:
			`SELECT ${projected.join(", ")} FROM ${left.relation} l ` +
			`${joinKind} ${right.relation} r ON l.${quoteIdentifier(leftKey)} = r.${quoteIdentifier(rightKey)}`,
		params: [],
		columns,
	};
}

/** Union (§5): stack two relations that share a column list. */
function compileUnion(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	if (inputs.length < 2) {
		throw new NotExecutable(node.id, "A union needs at least two inputs.");
	}
	// Only the columns every input has: unioning on a column one side lacks
	// would fail in the database with a far less helpful message.
	const shared = inputs
		.map((i) => i.columns)
		.reduce((common, columns) => common.filter((c) => columns.includes(c)));
	if (shared.length === 0) {
		throw new NotExecutable(
			node.id,
			"These inputs share no columns, so there is nothing to union.",
		);
	}

	const projection = shared.map(quoteIdentifier).join(", ");
	const keyword = node.config?.distinct === true ? " UNION " : " UNION ALL ";
	return {
		sql: inputs.map((i) => `SELECT ${projection} FROM ${i.relation}`).join(keyword),
		params: [],
		columns: shared,
	};
}

function compileAggregate(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const groupBy = configList(node, "groupBy").map((c) => resolveAgainst(input, c, node.id));

	const raw = node.config?.measures;
	const measures = Array.isArray(raw) ? raw : [];
	if (measures.length === 0 && groupBy.length === 0) {
		throw new NotExecutable(
			node.id,
			"An aggregate needs at least one measure or one group-by column.",
		);
	}

	const projected = groupBy.map(quoteIdentifier);
	const columns = [...groupBy];

	for (const entry of measures) {
		const measure = entry as Record<string, unknown>;
		const aggregationKey = String(measure.aggregation ?? "sum");
		const aggregation = AGGREGATIONS[aggregationKey];
		if (!aggregation) {
			throw new NotExecutable(
				node.id,
				`'${aggregationKey}' is not an aggregation. Use one of: ${Object.keys(AGGREGATIONS).join(", ")}.`,
			);
		}

		const isCountStar = aggregationKey === "count" && !measure.field;
		const column = isCountStar ? null : resolveAgainst(input, String(measure.field ?? ""), node.id);
		const alias =
			String(measure.alias ?? "").trim() ||
			(isCountStar ? "row_count" : `${aggregationKey}_${column}`);
		// The alias is an identifier the caller chose, so it goes through the
		// same validation as any other: quoteIdentifier refuses anything that
		// is not a plain name.
		const quotedAlias = quoteIdentifier(alias);

		if (isCountStar) {
			projected.push(`count(*) AS ${quotedAlias}`);
		} else if (aggregationKey === "countDistinct") {
			projected.push(`count(DISTINCT ${quoteIdentifier(column!)}) AS ${quotedAlias}`);
		} else {
			projected.push(`${aggregation}(${quoteIdentifier(column!)}) AS ${quotedAlias}`);
		}
		columns.push(alias);
	}

	const group = groupBy.length ? ` GROUP BY ${groupBy.map(quoteIdentifier).join(", ")}` : "";
	return {
		sql: `SELECT ${projected.join(", ")} FROM ${input.relation}${group}`,
		params: [],
		columns,
	};
}

/** Sort (§5). */
function compileSort(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const raw = node.config?.sortBy;
	const entries = Array.isArray(raw) ? raw : [];
	if (entries.length === 0) {
		return { sql: `SELECT * FROM ${input.relation}`, params: [], columns: input.columns };
	}
	const terms = entries.map((entry) => {
		const sort = entry as Record<string, unknown>;
		const column = resolveAgainst(input, String(sort.field ?? ""), node.id);
		// Direction is a keyword, so it is chosen from two literals rather than
		// taken from config.
		const direction = String(sort.direction ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
		return `${quoteIdentifier(column)} ${direction}`;
	});
	return {
		sql: `SELECT * FROM ${input.relation} ORDER BY ${terms.join(", ")}`,
		params: [],
		columns: input.columns,
	};
}

/** Deduplicate (§5): distinct rows, optionally on a subset of columns. */
function compileDedupe(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const on = configList(node, "on").map((c) => resolveAgainst(input, c, node.id));
	if (on.length === 0) {
		return { sql: `SELECT DISTINCT * FROM ${input.relation}`, params: [], columns: input.columns };
	}
	return {
		sql: `SELECT DISTINCT ON (${on.map(quoteIdentifier).join(", ")}) * FROM ${input.relation} ` +
			`ORDER BY ${on.map(quoteIdentifier).join(", ")}`,
		params: [],
		columns: input.columns,
	};
}

/** Calculate Column (§5): one derived column from two operands. */
function compileCalculate(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const alias = configString(node, "alias") || configString(node, "as");
	if (!alias) throw new NotExecutable(node.id, "A calculated column needs a name.");

	const operatorKey = String(node.config?.operator ?? "multiply");
	const operator = ARITHMETIC[operatorKey];
	if (!operator) {
		throw new NotExecutable(
			node.id,
			`'${operatorKey}' is not an arithmetic operator. Use one of: ${Object.keys(ARITHMETIC).join(", ")}.`,
		);
	}

	const left = resolveAgainst(input, configString(node, "left"), node.id);
	const params: unknown[] = [];

	// The right operand is either another column or a constant. A constant is
	// bound, so "0.5" cannot smuggle SQL in through the config.
	let right: string;
	const rightColumn = configString(node, "right");
	if (rightColumn && input.columns.some((c) => c.toLowerCase() === rightColumn.toLowerCase())) {
		right = quoteIdentifier(resolveAgainst(input, rightColumn, node.id));
	} else {
		const constant = Number(node.config?.rightValue ?? node.config?.right);
		if (!Number.isFinite(constant)) {
			throw new NotExecutable(
				node.id,
				`The right operand must be a column of ${input.name} or a number.`,
			);
		}
		params.push(constant);
		right = `$${params.length}`;
	}

	// Division guards against a zero denominator: a pipeline that divides by a
	// column should produce a null for those rows, not fail the whole run.
	const expression =
		operatorKey === "divide"
			? `CASE WHEN (${right})::numeric = 0 THEN NULL ELSE (${quoteIdentifier(left)})::numeric / (${right})::numeric END`
			: `(${quoteIdentifier(left)})::numeric ${operator} (${right})::numeric`;

	const { projection, columns } = additiveProjection(input, alias, node);
	const select = projection ? `${projection}, ` : "";
	return {
		sql: `SELECT ${select}${expression} AS ${quoteIdentifier(alias)} FROM ${input.relation}`,
		params,
		columns,
	};
}

/** Lookup (§5): enrich from an object type's backing view by key. */
function compileLookup(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const apiName = configString(node, "objectType");
	if (!apiName) throw new NotExecutable(node.id, "A lookup needs an object type to read from.");

	const type = resolveObjectType(apiName);
	const sourceKey = resolveAgainst(input, configString(node, "sourceKey"), node.id);
	// The lookup key is resolved through the registry, which is the same
	// guarantee the object-set builder relies on.
	const targetProperty = resolveColumn(type, configString(node, "lookupKey") || type.primaryKeyColumn);

	const bring = configList(node, "bring");
	const brought = (bring.length
		? bring.map((name) => resolveColumn(type, name))
		: type.properties.slice(0, 6)
	).filter((p) => p.sqlColumn !== targetProperty.sqlColumn);

	const projected = input.columns.map((c) => `l.${quoteIdentifier(c)}`);
	const columns = [...input.columns];
	for (const property of brought) {
		const alias = columns.includes(property.sqlColumn)
			? `${apiName.toLowerCase()}_${property.sqlColumn}`
			: property.sqlColumn;
		projected.push(`r.${quoteIdentifier(property.sqlColumn)} AS ${quoteIdentifier(alias)}`);
		columns.push(alias);
	}

	return {
		sql:
			`SELECT ${projected.join(", ")} FROM ${input.relation} l ` +
			`LEFT JOIN ${quoteQualified(type.sourceView)} r ` +
			`ON l.${quoteIdentifier(sourceKey)}::text = r.${quoteIdentifier(targetProperty.sqlColumn)}::text`,
		params: [],
		columns,
	};
}

/** Normalize (§5): trim and case-fold text columns in place. */
function compileNormalize(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const targets = configList(node, "columns").map((c) => resolveAgainst(input, c, node.id));
	if (targets.length === 0) {
		return { sql: `SELECT * FROM ${input.relation}`, params: [], columns: input.columns };
	}

	const mode = String(node.config?.mode ?? "trimLower").toLowerCase();
	const projected = input.columns.map((column) => {
		if (!targets.includes(column)) return quoteIdentifier(column);
		const quoted = quoteIdentifier(column);
		const expression =
			mode === "upper"
				? `upper(btrim(${quoted}::text))`
				: mode === "trim"
					? `btrim(${quoted}::text)`
					: `lower(btrim(${quoted}::text))`;
		return `${expression} AS ${quoted}`;
	});

	return {
		sql: `SELECT ${projected.join(", ")} FROM ${input.relation}`,
		params: [],
		columns: input.columns,
	};
}

/**
 * A raw SQL node.
 *
 * This is the one place caller-written SQL runs, and it is restricted rather
 * than trusted:
 *
 *   * the statement must be a single SELECT or WITH - checked after stripping
 *     comments, so `-- x` cannot hide a second statement
 *   * the executor runs it in a READ ONLY transaction, so even a statement
 *     that slips past this cannot write
 *   * it is gated on the admin role at the route
 *
 * The alternative — refusing raw SQL entirely — would remove the escape hatch
 * that makes the builder usable for work the fixed node kinds do not cover.
 */
function compileSql(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const statement = configString(node, "sql");
	if (!statement) throw new NotExecutable(node.id, "This SQL node is empty.");

	const stripped = statement
		.replace(/--[^\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.trim()
		.replace(/;\s*$/, "");

	if (stripped.includes(";")) {
		throw new NotExecutable(node.id, "A SQL node runs one statement; remove the extra ';'.");
	}
	if (!/^(select|with)\b/i.test(stripped)) {
		throw new NotExecutable(
			node.id,
			"A SQL node must be a single SELECT (or WITH ... SELECT). It runs read-only.",
		);
	}

	// `input` / `input1`, `input2`, … refer to the upstream relations, so the
	// author never has to know the generated table names.
	let resolved = stripped;
	inputs.forEach((input, index) => {
		resolved = resolved
			.replace(new RegExp(`\\binput${index + 1}\\b`, "gi"), input.relation)
			.replace(/\binput\b/gi, inputs[0]!.relation);
	});

	return { sql: resolved, params: [], columns: [] };
}

/**
 * Validate (§5, §23): keep every row but record which ones fail a check.
 *
 * A validation node that silently dropped bad rows would make a data-quality
 * problem disappear at exactly the point someone needs to see it, so the rows
 * stay and gain a boolean column instead.
 */
function compileValidation(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	const raw = node.config?.checks;
	const checks = Array.isArray(raw) ? raw : [];
	if (checks.length === 0) {
		return { sql: `SELECT * FROM ${input.relation}`, params: [], columns: input.columns };
	}

	const clauses: string[] = [];
	for (const entry of checks) {
		const check = entry as Record<string, unknown>;
		const column = resolveAgainst(input, String(check.field ?? ""), node.id);
		const quoted = quoteIdentifier(column);
		switch (String(check.rule ?? "notNull")) {
			case "notNull":
				clauses.push(`${quoted} IS NOT NULL`);
				break;
			case "positive":
				clauses.push(`(${quoted})::numeric > 0`);
				break;
			case "nonNegative":
				clauses.push(`(${quoted})::numeric >= 0`);
				break;
			case "notEmpty":
				clauses.push(`btrim(${quoted}::text) <> ''`);
				break;
			default:
				throw new NotExecutable(
					node.id,
					`'${check.rule}' is not a validation rule. Use notNull, notEmpty, positive or nonNegative.`,
				);
		}
	}

	const alias = configString(node, "alias") || "is_valid";
	const { projection, columns } = additiveProjection(input, alias, node);
	const select = projection ? `${projection}, ` : "";
	return {
		sql: `SELECT ${select}(${clauses.join(" AND ")}) AS ${quoteIdentifier(alias)} FROM ${input.relation}`,
		params: [],
		columns,
	};
}

/** An output node is a pass-through that gets materialised under its own name. */
function compilePassThrough(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	const input = only(inputs, node);
	return { sql: `SELECT * FROM ${input.relation}`, params: [], columns: input.columns };
}

// ── dispatch ────────────────────────────────────────────────────────────────

/** Node kinds this engine can execute. The rest are recorded as skipped. */
export const EXECUTABLE_KINDS: NodeKind[] = [
	"dataSource",
	"dataset",
	"objectType",
	"filter",
	"join",
	"aggregate",
	"sql",
	"output",
	"validation",
];

/**
 * Whether a node kind runs SQL.
 *
 * linkType, actionType, dashboard, llm and python describe something the graph
 * DOES rather than a relation it produces, so they are reported as skipped
 * with a reason instead of being failed — a pipeline ending in a dashboard is
 * a normal, complete pipeline.
 */
export function isExecutable(kind: NodeKind | string): boolean {
	return (EXECUTABLE_KINDS as string[]).includes(kind);
}

export function whyNotExecutable(kind: NodeKind | string): string {
	switch (kind) {
		case "linkType":
			return "A link type describes a relationship in the ontology; it is published, not computed.";
		case "actionType":
			return "An action type is invoked by a user, so a pipeline run does not execute it.";
		case "dashboard":
			return "A dashboard reads the ontology directly and is not built by the run.";
		case "llm":
			return "An LLM step is not run automatically: it would spend tokens on every run.";
		case "python":
			return "Python transforms run in the pipeline service, not in the database.";
		default:
			return `${kind} does not produce a relation.`;
	}
}

/** Compile one node against the relations its inputs produced. */
export function compileNode(node: PipelineNode, inputs: InputRelation[]): CompiledNode {
	switch (node.kind) {
		case "dataSource":
		case "dataset":
			// A source with an upstream is a pass-through: it is a label on the
			// graph rather than a second read of the same view.
			return inputs.length > 0 ? compilePassThrough(node, inputs) : compileSource(node);
		case "objectType":
			return compileObjectType(node);
		case "filter": {
			// The inspector writes several shapes into a filter node depending on
			// which control was used; each maps to a distinct SQL form.
			const mode = String(node.config?.mode ?? "").toLowerCase();
			if (mode === "select") return compileSelect(node, inputs);
			if (mode === "sort") return compileSort(node, inputs);
			if (mode === "dedupe") return compileDedupe(node, inputs);
			if (mode === "calculate") return compileCalculate(node, inputs);
			if (mode === "normalize") return compileNormalize(node, inputs);
			if (mode === "lookup") return compileLookup(node, inputs);
			if (mode === "union") return compileUnion(node, inputs);
			return compileFilter(node, inputs);
		}
		case "join":
			return inputs.length > 2 ? compileUnion(node, inputs) : compileJoin(node, inputs);
		case "aggregate":
			return compileAggregate(node, inputs);
		case "sql":
			return compileSql(node, inputs);
		case "validation":
			return compileValidation(node, inputs);
		case "output":
			return compilePassThrough(node, inputs);
		default:
			throw new NotExecutable(node.id, whyNotExecutable(node.kind));
	}
}

/**
 * The real column list of a materialised relation.
 *
 * Read back from the catalogue rather than predicted, because `SELECT *` on a
 * source and a raw SQL node both produce columns this module cannot know in
 * advance — and a guess here would surface as a confusing error two nodes
 * later rather than here.
 */
export async function columnsOf(schema: string, table: string): Promise<string[]> {
	const rows = await query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2
		  ORDER BY ordinal_position`,
		[schema, table],
	);
	return rows.map((r) => r.column_name);
}

/**
 * A stable, safe table name for a node's materialised output.
 *
 * Derived from the pipeline slug and node id so a rerun replaces its own
 * output rather than accumulating, and sanitised because both come from user
 * input. Truncated to stay inside Postgres's 63-byte identifier limit.
 */
export function outputTableName(pipelineSlug: string, nodeId: string): string {
	const clean = (value: string) =>
		value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";
	return `${clean(pipelineSlug).slice(0, 30)}__${clean(nodeId).slice(0, 28)}`;
}

/** Guards against a graph whose node ids collide once sanitised. */
export function assertDistinctOutputs(graph: PipelineGraph, pipelineSlug: string): void {
	const seen = new Map<string, string>();
	for (const node of graph.nodes ?? []) {
		const table = outputTableName(pipelineSlug, node.id);
		const other = seen.get(table);
		if (other) {
			throw new BadRequest(
				`Nodes '${other}' and '${node.id}' would write to the same table (${table}). Rename one.`,
			);
		}
		seen.set(table, node.id);
	}
}
