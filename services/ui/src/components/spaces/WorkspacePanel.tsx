/**
 * The workspace panel: everything this space holds, grouped by kind.
 *
 * The tree that preceded this showed folders, which is how the resources are
 * FILED — but almost nobody arrives asking "what is in the Connections
 * folder". They arrive asking "which object types are there", "what is this
 * metric read from", "what did the pipeline register". So this groups by kind
 * and puts the backing relation on every row, because
 * `tms_views.v_kpi_mode_mix` is the thing that makes a metric checkable.
 *
 * Every row can be deleted. That is deliberate and slightly dangerous, so the
 * button is not a single click: see the confirm state below.
 */

import { useMemo, useState } from "react";
import { RESOURCE_SPECS, type ResourceKind } from "./resourceKinds";

/**
 * Only the fields this panel reads.
 *
 * Narrower than the server's ResourceRecord on purpose: a component that asks
 * for the whole record forces every caller to carry fields it does not use,
 * and then breaks when the record gains one.
 */
export interface PanelResource {
	id: number;
	kind: ResourceKind;
	name: string;
	description: string | null;
	targetRef: string | null;
	backingView: string | null;
}

/**
 * The order the groups appear in, which follows the flow of the platform
 * rather than the alphabet: data comes in through a connection, lands as a
 * dataset, is modelled as ontology, and leaves as a dashboard.
 */
const GROUP_ORDER: ResourceKind[] = [
	"connection",
	"dataset",
	"objectType",
	"linkType",
	"actionType",
	"kpi",
	"pipeline",
	"dashboard",
];

/** The headings a reader expects, which are not always the kind's own plural. */
const GROUP_HEADINGS: Partial<Record<ResourceKind, string>> = {
	kpi: "Metrics",
	dashboard: "Outputs",
};

export function WorkspacePanel({
	resources,
	selectedId,
	onSelect,
	onDelete,
	busyId,
}: {
	resources: PanelResource[];
	selectedId: number | null;
	onSelect: (resource: PanelResource) => void;
	onDelete: (resource: PanelResource) => void;
	/** The row currently being deleted, so its button can show progress. */
	busyId: number | null;
}) {
	const [filter, setFilter] = useState("");
	const [collapsed, setCollapsed] = useState<Set<ResourceKind>>(new Set());
	// Which row is asking "are you sure". One at a time: a panel full of
	// half-armed delete buttons is its own hazard.
	const [confirming, setConfirming] = useState<number | null>(null);

	const groups = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const matching = needle
			? resources.filter(
					(r) =>
						r.name.toLowerCase().includes(needle) ||
						(r.backingView ?? "").toLowerCase().includes(needle) ||
						(r.targetRef ?? "").toLowerCase().includes(needle),
				)
			: resources;

		const byKind = new Map<ResourceKind, PanelResource[]>();
		for (const resource of matching) {
			const list = byKind.get(resource.kind);
			if (list) list.push(resource);
			else byKind.set(resource.kind, [resource]);
		}

		// Ordered by the flow above; anything with a kind not in that list still
		// appears, after the ones that are, rather than being dropped.
		const known = GROUP_ORDER.filter((kind) => byKind.has(kind));
		const extra = [...byKind.keys()].filter((kind) => !GROUP_ORDER.includes(kind));
		return [...known, ...extra].map((kind) => ({
			kind,
			items: (byKind.get(kind) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
		}));
	}, [resources, filter]);

	const total = groups.reduce((sum, group) => sum + group.items.length, 0);

	function toggle(kind: ResourceKind) {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});
	}

	return (
		<aside className="wsp">
			<div className="wsp-head">
				<input
					className="wsp-search"
					placeholder="Filter by name or view…"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<div className="wsp-count">
					{total} of {resources.length}
				</div>
			</div>

			<div className="wsp-scroll">
				{groups.length === 0 && (
					<p className="muted" style={{ padding: "12px 11px", fontSize: 11.5 }}>
						{resources.length === 0
							? "Nothing has been registered in this space yet."
							: "Nothing matches that filter."}
					</p>
				)}

				{groups.map(({ kind, items }) => {
					const spec = RESOURCE_SPECS[kind];
					const isCollapsed = collapsed.has(kind);
					return (
						<section className="wsp-group" key={kind}>
							<button
								className="wsp-group-head"
								onClick={() => toggle(kind)}
								aria-expanded={!isCollapsed}
							>
								<span className="wsp-caret" aria-hidden>
									{isCollapsed ? "▸" : "▾"}
								</span>
								<span className="wsp-glyph" style={{ color: spec?.accent }} aria-hidden>
									{spec?.glyph ?? "•"}
								</span>
								<span className="wsp-group-name">
									{GROUP_HEADINGS[kind] ?? spec?.plural ?? kind}
								</span>
								<span className="wsp-badge">{items.length}</span>
							</button>

							{!isCollapsed && (
								<ul className="wsp-list">
									{items.map((resource) => (
										<li
											key={resource.id}
											className={`wsp-item ${selectedId === resource.id ? "active" : ""}`}
										>
											<button
												className="wsp-item-main"
												onClick={() => onSelect(resource)}
												title={resource.description ?? resource.name}
											>
												<span className="wsp-item-name">{resource.name}</span>
												{/* The backing relation, which is what makes a metric or
												    an object type checkable against the warehouse. */}
												{resource.backingView && (
													<span className="wsp-item-view mono">{resource.backingView}</span>
												)}
											</button>

											{confirming === resource.id ? (
												<span className="wsp-confirm">
													<button
														className="wsp-confirm-yes"
														onClick={() => {
															setConfirming(null);
															onDelete(resource);
														}}
														disabled={busyId === resource.id}
													>
														{busyId === resource.id ? "…" : "Delete"}
													</button>
													<button
														className="wsp-confirm-no"
														onClick={() => setConfirming(null)}
													>
														Keep
													</button>
												</span>
											) : (
												<button
													className="wsp-delete"
													// Two steps, not one. These rows are the registry of
													// what the platform knows about; a mis-click next to
													// a name is far too easy otherwise.
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
							)}
						</section>
					);
				})}
			</div>

			<footer className="wsp-foot">
				Removing a card unregisters it from this workspace. The underlying view,
				object type or dashboard is not dropped.
			</footer>
		</aside>
	);
}
