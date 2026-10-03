import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
	type AssistantHealth,
	type SessionUser,
	api,
	session,
	setUnauthorizedHandler,
} from "./api";
import { PageLoader, useDebounced } from "./components/common";
import { BrandMark, Icon, type IconName } from "./components/icons";
import { BROWSE_KINDS } from "./components/spaces/resourceKinds";
import { ChatProvider } from "./ChatContext";
import { ResourceProvider, useResources } from "./ResourceContext";
import { Login } from "./pages/Login";
import { Assistant } from "./pages/Assistant";
import { SpaceProvider, envTone, useSpace } from "./SpaceContext";
import { Home } from "./pages/Home";

// Pages past the first screen load on demand, so signing in and the home
// page do not wait for the graph canvas, the ontology editor and the rest.
function page<K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) {
	return lazy(() => load().then((module) => ({ default: module[name] })));
}
const Actions = page(() => import("./pages/Actions"), "Actions");
const Admin = page(() => import("./pages/Admin"), "Admin");
const Functions = page(() => import("./pages/Functions"), "Functions");
const ResourceBrowser = page(() => import("./pages/ResourceBrowser"), "ResourceBrowser");
const CostAnalysis = page(() => import("./pages/CostAnalysis"), "CostAnalysis");
const DashboardHistory = page(() => import("./pages/DashboardHistory"), "DashboardHistory");
const DashboardDetail = page(() => import("./pages/Dashboards"), "DashboardDetail");
const DashboardList = page(() => import("./pages/Dashboards"), "DashboardList");
const GraphView = page(() => import("./pages/GraphView"), "GraphView");
const ObjectExplorer = page(() => import("./pages/ObjectExplorer"), "ObjectExplorer");
const Spaces = page(() => import("./pages/Spaces"), "Spaces");
const OntologyManager = page(() => import("./pages/OntologyManager"), "OntologyManager");
const Overview = page(() => import("./pages/Overview"), "Overview");
const DataSources = page(() => import("./pages/DataSources"), "DataSources");
const Proposals = page(() => import("./pages/Proposals"), "Proposals");
const Schedules = page(() => import("./pages/Schedules"), "Schedules");

interface HealthPayload {
	status: string;
	ontologyVersion: string;
	objectTypes: number;
	linkTypes: number;
	kpis: number;
}

/**
 * The navigation follows the one path data takes through the platform:
 * a connection syncs a view into a dataset on a schedule, object types are
 * created from datasets (or modelled on import), metrics, functions and
 * actions are defined on them, and dashboards and the assistant use the result.
 *
 * An entry with `browse` opens that resource kind's list-and-data page and
 * carries its count for the current space; `badge` marks a count of its own.
 */
type NavEntry =
	| { section: string }
	| {
			to: string;
			label: string;
			icon: IconName;
			exact?: boolean;
			browse?: ResourceKindName;
			badge?: "approvals";
	  };

type ResourceKindName = (typeof BROWSE_KINDS)[number]["kind"];

/**
 * A personal workspace is somebody's own data, so its navigation is the
 * business path - ask, look, approve - with the model underneath it. SQL
 * functions read tables by name and are not offered there.
 */
const PERSONAL_NAV: NavEntry[] = [
	{ to: "/", label: "Home", icon: "home", exact: true },
	{ to: "/assistant", label: "Ask AI", icon: "sparkles", exact: true },
	{ to: "/dashboards", label: "Dashboards & reports", icon: "dashboard" },
	{ to: "/approvals", label: "Approvals", icon: "checkCircle", badge: "approvals" },
	{ section: "Your data" },
	{ to: "/data", label: "Data sources", icon: "database" },
	{ to: "/schedules", label: "Refresh schedules", icon: "clock" },
	{ to: "/ontology", label: "Business objects", icon: "box" },
	{ to: "/graph", label: "Relationships", icon: "graph" },
	{ to: "/explorer", label: "Explore records", icon: "compass" },
	{ to: "/functions", label: "SQL functions", icon: "fn" },
	{ to: "/actions", label: "Actions", icon: "zap" },
	{ section: "Account" },
	{ to: "/assistant/cost", label: "AI usage & cost", icon: "dollar" },
];

