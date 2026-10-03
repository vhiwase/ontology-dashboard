/**
 * The resources registered in the current space, shared by the nav badges and
 * the resource browser.
 *
 * One load per space rather than one per component: every nav badge loading
 * the project trees would be the same requests repeated on every page.
 *
 * Whatever adds or removes a resource calls refresh(), so the list and the
 * badge beside "Datasets" follow the change rather than waiting for the next
 * page load: deleting one, running a sync (its first run is what registers
 * its dataset), the assistant building something, and any reload of the space.
 * A sync used to refresh only its own table, which left a newly synced dataset
 * missing from the Datasets page until the browser was reloaded.
 */

import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type ResourceKind, api, isMissingOntology } from "./api";
import { useSpace } from "./SpaceContext";

export interface BrowseResource {
	id: number;
	kind: ResourceKind;
	name: string;
	description: string | null;
	targetRef: string | null;
	backingView: string | null;
	folderId: number | null;
	properties: Record<string, unknown>;
	updatedAt: string;
}

interface ResourceContextValue {
	resources: BrowseResource[];
	/** Null while loading, so a badge shows nothing rather than a false zero. */
	counts: Partial<Record<ResourceKind, number>> | null;
	projectName: string | null;
	loading: boolean;
	refresh: () => Promise<void>;
}

const ResourceContext = createContext<ResourceContextValue>({
	resources: [],
	counts: null,
	projectName: null,
	loading: true,
	refresh: async () => {},
});

export function ResourceProvider({ children }: { children: ReactNode }) {
	const { spaceSlug, spaces } = useSpace();
	const [resources, setResources] = useState<BrowseResource[]>([]);
	const [projectName, setProjectName] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// The space whose resources are on screen, and the latest request made:
	// an answer for a space that has since been left must not be shown.
	const shownFor = useRef<string | null>(null);
	const latest = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latest.current;
		// Only the first load of a space shows as loading. A refresh after a
		// change keeps the list on screen and swaps it when the new one arrives,
		// so the badges do not blink out and back.
		if (shownFor.current !== spaceSlug) {
			shownFor.current = spaceSlug;
			setLoading(true);
			setResources([]);
		}
		try {
			// Every project in the space: a dataset lands in its connection's
			// project and the ontology's cards in the space's oldest one, so
			// reading only one project would hide whatever lives in the others.
			const projects = await api.get<Array<{ slug: string; name: string }>>(
				`/api/spaces/${spaceSlug}/projects`,
			);
			const trees = await Promise.all(
				projects.map((project) =>
					api.get<{ resources: BrowseResource[] }>(
						`/api/spaces/${spaceSlug}/projects/${project.slug}/tree`,
					),
				),
			);
			if (request !== latest.current) return;
			// Ids are BIGINTs, which the server sends as text. Made numbers here,
			// once, so an id from this list equals the same id from any other
			// route (a sync names its dataset by number).
			setResources(
				trees.flatMap((tree) =>
					tree.resources.map((resource) => ({
						...resource,
						id: Number(resource.id),
						folderId: resource.folderId === null || resource.folderId === undefined ? null : Number(resource.folderId),
					})),
				),
			);
			setProjectName(
				projects.length === 0 ? null : projects.length === 1 ? projects[0]!.name : `${projects.length} projects`,
			);
		} catch (exc) {
			// A space with nothing published has nothing to count. That is a
			// normal state, not a failure worth surfacing in the navigation.
			if (request !== latest.current) return;
			if (!isMissingOntology(exc)) console.warn("Could not load resources", exc);
			setResources([]);
			setProjectName(null);
		} finally {
			if (request === latest.current) setLoading(false);
		}
	}, [spaceSlug]);

	// Read again whenever the space's own data is re-read (`spaces` is replaced
	// by every reload): an approval, an import or the assistant can each have
	// registered something new.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `spaces` is the trigger
	useEffect(() => {
		void refresh();
	}, [refresh, spaces]);

	const value = useMemo<ResourceContextValue>(() => {
		const counts: Partial<Record<ResourceKind, number>> = {};
		for (const resource of resources) {
			counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
		}
		return { resources, counts: loading ? null : counts, projectName, loading, refresh };
	}, [resources, projectName, loading, refresh]);

	return <ResourceContext.Provider value={value}>{children}</ResourceContext.Provider>;
}

export function useResources(): ResourceContextValue {
	return useContext(ResourceContext);
}
