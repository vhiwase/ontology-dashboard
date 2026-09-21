/**
 * Lineage: where every figure came from.
 *
 * Laid out in pipeline columns rather than as a force graph, because the lineage
 * graph IS a pipeline and the layer a node sits in is the most important thing
 * about it. Selecting a node traces upstream from it, which is the question
 * people actually ask - "where does this number come from" far more often than
 * "what else uses it".
 */

import { useEffect, useMemo, useState } from "react";
import {
	type KpiMeta,
	type LineageGraph,
	type LineageNode,
	type ObjectTypeSummary,
	api,
} from "../api";
import { GraphCanvas, type GraphLink, type GraphNode } from "../components/GraphCanvas";
import { DataTable, Empty, ErrorBanner, Spinner } from "../components/common";

const LAYER_DESCRIPTIONS: Record<string, string> = {
	source: "The HTTP endpoint each payload was captured from.",
	raw: "Landing tables holding a faithful copy of the payload.",
	simulation: "Generated execution actuals. Not measured data.",
	view: "Semantic views that reshape raw rows into business language.",
	ontology: "Object types generated from those views.",
	metric: "KPI definitions built on the metric views.",
	consumer: "Dashboards, the explorer and the assistant.",
};

interface TraceResult {
	trace: {
		nodeId: string;
		origin: LineageNode;
		direction: string;
		depth: number;
		nodes: LineageNode[];
		edges: Array<{ id: string; source: string; target: string; relationType: string }>;
	};
	columns: Array<Record<string, unknown>>;
}

