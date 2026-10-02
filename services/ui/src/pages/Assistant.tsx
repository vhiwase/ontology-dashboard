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
import { Link, useSearchParams } from "react-router-dom";
import { ResourcePreview } from "../components/spaces/ResourcePreview";
import { FunctionReview } from "../components/functions/FunctionReview";
import { useSpace } from "../SpaceContext";
import {
	type AssistantHealth,
	type ChatArtifact,
	type ChatResponse,
	type ChatToolCall,
	type FeasibilityItem,
	type ProposalRecord,
	api,
	formatPeriod,
	formatValue,
	grainOf,
} from "../api";
import { Chart, type ChartKind } from "../components/Chart";
import { ProposalCard } from "../components/ProposalCard";
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
	const { spaceSlug, isPersonal, reload } = useSpace();
	// A question handed over from elsewhere (the home page's ask box, a
	// suggestion) arrives as ?q= and is asked once, then cleared from the URL.
	const [params, setParams] = useSearchParams();
	const handedOver = useRef<string | null>(params.get("q"));
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
			.get<ProviderCatalogue>("/api/assistant/providers")
			.then((body) => {
				setCatalogue(body);
				// Only adopt the server's default before the user has chosen, so a
				// refresh of availability never overrides an explicit pick.
				setProvider((current) => current ?? body.default);
			})
			.catch(() => setCatalogue(null));
	}, []);

	// Suggestions are written from this space's own metrics, so they follow it.
	useEffect(() => {
		api
			.get<{ starters: Starter[] }>(`/api/assistant/starters?space=${spaceSlug}`)
			.then((body) => setStarters(body.starters))
			.catch(() => setStarters([]));
	}, [spaceSlug]);

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

	// Ask the handed-over question once the model catalogue has settled, so it
	// goes to the same provider the picker shows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once
	useEffect(() => {
		const question = handedOver.current;
		if (!question || !catalogue) return;
		handedOver.current = null;
		params.delete("q");
		setParams(params, { replace: true });
		const trimmed = question.trim();
		// A prompt that ends mid-sentence ("Build me a dashboard about ") is a
		// starting point to finish, not a question to send.
		if (/\s$/.test(question) || trimmed.endsWith(" about")) {
			setInput(question);
			textareaRef.current?.focus();
		} else {
			void send(trimmed);
		}
	}, [catalogue]);

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
						{isPersonal ? (
							<p className="secondary" style={{ margin: "0 0 12px", maxWidth: 780 }}>
								I work from your <Link to="/ontology">data model</Link>: the tables you imported, the links
								between them and the <Link to="/dashboards#metrics">metrics</Link> defined on them. Ask for a
								chart, a KPI, a dashboard or a report. If your data can answer it, you get it; if it needs a
								new link, a combined dataset or a metric, I draft that for you to approve; if the data cannot
								answer it, I say what is missing. I never estimate a number.
							</p>
						) : (
							<p className="secondary" style={{ margin: "0 0 12px", maxWidth: 780 }}>
								I know this space's ontology: <Link to="/ontology">object types</Link>, their links, the{" "}
								<Link to="/dashboards">metric catalogue</Link> and the action layer. Ask me a question, or tell
								me what dashboard you need and I will build it. Every figure I show is measured from the data;
								where it does not carry something, I will say so rather than estimate it.
							</p>
						)}
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
						onApproved={(settled) => {
							reload();
							// Say what changed, in the conversation where it was asked for.
							const built = settled
								.map((entry) => entry.result?.built)
								.find((entry): entry is { kind: "dashboard" | "report"; slug: string; title: string; widgets: number } =>
									Boolean(entry && "slug" in entry),
								);
							if (built) {
								setTurns((current) => [
									...current,
									{
										role: "assistant",
										content: `Approved and built: **${built.title}**, a ${built.kind} with ${built.widgets} widgets.`,
										artifacts: [{ kind: "dashboard", slug: built.slug, title: built.title, widgets: built.widgets, boardKind: built.kind }],
									},
								]);
								return;
							}
							// Nothing to open: the question that asked for this can be
							// answered now, one click away rather than retyped.
							const asked = turns
								.slice(0, index)
								.reverse()
								.find((entry) => entry.role === "user")?.content;
							const applied = settled.filter((entry) => entry.status === "applied").map((entry) => entry.title);
							if (asked && applied.length > 0) {
								setTurns((current) => [
									...current,
									{
										role: "assistant",
										content: `Approved: ${applied.join(", ")}.`,
										artifacts: [
											{
												kind: "clarification",
												question: `Approved: ${applied.join(", ")}. Ask again now?`,
												options: [{ label: asked, detail: "answered from what you just approved" }],
												allowFreeText: false,
											},
										],
									},
								]);
							}
						}}
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
						placeholder={
							isPersonal
								? "Ask for a chart, a KPI, a dashboard or a report — “revenue by country per month”."
								: "Ask about the data — or ask for a dashboard."
						}
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
	onApproved,
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
	/** A proposal in this turn was approved (with whatever it settled). */
	onApproved?: (settled: ProposalRecord[]) => void;
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
								onApproved={onApproved}
								onAsk={onAnswer}
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

