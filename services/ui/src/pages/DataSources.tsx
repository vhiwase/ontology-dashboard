/**
 * Data: the databases this workspace reads, and the tables it copied from them.
 *
 * Each imported table is a sync - a snapshot pulled on demand - so this page is
 * also where data is refreshed. A refresh re-reads the source table and every
 * object type, metric and board built on it follows, because they all read the
 * synced copy through views.
 *
 * A database or a single table can be deleted from here. A table is a copy, so
 * deleting it removes the copy and stops it being refreshed; what was modelled
 * on it is listed in the confirmation and goes with it only if that is agreed.
 */

import { useCallback, useEffect, useState } from "react";
import { type SyncRecord, api } from "../api";
import { ConnectWizard } from "../components/ConnectWizard";
import { ErrorBanner, PageLoader, Spinner } from "../components/common";
import { DeleteButton, DeleteDialog, type RemovableKind, deletedNotice, useCanDelete } from "../components/DeleteDialog";
import { Icon } from "../components/icons";
import { useResources } from "../ResourceContext";
import { useSpace } from "../SpaceContext";

interface ConnectionView {
	id: number;
	name: string;
	description: string | null;
	syncs: SyncRecord[] | null;
}

function ago(iso: string | null | undefined): string {
	if (!iso) return "never";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return new Date(iso).toLocaleDateString();
}