const NAV: NavEntry[] = [
	{ section: "Data" },
	{ to: "/browse/connections", label: "Connections", icon: "database", browse: "connection" },
	{ to: "/browse/datasets", label: "Datasets", icon: "table", browse: "dataset" },
	{ to: "/schedules", label: "Schedules", icon: "clock" },
	{ section: "Ontology" },
	{ to: "/", label: "Overview", icon: "gauge", exact: true },
	{ to: "/ontology", label: "Object types", icon: "box" },
	{ to: "/graph", label: "Graph", icon: "graph" },
	{ to: "/explorer", label: "Object explorer", icon: "compass" },
	{ section: "Logic" },
	{ to: "/browse/metrics", label: "Metrics", icon: "sigma", browse: "kpi" },
	{ to: "/functions", label: "Functions", icon: "fn" },
	{ to: "/actions", label: "Actions", icon: "zap" },
	{ section: "Apps" },
	{ to: "/dashboards", label: "Dashboards", icon: "dashboard" },
	{ to: "/approvals", label: "Approvals", icon: "checkCircle", badge: "approvals" },
	{ section: "Assistant" },
	{ to: "/assistant", label: "AI-FDE", icon: "bot", exact: true },
	{ to: "/assistant/cost", label: "Cost analysis", icon: "dollar" },
	{ section: "Workspace" },
	{ to: "/spaces", label: "Spaces", icon: "layers" },
];

/**
 * Added for a platform administrator, in whichever space they are in. Hiding
 * the link is a courtesy, not the control: every /api/admin route refuses
 * anyone else on the server.
 */
const ADMIN_NAV: NavEntry[] = [
	{ section: "Administration" },
	{ to: "/admin", label: "Admin console", icon: "shieldCheck" },
];

const TITLES: Record<string, string> = {
	"/": "Overview",
	"/home": "Home",
	"/data": "Data sources",
	"/approvals": "Approvals",
	"/spaces": "Spaces",
	"/ontology": "Object types",
	"/graph": "Ontology graph",
	"/explorer": "Object explorer",
	"/dashboards": "Dashboards",
	"/dashboards/history": "Dashboard history",
	"/actions": "Actions",
	"/functions": "Functions",
	"/schedules": "Schedules",
	"/assistant": "AI-FDE assistant",
	"/assistant/cost": "Assistant cost analysis",
	"/admin": "Admin console",
};

/**
 * The nav section a page sits under, for the breadcrumb in the top bar.
 * The longest matching entry wins, so /dashboards/history reads as Apps
 * rather than matching nothing.
 */
function sectionFor(nav: NavEntry[], pathname: string): string | null {
	let section: string | null = null;
	let found: string | null = null;
	let best = -1;
	for (const entry of nav) {
		if ("section" in entry) {
			section = entry.section;
			continue;
		}
		const matches =
			entry.to === pathname || (entry.to !== "/" && pathname.startsWith(`${entry.to}/`));
		if (matches && entry.to.length > best) {
			best = entry.to.length;
			found = section;
		}
	}
	return found;
}

export function App() {
	return <AppShell />;
}

/**
 * The space switcher.
 *
 * Toned by environment, so working in production looks different from working
 * in the sandbox before anything is clicked rather than after.
 */
function SpaceSwitcher() {
	const { spaces, space, spaceSlug, setSpaceSlug, loading } = useSpace();
	// One space (a new account's own workspace) needs no switcher.
	if (loading || spaces.length <= 1) return null;
	return (
		<label className={`space-switcher ${envTone(space?.environment)}`}>
			<span className="muted">Space</span>
			<select
				value={spaceSlug}
				onChange={(event) => setSpaceSlug(event.target.value)}
				aria-label="Active space"
				title={space?.description ?? undefined}
			>
				{spaces.map((item) => (
					<option key={item.slug} value={item.slug}>
						{item.name}
					</option>
				))}
			</select>
		</label>
	);
}

/**
 * The rail's headline, for the space you are in.
 *
 * It used to read /health, which reports one global ontology — so every space
 * showed the sandbox's version and count, which is the same misdirection the
 * ontology pages had. Both now come from the space itself.
 */
