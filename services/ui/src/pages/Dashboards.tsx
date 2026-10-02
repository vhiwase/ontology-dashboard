/**
 * Dashboards and reports.
 *
 * A dashboard is a live grid; a report is the same widgets laid out as a
 * document - key figures, written highlights, then each chart with a caption -
 * that prints to PDF. Both are interactive in the same way: filters read from
 * the data (only values that exist are offered), clicking a bar or a slice
 * filters the whole board by it, and every widget downloads as CSV.
 *
 * The highlights in a report are written here from the numbers on the page,
 * not by a model: each sentence is arithmetic on a series the board already
 * fetched, so a report cannot say anything its charts do not show.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	type DashboardFilterOptions,
	type DashboardSummary,
	type KpiMeta,
	type KpiResult,
	type ResolvedDashboard,
	type WorkspaceSummary,
	api,
	downloadText,
	formatPeriod,
	formatValue,
	grainOf,
	session,
	toCsv,
} from "../api";
import { Chart, type ChartKind } from "../components/Chart";
import { CoverageBanner, DataTable, Empty, ErrorBanner, Markdown, Spinner, StatTile } from "../components/common";
import { ResourcePreview } from "../components/spaces/ResourcePreview";
import { useSpace } from "../SpaceContext";

type ResolvedWidget = ResolvedDashboard["widgets"][number];
type Filters = Record<string, string | { gte?: string; lte?: string }>;

// ── list ────────────────────────────────────────────────────────────────────

export function DashboardList() {
	const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
	const [kpis, setKpis] = useState<KpiMeta[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState<"all" | "dashboard" | "report">("all");
	const [creating, setCreating] = useState(false);
	const { spaceSlug, isPersonal } = useSpace();

	const load = () => {
		setError(null);
		setDashboards(null);
		// Dashboards are per-space and exist independently of the ontology, so
		// the list is what this page is FOR and must load on its own.
		api
			.get<DashboardSummary[]>(`/api/dashboards?space=${spaceSlug}`)
			.then(setDashboards)
			.catch((exc: Error) => setError(exc.message));
		// The metric catalogue is only needed to OFFER new charts; a space with no
		// published ontology genuinely has none, which is not an error here.
		api
			.get<KpiMeta[]>("/api/kpis")
			.then(setKpis)
			.catch(() => setKpis([]));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch per space
	useEffect(load, [spaceSlug]);

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!dashboards) return <Spinner label="Loading dashboards" />;

	const needle = query.trim().toLowerCase();
	const visible = dashboards.filter(
		(dashboard) =>
			(tab === "all" || (dashboard.kind ?? "dashboard") === tab) &&
			(!needle ||
				[dashboard.title, dashboard.description ?? "", dashboard.audience ?? "", dashboard.sourcePrompt ?? ""]
					.join(" ")
					.toLowerCase()
					.includes(needle)),
	);
	const reports = dashboards.filter((d) => d.kind === "report").length;

	const byCategory = new Map<string, KpiMeta[]>();
	for (const kpi of kpis) {
		const bucket = byCategory.get(kpi.category);
		if (bucket) bucket.push(kpi);
		else byCategory.set(kpi.category, [kpi]);
	}

	return (
		<div className="page">
			<header className="page-head">
				<div>
					<h1>Dashboards & reports</h1>
					<p className="page-lede">
						Every number on every board is one of your metrics, computed from your tables when you open it.
					</p>
				</div>
				<div className="row" style={{ gap: 8 }}>
					{!isPersonal && (
						<Link className="btn" to="/dashboards/history">
							History &amp; backup
						</Link>
					)}
					<button className="btn" onClick={() => setCreating(true)} disabled={kpis.length === 0}>
						New board
					</button>
					<Link className="btn primary" to={`/assistant?q=${encodeURIComponent("Build me a dashboard about ")}`}>
						Describe one to the assistant
					</Link>
				</div>
			</header>

			<div className="row" style={{ gap: 10 }}>
				<div className="tabs" role="tablist">
					{(
						[
							["all", `All ${dashboards.length}`],
							["dashboard", `Dashboards ${dashboards.length - reports}`],
							["report", `Reports ${reports}`],
						] as const
					).map(([id, label]) => (
						<button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
							{label}
						</button>
					))}
				</div>
				<input
					className="search-input"
					type="search"
					value={query}
					placeholder="Search boards…"
					onChange={(event) => setQuery(event.target.value)}
					aria-label="Search dashboards"
					style={{ marginLeft: "auto" }}
				/>
			</div>

			{visible.length === 0 ? (
				<div className="empty-state">
					<div className="empty-state-mark" aria-hidden>
						▦
					</div>
					<h3>{dashboards.length === 0 ? "No boards yet" : `Nothing matches “${query}”`}</h3>
					<p>
						Ask the assistant - “build me a sales dashboard”, “write a report on orders” - or start one from a
						type with <strong>New board</strong>.
					</p>
				</div>
			) : (
				<div className="board-grid">
					{visible.map((dashboard) => (
						<Link key={dashboard.slug} to={`/dashboards/${dashboard.slug}`} className="board-card">
							<div className="board-card-top">
								<span className={`board-kind ${dashboard.kind === "report" ? "report" : ""}`} aria-hidden>
									{dashboard.kind === "report" ? "▤" : "▦"}
								</span>
								<span className="chip">{dashboard.kind === "report" ? "Report" : "Dashboard"}</span>
								{dashboard.isAiGenerated && <span className="chip">✦ AI built</span>}
								{dashboard.isPinned && <span className="chip">pinned</span>}
							</div>
							<h3>{dashboard.title}</h3>
							<p>{dashboard.description}</p>
							<MiniLayout widgets={dashboard.layout} />
							<div className="board-card-foot muted">
								{dashboard.layout.length} widgets · updated {new Date(dashboard.updatedAt).toLocaleDateString()}
							</div>
						</Link>
					))}
				</div>
			)}

			<section className="panel" id="metrics">
				<header className="panel-head">
					<h2>Metrics</h2>
					<span className="muted">{kpis.length} defined · the only numbers a board can show</span>
				</header>
				{kpis.length === 0 ? (
					<p className="muted" style={{ margin: 0 }}>
						No metrics yet. They are created when tables are imported, and when you approve a new one.
					</p>
				) : (
					[...byCategory.entries()].map(([category, categoryKpis]) => (
						<div key={category} style={{ marginBottom: 14 }}>
							<div className="rail-section" style={{ padding: "0 0 5px" }}>
								{category}
							</div>
							<DataTable
								columns={[
									{ key: "label", label: "Metric" },
									{ key: "businessQuestion", label: "Answers" },
									{ key: "aggregation", label: "Computed as" },
									{ key: "dimensionList", label: "Can be sliced by" },
								]}
								rows={categoryKpis.map((kpi) => ({
									...kpi,
									dimensionList: sliceList(kpi.dimensions),
								}))}
							/>
						</div>
					))
				)}
			</section>

			{creating && <NewBoardDialog onClose={() => setCreating(false)} />}
		</div>
	);
}

/** "order_date:day", "order_date:month"... read as one entry: "order date (over time)". */
function sliceList(dimensions: string[]): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dimension of dimensions) {
		const [column = "", grain] = dimension.split(":");
		const label = `${column.replace(/_/g, " ")}${grain ? " (over time)" : ""}`;
		if (!seen.has(label)) {
			seen.add(label);
			out.push(label);
		}
	}
	return out.join(", ") || "—";
}

