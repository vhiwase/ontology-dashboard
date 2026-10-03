/**
 * The syncs on a connection: the only way anything crosses it.
 *
 * A sync copies one view from the source into a dataset exactly as it is, and
 * its cadence - manual, every 20 minutes, every 2 hours, daily, every 8 days,
 * or a custom one with its own first run - is set right here beside it,
 * because "how fresh is this" is part of what a sync is rather than a separate
 * thing to go and find.
 *
 * The view is chosen from the far side's real catalogue rather than typed, so
 * a sync cannot name something the connection's user cannot read.
 *
 * A sync's first run is what registers its dataset, so every run, new sync and
 * deletion here re-reads the shared resource list: the dataset is on the
 * Datasets page, and counted in the navigation, as soon as it exists.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
	CADENCES,
	type ConnectionCatalog,
	type RemoteRelation,
	type SyncOutcome,
	type SyncRecord,
	api,
	cadenceFor,
	describeInterval,
} from "../../api";
import { useResources } from "../../ResourceContext";
import { Empty, Spinner } from "../common";
import { Icon } from "../icons";
import { ScheduleDialog } from "./ScheduleDialog";
import { secondsOf } from "./schedule";

function when(value: string | null): string {
	return value ? new Date(value).toLocaleString() : "never";
}

function rowsOf(count: number | null | undefined): string {
	const rows = count ?? 0;
	return rows === 1 ? "1 row" : `${rows.toLocaleString()} rows`;
}

/** What the last run of a sync actually did, in one line. */
function runSummary(sync: SyncRecord): string {
	const run = sync.lastRun;
	if (!run) return "never run";
	if (run.status === "failed") return `failed — ${run.errorMessage ?? "no reason recorded"}`;
	const cut = run.truncated ? `, stopped at the ${sync.rowLimit}-row limit` : "";
	return `${rowsOf(run.rowsAfter)}${cut} · ${when(run.finishedAt ?? run.startedAt)}`;
}

/** What a run did, as the sentence shown after pressing Run. */
function outcomeMessage(sync: SyncRecord, outcome: SyncOutcome): string {
	return (
		`'${sync.name}' copied ${rowsOf(outcome.run.rowsAfter)} into ${sync.targetRelation}.` +
		(outcome.run.truncated
			? ` It stopped at the ${sync.rowLimit}-row limit, so the dataset is a prefix of the source.`
			: "") +
		(outcome.widenedColumns.length > 0
			? ` These columns landed as text because they have no local equivalent: ${outcome.widenedColumns.join(", ")}.`
			: "") +
		(outcome.objectTypesRefreshed > 0 ? ` ${outcome.objectTypesRefreshed} object type(s) refreshed.` : "") +
		(outcome.brokenProperties.length > 0
			? ` The source no longer has columns these properties use: ${outcome.brokenProperties.join(", ")}.`
			: "")
	);
}

/** What the schedule route answers with. */
interface ScheduleAnswer {
	schedule: { every: string; nextRunAt: string | null } | null;
}

/** A cadence as the sentence shown after setting it. */
function cadenceMessage(name: string, answer: ScheduleAnswer): string {
	if (!answer.schedule) return `'${name}' now runs only when someone runs it.`;
	return `'${name}' will refresh ${answer.schedule.every}. Next run: ${when(answer.schedule.nextRunAt)}.`;
}

/**
 * A cadence picker: the presets, and "Custom schedule…" for anything else,
 * which opens a window with a calendar for the first run.
 *
 * `onChange` is given the interval as the server reads it ("3d") and, for a
 * custom schedule with a chosen first run, that moment as an ISO string.
 */
