/**
 * Pipelines: the graph behind the pipeline builder.
 *
 * A pipeline describes how data becomes an ontology: sources, transforms, the
 * object types they produce, the links and actions defined on those, and the
 * dashboards at the end. The builder draws it; this module stores it,
 * validates it and simulates running it.
 *
 * Validation is the part worth reading. It checks the graph against the REAL
 * published ontology, not against a mock: an Object Type node naming
 * "Shipment" is an error if the registry has no Shipment, and a Link node is
 * an error if its cardinality contradicts the discovered link. That is what
 * keeps the builder from being a drawing tool that happens to look like a data
 * platform.
 */

import { query, queryOne } from "./db";
import { BadRequest, NotFound, getRegistry } from "./registry";

// ── the node model ──────────────────────────────────────────────────────────

/**
 * Node kinds, grouped the way the add-node menu groups them.
 *
 * The groups are not cosmetic: they decide what a node may connect to. A
 * transform can feed another transform or an object type; an object type
 * cannot feed a data source. `ACCEPTS` below encodes that.
 */
export const NODE_KINDS = [
	// data
	"dataSource",
	"dataset",
	// transform
	"filter",
	"join",
	"aggregate",
	"sql",
	"python",
	// ai
	"llm",
	// ontology
	"objectType",
	"linkType",
	"actionType",
	// output
	"output",
	"dashboard",
	"validation",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_GROUP: Record<NodeKind, "data" | "transform" | "ai" | "ontology" | "output"> = {
	dataSource: "data",
	dataset: "data",
	filter: "transform",
	join: "transform",
	aggregate: "transform",
	sql: "transform",
	python: "transform",
	llm: "ai",
	objectType: "ontology",
	linkType: "ontology",
	actionType: "ontology",
	output: "output",
	dashboard: "output",
	validation: "output",
};

/**
 * Which groups may feed each node kind.
 *
 * Read as "a node of this kind accepts input from these groups". An empty list
 * means a root: a data source has no upstream by definition.
 */
const ACCEPTS: Record<NodeKind, Array<"data" | "transform" | "ai" | "ontology" | "output">> = {
	dataSource: [],
	dataset: ["data", "transform", "ai"],
	filter: ["data", "transform", "ai"],
	join: ["data", "transform", "ai"],
	aggregate: ["data", "transform", "ai"],
	sql: ["data", "transform", "ai"],
	python: ["data", "transform", "ai"],
	llm: ["data", "transform", "ai"],
	// An object type is built from data, never from another object type: the
	// relationship between object types is a link, which is its own node.
	objectType: ["data", "transform", "ai"],
	linkType: ["ontology"],
	actionType: ["ontology"],
	output: ["ontology", "data", "transform", "ai"],
	dashboard: ["ontology", "data", "transform", "ai"],
	validation: ["ontology", "data", "transform", "ai"],
};

export interface PipelineNode {
	id: string;
	kind: NodeKind;
	name: string;
	position: { x: number; y: number };
	/** Kind-specific settings: which object type, which SQL, which KPI, … */
	config: Record<string, unknown>;
	description?: string | null;
}

export interface PipelineEdge {
	id: string;
	source: string;
	target: string;
}

export interface PipelineGraph {
	nodes: PipelineNode[];
	edges: PipelineEdge[];
}

export interface PipelineRecord {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	graph: PipelineGraph;
	validation: ValidationReport;
	version: number;
	createdBy: string;
	createdAt: string;
	updatedBy: string | null;
	updatedAt: string;
}

interface PipelineRow {
	pipeline_id: number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	graph: PipelineGraph;
	validation: ValidationReport;
	version: number;
	created_by: string;
	created_at: Date;
	updated_by: string | null;
	updated_at: Date;
}

function toRecord(row: PipelineRow): PipelineRecord {
	return {
		id: row.pipeline_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		environment: row.environment,
		graph: row.graph ?? { nodes: [], edges: [] },
		validation: row.validation,
		version: row.version,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedBy: row.updated_by,
		updatedAt: row.updated_at.toISOString(),
	};
}

// ── validation ──────────────────────────────────────────────────────────────

export interface ValidationIssue {
	severity: "error" | "warning";
	/** The node it belongs to, so the canvas can mark it and focus it. */
	nodeId: string | null;
	code: string;
	message: string;
}

export interface ValidationReport {
	status: "valid" | "warnings" | "invalid" | "unknown";
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
	checkedAt: string;
}

/**
 * Check a graph against the published ontology.
 *
 * Errors block a run; warnings do not. The split matters: "this object type
 * does not exist" makes the pipeline meaningless, while "this node has no
 * description" only makes it rude.
 */
export function validateGraph(graph: PipelineGraph): ValidationReport {
	const registry = getRegistry();
	const objectTypes = new Set(registry.objectTypes.map((t) => t.apiName));
	const linkTypes = new Map(registry.linkTypes.map((l) => [l.apiName, l]));
	const actionTypes = new Set(registry.actionTypes.map((a) => a.apiName));
	const kpis = new Set(registry.kpis.map((k) => k.apiName));

	const issues: ValidationIssue[] = [];
	const add = (
		severity: ValidationIssue["severity"],
		nodeId: string | null,
		code: string,
		message: string,
	) => issues.push({ severity, nodeId, code, message });

	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const edges = Array.isArray(graph.edges) ? graph.edges : [];
	const byId = new Map(nodes.map((n) => [n.id, n]));

	if (nodes.length === 0) {
		add("warning", null, "empty", "This pipeline has no nodes yet.");
	}

	// ── structural ──────────────────────────────────────────────────────────
	const seenIds = new Set<string>();
	for (const node of nodes) {
		if (seenIds.has(node.id)) {
			add("error", node.id, "duplicate_id", `Two nodes share the id '${node.id}'.`);
		}
		seenIds.add(node.id);

		if (!NODE_KINDS.includes(node.kind)) {
			add("error", node.id, "unknown_kind", `'${node.kind}' is not a node type.`);
			continue;
		}
		if (!node.name || !String(node.name).trim()) {
			add("error", node.id, "unnamed", "This node has no name.");
		}
		if (!node.description) {
			add("warning", node.id, "undocumented", `${node.name || node.kind} has no description.`);
		}
	}

	for (const edge of edges) {
		const source = byId.get(edge.source);
		const target = byId.get(edge.target);
		if (!source || !target) {
			add(
				"error",
				null,
				"dangling_edge",
				`A connection refers to a node that is not on the canvas (${edge.source} → ${edge.target}).`,
			);
			continue;
		}
		const allowed = ACCEPTS[target.kind] ?? [];
		if (!allowed.includes(NODE_GROUP[source.kind])) {
			add(
				"error",
				target.id,
				"illegal_connection",
				`${target.name} cannot take input from ${source.name}: a ${target.kind} accepts ${
					allowed.length ? allowed.join(", ") : "no"
				} input.`,
			);
		}
	}

	// A cycle would make the run order undefined, and is easy to draw by
	// accident once a graph has more than a handful of nodes.
	if (hasCycle(nodes, edges)) {
		add("error", null, "cycle", "The graph contains a cycle, so it has no run order.");
	}

	// ── ontology agreement ──────────────────────────────────────────────────
	for (const node of nodes) {
		const config = node.config ?? {};
		const incoming = edges.filter((e) => e.target === node.id);

		if (ACCEPTS[node.kind]?.length && incoming.length === 0) {
			add("warning", node.id, "no_input", `${node.name} has no input connected.`);
		}

		switch (node.kind) {
			case "objectType": {
				const apiName = String(config.objectType ?? "");
				if (!apiName) {
					add("error", node.id, "unconfigured", `${node.name} does not name an object type.`);
				} else if (!objectTypes.has(apiName)) {
					add(
						"error",
						node.id,
						"unknown_object_type",
						`'${apiName}' is not in the published ontology.`,
					);
				}
				break;
			}
			case "linkType": {
				const apiName = String(config.linkType ?? "");
				const link = linkTypes.get(apiName);
				if (!apiName) {
					add("error", node.id, "unconfigured", `${node.name} does not name a link type.`);
				} else if (!link) {
					add("error", node.id, "unknown_link_type", `'${apiName}' is not a published link.`);
				} else if (
					config.cardinality &&
					String(config.cardinality) !== String(link.cardinality)
				) {
					// The registry discovered this link from the data; a node that
					// disagrees is describing a relationship that is not there.
					add(
						"error",
						node.id,
						"cardinality_mismatch",
						`${apiName} is ${link.cardinality} in the ontology, not ${config.cardinality}.`,
					);
				} else if (link && !link.isVerified) {
					add(
						"warning",
						node.id,
						"partial_link",
						`${apiName} joins only ${Math.round(link.matchRatio * 100)}% of rows.`,
					);
				}
				break;
			}
			case "actionType": {
				const apiName = String(config.actionType ?? "");
				if (!apiName) {
					add("error", node.id, "unconfigured", `${node.name} does not name an action.`);
				} else if (!actionTypes.has(apiName)) {
					add("error", node.id, "unknown_action", `'${apiName}' is not a published action.`);
				}
				// An action operates on an object type, so it needs one upstream.
				if (
					incoming.length > 0 &&
					!incoming.some((e) => byId.get(e.source)?.kind === "objectType")
				) {
					add(
						"error",
						node.id,
						"action_input_unmapped",
						`${node.name} is not connected to the object type it acts on.`,
					);
				}
				break;
			}
			case "dashboard": {
				const referenced = Array.isArray(config.kpis) ? (config.kpis as unknown[]) : [];
				for (const kpi of referenced) {
					if (!kpis.has(String(kpi))) {
						add(
							"error",
							node.id,
							"unknown_kpi",
							`'${kpi}' is not in the KPI catalogue.`,
						);
					}
				}
				if (referenced.length === 0) {
					add("warning", node.id, "empty_dashboard", `${node.name} shows no metrics yet.`);
				}
				break;
			}
			case "sql": {
				if (!String(config.sql ?? "").trim()) {
					add("error", node.id, "unconfigured", `${node.name} has no SQL.`);
				}
				break;
			}
			case "python": {
				if (!String(config.code ?? "").trim()) {
					add("error", node.id, "unconfigured", `${node.name} has no code.`);
				}
				break;
			}
			case "dataSource": {
				if (!String(config.connection ?? "").trim()) {
					add("warning", node.id, "unconfigured", `${node.name} names no connection.`);
				}
				break;
			}
			case "join": {
				if (incoming.length < 2) {
					add("error", node.id, "join_needs_two", `${node.name} needs two inputs to join.`);
				}
				if (!String(config.on ?? "").trim()) {
					add("error", node.id, "unconfigured", `${node.name} has no join key.`);
				}
				break;
			}
			default:
				break;
		}
	}

	const errors = issues.filter((i) => i.severity === "error");
	const warnings = issues.filter((i) => i.severity === "warning");
	return {
		status: errors.length > 0 ? "invalid" : warnings.length > 0 ? "warnings" : "valid",
		errors,
		warnings,
		checkedAt: new Date().toISOString(),
	};
}

/** Depth-first cycle check over the directed graph. */
function hasCycle(nodes: PipelineNode[], edges: PipelineEdge[]): boolean {
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.source) ?? [];
		list.push(edge.target);
		outgoing.set(edge.source, list);
	}
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const colour = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));

	const visit = (id: string): boolean => {
		if (colour.get(id) === GREY) return true;
		if (colour.get(id) === BLACK) return false;
		colour.set(id, GREY);
		for (const next of outgoing.get(id) ?? []) {
			if (colour.has(next) && visit(next)) return true;
		}
		colour.set(id, BLACK);
		return false;
	};

	for (const node of nodes) {
		if (colour.get(node.id) === WHITE && visit(node.id)) return true;
	}
	return false;
}

