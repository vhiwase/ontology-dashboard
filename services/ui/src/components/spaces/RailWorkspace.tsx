/**
 * The workspace, in the nav rail.
 *
 * This lived on the Spaces page, which meant that to see what the platform
 * actually holds — which object types, which metrics, what each is read from —
 * you had to navigate away from whatever you were doing. That is the wrong
 * shape for the question, because "what is this metric backed by" is something
 * you ask WHILE looking at a dashboard, not instead of.
 *
 * So it sits under the navigation, always available, following the space
 * selector like everything else.
 *
 * It is collapsed by default. The rail's job is navigation; a hundred and
 * thirty-odd resource rows expanded on every page load would bury it.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, isMissingOntology } from "../../api";
import { useSpace } from "../../SpaceContext";
import { ResourcePreview } from "./ResourcePreview";
import { type PanelResource, WorkspacePanel } from "./WorkspacePanel";

interface Tree {
	project: { slug: string; name: string };
	resources: PanelResource[];
}

const STORAGE_KEY = "tms.rail.workspace.open";

export function RailWorkspace() {
	const { spaceSlug } = useSpace();
	const [open, setOpen] = useState<boolean>(() => {
		try {
			return window.localStorage.getItem(STORAGE_KEY) === "1";
		} catch {
			return false;
		}
	});
	const [tree, setTree] = useState<Tree | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [previewId, setPreviewId] = useState<number | null>(null);
	const [deletingId, setDeletingId] = useState<number | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			// The first project in the space. The rail shows one workspace rather
			// than a project picker: picking between projects is what the Spaces
			// page is for, and the rail should not grow a second navigation.
			const projects = await api.get<Array<{ slug: string; name: string }>>(
				`/api/spaces/${spaceSlug}/projects`,
			);
			const first = projects[0];
			if (!first) {
				setTree(null);
				return;
			}
			setTree(
				await api.get<Tree>(`/api/spaces/${spaceSlug}/projects/${first.slug}/tree`),
			);
		} catch (exc) {
			// A space with no ontology has no resources to list, which is a normal
			// state rather than a failure worth a red banner in the navigation.
			if (isMissingOntology(exc)) {
				setTree(null);
				return;
			}
			setError(exc instanceof ApiError ? exc.message : String(exc));
		}
	}, [spaceSlug]);

	// Only fetched once opened: an unopened panel should cost nothing on every
	// page load. Re-fetched when the space changes so it never shows another
	// space's contents.
	useEffect(() => {
		if (!open) return;
		void load();
	}, [open, load]);

	function toggle() {
		setOpen((current) => {
			const next = !current;
			try {
				window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
			} catch {
				/* the choice still applies for this tab */
			}
			return next;
		});
	}

	return (
		<div className={`rail-ws ${open ? "open" : ""}`}>
			<button className="rail-ws-head" onClick={toggle} aria-expanded={open}>
				<span className="rail-ws-caret" aria-hidden>
					{open ? "▾" : "▸"}
				</span>
				<span className="rail-ws-title">{tree?.project.name ?? "Workspace"}</span>
				{tree && <span className="rail-ws-count">{tree.resources.length}</span>}
			</button>

			{open && (
				<div className="rail-ws-body">
					{error ? (
						<p className="rail-ws-note">{error}</p>
					) : !tree ? (
						<p className="rail-ws-note">
							Nothing registered in this space yet.
						</p>
					) : (
						<WorkspacePanel
							resources={tree.resources}
							selectedId={previewId}
							onSelect={(resource) => setPreviewId(resource.id)}
							busyId={deletingId}
							onDelete={async (resource) => {
								setDeletingId(resource.id);
								try {
									await api.del(`/api/resources/${resource.id}`);
									setPreviewId((current) =>
										current === resource.id ? null : current,
									);
									await load();
								} catch (exc) {
									setError(exc instanceof ApiError ? exc.message : String(exc));
								} finally {
									setDeletingId(null);
								}
							}}
						/>
					)}
				</div>
			)}

			{/* The preview opens over the page, not inside the rail: a resource
			    detail squeezed into 215px would be unreadable. */}
			<ResourcePreview resourceId={previewId} onClose={() => setPreviewId(null)} />
		</div>
	);
}