/** A thumbnail of a board's grid, from its layout alone. */
function MiniLayout({ widgets }: { widgets: DashboardSummary["layout"] }) {
	return (
		<div className="mini-layout" aria-hidden>
			{widgets.slice(0, 12).map((widget, index) => (
				<span
					key={index}
					className={`mini-cell mini-${widget.type}`}
					style={{ gridColumn: `span ${Math.min(Math.max(widget.width ?? 2, 1), 4)}` }}
				/>
			))}
		</div>
	);
}

function NewBoardDialog({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
	const [kind, setKind] = useState<"dashboard" | "report">("dashboard");
	const [objectType, setObjectType] = useState("");
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api
			.get<WorkspaceSummary>("/api/workspace/summary")
			.then((body) => {
				setSummary(body);
				setObjectType(body.objectTypes[0]?.apiName ?? "");
			})
			.catch((exc: Error) => setError(exc.message));
	}, []);

	async function create() {
		setBusy(true);
		setError(null);
		try {
			const board = await api.post<{ slug: string }>("/api/workspace/auto-dashboard", {
				kind,
				objectType,
				...(title.trim() ? { title: title.trim() } : {}),
			});
			onClose();
			navigate(`/dashboards/${board.slug}`);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div className="modal" role="dialog" aria-label="New board" style={{ maxWidth: 520 }}>
				<header className="modal-head">
					<h2>New board</h2>
					<button className="btn sm ghost" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				<div className="modal-body">
					<div className="segmented" role="radiogroup">
						<button className={kind === "dashboard" ? "active" : ""} onClick={() => setKind("dashboard")}>
							▦ Dashboard
						</button>
						<button className={kind === "report" ? "active" : ""} onClick={() => setKind("report")}>
							▤ Report
						</button>
					</div>
					<label className="field">
						<span>About</span>
						<select value={objectType} onChange={(event) => setObjectType(event.target.value)}>
							{summary?.objectTypes.map((type) => (
								<option key={type.apiName} value={type.apiName}>
									{type.pluralLabel ?? type.label} ({type.rowCount.toLocaleString("en-US")})
								</option>
							))}
						</select>
					</label>
					<label className="field">
						<span>Title (optional)</span>
						<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Monthly sales review" />
					</label>
					<p className="muted" style={{ fontSize: 12 }}>
						Laid out from the metrics that type already has: headline figures, its timeline and its main
						breakdowns. For something specific - “revenue by category per quarter” - ask the assistant instead.
					</p>
					{error && <div className="banner error">{error}</div>}
					<footer className="modal-foot">
						<button className="btn" onClick={onClose}>
							Cancel
						</button>
						<button className="btn primary" disabled={busy || !objectType} onClick={() => void create()}>
							{busy ? "Building…" : `Create ${kind}`}
						</button>
					</footer>
				</div>
			</div>
		</div>
	);
}