/** Nodes in dependency order, which is also the order a run executes them. */
export function topologicalOrder(graph: PipelineGraph): PipelineNode[] {
	const nodes = graph.nodes ?? [];
	const edges = graph.edges ?? [];
	const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
	const outgoing = new Map<string, string[]>();

	for (const edge of edges) {
		if (!indegree.has(edge.target) || !indegree.has(edge.source)) continue;
		indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
		const list = outgoing.get(edge.source) ?? [];
		list.push(edge.target);
		outgoing.set(edge.source, list);
	}

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
	const ordered: PipelineNode[] = [];

	while (queue.length > 0) {
		const id = queue.shift() as string;
		const node = byId.get(id);
		if (node) ordered.push(node);
		for (const next of outgoing.get(id) ?? []) {
			const remaining = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) queue.push(next);
		}
	}

	// Anything left is inside a cycle; validation reports that separately, and
	// appending them keeps a run from silently skipping nodes.
	for (const node of nodes) {
		if (!ordered.includes(node)) ordered.push(node);
	}
	return ordered;
}

// ── persistence ─────────────────────────────────────────────────────────────

export async function listPipelines(): Promise<PipelineRecord[]> {
	const rows = await query<PipelineRow>(
		"SELECT * FROM platform.pipeline ORDER BY updated_at DESC",
	);
	return rows.map(toRecord);
}

