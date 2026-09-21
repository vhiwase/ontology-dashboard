/**
 * Charts, hand-built in SVG.
 *
 * No chart library: the forms needed here are few, and owning the SVG is what
 * makes the mark specs enforceable - 2px surface gaps between bars, 4px rounded
 * data-ends anchored to the baseline, selective direct labels, recessive grid.
 *
 * Colour follows the validated categorical order from theme.css. Almost every
 * chart here is single-series (one KPI, sliced one way), so slot 1 does most of
 * the work and identity comes from the axis label, not from hue. Where a form
 * genuinely needs several hues at once - the donut - the series count is capped
 * at three plus "Other", because the all-pairs CVD gate only clears for the
 * first three slots.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatValue, round, shortLabel } from "../api";

export type ChartKind = "bar" | "hbar" | "line" | "area" | "donut";

export interface Point {
	label: string;
	value: number | null;
}

interface ChartProps {
	kind: ChartKind;
	points: Point[];
	format: string;
	unit?: string | null;
	/** Drawn as a dashed reference line on bar and line forms. */
	target?: number | null;
	height?: number;
	/** Axis title for the value axis. */
	valueLabel?: string;
}

const SERIES = [
	"var(--series-1)",
	"var(--series-2)",
	"var(--series-3)",
	"var(--series-4)",
	"var(--series-5)",
	"var(--series-6)",
	"var(--series-7)",
	"var(--series-8)",
];

// Donuts and other all-pairs forms only clear the CVD gate for three hues, so the
// tail folds into a neutral "Other" slice rather than cycling into a fourth hue.
const DONUT_MAX_SLICES = 3;

interface TooltipState {
	x: number;
	y: number;
	label: string;
	value: string;
}

/**
 * Measure the container so charts can be drawn at true pixel scale.
 *
 * The alternative - a fixed 1000-unit viewBox with width:100% - looks fine until
 * you read it: the browser scales the whole drawing to fit, so a 10px axis label
 * in a 640px-wide card renders at 6.4px, and preserveAspectRatio="none"
 * additionally stretches the glyphs. Measuring means one SVG unit is one pixel and
 * text is the size it claims to be.
 */
function useMeasuredWidth(fallback = 640): [React.RefObject<HTMLDivElement>, number] {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(fallback);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => {
			const next = element.getBoundingClientRect().width;
			if (next > 0) setWidth(next);
		};
		update();
		// ResizeObserver is absent in older browsers and some test runners; the
		// measured-once fallback above still renders a correct chart.
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return [ref, width];
}

function useTooltip() {
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	const show = useCallback((event: React.MouseEvent, label: string, value: string) => {
		setTooltip({ x: event.clientX, y: event.clientY, label, value });
	}, []);
	const hide = useCallback(() => setTooltip(null), []);
	return { tooltip, show, hide };
}

function Tooltip({ state }: { state: TooltipState | null }) {
	if (!state) return null;
	// Offset up and right of the cursor, and clamped so it never leaves the
	// viewport on a tile at the right edge of a dashboard.
	const left = Math.min(state.x + 12, window.innerWidth - 240);
	const top = Math.max(state.y - 46, 8);
	return (
		<div className="tooltip" style={{ left, top }} role="tooltip">
			<div className="t-label">{state.label}</div>
			<div className="t-value">{state.value}</div>
		</div>
	);
}

export function Chart(props: ChartProps) {
	const points = useMemo(
		() => props.points.filter((p) => p.value !== null && Number.isFinite(p.value)),
		[props.points],
	);

	if (points.length === 0) {
		return (
			<div className="empty" style={{ padding: "26px 16px", fontSize: 12 }}>
				No data for this metric yet.
			</div>
		);
	}

	return <MeasuredChart {...props} points={points} />;
}

