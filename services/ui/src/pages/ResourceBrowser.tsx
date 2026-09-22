/**
 * One kind of resource: the list on the left, the selected one's data on the
 * right - the same shape as Object Explorer and Dashboards.
 *
 * This replaced a panel that expanded every kind inline inside the nav rail.
 * A hundred-odd rows stacked under the navigation buried it, and a resource's
 * name is not the useful part - its DATA is. So the rail now holds one entry
 * per kind, and choosing an entry opens this page.
 *
 * Every resource shows real rows. What those rows are depends on the kind
 * (see resourceData.ts on the server): a metric shows the view it is computed
 * from, a link shows its actual source -> target pairs, a connection lists the
 * tables it can read. "Open full data" pages through all of it in the grid
 * window.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, api, session } from "../api";
import { useResources, type BrowseResource } from "../ResourceContext";
import { useSpace } from "../SpaceContext";
import { DataGrid, type DataPage } from "../components/data/DataGrid";
import { DeletePipelineDialog } from "../components/pipeline/DeletePipelineDialog";
import { BROWSE_KINDS, RESOURCE_SPECS } from "../components/spaces/resourceKinds";
import { Empty, ErrorBanner, Spinner } from "../components/common";

interface LineageEntry {
	kind: string;
	name: string;
	relation: string;
	detail?: string | null;
}

interface Preview {
	lineage?: { upstream: LineageEntry[]; downstream: LineageEntry[] };
}

/** How many rows the inline preview shows before "Open full data". */
const PREVIEW_ROWS = 25;

export function ResourceBrowser() {
	const { kind: slug } = useParams<{ kind: string }>();
	const entry = BROWSE_KINDS.find((item) => item.slug === slug) ?? BROWSE_KINDS[0]!;
	const spec = RESOURCE_SPECS[entry.kind];
	const { resources, loading, refresh } = useResources();
	const { spaceSlug, space } = useSpace();

	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [confirming, setConfirming] = useState<number | null>(null);
	const [deleting, setDeleting] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [gridOpen, setGridOpen] = useState(false);
	const [deletingPipeline, setDeletingPipeline] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const isAdmin = session.user()?.role === "admin";

	const items = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return resources
			.filter((resource) => resource.kind === entry.kind)
			.filter(
				(resource) =>
					!needle ||
					resource.name.toLowerCase().includes(needle) ||
					(resource.backingView ?? "").toLowerCase().includes(needle),
			)
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [resources, entry.kind, filter]);

	// Changing kind or space starts from the first item of the new list, rather
	// than keeping an id that belongs to a different list.
	useEffect(() => {
		setFilter("");
		setConfirming(null);
		setSelectedId(null);
	}, [entry.kind, spaceSlug]);

	useEffect(() => {
		if (selectedId === null || !items.some((item) => item.id === selectedId)) {
			setSelectedId(items[0]?.id ?? null);
		}
	}, [items, selectedId]);

	const selected = items.find((item) => item.id === selectedId) ?? null;

	async function remove(resource: BrowseResource) {
		setDeleting(resource.id);
		setError(null);
		try {
			await api.del(`/api/resources/${resource.id}`);
			await refresh();
		} catch (exc) {
			setError(exc instanceof ApiError ? exc.message : String(exc));
		} finally {
			setDeleting(null);
			setConfirming(null);
		}
	}

	return (
		<div className="rb">
			<aside className="rb-list card">
				<div className="rb-list-head">
					<span className="rb-glyph" style={{ color: spec.accent }} aria-hidden>
						{spec.glyph}
					</span>
					<strong>{entry.label}</strong>
					<span className="wsp-badge">{items.length}</span>
				</div>
				<input
					className="rb-filter"
					placeholder="Filter by name or view…"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<ul className="rb-items">
					{loading && items.length === 0 && (
						<li className="muted rb-empty">Loading…</li>
					)}
					{!loading && items.length === 0 && (
						<li className="muted rb-empty">
							{filter
								? "Nothing matches that filter."
								: `No ${entry.label.toLowerCase()} registered in ${space?.name ?? spaceSlug}.`}
						</li>
					)}
					{items.map((resource) => (
						<li key={resource.id} className={`rb-item ${resource.id === selectedId ? "active" : ""}`}>
							<button className="rb-item-main" onClick={() => setSelectedId(resource.id)}>
								<span className="rb-item-name">{resource.name}</span>
								{resource.backingView && (
									<span className="rb-item-view mono">{resource.backingView}</span>
								)}
							</button>
							{confirming === resource.id ? (
								<span className="wsp-confirm">
									<button
										className="wsp-confirm-yes"
										onClick={() => void remove(resource)}
										disabled={deleting === resource.id}
									>
										{deleting === resource.id ? "…" : "Delete"}
									</button>
									<button className="wsp-confirm-no" onClick={() => setConfirming(null)}>
										Keep
									</button>
								</span>
							) : (
								<button
									className="wsp-delete"
									onClick={() => setConfirming(resource.id)}
									title={`Remove ${resource.name} from the workspace`}
									aria-label={`Remove ${resource.name}`}
								>
									×
								</button>
							)}
						</li>
					))}
				</ul>
				<p className="rb-foot muted">
					Removing a card unregisters it from the workspace. The view, object type or
					dashboard itself is not dropped.
				</p>
			</aside>

			<section className="rb-detail">
				{error && <ErrorBanner error={error} />}
				{notice && <p className="rb-notice">{notice}</p>}
				{selected ? (
					<ResourceDetail
						resource={selected}
						kindLabel={spec.label}
						onOpenGrid={() => setGridOpen(true)}
						// Deleting a PIPELINE, as opposed to unregistering its card.
						// The x on the card only removes it from the workspace; this
						// removes the pipeline and lets you choose its outputs.
						onDeletePipeline={
							entry.kind === "pipeline" && isAdmin && selected.targetRef
								? () => setDeletingPipeline(selected.targetRef)
								: undefined
						}
					/>
				) : (
					<div className="card">
						<Empty>Choose one on the left to see its data.</Empty>
					</div>
				)}
			</section>

			<DeletePipelineDialog
				slug={deletingPipeline}
				name={selected?.name ?? ""}
				onClose={() => setDeletingPipeline(null)}
				onDeleted={async (result) => {
					setDeletingPipeline(null);
					await refresh();
					setNotice(
						result.droppedOutputs.length > 0
							? `Deleted ${result.deleted} and dropped ${result.droppedOutputs.length} output table${result.droppedOutputs.length === 1 ? "" : "s"}.`
							: `Deleted ${result.deleted}.`,
					);
				}}
			/>

			<DataGrid
				resourceId={gridOpen && selected ? selected.id : null}
				title={selected?.name ?? ""}
				onClose={() => setGridOpen(false)}
			/>
		</div>
	);
}

