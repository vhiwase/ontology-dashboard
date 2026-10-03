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
 * (see resourceData.ts on the server): a dataset shows what its sync copied, a
 * metric the dataset it is computed from, a link its actual source -> target
 * pairs, a connection the views it can read. "Open full data" pages through
 * all of it in the grid window.
 *
 * Two kinds carry the next step of the flow on their page: a connection its
 * syncs and how often each runs, a dataset the object type made from it.
 *
 * The list is read again on every visit. Resources are registered from
 * elsewhere too - a scheduled sync's first run, the assistant, another
 * person - and a list loaded once per sign-in would not show them.
 *
 * Delete deletes the thing, not its card. The x that used to sit on each row
 * only unregistered the card, which for a metric, a type, a link or an action
 * came back with the next change to the ontology, and for a dataset with its
 * next sync. It now opens the same confirmation as everywhere else, which
 * lists what goes with it first.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, session } from "../api";
import { useResources, type BrowseResource } from "../ResourceContext";
import { useSpace } from "../SpaceContext";
import { DataGrid, type DataPage } from "../components/data/DataGrid";
import { CreateObjectTypeDialog } from "../components/ontology/CreateObjectTypeDialog";
import { AddDatasetDialog } from "../components/spaces/AddDatasetDialog";
import { SyncPanel } from "../components/spaces/SyncPanel";
import { BROWSE_KINDS, RESOURCE_SPECS } from "../components/spaces/resourceKinds";
import { ConnectionDialog } from "../components/spaces/ConnectionDialog";
import {
	DeleteButton,
	DeleteDialog,
	type RemovableKind,
	deletedNotice,
	useCanDelete,
} from "../components/DeleteDialog";
import { Empty, ErrorBanner, Spinner } from "../components/common";
import { Icon } from "../components/icons";

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

/** What a card stands for, as the server's delete knows it - or null for a card that stands for nothing. */
function removalTarget(resource: BrowseResource): { kind: RemovableKind; target: string | number } | null {
	switch (resource.kind) {
		case "connection":
		case "dataset":
			return { kind: resource.kind, target: resource.id };
		case "objectType":
		case "linkType":
		case "actionType":
			return resource.targetRef ? { kind: resource.kind, target: resource.targetRef } : null;
		case "kpi":
			return resource.targetRef ? { kind: "metric", target: resource.targetRef } : null;
		case "dashboard":
			return resource.targetRef ? { kind: "dashboard", target: resource.targetRef } : null;
		default:
			return null;
	}
}

export function ResourceBrowser() {
	const { kind: slug } = useParams<{ kind: string }>();
	const entry = BROWSE_KINDS.find((item) => item.slug === slug) ?? BROWSE_KINDS[0]!;
	const spec = RESOURCE_SPECS[entry.kind];
	const { resources, loading, refresh } = useResources();
	const { spaceSlug, space, reload } = useSpace();

	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState<number | null>(null);
	// The resource whose deletion is being confirmed.
	const [removing, setRemoving] = useState<BrowseResource | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [gridOpen, setGridOpen] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [addingDataset, setAddingDataset] = useState(false);
	const role = session.user()?.role;
	const canWrite = role === "admin" || role === "analyst";
	const canDelete = useCanDelete();

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
		setRemoving(null);
		setSelectedId(null);
		setNotice(null);
		setError(null);
	}, [entry.kind, spaceSlug]);

	// Opening a list re-reads it, so what was registered since the last look
	// is there. It is a quiet refresh: the list on screen stays until the new
	// one arrives.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per list opened
	useEffect(() => {
		void refresh();
	}, [entry.kind]);

	const connections = useMemo(
		() => resources.filter((resource) => resource.kind === "connection").sort((a, b) => a.name.localeCompare(b.name)),
		[resources],
	);

	useEffect(() => {
		if (selectedId === null || !items.some((item) => item.id === selectedId)) {
			setSelectedId(items[0]?.id ?? null);
		}
	}, [items, selectedId]);

	const selected = items.find((item) => item.id === selectedId) ?? null;
	const removingTarget = removing ? removalTarget(removing) : null;

	return (
		<div className="rb">
			<aside className="rb-list card">
				<div className="rb-list-head">
					<span className="rb-glyph" style={{ color: spec.accent }} aria-hidden>
						<Icon name={spec.icon} size={15} />
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
				{/* Creating a connection used to exist only inside /spaces, three
				    clicks into a project — so the page named "Connections" was the
				    one place you could not make one. */}
				{entry.kind === "connection" && canWrite && (
					<button
						className="btn sm"
						style={{ margin: "0 8px 8px" }}
						onClick={() => setCreating(true)}
						>
							<Icon name="plus" size={13} />
							New connection
						</button>
				)}
				{/* The same gap, one step along: a dataset could only be added from
				    a connection's page, so the page that lists them had no way in. */}
				{entry.kind === "dataset" && canWrite && (
					<button className="btn sm" style={{ margin: "0 8px 8px" }} onClick={() => setAddingDataset(true)}>
						<Icon name="plus" size={13} />
						Add dataset
					</button>
				)}
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
							{canDelete && removalTarget(resource) && (
								<button
									className="wsp-delete"
									onClick={() => setRemoving(resource)}
									title={`Delete ${resource.name}`}
									aria-label={`Delete ${resource.name}`}
								>
									<Icon name="trash" size={14} />
								</button>
							)}
						</li>
					))}
				</ul>
				{canDelete && (
					<p className="rb-foot muted">
						Deleting one removes the {spec.label.toLowerCase()} itself, not only its entry here. What goes with it
						is listed before anything is removed.
					</p>
				)}
			</aside>

			<section className="rb-detail">
				{error && <ErrorBanner error={error} />}
				{notice && <p className="rb-notice">{notice}</p>}
				{selected ? (
					<ResourceDetail
						resource={selected}
						kindLabel={spec.label}
						canWrite={canWrite}
						onDelete={canDelete && removalTarget(selected) ? () => setRemoving(selected) : null}
						onOpenGrid={() => setGridOpen(true)}
						onChanged={(message) => {
							setNotice(message);
							void refresh();
						}}
					/>
				) : (
					<div className="card">
						<Empty>Choose one on the left to see its data.</Empty>
					</div>
				)}
			</section>

			{addingDataset && (
				<div
					className="rb-dialog-backdrop"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setAddingDataset(false);
					}}
				>
					<div className="rb-dialog">
						<AddDatasetDialog
							connections={connections}
							onClose={() => setAddingDataset(false)}
							onDone={(message, datasetResourceId) => {
								setAddingDataset(false);
								setNotice(message);
								// The new dataset is opened once the list has it.
								void refresh().then(() => {
									if (datasetResourceId !== null) setSelectedId(datasetResourceId);
								});
							}}
						/>
					</div>
				</div>
			)}

			{creating && (
				<div className="rb-dialog-backdrop">
					<div className="rb-dialog">
						<ConnectionDialog
							spaceSlug={spaceSlug}
							projectSlug={null}
							onClose={() => setCreating(false)}
							onDone={(message) => {
								setCreating(false);
								setNotice(message);
								void refresh();
							}}
						/>
					</div>
				</div>
			)}

			<DataGrid
				resourceId={gridOpen && selected ? selected.id : null}
				title={selected?.name ?? ""}
				onClose={() => setGridOpen(false)}
			/>

			{removing && removingTarget && (
				<DeleteDialog
					kind={removingTarget.kind}
					target={removingTarget.target}
					label={removing.name}
					onClose={() => setRemoving(null)}
					onDeleted={(plan) => {
						setRemoving(null);
						setError(null);
						setNotice(deletedNotice(plan));
						// The lists, and the counts beside them in the navigation.
						void refresh();
						reload();
					}}
				/>
			)}
		</div>
	);
}