function MeasuredChart(props: ChartProps & { points: Point[] }) {
	const [ref, width] = useMeasuredWidth();
	// Below this the label gutter leaves no room for bars, so the card scrolls.
	const plotWidth = Math.max(width, 320);

	return (
		<div ref={ref} style={{ width: "100%", overflowX: width < 320 ? "auto" : "visible" }}>
			{props.kind === "hbar" ? (
				<HorizontalBars {...props} width={plotWidth} />
			) : props.kind === "donut" ? (
				<Donut {...props} />
			) : props.kind === "line" || props.kind === "area" ? (
				<LineChart {...props} width={plotWidth} />
			) : (
				<VerticalBars {...props} width={plotWidth} />
			)}
		</div>
	);
}

/**
 * Ranked categories. The default for anything with names - lanes, carriers,
 * facilities - because a vertical bar chart cannot show "Corbintown, Iowa ->
 * Travonstad, New Jersey" without rotating the label to unreadable.
 */
function HorizontalBars({
	points,
	format,
	unit,
	target,
	width,
}: ChartProps & { points: Point[]; width: number }) {
	const { tooltip, show, hide } = useTooltip();
	const rowHeight = 26;
	const gap = 2;
	// The label gutter scales with the card, so a narrow tile gives less to labels
	// and more to bars rather than squeezing the bars to nothing.
	const labelWidth = Math.round(Math.min(Math.max(width * 0.26, 90), 210));
	const valueWidth = 82;
	const height = points.length * rowHeight;

	const values = points.map((p) => p.value as number);
	const max = Math.max(...values, target ?? 0, 0);
	const min = Math.min(...values, 0);
	// A negative value (a loss-making margin) needs the axis to start below zero,
	// with the zero line drawn where it belongs rather than at the left edge.
	const span = max - min || 1;
	const plotWidth = Math.max(width - labelWidth - valueWidth, 40);
	const zeroX = labelWidth + ((0 - min) / span) * plotWidth;

	return (
		<>
			<svg
				className="chart-svg"
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				role="img"
			>
				{target !== null && target !== undefined && target >= min && target <= max && (
					<line
						x1={labelWidth + ((target - min) / span) * plotWidth}
						x2={labelWidth + ((target - min) / span) * plotWidth}
						y1={0}
						y2={height}
						stroke="var(--ink-muted)"
						strokeWidth={1}
						strokeDasharray="3 3"
					/>
				)}
				{min < 0 && (
					<line x1={zeroX} x2={zeroX} y1={0} y2={height} className="chart-base" />
				)}

				{points.map((point, index) => {
					const value = point.value as number;
					const y = index * rowHeight;
					const barLength = (Math.abs(value) / span) * plotWidth;
					const x = value >= 0 ? zeroX : zeroX - barLength;
					return (
						<g key={`${point.label}-${index}`}>
							<text
								x={labelWidth - 10}
								y={y + rowHeight / 2 + 4}
								textAnchor="end"
								className="chart-label"
							>
								{shortLabel(point.label, Math.max(8, Math.floor(labelWidth / 6.2)))}
							</text>
							<rect
								className="chart-mark"
								x={x}
								y={y + gap}
								width={Math.max(barLength, 2)}
								height={rowHeight - gap * 2}
								rx={4}
								fill={SERIES[0]}
								onMouseMove={(event) =>
									show(event, point.label, formatValue(value, format, unit))
								}
								onMouseLeave={hide}
							>
								<title>{`${point.label}: ${formatValue(value, format, unit)}`}</title>
							</rect>
							{/* Direct value labels, not a value axis: this is the relief the
							    light-mode contrast warning requires, and it reads faster. */}
							<text
								x={Math.max(x + barLength, zeroX) + 8}
								y={y + rowHeight / 2 + 4}
								className="chart-value"
							>
								{formatValue(value, format, unit)}
							</text>
						</g>
					);
				})}
			</svg>
			<Tooltip state={tooltip} />
		</>
	);
}