export async function getPipeline(slug: string): Promise<PipelineRecord> {
	const row = await queryOne<PipelineRow>(
		"SELECT * FROM platform.pipeline WHERE slug = $1",
		[slug],
	);
	if (!row) throw new NotFound(`No pipeline '${slug}'.`);
	return toRecord(row);
}

function slugifyName(name: string): string {
	const slug = name
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || `pipeline-${Date.now()}`;
}

/** Reject a graph that is the wrong shape before it reaches the database. */
function coerceGraph(input: unknown): PipelineGraph {
	const graph = (input ?? {}) as Partial<PipelineGraph>;
	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const edges = Array.isArray(graph.edges) ? graph.edges : [];

	for (const node of nodes) {
		if (!node || typeof node.id !== "string" || !node.id) {
			throw new BadRequest("Every node needs a string id.");
		}
		if (!NODE_KINDS.includes(node.kind)) {
			throw new BadRequest(`'${node.kind}' is not a node type.`);
		}
	}
	for (const edge of edges) {
		if (!edge || typeof edge.source !== "string" || typeof edge.target !== "string") {
			throw new BadRequest("Every connection needs a source and a target.");
		}
	}

	// Stored normalised, so a graph written by an older client still round-trips
	// through the current one.
	return {
		nodes: nodes.map((node) => ({
			id: node.id,
			kind: node.kind,
			name: String(node.name ?? node.kind),
			position: {
				x: Number(node.position?.x ?? 0) || 0,
				y: Number(node.position?.y ?? 0) || 0,
			},
			config: (node.config ?? {}) as Record<string, unknown>,
			description: node.description ?? null,
		})),
		edges: edges.map((edge) => ({
			id: edge.id || `${edge.source}->${edge.target}`,
			source: edge.source,
			target: edge.target,
		})),
	};
}

