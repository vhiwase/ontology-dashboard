/**
 * The active space, shared by the whole application.
 *
 * Space was previously a control on one page, which meant the pipeline builder
 * could say "Development" while the workspace said "Sandbox" and nothing
 * reconciled the two. It is now a single piece of app state: the top bar sets
 * it, every page reads it, and what you see is always the contents of one
 * space.
 *
 * The choice is remembered per browser, because it is a working context rather
 * than a preference — coming back to the tool should put you where you left
 * off, not reset you to the sandbox.
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
import { api, setActiveSpace } from "./api";

export interface Space {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	isSystem: boolean;
	projectCount: number;
	/** False where no pipeline has published an ontology into this space. */
	hasOntology: boolean;
	/** The space's own ontology counts, or null where it has none. */
	ontology: {
		version: string;
		objectTypes: number;
		linkTypes: number;
		actionTypes: number;
		kpis: number;
	} | null;
}

interface SpaceContextValue {
	spaces: Space[];
	space: Space | null;
	spaceSlug: string;
	setSpaceSlug: (slug: string) => void;
	loading: boolean;
}

const STORAGE_KEY = "tms.active.space";
const DEFAULT_SPACE = "sandbox";

const SpaceContext = createContext<SpaceContextValue>({
	spaces: [],
	space: null,
	spaceSlug: DEFAULT_SPACE,
	setSpaceSlug: () => {},
	loading: true,
});

export function SpaceProvider({ children }: { children: ReactNode }) {
	const [spaces, setSpaces] = useState<Space[]>([]);
	const [loading, setLoading] = useState(true);
	const [spaceSlug, setSpaceSlugState] = useState<string>(() => {
		try {
			return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SPACE;
		} catch {
			// Private windows refuse storage; the sandbox is the right default.
			return DEFAULT_SPACE;
		}
	});

	useEffect(() => {
		api
			.get<Space[]>("/api/spaces")
			.then((list) => {
				setSpaces(list);
				// A remembered space that no longer exists would leave every page
				// querying a slug the server rejects, so fall back rather than trust it.
				setSpaceSlugState((current) =>
					list.some((item) => item.slug === current) ? current : DEFAULT_SPACE,
				);
			})
			.catch(() => setSpaces([]))
			.finally(() => setLoading(false));
	}, []);

	// Assigned during render, before any child can fire a request: the API
	// client stamps ?space= on every call from this value, so setting it in an
	// effect would let the first fetch of a newly selected space go out under
	// the previous one.
	setActiveSpace(spaceSlug);

	const setSpaceSlug = useCallback((slug: string) => {
		setSpaceSlugState(slug);
		try {
			window.localStorage.setItem(STORAGE_KEY, slug);
		} catch {
			/* the choice still applies for this tab */
		}
	}, []);

	const value = useMemo<SpaceContextValue>(
		() => ({
			spaces,
			space: spaces.find((item) => item.slug === spaceSlug) ?? null,
			spaceSlug,
			setSpaceSlug,
			loading,
		}),
		[spaces, spaceSlug, setSpaceSlug, loading],
	);

	return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceContextValue {
	return useContext(SpaceContext);
}

/** The class that tones a control by environment, so production is obvious. */
export function envTone(environment: string | undefined): string {
	switch (environment) {
		case "sandbox":
			return "env-sandbox";
		case "development":
			return "env-dev";
		case "staging":
			return "env-staging";
		case "production":
			return "env-prod";
		default:
			return "";
	}
}
