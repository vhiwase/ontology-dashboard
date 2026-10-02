import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
	type AssistantHealth,
	type SessionUser,
	api,
	session,
	setUnauthorizedHandler,
} from "./api";
import { useDebounced } from "./components/common";
import { Actions } from "./pages/Actions";
import { RepoDetail, RepoList } from "./pages/CodeRepos";
import { Functions } from "./pages/Functions";
import { BROWSE_KINDS, RESOURCE_SPECS } from "./components/spaces/resourceKinds";
import { ResourceProvider, useResources } from "./ResourceContext";
import { ResourceBrowser } from "./pages/ResourceBrowser";
import { Login } from "./pages/Login";
import { Assistant } from "./pages/Assistant";
import { CostAnalysis } from "./pages/CostAnalysis";
import { DashboardHistory } from "./pages/DashboardHistory";
import { DashboardDetail, DashboardList } from "./pages/Dashboards";
import { GraphView } from "./pages/GraphView";
import { LineagePage } from "./pages/LineagePage";
import { ObjectExplorer } from "./pages/ObjectExplorer";
import { PipelineBuilder } from "./pages/PipelineBuilder";
import { Spaces } from "./pages/Spaces";
import { SpaceProvider, envTone, useSpace } from "./SpaceContext";
import { OntologyManager } from "./pages/OntologyManager";
import { Overview } from "./pages/Overview";
import { Home } from "./pages/Home";
import { DataSources } from "./pages/DataSources";
import { Proposals } from "./pages/Proposals";

interface HealthPayload {
	status: string;
	ontologyVersion: string;
	objectTypes: number;
	linkTypes: number;
	kpis: number;
}

type NavEntry =
	| { section: string }
	| { panel: "browse" }
	| {
			to: string;
			label: string;
			glyph: string;
			exact?: boolean;
			badge?: "approvals" | "objectTypes" | "linkTypes";
	  };

/**
 * A personal workspace is somebody's own data, so its navigation is the
 * business path - ask, look, approve - with the model underneath it. The
 * engineering surfaces (pipelines, repositories, SQL functions, lineage) run
 * code over shared tables and are not offered there at all.
 */
const PERSONAL_NAV: NavEntry[] = [
	{ to: "/", label: "Home", glyph: "⌂", exact: true },
	{ to: "/assistant", label: "Ask AI", glyph: "✦", exact: true },
	{ to: "/dashboards", label: "Dashboards & reports", glyph: "▦" },
	{ to: "/approvals", label: "Approvals", glyph: "✓", badge: "approvals" },
	{ section: "Your data" },
	{ to: "/data", label: "Data sources", glyph: "⛁" },
	{ to: "/ontology", label: "Business objects", glyph: "◇", badge: "objectTypes" },
	{ to: "/graph", label: "Relationships", glyph: "◉", badge: "linkTypes" },
	{ to: "/explorer", label: "Explore records", glyph: "▤" },
	{ to: "/actions", label: "Actions", glyph: "▶" },
	{ section: "Account" },
	{ to: "/assistant/cost", label: "AI usage & cost", glyph: "$" },
];

const NAV: NavEntry[] = [
	{ section: "Workspace" },
	{ to: "/spaces", label: "Spaces", glyph: "▣" },
	{ section: "Ontology" },
	{ to: "/", label: "Overview", glyph: "◈", exact: true },
	{ to: "/ontology", label: "Object types", glyph: "◇" },
	{ to: "/graph", label: "Graph", glyph: "◉" },
	{ to: "/lineage", label: "Lineage", glyph: "⑃" },
	{ to: "/pipeline", label: "Pipeline builder", glyph: "⑄" },
	// Beside the pipeline builder, because it is the other way of describing
	// how data becomes an ontology: one is drawn, the other is written down.
	{ to: "/repos", label: "Repositories", glyph: "⌥" },
	// One entry per resource kind, each opening a list-and-data page like
	// Object Explorer. These used to be an inline panel that expanded every
	// kind under the navigation, which buried it; a kind's name is not the
	// useful part, its data is.
	{ panel: "browse" as const },
	{ section: "Work" },
	{ to: "/explorer", label: "Object explorer", glyph: "▤" },
	{ to: "/dashboards", label: "Dashboards", glyph: "▦" },
	{ to: "/approvals", label: "Approvals", glyph: "✓", badge: "approvals" },
	{ to: "/actions", label: "Actions", glyph: "▶" },
	{ to: "/functions", label: "Functions", glyph: "ƒ" },
	{ section: "Assistant" },
	{ to: "/assistant", label: "AI-FDE", glyph: "✦", exact: true },
	{ to: "/assistant/cost", label: "Cost analysis", glyph: "$" },
];

