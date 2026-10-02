import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
	type AssistantHealth,
	type SessionUser,
	api,
	session,
	setUnauthorizedHandler,
} from "./api";
import { Spinner, useDebounced } from "./components/common";
import { BROWSE_KINDS } from "./components/spaces/resourceKinds";
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
			glyph: string;
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
	{ to: "/", label: "Home", glyph: "⌂", exact: true },
	{ to: "/assistant", label: "Ask AI", glyph: "✦", exact: true },
	{ to: "/dashboards", label: "Dashboards & reports", glyph: "▦" },
	{ to: "/approvals", label: "Approvals", glyph: "✓", badge: "approvals" },
	{ section: "Your data" },
	{ to: "/data", label: "Data sources", glyph: "⛁" },
	{ to: "/schedules", label: "Refresh schedules", glyph: "⏱" },
	{ to: "/ontology", label: "Business objects", glyph: "◇" },
	{ to: "/graph", label: "Relationships", glyph: "◉" },
	{ to: "/explorer", label: "Explore records", glyph: "▤" },
	{ to: "/actions", label: "Actions", glyph: "▶" },
	{ section: "Account" },
	{ to: "/assistant/cost", label: "AI usage & cost", glyph: "$" },
];

const NAV: NavEntry[] = [
	{ section: "Data" },
	{ to: "/browse/connections", label: "Connections", glyph: "⛁", browse: "connection" },
	{ to: "/browse/datasets", label: "Datasets", glyph: "▤", browse: "dataset" },
	{ to: "/schedules", label: "Schedules", glyph: "⏱" },
	{ section: "Ontology" },
	{ to: "/", label: "Overview", glyph: "◈", exact: true },
	{ to: "/ontology", label: "Object types", glyph: "◇" },
	{ to: "/graph", label: "Graph", glyph: "◉" },
	{ to: "/explorer", label: "Object explorer", glyph: "▦" },
	{ section: "Logic" },
	{ to: "/browse/metrics", label: "Metrics", glyph: "Σ", browse: "kpi" },
	{ to: "/functions", label: "Functions", glyph: "ƒ" },
	{ to: "/actions", label: "Actions", glyph: "▶" },
	{ section: "Apps" },
	{ to: "/dashboards", label: "Dashboards", glyph: "▥" },
	{ to: "/approvals", label: "Approvals", glyph: "✓", badge: "approvals" },
	{ section: "Assistant" },
	{ to: "/assistant", label: "AI-FDE", glyph: "✦", exact: true },
	{ to: "/assistant/cost", label: "Cost analysis", glyph: "$" },
	{ section: "Workspace" },
	{ to: "/spaces", label: "Spaces", glyph: "▣" },
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
};

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
	return (
		<div className="rail-brand">
			<h1>
				<span className="brand-mark" aria-hidden>
					◈
				</span>
				Ontology Dashboard
			</h1>
			<p>
				{!connected || loading
					? "connecting…"
					: isPersonal
						? ontology && ontology.objectTypes > 0
							? `${space?.name ?? "Your workspace"} · ${ontology.objectTypes} objects`
							: `${space?.name ?? "Your workspace"} · no data yet`
						: ontology
							? `${space?.name ?? ""} · v${ontology.version} · ${ontology.objectTypes} object types`
							: `${space?.name ?? "This space"} · nothing published`}
			</p>
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
				<Shell
					user={user}
					health={health}
					assistantHealth={assistantHealth}
					theme={theme}
					setTheme={setTheme}
					signOut={signOut}
				/>
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
	const nav = isPersonal ? PERSONAL_NAV : NAV;
	// From here on there is a token, so the space provider can load.

	const browseKind = location.pathname.startsWith("/browse/")
		? BROWSE_KINDS.find((item) => item.slug === location.pathname.slice("/browse/".length))
		: undefined;
	const title =
		(location.pathname === "/" && isPersonal ? "Home" : TITLES[location.pathname]) ??
		browseKind?.label ??
		(location.pathname.startsWith("/dashboards/") ? "Dashboard" : "Ontology Dashboard");

	return (
		<div className="shell">
			<nav className="rail">
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
									{entry.glyph}
								</span>
								<span>{entry.label}</span>
								<RailCount entry={entry} />
								{entry.badge === "approvals" && <RailApprovals />}
							</NavLink>
						),
					)}
				</div>

				<div className="rail-foot">
					<div className="row" style={{ gap: 6 }}>
						<span
							className="chip"
							style={{
								color: assistantHealth?.llm.reachable
									? "var(--status-good)"
									: "var(--status-critical)",
							}}
							title={
								assistantHealth?.llm.reachable
									? `Model ready: ${assistantHealth.model}`
									: (assistantHealth?.llm.detail ?? "Model unavailable")
							}
						>
							<span className="dot" aria-hidden />
							{assistantHealth
								? assistantHealth.llm.reachable
									? assistantHealth.llm.modelPresent === false
										? "model not pulled"
										: assistantHealth.provider === "builtin"
											? "AI: built-in planner"
											: "AI model ready"
									: "model offline"
								: "checking…"}
						</span>
					</div>
					{assistantHealth && <span className="mono">{assistantHealth.model}</span>}
					<button
						className="btn sm"
						onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
					>
						{theme === "dark" ? "Light theme" : "Dark theme"}
					</button>
					<div className="rail-user">
						<span className="mono" title={`Ontology role: ${user.ontologyRole}`}>
							{user.username} · {user.role}
						</span>
						<button className="btn sm" onClick={signOut}>
							Sign out
						</button>
					</div>
				</div>
			</nav>

			<div className="main">
				<header className="topbar">
					<h2>{title}</h2>
					<SpaceSwitcher />
					<div className="spacer" />
					<GlobalSearch />
				</header>

				<div className="content">
					<div
						className="content-wide"
						style={{ height: location.pathname === "/assistant" ? "100%" : undefined }}
					>
						<Suspense fallback={<Spinner />}>
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
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
						</Suspense>
					</div>
				</div>
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
		<div style={{ position: "relative" }}>
			<input
				placeholder="Search your records…"
				value={term}
				onChange={(event) => setTerm(event.target.value)}
				onFocus={() => setOpen(true)}
				onBlur={() => setTimeout(() => setOpen(false), 160)}
				style={{ width: 280 }}
				aria-label="Global search"
			/>
			{open && results && results.length > 0 && (
				<div
					className="card"
					style={{
						position: "absolute",
						top: "calc(100% + 6px)",
						right: 0,
						width: 360,
						zIndex: 30,
						padding: 8,
						maxHeight: 420,
						overflowY: "auto",
						boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
					}}
				>
					{results.map((group) => (
						<div key={group.objectType}>
							<div className="rail-section" style={{ padding: "6px 8px 3px" }}>
								{group.label}
							</div>
							{group.hits.map((hit) => (
								<button
									key={hit.key}
									className="rail-link"
									style={{ width: "100%", textAlign: "left" }}
									onClick={() => {
										setTerm("");
										setOpen(false);
										navigate("/explorer");
									}}
								>
									<span
										className="glyph"
										style={{ color: group.color ?? "var(--ink-muted)", fontSize: 13 }}
										aria-hidden
									>
										●
									</span>
									<span>{hit.title}</span>
								</button>
							))}
						</div>
					))}
					<div className="muted" style={{ fontSize: 11, padding: "7px 8px 3px" }}>
						Opens the explorer for that object type.
					</div>
				</div>
			)}
			{open && results && results.length === 0 && debounced.trim().length >= 2 && (
				<div
					className="card"
					style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 360, zIndex: 30 }}
				>
					<span className="muted" style={{ fontSize: 12 }}>
						Nothing matches “{debounced.trim()}”.
					</span>
				</div>
			)}
		</div>
	);
}