export interface SavePipelineRequest {
	slug?: string;
	name: string;
	description?: string | null;
	environment?: string;
	graph: unknown;
	note?: string | null;
}

export async function savePipeline(
	request: SavePipelineRequest,
	savedBy: string,
): Promise<PipelineRecord> {
	const name = String(request.name ?? "").trim();
	if (!name) throw new BadRequest("A pipeline needs a name.");

	const graph = coerceGraph(request.graph);
	const validation = validateGraph(graph);
	const slug = request.slug?.trim() || slugifyName(name);
	const environment = request.environment ?? "development";

	const existing = await queryOne<PipelineRow>(
		"SELECT * FROM platform.pipeline WHERE slug = $1",
		[slug],
	);

	const row = existing
		? await queryOne<PipelineRow>(
				`UPDATE platform.pipeline
				    SET name = $1, description = $2, environment = $3, graph = $4,
				        validation = $5, version = version + 1,
				        updated_by = $6, updated_at = now()
				  WHERE pipeline_id = $7
				RETURNING *`,
				[
					name,
					request.description ?? null,
					environment,
					JSON.stringify(graph),
					JSON.stringify(validation),
					savedBy,
					existing.pipeline_id,
				],
			)
		: await queryOne<PipelineRow>(
				`INSERT INTO platform.pipeline
				   (slug, name, description, environment, graph, validation, created_by, updated_by)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
				 RETURNING *`,
				[
					slug,
					name,
					request.description ?? null,
					environment,
					JSON.stringify(graph),
					JSON.stringify(validation),
					savedBy,
				],
			);

	if (!row) throw new BadRequest("The pipeline could not be saved.");

	// Snapshot the graph as it now stands. Written after the update so the
	// version number matches the row, and so a failed update leaves no
	// orphaned version behind.
	await query(
		`INSERT INTO platform.pipeline_version (pipeline_id, version, graph, note, saved_by)
		 VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (pipeline_id, version) DO NOTHING`,
		[row.pipeline_id, row.version, JSON.stringify(graph), request.note ?? null, savedBy],
	);

	return toRecord(row);
}