// ── one board ───────────────────────────────────────────────────────────────

export function DashboardDetail() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const { spaceSlug, space, isPersonal } = useSpace();
	const [dashboard, setDashboard] = useState<ResolvedDashboard | null>(null);
	const [options, setOptions] = useState<DashboardFilterOptions | null>(null);
	const [filters, setFilters] = useState<Filters>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lineageId, setLineageId] = useState<number | null>(null);
	const [view, setView] = useState<"board" | "report" | null>(null);
	const [copied, setCopied] = useState(false);

	// A new board starts unfiltered.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset per board
	useEffect(() => {
		setFilters({});
		setDashboard(null);
		setView(null);
	}, [slug, spaceSlug]);

	useEffect(() => {
		if (!slug) return;
		setLoading(true);
		setError(null);
		const encoded = Object.keys(filters).length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : "";
		api
			.get<ResolvedDashboard>(`/api/dashboards/${slug}?space=${spaceSlug}${encoded}`)
			.then(setDashboard)
			.catch((exc: Error) => setError(exc.message))
			.finally(() => setLoading(false));
	}, [slug, spaceSlug, filters]);

	useEffect(() => {
		if (!slug) return;
		api
			.get<DashboardFilterOptions>(`/api/dashboards/${slug}/filters?space=${spaceSlug}`)
			.then(setOptions)
			.catch(() => setOptions(null));
	}, [slug, spaceSlug]);

	/** Click-to-filter: the same value again clears it. */
	const toggleFilter = useCallback((key: string, value: string) => {
		setFilters((current) => {
			const next = { ...current };
			if (next[key] === value) delete next[key];
			else next[key] = value;
			return next;
		});
	}, []);

	async function showLineage(boardSlug: string) {
		try {
			const found = await api.get<{ id: number } | null>(
				`/api/resources/lookup?kind=dashboard&ref=${encodeURIComponent(boardSlug)}&space=${spaceSlug}`,
			);
			if (found?.id) setLineageId(found.id);
			else setError("This board is not registered as a workspace resource, so it has no lineage page.");
		} catch {
			setError("Could not load the lineage.");
		}
	}

	if (error && !dashboard) return <ErrorBanner error={error} />;
	if (!dashboard) return <Spinner label="Running the board's metrics" />;

	const mode = view ?? (dashboard.kind === "report" ? "report" : "board");
	const user = session.user();
	const canDelete = dashboard.isAiGenerated || isPersonal || user?.role === "admin";

	const remove = async () => {
		if (!window.confirm(`Delete "${dashboard.title}"? This cannot be undone.`)) return;
		try {
			await api.del(`/api/dashboards/${dashboard.slug}?space=${spaceSlug}`);
			navigate("/dashboards");
		} catch (exc) {
			setError((exc as Error).message);
		}
	};

	const exportAll = () => {
		const rows: Array<Array<unknown>> = [];
		for (const widget of dashboard.widgets) {
			const data = widget.data;
			if (!data) continue;
			if (data.series.length === 0) rows.push([widget.title ?? data.label, "", "total", data.total]);
			for (const point of data.series) rows.push([widget.title ?? data.label, data.dimensionLabel ?? "", point.label, point.value]);
		}
		downloadText(`${dashboard.slug}.csv`, toCsv(["widget", "dimension", "label", "value"], rows));
	};

	return (
		<div className={`page board-page ${mode === "report" ? "is-report" : ""}`}>
			<header className="board-head no-print">
				<div className="board-head-text">
					<div className="row" style={{ gap: 6 }}>
						<Link to="/dashboards" className="muted crumb">
							Dashboards & reports
						</Link>
						<span className="muted">/</span>
						<span className="chip">{dashboard.kind === "report" ? "Report" : "Dashboard"}</span>
						{dashboard.isAiGenerated && <span className="chip">✦ AI built</span>}
						{loading && <span className="spinner" aria-label="Updating" />}
					</div>
					<h1>{dashboard.title}</h1>
					{dashboard.description && <p className="page-lede">{dashboard.description}</p>}
					{dashboard.sourcePrompt && (
						<p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
							Asked for as: “{dashboard.sourcePrompt}”
						</p>
					)}
				</div>
				<div className="board-actions">
					<div className="segmented" role="radiogroup" aria-label="Layout">
						<button className={mode === "board" ? "active" : ""} onClick={() => setView("board")}>
							▦ Board
						</button>
						<button className={mode === "report" ? "active" : ""} onClick={() => setView("report")}>
							▤ Report
						</button>
					</div>
					{mode === "report" && (
						<button className="btn primary" onClick={() => window.print()}>
							Print / save PDF
						</button>
					)}
					<button className="btn" onClick={exportAll} title="Every widget's numbers as one CSV">
						Export CSV
					</button>
					<button
						className="btn"
						onClick={() => {
							void navigator.clipboard?.writeText(window.location.href).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 1600);
							});
						}}
					>
						{copied ? "Link copied" : "Copy link"}
					</button>
					{!isPersonal && (
						<button className="btn" onClick={() => void showLineage(dashboard.slug)}>
							Lineage
						</button>
					)}
					{canDelete && (
						<button className="btn ghost danger" onClick={() => void remove()}>
							Delete
						</button>
					)}
				</div>
			</header>

			<FilterBar options={options} filters={filters} onChange={setFilters} />

			{error && <ErrorBanner error={error} />}
			<CoverageBanner notes={dashboard.coverageNotes} />

			{mode === "report" ? (
				<ReportDocument dashboard={dashboard} spaceName={space?.name ?? ""} filters={filters} />
			) : (
				<div className="grid grid-4 board-grid-live">
					{dashboard.widgets.map((widget) => (
						<div key={widget.index} className={`w${Math.min(Math.max(widget.width ?? 2, 1), 4)}`}>
							<WidgetCard widget={widget} filters={filters} onFilter={toggleFilter} />
						</div>
					))}
				</div>
			)}

			<ResourcePreview resourceId={lineageId} onClose={() => setLineageId(null)} />
		</div>
	);
}

