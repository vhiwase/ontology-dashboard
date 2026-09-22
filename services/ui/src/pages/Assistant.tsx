/**
 * The AI-FDE conversation.
 *
 * Two things here are not cosmetic:
 *
 * TOOL CALLS ARE VISIBLE. Every answer shows which ontology queries produced it,
 * and each one expands to its arguments and result. A business user who cannot
 * see where a number came from has no way to trust it, and an engineer debugging a
 * bad answer needs to see which call went wrong.
 *
 * ARTEFACTS RENDER AS ARTEFACTS. When the assistant runs a KPI it returns the
 * series, so the UI draws the chart rather than leaving the user to read numbers
 * out of a paragraph. When it builds a dashboard, the reply carries a link to it.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ResourcePreview } from "../components/spaces/ResourcePreview";
import { FunctionReview } from "../components/functions/FunctionReview";
import { useSpace } from "../SpaceContext";
import {
	type AssistantHealth,
	type ChatArtifact,
	type ChatResponse,
	type ChatToolCall,
	api,
	formatValue,
} from "../api";
import { Chart, type ChartKind } from "../components/Chart";
import { DataTable, ErrorBanner, Markdown, Spinner, useScrollToBottom } from "../components/common";

interface Turn {
	role: "user" | "assistant";
	content: string;
	toolCalls?: ChatToolCall[];
	artifacts?: ChatArtifact[];
	meta?: {
		rounds: number;
		latencyMs: number;
		model: string;
		stoppedBecause: string;
		failoverReason?: string | null;
		tokens?: number;
		costUsd?: number;
		priced?: boolean;
	};
}

interface Starter {
	label: string;
	prompt: string;
}

interface ProviderOption {
	id: string;
	label: string;
	model: string;
	configured: boolean;
	available: boolean;
	/** Usable, but slow enough to warn about — a CPU-only local model. */
	slow: boolean;
	detail: string | null;
}

interface ProviderCatalogue {
	providers: ProviderOption[];
	auto: { id: string; label: string; resolvedTo: string | null; reason: string | null };
	/** Which option to preselect; the server yields off Ollama if it is not usable. */
	default: string;
}

