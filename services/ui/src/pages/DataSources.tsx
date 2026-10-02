/**
 * Data: the databases this workspace reads, and the tables it copied from them.
 *
 * Each imported table is a sync - a snapshot pulled on demand - so this page is
 * also where data is refreshed. A refresh re-reads the source table and every
 * object type, metric and board built on it follows, because they all read the
 * synced copy through views.
 */

import { useCallback, useEffect, useState } from "react";
import { type SyncRecord, api } from "../api";
import { ConnectWizard } from "../components/ConnectWizard";
import { ErrorBanner, Spinner } from "../components/common";
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

	if (loading || !connections) return <Spinner label="Loading your data sources" />;

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
					Connect a database
				</button>
			</header>

			{error && <ErrorBanner error={error} />}

			{connections.length === 0 ? (
				<div className="empty-state">
					<div className="empty-state-mark" aria-hidden>
						⛁
					</div>
					<h3>No databases connected yet</h3>
					<p>Connect a PostgreSQL database to bring its tables in. Nothing is ever written back to it.</p>
					<button className="btn primary" onClick={() => setWizard("new")}>
						Connect your database
					</button>
				</div>
			) : (
				connections.map((connection) => (
					<section key={connection.id} className="panel">
						<header className="panel-head">
							<span className="source-glyph" aria-hidden>
								⛁
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
									Refresh all
								</button>
								<button className="btn sm" onClick={() => setWizard({ id: connection.id, name: connection.name })}>
									Import more tables
								</button>
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
														<button className="btn sm" disabled={running.has(sync.id)} onClick={() => void resync([sync.id])}>
															{running.has(sync.id) ? "Refreshing…" : "Refresh"}
														</button>
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

			{wizard && (
				<ConnectWizard
					existing={wizard === "new" ? null : wizard}
					onClose={() => setWizard(null)}
					onImported={() => void refresh()}
				/>
			)}
		</div>
	);
}
