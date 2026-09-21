/**
 * The node vocabulary: one place that decides how every node kind looks,
 * what it is called, and what it can be configured with.
 *
 * Kept as data rather than as a switch inside the card component, because the
 * add-node menu, the canvas card, the inspector and the lineage view all need
 * the same answers and must not drift from each other.
 *
 * The kinds and their groups mirror NODE_KINDS / NODE_GROUP in the ontology
 * service. The server is authoritative — it validates what the canvas sends —
 * and this is the client's view of the same model.
 */

export type NodeKind =
	| "dataSource"
	| "dataset"
	| "filter"
	| "join"
	| "aggregate"
	| "sql"
	| "python"
	| "llm"
	| "objectType"
	| "linkType"
	| "actionType"
	| "output"
	| "dashboard"
	| "validation";

export type NodeGroup = "data" | "transform" | "ai" | "ontology" | "output";

export interface ConfigField {
	key: string;
	label: string;
	kind: "text" | "textarea" | "number" | "select" | "multiselect";
	/** Where a select's options come from, when they come from the ontology. */
	source?: "objectTypes" | "linkTypes" | "actionTypes" | "kpis";
	options?: string[];
	placeholder?: string;
	hint?: string;
}

export interface NodeKindSpec {
	kind: NodeKind;
	group: NodeGroup;
	/** Shown on the card. A glyph, not an icon font: no extra dependency. */
	glyph: string;
	label: string;
	description: string;
	/** Colour token for the card's accent bar and group chip. */
	accent: string;
	fields: ConfigField[];
}

export const GROUP_LABEL: Record<NodeGroup, string> = {
	data: "Data",
	transform: "Transform",
	ai: "AI",
	ontology: "Ontology",
	output: "Output",
};

/**
 * Group accents.
 *
 * Ontology nodes are indigo because they are the semantic layer — the thing
 * this platform is actually about — and AI nodes share that family rather than
 * competing with it. Data and transform stay neutral so a large graph reads as
 * structure first and colour second.
 */
export const GROUP_ACCENT: Record<NodeGroup, string> = {
	data: "var(--node-data)",
	transform: "var(--node-transform)",
	ai: "var(--node-ai)",
	ontology: "var(--node-ontology)",
	output: "var(--node-output)",
};

