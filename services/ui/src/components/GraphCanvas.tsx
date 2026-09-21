/**
 * Graph canvas for the ontology and the lineage graph.
 *
 * Two layouts, because the two graphs want different things:
 *
 *   force    - the ontology. 20 object types with 41 links and no natural
 *              ordering, so a relaxation layout that lets clusters emerge reads
 *              better than any imposed grid.
 *   layered  - the lineage graph. It IS a pipeline, source to consumer, so the
 *              layer a node belongs to is its x position and the only interesting
 *              freedom is vertical ordering within the column.
 *
 * The force layout is a small fixed-iteration relaxation run once on mount rather
 * than an animation loop: at this node count it settles in a few hundred
 * iterations, and a static result is far easier to read, screenshot and click
 * than one that drifts. Positions are recomputed only when the graph changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shortLabel } from "../api";

export interface GraphNode {
	id: string;
	label: string;
	/** Drives colour; for the ontology this is the object group, for lineage the layer. */
	group?: string | null;
	color?: string | null;
	/** Scales the node radius: object count, row count, whatever is meaningful. */
	weight?: number;
	meta?: Record<string, unknown>;
}

export interface GraphLink {
	source: string;
	target: string;
	label?: string;
	/** Drawn dashed when the underlying relationship is incomplete. */
	dashed?: boolean;
	kind?: string;
}

interface Positioned extends GraphNode {
	x: number;
	y: number;
	radius: number;
	/** False when the column is too dense for a label to be readable. */
	showLabel: boolean;
	/** Characters the label may use before it collides with the next column. */
	labelChars: number;
}

const GROUP_COLORS: Record<string, string> = {
	// Ontology groups.
	Demand: "var(--series-4)",
	Execution: "var(--series-1)",
	Party: "var(--series-3)",
	Structure: "var(--ink-muted)",
	Reference: "var(--series-7)",
	// Lineage layers, in pipeline order.
	source: "var(--series-2)",
	raw: "var(--series-4)",
	simulation: "var(--series-5)",
	view: "var(--series-1)",
	ontology: "var(--series-3)",
	metric: "var(--series-7)",
	consumer: "var(--series-6)",
};

const LAYER_ORDER = ["source", "raw", "simulation", "view", "ontology", "metric", "consumer"];

export function colorForGroup(group: string | null | undefined): string {
	if (!group) return "var(--ink-muted)";
	return GROUP_COLORS[group] ?? "var(--series-1)";
}

