import { query, queryOne } from "./db";
import { NotFound } from "./registry";

/**
 * Lineage queries over the graph the pipeline wrote.
 *
 * The trace is a breadth-first walk with a depth cap rather than a recursive CTE.
 * At this size (168 nodes, 432 edges) the whole graph fits in memory, and walking
 * it in TypeScript makes the depth bookkeeping the UI needs - which ring a node
 * sits in relative to the starting point - straightforward, where a CTE would
 * need a second pass to recover it.
 */

export interface LineageNode {
	id: string;
	nodeType: "dataSource" | "transformation" | "object" | "usage";
	label: string;
	description: string | null;
	objectId: string | null;
	layer: string | null;
	payload: Record<string, unknown>;
	tags: string[];
	/** Rings from the trace origin; absent on a full-graph fetch. */
	depth?: number;
}

export interface LineageEdge {
	id: string;
	source: string;
	target: string;
	relationType: "flowsTo" | "derivedFrom" | "usedBy";
	weight: number | null;
	payload: Record<string, unknown>;
}

export interface LineageGraph {
	nodes: LineageNode[];
	edges: LineageEdge[];
	layers: Array<{ layer: string; count: number }>;
}

interface NodeRow {
	lineage_node_rid: string;
	node_type: LineageNode["nodeType"];
	label: string;
	description: string | null;
	object_id: string | null;
	layer: string | null;
	payload: Record<string, unknown>;
	tags: string[];
}

interface EdgeRow {
	lineage_edge_rid: string;
	source_node_rid: string;
	target_node_rid: string;
	relation_type: LineageEdge["relationType"];
	weight: string | null;
	payload: Record<string, unknown>;
}

function toNode(row: NodeRow, depth?: number): LineageNode {
	return {
		id: row.lineage_node_rid,
		nodeType: row.node_type,
		label: row.label,
		description: row.description,
		objectId: row.object_id,
		layer: row.layer,
		payload: row.payload ?? {},
		tags: row.tags ?? [],
		...(depth === undefined ? {} : { depth }),
	};
}

function toEdge(row: EdgeRow): LineageEdge {
	return {
		id: row.lineage_edge_rid,
		source: row.source_node_rid,
		target: row.target_node_rid,
		relationType: row.relation_type,
		weight: row.weight === null ? null : Number(row.weight),
		payload: row.payload ?? {},
	};
}

export async function fetchGraph(layers?: string[]): Promise<LineageGraph> {
	const nodeRows = layers && layers.length
		? await query<NodeRow>("SELECT * FROM platform.lineage_node WHERE layer = ANY($1) ORDER BY layer, label", [layers])
		: await query<NodeRow>("SELECT * FROM platform.lineage_node ORDER BY layer, label");

	const ids = nodeRows.map((r) => r.lineage_node_rid);
	// Only edges whose BOTH endpoints are in the requested slice: an edge dangling
	// into a filtered-out layer would render as an arrow to nowhere.
	const edgeRows = await query<EdgeRow>(
		`SELECT * FROM platform.lineage_edge
		  WHERE source_node_rid = ANY($1) AND target_node_rid = ANY($1)`,
		[ids],
	);

	const layerRows = await query<{ layer: string; n: string }>(
		"SELECT layer, count(*)::bigint AS n FROM platform.lineage_node GROUP BY layer ORDER BY layer",
	);

	return {
		nodes: nodeRows.map((r) => toNode(r)),
		edges: edgeRows.map(toEdge),
		layers: layerRows.map((r) => ({ layer: r.layer, count: Number(r.n) })),
	};
}

export interface TraceOptions {
	direction?: "upstream" | "downstream" | "both";
	maxDepth?: number;
}

export interface LineageTrace {
	nodeId: string;
	origin: LineageNode;
	direction: string;
	depth: number;
	nodes: LineageNode[];
	edges: LineageEdge[];
}

