/**
 * The resources registered in the current space, shared by the nav badges and
 * the resource browser.
 *
 * One load per space rather than one per component: every nav badge loading
 * the project trees would be the same requests repeated on every page.
 * Deleting a resource calls refresh(), so the badge beside "Datasets" drops
 * the moment a dataset goes rather than on the next page load.
 */

import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
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
	const { spaceSlug } = useSpace();
	const [resources, setResources] = useState<BrowseResource[]>([]);
	const [projectName, setProjectName] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
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
			setResources(trees.flatMap((tree) => tree.resources));
			setProjectName(
				projects.length === 0 ? null : projects.length === 1 ? projects[0]!.name : `${projects.length} projects`,
			);
		} catch (exc) {
			// A space with nothing published has nothing to count. That is a
			// normal state, not a failure worth surfacing in the navigation.
			if (!isMissingOntology(exc)) console.warn("Could not load resources", exc);
			setResources([]);
			setProjectName(null);
		} finally {
			setLoading(false);
		}
	}, [spaceSlug]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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
