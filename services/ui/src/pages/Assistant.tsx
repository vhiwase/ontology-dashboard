/**
 * The AI-FDE conversation.
 *
 * Four things here are not cosmetic:
 *
 * TOOL CALLS ARE VISIBLE. Every answer shows which ontology queries produced it,
 * and each one expands to its arguments and result. A business user who cannot
 * see where a number came from has no way to trust it, and an engineer debugging a
 * bad answer needs to see which call went wrong.
 *
 * ARTEFACTS RENDER AS ARTEFACTS. When the assistant runs a KPI it returns the
 * series, so the UI draws the chart rather than leaving the user to read numbers
 * out of a paragraph. When it builds a dashboard, the reply carries a link to it.
 *
 * THE CONVERSATION OUTLIVES THE PAGE. It is held in ChatContext, one per space,
 * so opening a dataset or a schedule and coming back finds it where it was - and
 * a question still being answered keeps running meanwhile. Only "New
 * conversation" starts another.
 *
 * THE HISTORY IS BESIDE IT. Every conversation is stored as it happens; the
 * panel on the left lists them, newest first, and opens, renames, pins,
 * searches and deletes them (ChatHistoryPanel). It used to be a window behind
 * a button, which is how a history that was always kept came to look as if it
 * was not.
 *
 * A QUESTION IS ANSWERED BY CHOOSING. When the assistant asks - which tables,
 * which datasets, whether to go ahead - its options open in a panel above the
 * message box with a Submit button, one choice or several, so answering never
 * means retyping.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ResourcePreview } from "../components/spaces/ResourcePreview";
import { FunctionReview } from "../components/functions/FunctionReview";
import { useSpace } from "../SpaceContext";
import { type Turn, useChat } from "../ChatContext";
import {
	type AssistantHealth,
	type ChatArtifact,
	type FeasibilityItem,
	type ProposalRecord,
	api,
	formatPeriod,
	formatValue,
	grainOf,
} from "../api";
import { Chart, type ChartKind } from "../components/Chart";
import {
	type Clarification,
	ClarificationPanel,
	asClarification,
	chosenIn,
	replyProse,
	toggleChoice,
} from "../components/ClarificationPanel";
import { ChatHistoryPanel } from "../components/ChatHistoryPanel";
import { ProposalCard } from "../components/ProposalCard";
import { DataTable, ErrorBanner, Markdown, Refusal, Spinner, useScrollToBottom } from "../components/common";
import { Icon } from "../components/icons";

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
	detail: string | null;
}

interface ProviderCatalogue {
	providers: ProviderOption[];
	auto: { id: string; label: string; resolvedTo: string | null; reason: string | null };
	/** Which option to preselect: the administrator's default when one is set. */
	default: string;
}

/** Where the person stands against the monthly AI credit an administrator set. */
interface CreditStatus {
	mode: string;
	limitUsd: number | null;
	spentUsd: number;
	remainingUsd: number | null;
	exhausted: boolean;
	periodStart: string | null;
	resetsAt: string | null;
}

/** Whether the history panel is shown, remembered per browser. */
const HISTORY_KEY = "tms.chat.history";
/** Below this width the panel would squeeze the conversation, so it lies over it instead. */
const HISTORY_INLINE_FROM = 1080;

function historyPreference(): boolean {
	try {
		const stored = window.localStorage.getItem(HISTORY_KEY);
		if (stored === "open") return true;
		if (stored === "closed") return false;
	} catch {
		/* a private window: decided by the width below */
	}
	// Where there is room it is open: a history is for seeing, not for finding.
	return typeof window !== "undefined" && window.innerWidth >= HISTORY_INLINE_FROM;
}

