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
import { BrandMark } from "./components/icons";

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
	/** "personal" for someone's own workspace, "environment" for a shared one. */
	kind?: "personal" | "environment";
	ownerUsername?: string | null;
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
	/** True in the caller's own workspace: the business-first layout. */
	isPersonal: boolean;
	/** Re-read the spaces, e.g. after an import changed the ontology counts. */
	reload: () => void;
}

const STORAGE_KEY = "tms.active.space";
const DEFAULT_SPACE = "sandbox";

const SpaceContext = createContext<SpaceContextValue>({
	spaces: [],
	space: null,
	spaceSlug: DEFAULT_SPACE,
	setSpaceSlug: () => {},
	loading: true,
	isPersonal: false,
	reload: () => {},
});

/**
 * Where to land when nothing valid is remembered: the caller's own workspace
 * (the server lists it first), then the sandbox, then whatever is visible.
 * A self-registered account cannot open the sandbox at all, so defaulting to
 * it used to strand new users on an error.
 */
function landingSpace(list: Space[]): string {
	return (
		list.find((item) => item.kind === "personal")?.slug ??
		list.find((item) => item.slug === DEFAULT_SPACE)?.slug ??
		list[0]?.slug ??
		DEFAULT_SPACE
	);
}

export function SpaceProvider({ children }: { children: ReactNode }) {
	const [spaces, setSpaces] = useState<Space[]>([]);
	const [loading, setLoading] = useState(true);
	const [spaceSlug, setSpaceSlugState] = useState<string>(() => {
		try {
			return window.localStorage.getItem(STORAGE_KEY) ?? "";
		} catch {
			// Private windows refuse storage; the landing space is chosen below.
			return "";
		}
	});
	const [generation, setGeneration] = useState(0);

	useEffect(() => {
		api
			.get<Space[]>("/api/spaces")
			.then((list) => {
				setSpaces(list);
				// A remembered space that no longer exists (or that this account
				// cannot open) would leave every page querying a slug the server
				// rejects, so fall back rather than trust it.
				setSpaceSlugState((current) =>
					list.some((item) => item.slug === current) ? current : landingSpace(list),
				);
			})
			.catch(() => setSpaces([]))
			.finally(() => setLoading(false));
	}, [generation]);

	const reload = useCallback(() => setGeneration((value) => value + 1), []);

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

	const value = useMemo<SpaceContextValue>(() => {
		const space = spaces.find((item) => item.slug === spaceSlug) ?? null;
		return {
			spaces,
			space,
			spaceSlug,
			setSpaceSlug,
			loading,
			isPersonal: space?.kind === "personal",
			reload,
		};
	}, [spaces, spaceSlug, setSpaceSlug, loading, reload]);

	// Pages fire their first requests as they mount, so they wait until the
	// space is settled: a request made before then would be answered for the
	// wrong space (or refused, for an account that cannot open the sandbox).
	if (loading && spaces.length === 0) {
		return (
			<div className="boot-screen" role="status">
				<span className="brand-mark" aria-hidden>
					<BrandMark size={28} />
				</span>
				<span className="loading-inline">
					<span className="spinner" aria-hidden />
					Opening your workspace…
				</span>
			</div>
		);
	}
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