export function CadenceSelect({
	intervalSeconds,
	nextRunAt,
	subject,
	disabled,
	onChange,
}: {
	intervalSeconds: number | null;
	/** When it next runs, so the custom schedule's calendar starts from there. */
	nextRunAt?: string | null;
	/** What is being scheduled, for the custom schedule's heading. */
	subject?: string;
	disabled?: boolean;
	onChange: (every: string, startAt?: string | null) => void;
}) {
	const [customising, setCustomising] = useState(false);
	const current = cadenceFor(intervalSeconds);
	const known = CADENCES.some((option) => option.every === current);
	return (
		<>
			<select
				value={known ? current : "__current"}
				disabled={disabled}
				onChange={(event) => {
					const value = event.target.value;
					if (value === "__custom") setCustomising(true);
					else if (value !== "__current") onChange(value);
				}}
				aria-label="Refresh cadence"
			>
				{!known && intervalSeconds && (
					<option value="__current">{describeInterval(intervalSeconds).replace(/^e/, "E")}</option>
				)}
				{CADENCES.map((option) => (
					<option key={option.every} value={option.every}>
						{option.label}
					</option>
				))}
				<option value="__custom">Custom schedule…</option>
			</select>
			{customising && (
				<ScheduleDialog
					subject={subject}
					intervalSeconds={intervalSeconds}
					nextRunAt={nextRunAt}
					onClose={() => setCustomising(false)}
					onSave={(every, startAt) => {
						setCustomising(false);
						onChange(every, startAt);
					}}
				/>
			)}
		</>
	);
}

