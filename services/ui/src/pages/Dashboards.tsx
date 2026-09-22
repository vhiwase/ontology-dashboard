/** Dashboards: the seeded boards plus anything the assistant built. */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { type DashboardSummary, type KpiMeta, type ResolvedDashboard, api, formatValue } from "../api";
import { Chart, type ChartKind } from "../components/Chart";
import { ResourcePreview } from "../components/spaces/ResourcePreview";
import { useSpace } from "../SpaceContext";
import {
	CoverageBanner,
	DataTable,
	Empty,
	ErrorBanner,
	Markdown,
	Spinner,
	StatTile,
} from "../components/common";

export function DashboardList() {
	const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
	const [kpis, setKpis] = useState<KpiMeta[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const { spaceSlug } = useSpace();

	const load = () => {
		setError(null);
		setDashboards(null);

		// Dashboards are per-space and exist independently of the ontology, so
		// the list is what this page is FOR and must load on its own.
		api
			.get<DashboardSummary[]>(`/api/dashboards?space=${spaceSlug}`)
			.then(setDashboards)
			.catch((exc: Error) => setError(exc.message));

		// The metric catalogue is only needed to OFFER new charts. A space with
		// no published ontology genuinely has no metrics, and that used to fail
		// the whole page with "No ontology has been published" - hiding the
		// dashboards the space really does have behind an error about something
		// else. An empty list is the honest answer here.
		api
			.get<KpiMeta[]>("/api/kpis")
			.then(setKpis)
			.catch(() => setKpis([]));
	};

	// Keyed on the space: changing it must re-fetch, or the page keeps showing
	// the previous space's boards while the switcher says otherwise.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(load, [spaceSlug]);

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!dashboards) return <Spinner label="Loading dashboards" />;

	const byCategory = new Map<string, KpiMeta[]>();
	for (const kpi of kpis) {
		const bucket = byCategory.get(kpi.category);
		if (bucket) bucket.push(kpi);
		else byCategory.set(kpi.category, [kpi]);
	}

	const needle = query.trim().toLowerCase();
	const visible = needle
		? dashboards.filter((dashboard) =>
				[dashboard.title, dashboard.description ?? "", dashboard.audience ?? "", dashboard.slug]
					.join(" ")
					.toLowerCase()
					.includes(needle),
			)
		: dashboards;

	return (
		<div className="col" style={{ gap: 14 }}>
			<div className="card">
				<div className="card-head">
					<h3>Dashboards</h3>
					<span className="sub">
						{visible.length === dashboards.length
							? `${dashboards.length} boards`
							: `${visible.length} of ${dashboards.length}`}
					</span>
					<Link className="btn sm" to="/dashboards/history" style={{ marginLeft: 10 }}>
						History &amp; backup
					</Link>
					<Link className="btn sm primary" to="/assistant" style={{ marginLeft: 6 }}>
						Ask the assistant for a new one
					</Link>
				</div>

				<div className="history-controls" style={{ marginBottom: 12 }}>
					<input
						className="search-input"
						type="search"
						value={query}
						placeholder="Search dashboards…"
						onChange={(event) => setQuery(event.target.value)}
						aria-label="Search dashboards"
					/>
				</div>

				{visible.length === 0 ? (
					<Empty>No dashboard matches “{query}”.</Empty>
				) : (
				<div className="grid grid-3">
					{visible.map((dashboard) => (
						<Link
							key={dashboard.slug}
							to={`/dashboards/${dashboard.slug}`}
							className="card"
							style={{ background: "var(--surface-2)", textDecoration: "none", color: "inherit" }}
						>
							<div className="row" style={{ gap: 6, marginBottom: 5 }}>
								<strong style={{ fontSize: 13.5 }}>{dashboard.title}</strong>
								{dashboard.isPinned && <span className="chip">pinned</span>}
								{dashboard.isAiGenerated && <span className="chip">AI built</span>}
							</div>
							<p className="secondary" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
								{dashboard.description}
							</p>
							<div className="muted" style={{ fontSize: 11.5 }}>
								{dashboard.layout.length} widgets
								{dashboard.audience ? ` · for ${dashboard.audience}` : ""}
							</div>
						</Link>
					))}
				</div>
				)}
			</div>

			<div className="card">
				<div className="card-head">
					<h3>KPI catalogue</h3>
					<span className="sub">
						{kpis.length} metrics, every one measured from the captured snapshot
					</span>
				</div>
				<p className="secondary" style={{ margin: "0 0 12px", fontSize: 12.5, maxWidth: 800 }}>
					Every chart on every dashboard references one of these by name. A dashboard
					cannot contain a number that is not defined here, which is what makes an
					assistant-generated board reviewable.
				</p>
				{[...byCategory.entries()].map(([category, categoryKpis]) => (
					<div key={category} style={{ marginBottom: 14 }}>
						<div className="rail-section" style={{ padding: "0 0 5px" }}>
							{category}
						</div>
						<DataTable
							columns={[
								{ key: "label", label: "Metric" },
								{ key: "businessQuestion", label: "Answers" },
								{ key: "unit", label: "Unit" },
								{ key: "dimensionList", label: "Can be sliced by" },
								{ key: "provenance", label: "Provenance" },
							]}
							rows={categoryKpis.map((kpi) => ({
								...kpi,
								dimensionList: kpi.dimensions.join(", "),
								provenance: kpi.dependsOnSimulation ? "simulated" : "measured",
							}))}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

export function DashboardDetail() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const { spaceSlug } = useSpace();
	const [dashboard, setDashboard] = useState<ResolvedDashboard | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lineageId, setLineageId] = useState<number | null>(null);

	/** Open this board's provenance: which metrics, from which views. */
	async function showLineage(slug: string) {
		try {
			const found = await api.get<{ id: number } | null>(
				`/api/resources/lookup?kind=dashboard&ref=${encodeURIComponent(slug)}&space=${spaceSlug}`,
			);
			if (found?.id) setLineageId(found.id);
			else
				setError(
					"This dashboard is not registered as a workspace resource yet. Open Spaces and fill the sandbox from the ontology.",
				);
		} catch {
			setError("Could not load the lineage.");
		}
	}

	useEffect(() => {
		if (!slug) return;
		setDashboard(null);
		setError(null);
		api
			.get<ResolvedDashboard>(`/api/dashboards/${slug}?space=${spaceSlug}`)
			.then(setDashboard)
			.catch((exc: Error) => setError(exc.message));
	}, [slug, spaceSlug]);

	if (error) return <ErrorBanner error={error} />;
	if (!dashboard) return <Spinner label="Running dashboard metrics" />;

	const remove = async () => {
		if (!window.confirm(`Delete the dashboard "${dashboard.title}"? This cannot be undone.`)) return;
		try {
			await api.del(`/api/dashboards/${dashboard.slug}?space=${spaceSlug}`);
			navigate("/dashboards");
		} catch (exc) {
			setError((exc as Error).message);
		}
	};

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3 style={{ fontSize: 15 }}>{dashboard.title}</h3>
					{dashboard.isAiGenerated && <span className="chip">AI built</span>}
					<span className="sub">
						updated {new Date(dashboard.updatedAt).toLocaleString()}
						{dashboard.audience ? ` · for ${dashboard.audience}` : ""}
					</span>
				</div>
				{dashboard.description && (
					<p className="secondary" style={{ margin: "0 0 8px" }}>
						{dashboard.description}
					</p>
				)}
				{dashboard.sourcePrompt && (
					<p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
						Built from: “{dashboard.sourcePrompt}”
					</p>
				)}
				<div className="row" style={{ gap: 6 }}>
					<Link className="btn sm" to="/dashboards">
						All dashboards
					</Link>
					{/* Where these numbers come from: the metrics on this board and
					    the views they are computed from. */}
					<button className="btn sm" onClick={() => showLineage(dashboard.slug)}>
						Lineage
					</button>
					{dashboard.isAiGenerated && (
						<button className="btn sm" onClick={remove}>
							Delete
						</button>
					)}
				</div>
			</div>

			<CoverageBanner notes={dashboard.coverageNotes} />

			<div className="grid grid-4">
				{dashboard.widgets.map((widget) => (
					<div key={widget.index} className={`w${Math.min(Math.max(widget.width ?? 2, 1), 4)}`}>
						<WidgetView widget={widget} />
					</div>
				))}
			</div>

			{/* Provenance for this board: the metrics on it and the views they
			    are computed from. */}
			<ResourcePreview resourceId={lineageId} onClose={() => setLineageId(null)} />
		</div>
	);
}

function WidgetView({
	widget,
}: {
	widget: ResolvedDashboard["widgets"][number];
}) {
	if (widget.type === "note") {
		return (
			<div className="card">
				{widget.title && (
					<div className="card-head">
						<h3>{widget.title}</h3>
					</div>
				)}
				<div className="secondary" style={{ fontSize: 12.5 }}>
					<Markdown text={widget.body ?? ""} />
				</div>
			</div>
		);
	}

	if (widget.error) {
		return (
			<div className="card">
				<div className="card-head">
					<h3>{widget.title ?? widget.kpi}</h3>
				</div>
				<div className="banner error" style={{ fontSize: 11.5 }}>
					This tile could not be computed: {widget.error}
				</div>
			</div>
		);
	}

	if (!widget.data) {
		return (
			<div className="card">
				<Spinner />
			</div>
		);
	}

	if (widget.type === "stat") {
		return <StatTile result={widget.data} title={widget.title} />;
	}

	if (widget.type === "table") {
		return (
			<div className="card">
				<div className="card-head">
					<h3>{widget.title ?? widget.data.label}</h3>
					{widget.data.total !== null && (
						<span className="sub num">
							total {formatValue(widget.data.total, widget.data.valueFormat, widget.data.unit)}
						</span>
					)}
				</div>
				{widget.data.series.length === 0 ? (
					<Empty>No rows for this metric.</Empty>
				) : (
					<DataTable
						columns={[
							{ key: "label", label: widget.data.dimensionLabel ?? "Group" },
							{ key: "display", label: widget.data.label, numeric: true },
						]}
						rows={widget.data.series.map((point) => ({
							label: point.label,
							display: formatValue(point.value, widget.data!.valueFormat, widget.data!.unit),
						}))}
						maxHeight={320}
					/>
				)}
				{widget.data.dependsOnSimulation && (
					<p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
						Simulated data. {widget.data.coverageNote}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="card">
			<div className="card-head">
				<h3>{widget.title ?? widget.data.label}</h3>
				<span className="sub">
					{widget.data.dimensionLabel ? `by ${widget.data.dimensionLabel.toLowerCase()}` : ""}
					{widget.data.total !== null &&
						` · total ${formatValue(widget.data.total, widget.data.valueFormat, widget.data.unit)}`}
				</span>
			</div>
			<Chart
				kind={(widget.chart ?? "bar") as ChartKind}
				points={widget.data.series}
				format={widget.data.valueFormat}
				unit={widget.data.unit}
				target={widget.data.target}
				height={widget.chart === "hbar" ? undefined : 210}
			/>
			{widget.data.dependsOnSimulation && (
				<p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
					Simulated data. {widget.data.coverageNote}
				</p>
			)}
		</div>
	);
}