/** Vertical bars, for a small number of short-labelled categories. */
function VerticalBars({
	points,
	format,
	unit,
	target,
	height = 210,
	width,
}: ChartProps & { points: Point[]; width: number }) {
	const { tooltip, show, hide } = useTooltip();
	const padding = { top: 16, right: 12, bottom: 34, left: 56 };
	const plotWidth = width - padding.left - padding.right;
	const plotHeight = height - padding.top - padding.bottom;

	const values = points.map((p) => p.value as number);
	const max = Math.max(...values, target ?? 0, 0);
	const min = Math.min(...values, 0);
	const span = max - min || 1;
	const scaleY = (value: number) => padding.top + plotHeight - ((value - min) / span) * plotHeight;

	const slot = plotWidth / points.length;
	const barWidth = Math.max(Math.min(slot - 4, 58), 3);
	const ticks = niceTicks(min, max, 4);

	return (
		<>
			<svg className="chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
				{ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={padding.left}
							x2={width - padding.right}
							y1={scaleY(tick)}
							y2={scaleY(tick)}
							className="chart-grid"
						/>
						<text x={padding.left - 8} y={scaleY(tick) + 4} textAnchor="end" className="chart-axis">
							{formatValue(tick, format, null)}
						</text>
					</g>
				))}
				{target !== null && target !== undefined && (
					<line
						x1={padding.left}
						x2={width - padding.right}
						y1={scaleY(target)}
						y2={scaleY(target)}
						stroke="var(--ink-muted)"
						strokeWidth={1}
						strokeDasharray="3 3"
					/>
				)}

				{points.map((point, index) => {
					const value = point.value as number;
					const x = padding.left + index * slot + (slot - barWidth) / 2;
					const y = value >= 0 ? scaleY(value) : scaleY(0);
					const barHeight = Math.abs(scaleY(value) - scaleY(0));
					return (
						<g key={`${point.label}-${index}`}>
							<rect
								className="chart-mark"
								x={x}
								y={y}
								width={barWidth}
								height={Math.max(barHeight, 2)}
								rx={4}
								fill={SERIES[0]}
								onMouseMove={(event) =>
									show(event, point.label, formatValue(value, format, unit))
								}
								onMouseLeave={hide}
							>
								<title>{`${point.label}: ${formatValue(value, format, unit)}`}</title>
							</rect>
							{/* Labels only when they will not collide. */}
							{points.length <= 12 && (
								<text
									x={x + barWidth / 2}
									y={height - padding.bottom + 15}
									textAnchor="middle"
									className="chart-axis"
								>
									{shortLabel(point.label, Math.max(6, Math.floor(slot / 7)))}
								</text>
							)}
						</g>
					);
				})}
				<line
					x1={padding.left}
					x2={width - padding.right}
					y1={scaleY(0)}
					y2={scaleY(0)}
					className="chart-base"
				/>
			</svg>
			<Tooltip state={tooltip} />
		</>
	);
}

