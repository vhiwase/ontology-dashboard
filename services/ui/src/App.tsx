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
import { Login } from "./pages/Login";
import { Assistant } from "./pages/Assistant";
import { DashboardHistory } from "./pages/DashboardHistory";
import { DashboardDetail, DashboardList } from "./pages/Dashboards";
import { GraphView } from "./pages/GraphView";
import { LineagePage } from "./pages/LineagePage";
import { ObjectExplorer } from "./pages/ObjectExplorer";
import { PipelineBuilder } from "./pages/PipelineBuilder";
import { OntologyManager } from "./pages/OntologyManager";
import { Overview } from "./pages/Overview";

interface HealthPayload {
	status: string;
	ontologyVersion: string;
	objectTypes: number;
	linkTypes: number;
	kpis: number;
}

const NAV = [
	{ section: "Ontology" },
	{ to: "/", label: "Overview", glyph: "◈", exact: true },
	{ to: "/ontology", label: "Object types", glyph: "◇" },
	{ to: "/graph", label: "Graph", glyph: "◉" },
	{ to: "/lineage", label: "Lineage", glyph: "⑃" },
	{ to: "/pipeline", label: "Pipeline builder", glyph: "⑄" },
	{ section: "Work" },
	{ to: "/explorer", label: "Object explorer", glyph: "▤" },
	{ to: "/dashboards", label: "Dashboards", glyph: "▦" },
	{ to: "/actions", label: "Actions", glyph: "▶" },
	{ section: "Assistant" },
	{ to: "/assistant", label: "AI-FDE", glyph: "✦" },
];

const TITLES: Record<string, string> = {
	"/": "Overview",
	"/ontology": "Object types",
	"/graph": "Ontology graph",
	"/lineage": "Data lineage",
	"/pipeline": "Pipeline builder",
	"/explorer": "Object explorer",
	"/dashboards": "Dashboards",
	"/dashboards/history": "Dashboard history",
	"/actions": "Actions",
	"/assistant": "AI-FDE assistant",
};

export function App() {
	const location = useLocation();
	const [user, setUser] = useState<SessionUser | null>(() =>
		session.token() ? session.user() : null,
	);
	const [health, setHealth] = useState<HealthPayload | null>(null);
	const [assistantHealth, setAssistantHealth] = useState<AssistantHealth | null>(null);
	const [theme, setTheme] = useState<"dark" | "light">(
		() => (localStorage.getItem("tms-theme") as "dark" | "light") ?? "dark",
	);

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

	const title =
		TITLES[location.pathname] ??
		(location.pathname.startsWith("/dashboards/") ? "Dashboard" : "TMS Ontology");

	return (
		<div className="shell">
			<nav className="rail">
				<div className="rail-brand">
					<h1>TMS Ontology Workbench</h1>
					<p>
						{health ? `v${health.ontologyVersion} · ${health.objectTypes} object types` : "connecting…"}
					</p>
				</div>

				<div className="rail-nav">
					{NAV.map((entry, index) =>
						"section" in entry ? (
							<div className="rail-section" key={`section-${index}`}>
								{entry.section}
							</div>
						) : (
							<NavLink
								key={entry.to}
								to={entry.to!}
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
								{entry.to === "/ontology" && health && (
									<span className="count" title="Object types">{health.objectTypes}</span>
								)}
								{entry.to === "/graph" && health && (
									<span className="count" title="Link types">{health.linkTypes}</span>
								)}
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
										: "model ready"
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
							<Route path="/" element={<Overview />} />
							<Route path="/ontology" element={<OntologyManager />} />
							<Route path="/graph" element={<GraphView />} />
							<Route path="/lineage" element={<LineagePage />} />
							<Route path="/pipeline" element={<PipelineBuilder />} />
							<Route path="/explorer" element={<ObjectExplorer />} />
							<Route path="/dashboards" element={<DashboardList />} />
							{/* Before /dashboards/:slug, or "history" is read as a slug. */}
							<Route path="/dashboards/history" element={<DashboardHistory />} />
							<Route path="/dashboards/:slug" element={<DashboardDetail />} />
							<Route path="/actions" element={<Actions />} />
							<Route path="/assistant" element={<Assistant />} />
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
				placeholder="Find an order, shipment, carrier…"
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