export async function trace(nodeId: string, options: TraceOptions = {}): Promise<LineageTrace> {
	const direction = options.direction ?? "both";
	const maxDepth = options.maxDepth && options.maxDepth > 0 ? options.maxDepth : 12;

	const originRow = await queryOne<NodeRow>(
		"SELECT * FROM platform.lineage_node WHERE lineage_node_rid = $1",
		[nodeId],
	);
	if (!originRow) throw new NotFound(`No lineage node '${nodeId}'.`);

	// The whole graph in one round trip, then walked in memory. Two queries beats
	// one per ring, and the graph is small enough that loading it all is cheaper
	// than a recursive CTE with a depth column.
	const [allNodes, allEdges] = await Promise.all([
		query<NodeRow>("SELECT * FROM platform.lineage_node"),
		query<EdgeRow>("SELECT * FROM platform.lineage_edge"),
	]);

	const nodeById = new Map(allNodes.map((n) => [n.lineage_node_rid, n]));
	const outgoing = new Map<string, EdgeRow[]>();
	const incoming = new Map<string, EdgeRow[]>();
	for (const edge of allEdges) {
		const out = outgoing.get(edge.source_node_rid);
		if (out) out.push(edge);
		else outgoing.set(edge.source_node_rid, [edge]);

		const inbound = incoming.get(edge.target_node_rid);
		if (inbound) inbound.push(edge);
		else incoming.set(edge.target_node_rid, [edge]);
	}

	const visited = new Map<string, number>([[nodeId, 0]]);
	const collectedEdges = new Map<string, EdgeRow>();
	let frontier = [nodeId];
	let depth = 0;

	while (frontier.length && depth < maxDepth) {
		const next: string[] = [];
		for (const id of frontier) {
			if (direction === "downstream" || direction === "both") {
				for (const edge of outgoing.get(id) ?? []) {
					collectedEdges.set(edge.lineage_edge_rid, edge);
					if (!visited.has(edge.target_node_rid)) {
						visited.set(edge.target_node_rid, depth + 1);
						next.push(edge.target_node_rid);
					}
				}
			}
			if (direction === "upstream" || direction === "both") {
				for (const edge of incoming.get(id) ?? []) {
					collectedEdges.set(edge.lineage_edge_rid, edge);
					if (!visited.has(edge.source_node_rid)) {
						visited.set(edge.source_node_rid, depth + 1);
						next.push(edge.source_node_rid);
					}
				}
			}
		}
		if (next.length === 0) break;
		frontier = next;
		depth += 1;
	}

	const nodes: LineageNode[] = [];
	for (const [id, nodeDepth] of visited) {
		const row = nodeById.get(id);
		if (row) nodes.push(toNode(row, nodeDepth));
	}
	nodes.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.label.localeCompare(b.label));

	// Edges are kept only between nodes the walk actually reached, so the returned
	// subgraph is self-consistent.
	const edges = [...collectedEdges.values()]
		.filter((e) => visited.has(e.source_node_rid) && visited.has(e.target_node_rid))
		.map(toEdge);

	return {
		nodeId,
		origin: toNode(originRow, 0),
		direction,
		depth,
		nodes,
		edges,
	};
}

/** The upstream story for one object type, for the "where does this come from" panel. */
export async function traceObjectType(apiName: string): Promise<LineageTrace> {
	return trace(`lineage:objecttype:${apiName}`, { direction: "upstream", maxDepth: 12 });
}

/** The upstream story for one KPI. */
export async function traceKpi(apiName: string): Promise<LineageTrace> {
	return trace(`lineage:kpi:${apiName}`, { direction: "upstream", maxDepth: 12 });
}

/** Which base columns feed a given view. */
export async function columnLineage(view: string): Promise<Array<Record<string, unknown>>> {
	return query(
		`SELECT target_view, source_table, source_column, transform_note
		   FROM platform.lineage_column
		  WHERE target_view = $1
		  ORDER BY source_table, source_column`,
		[view],
	);
}