function usd(value: number): string {
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dayAndMonth(iso: string | null): string {
	if (!iso) return "";
	return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

export function Assistant() {
	const { spaceSlug, isPersonal, reload } = useSpace();
	const chat = useChat();
	const { restore, setDraft, setAnswer, newConversation, open, append, setTitle, provider, setProvider } = chat;
	const conversation = chat.conversation(spaceSlug);
	const { turns, busy, draft, sessionId, loading } = conversation;
	// ?prompt= pre-fills the composer - how "Ask the AI-FDE to model it" hands a
	// request over. It is never sent on its own; the person reads it first.
	// A question handed over from elsewhere (the home page's ask box, a
	// suggestion) arrives as ?q= and is asked once, then cleared from the URL.
	const [params, setParams] = useSearchParams();
	const prefill = useRef<string | null>(params.get("prompt"));
	const handedOver = useRef<string | null>(params.get("q"));
	// ?session= opens that conversation - how a dashboard's history links back
	// to the one that built it.
	const linked = useRef<string | null>(params.get("session"));
	const [health, setHealth] = useState<AssistantHealth | null>(null);
	const [starters, setStarters] = useState<Starter[]>([]);
	const [catalogue, setCatalogue] = useState<ProviderCatalogue | null>(null);
	const [credit, setCredit] = useState<CreditStatus | null>(null);
	// Errors from this page's own lookups. A failed turn's error lives with the
	// conversation, so it is still there after going to another page and back.
	const [pageError, setPageError] = useState<string | null>(null);
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
	const [historyOpen, setHistoryOpenState] = useState(historyPreference);
	const setHistoryOpen = useCallback((shown: boolean) => {
		setHistoryOpenState(shown);
		try {
			window.localStorage.setItem(HISTORY_KEY, shown ? "open" : "closed");
		} catch {
			/* it still applies for this visit */
		}
	}, []);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// The question waiting for an answer: the latest turn's clarification, while
	// nothing has been said since and nothing is being answered.
	const last = turns[turns.length - 1];
	const pending =
		!busy && !loading && last?.role === "assistant"
			? asClarification(last.artifacts?.find((artifact) => artifact.kind === "clarification"))
			: null;
	// What is ticked so far belongs to this question only: it lapses as soon
	// as the conversation moves on.
	const inProgress = conversation.answer?.at === turns.length ? conversation.answer : null;
	const onlyOption = pending?.options.length === 1 ? pending.options[0] : undefined;
	// A question with one option has it ticked already: Submit is all it needs.
	const chosen = inProgress?.chosen ?? (onlyOption ? [onlyOption.label] : []);
	const panelOpen = pending !== null && pending.options.length > 0 && !inProgress?.later;

	const scrollRef = useScrollToBottom(turns.length + (busy ? 1 : 0) + (loading ? 1 : 0) + (panelOpen ? 1 : 0));

	const sendIn = chat.send;
	const creditOut = credit?.exhausted === true;
	// With the month's credit used up nothing is sent: the server would refuse
	// it. What was about to be asked is left in the box instead - a suggestion
	// clicked, a question handed over from another page - and the banner above
	// the box says why.
	const send = useCallback(
		(message: string) => {
			// Asking something new answers any notice left above the box.
			setPageError(null);
			if (creditOut) setDraft(spaceSlug, message);
			else void sendIn(spaceSlug, message);
		},
		[sendIn, setDraft, spaceSlug, creditOut],
	);

	// Reopen the conversation remembered for this space, unless it is already
	// on screen - or open the one a link asked for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the link is read once
	useEffect(() => {
		const wanted = Number(linked.current);
		linked.current = null;
		if (!Number.isInteger(wanted) || wanted <= 0) {
			restore(spaceSlug);
			return;
		}
		params.delete("session");
		setParams(params, { replace: true });
		void open(spaceSlug, wanted).then((opened) => {
			if (!opened) {
				setPageError(
					`Conversation ${wanted} could not be opened here. It may have been deleted, belong to someone else, or an answer is still on its way in this one.`,
				);
			}
		});
	}, [restore, open, spaceSlug]);

	useEffect(() => {
		if (prefill.current) {
			setDraft(spaceSlug, prefill.current);
			prefill.current = null;
		}
	}, [setDraft, spaceSlug]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: read once per visit
	useEffect(() => {
		api
			.get<AssistantHealth>("/api/assistant/health")
			.then(setHealth)
			.catch(() => setHealth(null));
		api
			.get<ProviderCatalogue>("/api/assistant/providers")
			.then((body) => {
				setCatalogue(body);
				// Only adopt the server's default before the person has chosen, so
				// a refresh of availability never overrides an explicit pick.
				if (provider === null) setProvider(body.default);
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

	// Re-read after every answer, since each one spends some of the credit -
	// and after a refusal, which may be the first this page hears of the limit.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these are the triggers
	useEffect(() => {
		api
			.get<CreditStatus>("/api/assistant/credit")
			.then(setCredit)
			.catch(() => setCredit(null));
	}, [conversation.answered, conversation.refusal]);

	const selected = catalogue?.providers.find((p) => p.id === provider) ?? null;

	/** Open the workspace resource a :resource[kind:ref] chip refers to. */
	const openResource = async (kind: string, ref: string) => {
		try {
			const found = await api.get<{ id: number } | null>(
				`/api/resources/lookup?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}&space=${spaceSlug}`,
			);
			if (found?.id) setPreviewId(found.id);
			else setPageError(`${ref} is not registered as a resource in this space.`);
		} catch {
			setPageError("Could not open that resource.");
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
			setPageError(`Could not open the document '${path}'.`);
		}
	};

	// Ask the handed-over question once the model catalogue has settled, so it
	// goes to the same provider the picker shows - and once any remembered
	// conversation is back, so it is asked there rather than lost under it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once
	useEffect(() => {
		const question = handedOver.current;
		if (!question || !catalogue || loading) return;
		handedOver.current = null;
		params.delete("q");
		setParams(params, { replace: true });
		const trimmed = question.trim();
		// A prompt that ends mid-sentence ("Build me a dashboard about ") is a
		// starting point to finish, not a question to send.
		if (/\s$/.test(question) || trimmed.endsWith(" about")) {
			setDraft(spaceSlug, question);
			textareaRef.current?.focus();
		} else {
			send(trimmed);
		}
	}, [catalogue, loading]);

	// Once an answer is in, the keyboard goes back to the composer - unless the
	// answer asked something, in which case it goes to the choices.
	const wasBusy = useRef(busy);
	const justAnswered = wasBusy.current && !busy;
	// biome-ignore lint/correctness/useExhaustiveDependencies: compares with the last render
	useEffect(() => {
		if (wasBusy.current && !busy && !panelOpen) textareaRef.current?.focus();
		wasBusy.current = busy;
	});

	const startNew = () => {
		setPageError(null);
		newConversation(spaceSlug);
		textareaRef.current?.focus();
	};

	/** Open a conversation from the history, unless an answer is still on its way here. */
	const openFromHistory = (id: number) => {
		setPageError(null);
		// Over the conversation rather than beside it (a narrow window): out
		// of the way once something has been chosen.
		if (window.innerWidth < HISTORY_INLINE_FROM) setHistoryOpenState(false);
		if (id === sessionId) return;
		void open(spaceSlug, id).then((opened) => {
			if (!opened) {
				setPageError(
					busy
						? "An answer is still on its way in this conversation. Open another one once it has arrived."
						: `Conversation ${id} could not be opened. It may have been deleted.`,
				);
			}
		});
	};

	// Its name in the history when it has one (given, or the first question as
	// the server kept it); otherwise the first question as it stands here.
	const title = conversation.title ?? turns.find((turn) => turn.role === "user")?.content ?? "New conversation";
	const creditShare = credit?.limitUsd ? Math.min(1, credit.spentUsd / credit.limitUsd) : creditOut ? 1 : 0;
	const llmDown = health && !health.llm.reachable;
	// A failed turn's error ends the transcript, under the question it belongs
	// to. One about the page (pageError) is shown above the message box instead.
	const error = conversation.error;

	return (
		<div className={`chat-layout ${historyOpen ? "with-history" : ""}`}>
		{historyOpen && (
			<>
				{/* Only drawn on a narrow window, where the panel lies over the
				    conversation: a click beside it puts it away. */}
				<div className="chat-history-backdrop" onClick={() => setHistoryOpenState(false)} aria-hidden />
				<ChatHistoryPanel
					space={spaceSlug}
					currentId={sessionId}
					// Read again when a conversation begins, and after every answer:
					// its place in the list and its message count have both moved.
					refreshKey={`${sessionId ?? "new"}:${conversation.answered}:${turns.length}`}
					busy={busy}
					onOpen={openFromHistory}
					onNew={() => {
						startNew();
						if (window.innerWidth < HISTORY_INLINE_FROM) setHistoryOpenState(false);
					}}
					onDeleted={(id) => {
						// The one on screen is gone from the server, so it goes from here too.
						if (id === sessionId) newConversation(spaceSlug);
					}}
					onRenamed={(id, name) => {
						if (id === sessionId) setTitle(spaceSlug, name);
					}}
					onClose={() => setHistoryOpen(false)}
				/>
			</>
		)}
		<div className="chat">
			<div className="chat-bar">
				<span className="chat-bar-mark" aria-hidden>
					<Icon name="message" size={15} />
				</span>
				<div className="chat-bar-text">
					<span className="chat-bar-title" title={title}>
						{title}
					</span>
					<span className="chat-bar-meta">
						{loading
							? "Opening your conversation…"
							: turns.length === 0
								? "Nothing asked yet"
								: `${turns.length} message${turns.length === 1 ? "" : "s"}${sessionId ? ` · session ${sessionId} · saved in your history` : ""}`}
					</span>
				</div>
				<div className="chat-bar-actions">
					<button
						className="btn sm ghost"
						onClick={() => setHistoryOpen(!historyOpen)}
						aria-pressed={historyOpen}
						title={historyOpen ? "Hide the conversation history" : "Show the conversation history"}
					>
						<Icon name="history" size={14} />
						History
					</button>
					{turns.length > 0 && (
						<button className="btn sm" onClick={startNew} disabled={busy}>
							<Icon name="plus" size={13} />
							New conversation
						</button>
					)}
				</div>
			</div>

			<div className="chat-scroll" ref={scrollRef}>
				{llmDown && (
					<div className="banner error" style={{ marginBottom: 12 }}>
						<strong>The language model is not ready.</strong>{" "}
						The configured provider is not reachable. {health?.llm.detail}
					</div>
				)}

				{loading && turns.length === 0 && (
					<div className="chat-restoring">
						<Spinner label="Opening your conversation" />
					</div>
				)}

				{!loading && turns.length === 0 && (
					<div className="card chat-welcome">
						<div className="card-head">
							<span className="chat-welcome-mark" aria-hidden>
								<Icon name="sparkles" size={20} />
							</span>
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
								I build the ontology from this space's <Link to="/browse/datasets">datasets</Link> - object
								types, the links between them, metrics and actions - and then answer from it. Ask me to sync a
								view, to model what has been synced, a question about the data, or to build a dashboard. Every
								figure I show is measured from the synced data; where the source does not carry something, I
								will say so rather than estimate it.
							</p>
						)}
						<div className="starters">
							{starters.map((starter) => (
								<button key={starter.label} className="starter" onClick={() => send(starter.prompt)}>
									<Icon name="sparkles" size={13} />
									{starter.label}
								</button>
							))}
						</div>
					</div>
				)}

				{turns.map((turn, index) => {
					const isPending = pending !== null && index === turns.length - 1;
					const next = turns[index + 1];
					return (
						<TurnView
							key={index}
							turn={turn}
							question={
								isPending
									? {
											chosen,
											panelOpen,
											onToggle: (label) =>
												setAnswer(spaceSlug, { chosen: toggleChoice(pending, chosen, label), later: false }),
											onOpen: () => setAnswer(spaceSlug, { chosen, later: false }),
										}
									: null
							}
							answer={next?.role === "user" ? next.content : null}
							onResource={openResource}
							onCitation={openCitation}
							onAnswer={send}
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
									append(spaceSlug, {
										role: "assistant",
										content: `Approved and built: **${built.title}**, a ${built.kind} with ${built.widgets} widgets.`,
										artifacts: [{ kind: "dashboard", slug: built.slug, title: built.title, widgets: built.widgets, boardKind: built.kind }],
									});
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
									append(spaceSlug, {
										role: "assistant",
										content: `Approved: ${applied.join(", ")}.`,
										artifacts: [
											{
												kind: "clarification",
												question: "Ask again now?",
												options: [{ label: asked, detail: "answered from what you just approved" }],
												allowFreeText: false,
											},
										],
									});
								}
							}}
						/>
					);
				})}

				{busy && (
					<div className="msg assistant">
						<div className="avatar">
							<Icon name="sparkles" size={16} />
							<span className="sr-only">AI</span>
						</div>
						<div className="body">
							<div className="typing" role="status">
								<i />
								<i />
								<i />
								<span className="typing-label">Querying the ontology…</span>
							</div>
						</div>
					</div>
				)}

				{/* Refused, not broken: said as it is, and the question is back in
				    the box below. Hidden once the credit banner there says the same. */}
				{conversation.refusal && !creditOut && (
					<div style={{ marginTop: 10 }}>
						<Refusal message={conversation.refusal} />
					</div>
				)}
				{error && (
					<div style={{ marginTop: 10 }}>
						<ErrorBanner error={error} />
					</div>
				)}
			</div>

			<div className="chat-dock">
				{panelOpen && pending && (
					<ClarificationPanel
						// A new question gets a new panel, with nothing typed in it.
						key={`${sessionId ?? "new"}:${turns.length}`}
						clarification={pending}
						chosen={chosen}
						autoFocus={justAnswered && draft.trim() === ""}
						onChange={(next) => setAnswer(spaceSlug, { chosen: next })}
						onSubmit={send}
						onDismiss={() => {
							setAnswer(spaceSlug, { chosen, later: true });
							textareaRef.current?.focus();
						}}
					/>
				)}

				<div className="composer">
					{/* About the page rather than an answer - a link to a conversation
					    that is gone, a chip that opens nothing. Said here, where it is in
					    view however far up the transcript the person is reading. */}
					{pageError && (
						<div className="banner error composer-banner composer-notice" role="alert">
							<span>{pageError}</span>
							<button type="button" className="link-button" onClick={() => setPageError(null)}>
								Dismiss
							</button>
						</div>
					)}
					{creditOut && credit && (
						<div className="banner warn composer-banner" role="status">
							<span>
								<strong>Your monthly AI credit is used up.</strong> {usd(credit.spentUsd)} of{" "}
								{usd(credit.limitUsd ?? 0)} spent since {dayAndMonth(credit.periodStart)}; it renews on{" "}
								{dayAndMonth(credit.resetsAt)}. Ask an administrator to raise your limit.
							</span>
						</div>
					)}
					<form
						onSubmit={(event) => {
							event.preventDefault();
							send(draft);
						}}
					>
						<textarea
							ref={textareaRef}
							value={draft}
							placeholder={
								panelOpen
									? "Or type a different answer here."
									: pending
										? "Answer the question above, or ask something else."
										: isPersonal
										? "Ask for a chart, a KPI, a dashboard or a report — “revenue by country per month”."
										: "Ask about the data — or ask for a dashboard."
							}
							onChange={(event) => setDraft(spaceSlug, event.target.value)}
							onKeyDown={(event) => {
								// Enter sends; Shift+Enter is a newline. Standard for a chat box, and
								// the hint below says so.
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									send(draft);
								}
							}}
							rows={2}
						/>
						<button className="btn primary" type="submit" disabled={busy || loading || !draft.trim() || creditOut}>
							{busy ? <span className="spinner" aria-hidden /> : <Icon name="arrowUp" size={16} />}
							{busy ? "Working…" : "Send"}
						</button>
					</form>
					<div className="row muted composer-meta">
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
										{!option.available ? " — unavailable" : ""}
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
						{selected?.detail && !selected.available && (
							<span className="model-warn" title={selected.detail}>
								<Icon name="alertTriangle" size={12} /> {selected.detail}
							</span>
						)}
						<span>Enter to send · Shift+Enter for a new line</span>
						{credit && credit.limitUsd !== null && (
							<span
								className={`credit-pill ${creditOut ? "out" : creditShare >= 0.8 ? "low" : ""}`}
								title={`Your monthly AI credit. It renews on ${dayAndMonth(credit.resetsAt)}.`}
							>
								<span className="credit-meter" aria-hidden>
									<span style={{ width: `${Math.round(creditShare * 100)}%` }} />
								</span>
								{usd(credit.spentUsd)} of {usd(credit.limitUsd)} this month
							</span>
						)}
					</div>
				</div>
			</div>

			<ResourcePreview resourceId={previewId} onClose={() => setPreviewId(null)} />

			<FunctionReview
				apiName={reviewFunction}
				onClose={() => setReviewFunction(null)}
				onApproved={(fn) => {
					// Say what changed, in the conversation where it was asked for.
					append(spaceSlug, {
						role: "assistant",
						content:
							`**${fn.name}** is approved and active. You can use it in a dashboard now, ` +
							`or ask me to build one with it.`,
					});
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
							<button className="icon-btn" onClick={() => setDoc(null)} aria-label="Close">
								<Icon name="x" size={17} />
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
		</div>
	);
}

/** The live side of a question that is still waiting for its answer. */
interface OpenQuestion {
	chosen: string[];
	/** The answer panel is showing above the message box. */
	panelOpen: boolean;
	onToggle: (label: string) => void;
	onOpen: () => void;
}

/**
 * The assistant's question, in the transcript.
 *
 * While the answer panel is open the card is only the question: the choices
 * are in the panel, and listing them twice an inch apart is noise. Once the
 * panel is put away the choices are here, and picking one reopens it with that
 * choice ticked. Once answered, the card records what the answer was.
 */
function ClarificationCard({
	clarification,
	question,
	answer,
}: {
	clarification: Clarification;
	question: OpenQuestion | null;
	answer: string | null;
}) {
	const picked = answer ? chosenIn(answer, clarification.options) : [];
	return (
		<div className={`clar-card ${question ? "pending" : ""}`}>
			<div className="clar-card-head">
				<span className="clar-mark sm" aria-hidden>
					<Icon name={question ? "message" : "checkCircle"} size={14} />
				</span>
				<p className="clar-card-q">{clarification.question}</p>
			</div>
			{clarification.options.length > 0 && !question?.panelOpen && (
				<div className="clar-chips">
					{clarification.options.map((option) => {
						if (!question) {
							const on = picked.includes(option.label);
							return (
								<span key={option.label} className={`clar-chip static ${on ? "on" : ""}`} title={option.detail}>
									{on && <Icon name="check" size={12} strokeWidth={2.6} />}
									{option.label}
								</span>
							);
						}
						const on = question.chosen.includes(option.label);
						return (
							<button
								key={option.label}
								type="button"
								className={`clar-chip ${on ? "on" : ""}`}
								aria-pressed={on}
								title={option.detail}
								onClick={() => question.onToggle(option.label)}
							>
								{on && <Icon name="check" size={12} strokeWidth={2.6} />}
								{option.label}
							</button>
						);
					})}
				</div>
			)}
			<div className="clar-card-foot">
				{question ? (
					clarification.options.length === 0 ? (
						<span className="muted">Type your answer in the message box below.</span>
					) : question.panelOpen ? (
						<span className="muted">
							{clarification.multiple
								? "Tick one or more in the panel below, then press Submit answer."
								: "Pick one in the panel below, then press Submit answer."}
						</span>
					) : (
						<>
							<span className="muted">Waiting for your answer.</span>
							<button type="button" className="btn sm primary" onClick={question.onOpen}>
								Answer
								<Icon name="arrowRight" size={13} />
							</button>
						</>
					)
				) : answer ? (
					<span className="muted clar-answered">
						You answered: <strong>{answer.split("\n\n")[0]}</strong>
					</span>
				) : (
					<span className="muted">Not answered.</span>
				)}
			</div>
		</div>
	);
}

function TurnView({
	turn,
	question,
	answer,
	onResource,
	onCitation,
	onAnswer,
	onReviewFunction,
	onApproved,
}: {
	turn: Turn;
	/** Set while this turn's question is the one waiting for an answer. */
	question: OpenQuestion | null;
	/** What was said next, when this turn asked a question. */
	answer: string | null;
	/** Opens the workspace resource a :resource[...] chip names. */
	onResource: (kind: string, ref: string) => void;
	/** Opens the document a :citation[...] marker refers to. */
	onCitation: (path: string, section: string) => void;
	/** Sends a suggested follow-up as the person's next message. */
	onAnswer: (answer: string) => void;
	/** Opens the review dialog for a metric the assistant drafted. */
	onReviewFunction?: (apiName: string) => void;
	/** A proposal in this turn was approved (with whatever it settled). */
	onApproved?: (settled: ProposalRecord[]) => void;
}) {
	// A clarification arrives as an artifact rather than prose, so the options
	// stay structured instead of being parsed back out of a sentence. Whatever
	// the assistant had to say before asking stays above the question.
	const raw = turn.artifacts?.find((artifact) => artifact.kind === "clarification");
	const clarification = asClarification(raw);
	const prose = replyProse(turn.content, clarification, raw?.inferred === true);
	const [showTools, setShowTools] = useState(false);

	if (turn.role === "user") {
		return (
			<div className="msg">
				<div className="avatar">
					<Icon name="user" size={15} />
					<span className="sr-only">You</span>
				</div>
				<div className="body">
					<p style={{ margin: 0 }}>{turn.content}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="msg assistant">
			<div className="avatar">
				<Icon name="sparkles" size={16} />
				<span className="sr-only">AI</span>
			</div>
			<div className="body">
				{prose && <Markdown text={prose} onResource={onResource} onCitation={onCitation} />}
				{clarification && (clarification.question || clarification.options.length > 0) && (
					<ClarificationCard clarification={clarification} question={question} answer={answer} />
				)}

				{turn.artifacts && turn.artifacts.length > 0 && (
					<div className="col" style={{ gap: 10, marginTop: 10 }}>
						<ChangesCard
							changes={turn.artifacts.filter((artifact) => artifact.kind === "ontologyChange")}
							onResource={onResource}
						/>
						{turn.artifacts
							.filter((artifact) => artifact.kind !== "ontologyChange")
							.map((artifact, index) => (
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
						{/* A turn read back from the server no longer knows its rounds or
						    mode; what it does know is still shown. Tokens and cost are per
						    turn, so the price of a question is visible where it was asked,
						    and a turn on an unpriced provider says so instead of showing $0. */}
						{[
							turn.meta.rounds !== undefined ? `${turn.meta.rounds} round${turn.meta.rounds === 1 ? "" : "s"}` : null,
							`${(turn.meta.latencyMs / 1000).toFixed(1)}s`,
							turn.meta.model || null,
							turn.meta.agentMode ? `mode: ${turn.meta.agentMode}` : null,
							turn.meta.stoppedBecause !== "answered" ? turn.meta.stoppedBecause : null,
							turn.meta.tokens ? `${turn.meta.tokens.toLocaleString("en-US")} tokens` : null,
							turn.meta.priced === false
								? "unpriced model"
								: turn.meta.costUsd !== undefined
									? `$${turn.meta.costUsd < 0.01 ? turn.meta.costUsd.toFixed(6) : turn.meta.costUsd.toFixed(4)}`
									: null,
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
				)}
			</div>
		</div>
	);
}

const CHANGE_LABELS: Record<string, { verb: string; glyph: string }> = {
	dataset: { verb: "Synced", glyph: "▤" },
	objectType: { verb: "Object type", glyph: "◈" },
	linkType: { verb: "Link", glyph: "↔" },
	kpi: { verb: "Metric", glyph: "Σ" },
	actionType: { verb: "Action", glyph: "⚡" },
};

/**
 * Everything a turn created, as one card.
 *
 * A build turn creates a dozen things; a card each would bury the answer. One
 * list, each entry opening the resource it names, is what the reader needs to
 * check the work.
 */
function ChangesCard({
	changes,
	onResource,
}: {
	changes: ChatArtifact[];
	onResource: (kind: string, ref: string) => void;
}) {
	if (changes.length === 0) return null;
	return (
		<div className="card">
			<div className="card-head">
				<h3>Built in this turn</h3>
				<span className="sub">{changes.length} change{changes.length === 1 ? "" : "s"}</span>
			</div>
			<ul className="rb-lineage-list" style={{ margin: 0 }}>
				{changes.map((change, index) => {
					const kind = String(change.change);
					const label = CHANGE_LABELS[kind] ?? { verb: "Changed", glyph: "▫" };
					const ref = String(change.apiName);
					return (
						<li key={`${kind}-${ref}-${index}`}>
							<span aria-hidden>{label.glyph}</span> <span className="muted">{label.verb}</span>{" "}
							<button type="button" className="res-chip" onClick={() => onResource(kind, ref)}>
								{kind === "dataset" ? ref.split(".").pop() : ref}
							</button>
							{change.detail ? <span className="muted"> · {String(change.detail)}</span> : null}
						</li>
					);
				})}
			</ul>
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

	// A drafted function. Deliberately not rendered as a finished result: it
	// computes nothing until an admin approves it, so the card is an invitation
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
						<Icon name="fn" size={18} />
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
					<Icon name={report ? "fileText" : "dashboard"} size={17} />
				</span>
				<span className="board-artifact-text">
					<strong>{String(artifact.title)}</strong>
					<span className="muted">
						{report ? "Report" : "Dashboard"} · {String(artifact.widgets)} widgets
					</span>
				</span>
				<span className="btn sm primary">
					Open {report ? "report" : "dashboard"}
					<Icon name="arrowRight" size={13} />
				</span>
			</Link>
		);
	}

	if (artifact.kind === "chart") {
		const series = (artifact.series as Array<{ label: string; value: number | null }>) ?? [];
		const grain = (artifact.dimensionGrain as string | null) ?? grainOf(artifact.dimension as string | null);
		const formatLabel = grain ? (label: string) => formatPeriod(label, grain) : undefined;
		return (
			<div className="card">
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
			<div className="card">
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
			<div className="card">
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

	// The plan the assistant is working through. Steps render with their live
	// status, because a plan only earns its place on the screen while it is
	// visibly being followed - a finished list of ticks is an answer, not a plan.
	if (artifact.kind === "plan" && artifact.plan) {
		const plan = artifact.plan as {
			title: string;
			background?: string | null;
			status: string;
			steps: Array<{ description: string; status: string }>;
		};
		const glyph: Record<string, string> = {
			pending: "○",
			in_progress: "◐",
			done: "●",
			skipped: "◌",
		};
		return (
			<div className="card">
				<div className="card-head">
					<h3>Plan · {plan.title}</h3>
					<span className="rp-rows mono" style={{ marginLeft: "auto" }}>
						{plan.status}
					</span>
				</div>
				{plan.background && <p className="secondary">{plan.background}</p>}
				<ol style={{ margin: "8px 0 0", paddingLeft: 4, listStyle: "none" }}>
					{plan.steps.map((step, index) => (
						<li key={index} style={{ padding: "3px 0" }}>
							<span aria-hidden style={{ marginRight: 8 }}>
								{glyph[step.status] ?? "○"}
							</span>
							<span className={step.status === "done" ? "secondary" : ""}>
								{step.description}
							</span>
						</li>
					))}
				</ol>
			</div>
		);
	}

	if (artifact.kind === "todos" && Array.isArray(artifact.todos)) {
		const todos = artifact.todos as Array<{ text: string; status: string }>;
		if (!todos.length) return null;
		return (
			<div className="card">
				<div className="card-head">
					<h3>Follow-ups</h3>
				</div>
				<ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
					{todos.map((todo, index) => (
						<li
							key={index}
							className={todo.status === "done" ? "secondary" : ""}
							style={{ padding: "2px 0" }}
						>
							{todo.status === "done" ? "✓ " : ""}
							{todo.text}
						</li>
					))}
				</ul>
			</div>
		);
	}

	// A mode switch is worth one quiet line in the transcript: it explains why
	// the next answer was shaped by a different set of tools.
	if (artifact.kind === "modeChange" && artifact.mode) {
		return (
			<p className="muted" style={{ fontSize: 12, margin: "8px 0" }}>
				↳ switched to the <strong>{String(artifact.label ?? artifact.mode)}</strong> mode
			</p>
		);
	}

	return null;
}