function RailBrand({ connected }: { connected: boolean }) {
	const { space, loading, isPersonal } = useSpace();
	const ontology = space?.ontology ?? null;
	const status =
		!connected || loading
			? "connecting…"
			: isPersonal
				? ontology && ontology.objectTypes > 0
					? `${space?.name ?? "Your workspace"} · ${ontology.objectTypes} objects`
					: `${space?.name ?? "Your workspace"} · no data yet`
				: ontology
					? `${space?.name ?? ""} · v${ontology.version} · ${ontology.objectTypes} object types`
					: `${space?.name ?? "This space"} · nothing published`;
	return (
		<div className="rail-brand">
			<span className="brand-mark" aria-hidden>
				<BrandMark size={20} />
			</span>
			<div className="rail-brand-text">
				<h1>Ontology Dashboard</h1>
				<p title={status}>{status}</p>
			</div>
		</div>
	);
}

/** Pending approvals in this space, re-read whenever the space data reloads. */
function RailApprovals() {
	const { spaceSlug, spaces } = useSpace();
	const [count, setCount] = useState<number | null>(null);
	useEffect(() => {
		api
			.get<unknown[]>("/api/proposals?status=pending")
			.then((rows) => setCount(rows.length))
			.catch(() => setCount(null));
	}, [spaceSlug, spaces]);
	if (!count) return null;
	return (
		<span className="count attention" title={`${count} waiting for approval`}>
			{count}
		</span>
	);
}

/** A nav badge counting what its link leads to, in the current space. */
function RailCount({ entry }: { entry: Extract<NavEntry, { to: string }> }) {
	const { space } = useSpace();
	const { counts } = useResources();
	// No badge rather than a zero: an empty space has nothing to count, and a
	// "0" beside every link reads as a failure to load.
	const count = entry.browse
		? (counts?.[entry.browse] ?? 0)
		: entry.to === "/ontology"
			? (space?.ontology?.objectTypes ?? 0)
			: entry.to === "/graph"
				? (space?.ontology?.linkTypes ?? 0)
				: 0;
	if (!count) return null;
	return <span className="count">{count}</span>;
}

function AppShell() {
	const [user, setUser] = useState<SessionUser | null>(() =>
		session.token() ? session.user() : null,
	);
	const [health, setHealth] = useState<HealthPayload | null>(null);
	const [assistantHealth, setAssistantHealth] = useState<AssistantHealth | null>(null);
	const [theme, setTheme] = useState<"dark" | "light">(() => {
		try {
			// Light for a first visit: reports are read on paper and in meetings.
			return (localStorage.getItem("tms-theme") as "dark" | "light") ?? "light";
		} catch {
			return "light";
		}
	});

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
		try {
			localStorage.setItem("tms-theme", theme);
		} catch {
			// A private window can refuse storage; the theme still applies for the session.
		}
	}, [theme]);

	// One handler for "the server refused our token", wherever the call came
	// from. Without it a revoked session would leave the shell mounted and
	// every panel failing on its own.
	useEffect(() => {
		setUnauthorizedHandler(() => setUser(null));
	}, []);

	const signOut = useCallback(() => {
		api.logout();
		setUser(null);
		setHealth(null);
		setAssistantHealth(null);
	}, []);

	useEffect(() => {
		if (!user) return;
		api.get<HealthPayload>("/health").then(setHealth).catch(() => setHealth(null));
		api
			.get<AssistantHealth>("/api/assistant/health")
			.then(setAssistantHealth)
			.catch(() => setAssistantHealth(null));
	}, [user]);

	if (!user) return <Login onSignedIn={setUser} />;
	return (
		<SpaceProvider>
			<ResourceProvider>
				{/* Above the pages, so a conversation is still there after looking
				    at a dataset or a schedule - and gone on sign-out, since this
				    whole tree unmounts with the session. */}
				<ChatProvider>
					<Shell
						user={user}
						health={health}
						assistantHealth={assistantHealth}
						theme={theme}
						setTheme={setTheme}
						signOut={signOut}
					/>
				</ChatProvider>
			</ResourceProvider>
		</SpaceProvider>
	);
}

