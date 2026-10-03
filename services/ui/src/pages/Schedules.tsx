/**
 * Schedules: how often each sync runs.
 *
 * One row per sync in the space, with its cadence beside it - manual, every
 * 20 minutes, every 2 hours, every day, every 8 days, or a custom one with
 * its own first run, chosen on a calendar - so deciding how fresh each
 * dataset stays is one page rather than a hunt.
 * The ontology service's background loop runs each sync when due and records
 * what happened.
 *
 * The list leads with what needs attention, like every other list here: a
 * failed last run is the first thing a person opening this page should see.
 *
 * A row is a sync and its schedule, so Delete asks which is meant: the
 * schedule alone (the sync stays, run by hand) or the sync with it.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type SyncRecord, api, describeInterval } from "../api";
import { Empty, ErrorBanner, PageLoader, Spinner } from "../components/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeleteButton, useCanDelete } from "../components/DeleteDialog";
import { Icon } from "../components/icons";
import { CadenceSelect } from "../components/spaces/SyncPanel";
import { useResources } from "../ResourceContext";

interface ScheduleRun {
	schedule_run_id: number;
	status: string;
	detail: Record<string, unknown>;
	started_at: string;
	finished_at: string | null;
}

function when(value: string | null | undefined): string {
	return value ? new Date(value).toLocaleString() : "never";
}

export function Schedules() {
	const [syncs, setSyncs] = useState<SyncRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<number | null>(null);
	const [historyOf, setHistoryOf] = useState<SyncRecord | null>(null);
	const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
	// The row whose deletion is being asked about.
	const [removing, setRemoving] = useState<SyncRecord | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const canDelete = useCanDelete();
	const { refresh } = useResources();

	const load = useCallback(() => {
		api
			.get<SyncRecord[]>("/api/syncs")
			.then(setSyncs)
			.catch((exc: Error) => setError(exc.message));
	}, []);
	useEffect(load, [load]);

	useEffect(() => {
		if (!historyOf?.schedule) {
			setRuns(null);
			return;
		}
		api
			.get<ScheduleRun[]>(`/api/schedules/${historyOf.schedule.id}/runs`)
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

	if (error && !syncs) return <ErrorBanner error={error} onRetry={load} />;
	if (!syncs) return <PageLoader label="Loading schedules" />;

	const failing = syncs.filter((s) => s.lastRun?.status === "failed");
	const rest = syncs.filter((s) => s.lastRun?.status !== "failed");
	const scheduled = syncs.filter((s) => s.schedule?.enabled).length;

	const row = (sync: SyncRecord) => (
		<SyncScheduleRow
			key={sync.id}
			sync={sync}
			busy={busy === sync.id}
			onCadence={(every, startAt) =>
				act(sync.id, () => api.post(`/api/syncs/${sync.id}/schedule`, { every, ...(startAt ? { startAt } : {}) }))
			}
			onToggle={() =>
				sync.schedule &&
				act(sync.id, () => api.patch(`/api/schedules/${sync.schedule!.id}`, { enabled: !sync.schedule!.enabled }))
			}
			// A sync's first run registers its dataset, so the shared list is
			// read again: the dataset is on the Datasets page straight away.
			onRunNow={() => act(sync.id, () => api.post(`/api/syncs/${sync.id}/run`).then(() => refresh()))}
			onHistory={() => setHistoryOf(sync)}
			onDelete={canDelete ? () => setRemoving(sync) : null}
		/>
	);

	/** Carry out what the question below was answered with. */
	async function remove(sync: SyncRecord, what: "schedule" | "sync") {
		const subject = `${sync.sourceSchema}.${sync.sourceTable}`;
		await act(sync.id, async () => {
			if (what === "schedule" && sync.schedule) await api.del(`/api/removal/schedule/${sync.schedule.id}`);
			else await api.del(`/api/removal/sync/${sync.id}`);
			setNotice(
				what === "schedule"
					? `Removed the schedule of ${subject}. It now runs only when someone starts it.`
					: `Deleted the sync ${subject}${sync.schedule ? " and its schedule" : ""}. Its dataset is kept as it is.`,
			);
			// A sync is listed on its connection's page and counted in the navigation.
			await refresh();
		});
		setRemoving(null);
	}

	return (
		<div className="col" style={{ gap: 12 }}>
			{error && <ErrorBanner error={error} onRetry={load} />}
			{notice && (
				<p className="rb-notice" role="status">
					{notice}
				</p>
			)}

			{failing.length > 0 && (
				<div className="card">
					<div className="card-head">
						<h3>Failing</h3>
						<span className="sub">
							the cadence continues through a failure, so a broken source is visible rather than a
							silent gap in the data
						</span>
					</div>
					<div className="col" style={{ gap: 6 }}>{failing.map(row)}</div>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>Syncs and how often they run</h3>
					<span className="sub">
						{scheduled} of {syncs.length} on a schedule
					</span>
					<Link className="btn sm" style={{ marginLeft: "auto" }} to="/browse/connections">
						<Icon name="plus" size={13} />
						Sync another view
					</Link>
				</div>
				{syncs.length === 0 ? (
					<Empty>
						<p>
							<strong>Nothing is synced yet.</strong> Open a connection and choose a view to sync; its
							cadence is set here or right beside it.
						</p>
					</Empty>
				) : rest.length === 0 ? (
					<p className="muted">Every sync is listed under Failing above.</p>
				) : (
					<div className="col" style={{ gap: 6 }}>{rest.map(row)}</div>
				)}
			</div>

			{historyOf && (
				<div
					className="rp-backdrop"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setHistoryOf(null);
					}}
				>
					<div className="rp" role="dialog" aria-label={`Scheduled runs of ${historyOf.name}`}>
						<header className="rp-head">
							<div className="rp-heading">
								<div className="rp-kind">SCHEDULED RUNS</div>
								<h2 className="rp-title">{historyOf.name}</h2>
							</div>
							<button className="icon-btn" onClick={() => setHistoryOf(null)} aria-label="Close">
								<Icon name="x" size={17} />
							</button>
						</header>
						<div className="rp-body">
							{!historyOf.schedule ? (
								<p className="muted">This sync is not on a schedule, so it has no scheduled runs.</p>
							) : runs === null ? (
								<Spinner label="Loading runs" />
							) : runs.length === 0 ? (
								<p className="muted">It has not fired yet. Next: {when(historyOf.schedule.nextRunAt)}.</p>
							) : (
								<div className="col" style={{ gap: 8 }}>
									{runs.map((run) => (
										<div key={run.schedule_run_id} className="card" style={{ padding: 10 }}>
											<div className="row" style={{ gap: 8 }}>
												<span className={`chip ${run.status === "succeeded" ? "good" : "bad"}`}>
													{run.status}
												</span>
												<span className="muted">{when(run.started_at)}</span>
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

			{removing && (
				<ConfirmDialog
					title={`Delete “${removing.sourceSchema}.${removing.sourceTable}”?`}
					icon="trash"
					cancelLabel="Keep it"
					busy={busy === removing.id}
					onCancel={() => setRemoving(null)}
					choices={[
						...(removing.schedule
							? [
									{
										label: "Remove the schedule only",
										tone: "plain" as const,
										onSelect: () => void remove(removing, "schedule"),
									},
								]
							: []),
						{
							label: removing.schedule ? "Delete the sync and its schedule" : "Delete this sync",
							tone: "danger" as const,
							onSelect: () => void remove(removing, "sync"),
						},
					]}
				>
					{removing.schedule ? (
						<>
							<p>
								<strong>Remove the schedule only</strong> stops it running {describeInterval(removing.schedule.intervalSeconds)}.
								The sync stays, and runs when someone presses Run now.
							</p>
							<p>
								<strong>Delete the sync and its schedule</strong> removes both, with the record of its runs.
							</p>
						</>
					) : (
						<p>The sync is removed, with the record of its runs. It has no schedule.</p>
					)}
					<p>
						Either way the dataset <strong>{removing.sourceTable}</strong> keeps the rows it has now; without the
						sync it can no longer be refreshed. This cannot be undone.
					</p>
				</ConfirmDialog>
			)}
		</div>
	);
}

function SyncScheduleRow({
	sync,
	busy,
	onCadence,
	onToggle,
	onRunNow,
	onHistory,
	onDelete,
}: {
	sync: SyncRecord;
	busy: boolean;
	onCadence: (every: string, startAt?: string | null) => void;
	onToggle: () => void;
	onRunNow: () => void;
	onHistory: () => void;
	/** Null when this person may not delete here. */
	onDelete: (() => void) | null;
}) {
	const schedule = sync.schedule;
	const last = sync.lastRun;
	return (
		<div className="sched-row">
			<div className="col" style={{ gap: 3, flex: "1 1 auto", minWidth: 0 }}>
				<div className="row" style={{ gap: 8 }}>
					<span className={`chip ${schedule?.enabled ? "good" : ""}`}>
						{!schedule ? "manual" : schedule.enabled ? describeInterval(schedule.intervalSeconds) : "paused"}
					</span>
					<strong className="mono">
						{sync.sourceSchema}.{sync.sourceTable}
					</strong>
					<span className="muted" title={sync.targetRelation}>
						→ dataset {sync.sourceTable}
					</span>
				</div>
				<span className={last?.status === "failed" ? "error" : "muted"} style={{ fontSize: 11 }}>
					{last?.status === "failed"
						? `last run failed: ${last.errorMessage?.slice(0, 120) ?? "no reason recorded"}`
						: last
							? `${last.rowsAfter ?? 0} rows at ${when(last.finishedAt ?? last.startedAt)}`
							: "never run"}
					{schedule?.enabled && schedule.nextRunAt ? ` · next run ${when(schedule.nextRunAt)}` : ""}
				</span>
			</div>
			<div className="row" style={{ gap: 6, flex: "none" }}>
				<CadenceSelect
					intervalSeconds={schedule?.intervalSeconds ?? null}
					nextRunAt={schedule?.nextRunAt ?? null}
					subject={`${sync.sourceSchema}.${sync.sourceTable}`}
					disabled={busy}
					onChange={onCadence}
				/>
				<button className="btn sm" disabled={busy} onClick={onRunNow}>
					{busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={12} />}
					{busy ? "Working…" : "Run now"}
				</button>
				{schedule && (
					<button className="btn sm" disabled={busy} onClick={onToggle}>
						<Icon name={schedule.enabled ? "pause" : "play"} size={12} />
						{schedule.enabled ? "Pause" : "Resume"}
					</button>
				)}
				<button className="btn sm" disabled={busy} onClick={onHistory}>
					<Icon name="history" size={13} />
					History
				</button>
				{onDelete && (
					<DeleteButton
						onClick={onDelete}
						disabled={busy}
						title={`Delete ${sync.sourceSchema}.${sync.sourceTable}`}
					/>
				)}
			</div>
		</div>
	);
}