/** A proposal from the conversation, read in full so the evidence shows. */
function ProposalArtifact({
	id,
	onApproved,
}: {
	id: number;
	onApproved?: (settled: ProposalRecord[]) => void;
}) {
	const [proposal, setProposal] = useState<ProposalRecord | null>(null);
	const [missing, setMissing] = useState(false);
	useEffect(() => {
		api
			.get<ProposalRecord>(`/api/proposals/${id}`)
			.then(setProposal)
			.catch(() => setMissing(true));
	}, [id]);
	if (missing) return null;
	if (!proposal) return <Spinner label="Loading the proposal" />;
	return (
		<ProposalCard
			proposal={proposal}
			compact
			onSettled={(settled) => {
				if (settled.some((entry) => entry.status === "applied")) onApproved?.(settled);
			}}
		/>
	);
}

const STATUS_MARK: Record<string, { mark: string; tone: string; label: string }> = {
	ready: { mark: "✓", tone: "good", label: "Ready" },
	needs_approval: { mark: "◐", tone: "warning", label: "Needs approval" },
	not_possible: { mark: "✕", tone: "critical", label: "Not possible" },
};

/** What the data can answer, one approval away, or not at all. */
function FeasibilityArtifact({
	items,
	onAsk,
}: {
	items: FeasibilityItem[];
	onAsk?: (text: string) => void;
}) {
	const [open, setOpen] = useState(false);
	if (items.length === 0) return null;
	const counts = items.reduce<Record<string, number>>((acc, item) => {
		acc[item.status] = (acc[item.status] ?? 0) + 1;
		return acc;
	}, {});
	return (
		<div className="feasibility">
			<button className="feasibility-head" onClick={() => setOpen((value) => !value)}>
				<span className="muted">Checked against your data:</span>
				{(["ready", "needs_approval", "not_possible"] as const).map((status) =>
					counts[status] ? (
						<span key={status} className={`chip ${STATUS_MARK[status]!.tone}`}>
							{STATUS_MARK[status]!.mark} {counts[status]} {STATUS_MARK[status]!.label.toLowerCase()}
						</span>
					) : null,
				)}
				<span className="muted" style={{ marginLeft: "auto" }}>
					{open ? "hide" : "details"}
				</span>
			</button>
			{open && (
				<ul className="feasibility-list">
					{items.map((item, index) => {
						const status = STATUS_MARK[item.status] ?? STATUS_MARK.ready!;
						return (
							<li key={index} className={`feasibility-item ${item.status}`}>
								<span className={`feasibility-mark ${status.tone}`} aria-label={status.label}>
									{status.mark}
								</span>
								<div>
									<div>{item.explanation}</div>
									{item.missing && item.missing.length > 0 && (
										<div className="muted" style={{ fontSize: 12 }}>
											Missing: {item.missing.join("; ")}
										</div>
									)}
									{item.alternatives && item.alternatives.length > 0 && (
										<div className="row" style={{ gap: 5, marginTop: 4 }}>
											<span className="muted" style={{ fontSize: 12 }}>
												Try instead:
											</span>
											{item.alternatives.slice(0, 4).map((alternative) => (
												<button key={alternative} className="starter sm" onClick={() => onAsk?.(alternative)}>
													{alternative}
												</button>
											))}
										</div>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

function ArtifactView({
	artifact,
	onReviewFunction,
	onApproved,
	onAsk,
}: {
	artifact: ChatArtifact;
	onReviewFunction?: (apiName: string) => void;
	onApproved?: (settled: ProposalRecord[]) => void;
	onAsk?: (text: string) => void;
}) {
	if (artifact.kind === "feasibility") {
		return <FeasibilityArtifact items={(artifact.items as FeasibilityItem[]) ?? []} onAsk={onAsk} />;
	}

	if (artifact.kind === "proposal") {
		const proposal = artifact.proposal as { id: number } | undefined;
		return proposal?.id ? <ProposalArtifact id={proposal.id} onApproved={onApproved} /> : null;
	}

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
		const report = artifact.boardKind === "report";
		return (
			<Link className="board-artifact" to={`/dashboards/${String(artifact.slug)}`}>
				<span className={`board-kind ${report ? "report" : ""}`} aria-hidden>
					{report ? "▤" : "▦"}
				</span>
				<span className="board-artifact-text">
					<strong>{String(artifact.title)}</strong>
					<span className="muted">
						{report ? "Report" : "Dashboard"} · {String(artifact.widgets)} widgets
					</span>
				</span>
				<span className="btn sm primary">Open {report ? "report" : "dashboard"}</span>
			</Link>
		);
	}

	if (artifact.kind === "chart") {
		const series = (artifact.series as Array<{ label: string; value: number | null }>) ?? [];
		const grain = (artifact.dimensionGrain as string | null) ?? grainOf(artifact.dimension as string | null);
		const formatLabel = grain ? (label: string) => formatPeriod(label, grain) : undefined;
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
					formatLabel={formatLabel}
					partialLabel={(artifact.partialPeriod as string | null) ?? null}
				/>
				{Boolean(artifact.partialPeriod) && (
					<p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
						{formatLabel ? formatLabel(String(artifact.partialPeriod)) : String(artifact.partialPeriod)} is
						incomplete: the data runs to {String(artifact.dataThrough)}.
					</p>
				)}
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
