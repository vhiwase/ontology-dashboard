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

import { pool, query, queryOne } from "./db";
import { compileNode, isExecutable, outputTableName, whyNotExecutable } from "./compile";
import {
	type ExecutionResult,
	executeGraph,
	recordDatasetVersions,
	recordNodeRuns,
} from "./execute";
import { BadRequest, currentSpace, getRegistry, hasOntology, NotFound } from "./registry";

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
	/** The space this pipeline lives in; the environment is derived from it. */
	spaceSlug: string;
	environment: string;
	graph: PipelineGraph;
	validation: ValidationReport;
	version: number;
	createdBy: string;
	createdAt: string;
	updatedBy: string | null;
	updatedAt: string;
	/** Set where the assistant drafted this rather than a person building it. */
	proposedBy: string | null;
	/** The request that produced it, so a strange graph can be traced back. */
	proposedFrom: string | null;
	/** NULL while this is an unreviewed proposal. A proposal cannot be run. */
	acceptedBy: string | null;
	acceptedAt: string | null;
}

interface PipelineRow {
	pipeline_id: number;
	slug: string;
	name: string;
	description: string | null;
	space_slug: string;
	environment: string;
	graph: PipelineGraph;
	validation: ValidationReport;
	version: number;
	created_by: string;
	created_at: Date;
	updated_by: string | null;
	updated_at: Date;
	proposed_by: string | null;
	proposed_from: string | null;
	accepted_by: string | null;
	accepted_at: Date | null;
}