export async function deletePipeline(slug: string): Promise<void> {
	const row = await queryOne<{ pipeline_id: number }>(
		"DELETE FROM platform.pipeline WHERE slug = $1 RETURNING pipeline_id",
		[slug],
	);
	if (!row) throw new NotFound(`No pipeline '${slug}'.`);
}

export interface PipelineVersionSummary {
	version: number;
	note: string | null;
	savedBy: string;
	savedAt: string;
	nodeCount: number;
	edgeCount: number;
}

export async function listVersions(slug: string): Promise<PipelineVersionSummary[]> {
	const pipeline = await getPipeline(slug);
	const rows = await query<{
		version: number;
		note: string | null;
		saved_by: string;
		saved_at: Date;
		graph: PipelineGraph;
	}>(
		`SELECT version, note, saved_by, saved_at, graph
		   FROM platform.pipeline_version
		  WHERE pipeline_id = $1 ORDER BY version DESC`,
		[pipeline.id],
	);
	return rows.map((row) => ({
		version: row.version,
		note: row.note,
		savedBy: row.saved_by,
		savedAt: row.saved_at.toISOString(),
		nodeCount: row.graph?.nodes?.length ?? 0,
		edgeCount: row.graph?.edges?.length ?? 0,
	}));
}

/** Restore an earlier version as a new one, so history is never rewritten. */
export async function restoreVersion(
	slug: string,
	version: number,
	restoredBy: string,
): Promise<PipelineRecord> {
	const pipeline = await getPipeline(slug);
	const row = await queryOne<{ graph: PipelineGraph }>(
		"SELECT graph FROM platform.pipeline_version WHERE pipeline_id = $1 AND version = $2",
		[pipeline.id, version],
	);
	if (!row) throw new NotFound(`Pipeline '${slug}' has no version ${version}.`);

	return savePipeline(
		{
			slug,
			name: pipeline.name,
			description: pipeline.description,
			environment: pipeline.environment,
			graph: row.graph,
			note: `Restored from version ${version}.`,
		},
		restoredBy,
	);
}

// ── runs ────────────────────────────────────────────────────────────────────

export interface NodeResult {
	nodeId: string;
	name: string;
	kind: NodeKind;
	status: "success" | "failed" | "skipped";
	durationMs: number;
	/** null when the node's size is not knowable without really running it. */
	records: number | null;
	message: string;
}

export interface RunRecord {
	id: number;
	pipelineSlug: string;
	version: number;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	records: number;
	errors: number;
	warnings: number;
	nodeResults: NodeResult[];
	log: Array<{ at: string; level: string; message: string }>;
	isSimulated: boolean;
	triggeredBy: string;
}

/**
 * How many rows a node kind is taken to emit.
 *
 * An object-type node reports the real row count from the registry, because
 * that number exists and is true. The rest are derived from their input, which
 * is the honest thing to do for a platform with no execution engine: the run
 * exercises the graph's SHAPE and dependency order, and every row it writes is
 * marked is_simulated so nobody mistakes it for a real load.
 */