// ── filters ─────────────────────────────────────────────────────────────────

function FilterBar({
	options,
	filters,
	onChange,
}: {
	options: DashboardFilterOptions | null;
	filters: Filters;
	onChange: (filters: Filters) => void;
}) {
	const [more, setMore] = useState(false);
	const time = options?.time[0];

	/** Presets measured from where the data ends, not from today. */
	const presets = useMemo(() => {
		if (!time?.max) return [];
		const end = new Date(`${time.max}T00:00:00Z`);
		const iso = (date: Date) => date.toISOString().slice(0, 10);
		const back = (months: number) => {
			const start = new Date(end);
			start.setUTCMonth(start.getUTCMonth() - months);
			return iso(start);
		};
		const year = end.getUTCFullYear();
		return [
			{ label: "Last 3 months", gte: back(3), lte: time.max },
			{ label: "Last 12 months", gte: back(12), lte: time.max },
			{ label: `${year}`, gte: `${year}-01-01`, lte: `${year}-12-31` },
			{ label: `${year - 1}`, gte: `${year - 1}-01-01`, lte: `${year - 1}-12-31` },
		];
	}, [time?.max]);

	if (!options || (options.dimensions.length === 0 && options.time.length === 0)) return null;
	const range = time ? (filters[time.column] as { gte?: string; lte?: string } | undefined) : undefined;
	const shown = more ? options.dimensions : options.dimensions.slice(0, 3);
	const active = Object.entries(filters);
	const setRange = (gte?: string, lte?: string) => {
		if (!time) return;
		const next = { ...filters };
		if (!gte && !lte) delete next[time.column];
		else next[time.column] = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
		onChange(next);
	};


	return (
		<div className="filter-bar no-print">
			<span className="filter-label">Filter</span>
			{time && (
				<div className="filter-time">
					<select
						aria-label={`${time.label} range`}
						value={
							presets.find((preset) => preset.gte === range?.gte && preset.lte === range?.lte)?.label ??
							(range ? "custom" : "")
						}
						onChange={(event) => {
							const preset = presets.find((item) => item.label === event.target.value);
							if (preset) setRange(preset.gte, preset.lte);
							else if (event.target.value === "") setRange();
						}}
					>
						<option value="">All {time.label.toLowerCase()}s</option>
						{presets.map((preset) => (
							<option key={preset.label} value={preset.label}>
								{preset.label}
							</option>
						))}
						{range && !presets.some((p) => p.gte === range.gte && p.lte === range.lte) && (
							<option value="custom">Custom</option>
						)}
					</select>
					<input
						type="date"
						aria-label="From"
						min={time.min ?? undefined}
						max={time.max ?? undefined}
						value={range?.gte ?? ""}
						onChange={(event) => setRange(event.target.value || undefined, range?.lte)}
					/>
					<span className="muted">to</span>
					<input
						type="date"
						aria-label="To"
						min={time.min ?? undefined}
						max={time.max ?? undefined}
						value={range?.lte ?? ""}
						onChange={(event) => setRange(range?.gte, event.target.value || undefined)}
					/>
				</div>
			)}
			{shown.map((dimension) => (
				<select
					key={dimension.key}
					className={filters[dimension.key] ? "on" : ""}
					aria-label={dimension.label}
					value={typeof filters[dimension.key] === "string" ? (filters[dimension.key] as string) : ""}
					onChange={(event) => {
						const next = { ...filters };
						if (event.target.value) next[dimension.key] = event.target.value;
						else delete next[dimension.key];
						onChange(next);
					}}
				>
					<option value="">All {dimension.label.toLowerCase()}</option>
					{dimension.values.map((value) => (
						<option key={value.value} value={value.value}>
							{value.value} ({value.count.toLocaleString("en-US")})
						</option>
					))}
				</select>
			))}
			{options.dimensions.length > 3 && (
				<button className="btn sm ghost" onClick={() => setMore((value) => !value)}>
					{more ? "Fewer" : `+${options.dimensions.length - 3} more`}
				</button>
			)}
			{active.length > 0 && (
				<div className="filter-chips">
					{active.map(([key, value]) => (
						<button
							key={key}
							className="filter-chip"
							onClick={() => {
								const next = { ...filters };
								delete next[key];
								onChange(next);
							}}
							title="Remove this filter"
						>
							{key.replace(/_/g, " ")}:{" "}
							{typeof value === "string" ? value : `${value.gte ?? "…"} – ${value.lte ?? "…"}`} ✕
						</button>
					))}
					<button className="btn sm ghost" onClick={() => onChange({})}>
						Clear all
					</button>
				</div>
			)}
		</div>
	);
}