function Shell({
	user,
	health,
	assistantHealth,
	theme,
	setTheme,
	signOut,
}: {
	user: SessionUser;
	health: HealthPayload | null;
	assistantHealth: AssistantHealth | null;
	theme: "dark" | "light";
	setTheme: (update: (current: "dark" | "light") => "dark" | "light") => void;
	signOut: () => void;
}) {
	const location = useLocation();
	const { isPersonal } = useSpace();
	const isAdmin = user.role === "admin";
	const nav = [...(isPersonal ? PERSONAL_NAV : NAV), ...(isAdmin ? ADMIN_NAV : [])];
	// From here on there is a token, so the space provider can load.

	// The rail is a drawer on a narrow screen. It closes on navigation, on
	// Escape and on a tap outside it, the three ways people expect to leave one.
	const [navOpen, setNavOpen] = useState(false);
	useEffect(() => {
		setNavOpen(false);
	}, [location.pathname]);
	useEffect(() => {
		if (!navOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setNavOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navOpen]);

	const browseKind = location.pathname.startsWith("/browse/")
		? BROWSE_KINDS.find((item) => item.slug === location.pathname.slice("/browse/".length))
		: undefined;
	const title =
		(location.pathname === "/" && isPersonal ? "Home" : TITLES[location.pathname]) ??
		browseKind?.label ??
		(location.pathname.startsWith("/dashboards/") ? "Dashboard" : "Ontology Dashboard");
	const section = sectionFor(nav, location.pathname);
	const isChat = location.pathname === "/assistant";

	const modelStatus = assistantHealth
		? assistantHealth.llm.reachable
			? assistantHealth.llm.modelPresent === false
				? "model not pulled"
				: assistantHealth.provider === "builtin"
					? "AI: built-in planner"
					: "AI model ready"
			: "model offline"
		: "checking…";
	const initials = user.username.slice(0, 2).toUpperCase();
	const nextTheme = theme === "dark" ? "light" : "dark";

	return (
		<div className={`shell ${navOpen ? "nav-open" : ""}`}>
			<a
				className="skip-link"
				href="#main-content"
				onClick={(event) => {
					event.preventDefault();
					document.getElementById("main-content")?.focus();
				}}
			>
				Skip to content
			</a>

			<nav className="rail" id="app-rail" aria-label="Main navigation">
				<RailBrand connected={health !== null} />

				<div className="rail-nav">
					{nav.map((entry, index) =>
						"section" in entry ? (
							<div className="rail-section" key={`section-${index}`}>
								{entry.section}
							</div>
						) : (
							<NavLink
								key={entry.to}
								to={entry.to}
								end={entry.exact}
								className={({ isActive }) => `rail-link ${isActive ? "active" : ""}`}
							>
								<span className="glyph" aria-hidden>
									<Icon name={entry.icon} size={17} />
								</span>
								<span>{entry.label}</span>
								<RailCount entry={entry} />
								{entry.badge === "approvals" && <RailApprovals />}
							</NavLink>
						),
					)}
				</div>

				<div className="rail-foot">
					<div
						className="rail-status"
						title={
							assistantHealth?.llm.reachable
								? `Model ready: ${assistantHealth.model}`
								: (assistantHealth?.llm.detail ?? "Model unavailable")
						}
					>
						<span
							className={`status-dot ${assistantHealth ? (assistantHealth.llm.reachable ? "ok" : "bad") : ""}`}
							aria-hidden
						/>
						<span>{modelStatus}</span>
						{assistantHealth && <span className="mono">{assistantHealth.model}</span>}
					</div>
					<div className="rail-user">
						<span className="avatar-circle" aria-hidden>
							{initials}
						</span>
						<div className="rail-user-text">
							<div className="rail-user-name">{user.username}</div>
							<div className="rail-user-role" title={`Ontology role: ${user.ontologyRole}`}>
								{user.role}
							</div>
						</div>
						<button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out">
							<Icon name="logOut" size={17} />
						</button>
					</div>
				</div>
			</nav>
			<div className="rail-backdrop" aria-hidden onClick={() => setNavOpen(false)} />

			<div className="main">
				<header className="topbar">
					<button
						className="icon-btn nav-toggle"
						onClick={() => setNavOpen(true)}
						aria-label="Open navigation"
						aria-expanded={navOpen}
						aria-controls="app-rail"
					>
						<Icon name="menu" size={19} />
					</button>
					<div className="topbar-title">
						{section && (
							<>
								<span className="topbar-section">{section}</span>
								<Icon name="chevronRight" size={14} />
							</>
						)}
						<h2>{title}</h2>
					</div>
					<SpaceSwitcher />
					<div className="spacer" />
					<div className="topbar-actions">
						<GlobalSearch />
						<button
							className="icon-btn bordered"
							onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
							title={`Switch to the ${nextTheme} theme`}
							aria-label={`Switch to the ${nextTheme} theme`}
						>
							<Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
						</button>
					</div>
				</header>

				<main className={`content ${isChat ? "is-chat" : ""}`} id="main-content" tabIndex={-1}>
					<div className="content-wide" style={{ height: isChat ? "100%" : undefined }}>
						<Suspense fallback={<PageLoader label="Loading" />}>
							<Routes>
								<Route path="/" element={isPersonal ? <Home /> : <Overview />} />
								<Route path="/home" element={<Home />} />
								<Route path="/data" element={<DataSources />} />
								<Route path="/approvals" element={<Proposals />} />
								<Route path="/ontology" element={<OntologyManager />} />
								<Route path="/graph" element={<GraphView />} />
								<Route path="/spaces" element={<Spaces />} />
								<Route path="/explorer" element={<ObjectExplorer />} />
								<Route path="/dashboards" element={<DashboardList />} />
								{/* Before /dashboards/:slug, or "history" is read as a slug. */}
								<Route path="/dashboards/history" element={<DashboardHistory />} />
								<Route path="/dashboards/:slug" element={<DashboardDetail />} />
								<Route path="/actions" element={<Actions />} />
								<Route path="/functions" element={<Functions />} />
								<Route path="/schedules" element={<Schedules />} />
								<Route path="/browse/:kind" element={<ResourceBrowser />} />
								<Route path="/assistant" element={<Assistant />} />
								{/* Before nothing else, but listed after /assistant so the exact
								    match on the nav link does not highlight both. */}
								<Route path="/assistant/cost" element={<CostAnalysis />} />
								<Route path="/admin" element={isAdmin ? <Admin /> : <Navigate to="/" replace />} />
								<Route path="*" element={<Navigate to="/" replace />} />
							</Routes>
						</Suspense>
					</div>
				</main>
			</div>
		</div>
	);
}

interface SearchGroup {
	objectType: string;
	label: string;
	color: string | null;
	hits: Array<{ key: string; title: string }>;
}

function GlobalSearch() {
	const navigate = useNavigate();
	const [term, setTerm] = useState("");
	const [results, setResults] = useState<SearchGroup[] | null>(null);
	const [open, setOpen] = useState(false);
	const debounced = useDebounced(term, 300);
	const inputRef = useRef<HTMLInputElement>(null);
	const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

	// Ctrl+K (Cmd+K on a Mac) jumps to the search from anywhere in the app.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				inputRef.current?.focus();
				inputRef.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		const trimmed = debounced.trim();
		// Two characters is the floor: a one-character ILIKE matches most of the
		// party master and returns noise.
		if (trimmed.length < 2) {
			setResults(null);
			return;
		}
		api
			.get<SearchGroup[]>(`/api/search?q=${encodeURIComponent(trimmed)}&limit=4`)
			.then((groups) => {
				setResults(groups);
				setOpen(true);
			})
			.catch(() => setResults(null));
	}, [debounced]);

	return (
		<div className="search-box">
			<Icon name="search" size={15} />
			<input
				ref={inputRef}
				placeholder="Search your records…"
				value={term}
				onChange={(event) => setTerm(event.target.value)}
				onFocus={() => setOpen(true)}
				onBlur={() => setTimeout(() => setOpen(false), 160)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						setOpen(false);
						event.currentTarget.blur();
					}
				}}
				aria-label="Global search"
			/>
			<span className="search-kbd" aria-hidden>
				<kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
				<kbd>K</kbd>
			</span>
			{open && results && results.length > 0 && (
				<div className="search-popover">
					{results.map((group) => (
						<div key={group.objectType}>
							<div className="search-group-label">{group.label}</div>
							{group.hits.map((hit) => (
								<button
									key={hit.key}
									className="rail-link"
									onClick={() => {
										setTerm("");
										setOpen(false);
										navigate("/explorer");
									}}
								>
									<span
										className="glyph"
										style={{ color: group.color ?? "var(--ink-muted)", fontSize: 11 }}
										aria-hidden
									>
										●
									</span>
									<span>{hit.title}</span>
								</button>
							))}
						</div>
					))}
					<div className="search-hint">Opens the explorer for that object type.</div>
				</div>
			)}
			{open && results && results.length === 0 && debounced.trim().length >= 2 && (
				<div className="search-popover">
					<div className="search-empty">
						<Icon name="search" size={15} />
						Nothing matches “{debounced.trim()}”.
					</div>
				</div>
			)}
		</div>
	);
}