export function GraphCanvas({
	nodes,
	links,
	layout = "force",
	height = 560,
	selectedId,
	onSelect,
}: {
	nodes: GraphNode[];
	links: GraphLink[];
	layout?: "force" | "layered";
	height?: number;
	selectedId?: string | null;
	onSelect?: (node: GraphNode) => void;
}) {
	const width = 1200;
	const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
	const [hovered, setHovered] = useState<string | null>(null);
	const dragState = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

	const positioned = useMemo<Positioned[]>(
		() => (layout === "layered" ? layeredLayout(nodes, width, height) : forceLayout(nodes, links, width, height)),
		[nodes, links, layout, height],
	);

	const byId = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);

	// Reset the view whenever the graph itself changes, so switching subject does
	// not leave the user panned off into empty space.
	useEffect(() => {
		setTransform({ x: 0, y: 0, k: 1 });
	}, [nodes, links]);

	const onWheel = useCallback((event: React.WheelEvent) => {
		event.preventDefault();
		setTransform((current) => {
			const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
			return { ...current, k: Math.min(3, Math.max(0.35, current.k * factor)) };
		});
	}, []);

	const onPointerDown = (event: React.PointerEvent) => {
		dragState.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
		(event.target as Element).setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: React.PointerEvent) => {
		const drag = dragState.current;
		if (!drag) return;
		setTransform((current) => ({
			...current,
			x: drag.tx + (event.clientX - drag.x),
			y: drag.ty + (event.clientY - drag.y),
		}));
	};
	const onPointerUp = () => {
		dragState.current = null;
	};

	// Neighbours of the hovered or selected node, so hovering dims everything else.
	const focusId = hovered ?? selectedId ?? null;
	const neighbours = useMemo(() => {
		if (!focusId) return null;
		const set = new Set<string>([focusId]);
		for (const link of links) {
			if (link.source === focusId) set.add(link.target);
			if (link.target === focusId) set.add(link.source);
		}
		return set;
	}, [focusId, links]);

	const groups = useMemo(() => {
		const seen = new Map<string, number>();
		for (const node of nodes) {
			const key = node.group ?? "other";
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}
		return [...seen.entries()].sort((a, b) => {
			const ai = LAYER_ORDER.indexOf(a[0]);
			const bi = LAYER_ORDER.indexOf(b[0]);
			if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
			return b[1] - a[1];
		});
	}, [nodes]);

	if (nodes.length === 0) {
		return <div className="empty">No nodes to draw.</div>;
	}

	return (
		<div>
			<div className="graph-wrap" style={{ height }}>
				<div className="graph-controls">
					<button
						className="btn sm"
						onClick={() => setTransform((c) => ({ ...c, k: Math.min(3, c.k * 1.2) }))}
						aria-label="Zoom in"
					>
						+
					</button>
					<button
						className="btn sm"
						onClick={() => setTransform((c) => ({ ...c, k: Math.max(0.35, c.k / 1.2) }))}
						aria-label="Zoom out"
					>
						−
					</button>
					<button className="btn sm" onClick={() => setTransform({ x: 0, y: 0, k: 1 })}>
						Reset
					</button>
				</div>

				<svg
					viewBox={`0 0 ${width} ${height}`}
					height={height}
					onWheel={onWheel}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerLeave={onPointerUp}
					role="img"
					aria-label="Graph"
				>
					<defs>
						<marker
							id="graph-arrow"
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="6"
							markerHeight="6"
							orient="auto-start-reverse"
						>
							<path d="M0,0 L8,4 L0,8 z" fill="var(--border-strong)" />
						</marker>
					</defs>

					<g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
						{links.map((link, index) => {
							const from = byId.get(link.source);
							const to = byId.get(link.target);
							if (!from || !to) return null;
							const dimmed = neighbours
								? !(neighbours.has(link.source) && neighbours.has(link.target))
								: false;
							// A self-link is drawn as a loop above the node, otherwise it would
							// collapse to an invisible zero-length line.
							if (link.source === link.target) {
								return (
									<path
										key={`${link.source}-${link.target}-${index}`}
										className="edge-line"
										d={`M${from.x},${from.y - from.radius} a 16,14 0 1,1 8,0`}
										opacity={dimmed ? 0.12 : 0.55}
										strokeWidth={1}
										strokeDasharray={link.dashed ? "4 3" : undefined}
									/>
								);
							}
							return (
								<line
									key={`${link.source}-${link.target}-${index}`}
									className="edge-line"
									x1={from.x}
									y1={from.y}
									x2={to.x}
									y2={to.y}
									opacity={dimmed ? 0.1 : 0.5}
									strokeWidth={dimmed ? 1 : 1.3}
									strokeDasharray={link.dashed ? "4 3" : undefined}
									markerEnd="url(#graph-arrow)"
								/>
							);
						})}

						{positioned.map((node) => {
							const dimmed = neighbours ? !neighbours.has(node.id) : false;
							const isSelected = node.id === selectedId;
							return (
								<g
									key={node.id}
									opacity={dimmed ? 0.22 : 1}
									onMouseEnter={() => setHovered(node.id)}
									onMouseLeave={() => setHovered(null)}
									onClick={() => onSelect?.(node)}
									style={{ cursor: onSelect ? "pointer" : "default" }}
								>
									<circle
										className="node-circle"
										cx={node.x}
										cy={node.y}
										r={node.radius}
										fill={node.color ?? colorForGroup(node.group)}
										stroke={isSelected ? "var(--ink-primary)" : "var(--surface-1)"}
										strokeWidth={isSelected ? 2.5 : 2}
									>
										<title>{node.label}</title>
									</circle>
									{(node.showLabel || isSelected || node.id === hovered) && (
										<text
											className="node-label"
											x={node.x}
											y={node.y + node.radius + 11}
											textAnchor="middle"
											style={
												isSelected || node.id === hovered
													? { fill: "var(--ink-primary)", fontWeight: 600 }
													: undefined
											}
										>
											{shortLabel(node.label, node.labelChars)}
										</text>
									)}
								</g>
							);
						})}
					</g>
				</svg>
			</div>

			{/* Legend is always present: the group colours carry meaning. */}
			<div className="legend">
				{groups.map(([group, count]) => (
					<span className="legend-item" key={group}>
						<span className="legend-swatch" style={{ background: colorForGroup(group) }} />
						{group} <span className="muted num">{count}</span>
					</span>
				))}
				<span className="legend-item muted" style={{ marginLeft: "auto" }}>
					Drag to pan · scroll to zoom · hover to isolate
					{positioned.some((node) => !node.showLabel) &&
						" · hover a dense column to name its nodes"}
				</span>
			</div>
		</div>
	);
}