export function SyncPanel({ resourceId }: { resourceId: number }) {
	const { refresh } = useResources();
	const [syncs, setSyncs] = useState<SyncRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<number | "new" | null>(null);
	const [adding, setAdding] = useState(false);
	const [confirming, setConfirming] = useState<number | null>(null);

	const load = useCallback(() => {
		api
			.get<SyncRecord[]>(`/api/resources/${resourceId}/syncs`)
			.then(setSyncs)
			.catch((exc: Error) => setError(exc.message));
	}, [resourceId]);

	useEffect(load, [load]);

	async function run(sync: SyncRecord) {
		setBusy(sync.id);
		setError(null);
		setNotice(null);
		try {
			setNotice(outcomeMessage(sync, await api.post<SyncOutcome>(`/api/syncs/${sync.id}/run`)));
			load();
			// A first run registers the dataset; every run changes its row count.
			void refresh();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function schedule(sync: SyncRecord, every: string, startAt?: string | null) {
		setBusy(sync.id);
		setError(null);
		setNotice(null);
		try {
			const answer = await api.post<ScheduleAnswer>(`/api/syncs/${sync.id}/schedule`, {
				every,
				...(startAt ? { startAt } : {}),
			});
			setNotice(cadenceMessage(sync.name, answer));
			load();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function remove(sync: SyncRecord) {
		setBusy(sync.id);
		setError(null);
		setNotice(null);
		try {
			await api.del(`/api/syncs/${sync.id}`);
			setNotice(
				`The sync '${sync.name}' and its schedule are deleted. ${sync.targetRelation} is left in place; nothing refreshes it now.`,
			);
			load();
			void refresh();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
			setConfirming(null);
		}
	}

	return (
		<div style={{ marginBottom: 12 }}>
			<div className="row" style={{ marginBottom: 6 }}>
				<strong style={{ fontSize: 12 }}>Syncs</strong>
				<span className="muted" style={{ fontSize: 11 }}>
					each copies one view into a dataset, as it is, on its own cadence
				</span>
				<button className="btn sm" onClick={() => setAdding((open) => !open)}>
					<Icon name={adding ? "x" : "plus"} size={13} />
					{adding ? "Cancel" : "Sync a view"}
				</button>
			</div>

			{error && <div className="banner error">{error}</div>}
			{notice && (
				<div className="banner sync-notice" role="status">
					<span>
						{notice} <Link to="/browse/datasets">Open the datasets</Link>
					</span>
				</div>
			)}

			{adding && (
				<NewSync
					resourceId={resourceId}
					onDone={(message) => {
						setAdding(false);
						setNotice(message);
						load();
						void refresh();
					}}
				/>
			)}

			{!syncs ? (
				<Spinner label="Loading syncs" />
			) : syncs.length === 0 ? (
				<Empty>
					Nothing is synced through this connection yet. Choose <strong>Sync a view</strong> to copy
					one into a dataset.
				</Empty>
			) : (
				<div className="table-wrap">
					<table className="dense">
						<thead>
							<tr>
								<th>Source view</th>
								<th>Dataset</th>
								<th>Refresh</th>
								<th>Last run</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{syncs.map((sync) => (
								<tr key={sync.id}>
									<td className="mono">
										{sync.sourceSchema}.{sync.sourceTable}
									</td>
									<td className="mono" title={sync.targetRelation}>
										{sync.sourceTable}
									</td>
									<td>
										<CadenceSelect
											intervalSeconds={sync.schedule?.intervalSeconds ?? null}
											nextRunAt={sync.schedule?.nextRunAt ?? null}
											subject={`${sync.sourceSchema}.${sync.sourceTable}`}
											disabled={busy !== null}
											onChange={(every, startAt) => void schedule(sync, every, startAt)}
										/>
										{sync.schedule?.nextRunAt && (
											<div className="muted" style={{ fontSize: 11 }}>
												next {when(sync.schedule.nextRunAt)}
											</div>
										)}
									</td>
									<td className={sync.lastRun?.status === "failed" ? "error" : undefined} style={{ fontSize: 11 }}>
										{runSummary(sync)}
									</td>
									<td style={{ whiteSpace: "nowrap" }}>
										{confirming === sync.id ? (
										// Asked in the row rather than in a browser dialog. Kept as
											// narrow as the buttons it replaces, so the table does not
											// grow sideways; what stays is said on the button and in
											// the notice afterwards.
											<span className="row-confirm">
												<button
													className="btn sm danger"
													disabled={busy !== null}
													title="Deletes the sync and its schedule. Its dataset is left in place."
													onClick={() => void remove(sync)}
												>
													{busy === sync.id ? "Deleting…" : "Delete sync"}
												</button>
												<button className="btn sm ghost" disabled={busy !== null} onClick={() => setConfirming(null)}>
													Keep
												</button>
											</span>
										) : (
											<>
												<button className="btn sm" disabled={busy !== null} onClick={() => void run(sync)}>
													{busy === sync.id ? <span className="spinner" aria-hidden /> : <Icon name="play" size={12} />}
													{busy === sync.id ? "Running…" : "Run now"}
												</button>{" "}
												<button
													className="icon-btn"
													disabled={busy !== null}
													onClick={() => setConfirming(sync.id)}
													title="Delete this sync"
													aria-label={`Delete the sync ${sync.name}`}
												>
													<Icon name="trash" size={14} />
												</button>
											</>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

/**
 * Syncing a view: choose it, choose how often, and it is copied at once.
 *
 * The list comes from the connection's own catalogue, views first, which is
 * also the check that the connection can read it.
 */
export function NewSync({
	resourceId,
	bare = false,
	submitLabel = "Sync",
	onCancel,
	onDone,
}: {
	resourceId: number;
	/** Without its own card, for a window that already is one. */
	bare?: boolean;
	submitLabel?: string;
	/** Shown as a Cancel button beside the submit, where the form is in a window. */
	onCancel?: () => void;
	/** The sync exists. `datasetResourceId` is set when it was also copied. */
	onDone: (message: string, datasetResourceId: number | null) => void;
}) {
	const [catalog, setCatalog] = useState<ConnectionCatalog | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const [chosen, setChosen] = useState<string>("");
	const [cadence, setCadence] = useState<{ every: string; startAt: string | null }>({ every: "manual", startAt: null });
	const [rowLimit, setRowLimit] = useState(50_000);
	const [runNow, setRunNow] = useState(true);

	useEffect(() => {
		setCatalog(null);
		setChosen("");
		setError(null);
		api
			.get<ConnectionCatalog>(`/api/resources/${resourceId}/catalog`)
			.then(setCatalog)
			.catch((exc: Error) => setError(exc.message));
	}, [resourceId]);

	const pick = (relation: RemoteRelation) => `${relation.schema}.${relation.name}`;

	async function submit() {
		const [sourceSchema, sourceTable] = chosen.split(".");
		setBusy(true);
		setError(null);
		try {
			const created = await api.post<SyncRecord>(`/api/resources/${resourceId}/syncs`, {
				sourceSchema,
				sourceTable,
				rowLimit,
			});
			let scheduled = "It runs only when someone runs it.";
			if (cadence.every !== "manual") {
				const answer = await api.post<ScheduleAnswer>(`/api/syncs/${created.id}/schedule`, {
					every: cadence.every,
					...(cadence.startAt ? { startAt: cadence.startAt } : {}),
				});
				scheduled = answer.schedule
					? `It refreshes ${answer.schedule.every}; next run ${when(answer.schedule.nextRunAt)}.`
					: scheduled;
			}
			let ran = "";
			let datasetResourceId: number | null = null;
			if (runNow) {
				const outcome = await api.post<SyncOutcome>(`/api/syncs/${created.id}/run`);
				ran = ` ${outcomeMessage(created, outcome)}`;
				datasetResourceId = outcome.datasetResourceId;
			}
			onDone(`Syncing ${chosen} into the dataset ${created.sourceTable}. ${scheduled}${ran}`, datasetResourceId);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	if (error && !catalog) return <div className="banner error">{error}</div>;
	if (!catalog) return <Spinner label="Reading the source" />;

	return (
		<div className={bare ? undefined : "card"} style={bare ? undefined : { marginBottom: 10 }}>
			<label className="field">
				<span>View on {catalog.connection}</span>
				<select value={chosen} onChange={(event) => setChosen(event.target.value)}>
					<option value="">Choose…</option>
					{catalog.relations.map((relation) => (
						<option key={pick(relation)} value={pick(relation)}>
							{pick(relation)} · {relation.kind}
							{relation.estimatedRows !== null ? ` · ~${relation.estimatedRows} rows` : ""}
						</option>
					))}
				</select>
				<span className="field-hint">
					{catalog.relations.length} views and tables readable by this connection's user. The
					dataset is a copy of it, rebuilt on every run: same columns, same rows.
				</span>
			</label>

			<div className="field">
				<span>Refresh</span>
				<CadenceSelect
					intervalSeconds={secondsOf(cadence.every)}
					nextRunAt={cadence.startAt}
					subject={chosen || undefined}
					onChange={(every, startAt) => setCadence({ every, startAt: startAt ?? null })}
				/>
				{cadence.startAt && (
					<span className="field-hint">First run {when(cadence.startAt)}, then on the same rhythm.</span>
				)}
			</div>

			<label className="field">
				<span>Row limit</span>
				<input
					type="number"
					value={rowLimit}
					min={1}
					max={1_000_000}
					onChange={(event) => setRowLimit(Number(event.target.value))}
				/>
				<span className="field-hint">
					A run holds its result in memory before writing it. One that reaches this limit says so
					rather than reporting a partial dataset as complete.
				</span>
			</label>

			{error && <div className="banner error">{error}</div>}
			<div className="new-sync-foot">
				<label className="row" style={{ gap: 6, fontSize: 12.5 }}>
					<input type="checkbox" checked={runNow} onChange={(event) => setRunNow(event.target.checked)} />
					Copy it now as well
				</label>
				<span className="spacer" />
				{onCancel && (
					<button className="btn ghost" disabled={busy} onClick={onCancel}>
						Cancel
					</button>
				)}
				<button className={`btn primary ${onCancel ? "" : "sm"}`} disabled={busy || !chosen} onClick={submit}>
					{busy && <span className="spinner" aria-hidden />}
					{busy ? "Syncing…" : submitLabel}
				</button>
			</div>
		</div>
	);
}