function toRecord(row: PipelineRow): PipelineRecord {
	return {
		id: row.pipeline_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		spaceSlug: row.space_slug,
		environment: row.environment,
		graph: row.graph ?? { nodes: [], edges: [] },
		validation: row.validation,
		version: row.version,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedBy: row.updated_by,
		updatedAt: row.updated_at.toISOString(),
		proposedBy: row.proposed_by,
		proposedFrom: row.proposed_from,
		acceptedBy: row.accepted_by,
		acceptedAt: row.accepted_at?.toISOString() ?? null,
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
			case "dataSource":
			case "dataset": {
				// A source needs something it can actually read. The view is what
				// the execution engine opens; the connection is metadata about
				// where the data originally came from. Naming neither used to be a
				// warning, back when a run only estimated: now it is the reason the
				// run would fail, so it is an error and says which to set.
				const view = String(config.sourceView ?? config.view ?? "").trim();
				const connection = String(config.connection ?? "").trim();
				const hasUpstream = incoming.length > 0;

				if (!view && !hasUpstream) {
					// A warning rather than an error, deliberately. Blocking the whole
					// run would stop every other branch of a graph someone is halfway
					// through building — and the engine already handles this precisely:
					// this node fails with "no view selected", its downstream nodes are
					// marked skipped, and the rest of the graph still executes.
					add(
						"warning",
						node.id,
						"unconfigured",
						`${node.name} names no source view, so it has nothing to read. ` +
							`Pick one in the inspector.`,
					);
				} else if (view && !connection) {
					// A warning, not an error: warnings do not block a run, and this
					// one does not stop it working — it only means the lineage cannot
					// say which system the rows originally came from.
					add(
						"warning",
						node.id,
						"no_connection",
						`${node.name} reads ${view} directly. Naming a connection records where that data came from.`,
					);
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

export async function listPipelines(spaceSlug?: string): Promise<PipelineRecord[]> {
	const rows = await query<PipelineRow>(
		`SELECT p.*, s.slug AS space_slug
		   FROM platform.pipeline p JOIN platform.space s ON s.space_id = p.space_id
		  WHERE ($1::text IS NULL OR s.slug = $1)
		  ORDER BY p.updated_at DESC`,
		[spaceSlug ?? null],
	);
	return rows.map(toRecord);
}

/**
 * A pipeline by slug, within a space.
 *
 * The slug is unique per space rather than globally, so the same pipeline
 * promoted from sandbox to production keeps its name in both. Without the
 * space, "tms-kpi-pipeline" is ambiguous once it has been promoted.
 */
export async function getPipeline(
	slug: string,
	spaceSlug?: string,
): Promise<PipelineRecord> {
	const row = await queryOne<PipelineRow>(
		`SELECT p.*, s.slug AS space_slug
		   FROM platform.pipeline p JOIN platform.space s ON s.space_id = p.space_id
		  WHERE p.slug = $1 AND ($2::text IS NULL OR s.slug = $2)
		  ORDER BY (s.slug = 'sandbox') DESC
		  LIMIT 1`,
		[slug, spaceSlug ?? null],
	);
	if (!row) {
		throw new NotFound(
			spaceSlug ? `No pipeline '${slug}' in space '${spaceSlug}'.` : `No pipeline '${slug}'.`,
		);
	}
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
	/** Which space it belongs to. The environment follows from it. */
	spaceSlug?: string;
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

	// Work that has not been deliberately promoted belongs in the sandbox, so
	// that is the default rather than "development".
	const spaceSlug = request.spaceSlug?.trim() || "sandbox";
	const space = await queryOne<{ space_id: number; environment: string }>(
		"SELECT space_id, environment FROM platform.space WHERE slug = $1",
		[spaceSlug],
	);
	if (!space) throw new BadRequest(`No space '${spaceSlug}'.`);
	const environment = space.environment;

	const existing = await queryOne<PipelineRow>(
		`SELECT p.*, s.slug AS space_slug
		   FROM platform.pipeline p JOIN platform.space s ON s.space_id = p.space_id
		  WHERE p.slug = $1 AND s.slug = $2`,
		[slug, spaceSlug],
	);

	const row = existing
		? await queryOne<PipelineRow>(
				`UPDATE platform.pipeline
				    SET name = $1, description = $2, environment = $3, graph = $4,
				        validation = $5, version = version + 1,
				        updated_by = $6, updated_at = now()
				  WHERE pipeline_id = $7
				RETURNING *, $8::text AS space_slug`,
				[
					name,
					request.description ?? null,
					environment,
					JSON.stringify(graph),
					JSON.stringify(validation),
					savedBy,
					existing.pipeline_id,
					spaceSlug,
				],
			)
		: await queryOne<PipelineRow>(
				`INSERT INTO platform.pipeline
				   (slug, name, description, environment, space_id, graph, validation,
				    created_by, updated_by)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
				 RETURNING *, $9::text AS space_slug`,
				[
					slug,
					name,
					request.description ?? null,
					environment,
					space.space_id,
					JSON.stringify(graph),
					JSON.stringify(validation),
					savedBy,
					spaceSlug,
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

// ── outputs, and deleting a pipeline with them ──────────────────────────────

export interface PipelineOutput {
	/** schema.table, always in pipeline_out. */
	table: string;
	nodeId: string | null;
	nodeName: string | null;
	nodeKind: string | null;
	rowCount: number | null;
	size: string | null;
	lastBuiltAt: string | null;
	/** Workspace resources that point at this table and would be left dangling. */
	referencedBy: string[];
}

/**
 * The tables this pipeline has materialised, and what each one is.
 *
 * Found two ways, because either alone misses something:
 *
 *   * the run records, which name every table the engine wrote - but are
 *     deleted along with the pipeline, and can be pruned;
 *   * the naming convention outputTableName() uses, which finds a table whose
 *     run record is gone.
 *
 * A table recorded against a DIFFERENT pipeline's runs is excluded even if its
 * name happens to share the prefix. Two slugs that agree in their first thirty
 * characters produce the same prefix, and offering to drop another pipeline's
 * output because of that would be exactly the wrong kind of mistake.
 */
export async function pipelineOutputs(slug: string, spaceSlug?: string): Promise<PipelineOutput[]> {
	const pipeline = await getPipeline(slug, spaceSlug);
	// outputTableName(slug, "x") is prefix + "x"; dropping the "x" leaves the
	// prefix exactly as the engine builds it, sanitising and truncation included.
	const prefix = outputTableName(slug, "x").slice(0, -1);

	const rows = await query<{
		table_name: string;
		node_id: string | null;
		node_name: string | null;
		node_kind: string | null;
		finished_at: Date | null;
	}>(
		`WITH recorded AS (
		    SELECT DISTINCT ON (nr.output_table)
		           split_part(nr.output_table, '.', 2) AS table_name,
		           nr.node_id, nr.node_name, nr.node_kind, nr.finished_at
		      FROM platform.pipeline_node_run nr
		      JOIN platform.pipeline_run r ON r.pipeline_run_id = nr.pipeline_run_id
		     WHERE r.pipeline_id = $1 AND nr.output_table LIKE 'pipeline_out.%'
		     ORDER BY nr.output_table, nr.pipeline_node_run_id DESC
		 ),
		 claimed_elsewhere AS (
		    SELECT DISTINCT split_part(nr.output_table, '.', 2) AS table_name
		      FROM platform.pipeline_node_run nr
		      JOIN platform.pipeline_run r ON r.pipeline_run_id = nr.pipeline_run_id
		     WHERE r.pipeline_id <> $1 AND nr.output_table LIKE 'pipeline_out.%'
		 ),
		 by_name AS (
		    -- left(...) = prefix rather than LIKE: the prefix contains
		    -- underscores, which LIKE would treat as wildcards.
		    SELECT t.table_name
		      FROM information_schema.tables t
		     WHERE t.table_schema = 'pipeline_out'
		       AND left(t.table_name, length($2)) = $2
		       AND t.table_name NOT IN (SELECT table_name FROM claimed_elsewhere)
		 )
		 SELECT t.table_name, rec.node_id, rec.node_name, rec.node_kind, rec.finished_at
		   FROM information_schema.tables t
		   LEFT JOIN recorded rec ON rec.table_name = t.table_name
		  WHERE t.table_schema = 'pipeline_out'
		    AND (t.table_name IN (SELECT table_name FROM recorded)
		         OR t.table_name IN (SELECT table_name FROM by_name))
		  ORDER BY rec.finished_at DESC NULLS LAST, t.table_name`,
		[pipeline.id, prefix],
	);

	const outputs: PipelineOutput[] = [];
	for (const row of rows) {
		const qualified = `pipeline_out.${row.table_name}`;
		const relation = `${quoteIdent("pipeline_out")}.${quoteIdent(row.table_name)}`;

		// Exact counts: these tables are pipeline outputs, small by construction,
		// and the dialog is where someone decides whether to destroy them - an
		// estimate is the wrong number to show at that moment.
		const stats = await queryOne<{ n: string; size: string }>(
			`SELECT (SELECT count(*) FROM ${relation})::text AS n,
			        pg_size_pretty(pg_total_relation_size($1::regclass)) AS size`,
			[qualified],
		);
		const references = await query<{ name: string; kind: string }>(
			`SELECT r.name, r.kind FROM platform.resource r
			  WHERE r.target_ref = $1 OR r.properties->>'sourceView' = $1`,
			[qualified],
		);

		outputs.push({
			table: qualified,
			nodeId: row.node_id,
			nodeName: row.node_name,
			nodeKind: row.node_kind,
			rowCount: stats ? Number(stats.n) : null,
			size: stats?.size ?? null,
			lastBuiltAt: row.finished_at?.toISOString() ?? null,
			referencedBy: references.map((ref) => `${ref.kind} ${ref.name}`),
		});
	}
	return outputs;
}

/** Quote an identifier that came from the catalogue, refusing anything odd. */
function quoteIdent(identifier: string): string {
	if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
		throw new BadRequest(`Refusing to use '${identifier}' as a table name.`);
	}
	return `"${identifier}"`;
}

export interface DeletePipelineResult {
	deleted: string;
	droppedOutputs: string[];
	keptOutputs: string[];
}

/**
 * Delete a pipeline, and exactly the outputs the caller selected.
 *
 * Tables are dropped ONLY when named in `dropOutputs`. There is no "and
 * everything it made" default: dropping data is the consequential part of
 * this, so it happens when a person has seen the list and ticked it, which is
 * what the confirmation dialog is for. A caller that sends no list deletes the
 * pipeline and leaves its tables, and is told which ones were kept.
 *
 * Every requested table must be one of THIS pipeline's outputs, re-derived on
 * the server. A request cannot use this route to drop an arbitrary table by
 * naming it.
 *
 * One transaction: Postgres DDL is transactional, so the pipeline row, its
 * tables, their build history and its workspace card go together or not at
 * all. A half-done delete - pipeline gone, tables still there - is the orphan
 * problem this exists to stop creating.
 */
export async function deletePipeline(
	slug: string,
	spaceSlug?: string,
	dropOutputs: string[] = [],
): Promise<DeletePipelineResult> {
	const pipeline = await getPipeline(slug, spaceSlug);
	const outputs = await pipelineOutputs(slug, spaceSlug);
	const owned = new Set(outputs.map((output) => output.table));

	const requested = [...new Set(dropOutputs.map((name) => String(name).trim()).filter(Boolean))];
	const foreign = requested.filter((name) => !owned.has(name));
	if (foreign.length > 0) {
		throw new BadRequest(
			`${foreign.join(", ")} ${foreign.length === 1 ? "is" : "are"} not an output of ` +
				`'${pipeline.name}', so this request cannot drop ${foreign.length === 1 ? "it" : "them"}.`,
		);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const removed = await client.query(
			"DELETE FROM platform.pipeline WHERE pipeline_id = $1 RETURNING pipeline_id",
			[pipeline.id],
		);
		if (removed.rowCount === 0) throw new NotFound(`No pipeline '${slug}'.`);

		for (const qualified of requested) {
			const [schema, table] = qualified.split(".");
			if (schema !== "pipeline_out" || !table) {
				throw new BadRequest(`Refusing to drop '${qualified}': not a pipeline output.`);
			}
			await client.query(`DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(table)}`);
		}

		if (requested.length > 0) {
			// The build history of a dataset that no longer exists would otherwise
			// keep answering "how has this changed" about nothing.
			await client.query(
				"DELETE FROM platform.dataset_version WHERE qualified_name = ANY($1::text[])",
				[requested],
			);
		}

		// Its workspace card points at a pipeline that is gone; left behind it
		// would open onto a 404.
		await client.query(
			`DELETE FROM platform.resource r
			  USING platform.project p, platform.space s
			  WHERE r.project_id = p.project_id AND p.space_id = s.space_id
			    AND r.kind = 'pipeline' AND r.target_ref = $1 AND s.slug = $2`,
			[slug, pipeline.spaceSlug],
		);

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}

	return {
		deleted: pipeline.name,
		droppedOutputs: requested,
		keptOutputs: [...owned].filter((name) => !requested.includes(name)),
	};
}

export interface PipelineVersionSummary {
	version: number;
	note: string | null;
	savedBy: string;
	savedAt: string;
	nodeCount: number;
	edgeCount: number;
}

export async function listVersions(
	slug: string,
	spaceSlug?: string,
): Promise<PipelineVersionSummary[]> {
	const pipeline = await getPipeline(slug, spaceSlug);
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
	spaceSlug?: string,
): Promise<PipelineRecord> {
	const pipeline = await getPipeline(slug, spaceSlug);
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
			spaceSlug: pipeline.spaceSlug,
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

export async function runPipeline(
	slug: string,
	triggeredBy: string,
	spaceSlug?: string,
): Promise<RunRecord> {
	const pipeline = await getPipeline(slug, spaceSlug);

	// An unaccepted proposal does not run. Running writes real tables into
	// pipeline_out that dashboards and the assistant go on to read, so a graph
	// nobody has reviewed must not be able to become a dataset by being
	// triggered - which is the entire reason proposals are inert.
	if (pipeline.proposedBy && !pipeline.acceptedBy) {
		throw new BadRequest(
			`'${pipeline.name}' was drafted by ${pipeline.proposedBy} and has not been ` +
				`accepted yet. Review the graph and accept it before running it.`,
		);
	}

	const validation = validateGraph(pipeline.graph);

	if (validation.status === "invalid") {
		throw new BadRequest(
			`This pipeline has ${validation.errors.length} error(s) and cannot run. ` +
				`First: ${validation.errors[0]?.message}`,
		);
	}

	// The run row is written BEFORE execution and updated after, so a run that
	// crashes the process still leaves a record saying it was running rather
	// than vanishing. A pipeline that silently never ran is the worst outcome.
	const opened = await queryOne<{ pipeline_run_id: number; started_at: Date }>(
		`INSERT INTO platform.pipeline_run
		   (pipeline_id, version, status, records, errors, warnings, node_results, log,
		    is_simulated, execution_mode, triggered_by)
		 VALUES ($1,$2,'running',0,0,$3,'[]'::jsonb,'[]'::jsonb,false,'executed',$4)
		 RETURNING pipeline_run_id, started_at`,
		[pipeline.id, pipeline.version, validation.warnings.length, triggeredBy],
	);
	const runId = opened?.pipeline_run_id ?? 0;

	let result: ExecutionResult;
	try {
		result = await executeGraph(pipeline.graph, slug);
	} catch (error) {
		// A failure here is the engine itself giving up — a cyclic graph, a
		// name collision — rather than one node's SQL. The run is closed as
		// failed so it does not sit at "running" forever.
		const message = (error as Error).message;
		await query(
			`UPDATE platform.pipeline_run
			    SET status = 'failed', finished_at = now(),
			        duration_ms = 0, errors = 1,
			        log = $2::jsonb
			  WHERE pipeline_run_id = $1`,
			[
				runId,
				JSON.stringify([
					{ at: new Date().toISOString(), level: "error", message },
				]),
			],
		);
		throw error;
	}

	for (const warning of validation.warnings) {
		result.log.push({ at: new Date().toISOString(), level: "warn", message: warning.message });
	}

	// The shape the UI already renders, built from what actually ran.
	const nodeResults: NodeResult[] = result.nodes.map((node) => ({
		nodeId: node.nodeId,
		name: node.name,
		kind: node.kind,
		status: node.status,
		durationMs: node.durationMs,
		records: node.rowsOut,
		message: node.message,
	}));

	const errors = result.nodes.filter((n) => n.status === "failed").length;

	await query(
		`UPDATE platform.pipeline_run
		    SET status = $2, finished_at = now(), duration_ms = $3, records = $4,
		        errors = $5, warnings = $6, node_results = $7::jsonb, log = $8::jsonb,
		        rows_read = $9, rows_written = $10
		  WHERE pipeline_run_id = $1`,
		[
			runId,
			result.status,
			result.durationMs,
			result.rowsWritten,
			errors,
			validation.warnings.length,
			JSON.stringify(nodeResults),
			JSON.stringify(result.log),
			result.rowsRead,
			result.rowsWritten,
		],
	);

	await recordNodeRuns(runId, result.nodes);
	await recordDatasetVersions(runId, result.nodes, triggeredBy);

	return {
		id: runId,
		pipelineSlug: slug,
		version: pipeline.version,
		status: result.status,
		startedAt: opened?.started_at.toISOString() ?? new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: result.durationMs,
		records: result.rowsWritten,
		errors,
		warnings: validation.warnings.length,
		nodeResults,
		log: result.log,
		// The engine ran SQL. Nothing here is projected, so the banner that
		// warned every run was simulated must no longer appear.
		isSimulated: false,
		triggeredBy,
	};
}

export async function listRuns(
	slug: string,
	limit = 20,
	spaceSlug?: string,
): Promise<RunRecord[]> {
	const pipeline = await getPipeline(slug, spaceSlug);
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
	// Empty rather than a 409 where the space has no ontology. This is the
	// bootstrap case and it matters: the Pipeline Builder is how an ontology
	// gets published in the first place, so refusing to open it until one
	// exists would make a fresh space impossible to start work in. The data
	// nodes still work; there are simply no ontology nodes to offer yet.
	if (!hasOntology(currentSpace())) {
		return { objectTypes: [], linkTypes: [], actionTypes: [], kpis: [], views: [] };
	}
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

// ── AI-proposed pipelines (§18) ─────────────────────────────────────────────

export interface ProposePipelineRequest {
	name: string;
	description?: string;
	graph: unknown;
	proposedFrom?: string;
}

/**
 * Record a pipeline the assistant drafted.
 *
 * Saved so it can be looked at, and inert until it is. A graph that runs
 * writes real tables into pipeline_out which dashboards and the assistant then
 * read, so "generate and run" would let a sentence quietly become a dataset.
 *
 * Every node is COMPILED here, not merely shape-checked. The graph validator
 * catches a missing input or an unknown object type; it does not catch a
 * filter on a column the view has never had. Compiling does, and it does so
 * while the author can still fix it — the same lesson the function proposals
 * taught when the assistant confidently used camelCase api names as SQL
 * columns.
 */
export async function proposePipeline(
	request: ProposePipelineRequest,
	proposedBy: string,
): Promise<{ pipeline: PipelineRecord; compiled: Array<{ node: string; ok: boolean; detail: string }> }> {
	const name = String(request.name ?? "").trim();
	if (!name) throw new BadRequest("A pipeline needs a name.");

	const graph = coerceGraph(request.graph);
	if ((graph.nodes ?? []).length === 0) {
		throw new BadRequest("A pipeline needs at least one node.");
	}

	const validation = validateGraph(graph);
	if (validation.status === "invalid") {
		throw new BadRequest(
			`This graph has ${validation.errors.length} error(s). ` +
				`First: ${validation.errors[0]?.message}`,
		);
	}

	// Dry-compile each node against what its inputs really produce.
	const compiled = await dryCompile(graph);
	const broken = compiled.filter((entry) => !entry.ok);
	if (broken.length > 0) {
		throw new BadRequest(
			`${broken.length} node(s) will not run. First: ${broken[0]!.node} — ${broken[0]!.detail}`,
		);
	}

	const slug = slugifyName(name);
	const record = await savePipeline(
		{ slug, name, description: request.description, graph, spaceSlug: currentSpace() },
		proposedBy,
	);

	// Marked as a proposal AFTER saving, because savePipeline is the one place
	// that knows how to write a graph and its version history.
	await query(
		`UPDATE platform.pipeline
		    SET proposed_by = $2, proposed_from = $3, accepted_by = NULL, accepted_at = NULL
		  WHERE pipeline_id = $1`,
		[record.id, proposedBy, request.proposedFrom ?? null],
	);

	return { pipeline: await getPipeline(record.slug, currentSpace()), compiled };
}

/**
 * Compile every node without running anything.
 *
 * Inputs are described from the ontology rather than from materialised tables,
 * because nothing has run yet. A source node's columns come from its view's
 * catalogue entry; a transform's from what the compiler says its input emits.
 */
async function dryCompile(
	graph: PipelineGraph,
): Promise<Array<{ node: string; ok: boolean; detail: string }>> {
	const results: Array<{ node: string; ok: boolean; detail: string }> = [];
	const emitted = new Map<string, string[]>();

	const incoming = new Map<string, string[]>();
	for (const edge of graph.edges ?? []) {
		incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
	}

	for (const node of orderNodes(graph)) {
		if (!isExecutable(node.kind)) {
			results.push({ node: node.name, ok: true, detail: whyNotExecutable(node.kind) });
			continue;
		}

		const inputs = (incoming.get(node.id) ?? [])
			.filter((id) => emitted.has(id))
			.map((id) => ({
				relation: `"pipeline_out"."${id}"`,
				columns: emitted.get(id) ?? [],
				nodeId: id,
				name: id,
				rowCount: 0,
			}));

		try {
			const result = compileNode(node, inputs);
			// A source compiles to SELECT * over a view, so its real columns come
			// from the catalogue rather than from the compiler.
			const columns = result.columns.length
				? result.columns
				: await viewColumns(String(node.config?.sourceView ?? node.config?.view ?? ""));
			emitted.set(node.id, columns);

			// An aggregate that only groups computes nothing: it returns the
			// distinct group keys. That is valid SQL and almost never what was
			// asked for, so the reviewer is told rather than left to notice a
			// one-column result.
			const measures = Array.isArray(node.config?.measures) ? node.config.measures : [];
			const computesNothing = node.kind === "aggregate" && measures.length === 0;

			results.push({
				node: node.name,
				ok: true,
				detail: computesNothing
					? `${columns.length} column(s) - groups but computes nothing; add a measure`
					: `${columns.length} columns`,
			});
		} catch (error) {
			results.push({ node: node.name, ok: false, detail: (error as Error).message });
			emitted.set(node.id, []);
		}
	}
	return results;
}

/** Column names of a published view, for dry-compiling a source node. */
async function viewColumns(qualified: string): Promise<string[]> {
	const [schema, table] = qualified.split(".");
	if (!schema || !table) return [];
	const rows = await query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		[schema, table],
	);
	return rows.map((row) => row.column_name);
}

/** Dependency order, reused by the dry compile. */
function orderNodes(graph: PipelineGraph): PipelineNode[] {
	const nodes = graph.nodes ?? [];
	const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
	const next = new Map<string, string[]>();
	for (const edge of graph.edges ?? []) {
		if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
		indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
		next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
	}
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
	const ordered: PipelineNode[] = [];
	while (queue.length) {
		const node = queue.shift()!;
		ordered.push(node);
		for (const id of next.get(node.id) ?? []) {
			const remaining = (indegree.get(id) ?? 0) - 1;
			indegree.set(id, remaining);
			if (remaining === 0) queue.push(byId.get(id)!);
		}
	}
	return ordered;
}

/** Accept a proposal, making it runnable. */
export async function acceptPipeline(slug: string, acceptedBy: string): Promise<PipelineRecord> {
	const pipeline = await getPipeline(slug, currentSpace());
	if (pipeline.acceptedBy) return pipeline;

	await query(
		`UPDATE platform.pipeline SET accepted_by = $2, accepted_at = now() WHERE pipeline_id = $1`,
		[pipeline.id, acceptedBy],
	);
	return getPipeline(slug, currentSpace());
}