const TITLES: Record<string, string> = {
	"/": "Overview",
	"/home": "Home",
	"/data": "Data sources",
	"/approvals": "Approvals",
	"/spaces": "Spaces",
	"/ontology": "Object types",
	"/graph": "Ontology graph",
	"/lineage": "Data lineage",
	"/pipeline": "Pipeline builder",
	"/repos": "Code repositories",
	"/explorer": "Object explorer",
	"/dashboards": "Dashboards",
	"/dashboards/history": "Dashboard history",
	"/actions": "Actions",
	"/functions": "Functions",
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
function RailCount({
	of,
	title,
}: {
	of: "objectTypes" | "linkTypes";
	title: string;
}) {
	const { space } = useSpace();
	// No badge at all rather than a zero: an empty space has nothing to count,
	// and a "0" beside every link reads as a failure to load.
	if (!space?.ontology) return null;
	return (
		<span className="count" title={title}>
			{space.ontology[of]}
		</span>
	);
}

/**
 * The resource kinds in the nav, each with a count for the current space.
 *
 * The count is omitted while loading rather than shown as 0: a badge reading
 * "Datasets 0" for half a second reads as "you have no datasets".
 */
function RailBrowse() {
	const { counts, projectName } = useResources();
	return (
		<>
			<div className="rail-subsection" title="The resources registered in this space">
				{projectName ?? "Workspace"}
			</div>
			{BROWSE_KINDS.map((item) => (
				<NavLink
					key={item.slug}
					to={`/browse/${item.slug}`}
					className={({ isActive }) => `rail-link rail-link-sub ${isActive ? "active" : ""}`}
				>
					<span className="glyph" aria-hidden style={{ color: RESOURCE_SPECS[item.kind].accent }}>
						{RESOURCE_SPECS[item.kind].glyph}
					</span>
					<span>{item.label}</span>
					{counts && (counts[item.kind] ?? 0) > 0 && (
						<span className="count">{counts[item.kind]}</span>
					)}
				</NavLink>
			))}
		</>
	);
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
						"panel" in entry ? (
							<RailBrowse key={`panel-${index}`} />
						) : "section" in entry ? (
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
								{/* Each badge counts the thing its own link leads to. The
								    dashboards badge used to show health.kpis, so it read as
								    "31 dashboards" when 31 was the number of metrics. */}
								{entry.to === "/ontology" && <RailCount of="objectTypes" title="Object types" />}
								{entry.to === "/graph" && <RailCount of="linkTypes" title="Link types" />}
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

				{/* The builder is a full-bleed canvas: it needs the padding and the
				    max-width off, and its own scrolling rather than the page's. */}
				<div className={`content${location.pathname === "/pipeline" ? " content-flush" : ""}`}>
					<div
						className="content-wide"
						style={{
							height:
								location.pathname === "/assistant" || location.pathname === "/pipeline"
									? "100%"
									: undefined,
						}}
					>
						<Routes>
							<Route path="/" element={isPersonal ? <Home /> : <Overview />} />
							<Route path="/home" element={<Home />} />
							<Route path="/data" element={<DataSources />} />
							<Route path="/approvals" element={<Proposals />} />
							<Route path="/ontology" element={<OntologyManager />} />
							<Route path="/graph" element={<GraphView />} />
							<Route path="/lineage" element={<LineagePage />} />
							<Route path="/pipeline" element={<PipelineBuilder />} />
							<Route path="/spaces" element={<Spaces />} />
							<Route path="/explorer" element={<ObjectExplorer />} />
							<Route path="/dashboards" element={<DashboardList />} />
							{/* Before /dashboards/:slug, or "history" is read as a slug. */}
							<Route path="/dashboards/history" element={<DashboardHistory />} />
							<Route path="/dashboards/:slug" element={<DashboardDetail />} />
							<Route path="/actions" element={<Actions />} />
							<Route path="/functions" element={<Functions />} />
							<Route path="/repos" element={<RepoList />} />
							<Route path="/repos/:slug" element={<RepoDetail />} />
							<Route path="/browse/:kind" element={<ResourceBrowser />} />
							<Route path="/assistant" element={<Assistant />} />
							{/* Before nothing else, but listed after /assistant so the exact
							    match on the nav link does not highlight both. */}
							<Route path="/assistant/cost" element={<CostAnalysis />} />
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
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