export function Assistant() {
	const [turns, setTurns] = useState<Turn[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [sessionId, setSessionId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [health, setHealth] = useState<AssistantHealth | null>(null);
	const [starters, setStarters] = useState<Starter[]>([]);
	const [catalogue, setCatalogue] = useState<ProviderCatalogue | null>(null);
	// Null until the catalogue loads, then the server's suggested default.
	// Pinned per conversation rather than per turn, so a thread does not
	// silently change model half way through.
	const [provider, setProvider] = useState<string | null>(null);
	const { spaceSlug } = useSpace();
	// The resource a chip in a reply opened. An answer that names an object
	// type should be able to show it, not just spell it.
	const [previewId, setPreviewId] = useState<number | null>(null);
	// A metric the assistant drafted, opened for review from the chat. The
	// dialog lives on the page rather than inside the artifact so it survives
	// the turn list re-rendering underneath it.
	const [reviewFunction, setReviewFunction] = useState<string | null>(null);
	// The cited document being read, if any.
	const [doc, setDoc] = useState<{
		path: string;
		title: string;
		category: string;
		sections: Array<{ title: string; body: string }>;
		focus: string;
	} | null>(null);
	const scrollRef = useScrollToBottom(turns.length + (busy ? 1 : 0));
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		api
			.get<AssistantHealth>("/api/assistant/health")
			.then(setHealth)
			.catch(() => setHealth(null));
		api
			.get<{ starters: Starter[] }>("/api/assistant/starters")
			.then((body) => setStarters(body.starters))
			.catch(() => setStarters([]));
		api
			.get<ProviderCatalogue>("/api/assistant/providers")
			.then((body) => {
				setCatalogue(body);
				// Only adopt the server's default before the user has chosen, so a
				// refresh of availability never overrides an explicit pick.
				setProvider((current) => current ?? body.default);
			})
			.catch(() => setCatalogue(null));
	}, []);

	const selected = catalogue?.providers.find((p) => p.id === provider) ?? null;

	// A conversation belongs to one space, so changing space starts a new one
	// rather than carrying the old thread across an environment boundary.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
	useEffect(() => {
		setTurns([]);
		setSessionId(null);
	}, [spaceSlug]);

	/** Open the workspace resource a :resource[kind:ref] chip refers to. */
	const openResource = async (kind: string, ref: string) => {
		try {
			const found = await api.get<{ id: number } | null>(
				`/api/resources/lookup?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}&space=${spaceSlug}`,
			);
			if (found?.id) setPreviewId(found.id);
			else setError(`${ref} is not registered as a resource in this space.`);
		} catch {
			setError("Could not open that resource.");
		}
	};

	/** Open a cited document, scrolled to the section that was cited. */
	const openCitation = async (path: string, section: string) => {
		try {
			const page = await api.get<{
				path: string;
				title: string;
				category: string;
				sections: Array<{ title: string; body: string }>;
			}>(`/api/docs/page/${path}`);
			setDoc({ ...page, focus: section });
		} catch {
			setError(`Could not open the document '${path}'.`);
		}
	};

	const send = async (message: string) => {
		const trimmed = message.trim();
		if (!trimmed || busy) return;
		setError(null);
		setInput("");
		setTurns((current) => [...current, { role: "user", content: trimmed }]);
		setBusy(true);

		try {
			const response = await api.post<ChatResponse>("/api/assistant/chat", {
				message: trimmed,
				sessionId,
				// The conversation belongs to the space it was started in.
				spaceSlug,
				// Omitted while the catalogue is still loading, which leaves the
				// server on its configured chain rather than guessing here.
				...(provider ? { provider } : {}),
			});
			setSessionId(response.sessionId);
			setTurns((current) => [
				...current,
				{
					role: "assistant",
					content: response.reply,
					toolCalls: response.toolCalls,
					artifacts: response.artifacts,
					meta: {
						rounds: response.rounds,
						latencyMs: response.latencyMs,
						model: response.model,
						stoppedBecause: response.stoppedBecause,
						failoverReason: response.failoverReason,
						tokens: response.cost?.totalTokens,
						costUsd: response.cost?.usd,
						priced: response.cost?.priced,
					},
				},
			]);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
			textareaRef.current?.focus();
		}
	};

	const llmDown = health && !health.llm.reachable;
	const modelMissing = health?.llm.reachable && health.llm.modelPresent === false;
	// The primary can be in cooldown while the fallback answers fine. That is a
	// working state, not an error, so it gets a note rather than a red banner.
	const onFallback = Boolean(
		health?.llm.breakerOpen ||
			(health?.configuredProvider && health.configuredProvider !== "auto" &&
				health.provider !== health.configuredProvider),
	);

	return (
		<div className="chat">
			<div className="chat-scroll" ref={scrollRef}>
				{(llmDown || modelMissing) && (
					<div className="banner error" style={{ marginBottom: 12 }}>
						<strong>The language model is not ready.</strong>{" "}
						{llmDown ? (
							<>
								{health?.provider === "ollama"
									? "Ollama is not reachable. "
									: "The configured provider is not reachable. "}
								{health?.llm.detail}
							</>
						) : (
							<>
								Ollama is up but the model <code>{health?.model}</code> has not been pulled
								yet. Run{" "}
								<code>docker compose exec ollama ollama pull {health?.model}</code> and
								reload. Everything else in this workbench works without it.
							</>
						)}
					</div>
				)}

				{onFallback && !llmDown && (
					<div className="banner" style={{ marginBottom: 12 }}>
						<strong>Running on the fallback model.</strong>{" "}
						{health?.llm.lastFailoverReason ?? health?.providerReason}{" "}
						Answers are unaffected; only which model produces them has changed.
					</div>
				)}

				{turns.length === 0 && (
					<div className="card" style={{ marginBottom: 12 }}>
						<div className="card-head">
							<h3>AI-FDE</h3>
							<span className="sub" title={health?.providerReason ?? undefined}>
								{health ? `${health.provider} · ${health.model}` : "checking model…"}
							</span>
						</div>
						{health?.providerReason && (
							<p className="muted" style={{ margin: "0 0 10px", fontSize: 11.5 }}>
								{health.providerReason}
							</p>
						)}
						<p className="secondary" style={{ margin: "0 0 12px", maxWidth: 780 }}>
							I know this TMS ontology: {" "}
							<Link to="/ontology">object types</Link>, their links, the{" "}
							<Link to="/dashboards">KPI catalogue</Link> and the action layer. Ask me a
							question about the freight book, or tell me what dashboard you need and I
							will build it. I will tell you which figures are measured and which rest on
							simulated execution data.
						</p>
						<div className="starters">
							{starters.map((starter) => (
								<button key={starter.label} className="starter" onClick={() => void send(starter.prompt)}>
									{starter.label}
								</button>
							))}
						</div>
					</div>
				)}

				{turns.map((turn, index) => (
					<TurnView
						key={index}
						turn={turn}
						onResource={openResource}
						onCitation={openCitation}
						onAnswer={(answer) => void send(answer)}
						onReviewFunction={setReviewFunction}
					/>
				))}

				{busy && (
					<div className="msg assistant">
						<div className="avatar">AI</div>
						<div className="body">
							<Spinner label="Querying the ontology…" />
						</div>
					</div>
				)}

				{error && (
					<div style={{ marginTop: 10 }}>
						<ErrorBanner error={error} />
					</div>
				)}
			</div>

			<div className="composer">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void send(input);
					}}
				>
					<textarea
						ref={textareaRef}
						value={input}
						placeholder="Ask about orders, carriers, lanes, margin — or ask for a dashboard."
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							// Enter sends; Shift+Enter is a newline. Standard for a chat box, and
							// the hint below says so.
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void send(input);
							}
						}}
						rows={2}
					/>
					<button className="btn primary" type="submit" disabled={busy || !input.trim()}>
						{busy ? "Working…" : "Send"}
					</button>
				</form>
				<div className="row muted" style={{ fontSize: 11, marginTop: 6, gap: 10 }}>
					<label className="model-picker">
						<span>Model</span>
						<select
							value={provider ?? ""}
							disabled={!catalogue}
							onChange={(event) => setProvider(event.target.value)}
							// Changing model mid-thread is allowed; the prior turns are
							// replayed to whichever model answers next.
							title={selected?.detail ?? undefined}
						>
							{catalogue?.providers.map((option) => (
								<option key={option.id} value={option.id} disabled={!option.available}>
									{option.label}
									{!option.available ? " — unavailable" : option.slow ? " — slow (CPU)" : ""}
								</option>
							))}
							{catalogue && (
								<option value="auto">
									{catalogue.auto.label}
									{catalogue.auto.resolvedTo ? ` — ${catalogue.auto.resolvedTo}` : ""}
								</option>
							)}
						</select>
					</label>
					{selected && <span className="mono">{selected.model}</span>}
					{selected?.detail && (selected.slow || !selected.available) && (
						<span className="model-warn" title={selected.detail}>
							⚠ {selected.slow ? "CPU-only — answers take minutes" : selected.detail}
						</span>
					)}
					<span>Enter to send · Shift+Enter for a new line</span>
					{sessionId && <span>session {sessionId}</span>}
					{turns.length > 0 && (
						<button
							className="btn sm"
							style={{ marginLeft: "auto" }}
							onClick={() => {
								setTurns([]);
								setSessionId(null);
							}}
						>
							New conversation
						</button>
					)}
				</div>
			</div>

			<ResourcePreview resourceId={previewId} onClose={() => setPreviewId(null)} />

			<FunctionReview
				apiName={reviewFunction}
				onClose={() => setReviewFunction(null)}
				onApproved={(fn) => {
					// Say what changed, in the conversation where it was asked for.
					setTurns((current) => [
						...current,
						{
							role: "assistant",
							content:
								`**${fn.name}** is approved and active. You can use it in a dashboard now, ` +
								`or ask me to build one with it.`,
						},
					]);
				}}
			/>

			{doc && (
				<div
					className="rp-backdrop"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setDoc(null);
					}}
				>
					<div className="rp" role="dialog" aria-label={doc.title}>
						<header className="rp-head">
							<span className="rp-glyph" aria-hidden>
								§
							</span>
							<div className="rp-heading">
								<div className="rp-kind">{doc.category.toUpperCase()}</div>
								<h2 className="rp-title">{doc.title}</h2>
							</div>
							<span className="rp-rows mono">{doc.path}</span>
							<button className="btn sm" onClick={() => setDoc(null)} aria-label="Close">
								✕
							</button>
						</header>
						<div className="rp-body">
							{doc.sections.map((section) => (
								<section
									key={section.title}
									/* The cited section is highlighted, so a citation lands on
									   the sentence it was making rather than the top of a page. */
									className={`doc-section ${section.title === doc.focus ? "cited" : ""}`}
								>
									<h4>{section.title}</h4>
									<p>{section.body}</p>
								</section>
							))}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function TurnView({
	turn,
	onResource,
	onCitation,
	onAnswer,
	onReviewFunction,
}: {
	turn: Turn;
	/** Opens the workspace resource a :resource[...] chip names. */
	onResource: (kind: string, ref: string) => void;
	/** Opens the document a :citation[...] marker refers to. */
	onCitation: (path: string, section: string) => void;
	/** Sends the user's pick when the assistant asked for clarification. */
	onAnswer: (answer: string) => void;
	/** Opens the review dialog for a metric the assistant drafted. */
	onReviewFunction?: (apiName: string) => void;
}) {
	// A clarification arrives as an artifact rather than prose, so the options
	// stay structured instead of being parsed back out of a sentence.
	const clarification = turn.artifacts?.find(
		(artifact) => artifact.kind === "clarification",
	) as
		| { question?: string; options?: Array<{ label: string; detail?: string }>; allowFreeText?: boolean }
		| undefined;
	const [showTools, setShowTools] = useState(false);

	if (turn.role === "user") {
		return (
			<div className="msg">
				<div className="avatar">You</div>
				<div className="body">
					<p style={{ margin: 0 }}>{turn.content}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="msg assistant">
			<div className="avatar">AI</div>
			<div className="body">
				{clarification ? (
					/* The assistant asked rather than guessed. Its options are the
					   answer, so they are buttons: picking one is far less work than
					   retyping the question's terms. */
					<div className="clarify">
						<p className="clarify-q">{String(clarification.question ?? turn.content)}</p>
						<div className="clarify-options">
							{(clarification.options as Array<{ label: string; detail?: string }>).map(
								(option) => (
									<button
										key={option.label}
										className="clarify-option"
										onClick={() => onAnswer(option.label)}
									>
										<span className="clarify-label">{option.label}</span>
										{option.detail && <span className="muted">{option.detail}</span>}
									</button>
								),
							)}
						</div>
						{clarification.allowFreeText !== false && (
							<p className="muted clarify-hint">
								Or answer in your own words below.
							</p>
						)}
					</div>
				) : (
					<Markdown text={turn.content} onResource={onResource} onCitation={onCitation} />
				)}

				{turn.artifacts && turn.artifacts.length > 0 && (
					<div className="col" style={{ gap: 10, marginTop: 10 }}>
						{turn.artifacts.map((artifact, index) => (
							<ArtifactView
								key={index}
								artifact={artifact}
								onReviewFunction={onReviewFunction}
							/>
						))}
					</div>
				)}

				{turn.toolCalls && turn.toolCalls.length > 0 && (
					<>
						<div className="tool-strip">
							{turn.toolCalls.map((call, index) => (
								<span key={index} className={`tool-pill ${call.ok ? "" : "failed"}`}>
									{call.ok ? "✓" : "✕"} {call.name} <span className="num">{call.durationMs}ms</span>
								</span>
							))}
							<button
								className="tool-pill"
								style={{ cursor: "pointer" }}
								onClick={() => setShowTools((current) => !current)}
							>
								{showTools ? "hide detail" : "show detail"}
							</button>
						</div>

						{showTools && (
							<div className="col" style={{ gap: 7, marginTop: 6 }}>
								{turn.toolCalls.map((call, index) => (
									<details key={index} open={!call.ok}>
										<summary className="mono" style={{ cursor: "pointer", fontSize: 11.5 }}>
											{call.name}
										</summary>
										<pre className="mono" style={{ marginTop: 5, whiteSpace: "pre-wrap", fontSize: 11 }}>
											{JSON.stringify(call.arguments, null, 2)}
											{"\n→ "}
											{call.preview}
										</pre>
									</details>
								))}
							</div>
						)}
					</>
				)}

				{turn.meta && (
					<div className="muted" style={{ fontSize: 11, marginTop: 7 }}>
						{turn.meta.rounds} round{turn.meta.rounds === 1 ? "" : "s"} ·{" "}
						{(turn.meta.latencyMs / 1000).toFixed(1)}s · {turn.meta.model}
						{turn.meta.stoppedBecause !== "answered" && ` · ${turn.meta.stoppedBecause}`}
						{turn.meta.failoverReason && " · answered by the fallback model"}
						{/* Tokens and cost per turn, so the price of a question is visible
						    where the question was asked rather than only in a report.
						    A turn on an unpriced provider says so instead of showing $0. */}
						{turn.meta.tokens ? ` · ${turn.meta.tokens.toLocaleString("en-US")} tokens` : ""}
						{turn.meta.priced === false
							? " · unpriced model"
							: turn.meta.costUsd !== undefined
								? ` · $${turn.meta.costUsd < 0.01 ? turn.meta.costUsd.toFixed(6) : turn.meta.costUsd.toFixed(4)}`
								: ""}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The decision card for a drafted pipeline.
 *
 * Its own component because it holds state - a card that has been accepted
 * should say so rather than keep offering the button, and the artifact list
 * re-renders around it.
 */
function PipelineProposalCard({
	pipeline,
	compiled,
}: {
	pipeline: {
		slug: string;
		name: string;
		description: string | null;
		graph: { nodes: Array<{ id: string; kind: string; name: string }> };
		acceptedBy: string | null;
	};
	compiled: Array<{ node: string; ok: boolean; detail: string }>;
}) {
	const [state, setState] = useState<"pending" | "accepted" | "rejected">(
		pipeline.acceptedBy ? "accepted" : "pending",
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nodes = pipeline.graph?.nodes ?? [];

	async function decide(action: "accept" | "reject") {
		setBusy(true);
		setError(null);
		try {
			if (action === "accept") {
				await api.post(`/api/pipelines/${pipeline.slug}/accept`);
				setState("accepted");
			} else {
				await api.del(`/api/pipelines/${pipeline.slug}`);
				setState("rejected");
			}
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="card fn-proposal-card">
			<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
				<span className="rp-glyph" aria-hidden>
					⑄
				</span>
				<div style={{ minWidth: 0, flex: "1 1 auto" }}>
					<div className="row" style={{ gap: 6 }}>
						<strong>{pipeline.name}</strong>
						<span className={`chip ${state === "accepted" ? "good" : state === "rejected" ? "bad" : "warn"}`}>
							{state === "accepted" ? "accepted" : state === "rejected" ? "rejected" : "proposed"}
						</span>
						<span className="chip mono">{nodes.length} nodes</span>
					</div>
					<p className="muted" style={{ margin: "3px 0 0", fontSize: 11.5 }}>
						{pipeline.description || "No description."}
					</p>

					{/* The graph as a line, which is how a pipeline reads. */}
					<p className="mono" style={{ margin: "6px 0 0", fontSize: 11 }}>
						{nodes.map((node) => node.name).join("  →  ")}
					</p>

					{/* Anything the compiler flagged. A node that compiles but
					    computes nothing is the failure worth surfacing here. */}
					{compiled
						.filter((entry) => !entry.ok || entry.detail.includes("computes nothing"))
						.map((entry) => (
							<p
								key={entry.node}
								className="muted"
								style={{ margin: "4px 0 0", fontSize: 11 }}
							>
								⚠ {entry.node}: {entry.detail}
							</p>
						))}

					{error && (
						<p className="muted" style={{ margin: "5px 0 0", fontSize: 11, color: "var(--bad)" }}>
							{error}
						</p>
					)}

					<p className="muted" style={{ margin: "5px 0 0", fontSize: 11 }}>
						{state === "accepted"
							? "Accepted. You can run it from the Pipeline builder."
							: state === "rejected"
								? "Rejected and removed."
								: "Nothing has run. Accepting makes it runnable."}
					</p>
				</div>

				<div className="col" style={{ gap: 5, marginLeft: "auto" }}>
					{state === "pending" && (
						<>
							<button className="btn sm primary" onClick={() => decide("accept")} disabled={busy}>
								Accept
							</button>
							<Link className="btn sm" to="/pipeline">
								Edit
							</Link>
							<button className="btn sm ghost" onClick={() => decide("reject")} disabled={busy}>
								Reject
							</button>
						</>
					)}
					{state === "accepted" && (
						<Link className="btn sm primary" to="/pipeline">
							Open
						</Link>
					)}
				</div>
			</div>
		</div>
	);
}

function ArtifactView({
	artifact,
	onReviewFunction,
}: {
	artifact: ChatArtifact;
	onReviewFunction?: (apiName: string) => void;
}) {
	// A drafted pipeline. Accept / Edit / Reject, as §18 asks - and the graph
	// is summarised inline so the decision can be made without leaving the
	// conversation for a canvas.
	if (artifact.kind === "pipelineProposal") {
		const pipeline = artifact.pipeline as {
			slug: string;
			name: string;
			description: string | null;
			graph: { nodes: Array<{ id: string; kind: string; name: string }> };
			acceptedBy: string | null;
		};
		const compiled = (artifact.compiled as Array<{ node: string; ok: boolean; detail: string }>) ?? [];
		return (
			<PipelineProposalCard pipeline={pipeline} compiled={compiled} />
		);
	}

	// A drafted metric. Deliberately not rendered as a finished result: it
	// computes nothing until someone approves it, so the card is an invitation
	// to review rather than a report of something done.
	if (artifact.kind === "functionProposal") {
		const fn = artifact.function as {
			apiName: string;
			name: string;
			description: string | null;
			returns: string;
			readsViews: string[];
		};
		return (
			<div className="card fn-proposal-card">
				<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
					<span className="rp-glyph" aria-hidden>
						ƒ
					</span>
					<div style={{ minWidth: 0, flex: "1 1 auto" }}>
						<div className="row" style={{ gap: 6 }}>
							<strong>{fn.name}</strong>
							<span className="chip warn">proposed</span>
							<span className="chip mono">{fn.returns}</span>
						</div>
						<p className="muted" style={{ margin: "3px 0 0", fontSize: 11.5 }}>
							{fn.description || "No description."}
						</p>
						<p className="muted" style={{ margin: "5px 0 0", fontSize: 11 }}>
							Reads {fn.readsViews?.join(", ") || "nothing detected"} · not usable until approved
						</p>
					</div>
					<button
						className="btn sm primary"
						style={{ marginLeft: "auto" }}
						onClick={() => onReviewFunction?.(fn.apiName)}
					>
						Review &amp; approve
					</button>
				</div>
			</div>
		);
	}

	if (artifact.kind === "dashboard") {
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="row" style={{ gap: 8 }}>
					<strong>{String(artifact.title)}</strong>
					<span className="chip">{String(artifact.widgets)} widgets</span>
					<Link className="btn sm primary" to={`/dashboards/${String(artifact.slug)}`} style={{ marginLeft: "auto" }}>
						Open dashboard
					</Link>
				</div>
			</div>
		);
	}

	if (artifact.kind === "chart") {
		const series = (artifact.series as Array<{ label: string; value: number | null }>) ?? [];
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>{String(artifact.title ?? artifact.kpi)}</h3>
					{artifact.total !== null && artifact.total !== undefined && (
						<span className="sub num">
							total{" "}
							{formatValue(
								artifact.total as number,
								String(artifact.format ?? "number"),
								artifact.unit as string | null,
							)}
						</span>
					)}
				</div>
				<Chart
					kind={(artifact.chart as ChartKind) ?? "hbar"}
					points={series}
					format={String(artifact.format ?? "number")}
					unit={artifact.unit as string | null}
				/>
				{Boolean(artifact.caveat) && (
					<p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
						{String(artifact.caveat)}
					</p>
				)}
			</div>
		);
	}

	if (artifact.kind === "table") {
		const rows = (artifact.rows as Array<Record<string, unknown>>) ?? [];
		if (rows.length === 0) return null;
		const columns = Object.keys(rows[0] ?? {})
			.filter((key) => !key.endsWith("__display") && !key.startsWith("_"))
			.slice(0, 7);
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>{String(artifact.title)}</h3>
					{artifact.rowsTotal !== undefined && (
						<span className="sub">
							{rows.length} of {String(artifact.rowsTotal)} rows
						</span>
					)}
				</div>
				<DataTable columns={columns.map((key) => ({ key, label: key }))} rows={rows} maxHeight={280} />
			</div>
		);
	}

	if (artifact.kind === "action") {
		const result = (artifact.result as Record<string, unknown>) ?? {};
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>{String(artifact.action)}</h3>
					<span className="chip">{String(artifact.status)}</span>
				</div>
				<DataTable
					columns={[
						{ key: "field", label: "Field" },
						{ key: "value", label: "Value" },
					]}
					rows={Object.entries(result)
						.filter(([key]) => key !== "note")
						.map(([key, value]) => ({ field: key, value }))}
					maxHeight={260}
				/>
				{Boolean(result.note) && (
					<p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
						{String(result.note)}
					</p>
				)}
			</div>
		);
	}

	if (artifact.kind === "lineage") {
		const byLayer = (artifact.upstreamByLayer as Record<string, string[]>) ?? {};
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>Lineage for {String(artifact.subject)}</h3>
					<Link className="btn sm" to="/lineage" style={{ marginLeft: "auto" }}>
						Open lineage graph
					</Link>
				</div>
				<dl className="kv">
					{Object.entries(byLayer).map(([layer, labels]) => (
						<div key={layer} style={{ display: "contents" }}>
							<dt>{layer}</dt>
							<dd className="secondary">{labels.join(", ")}</dd>
						</div>
					))}
				</dl>
			</div>
		);
	}

	return null;
}