function ResourceDetail({
	resource,
	kindLabel,
	canWrite,
	onDelete,
	onOpenGrid,
	onChanged,
}: {
	resource: BrowseResource;
	kindLabel: string;
	canWrite: boolean;
	/** Null when this person may not delete here, or the card stands for nothing. */
	onDelete: (() => void) | null;
	onOpenGrid: () => void;
	onChanged: (message: string) => void;
}) {
	const [data, setData] = useState<DataPage | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [modelling, setModelling] = useState(false);
	const modelledAs = (preview?.lineage?.downstream ?? []).filter((entry) => entry.kind === "objectType");

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
					{resource.kind === "dataset" && canWrite && (
						<button
							className="btn sm primary"
							style={{ marginLeft: "auto" }}
							onClick={() => setModelling(true)}
							title="Model this dataset as an object type, a property per column"
							>
								<Icon name="plus" size={13} />
								Create object type
							</button>
					)}
					<button
						className="btn sm"
						style={{ marginLeft: resource.kind === "dataset" && canWrite ? 6 : "auto" }}
						onClick={onOpenGrid}
						disabled={!data || data.total === 0}
						title={data && data.total === 0 ? "There are no rows to open." : undefined}
						>
							<Icon name="maximize" size={13} />
							Open full data
						</button>
					{onDelete && <DeleteButton onClick={onDelete} title={`Delete ${resource.name}`} />}
				</div>
				{resource.description && (
					<p className="secondary" style={{ margin: "0 0 10px" }}>
						{resource.description}
					</p>
				)}
				<dl className="kv">
					{resource.kind === "dataset" && (
						<>
							<dt>Synced from</dt>
							<dd className="mono">
								{String(resource.properties.source ?? "—")} via{" "}
								{String(resource.properties.connectionName ?? "?")}
							</dd>
							<dt>Last synced</dt>
							<dd className="mono">
								{resource.properties.lastSyncedAt
									? new Date(String(resource.properties.lastSyncedAt)).toLocaleString()
									: "never"}
							</dd>
							<dt>Modelled as</dt>
							<dd className="mono">
								{modelledAs.length ? modelledAs.map((entry) => entry.name).join(", ") : "not yet"}
							</dd>
						</>
					)}
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

			{resource.kind === "connection" && (
				<div className="card">
					<SyncPanel resourceId={resource.id} />
				</div>
			)}

			{modelling && (
				<div className="rb-dialog-backdrop">
					<div className="rb-dialog rb-dialog-wide">
						<CreateObjectTypeDialog
							dataset={resource.targetRef ?? resource.name}
							onClose={() => setModelling(false)}
							onCreated={(apiName) => {
								setModelling(false);
								onChanged(`Created the ${apiName} object type from ${resource.name}.`);
							}}
						/>
					</div>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>{resource.kind === "connection" ? "Views it can read" : "Preview"}</h3>
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