export const NODE_SPECS: Record<NodeKind, NodeKindSpec> = {
	dataSource: {
		kind: "dataSource",
		group: "data",
		glyph: "▣",
		label: "Data Source",
		description: "A system the pipeline reads from.",
		accent: GROUP_ACCENT.data,
		fields: [
			{ key: "connection", label: "Connection", kind: "text", placeholder: "postgres:5432/tms_ontology" },
			{ key: "system", label: "System", kind: "select", options: ["PostgreSQL", "REST API", "S3", "File", "Stream"] },
			{
				key: "rowCount",
				label: "Row count",
				kind: "number",
				hint: "Used to estimate volumes downstream. Left empty, a run reports the size as unknown rather than guessing.",
			},
		],
	},
	dataset: {
		kind: "dataset",
		group: "data",
		glyph: "▤",
		label: "Dataset",
		description: "A materialised table or view.",
		accent: GROUP_ACCENT.data,
		fields: [
			{ key: "table", label: "Table or view", kind: "text", placeholder: "tms_views.v_order" },
			{ key: "rowCount", label: "Row count", kind: "number" },
		],
	},
	filter: {
		kind: "filter",
		group: "transform",
		glyph: "⑂",
		label: "Filter",
		description: "Keeps the rows that match a condition.",
		accent: GROUP_ACCENT.transform,
		fields: [
			{ key: "condition", label: "Condition", kind: "text", placeholder: "status <> 'CANCELLED'" },
			{
				key: "selectivity",
				label: "Selectivity",
				kind: "number",
				hint: "The fraction of rows expected to survive, 0–1. Used only to estimate downstream volume.",
			},
		],
	},
	join: {
		kind: "join",
		group: "transform",
		glyph: "⋈",
		label: "Join",
		description: "Combines two inputs on a key.",
		accent: GROUP_ACCENT.transform,
		fields: [
			{ key: "on", label: "Join key", kind: "text", placeholder: "order_id" },
			{ key: "how", label: "Kind", kind: "select", options: ["inner", "left", "right", "full"] },
		],
	},
	aggregate: {
		kind: "aggregate",
		group: "transform",
		glyph: "Σ",
		label: "Aggregate",
		description: "Groups rows and computes measures.",
		accent: GROUP_ACCENT.transform,
		fields: [
			{ key: "groupBy", label: "Group by", kind: "text", placeholder: "carrier_name, ship_date" },
			{ key: "measures", label: "Measures", kind: "text", placeholder: "count(*), sum(cost)" },
		],
	},
	sql: {
		kind: "sql",
		group: "transform",
		glyph: "❯",
		label: "SQL",
		description: "An explicit SQL transformation.",
		accent: GROUP_ACCENT.transform,
		fields: [{ key: "sql", label: "SQL", kind: "textarea", placeholder: "SELECT …" }],
	},
	python: {
		kind: "python",
		group: "transform",
		glyph: "⌘",
		label: "Python",
		description: "A Python transformation step.",
		accent: GROUP_ACCENT.transform,
		fields: [{ key: "code", label: "Code", kind: "textarea", placeholder: "def transform(df): …" }],
	},
	llm: {
		kind: "llm",
		group: "ai",
		glyph: "✦",
		label: "AI / LLM",
		description: "Extraction or classification by a model.",
		accent: GROUP_ACCENT.ai,
		fields: [
			{ key: "task", label: "Task", kind: "select", options: ["extract", "classify", "summarise", "embed"] },
			{ key: "prompt", label: "Prompt", kind: "textarea", placeholder: "Classify each exception…" },
		],
	},
	objectType: {
		kind: "objectType",
		group: "ontology",
		glyph: "◈",
		label: "Object Type",
		description: "A published ontology object.",
		accent: GROUP_ACCENT.ontology,
		fields: [
			{
				key: "objectType",
				label: "Object type",
				kind: "select",
				source: "objectTypes",
				hint: "Only types in the published ontology. A name that is not there is a validation error.",
			},
		],
	},
	linkType: {
		kind: "linkType",
		group: "ontology",
		glyph: "↔",
		label: "Link Type",
		description: "A relationship between two object types.",
		accent: GROUP_ACCENT.ontology,
		fields: [
			{ key: "linkType", label: "Link", kind: "select", source: "linkTypes" },
			{
				key: "cardinality",
				label: "Cardinality",
				kind: "select",
				options: ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"],
				hint: "Must match what the pipeline discovered in the data, or it is an error.",
			},
		],
	},
	actionType: {
		kind: "actionType",
		group: "ontology",
		glyph: "⚡",
		label: "Action Type",
		description: "An operation available on an object.",
		accent: GROUP_ACCENT.ontology,
		fields: [{ key: "actionType", label: "Action", kind: "select", source: "actionTypes" }],
	},
	output: {
		kind: "output",
		group: "output",
		glyph: "⇥",
		label: "Output",
		description: "Where the result is written.",
		accent: GROUP_ACCENT.output,
		fields: [
			{ key: "target", label: "Target", kind: "select", options: ["Dataset", "API", "Object store", "Stream"] },
			{ key: "name", label: "Name", kind: "text" },
		],
	},
	dashboard: {
		kind: "dashboard",
		group: "output",
		glyph: "▦",
		label: "Dashboard",
		description: "The operational view built from this pipeline.",
		accent: GROUP_ACCENT.output,
		fields: [{ key: "kpis", label: "Metrics", kind: "multiselect", source: "kpis" }],
	},
	validation: {
		kind: "validation",
		group: "output",
		glyph: "✓",
		label: "Validation",
		description: "A data-quality gate on the result.",
		accent: GROUP_ACCENT.output,
		fields: [
			{ key: "rule", label: "Rule", kind: "text", placeholder: "on_time_pct BETWEEN 0 AND 100" },
			{ key: "severity", label: "On failure", kind: "select", options: ["warn", "fail"] },
		],
	},
};

export const NODE_KIND_LIST = Object.values(NODE_SPECS);

/** Grouped for the add-node menu, in the order the menu shows them. */
export const MENU_GROUPS: Array<{ group: NodeGroup; kinds: NodeKindSpec[] }> = (
	["data", "transform", "ontology", "ai", "output"] as NodeGroup[]
).map((group) => ({
	group,
	kinds: NODE_KIND_LIST.filter((spec) => spec.group === group),
}));

/** A short line of metadata for the card face, from whatever is configured. */
export function nodeSubtitle(
	kind: NodeKind,
	config: Record<string, unknown>,
): string[] {
	const lines: string[] = [];
	const push = (value: unknown, suffix = "") => {
		if (value === undefined || value === null || value === "") return;
		lines.push(`${value}${suffix}`);
	};

	switch (kind) {
		case "dataSource":
			push(config.system);
			push(config.connection);
			break;
		case "dataset":
			push(config.table);
			break;
		case "objectType":
			push(config.objectType);
			break;
		case "linkType":
			push(config.linkType);
			push(config.cardinality);
			break;
		case "actionType":
			push(config.actionType);
			break;
		case "dashboard": {
			const kpis = Array.isArray(config.kpis) ? config.kpis : [];
			push(kpis.length ? `${kpis.length} metric${kpis.length === 1 ? "" : "s"}` : "");
			break;
		}
		case "filter":
			push(config.condition);
			break;
		case "join":
			push(config.how, " join");
			push(config.on ? `on ${config.on}` : "");
			break;
		case "aggregate":
			push(config.groupBy ? `by ${config.groupBy}` : "");
			break;
		case "sql":
		case "python":
			push(String(config.sql ?? config.code ?? "").split("\n")[0]?.slice(0, 40));
			break;
		case "llm":
			push(config.task);
			break;
		case "validation":
			push(config.rule);
			break;
		case "output":
			push(config.target);
			break;
		default:
			break;
	}
	return lines.filter(Boolean).slice(0, 2);
}