function projectedRecords(node: PipelineNode, upstream: number | null): number | null {
	const registry = getRegistry();
	switch (node.kind) {
		case "objectType": {
			// The one node kind with a real number behind it: the registry knows
			// how many rows this object type actually has.
			const apiName = String(node.config?.objectType ?? "");
			const type = registry.objectTypes.find((t) => t.apiName === apiName);
			return type?.rowCount ?? upstream;
		}
		case "dataSource":
		case "dataset": {
			const declared = Number(node.config?.rowCount ?? 0);
			if (Number.isFinite(declared) && declared > 0) return declared;
			// null, not 0: a source with no declared row count and nothing
			// upstream has an UNKNOWN size, and reporting 0 would read as "this
			// source is empty" - which is a different and wrong claim.
			return upstream;
		}
		case "filter": {
			if (upstream === null) return null;
			const ratio = Number(node.config?.selectivity ?? 0.6);
			return Math.round(upstream * (Number.isFinite(ratio) ? ratio : 0.6));
		}
		case "aggregate":
			// An aggregate collapses its input; the exact factor is unknowable
			// without running it, so this is explicitly an estimate.
			return upstream === null ? null : Math.max(1, Math.round(upstream / 50));
		case "join":
			return upstream;
		case "linkType": {
			if (upstream === null) return null;
			const apiName = String(node.config?.linkType ?? "");
			const link = registry.linkTypes.find((l) => l.apiName === apiName);
			return link ? Math.round(upstream * (link.matchRatio || 1)) : upstream;
		}
		case "dashboard":
		case "validation":
		case "actionType":
			return upstream;
		default:
			return upstream;
	}
}

export async function runPipeline(slug: string, triggeredBy: string): Promise<RunRecord> {
	const pipeline = await getPipeline(slug);
	const validation = validateGraph(pipeline.graph);

	if (validation.status === "invalid") {
		throw new BadRequest(
			`This pipeline has ${validation.errors.length} error(s) and cannot run. ` +
				`First: ${validation.errors[0]?.message}`,
		);
	}

	const ordered = topologicalOrder(pipeline.graph);
	const incoming = new Map<string, string[]>();
	for (const edge of pipeline.graph.edges ?? []) {
		const list = incoming.get(edge.target) ?? [];
		list.push(edge.source);
		incoming.set(edge.target, list);
	}

	const started = Date.now();
	const recordsByNode = new Map<string, number | null>();
	const nodeResults: NodeResult[] = [];
	const log: RunRecord["log"] = [
		{
			at: new Date().toISOString(),
			level: "info",
			message: `Run started for ${pipeline.name} v${pipeline.version} (${ordered.length} nodes).`,
		},
	];

	for (const node of ordered) {
		const sources = incoming.get(node.id) ?? [];
		const upstreamValues = sources.map((id) => recordsByNode.get(id) ?? null);
		// Unknown is contagious: if any input size is unknown, so is the output.
		const upstream =
			sources.length === 0
				? null
				: upstreamValues.some((value) => value === null)
					? null
					: upstreamValues.reduce((sum: number, value) => sum + (value ?? 0), 0);

		const records = projectedRecords(node, upstream);
		recordsByNode.set(node.id, records);

		// Deterministic from the node id, not random: two runs of an unchanged
		// pipeline should report the same shape, or the panel is noise.
		const durationMs = 40 + (hashString(node.id) % 800);

		const size =
			records === null ? "an unknown number of" : records.toLocaleString("en-US");
		nodeResults.push({
			nodeId: node.id,
			name: node.name,
			kind: node.kind,
			// "skipped" rather than "success" when the size is unknown: the node
			// was reached, but nothing about its output was established.
			status: records === null ? "skipped" : "success",
			durationMs,
			records,
			message:
				records === null
					? `${node.kind} ran, but its row count is not known without a real execution. Set a row count on the source to estimate it.`
					: `${node.kind} produced ${size} records.`,
		});
		log.push({
			at: new Date().toISOString(),
			level: records === null ? "warn" : "info",
			message: `${node.name}: ${size} records in ${durationMs}ms.`,
		});
	}

	for (const warning of validation.warnings) {
		log.push({ at: new Date().toISOString(), level: "warn", message: warning.message });
	}

	const durationMs = Date.now() - started;
	const totalRecords = nodeResults.reduce((max, r) => Math.max(max, r.records ?? 0), 0);

	const row = await queryOne<{
		pipeline_run_id: number;
		started_at: Date;
		finished_at: Date;
	}>(
		`INSERT INTO platform.pipeline_run
		   (pipeline_id, version, status, finished_at, duration_ms, records, errors,
		    warnings, node_results, log, is_simulated, triggered_by)
		 VALUES ($1,$2,'success', now(), $3, $4, 0, $5, $6, $7, true, $8)
		 RETURNING pipeline_run_id, started_at, finished_at`,
		[
			pipeline.id,
			pipeline.version,
			durationMs,
			totalRecords,
			validation.warnings.length,
			JSON.stringify(nodeResults),
			JSON.stringify(log),
			triggeredBy,
		],
	);

	return {
		id: row?.pipeline_run_id ?? 0,
		pipelineSlug: slug,
		version: pipeline.version,
		status: "success",
		startedAt: row?.started_at.toISOString() ?? new Date(started).toISOString(),
		finishedAt: row?.finished_at.toISOString() ?? new Date().toISOString(),
		durationMs,
		records: totalRecords,
		errors: 0,
		warnings: validation.warnings.length,
		nodeResults,
		log,
		isSimulated: true,
		triggeredBy,
	};
}