/** A measure over time. Crosshair plus tooltip on hover, as the default. */
function LineChart({
	points,
	format,
	unit,
	target,
	kind,
	height = 210,
	width,
}: ChartProps & { points: Point[]; width: number }) {
	const gradientId = useId().replace(/:/g, "");
	const svgRef = useRef<SVGSVGElement>(null);
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	const { tooltip, show, hide } = useTooltip();

	const padding = { top: 16, right: 16, bottom: 30, left: 60 };
	const plotWidth = width - padding.left - padding.right;
	const plotHeight = height - padding.top - padding.bottom;

	const values = points.map((p) => p.value as number);
	const max = Math.max(...values, target ?? Number.NEGATIVE_INFINITY);
	const min = Math.min(...values, 0);
	const span = max - min || 1;

	const scaleX = (index: number) =>
		points.length === 1
			? padding.left + plotWidth / 2
			: padding.left + (index / (points.length - 1)) * plotWidth;
	const scaleY = (value: number) => padding.top + plotHeight - ((value - min) / span) * plotHeight;

	const path = points
		.map((point, index) => `${index === 0 ? "M" : "L"}${scaleX(index)},${scaleY(point.value as number)}`)
		.join(" ");
	const areaPath =
		kind === "area"
			? `${path} L${scaleX(points.length - 1)},${scaleY(min)} L${scaleX(0)},${scaleY(min)} Z`
			: null;

	const ticks = niceTicks(min, max, 4);
	// Thin the x labels so they never overlap, whatever the series length.
	const labelStep = Math.max(
		1,
		Math.ceil(points.length / Math.max(2, Math.floor(plotWidth / 86))),
	);

	const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
		const svg = svgRef.current;
		if (!svg) return;
		const bounds = svg.getBoundingClientRect();
		const relative = ((event.clientX - bounds.left) / bounds.width) * width;
		const ratio = (relative - padding.left) / plotWidth;
		const index = Math.round(ratio * (points.length - 1));
		const clamped = Math.max(0, Math.min(points.length - 1, index));
		setHoverIndex(clamped);
		const point = points[clamped];
		if (point) show(event, point.label, formatValue(point.value, format, unit));
	};

	return (
		<>
			<svg
				ref={svgRef}
				className="chart-svg"
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				onMouseMove={onMove}
				onMouseLeave={() => {
					setHoverIndex(null);
					hide();
				}}
			>
				<defs>
					<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.28" />
						<stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.02" />
					</linearGradient>
				</defs>

				{ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={padding.left}
							x2={width - padding.right}
							y1={scaleY(tick)}
							y2={scaleY(tick)}
							className="chart-grid"
						/>
						<text x={padding.left - 8} y={scaleY(tick) + 4} textAnchor="end" className="chart-axis">
							{formatValue(tick, format, null)}
						</text>
					</g>
				))}
				{target !== null && target !== undefined && target >= min && target <= max && (
					<line
						x1={padding.left}
						x2={width - padding.right}
						y1={scaleY(target)}
						y2={scaleY(target)}
						stroke="var(--ink-muted)"
						strokeWidth={1}
						strokeDasharray="3 3"
					/>
				)}

				{areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
				<path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />

				{hoverIndex !== null && points[hoverIndex] && (
					<>
						<line
							x1={scaleX(hoverIndex)}
							x2={scaleX(hoverIndex)}
							y1={padding.top}
							y2={padding.top + plotHeight}
							stroke="var(--ink-muted)"
							strokeWidth={1}
						/>
						<circle
							cx={scaleX(hoverIndex)}
							cy={scaleY(points[hoverIndex]!.value as number)}
							r={5}
							fill="var(--series-1)"
							stroke="var(--surface-1)"
							strokeWidth={2}
						/>
					</>
				)}

				{/* A single point has no line to read, so it gets a visible marker. */}
				{points.length === 1 && points[0] && (
					<circle
						cx={scaleX(0)}
						cy={scaleY(points[0].value as number)}
						r={5}
						fill="var(--series-1)"
						stroke="var(--surface-1)"
						strokeWidth={2}
					/>
				)}

				{points.map((point, index) =>
					index % labelStep === 0 ? (
						<text
							key={`${point.label}-${index}`}
							x={scaleX(index)}
							y={height - padding.bottom + 15}
							textAnchor="middle"
							className="chart-axis"
						>
							{shortLabel(point.label, 12)}
						</text>
					) : null,
				)}

				<line
					x1={padding.left}
					x2={width - padding.right}
					y1={padding.top + plotHeight}
					y2={padding.top + plotHeight}
					className="chart-base"
				/>
			</svg>
			<Tooltip state={tooltip} />
		</>
	);
}

/**
 * Shares of a whole. Capped at three hues plus a neutral "Other", because the
 * all-pairs CVD gate only clears for the first three categorical slots - a
 * six-slice donut would put indistinguishable hues side by side.
 */