export function LineagePage() {
	const [graph, setGraph] = useState<LineageGraph | null>(null);
	const [types, setTypes] = useState<ObjectTypeSummary[]>([]);
	const [kpis, setKpis] = useState<KpiMeta[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [subject, setSubject] = useState<{ kind: "objectType" | "kpi"; name: string } | null>(null);
	const [trace, setTrace] = useState<TraceResult | null>(null);
	const [activeLayers, setActiveLayers] = useState<string[] | null>(null);

	useEffect(() => {
		Promise.all([
			api.get<LineageGraph>("/api/lineage/graph"),
			api.get<ObjectTypeSummary[]>("/api/object-types"),
			api.get<KpiMeta[]>("/api/kpis"),
		])
			.then(([graphData, typeRows, kpiRows]) => {
				setGraph(graphData);
				setTypes(typeRows);
				setKpis(kpiRows);
			})
			.catch((exc: Error) => setError(exc.message));
	}, []);

	useEffect(() => {
		if (!subject) {
			setTrace(null);
			return;
		}
		setTrace(null);
		const path =
			subject.kind === "kpi"
				? `/api/lineage/kpi/${subject.name}`
				: `/api/lineage/object-type/${subject.name}`;
		api
			.get<TraceResult>(path)
			.then(setTrace)
			.catch((exc: Error) => setError(exc.message));
	}, [subject]);

	// When a subject is chosen, draw only its upstream subgraph; otherwise the
	// whole pipeline. 168 nodes is legible in columns but the trace is the point.
	const { nodes, links } = useMemo(() => {
		const sourceNodes = trace ? trace.trace.nodes : (graph?.nodes ?? []);
		const sourceEdges = trace ? trace.trace.edges : (graph?.edges ?? []);
		const visible = activeLayers
			? sourceNodes.filter((node) => activeLayers.includes(node.layer ?? "other"))
			: sourceNodes;
		const ids = new Set(visible.map((node) => node.id));
		return {
			nodes: visible.map<GraphNode>((node) => ({
				id: node.id,
				label: node.label,
				group: node.layer,
				weight: Number((node.payload as { rowCount?: number }).rowCount ?? 0),
				meta: { description: node.description, nodeType: node.nodeType, tags: node.tags },
			})),
			links: sourceEdges
				.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
				.map<GraphLink>((edge) => ({
					source: edge.source,
					target: edge.target,
					kind: edge.relationType,
					dashed: edge.relationType === "derivedFrom",
				})),
		};
	}, [graph, trace, activeLayers]);

	// The tallest column decides the canvas height.
	const densestColumn = useMemo(() => {
		const counts = new Map<string, number>();
		for (const node of nodes) {
			const key = node.group ?? "other";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return Math.max(1, ...counts.values());
	}, [nodes]);

	if (error) return <ErrorBanner error={error} />;
	if (!graph) return <Spinner label="Loading lineage graph" />;

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3>Data lineage</h3>
					<span className="sub">
						{graph.nodes.length} nodes · {graph.edges.length} edges across {graph.layers.length} layers
					</span>
				</div>

				<div className="row" style={{ gap: 10, marginBottom: 10 }}>
					<label className="row" style={{ gap: 6 }}>
						<span className="muted">Trace</span>
						<select
							value={subject ? `${subject.kind}:${subject.name}` : ""}
							onChange={(event) => {
								const raw = event.target.value;
								if (!raw) return setSubject(null);
								const [kind, name] = raw.split(":");
								setSubject({ kind: kind as "objectType" | "kpi", name: name! });
							}}
						>
							<option value="">whole pipeline</option>
							<optgroup label="Object types">
								{types.map((type) => (
									<option key={type.apiName} value={`objectType:${type.apiName}`}>
										{type.label}
									</option>
								))}
							</optgroup>
							<optgroup label="KPIs">
								{kpis.map((kpi) => (
									<option key={kpi.apiName} value={`kpi:${kpi.apiName}`}>
										{kpi.label}
									</option>
								))}
							</optgroup>
						</select>
					</label>

					<div className="row" style={{ gap: 5 }}>
						{graph.layers.map((layer) => {
							const active = !activeLayers || activeLayers.includes(layer.layer);
							return (
								<button
									key={layer.layer}
									className={`btn sm ${active ? "primary" : ""}`}
									title={LAYER_DESCRIPTIONS[layer.layer]}
									onClick={() => {
										const all = graph.layers.map((entry) => entry.layer);
										const current = activeLayers ?? all;
										const next = current.includes(layer.layer)
											? current.filter((name) => name !== layer.layer)
											: [...current, layer.layer];
										setActiveLayers(next.length === all.length ? null : next);
									}}
								>
									{layer.layer} {layer.count}
								</button>
							);
						})}
					</div>
				</div>

				{subject && trace && (
					<div className="banner" style={{ marginBottom: 10, borderLeftColor: "var(--series-1)" }}>
						<strong>{trace.trace.origin.label}</strong> draws on {trace.trace.nodes.length} upstream
						nodes across {trace.trace.depth} hops, from{" "}
						{
							trace.trace.nodes.filter((node) => node.layer === "source").length
						}{" "}
						source endpoints.
						{trace.trace.nodes.some((node) => node.layer === "simulation") && (
							<>
								{" "}
								It passes through the execution simulation, so some of its values are
								generated rather than measured.
							</>
						)}
					</div>
				)}

				<GraphCanvas
					nodes={nodes}
					links={links}
					layout="layered"
					// Scales with the busiest column, so a 53-node metric layer still gets
					// a readable row height instead of being crushed into a fixed canvas.
					height={Math.min(Math.max(520, densestColumn * 17 + 120), 1100)}
				/>
			</div>

			{trace && (
				<div className="grid grid-2">
					<div className="card">
						<div className="card-head">
							<h3>Upstream nodes</h3>
							<span className="sub">ordered by distance from {trace.trace.origin.label}</span>
						</div>
						<DataTable
							columns={[
								{ key: "depth", label: "Hops", numeric: true },
								{ key: "layer", label: "Layer" },
								{ key: "nodeType", label: "Kind" },
								{ key: "label", label: "Node" },
							]}
							rows={trace.trace.nodes as unknown as Array<Record<string, unknown>>}
							maxHeight={380}
						/>
					</div>

					<div className="card">
						<div className="card-head">
							<h3>Source columns</h3>
							<span className="sub">{trace.columns.length} base columns read</span>
						</div>
						{trace.columns.length === 0 ? (
							<Empty>No column-level dependencies recorded for this view.</Empty>
						) : (
							<DataTable
								columns={[
									{ key: "source_table", label: "Table" },
									{ key: "source_column", label: "Column" },
								]}
								rows={trace.columns}
								maxHeight={380}
							/>
						)}
						<p className="muted" style={{ fontSize: 11.5, marginTop: 9, marginBottom: 0 }}>
							Read from <code>pg_depend</code>: Postgres records these when the view is
							created, so this is the catalogue's own account of the dependency, not a
							guess from parsing SQL.
						</p>
					</div>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>What the layers mean</h3>
				</div>
				<div className="kv">
					{graph.layers.map((layer) => (
						<div key={layer.layer} style={{ display: "contents" }}>
							<dt>{layer.layer}</dt>
							<dd className="secondary">{LAYER_DESCRIPTIONS[layer.layer] ?? "—"}</dd>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
