/**
 * The syncs on a connection: the only way anything crosses it.
 *
 * A sync copies one view from the source into a dataset exactly as it is, and
 * its cadence - manual, every 20 minutes, every 2 hours, daily, every 8 days -
 * is set right here beside it, because "how fresh is this" is part of what a
 * sync is rather than a separate thing to go and find.
 *
 * The view is chosen from the far side's real catalogue rather than typed, so
 * a sync cannot name something the connection's user cannot read.
 */

import { useCallback, useEffect, useState } from "react";
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
import { Empty, Spinner } from "../common";

function when(value: string | null): string {
	return value ? new Date(value).toLocaleString() : "never";
}

/** What the last run of a sync actually did, in one line. */
function runSummary(sync: SyncRecord): string {
	const run = sync.lastRun;
	if (!run) return "never run";
	if (run.status === "failed") return `failed — ${run.errorMessage ?? "no reason recorded"}`;
	const cut = run.truncated ? `, stopped at the ${sync.rowLimit}-row limit` : "";
	return `${run.rowsAfter ?? 0} rows${cut} · ${when(run.finishedAt ?? run.startedAt)}`;
}

/** What a run did, as the sentence shown after pressing Run. */
function outcomeMessage(sync: SyncRecord, outcome: SyncOutcome): string {
	return (
		`'${sync.name}' copied ${outcome.run.rowsAfter ?? 0} rows into ${sync.targetRelation}.` +
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

/**
 * A cadence picker: the presets, plus a custom value when the current cadence
 * is not one of them. Anything the server reads ("3d", "45m") may be typed.
 */
export function CadenceSelect({
	intervalSeconds,
	disabled,
	onChange,
}: {
	intervalSeconds: number | null;
	disabled?: boolean;
	onChange: (every: string) => void;
}) {
	const current = cadenceFor(intervalSeconds);
	const known = CADENCES.some((option) => option.every === current);
	return (
		<select
			value={known ? current : "__current"}
			disabled={disabled}
			onChange={(event) => {
				const value = event.target.value;
				if (value === "__custom") {
					const typed = window.prompt("How often? e.g. 45m, 3h, 3d, 2w", current === "manual" ? "4h" : current);
					if (typed?.trim()) onChange(typed.trim());
					return;
				}
				if (value !== "__current") onChange(value);
			}}
			aria-label="Refresh cadence"
		>
			{!known && intervalSeconds && <option value="__current">{describeInterval(intervalSeconds)}</option>}
			{CADENCES.map((option) => (
				<option key={option.every} value={option.every}>
					{option.label}
				</option>
			))}
			<option value="__custom">Custom…</option>
		</select>
	);
}

export function SyncPanel({ resourceId }: { resourceId: number }) {
	const [syncs, setSyncs] = useState<SyncRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<number | "new" | null>(null);
	const [adding, setAdding] = useState(false);

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
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function schedule(sync: SyncRecord, every: string) {
		setBusy(sync.id);
		setError(null);
		setNotice(null);
		try {
			await api.post(`/api/syncs/${sync.id}/schedule`, { every });
			setNotice(
				every === "manual"
					? `'${sync.name}' now runs only when someone runs it.`
					: `'${sync.name}' will refresh ${CADENCES.find((c) => c.every === every)?.label.toLowerCase() ?? `every ${every}`}.`,
			);
			load();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function remove(sync: SyncRecord) {
		if (
			!window.confirm(
				`Delete the sync '${sync.name}' and its schedule? ${sync.targetRelation} is left in place; ` +
					"nothing will refresh it afterwards.",
			)
		) {
			return;
		}
		setBusy(sync.id);
		try {
			await api.del(`/api/syncs/${sync.id}`);
			load();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
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
					{adding ? "Cancel" : "Sync a view"}
				</button>
			</div>

			{error && <div className="banner error">{error}</div>}
			{notice && <div className="banner">{notice}</div>}

			{adding && (
				<NewSync
					resourceId={resourceId}
					onDone={(message) => {
						setAdding(false);
						setNotice(message);
						load();
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
										disabled={busy !== null}
										onChange={(every) => void schedule(sync, every)}
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
									<button className="btn sm" disabled={busy !== null} onClick={() => void run(sync)}>
										{busy === sync.id ? "Running…" : "Run now"}
									</button>{" "}
									<button className="btn sm" disabled={busy !== null} onClick={() => void remove(sync)}>
										Delete
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
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
function NewSync({
	resourceId,
	onDone,
}: {
	resourceId: number;
	onDone: (message: string) => void;
}) {
	const [catalog, setCatalog] = useState<ConnectionCatalog | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const [chosen, setChosen] = useState<string>("");
	const [every, setEvery] = useState("manual");
	const [rowLimit, setRowLimit] = useState(50_000);
	const [runNow, setRunNow] = useState(true);

	useEffect(() => {
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
			if (every !== "manual") {
				await api.post(`/api/syncs/${created.id}/schedule`, { every });
			}
			let ran = "";
			if (runNow) {
				const outcome = await api.post<SyncOutcome>(`/api/syncs/${created.id}/run`);
				ran = ` ${outcomeMessage(created, outcome)}`;
			}
			onDone(
				`Syncing ${chosen} into ${created.targetRelation}, ${
					CADENCES.find((c) => c.every === every)?.label.toLowerCase() ?? `every ${every}`
				}.${ran}`,
			);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	if (error && !catalog) return <div className="banner error">{error}</div>;
	if (!catalog) return <Spinner label="Reading the source" />;

	return (
		<div className="card" style={{ marginBottom: 10 }}>
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

			<label className="field">
				<span>Refresh</span>
				<select value={every} onChange={(event) => setEvery(event.target.value)}>
					{CADENCES.map((option) => (
						<option key={option.every} value={option.every}>
							{option.label}
						</option>
					))}
				</select>
			</label>

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

			<label className="row" style={{ gap: 6, fontSize: 12 }}>
				<input type="checkbox" checked={runNow} onChange={(event) => setRunNow(event.target.checked)} />
				Copy it now as well
			</label>

			{error && <div className="banner error">{error}</div>}
			<div className="row">
				<button className="btn primary sm" disabled={busy || !chosen} onClick={submit}>
					{busy ? "Syncing…" : "Sync"}
				</button>
			</div>
		</div>
	);
}
