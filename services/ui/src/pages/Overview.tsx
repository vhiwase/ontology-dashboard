/** Overview: what this platform is, what is in it, and how much of it is real. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type PlatformStats, api, isMissingOntology, round } from "../api";
import { useSpace } from "../SpaceContext";
import { Chart } from "../components/Chart";
import { DataTable, ErrorBanner, NoOntologyHere, Spinner } from "../components/common";

export function Overview() {
	const [stats, setStats] = useState<PlatformStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [missing, setMissing] = useState(false);
	const { spaceSlug, space } = useSpace();

	const load = () => {
		setStats(null);
		setError(null);
		setMissing(false);
		api
			.get<PlatformStats>("/api/stats")
			.then(setStats)
			.catch((exc: Error) =>
				isMissingOntology(exc) ? setMissing(true) : setError(exc.message),
			);
	};

	// The summary counts one space's ontology, so it reloads when the space does.
	// biome-ignore lint/correctness/useExhaustiveDependencies: load is stable enough here; the space is the input.
	useEffect(load, [spaceSlug]);

	if (missing)
		return <NoOntologyHere what="published ontology" spaceName={space?.name ?? spaceSlug} />;
	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!stats) return <Spinner label="Loading platform summary" />;

	const { counts } = stats;
	const coverage = stats.dataCoverage.map((row) => ({
		label: row.metric_area,
		value: row.source_coverage_pct === null ? 0 : Number(row.source_coverage_pct),
	}));
	const measuredAreas = stats.dataCoverage.filter(
		(row) => Number(row.source_coverage_pct ?? 0) >= 100,
	).length;

	return (
		<div className="col" style={{ gap: 14 }}>
			<div className="card">
				<div className="card-head">
					<h3>TMS Transport Management Ontology</h3>
					<span className="sub">
						v{stats.ontology.version} · generated {new Date(stats.ontology.createdAt).toLocaleString()}
					</span>
				</div>
				<p className="secondary" style={{ margin: "0 0 10px", maxWidth: 860 }}>
					{stats.ontology.description}
				</p>
				<div className="row" style={{ gap: 6 }}>
					<span className="chip good">
						<span className="dot" aria-hidden />
						ontology validates
					</span>
					<span className="chip">{counts.objectTypes} object types</span>
					<span className="chip">{counts.linkTypes} link types</span>
					<span className="chip">{counts.actionTypes} actions</span>
					<span className="chip">{counts.kpis} KPIs</span>
				</div>
			</div>

			<div className="grid grid-4">
				<Tile label="Objects" value={counts.objects.toLocaleString()} foot={`across ${counts.objectTypes} types`} />
				<Tile
					label="Properties"
					value={counts.properties.toLocaleString()}
					foot="classified by semantic role"
				/>
				<Tile
					label="Link types"
					value={String(counts.linkTypes)}
					foot={`${counts.completeLinks} resolve every reference`}
				/>
				<Tile
					label="Measured metric areas"
					value={`${measuredAreas} of ${stats.dataCoverage.length}`}
					foot="the rest rest on simulation"
				/>
			</div>

			<div className="grid grid-2">
				<div className="card">
					<div className="card-head">
						<h3>Data coverage</h3>
						<span className="sub">share of rows that came from the captured TMS payloads</span>
					</div>
					<Chart kind="hbar" points={coverage} format="percent" />
					<p className="muted" style={{ fontSize: 11.5, marginBottom: 0, marginTop: 10 }}>
						The captured snapshot is a planning snapshot: it contains no arrivals, no
						distances and no carrier assignments. Those are generated into a separate
						schema so the metrics are demonstrable, and every affected figure is
						labelled. See <Link to="/dashboards/data-trust">Data Trust</Link>.
					</p>
				</div>

				<div className="card">
					<div className="card-head">
						<h3>Exception worklist</h3>
						<span className="sub">what an operations lead opens the day with</span>
					</div>
					<DataTable
						columns={[
							{ key: "exception_type", label: "Exception" },
							{ key: "object_type", label: "Object" },
							{ key: "severity", label: "Severity" },
							{ key: "item_count", label: "Items", numeric: true },
						]}
						rows={stats.exceptions as unknown as Array<Record<string, unknown>>}
						maxHeight={320}
					/>
				</div>
			</div>

			<div className="grid grid-2">
				<div className="card">
					<div className="card-head">
						<h3>Object types by domain</h3>
					</div>
					<Chart
						kind="hbar"
						points={stats.groups.map((group) => ({ label: group.group, value: group.objects }))}
						format="integer"
					/>
				</div>

				<div className="card">
					<div className="card-head">
						<h3>How this was built</h3>
					</div>
					<ol className="secondary" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.8 }}>
						<li>
							Captured TMS REST payloads landed into <code>tms_raw</code> (19 endpoints).
						</li>
						<li>
							Semantic views in <code>tms_views</code> reshaped them into business language.
						</li>
						<li>
							The pipeline introspected those views and emitted this ontology: one object
							type per view, properties classified by role, link types probed against the
							real data.
						</li>
						<li>
							A curated KPI catalogue and an action layer were registered on top.
						</li>
						<li>
							A six-layer <Link to="/lineage">lineage graph</Link> records where every
							figure comes from.
						</li>
					</ol>
					<div className="row" style={{ marginTop: 12, gap: 6 }}>
						<Link className="btn" to="/ontology">
							Browse the ontology
						</Link>
						<Link className="btn primary" to="/assistant">
							Ask the assistant
						</Link>
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<h3>Recent pipeline runs</h3>
				</div>
				<DataTable
					columns={[
						{ key: "generation_run_id", label: "Run", numeric: true },
						{ key: "status", label: "Status" },
						{ key: "views_scanned", label: "Views", numeric: true },
						{ key: "object_types", label: "Object types", numeric: true },
						{ key: "link_types", label: "Links", numeric: true },
						{ key: "kpis", label: "KPIs", numeric: true },
						{ key: "lineage_nodes", label: "Lineage nodes", numeric: true },
						{ key: "finished_at", label: "Finished" },
					]}
					rows={stats.generationRuns}
				/>
			</div>
		</div>
	);
}

function Tile({ label, value, foot }: { label: string; value: string; foot: string }) {
	return (
		<div className="card stat">
			<div className="label">{label}</div>
			<div className="value">{value}</div>
			<div className="foot">{foot}</div>
		</div>
	);
}

export { round };