/** Stable small hash, so a node's simulated duration does not change per run. */
function hashString(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(hash);
}

export async function listRuns(slug: string, limit = 20): Promise<RunRecord[]> {
	const pipeline = await getPipeline(slug);
	const bounded = Math.min(Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 20), 100);
	const rows = await query<{
		pipeline_run_id: number;
		version: number;
		status: string;
		started_at: Date;
		finished_at: Date | null;
		duration_ms: number | null;
		records: string;
		errors: number;
		warnings: number;
		node_results: NodeResult[];
		log: RunRecord["log"];
		is_simulated: boolean;
		triggered_by: string;
	}>(
		`SELECT * FROM platform.pipeline_run
		  WHERE pipeline_id = $1 ORDER BY started_at DESC LIMIT ${bounded}`,
		[pipeline.id],
	);

	return rows.map((row) => ({
		id: row.pipeline_run_id,
		pipelineSlug: slug,
		version: row.version,
		status: row.status,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		durationMs: row.duration_ms,
		records: Number(row.records),
		errors: row.errors,
		warnings: row.warnings,
		nodeResults: row.node_results ?? [],
		log: row.log ?? [],
		isSimulated: row.is_simulated,
		triggeredBy: row.triggered_by,
	}));
}

/**
 * The ontology as pipeline-builder palette entries.
 *
 * The builder offers the REAL object types, links, actions and KPIs, so a node
 * dragged onto the canvas is configured against something that exists rather
 * than against a placeholder.
 */
export function ontologyPalette(): Record<string, unknown> {
	const registry = getRegistry();
	return {
		objectTypes: registry.objectTypes.map((type) => ({
			apiName: type.apiName,
			label: type.label,
			group: type.group,
			rowCount: type.rowCount,
			propertyCount: type.properties.length,
			sourceView: type.sourceView,
		})),
		linkTypes: registry.linkTypes.map((link) => ({
			apiName: link.apiName,
			label: link.label,
			source: link.sourceObjectType,
			target: link.targetObjectType,
			cardinality: link.cardinality,
			matchRatio: link.matchRatio,
			isVerified: link.isVerified,
		})),
		actionTypes: registry.actionTypes.map((action) => ({
			apiName: action.apiName,
			label: action.label,
			isReadOnly: action.isReadOnly,
			targetObjectTypes: action.targetObjectTypes,
		})),
		kpis: registry.kpis.map((kpi) => ({
			apiName: kpi.apiName,
			label: kpi.label,
			category: kpi.category,
			dependsOnSimulation: kpi.dependsOnSimulation,
		})),
	};
}