function Donut({ points, format, unit, height = 210 }: ChartProps & { points: Point[] }) {
	const { tooltip, show, hide } = useTooltip();

	const sorted = [...points].sort((a, b) => (b.value as number) - (a.value as number));
	const head = sorted.slice(0, DONUT_MAX_SLICES);
	const tail = sorted.slice(DONUT_MAX_SLICES);
	const slices =
		tail.length > 0
			? [
					...head,
					{
						label: `Other (${tail.length})`,
						value: tail.reduce((sum, point) => sum + (point.value as number), 0),
					},
				]
			: head;

	const total = slices.reduce((sum, slice) => sum + (slice.value as number), 0);
	if (total <= 0) {
		return (
			<div className="empty" style={{ padding: "26px 16px", fontSize: 12 }}>
				Every value is zero, so there are no shares to show.
			</div>
		);
	}

	const size = height;
	const radius = size / 2 - 4;
	const inner = radius * 0.58;
	const center = size / 2;

	let angle = -Math.PI / 2;
	const arcs = slices.map((slice, index) => {
		const fraction = (slice.value as number) / total;
		const start = angle;
		const end = angle + fraction * Math.PI * 2;
		angle = end;
		return {
			...slice,
			fraction,
			path: annularSector(center, center, inner, radius, start, end),
			// "Other" is neutral, never a series hue: it is not an entity.
			color: index < DONUT_MAX_SLICES ? SERIES[index] : "var(--ink-muted)",
		};
	});

	return (
		<>
			<div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
				<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" style={{ flex: "0 0 auto" }}>
					{arcs.map((arc) => (
						<path
							key={arc.label}
							className="chart-mark"
							d={arc.path}
							fill={arc.color}
							// 2px surface-coloured ring so adjacent fills never touch.
							stroke="var(--surface-1)"
							strokeWidth={2}
							onMouseMove={(event) =>
								show(
									event,
									arc.label,
									`${formatValue(arc.value, format, unit)} · ${round(arc.fraction * 100, 1)}%`,
								)
							}
							onMouseLeave={hide}
						>
							<title>{`${arc.label}: ${formatValue(arc.value, format, unit)}`}</title>
						</path>
					))}
					<text
						x={center}
						y={center - 3}
						textAnchor="middle"
						style={{ fontSize: 17, fontWeight: 600, fill: "var(--ink-primary)" }}
					>
						{formatValue(total, format === "percent" ? "number" : format, null)}
					</text>
					<text x={center} y={center + 14} textAnchor="middle" className="chart-axis">
						total
					</text>
				</svg>

				{/* Legend is always present for more than one slice: identity is never
				    carried by colour alone. */}
				<div className="legend" style={{ flexDirection: "column", margin: 0, gap: 5 }}>
					{arcs.map((arc) => (
						<span className="legend-item" key={arc.label}>
							<span className="legend-swatch" style={{ background: arc.color }} />
							<span>{shortLabel(arc.label, 26)}</span>
							<span className="muted num">{round(arc.fraction * 100, 1)}%</span>
						</span>
					))}
				</div>
			</div>
			<Tooltip state={tooltip} />
		</>
	);
}

function annularSector(
	cx: number,
	cy: number,
	innerRadius: number,
	outerRadius: number,
	start: number,
	end: number,
): string {
	// A full circle cannot be drawn as a single arc (start and end coincide), so
	// it is split into two halves.
	if (end - start >= Math.PI * 2 - 1e-6) {
		const mid = start + Math.PI;
		return `${annularSector(cx, cy, innerRadius, outerRadius, start, mid)} ${annularSector(
			cx,
			cy,
			innerRadius,
			outerRadius,
			mid,
			end,
		)}`;
	}
	const largeArc = end - start > Math.PI ? 1 : 0;
	const x1 = cx + outerRadius * Math.cos(start);
	const y1 = cy + outerRadius * Math.sin(start);
	const x2 = cx + outerRadius * Math.cos(end);
	const y2 = cy + outerRadius * Math.sin(end);
	const x3 = cx + innerRadius * Math.cos(end);
	const y3 = cy + innerRadius * Math.sin(end);
	const x4 = cx + innerRadius * Math.cos(start);
	const y4 = cy + innerRadius * Math.sin(start);
	return [
		`M${x1},${y1}`,
		`A${outerRadius},${outerRadius} 0 ${largeArc} 1 ${x2},${y2}`,
		`L${x3},${y3}`,
		`A${innerRadius},${innerRadius} 0 ${largeArc} 0 ${x4},${y4}`,
		"Z",
	].join(" ");
}

/** Axis ticks on round numbers, including zero when the range spans it. */
function niceTicks(min: number, max: number, count: number): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
		return [min || 0];
	}
	const rawStep = (max - min) / count;
	const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
	const normalised = rawStep / magnitude;
	const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
	const ticks: number[] = [];
	for (let tick = Math.ceil(min / step) * step; tick <= max + step * 0.001; tick += step) {
		ticks.push(round(tick, 6));
	}
	return ticks.length ? ticks : [min, max];
}
