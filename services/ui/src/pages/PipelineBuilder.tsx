/**
 * The pipeline builder.
 *
 * A canvas where a pipeline is drawn — sources, transforms, the object types
 * they produce, the links and actions on those, and the dashboards at the end
 * — with the ontology it produces validated against the one actually
 * published. Validation, the palette and the run are all server-side; this is
 * the editor over them.
 *
 * Undo/redo is a stack of whole graphs rather than a command log. The graphs
 * are small (tens of nodes) and whole-state snapshots cannot drift out of sync
 * with the document the way an inverse-command log can.
 */

import {
	Background,
	type Connection,
	Controls,
	type Edge,
	MiniMap,
	type Node,
	ReactFlow,
	ReactFlowProvider,
	addEdge,
	useEdgesState,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, session } from "../api";
import {
	BottomPanel,
	type Issue,
	type Run,
} from "../components/pipeline/BottomPanel";
import { CommandMenu } from "../components/pipeline/CommandMenu";
import {
	NodeInspector,
	type Palette,
} from "../components/pipeline/NodeInspector";
import {
	PipelineNodeCard,
	type PipelineNodeData,
} from "../components/pipeline/PipelineNodeCard";
import { NODE_SPECS, type NodeKind } from "../components/pipeline/nodeTypes";
import { ErrorBanner, Spinner } from "../components/common";

// ── the document ────────────────────────────────────────────────────────────

interface GraphNode {
	id: string;
	kind: NodeKind;
	name: string;
	description: string | null;
	position: { x: number; y: number };
	config: Record<string, unknown>;
}

interface GraphEdge {
	id: string;
	source: string;
	target: string;
}

interface Graph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

interface ValidationReport {
	status: "valid" | "warnings" | "invalid" | "unknown";
	errors: Issue[];
	warnings: Issue[];
	checkedAt: string;
}

interface PipelineRecord {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	graph: Graph;
	validation: ValidationReport;
	version: number;
	updatedBy: string | null;
	updatedAt: string;
}

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };

const nodeTypes = { pipeline: PipelineNodeCard };

/** A starter graph, so a new pipeline is never an empty void. */
function starterGraph(): Graph {
	return {
		nodes: [
			{
				id: "source-1",
				kind: "dataSource",
				name: "TMS Postgres",
				description: "The captured TMS snapshot this platform reads.",
				position: { x: 40, y: 160 },
				config: { system: "PostgreSQL", connection: "postgres:5432/tms_ontology" },
			},
		],
		edges: [],
	};
}

export function PipelineBuilder() {
	return (
		<ReactFlowProvider>
			<PipelineBuilderInner />
		</ReactFlowProvider>
	);
}

