/**
 * Schedules: the work that runs on a cadence instead of on a click.
 *
 * A schedule names one target - a connection sync or a pipeline - and an
 * interval; the ontology service's background loop fires it when due and
 * records what happened. This page manages the definitions and shows the
 * outcomes: next run, last status, and the run history behind them.
 *
 * The list leads with what needs attention, like every other list here: a
 * failed last run is the first thing a person opening this page should see.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Empty, ErrorBanner, Spinner } from "../components/common";
import { useResources } from "../ResourceContext";

interface Schedule {
	scheduleId: number;
	name: string;
	kind: "sync" | "pipeline";
	targetRef: string;
	targetLabel?: string | null;
	intervalSeconds: number;
	enabled: boolean;
	createdBy: string;
	lastRunAt: string | null;
	nextRunAt: string | null;
	lastStatus: string | null;
	lastError: string | null;
	runCount: number;
}

interface ScheduleRun {
	schedule_run_id: number;
	status: string;
	detail: Record<string, unknown>;
	started_at: string;
	finished_at: string | null;
}

interface SyncOption {
	syncId: number;
	name: string;
	connection: string;
}

const INTERVALS: Array<{ label: string; seconds: number }> = [
	{ label: "Every 15 minutes", seconds: 900 },
	{ label: "Every hour", seconds: 3600 },
	{ label: "Every 6 hours", seconds: 21600 },
	{ label: "Every day", seconds: 86400 },
];

function humanInterval(seconds: number): string {
	if (seconds % 86400 === 0) return `every ${seconds / 86400} day(s)`;
	if (seconds % 3600 === 0) return `every ${seconds / 3600} hour(s)`;
	if (seconds % 60 === 0) return `every ${seconds / 60} min`;
	return `every ${seconds}s`;
}

export function Schedules() {
	const [schedules, setSchedules] = useState<Schedule[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<number | null>(null);
	const [creating, setCreating] = useState(false);
	const [historyOf, setHistoryOf] = useState<Schedule | null>(null);
	const [runs, setRuns] = useState<ScheduleRun[] | null>(null);

	const load = useCallback(() => {
		setSchedules(null);
		api
			.get<Schedule[]>("/api/schedules")
			.then(setSchedules)
			.catch((exc: Error) => setError(exc.message));
	}, []);
	useEffect(load, [load]);

	useEffect(() => {
		if (!historyOf) {
			setRuns(null);
			return;
		}
		api
			.get<ScheduleRun[]>(`/api/schedules/${historyOf.scheduleId}/runs`)
			.then(setRuns)
			.catch(() => setRuns([]));
	}, [historyOf]);

	async function act(id: number, action: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await action();
			load();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	if (error && !schedules) return <ErrorBanner error={error} onRetry={load} />;
	if (!schedules) return <Spinner label="Loading schedules" />;

	const failing = schedules.filter((s) => s.lastStatus === "failed");
	const healthy = schedules.filter((s) => s.lastStatus !== "failed");

	return (
		<div className="col" style={{ gap: 12 }}>
			{error && <ErrorBanner error={error} onRetry={load} />}

			{failing.length > 0 && (
				<div className="card">
					<div className="card-head">
						<h3>Failing</h3>
						<span className="sub">
							the cadence continues through a failure — a schedule that died quietly
							would be a silent gap in the data
						</span>
					</div>
					<div className="col" style={{ gap: 6 }}>
						{failing.map((s) => (
							<ScheduleRow
								key={s.scheduleId}
								schedule={s}
								busy={busy === s.scheduleId}
								onToggle={() =>
									act(s.scheduleId, () =>
										api.patch(`/api/schedules/${s.scheduleId}`, { enabled: !s.enabled }),
									)
								}
								onRunNow={() =>
									act(s.scheduleId, () => api.post(`/api/schedules/${s.scheduleId}/run`))
								}
								onHistory={() => setHistoryOf(s)}
								onDelete={() =>
									act(s.scheduleId, () => api.del(`/api/schedules/${s.scheduleId}`))
								}
							/>
						))}
					</div>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>Schedules</h3>
					<span className="sub">syncs and pipelines that fire on an interval</span>
					<button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
						New schedule
					</button>
				</div>
				{healthy.length === 0 && failing.length === 0 ? (
					<Empty>
						<p>
							<strong>Nothing is scheduled.</strong> A sync or a pipeline runs when someone
							presses Run. Give one a cadence and this platform keeps it fed without anyone
							watching.
						</p>
					</Empty>
				) : (
					<div className="col" style={{ gap: 6 }}>
						{healthy.map((s) => (
							<ScheduleRow
								key={s.scheduleId}
								schedule={s}
								busy={busy === s.scheduleId}
								onToggle={() =>
									act(s.scheduleId, () =>
										api.patch(`/api/schedules/${s.scheduleId}`, { enabled: !s.enabled }),
									)
								}
								onRunNow={() =>
									act(s.scheduleId, () => api.post(`/api/schedules/${s.scheduleId}/run`))
								}
								onHistory={() => setHistoryOf(s)}
								onDelete={() =>
									act(s.scheduleId, () => api.del(`/api/schedules/${s.scheduleId}`))
								}
							/>
						))}
					</div>
				)}
			</div>

			{creating && (
				<CreateDialog
					onClose={() => setCreating(false)}
					onCreated={() => {
						setCreating(false);
						load();
					}}
				/>
			)}

			{historyOf && (
				<div
					className="rp-backdrop"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setHistoryOf(null);
					}}
				>
					<div className="rp" role="dialog" aria-label={`Runs of ${historyOf.name}`}>
						<header className="rp-head">
							<div className="rp-heading">
								<div className="rp-kind">SCHEDULE RUNS</div>
								<h2 className="rp-title">{historyOf.name}</h2>
							</div>
							<button className="btn sm" onClick={() => setHistoryOf(null)} aria-label="Close">
								✕
							</button>
						</header>
						<div className="rp-body">
							{runs === null ? (
								<Spinner label="Loading runs" />
							) : runs.length === 0 ? (
								<p className="muted">It has never fired.</p>
							) : (
								<div className="col" style={{ gap: 8 }}>
									{runs.map((run) => (
										<div key={run.schedule_run_id} className="card" style={{ padding: 10 }}>
											<div className="row" style={{ gap: 8 }}>
												<span className={`chip ${run.status === "succeeded" ? "good" : "bad"}`}>
													{run.status}
												</span>
												<span className="muted">
													{new Date(run.started_at).toLocaleString("en-US")}
												</span>
											</div>
											<pre className="mono" style={{ fontSize: 11, marginTop: 6 }}>
												{JSON.stringify(run.detail, null, 2)}
											</pre>
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function ScheduleRow({
	schedule,
	busy,
	onToggle,
	onRunNow,
	onHistory,
	onDelete,
}: {
	schedule: Schedule;
	busy: boolean;
	onToggle: () => void;
	onRunNow: () => void;
	onHistory: () => void;
	onDelete: () => void;
}) {
	return (
		<div className="row" style={{ gap: 10, alignItems: "center", padding: "6px 0" }}>
			<span className={`chip ${schedule.enabled ? "good" : ""}`}>
				{schedule.enabled ? "enabled" : "paused"}
			</span>
			<strong>{schedule.name}</strong>
			<span className="chip">{schedule.kind === "sync" ? "sync" : "pipeline"}</span>
			<span className="mono muted">
				{schedule.kind === "sync" ? `sync #${schedule.targetRef}` : schedule.targetRef}
			</span>
			<span className="muted">{humanInterval(schedule.intervalSeconds)}</span>
			<span className="muted" style={{ fontSize: 11 }}>
				{schedule.lastStatus === "failed"
					? `last run failed: ${schedule.lastError?.slice(0, 80)}`
					: schedule.nextRunAt
						? `next run ${new Date(schedule.nextRunAt).toLocaleString("en-US")}`
						: "never run"}
			</span>
			<div className="row" style={{ gap: 6, marginLeft: "auto" }}>
				<button className="btn sm" disabled={busy} onClick={onRunNow}>
					Run now
				</button>
				<button className="btn sm" disabled={busy} onClick={onToggle}>
					{schedule.enabled ? "Pause" : "Resume"}
				</button>
				<button className="btn sm" disabled={busy} onClick={onHistory}>
					History
				</button>
				<button className="btn sm danger" disabled={busy} onClick={onDelete}>
					Delete
				</button>
			</div>
		</div>
	);
}

/**
 * The create dialog lists the syncs it can reach by walking the workspace's
 * connection resources, so a schedule names a target that exists rather than
 * typing an id and hoping.
 */
function CreateDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => void;
}) {
	const { resources } = useResources();
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"sync" | "pipeline">("pipeline");
	const [target, setTarget] = useState("");
	const [intervalSeconds, setIntervalSeconds] = useState(3600);
	const [syncs, setSyncs] = useState<SyncOption[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const connections = resources.filter((r) => r.kind === "connection");
	const pipelines = resources.filter((r) => r.kind === "pipeline");

	useEffect(() => {
		if (kind !== "sync") return;
		setSyncs(null);
		Promise.all(
			connections.map((connection) =>
				api
					.get<Array<Record<string, unknown>>>(`/api/resources/${connection.id}/syncs`)
					.then((rows) =>
						rows.map((row) => ({
							syncId: Number(row.sync_id ?? row.syncId),
							name: String(row.name ?? ""),
							connection: connection.name,
						})),
					)
					.catch(() => [] as SyncOption[]),
			),
		).then((groups) => setSyncs(groups.flat()));
		// Re-read when the connections themselves change, not on every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [kind, resources]);

	async function create() {
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/schedules", {
				name: name.trim(),
				kind,
				targetRef: target,
				intervalSeconds,
			});
			onCreated();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="rp" role="dialog" aria-label="New schedule">
				<header className="rp-head">
					<div className="rp-heading">
						<div className="rp-kind">SCHEDULE</div>
						<h2 className="rp-title">New schedule</h2>
					</div>
					<button className="btn sm" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				<div className="rp-body col" style={{ gap: 10 }}>
					<label className="col" style={{ gap: 4 }}>
						<span className="muted">Name</span>
						<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly order sync" />
					</label>
					<label className="col" style={{ gap: 4 }}>
						<span className="muted">What fires</span>
						<select
							value={kind}
							onChange={(e) => {
								setKind(e.target.value as "sync" | "pipeline");
								setTarget("");
							}}
						>
							<option value="pipeline">A pipeline</option>
							<option value="sync">A connection sync</option>
						</select>
					</label>
					<label className="col" style={{ gap: 4 }}>
						<span className="muted">Target</span>
						{kind === "pipeline" ? (
							<select value={target} onChange={(e) => setTarget(e.target.value)}>
								<option value="">Choose a pipeline…</option>
								{pipelines.map((p) => (
									<option key={p.id} value={p.targetRef ?? p.name}>
										{p.name}
									</option>
								))}
							</select>
						) : syncs === null ? (
							<Spinner label="Listing syncs" />
						) : syncs.length === 0 ? (
							<p className="muted">No syncs in this space yet — create one from a connection first.</p>
						) : (
							<select value={target} onChange={(e) => setTarget(e.target.value)}>
								<option value="">Choose a sync…</option>
								{syncs.map((s) => (
									<option key={s.syncId} value={String(s.syncId)}>
										{s.name} ({s.connection})
									</option>
								))}
							</select>
						)}
					</label>
					<label className="col" style={{ gap: 4 }}>
						<span className="muted">Cadence — minimum 60s, because a sub-minute schedule is a misconfiguration</span>
						<select value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
							{INTERVALS.map((option) => (
								<option key={option.seconds} value={option.seconds}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					{error && <ErrorBanner error={error} onRetry={create} />}
					<div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
						<button className="btn" onClick={onClose}>
							Cancel
						</button>
						<button className="btn primary" disabled={busy || !name.trim() || !target} onClick={create}>
							Create schedule
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