export function DataSources() {
	const { resources, loading, refresh } = useResources();
	const { reload } = useSpace();
	const [connections, setConnections] = useState<ConnectionView[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [wizard, setWizard] = useState<{ id: number; name: string } | "new" | null>(null);
	const [running, setRunning] = useState<Set<number>>(new Set());
	// What is being deleted: a database, or one of its tables.
	const [removing, setRemoving] = useState<{
		kind: RemovableKind;
		target: number;
		label: string;
		noun: string;
	} | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const canDelete = useCanDelete();

	const load = useCallback(async () => {
		const list = resources.filter((resource) => resource.kind === "connection");
		const views: ConnectionView[] = list.map((resource) => ({
			id: resource.id,
			name: resource.name,
			description: resource.description,
			syncs: null,
		}));
		setConnections(views);
		const withSyncs = await Promise.all(
			views.map(async (view) => ({
				...view,
				syncs: await api.get<SyncRecord[]>(`/api/resources/${view.id}/syncs`).catch(() => []),
			})),
		);
		setConnections(withSyncs);
	}, [resources]);

	useEffect(() => {
		if (!loading) void load().catch((exc: Error) => setError(exc.message));
	}, [loading, load]);

	async function resync(ids: number[]) {
		setRunning((current) => new Set([...current, ...ids]));
		setError(null);
		try {
			for (const id of ids) await api.post(`/api/syncs/${id}/run`, {});
			await load();
			reload();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setRunning((current) => {
				const next = new Set(current);
				for (const id of ids) next.delete(id);
				return next;
			});
		}
	}

	if (loading || !connections) return <PageLoader label="Loading your data sources" />;

	// Copied tables that nothing here refreshes any more: deleting a database
	// (or one table's import) keeps what had been copied, and what is modelled
	// on those tables goes on reading them. Listed so that they can still be
	// seen - and deleted - once nothing lists them under a database.
	const refreshed = new Set(
		connections.flatMap((connection) => (connection.syncs ?? []).map((sync) => Number(sync.datasetResourceId))),
	);
	const kept = connections.some((connection) => connection.syncs === null)
		? []
		: resources.filter((resource) => resource.kind === "dataset" && !refreshed.has(resource.id));

	return (
		<div className="page">
			<header className="page-head">
				<div>
					<h1>Data</h1>
					<p className="page-lede">
						The databases this workspace reads and the tables copied from them. Refreshing a table re-reads it
						from the source; every metric and board built on it follows.
					</p>
				</div>
				<button className="btn primary" onClick={() => setWizard("new")}>
					<Icon name="plug" size={15} />
					Connect a database
				</button>
			</header>

			{error && <ErrorBanner error={error} />}
			{notice && (
				<p className="rb-notice" role="status">
					{notice}
				</p>
			)}

			{connections.length === 0 ? (
				<div className="empty-state">
					<div className="empty-state-mark" aria-hidden>
						<Icon name="database" size={24} />
					</div>
					<h3>No databases connected yet</h3>
					<p>Connect a PostgreSQL database to bring its tables in. Nothing is ever written back to it.</p>
					<button className="btn primary" onClick={() => setWizard("new")}>
						<Icon name="plug" size={15} />
						Connect your database
					</button>
				</div>
			) : (
				connections.map((connection) => (
					<section key={connection.id} className="panel">
						<header className="panel-head">
							<span className="source-glyph" aria-hidden>
								<Icon name="database" size={18} />
							</span>
							<div>
								<h2>{connection.name}</h2>
								<span className="muted" style={{ fontSize: 12 }}>
									{connection.description}
								</span>
							</div>
							<div className="row" style={{ marginLeft: "auto", gap: 6 }}>
								<button
									className="btn sm"
									disabled={!connection.syncs?.length || connection.syncs.some((s) => running.has(s.id))}
									onClick={() => void resync((connection.syncs ?? []).map((s) => s.id))}
								>
									<Icon name="refresh" size={13} />
									Refresh all
								</button>
								<button className="btn sm" onClick={() => setWizard({ id: connection.id, name: connection.name })}>
									<Icon name="download" size={13} />
									Import more tables
								</button>
								{canDelete && (
									<DeleteButton
										title={`Delete the database ${connection.name}`}
										onClick={() =>
											setRemoving({ kind: "connection", target: connection.id, label: connection.name, noun: "database" })
										}
									/>
								)}
							</div>
						</header>
						{connection.syncs === null ? (
							<Spinner />
						) : connection.syncs.length === 0 ? (
							<p className="muted">No tables imported from this database yet.</p>
						) : (
							<div className="table-wrap">
								<table className="data">
									<thead>
										<tr>
											<th>Table</th>
											<th style={{ textAlign: "right" }}>Rows</th>
											<th>Last refreshed</th>
											<th>Status</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{connection.syncs.map((sync) => {
											const run = sync.lastRun;
											return (
												<tr key={sync.id}>
													<td>
														<strong>{sync.sourceTable}</strong>
														<span className="muted"> · {sync.sourceSchema}</span>
													</td>
													<td className="n">{(run?.rowsAfter ?? run?.rowsWritten ?? 0).toLocaleString("en-US")}</td>
													<td className="muted">{ago(run?.finishedAt ?? run?.startedAt)}</td>
													<td>
														{run?.status === "failed" ? (
															<span className="chip critical" title={run.errorMessage ?? undefined}>
																<span className="dot" aria-hidden /> failed
															</span>
														) : run?.truncated ? (
															<span className="chip warning" title="Stopped at the row limit">
																<span className="dot" aria-hidden /> partial
															</span>
														) : (
															<span className="chip good" title="A snapshot of the source table at the time shown">
																<span className="dot" aria-hidden /> synced
															</span>
														)}
													</td>
													<td style={{ textAlign: "right" }}>
														<span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
															<button className="btn sm" disabled={running.has(sync.id)} onClick={() => void resync([sync.id])}>
																{running.has(sync.id) ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={13} />}
																{running.has(sync.id) ? "Refreshing…" : "Refresh"}
															</button>
															{canDelete && (
																<DeleteButton
																	iconOnly
																	title={`Delete the table ${sync.sourceTable}`}
																	disabled={running.has(sync.id)}
																	onClick={() =>
																		// The copied table is the dataset; a table that has
																		// never been refreshed has only its sync to delete.
																		setRemoving(
																			sync.datasetResourceId !== null && sync.datasetResourceId !== undefined
																				? { kind: "dataset", target: Number(sync.datasetResourceId), label: sync.sourceTable, noun: "table" }
																				: { kind: "sync", target: sync.id, label: sync.sourceTable, noun: "table" },
																		)
																	}
																/>
															)}
														</span>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}
					</section>
				))
			)}

			{kept.length > 0 && (
				<section className="panel kept-tables">
					<header className="panel-head">
						<span className="source-glyph" aria-hidden>
							<Icon name="table" size={18} />
						</span>
						<div>
							<h2>Tables no longer refreshed</h2>
							<span className="muted" style={{ fontSize: 12 }}>
								Their database, or their import from it, was removed. They keep the rows they had, and what is
								built on them still works. Delete one here when it is no longer needed.
							</span>
						</div>
					</header>
					<div className="table-wrap">
						<table className="data">
							<thead>
								<tr>
									<th>Table</th>
									<th style={{ textAlign: "right" }}>Rows</th>
									<th>Last refreshed</th>
									<th>Status</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{kept.map((dataset) => {
									const source = typeof dataset.properties.source === "string" ? dataset.properties.source : null;
									const schema = source?.includes(".") ? source.split(".")[0] : null;
									const rows = Number(dataset.properties.rowCount);
									const refreshedAt =
										typeof dataset.properties.lastSyncedAt === "string" ? dataset.properties.lastSyncedAt : null;
									return (
										<tr key={dataset.id}>
											<td>
												<strong>{dataset.name}</strong>
												{schema && <span className="muted"> · {schema}</span>}
											</td>
											<td className="n">{Number.isFinite(rows) ? rows.toLocaleString("en-US") : "—"}</td>
											<td className="muted">{ago(refreshedAt)}</td>
											<td>
												<span className="chip" title="Nothing refreshes it any more">
													<span className="dot" aria-hidden /> not refreshed
												</span>
											</td>
											<td style={{ textAlign: "right" }}>
												{canDelete && (
													<DeleteButton
														iconOnly
														title={`Delete the table ${dataset.name}`}
														onClick={() =>
															setRemoving({ kind: "dataset", target: dataset.id, label: dataset.name, noun: "table" })
														}
													/>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</section>
			)}

			{wizard && (
				<ConnectWizard
					existing={wizard === "new" ? null : wizard}
					onClose={() => setWizard(null)}
					onImported={() => void refresh()}
				/>
			)}

			{removing && (
				<DeleteDialog
					kind={removing.kind}
					target={removing.target}
					label={removing.label}
					noun={removing.noun}
					onClose={() => setRemoving(null)}
					onDeleted={(plan) => {
						setNotice(deletedNotice(plan, removing.noun));
						setRemoving(null);
						setError(null);
						// The page's own list follows the shared one; the counts on the
						// home page and in the navigation are read again too.
						void refresh();
						reload();
					}}
				/>
			)}
		</div>
	);
}
