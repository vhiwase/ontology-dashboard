/**
 * Home: where a workspace starts.
 *
 * An empty workspace gets one thing to do - connect a database - and says what
 * happens after. A workspace with data gets its state at a glance (what was
 * imported, what the model holds, what is waiting for approval) and the
 * shortest path to an answer: a question box and suggestions written from its
 * own metrics.
 */

import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	type DashboardSummary,
	type ProposalRecord,
	type WorkspaceSummary,
	api,
	session,
} from "../api";
import { ConnectWizard } from "../components/ConnectWizard";
import { ProposalCard } from "../components/ProposalCard";
import { ErrorBanner, Spinner } from "../components/common";
import { useSpace } from "../SpaceContext";

interface Starter {
	label: string;
	prompt: string;
}

function greeting(): string {
	const hour = new Date().getHours();
	return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
	const { spaceSlug, space, reload } = useSpace();
	const navigate = useNavigate();
	const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
	const [boards, setBoards] = useState<DashboardSummary[]>([]);
	const [pending, setPending] = useState<ProposalRecord[]>([]);
	const [starters, setStarters] = useState<Starter[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [wizard, setWizard] = useState(false);
	const [question, setQuestion] = useState("");
	const [building, setBuilding] = useState<"dashboard" | "report" | null>(null);
	const [generation, setGeneration] = useState(0);
	const user = session.user();
	const name = user?.displayName || (user?.username ? user.username[0]!.toUpperCase() + user.username.slice(1) : "");

	useEffect(() => {
		setError(null);
		api
			.get<WorkspaceSummary>("/api/workspace/summary")
			.then(setSummary)
			.catch((exc: Error) => setError(exc.message));
		api
			.get<DashboardSummary[]>(`/api/dashboards?space=${spaceSlug}`)
			.then(setBoards)
			.catch(() => setBoards([]));
		api
			.get<ProposalRecord[]>("/api/proposals?status=pending")
			.then(setPending)
			.catch(() => setPending([]));
		api
			.get<{ starters: Starter[] }>(`/api/assistant/starters?space=${spaceSlug}`)
			.then((body) => setStarters(body.starters))
			.catch(() => setStarters([]));
	}, [spaceSlug, generation]);

	const ask = (text: string) => navigate(`/assistant?q=${encodeURIComponent(text)}`);

	async function build(kind: "dashboard" | "report") {
		setBuilding(kind);
		setError(null);
		try {
			const board = await api.post<{ slug: string }>("/api/workspace/auto-dashboard", { kind });
			navigate(`/dashboards/${board.slug}`);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBuilding(null);
		}
	}

	if (error && !summary) return <ErrorBanner error={error} />;
	if (!summary) return <Spinner label="Opening your workspace" />;

	const empty = summary.counts.objectTypes === 0;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (question.trim()) ask(question.trim());
	};

	return (
		<div className="page home">
			<section className="hero">
				<div className="hero-text">
					<p className="hero-kicker">{space?.name ?? "Your workspace"}</p>
					<h1>
						{greeting()}
						{name ? `, ${name}` : ""}.
					</h1>
					<p className="hero-lede">
						{empty
							? "Connect a database and ask for the reports you need. Every figure comes from your own tables."
							: "Ask a question, or open a board. Everything here is computed from your own tables."}
					</p>
				</div>
				<form className="ask-box" onSubmit={submit}>
					<span className="ask-spark" aria-hidden>
						✦
					</span>
					<input
						value={question}
						onChange={(event) => setQuestion(event.target.value)}
						placeholder={empty ? "Connect a database first, then ask anything…" : "Ask anything - “revenue by country per month”"}
						aria-label="Ask the assistant"
						disabled={empty}
					/>
					<button className="btn primary" type="submit" disabled={empty || !question.trim()}>
						Ask
					</button>
				</form>
			</section>

			{error && <ErrorBanner error={error} />}

			{empty ? (
				<section className="onboarding">
					<div className="onboarding-steps">
						<OnboardingStep n={1} title="Connect a database" active>
							A PostgreSQL host and a read-only user. The password is kept encrypted in your workspace.
						</OnboardingStep>
						<OnboardingStep n={2} title="Choose your tables">
							Customers, orders, invoices, tickets - whatever you report on. Keys and foreign keys are read
							automatically.
						</OnboardingStep>
						<OnboardingStep n={3} title="Get a model, not a dump">
							Each table becomes a business object with its metrics; foreign keys become links you can follow
							and slice by.
						</OnboardingStep>
						<OnboardingStep n={4} title="Ask for anything">
							Charts, KPIs, dashboards and reports. What the data cannot answer is said plainly, with what is
							missing.
						</OnboardingStep>
					</div>
					<div className="onboarding-cta">
						<button className="btn primary lg" onClick={() => setWizard(true)}>
							Connect your database
						</button>
						<p className="muted">Takes about a minute. Nothing is ever written to your database.</p>
					</div>
				</section>
			) : (
				<>
					<section className="metric-strip" aria-label="Workspace at a glance">
						<Glance label="Tables imported" value={summary.counts.datasets} to="/data" />
						<Glance label="Business objects" value={summary.counts.objectTypes} to="/ontology" />
						<Glance label="Links" value={summary.counts.linkTypes} to="/graph" />
						<Glance label="Metrics" value={summary.counts.metrics} to="/dashboards#metrics" />
						<Glance
							label="Dashboards & reports"
							value={summary.counts.dashboards + summary.counts.reports}
							to="/dashboards"
						/>
						<Glance
							label="Waiting for approval"
							value={summary.counts.pendingProposals}
							to="/approvals"
							tone={summary.counts.pendingProposals > 0 ? "attention" : undefined}
						/>
					</section>

					<div className="home-grid">
						<div className="col" style={{ gap: 16 }}>
							<section className="panel">
								<header className="panel-head">
									<h2>Ask about your data</h2>
									<span className="muted">written from your own metrics</span>
								</header>
								<div className="suggestions">
									{starters.map((starter) => (
										<button key={starter.label} className="suggestion" onClick={() => ask(starter.prompt)}>
											<span className="suggestion-spark" aria-hidden>
												✦
											</span>
											{starter.label}
										</button>
									))}
								</div>
							</section>

							<section className="panel">
								<header className="panel-head">
									<h2>Dashboards & reports</h2>
									<div className="row" style={{ marginLeft: "auto", gap: 6 }}>
										<button className="btn sm" disabled={building !== null} onClick={() => void build("dashboard")}>
											{building === "dashboard" ? "Building…" : "New dashboard"}
										</button>
										<button className="btn sm" disabled={building !== null} onClick={() => void build("report")}>
											{building === "report" ? "Writing…" : "New report"}
										</button>
									</div>
								</header>
								{boards.length === 0 ? (
									<p className="muted" style={{ margin: 0 }}>
										None yet. Ask for one - “build me a sales dashboard” - or let it be built from your largest
										table with the buttons above.
									</p>
								) : (
									<div className="board-list">
										{boards.slice(0, 6).map((board) => (
											<Link key={board.slug} to={`/dashboards/${board.slug}`} className="board-row">
												<span className={`board-kind ${board.kind === "report" ? "report" : ""}`} aria-hidden>
													{board.kind === "report" ? "▤" : "▦"}
												</span>
												<span className="board-title">{board.title}</span>
												<span className="muted board-meta">
													{board.layout.length} widgets · {new Date(board.updatedAt).toLocaleDateString()}
												</span>
											</Link>
										))}
									</div>
								)}
							</section>
						</div>

						<div className="col" style={{ gap: 16 }}>
							{pending.length > 0 && (
								<section className="panel attention">
									<header className="panel-head">
										<h2>Waiting for your approval</h2>
										<Link to="/approvals" className="muted" style={{ marginLeft: "auto" }}>
											All approvals
										</Link>
									</header>
									<div className="col" style={{ gap: 10 }}>
										{pending.slice(0, 3).map((proposal) => (
											<ProposalCard
												key={proposal.id}
												proposal={proposal}
												compact
												onSettled={() => {
													reload();
													setGeneration((value) => value + 1);
												}}
											/>
										))}
									</div>
								</section>
							)}

							<section className="panel">
								<header className="panel-head">
									<h2>Your data model</h2>
									<button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setWizard(true)}>
										Connect another database
									</button>
								</header>
								<div className="model-list">
									{summary.objectTypes.map((type) => (
										<Link key={type.apiName} to={`/explorer?type=${type.apiName}`} className="model-row">
											<span className="model-dot" style={{ background: type.color ?? "var(--series-1)" }} aria-hidden />
											<span className="model-name">
												{type.pluralLabel ?? type.label}
												{type.origin === "combination" && <span className="chip">combined</span>}
											</span>
											<span className="muted num">{type.rowCount.toLocaleString("en-US")}</span>
											<span className="muted model-meta">
												{type.measures} measures · {type.dimensions} dimensions · {type.links} links
											</span>
										</Link>
									))}
								</div>
							</section>
						</div>
					</div>
				</>
			)}

			{wizard && (
				<ConnectWizard
					onClose={() => setWizard(false)}
					onImported={() => setGeneration((value) => value + 1)}
				/>
			)}
		</div>
	);
}

function OnboardingStep({
	n,
	title,
	active,
	children,
}: {
	n: number;
	title: string;
	active?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className={`onboarding-step ${active ? "active" : ""}`}>
			<span className="onboarding-n">{n}</span>
			<div>
				<h3>{title}</h3>
				<p>{children}</p>
			</div>
		</div>
	);
}

function Glance({ label, value, to, tone }: { label: string; value: number; to: string; tone?: "attention" }) {
	return (
		<Link to={to} className={`glance ${tone ?? ""}`}>
			<span className="glance-value num">{value.toLocaleString("en-US")}</span>
			<span className="glance-label">{label}</span>
		</Link>
	);
}