// ── widgets ─────────────────────────────────────────────────────────────────

function isAdditive(data: KpiResult): boolean {
	return !data.aggregation || data.aggregation === "sum" || data.aggregation === "count";
}

function labelFormatter(data: KpiResult): (label: string) => string {
	const grain = data.dimensionGrain ?? grainOf(data.dimension);
	return grain ? (label: string) => formatPeriod(label, grain) : (label: string) => label;
}

function downloadWidget(widget: ResolvedWidget) {
	const data = widget.data;
	if (!data) return;
	const format = labelFormatter(data);
	const rows =
		data.series.length > 0
			? data.series.map((point) => [format(point.label), point.value])
			: [["total", data.total]];
	downloadText(
		`${(widget.title ?? data.label).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`,
		toCsv([data.dimensionLabel ?? "label", data.label], rows),
	);
}

function WidgetCard({
	widget,
	filters,
	onFilter,
}: {
	widget: ResolvedWidget;
	filters: Filters;
	onFilter: (key: string, value: string) => void;
}) {
	const [showSql, setShowSql] = useState(false);

	if (widget.type === "note") {
		return (
			<div className="card widget note">
				{widget.title && (
					<div className="card-head">
						<h3>{widget.title}</h3>
					</div>
				)}
				<div className="secondary" style={{ fontSize: 13 }}>
					<Markdown text={widget.body ?? ""} />
				</div>
			</div>
		);
	}
	if (widget.error) {
		return (
			<div className="card widget">
				<div className="card-head">
					<h3>{widget.title ?? widget.kpi}</h3>
				</div>
				<div className="banner error" style={{ fontSize: 12 }}>
					This tile could not be computed: {widget.error}
				</div>
			</div>
		);
	}
	const data = widget.data;
	if (!data) {
		return (
			<div className="card widget">
				<Spinner />
			</div>
		);
	}
	if (widget.type === "stat") return <StatTile result={data} title={widget.title} />;

	const dimension = data.dimension ?? widget.dimension ?? null;
	const temporal = Boolean(data.dimensionGrain ?? grainOf(dimension));
	// Categories filter the board when clicked; periods do not (the range
	// control above is the way to narrow time).
	const filterKey = dimension && !temporal ? dimension : null;
	const selected = filterKey && typeof filters[filterKey] === "string" ? (filters[filterKey] as string) : null;
	const format = labelFormatter(data);
	const additive = isAdditive(data);

	return (
		<div className="card widget">
			<div className="widget-head">
				<div>
					<h3>{widget.title ?? data.label}</h3>
					<span className="widget-sub">
						{data.total !== null && `${additive ? "Total" : "Overall"} ${formatValue(data.total, data.valueFormat, data.unit)}`}
						{data.partialPeriod &&
							` · ${format(data.partialPeriod)} is incomplete (data to ${formatPeriod(data.dataThrough ?? "", "day")})`}
					</span>
				</div>
				<div className="widget-tools no-print">
					<button className="icon-btn" title="Download CSV" onClick={() => downloadWidget(widget)}>
						⤓
					</button>
					<button className="icon-btn" title="How this is computed" onClick={() => setShowSql((value) => !value)}>
						{"</>"}
					</button>
				</div>
			</div>

			{widget.type === "table" ? (
				<RankedTable data={data} onSelect={filterKey ? (label) => onFilter(filterKey, label) : undefined} selected={selected} />
			) : (
				<Chart
					kind={(widget.chart ?? (temporal ? "line" : "hbar")) as ChartKind}
					points={data.series}
					format={data.valueFormat}
					unit={data.unit}
					target={data.target}
					height={widget.chart === "hbar" ? undefined : 220}
					onSelect={filterKey ? (label) => onFilter(filterKey, label) : undefined}
					selected={selected}
					formatLabel={format}
					partialLabel={data.partialPeriod ?? null}
					additive={additive}
				/>
			)}

			{filterKey && !selected && data.series.length > 1 && (
				<p className="widget-hint no-print">Click a {widget.type === "table" ? "row" : "bar"} to filter the board by it.</p>
			)}
			{widget.ignoredFilters && widget.ignoredFilters.length > 0 && (
				<p className="widget-hint">
					Not filtered by {widget.ignoredFilters.map((f) => f.replace(/_/g, " ")).join(", ")}: this metric has no such
					column.
				</p>
			)}
			{showSql && <pre className="sql-block">{data.sql}</pre>}
		</div>
	);
}

