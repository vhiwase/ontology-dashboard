/**
 * The syncs on a connection: the only way anything crosses it.
 *
 * A connection that has never been synced is a business card, and this panel
 * is what makes that visible — it leads with the syncs and says plainly when
 * there are none, rather than leaving "can this actually bring data in" as
 * something you discover by its absence.
 *
 * The source table is chosen from the far side's real catalogue rather than
 * typed, so a sync cannot name a table the connection's user cannot read.
 */

import { useCallback, useEffect, useState } from "react";
import {
	type ConnectionCatalog,
	type RemoteRelation,
	type SyncOutcome,
	type SyncRecord,
	api,
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
	const rows = `${run.rowsWritten ?? 0} rows in, ${run.rowsAfter ?? 0} now`;
	const cut = run.truncated ? `, stopped at the ${sync.rowLimit}-row limit` : "";
	return `${run.status} · ${rows}${cut} · ${when(run.finishedAt ?? run.startedAt)}`;
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
			const outcome = await api.post<SyncOutcome>(`/api/syncs/${sync.id}/run`);
			setNotice(
				`'${sync.name}' pulled ${outcome.run.rowsWritten ?? 0} rows into ${sync.targetRelation}.` +
					(outcome.run.truncated
						? ` It stopped at the ${sync.rowLimit}-row limit, so the table is a prefix of the source.`
						: "") +
					(outcome.widenedColumns.length > 0
						? ` These columns landed as text because they have no local equivalent: ${outcome.widenedColumns.join(", ")}.`
						: ""),
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
				`Delete the sync '${sync.name}'? ${sync.targetRelation} is left in place; ` +
					"nothing will rebuild it afterwards.",
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
					a named, re-runnable pull from one table into one dataset
				</span>
				<button className="btn sm" onClick={() => setAdding((open) => !open)}>
					{adding ? "Cancel" : "New sync"}
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
					Nothing is synced through this connection yet, so it has brought no data in.
					Declare one here, or commit a <span className="mono">*.sync.json</span> file to a
					transforms repository.
				</Empty>
			) : (
				<table className="dense">
					<thead>
						<tr>
							<th>Name</th>
							<th>Source</th>
							<th>Mode</th>
							<th>Lands in</th>
							<th>Last run</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{syncs.map((sync) => (
							<tr key={sync.id}>
								<td>{sync.name}</td>
								<td className="mono">
									{sync.sourcePath ?? `${sync.sourceSchema}.${sync.sourceTable}`}
									{sync.recordsPath ? ` → ${sync.recordsPath}` : ""}
								</td>
								<td>
									{sync.mode}
									{sync.cursorColumn ? ` (${sync.cursorColumn})` : ""}
								</td>
								<td className="mono">{sync.targetRelation}</td>
								<td className={sync.lastRun?.status === "failed" ? "error" : undefined}>
									{runSummary(sync)}
								</td>
								<td>
									<button
										className="btn sm"
										disabled={busy !== null}
										onClick={() => void run(sync)}
									>
										{busy === sync.id ? "Running…" : "Run"}
									</button>{" "}
									<button
										className="btn sm"
										disabled={busy !== null}
										onClick={() => void remove(sync)}
									>
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
 * Declaring a sync.
 *
 * The table list comes from the connection's own catalogue, which is also the
 * check that the connection can read it: information_schema only shows what
 * the caller has a privilege on.
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
	const [name, setName] = useState("");
	const [mode, setMode] = useState<"snapshot" | "incremental">("snapshot");
	const [cursorColumn, setCursorColumn] = useState("");
	const [rowLimit, setRowLimit] = useState(50_000);
	// REST: there is no catalogue to choose from, so the path is typed.
	const [sourcePath, setSourcePath] = useState("");
	const [recordsPath, setRecordsPath] = useState("");

	useEffect(() => {
		api
			.get<ConnectionCatalog>(`/api/resources/${resourceId}/catalog`)
			.then(setCatalog)
			.catch((exc: Error) => setError(exc.message));
	}, [resourceId]);

	const pick = (relation: RemoteRelation) => `${relation.schema}.${relation.name}`;

	const isRest = catalog?.connector === "rest";

	async function submit() {
		const [sourceSchema, sourceTable] = chosen.split(".");
		const fallbackName = isRest
			? sourcePath.split("?")[0]!.split("/").filter(Boolean).pop() || "records"
			: sourceTable;
		setBusy(true);
		setError(null);
		try {
			const created = await api.post<SyncRecord>(`/api/resources/${resourceId}/syncs`, {
				name: name.trim() || fallbackName,
				...(isRest
					? { sourcePath: sourcePath.trim(), recordsPath: recordsPath.trim() || null }
					: { sourceSchema, sourceTable }),
				mode,
				cursorColumn: mode === "incremental" ? cursorColumn.trim() : null,
				rowLimit,
			});
			onDone(`Declared '${created.name}'. It lands in ${created.targetRelation} when you run it.`);
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
			{isRest ? (
				<>
					<label className="field">
						<span>Path on {catalog.connection}</span>
						<input
							value={sourcePath}
							placeholder="/orders"
							onChange={(event) => setSourcePath(event.target.value)}
						/>
						<span className="field-hint">
							{catalog.note ?? "Appended to the connection's base URL."}
						</span>
					</label>
					<label className="field">
						<span>Records path</span>
						<input
							value={recordsPath}
							placeholder="data.items — leave empty if the response is already a list"
							onChange={(event) => setRecordsPath(event.target.value)}
						/>
						<span className="field-hint">
							Where the rows sit inside the response. Getting this wrong would land the
							whole document as a single row, so the sync refuses rather than guesses —
							and tells you where the records look to be.
						</span>
					</label>
				</>
			) : (
				<label className="field">
					<span>Table or view on {catalog.connection}</span>
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
						{catalog.relations.length} readable by this connection's user.
					</span>
				</label>
			)}

			<label className="field">
				<span>Name</span>
				<input
					value={name}
					placeholder={
						isRest
							? sourcePath.split("?")[0]!.split("/").filter(Boolean).pop() || "records"
							: (chosen.split(".")[1] ?? "orders")
					}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>

			<label className="field">
				<span>Mode</span>
				<select
					value={mode}
					onChange={(event) => setMode(event.target.value as "snapshot" | "incremental")}
				>
					<option value="snapshot">Snapshot — rebuild the table each run</option>
					<option value="incremental">Incremental — append rows past a cursor</option>
				</select>
				<span className="field-hint">
					{mode === "snapshot"
						? "The table is exactly what the source holds now. It cannot keep rows the source has since deleted."
						: "Cheaper, and wrong if the source edits rows in place without moving the cursor."}
				</span>
			</label>

			{mode === "incremental" && (
				<label className="field">
					<span>{isRest ? "Cursor field" : "Cursor column"}</span>
					<input
						value={cursorColumn}
						placeholder="updated_at"
						onChange={(event) => setCursorColumn(event.target.value)}
					/>
					<span className="field-hint">
						{isRest
							? "The field whose increasing value says which records are new. It is sent back as a query parameter of the same name on the next run."
							: "The column whose increasing value says which rows are new."}
					</span>
				</label>
			)}

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
					A run holds its result in memory before writing it. One that reaches this limit says
					so rather than reporting a partial table as complete.
				</span>
			</label>

			{error && <div className="banner error">{error}</div>}
			<div className="row">
				<button
					className="btn primary sm"
					disabled={busy || (isRest ? !sourcePath.trim() : !chosen)}
					onClick={submit}
				>
					{busy ? "Checking the source…" : "Declare sync"}
				</button>
			</div>
		</div>
	);
}
