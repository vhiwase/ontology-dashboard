/**
 * Overview: the one path data takes through this platform, counted for the
 * space you are in, and the next step along it.
 *
 *   connection -> sync (scheduled) -> dataset -> object type -> metrics, actions
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type PlatformStats, api, isMissingOntology, round } from "../api";
import { useSpace } from "../SpaceContext";
import { Chart } from "../components/Chart";
import { Empty, ErrorBanner, NoOntologyHere, Spinner } from "../components/common";

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

	// The summary counts one space, so it reloads when the space does.
	// biome-ignore lint/correctness/useExhaustiveDependencies: load is stable enough here; the space is the input.
	useEffect(load, [spaceSlug]);

	if (missing) return <NoOntologyHere what="ontology" spaceName={space?.name ?? spaceSlug} />;
	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!stats) return <Spinner label="Loading platform summary" />;

	const { counts, flow } = stats;
	const valid = stats.ontology.validation?.valid !== false;

	const stages = [
		{
			label: "Connections",
			value: flow.connections,
			foot: "PostgreSQL sources",
			to: "/browse/connections",
		},
		{
			label: "Syncs",
			value: flow.syncs,
			foot: `${flow.schedules} on a schedule`,
			to: "/schedules",
		},
		{
			label: "Datasets",
			value: flow.datasets,
			foot: flow.lastSyncAt ? `last synced ${new Date(flow.lastSyncAt).toLocaleString()}` : "nothing synced yet",
			to: "/browse/datasets",
		},
		{
			label: "Object types",
			value: counts.objectTypes,
			foot: `${counts.objects.toLocaleString()} objects, ${counts.linkTypes} links`,
			to: "/ontology",
		},
		{
			label: "Metrics · actions",
			value: counts.kpis + counts.actionTypes,
			foot: `${counts.kpis} metrics, ${counts.actionTypes} actions, ${flow.functions} functions`,
			to: "/browse/metrics",
		},
	];

	return (
		<div className="col" style={{ gap: 14 }}>
			<div className="card">
				<div className="card-head">
					<h3>{stats.ontology.label ?? "TMS Ontology"}</h3>
					<span className="sub">v{stats.ontology.version}</span>
				</div>
				<p className="secondary" style={{ margin: "0 0 10px", maxWidth: 860 }}>
					A PostgreSQL connection syncs views into datasets exactly as they are, on the schedule you
					choose. Object types are created from those datasets, and the links, metrics, actions and
					functions on them are what dashboards and the AI-FDE answer from.
				</p>
				<div className="row" style={{ gap: 6 }}>
					<span className={`chip ${valid ? "good" : "critical"}`}>
						<span className="dot" aria-hidden />
						{valid ? "ontology validates" : "ontology has validation errors"}
					</span>
					<span className="chip">{counts.objectTypes} object types</span>
					<span className="chip">{counts.linkTypes} links</span>
					<span className="chip">{counts.actionTypes} actions</span>
					<span className="chip">{counts.kpis} metrics</span>
				</div>
			</div>

			<div className="grid grid-5">
				{stages.map((stage, index) => (
					<Link key={stage.label} to={stage.to} className="card stat" style={{ textDecoration: "none" }}>
						<div className="label">
							{index + 1}. {stage.label}
						</div>
						<div className="value">{stage.value.toLocaleString()}</div>
						<div className="foot">{stage.foot}</div>
					</Link>
				))}
			</div>

			<NextStep stats={stats} />

			<div className="grid grid-2">
				<div className="card">
					<div className="card-head">
						<h3>Objects by type</h3>
						<span className="sub">rows in each type's dataset, as of its last sync</span>
					</div>
					{stats.objectTypes.length === 0 ? (
						<Empty>No object types yet.</Empty>
					) : (
						<Chart
							kind="hbar"
							points={stats.objectTypes.map((type) => ({ label: type.label, value: type.objects }))}
							format="integer"
						/>
					)}
				</div>

				<div className="card">
					<div className="card-head">
						<h3>How data gets here</h3>
					</div>
					<ol className="secondary" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.8 }}>
						<li>
							A <Link to="/browse/connections">connection</Link> names a PostgreSQL host and the
							secret its password is in - never the password.
						</li>
						<li>
							A sync copies one view into a <Link to="/browse/datasets">dataset</Link>, as it is, and
							a <Link to="/schedules">schedule</Link> refreshes it: every 20 minutes, 2 hours, a day,
							8 days.
						</li>
						<li>
							An <Link to="/ontology">object type</Link> is created from a dataset, a property per
							column; its primary key is checked unique against the data.
						</li>
						<li>
							Links are measured against the data, metrics are computed once before they are kept,
							actions are staged, and functions wait for an admin.
						</li>
					</ol>
					<div className="row" style={{ marginTop: 12, gap: 6 }}>
						<Link className="btn" to="/ontology">
							Browse the ontology
						</Link>
						<Link className="btn primary" to="/assistant">
							Ask the AI-FDE
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}

/** The next thing to do, from what this space has and has not got yet. */
function NextStep({ stats }: { stats: PlatformStats }) {
	const { flow, counts } = stats;
	const build = encodeURIComponent(
		"Create object types from every synced dataset that is not modelled yet, link them, and add " +
			"the metrics and actions that are useful for running freight operations.",
	);

	let message: string;
	let action: { to: string; label: string } | null;
	if (flow.connections === 0) {
		message = "Register a PostgreSQL connection to bring data in.";
		action = { to: "/browse/connections", label: "Add a connection" };
	} else if (flow.datasets === 0) {
		message = "Sync a view from a connection: it lands as a dataset, exactly as it is.";
		action = { to: "/browse/connections", label: "Sync a view" };
	} else if (counts.objectTypes < flow.datasets) {
		message =
			`${flow.datasets} dataset${flow.datasets === 1 ? "" : "s"} synced, ${counts.objectTypes} ` +
			"object type" +
			(counts.objectTypes === 1 ? "" : "s") +
			" made from them. Model the rest - by hand from a dataset's page, or let the AI-FDE build them with links, metrics and actions.";
		action = { to: `/assistant?prompt=${build}`, label: "Build with the AI-FDE" };
	} else if (flow.schedules < flow.syncs) {
		message = `${flow.syncs - flow.schedules} sync(s) run only when someone runs them. Give them a cadence to keep the datasets fresh.`;
		action = { to: "/browse/connections", label: "Set a schedule" };
	} else if (counts.kpis === 0) {
		message = "The ontology has no metrics yet. Define the numbers a dashboard should show.";
		action = { to: "/assistant", label: "Ask the AI-FDE" };
	} else {
		message = "Every dataset is modelled and refreshing on a schedule. Build a dashboard on the metrics.";
		action = { to: "/dashboards", label: "Open dashboards" };
	}

	return (
		<div className="card">
			<div className="row" style={{ gap: 10 }}>
				<strong style={{ fontSize: 13 }}>Next</strong>
				<span className="secondary" style={{ flex: "1 1 auto" }}>
					{message}
				</span>
				{action && (
					<Link className="btn primary sm" to={action.to}>
						{action.label}
					</Link>
				)}
			</div>
		</div>
	);
}

export { round };