function radiusFor(weight: number | undefined): number {
	if (!weight || weight <= 0) return 9;
	// Square root so area, not radius, tracks the count: a 2,269-row type should
	// not be 250 times the width of a 9-row one.
	return Math.max(8, Math.min(30, 7 + Math.sqrt(weight) * 0.55));
}

/**
 * Fixed-iteration force relaxation: repulsion between all pairs, springs along
 * links, and a weak pull to centre so disconnected nodes do not drift off canvas.
 */
function forceLayout(nodes: GraphNode[], links: GraphLink[], width: number, height: number): Positioned[] {
	const count = nodes.length;
	if (count === 0) return [];

	const centerX = width / 2;
	const centerY = height / 2;
	// Seeded on a circle rather than at random, so the layout is reproducible
	// across reloads - a graph that rearranges itself every refresh is disorienting.
	const placed: Positioned[] = nodes.map((node, index) => {
		const angle = (index / count) * Math.PI * 2;
		const ring = Math.min(width, height) * 0.32;
		return {
			...node,
			x: centerX + Math.cos(angle) * ring,
			y: centerY + Math.sin(angle) * ring,
			radius: radiusFor(node.weight),
			showLabel: true,
			labelChars: 22,
		};
	});

	const index = new Map(placed.map((node, position) => [node.id, position]));
	const edges = links
		.map((link) => ({ a: index.get(link.source), b: index.get(link.target) }))
		.filter((edge): edge is { a: number; b: number } => edge.a !== undefined && edge.b !== undefined && edge.a !== edge.b);

	const iterations = 320;
	const repulsion = 9000;
	const springLength = 120;
	const springStrength = 0.02;

	for (let step = 0; step < iterations; step += 1) {
		// Cooling: big moves early, fine adjustment late.
		const cooling = 1 - step / iterations;
		const dx = new Float64Array(count);
		const dy = new Float64Array(count);

		for (let i = 0; i < count; i += 1) {
			for (let j = i + 1; j < count; j += 1) {
				const a = placed[i]!;
				const b = placed[j]!;
				let deltaX = a.x - b.x;
				let deltaY = a.y - b.y;
				let distanceSquared = deltaX * deltaX + deltaY * deltaY;
				if (distanceSquared < 1) {
					// Coincident nodes would divide by zero; nudge them apart
					// deterministically using their index rather than randomly.
					deltaX = (i - j) * 0.01 + 0.5;
					deltaY = (j - i) * 0.01 + 0.5;
					distanceSquared = deltaX * deltaX + deltaY * deltaY;
				}
				const distance = Math.sqrt(distanceSquared);
				const force = repulsion / distanceSquared;
				const fx = (deltaX / distance) * force;
				const fy = (deltaY / distance) * force;
				dx[i]! += fx;
				dy[i]! += fy;
				dx[j]! -= fx;
				dy[j]! -= fy;
			}
		}

		for (const edge of edges) {
			const a = placed[edge.a]!;
			const b = placed[edge.b]!;
			const deltaX = b.x - a.x;
			const deltaY = b.y - a.y;
			const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1;
			const force = (distance - springLength) * springStrength;
			const fx = (deltaX / distance) * force;
			const fy = (deltaY / distance) * force;
			dx[edge.a]! += fx;
			dy[edge.a]! += fy;
			dx[edge.b]! -= fx;
			dy[edge.b]! -= fy;
		}

		for (let i = 0; i < count; i += 1) {
			const node = placed[i]!;
			dx[i]! += (centerX - node.x) * 0.006;
			dy[i]! += (centerY - node.y) * 0.006;
			node.x += Math.max(-24, Math.min(24, dx[i]!)) * cooling;
			node.y += Math.max(-24, Math.min(24, dy[i]!)) * cooling;
		}
	}

	// Scale the settled layout to fill the canvas, leaving room for labels.
	const margin = 46;
	const xs = placed.map((node) => node.x);
	const ys = placed.map((node) => node.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const scaleX = (width - margin * 2) / (maxX - minX || 1);
	const scaleY = (height - margin * 2) / (maxY - minY || 1);
	const scale = Math.min(scaleX, scaleY, 1.6);

	for (const node of placed) {
		node.x = margin + (node.x - minX) * scale;
		node.y = margin + (node.y - minY) * scale;
	}
	return placed;
}

/** Columns by layer, in pipeline order, evenly spread vertically. */
function layeredLayout(nodes: GraphNode[], width: number, height: number): Positioned[] {
	const byLayer = new Map<string, GraphNode[]>();
	for (const node of nodes) {
		const key = node.group ?? "other";
		const bucket = byLayer.get(key);
		if (bucket) bucket.push(node);
		else byLayer.set(key, [node]);
	}

	const layers = [...byLayer.keys()].sort((a, b) => {
		const ai = LAYER_ORDER.indexOf(a);
		const bi = LAYER_ORDER.indexOf(b);
		return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
	});

	const margin = 64;
	const columnWidth = (width - margin * 2) / Math.max(layers.length - 1, 1);
	const placed: Positioned[] = [];

	layers.forEach((layer, columnIndex) => {
		const column = byLayer.get(layer) ?? [];
		// Alphabetical within a column so a node keeps its place between renders.
		column.sort((a, b) => a.label.localeCompare(b.label));
		const spacing = (height - margin * 2) / Math.max(column.length, 1);

		// A column of 53 KPI nodes leaves ~8px per row. Drawing a 10px label and an
		// 18px circle into that is the illegible overlap this guards against.
		// Circles are clamped to their slot, and labels are dropped for the whole
		// column rather than some of them: a column where every third label renders
		// is harder to read than one with none, and hover still names every node.
		const maxRadius = Math.max(3, spacing / 2 - 1);
		const showLabel = spacing >= 15;
		// A centred label spills into the neighbouring columns, so it is truncated
		// to the column's own width - roughly 6.4px per character at 10px type.
		const labelChars = Math.max(6, Math.floor((columnWidth - 12) / 6.4));
		column.forEach((node, rowIndex) => {
			placed.push({
				...node,
				x: margin + columnIndex * columnWidth,
				y: margin + spacing * (rowIndex + 0.5),
				radius: Math.min(radiusFor(node.weight), maxRadius),
				showLabel,
				labelChars,
			});
		});
	});

	return placed;
}