/** A ranking with an in-cell bar, so a table still reads at a glance. */
function RankedTable({
	data,
	onSelect,
	selected,
}: {
	data: KpiResult;
	onSelect?: (label: string) => void;
	selected: string | null;
}) {
	if (data.series.length === 0) return <Empty>No rows for this metric.</Empty>;
	const additive = isAdditive(data);
	const max = Math.max(...data.series.map((point) => Math.abs(point.value ?? 0)), 1);
	const format = labelFormatter(data);
	return (
		<div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
			<table className="data ranked">
				<thead>
					<tr>
						<th>#</th>
						<th>{data.dimensionLabel ?? "Group"}</th>
						<th style={{ textAlign: "right" }}>{data.label}</th>
						{additive && data.total ? <th style={{ textAlign: "right" }}>Share</th> : null}
					</tr>
				</thead>
				<tbody>
					{data.series.map((point, index) => (
						<tr
							key={point.label}
							className={`${onSelect ? "clickable" : ""} ${selected && selected !== point.label ? "dim" : ""}`}
							onClick={onSelect ? () => onSelect(point.label) : undefined}
						>
							<td className="muted num">{index + 1}</td>
							<td>
								<div className="cell-bar">
									<span className="cell-bar-fill" style={{ width: `${(Math.abs(point.value ?? 0) / max) * 100}%` }} />
									<span className="cell-bar-label">{format(point.label)}</span>
								</div>
							</td>
							<td className="n">{formatValue(point.value, data.valueFormat, data.unit)}</td>
							{additive && data.total ? (
								<td className="n muted">{(((point.value ?? 0) / data.total) * 100).toFixed(1)}%</td>
							) : null}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// ── the report layout ───────────────────────────────────────────────────────

/** One sentence about a widget, from its own numbers. */
export function highlight(widget: ResolvedWidget): string | null {
	const data = widget.data;
	if (!data) return null;
	const title = widget.title ?? data.label;
	const fmt = (value: number | null | undefined) => formatValue(value ?? null, data.valueFormat, data.unit);
	if (widget.type === "stat") {
		const trend = data.trend;
		if (trend?.deltaPct !== null && trend?.deltaPct !== undefined && trend.lastPeriod && trend.previousPeriod) {
			const direction = trend.deltaPct >= 0 ? "up" : "down";
			return `${title} stands at ${fmt(data.total)}; the latest complete ${trend.grain}, ${formatPeriod(trend.lastPeriod, trend.grain)}, was ${direction} ${Math.abs(trend.deltaPct).toFixed(1)}% on ${formatPeriod(trend.previousPeriod, trend.grain)}.`;
		}
		return `${title} stands at ${fmt(data.total)}.`;
	}
	const points = data.series.filter((point) => point.value !== null) as Array<{ label: string; value: number }>;
	if (points.length === 0) return null;
	const format = labelFormatter(data);
	const grain = data.dimensionGrain ?? grainOf(data.dimension);
	if (grain) {
		const complete = points.filter((point) => point.label !== data.partialPeriod);
		if (complete.length === 0) return null;
		const peak = complete.reduce((best, point) => (point.value > best.value ? point : best));
		const last = complete[complete.length - 1]!;
		const previous = complete[complete.length - 2];
		const change = previous && previous.value !== 0 ? ((last.value - previous.value) / Math.abs(previous.value)) * 100 : null;
		return (
			`${title}: the highest ${grain} was ${format(peak.label)} at ${fmt(peak.value)}. ` +
			`The latest complete ${grain}, ${format(last.label)}, came to ${fmt(last.value)}` +
			(change !== null ? ` (${change >= 0 ? "+" : ""}${change.toFixed(1)}% on ${format(previous!.label)}).` : ".") +
			(data.partialPeriod ? ` ${format(data.partialPeriod)} is still incomplete.` : "")
		);
	}
	const sorted = [...points].sort((a, b) => b.value - a.value);
	const top = sorted[0]!;
	if (isAdditive(data) && data.total) {
		const share = (top.value / data.total) * 100;
		const top3 = sorted.slice(0, 3).reduce((sum, point) => sum + point.value, 0);
		return (
			`${title}: ${format(top.label)} leads with ${fmt(top.value)} (${share.toFixed(0)}% of the total)` +
			(sorted.length > 3 ? `; the top three account for ${((top3 / data.total) * 100).toFixed(0)}%.` : ".")
		);
	}
	const bottom = sorted[sorted.length - 1]!;
	return `${title}: highest for ${format(top.label)} (${fmt(top.value)}), lowest for ${format(bottom.label)} (${fmt(bottom.value)}).`;
}

function ReportDocument({
	dashboard,
	spaceName,
	filters,
}: {
	dashboard: ResolvedDashboard;
	spaceName: string;
	filters: Filters;
}) {
	const stats = dashboard.widgets.filter((widget) => widget.type === "stat" && widget.data);
	const sections = dashboard.widgets.filter((widget) => widget.type !== "stat");
	const highlights = dashboard.widgets.map(highlight).filter((line): line is string => Boolean(line));
	const through = dashboard.widgets
		.map((widget) => widget.data?.dataThrough ?? widget.data?.trend?.dataThrough ?? null)
		.filter((value): value is string => Boolean(value))
		.sort()
		.pop();
	const activeFilters = Object.entries(filters);

	return (
		<article className="report-doc">
			<header className="report-cover">
				<p className="report-kicker">{spaceName}</p>
				<h1>{dashboard.title}</h1>
				{dashboard.description && <p className="report-sub">{dashboard.description}</p>}
				<p className="report-meta">
					Prepared {new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
					{through ? ` · data through ${formatPeriod(through, "day")}` : ""}
					{activeFilters.length > 0 &&
						` · filtered to ${activeFilters
							.map(([key, value]) => `${key.replace(/_/g, " ")} ${typeof value === "string" ? value : `${value.gte ?? ""}–${value.lte ?? ""}`}`)
							.join(", ")}`}
				</p>
			</header>

			{stats.length > 0 && (
				<section className="report-figures">
					{stats.map((widget) => (
						<div key={widget.index} className="report-figure">
							<span className="report-figure-value num">
								{formatValue(widget.data!.total, widget.data!.valueFormat, widget.data!.unit)}
							</span>
							<span className="report-figure-label">{widget.title ?? widget.data!.label}</span>
						</div>
					))}
				</section>
			)}

			{highlights.length > 0 && (
				<section className="report-section">
					<h2>Highlights</h2>
					<ul className="report-highlights">
						{highlights.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</section>
			)}

			{sections.map((widget, index) => (
				<ReportSection key={widget.index} widget={widget} n={index + 1} />
			))}

			<footer className="report-foot">
				Every figure in this report is computed from the tables in {spaceName || "this workspace"} at the time it was
				opened; nothing is estimated. Highlights are written from the numbers shown.
			</footer>
		</article>
	);
}

function ReportSection({ widget, n }: { widget: ResolvedWidget; n: number }): ReactNode {
	if (widget.type === "note") {
		return (
			<section className="report-section">
				{widget.title && <h2>{widget.title}</h2>}
				<Markdown text={widget.body ?? ""} />
			</section>
		);
	}
	const data = widget.data;
	if (!data) return null;
	const temporal = Boolean(data.dimensionGrain ?? grainOf(data.dimension));
	const sentence = highlight(widget);
	return (
		<section className="report-section">
			<h2>
				<span className="report-n">{n}</span> {widget.title ?? data.label}
			</h2>
			{widget.type === "table" ? (
				<RankedTable data={data} selected={null} />
			) : (
				<Chart
					kind={(widget.chart ?? (temporal ? "line" : "hbar")) as ChartKind}
					points={data.series}
					format={data.valueFormat}
					unit={data.unit}
					height={widget.chart === "hbar" ? undefined : 240}
					formatLabel={labelFormatter(data)}
					partialLabel={data.partialPeriod ?? null}
					additive={isAdditive(data)}
				/>
			)}
			{sentence && <p className="report-caption">{sentence}</p>}
		</section>
	);
}