function ResourceDetail({
	resource,
	kindLabel,
	onOpenGrid,
	onDeletePipeline,
}: {
	resource: BrowseResource;
	kindLabel: string;
	onOpenGrid: () => void;
	onDeletePipeline?: () => void;
}) {
	const [data, setData] = useState<DataPage | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setData(null);
		setPreview(null);
		setError(null);
		api
			.get<DataPage>(`/api/resources/${resource.id}/data?limit=${PREVIEW_ROWS}`)
			.then(setData)
			.catch((exc: Error) => setError(exc.message));
		// Lineage comes from the resource preview, which already resolves what a
		// resource reads from and what reads from it.
		api
			.get<Preview>(`/api/resources/${resource.id}/preview`)
			.then(setPreview)
			.catch(() => setPreview(null));
	}, [resource.id]);

	return (
		<>
			<div className="card">
				<div className="card-head">
					<div>
						<div className="rp-kind">{kindLabel.toUpperCase()}</div>
						<h3 style={{ fontSize: 16, margin: "2px 0 0" }}>{resource.name}</h3>
					</div>
					{onDeletePipeline && (
						<button
							className="btn sm ghost danger"
							style={{ marginLeft: "auto" }}
							onClick={onDeletePipeline}
						>
							Delete pipeline…
						</button>
					)}
					<button
						className="btn sm primary"
						style={{ marginLeft: onDeletePipeline ? 6 : "auto" }}
						onClick={onOpenGrid}
						disabled={!data || data.total === 0}
						title={data && data.total === 0 ? "There are no rows to open." : undefined}
					>
						Open full data
					</button>
				</div>
				{resource.description && (
					<p className="secondary" style={{ margin: "0 0 10px" }}>
						{resource.description}
					</p>
				)}
				<dl className="kv">
					<dt>Backed by</dt>
					<dd className="mono">{resource.backingView ?? "—"}</dd>
					<dt>Reads from</dt>
					<dd className="mono">{data?.source ?? "…"}</dd>
					<dt>Rows</dt>
					<dd className="mono">{data ? data.total.toLocaleString() : "…"}</dd>
					<dt>Columns</dt>
					<dd className="mono">{data ? data.columns.length : "…"}</dd>
				</dl>
			</div>

			<div className="card">
				<div className="card-head">
					<h3>Preview</h3>
					<span className="sub">
						{data
							? data.total > PREVIEW_ROWS
								? `first ${PREVIEW_ROWS} of ${data.total.toLocaleString()} rows`
								: `${data.total.toLocaleString()} row${data.total === 1 ? "" : "s"}`
							: ""}
					</span>
				</div>
				{error ? (
					<ErrorBanner error={error} />
				) : !data ? (
					<Spinner label="Reading rows" />
				) : (
					<>
						{data.note && <p className="dg-note">{data.note}</p>}
						{data.rows.length > 0 && (
							<div className="rb-preview">
								<table className="dg-table">
									<thead>
										<tr>
											<th className="dg-rownum" aria-label="Row" />
											{data.columns.map((column) => (
												<th key={column.name}>
													<div className="dg-colname">{column.name}</div>
													<div className="dg-coltype">{column.type}</div>
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{data.rows.map((row, index) => (
											<tr key={index}>
												<td className="dg-rownum mono">{index + 1}</td>
												{data.columns.map((column) => {
													const value = row[column.name];
													const isNull = value === null || value === undefined;
													const text = isNull
														? "null"
														: typeof value === "object"
															? JSON.stringify(value)
															: String(value);
													return (
														<td key={column.name} className={isNull ? "dg-null" : ""} title={text}>
															{text}
														</td>
													);
												})}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</>
				)}
			</div>

			{preview?.lineage &&
				(preview.lineage.upstream.length > 0 || preview.lineage.downstream.length > 0) && (
					<div className="card">
						<div className="card-head">
							<h3>Lineage</h3>
							<span className="sub">what this reads from, and what reads from it</span>
						</div>
						<div className="rb-lineage">
							<LineageList title="Upstream" entries={preview.lineage.upstream} />
							<LineageList title="Downstream" entries={preview.lineage.downstream} />
						</div>
					</div>
				)}
		</>
	);
}

function LineageList({ title, entries }: { title: string; entries: LineageEntry[] }) {
	return (
		<div>
			<h4 className="rb-lineage-title">{title}</h4>
			{entries.length === 0 ? (
				<p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
					Nothing.
				</p>
			) : (
				<ul className="rb-lineage-list">
					{entries.map((entry, index) => (
						<li key={`${entry.name}-${index}`}>
							<span className="muted">{entry.relation}</span>{" "}
							<span className="mono">{entry.name}</span>
							{entry.detail && <span className="muted"> · {entry.detail}</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