function PipelineBuilderInner() {
	const [pipelines, setPipelines] = useState<PipelineRecord[] | null>(null);
	const [slug, setSlug] = useState<string | null>(null);
	const [name, setName] = useState("Untitled pipeline");
	const [environment, setEnvironment] = useState("development");
	const [version, setVersion] = useState(1);
	const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
	const [palette, setPalette] = useState<Palette | null>(null);
	const [report, setReport] = useState<ValidationReport | null>(null);
	const [runs, setRuns] = useState<Run[]>([]);
	const [activeRun, setActiveRun] = useState<Run | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [bottomOpen, setBottomOpen] = useState(true);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const { fitView, setCenter } = useReactFlow();

	// Whole-graph snapshots. past/future hold documents, not commands.
	const past = useRef<Graph[]>([]);
	const future = useRef<Graph[]>([]);

	const role = session.user()?.role ?? "viewer";
	const readOnly = role === "viewer";

	// ── loading ─────────────────────────────────────────────────────────────

	useEffect(() => {
		Promise.all([
			api.get<PipelineRecord[]>("/api/pipelines"),
			api.get<Palette>("/api/pipelines/palette"),
		])
			.then(([list, pal]) => {
				setPipelines(list);
				setPalette(pal);
				// noUncheckedIndexedAccess: list[0] is possibly undefined even
				// after the length check, so it is read once and tested.
				const first = list[0];
				if (first) {
					void openPipeline(first.slug);
				} else {
					setGraph(starterGraph());
					setDirty(true);
				}
			})
			.catch((exc: Error) => setError(exc.message));
		// openPipeline is stable for this purpose; re-running on it would reload.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const openPipeline = useCallback(async (next: string) => {
		setError(null);
		try {
			const record = await api.get<PipelineRecord>(`/api/pipelines/${next}`);
			setSlug(record.slug);
			setName(record.name);
			setEnvironment(record.environment);
			setVersion(record.version);
			setGraph(record.graph ?? EMPTY_GRAPH);
			setReport(record.validation);
			setSelectedId(null);
			setDirty(false);
			past.current = [];
			future.current = [];
			const history = await api.get<Run[]>(`/api/pipelines/${next}/runs`);
			setRuns(history);
			setActiveRun(history[0] ?? null);
		} catch (exc) {
			setError(exc instanceof ApiError ? exc.message : String(exc));
		}
	}, []);

	// ── editing ─────────────────────────────────────────────────────────────

	const commit = useCallback((next: Graph, { snapshot = true } = {}) => {
		setGraph((current) => {
			if (snapshot) {
				past.current = [...past.current.slice(-49), current];
				future.current = [];
			}
			return next;
		});
		setDirty(true);
	}, []);

	const undo = useCallback(() => {
		const previous = past.current.pop();
		if (!previous) return;
		setGraph((current) => {
			future.current = [...future.current, current];
			return previous;
		});
		setDirty(true);
	}, []);

	const redo = useCallback(() => {
		const next = future.current.pop();
		if (!next) return;
		setGraph((current) => {
			past.current = [...past.current, current];
			return next;
		});
		setDirty(true);
	}, []);

	const addNode = useCallback(
		(kind: NodeKind) => {
			const spec = NODE_SPECS[kind];
			const id = `${kind}-${Date.now().toString(36)}`;
			// Placed to the right of the rightmost node, so a new node lands
			// where the graph is growing rather than on top of an existing one.
			const rightmost = graph.nodes.reduce(
				(max, node) => Math.max(max, node.position.x),
				-260,
			);
			commit({
				...graph,
				nodes: [
					...graph.nodes,
					{
						id,
						kind,
						name: spec.label,
						description: null,
						position: { x: rightmost + 280, y: 160 },
						config: {},
					},
				],
			});
			setSelectedId(id);
			setMenuOpen(false);
		},
		[graph, commit],
	);

	const updateNode = useCallback(
		(nodeId: string, patch: Partial<GraphNode>) => {
			commit({
				...graph,
				nodes: graph.nodes.map((node) =>
					node.id === nodeId ? { ...node, ...patch } : node,
				),
			});
		},
		[graph, commit],
	);

	const deleteNodes = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			const removing = new Set(ids);
			commit({
				nodes: graph.nodes.filter((node) => !removing.has(node.id)),
				// Edges to a removed node go with it, or the graph is left with
				// dangling references the server would reject.
				edges: graph.edges.filter(
					(edge) => !removing.has(edge.source) && !removing.has(edge.target),
				),
			});
			setSelectedId((current) => (current && removing.has(current) ? null : current));
		},
		[graph, commit],
	);

	const duplicateNode = useCallback(
		(nodeId: string) => {
			const original = graph.nodes.find((node) => node.id === nodeId);
			if (!original) return;
			const id = `${original.kind}-${Date.now().toString(36)}`;
			commit({
				...graph,
				nodes: [
					...graph.nodes,
					{
						...original,
						id,
						name: `${original.name} copy`,
						position: { x: original.position.x + 40, y: original.position.y + 60 },
					},
				],
			});
			setSelectedId(id);
		},
		[graph, commit],
	);

	/** Simple layered layout: depth from the roots decides the column. */
	const autoLayout = useCallback(() => {
		const depth = new Map<string, number>();
		const incoming = new Map<string, string[]>();
		for (const edge of graph.edges) {
			incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
		}
		const resolve = (id: string, seen: Set<string>): number => {
			if (depth.has(id)) return depth.get(id) as number;
			if (seen.has(id)) return 0; // a cycle; validation reports it separately
			seen.add(id);
			const parents = incoming.get(id) ?? [];
			const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => resolve(p, seen))) + 1;
			depth.set(id, value);
			return value;
		};
		for (const node of graph.nodes) resolve(node.id, new Set());

		const perColumn = new Map<number, number>();
		commit({
			...graph,
			nodes: graph.nodes.map((node) => {
				const column = depth.get(node.id) ?? 0;
				const row = perColumn.get(column) ?? 0;
				perColumn.set(column, row + 1);
				return { ...node, position: { x: column * 280, y: row * 150 } };
			}),
		});
		window.setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
	}, [graph, commit, fitView]);

	// ── server round trips ──────────────────────────────────────────────────

	// Validate as the graph changes, debounced: this is what puts the error
	// marks on the cards, so it has to track edits rather than wait for a save.
	useEffect(() => {
		if (!palette) return;
		const id = window.setTimeout(() => {
			api
				.post<ValidationReport>("/api/pipelines/validate", { graph })
				.then(setReport)
				.catch(() => {
					/* a failed validation must not block editing */
				});
		}, 400);
		return () => window.clearTimeout(id);
	}, [graph, palette]);

	const save = useCallback(async () => {
		if (readOnly) return;
		setBusy(true);
		setNotice(null);
		try {
			const saved = await api.post<PipelineRecord>("/api/pipelines", {
				slug: slug ?? undefined,
				name,
				environment,
				graph,
			});
			setSlug(saved.slug);
			setVersion(saved.version);
			setReport(saved.validation);
			setDirty(false);
			setNotice(`Saved as version ${saved.version}.`);
			setPipelines(await api.get<PipelineRecord[]>("/api/pipelines"));
		} catch (exc) {
			setNotice(exc instanceof ApiError ? exc.message : "Save failed.");
		} finally {
			setBusy(false);
		}
	}, [readOnly, slug, name, environment, graph]);

	const run = useCallback(async () => {
		if (!slug || readOnly) return;
		setBusy(true);
		setNotice(null);
		try {
			const result = await api.post<Run>(`/api/pipelines/${slug}/run`);
			setActiveRun(result);
			setRuns(await api.get<Run[]>(`/api/pipelines/${slug}/runs`));
			setBottomOpen(true);
			setNotice(`Run #${result.id} finished in ${result.durationMs}ms.`);
		} catch (exc) {
			setNotice(exc instanceof ApiError ? exc.message : "Run failed.");
			setBottomOpen(true);
		} finally {
			setBusy(false);
		}
	}, [slug, readOnly]);

	// ── keyboard ────────────────────────────────────────────────────────────

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			// Never hijack a key the user is typing into a field.
			if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

			const meta = event.metaKey || event.ctrlKey;
			if (meta && event.key.toLowerCase() === "s") {
				event.preventDefault();
				void save();
			} else if (meta && event.shiftKey && event.key.toLowerCase() === "z") {
				event.preventDefault();
				redo();
			} else if (meta && event.key.toLowerCase() === "z") {
				event.preventDefault();
				undo();
			} else if (event.key === "Delete" || event.key === "Backspace") {
				if (selectedId && !readOnly) {
					event.preventDefault();
					deleteNodes([selectedId]);
				}
			} else if (event.key === "f") {
				fitView({ padding: 0.2, duration: 300 });
			} else if (event.key === "n" && !readOnly) {
				event.preventDefault();
				setMenuOpen(true);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [save, undo, redo, selectedId, readOnly, deleteNodes, fitView]);

	// ── derived view state ──────────────────────────────────────────────────

	const issues: Issue[] = useMemo(
		() => (report ? [...report.errors, ...report.warnings] : []),
		[report],
	);

	const issuesByNode = useMemo(() => {
		const map = new Map<string, Issue[]>();
		for (const issue of issues) {
			if (!issue.nodeId) continue;
			map.set(issue.nodeId, [...(map.get(issue.nodeId) ?? []), issue]);
		}
		return map;
	}, [issues]);

	const recordsByNode = useMemo(() => {
		const map = new Map<string, number | null>();
		for (const result of activeRun?.nodeResults ?? []) {
			map.set(result.nodeId, result.records);
		}
		return map;
	}, [activeRun]);

	/**
	 * React Flow owns the node objects; the graph owns the document.
	 *
	 * Rebuilding the node array from `graph` on every render replaced each node
	 * object every time, which threw away React Flow's measurement for it — and
	 * an unmeasured node is rendered with visibility:hidden, so the whole canvas
	 * went blank. Node objects are now created once per structural change and
	 * patched in place after that.
	 */
	const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
	const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

	const buildData = useCallback(
		(node: GraphNode): PipelineNodeData => {
			const nodeIssues = issuesByNode.get(node.id) ?? [];
			const result = activeRun?.nodeResults.find((r) => r.nodeId === node.id);
			return {
				kind: node.kind,
				name: node.name,
				description: node.description,
				config: node.config,
				issue: nodeIssues.some((i) => i.severity === "error")
					? "error"
					: nodeIssues.length > 0
						? "warning"
						: null,
				issueCount: nodeIssues.length,
				runStatus: result?.status ?? null,
				runRecords: recordsByNode.get(node.id) ?? null,
				collapsed: false,
			};
		},
		[issuesByNode, recordsByNode, activeRun],
	);

	// The set of node ids, so a rebuild happens when nodes are added or removed
	// but not when one is merely dragged or reconfigured.
	const structureKey = graph.nodes.map((node) => node.id).join("|");

	useEffect(() => {
		setRfNodes(
			graph.nodes.map((node) => ({
				id: node.id,
				type: "pipeline",
				position: node.position,
				data: buildData(node),
			})),
		);
		// buildData changes with validation, which is handled by the patch below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [structureKey, setRfNodes]);

	// Patch data in place: same node objects, new contents, so measurement and
	// therefore visibility survive a validation or run update.
	useEffect(() => {
		setRfNodes((current) =>
			current.map((rfNode) => {
				const source = graph.nodes.find((node) => node.id === rfNode.id);
				return source ? { ...rfNode, data: buildData(source) } : rfNode;
			}),
		);
	}, [buildData, graph.nodes, setRfNodes]);

	useEffect(() => {
		setRfEdges(
			graph.edges.map((edge) => ({
				id: edge.id,
				source: edge.source,
				target: edge.target,
				className: "pedge",
			})),
		);
	}, [graph.edges, setRfEdges]);

	useEffect(() => {
		setRfNodes((current) =>
			current.map((node) =>
				node.selected === (node.id === selectedId)
					? node
					: { ...node, selected: node.id === selectedId },
			),
		);
	}, [selectedId, setRfNodes]);

	const selectedNode = graph.nodes.find((node) => node.id === selectedId) ?? null;
	const upstream = graph.edges
		.filter((edge) => edge.target === selectedId)
		.map((edge) => graph.nodes.find((n) => n.id === edge.source))
		.filter(Boolean) as GraphNode[];
	const downstream = graph.edges
		.filter((edge) => edge.source === selectedId)
		.map((edge) => graph.nodes.find((n) => n.id === edge.target))
		.filter(Boolean) as GraphNode[];

	const focusNode = useCallback(
		(nodeId: string) => {
			const node = graph.nodes.find((n) => n.id === nodeId);
			if (!node) return;
			setSelectedId(nodeId);
			setCenter(node.position.x + 110, node.position.y + 60, { zoom: 1, duration: 400 });
		},
		[graph.nodes, setCenter],
	);

	// ── render ──────────────────────────────────────────────────────────────

	if (error) return <ErrorBanner error={error} />;
	if (!pipelines || !palette) return <Spinner label="Loading the pipeline builder" />;

	const statusTone =
		report?.status === "invalid" ? "error" : report?.status === "warnings" ? "warn" : "ok";

	return (
		<div className="builder">
			<header className="builder-bar">
				<div className="builder-crumbs">
					<span className="muted">Operations Intelligence</span>
					<span className="muted">/</span>
					<input
						className="builder-name"
						value={name}
						disabled={readOnly}
						onChange={(event) => {
							setName(event.target.value);
							setDirty(true);
						}}
						aria-label="Pipeline name"
					/>
					{dirty && <span className="chip">unsaved</span>}
					<span className="chip mono">v{version}</span>
				</div>

				<select
					className="builder-select"
					value={slug ?? ""}
					onChange={(event) => {
						if (event.target.value) void openPipeline(event.target.value);
					}}
					aria-label="Open pipeline"
				>
					<option value="">— new pipeline —</option>
					{pipelines.map((item) => (
						<option key={item.slug} value={item.slug}>
							{item.name}
						</option>
					))}
				</select>

				<select
					className="builder-select"
					value={environment}
					disabled={readOnly}
					onChange={(event) => {
						setEnvironment(event.target.value);
						setDirty(true);
					}}
					aria-label="Environment"
				>
					<option value="development">Development</option>
					<option value="staging">Staging</option>
					<option value="production">Production</option>
				</select>

				<span className={`builder-status ${statusTone}`}>
					<span className="pnode-dot" aria-hidden />
					{report
						? report.status === "valid"
							? "Valid"
							: report.status === "warnings"
								? `${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`
								: `${report.errors.length} error${report.errors.length === 1 ? "" : "s"}`
						: "Not validated"}
				</span>

				<div className="builder-actions">
					<button className="btn sm" onClick={() => setMenuOpen(true)} disabled={readOnly}>
						+ Add node
					</button>
					<button className="btn sm" onClick={autoLayout} disabled={readOnly}>
						Auto-layout
					</button>
					<button className="btn sm" onClick={() => fitView({ padding: 0.2, duration: 300 })}>
						Fit
					</button>
					<button className="btn sm" onClick={undo} disabled={readOnly}>
						Undo
					</button>
					<button className="btn sm" onClick={save} disabled={readOnly || busy || !dirty}>
						Save
					</button>
					<button
						className="btn sm primary"
						onClick={run}
						disabled={readOnly || busy || !slug || report?.status === "invalid"}
						title={
							report?.status === "invalid"
								? "Fix the validation errors before running."
								: !slug
									? "Save the pipeline before running it."
									: undefined
						}
					>
						Run
					</button>
				</div>
			</header>

			{notice && <div className="banner builder-notice">{notice}</div>}

			<div className="builder-body">
				<div className="canvas">
					<ReactFlow
						nodes={rfNodes}
						edges={rfEdges}
						nodeTypes={nodeTypes}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						// Positions are written back to the document when the drag
						// ENDS, not while it streams: one undo entry per move, and no
						// re-render of the document sixty times a second.
						onNodeDragStop={(_event, node) => {
							commit({
								...graph,
								nodes: graph.nodes.map((item) =>
									item.id === node.id ? { ...item, position: node.position } : item,
								),
							});
						}}
						onConnect={(connection: Connection) => {
							if (readOnly) return;
							const next = addEdge(
								{ ...connection, id: `${connection.source}->${connection.target}` },
								rfEdges,
							);
							commit({
								...graph,
								edges: next.map((edge) => ({
									id: edge.id,
									source: edge.source,
									target: edge.target,
								})),
							});
						}}
						onNodeClick={(_event, node) => setSelectedId(node.id)}
						onPaneClick={() => setSelectedId(null)}
						onEdgesDelete={(deleted) => {
							const removing = new Set(deleted.map((e) => e.id));
							commit({ ...graph, edges: graph.edges.filter((e) => !removing.has(e.id)) });
						}}
						fitView
						minZoom={0.2}
						maxZoom={1.8}
						proOptions={{ hideAttribution: false }}
					>
						<Background gap={16} size={1} color="var(--canvas-dot)" />
						<Controls showInteractive={false} />
						<MiniMap
							pannable
							zoomable
							className="pminimap"
							nodeColor={(node) =>
								NODE_SPECS[(node.data as PipelineNodeData).kind]?.accent ?? "#666"
							}
						/>
					</ReactFlow>

					{/* Anchored to the canvas, not to the builder: at builder level it
					    sat on top of the bottom panel and covered the validation text. */}
					{selectedNode && !readOnly && (
						<div className="builder-floating">
							<button className="btn sm" onClick={() => duplicateNode(selectedNode.id)}>
								Duplicate
							</button>
							<button className="btn sm" onClick={() => deleteNodes([selectedNode.id])}>
								Delete
							</button>
						</div>
					)}

					{graph.nodes.length === 0 && (
						<div className="canvas-empty">
							<p>This pipeline is empty.</p>
							<button className="btn sm primary" onClick={() => setMenuOpen(true)}>
								Add the first node
							</button>
						</div>
					)}
				</div>

				<NodeInspector
					node={selectedNode}
					palette={palette}
					issues={issues}
					upstream={upstream}
					downstream={downstream}
					runRecords={selectedId ? (recordsByNode.get(selectedId) ?? null) : null}
					readOnly={readOnly}
					onChange={(patch) => selectedId && updateNode(selectedId, patch)}
					onSelect={focusNode}
					onClose={() => setSelectedId(null)}
				/>
			</div>

			<BottomPanel
				open={bottomOpen}
				issues={issues}
				runs={runs}
				activeRun={activeRun}
				onToggle={() => setBottomOpen((open) => !open)}
				onFocusNode={focusNode}
				onSelectRun={setActiveRun}
			/>

			<CommandMenu open={menuOpen} onPick={addNode} onClose={() => setMenuOpen(false)} />

		</div>
	);
}
