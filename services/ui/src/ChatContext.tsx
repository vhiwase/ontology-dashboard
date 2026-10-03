/**
 * The assistant's conversations, held above the page that shows them.
 *
 * A conversation used to live in the Assistant page's own state, so going to
 * look at a dataset, a schedule or the object types unmounted the page and
 * threw the conversation away; coming back opened a new one. It lives here
 * now, one per space, for as long as the person is signed in - and its session
 * id is remembered per user and space, so a reload reopens it from the server.
 * Only "New conversation" starts a new one.
 *
 * A turn in flight belongs here too. Asking a question and going to look at a
 * dashboard while it is answered must not drop the answer: the request keeps
 * running, and its reply lands in the conversation it was asked in.
 *
 * Everything said is stored by the server as it is said, which is what the
 * history panel lists. The one exception was what the PAGE adds to a
 * conversation - "Approved and built: ..." after an approval made inside it -
 * which was on screen and nowhere else; append() now sends those to be kept
 * too, so a conversation reads the same when it is opened again.
 */

import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { type ChatArtifact, type ChatResponse, type ChatToolCall, ApiError, api, session } from "./api";
import { useSpace } from "./SpaceContext";

export interface Turn {
	role: "user" | "assistant";
	content: string;
	toolCalls?: ChatToolCall[];
	artifacts?: ChatArtifact[];
	meta?: {
		/** Unknown for a turn read back from the server. */
		rounds?: number;
		latencyMs: number;
		model: string;
		stoppedBecause: string;
		tokens?: number;
		costUsd?: number;
		priced?: boolean;
		/** The operational mode the conversation is in after this turn. */
		agentMode?: string;
	};
}

export interface Conversation {
	sessionId: number | null;
	/** Its name in the history, once it has been given one or opened from there. */
	title: string | null;
	turns: Turn[];
	busy: boolean;
	error: string | null;
	/**
	 * Why the server would not take the last question: the monthly credit is
	 * used up, or questions are coming too fast. Not a fault - the person (or
	 * an administrator) can put it right - so it is kept apart from `error`.
	 */
	refusal: string | null;
	draft: string;
	/** Reading a conversation back from the server. */
	loading: boolean;
	/** Bumped whenever an answer lands, so the page can tell a new one arrived. */
	answered: number;
	/**
	 * The person's answer in progress to the question on the latest turn: what
	 * is ticked so far, and whether they put it off. `at` is the turn count it
	 * was made at, so it lapses by itself once the conversation moves on.
	 */
	answer: { at: number; chosen: string[]; later: boolean } | null;
}

/** One message as /api/assistant/sessions/{id} returns it. */
interface StoredMessage {
	role: string;
	content: string | null;
	tool_calls: ChatToolCall[] | null;
	/** "page-note" on a line the page added itself, stored under the system role. */
	tool_name?: string | null;
	artifacts: ChatArtifact[] | null;
	latency_ms: number | null;
	model?: string | null;
	total_tokens?: number | null;
	cost_usd?: number | string | null;
}

/** What a stored conversation's own record says about it. */
interface StoredSession {
	sessionId: number;
	title?: string | null;
	messages: StoredMessage[];
}

/** How the server marks a line the page added to a conversation. */
const PAGE_NOTE = "page-note";

const EMPTY: Conversation = {
	sessionId: null,
	title: null,
	turns: [],
	busy: false,
	error: null,
	refusal: null,
	draft: "",
	loading: false,
	answered: 0,
	answer: null,
};

/** A stored conversation as the turns the page renders. */
export function turnsFromMessages(messages: StoredMessage[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			turns.push({ role: "user", content: message.content ?? "" });
		} else if (message.role === "assistant") {
			const cost = message.cost_usd === null || message.cost_usd === undefined ? undefined : Number(message.cost_usd);
			turns.push({
				role: "assistant",
				content: message.content ?? "",
				toolCalls: message.tool_calls ?? [],
				artifacts: message.artifacts ?? [],
				meta: {
					latencyMs: message.latency_ms ?? 0,
					model: message.model ?? "",
					stoppedBecause: "answered",
					tokens: message.total_tokens ?? undefined,
					costUsd: cost,
					// A turn the server could not price is stored with no cost;
					// say so rather than show it as free.
					priced: cost !== undefined ? true : message.model ? false : undefined,
				},
			});
		} else if (message.role === "system" && message.tool_name === PAGE_NOTE) {
			// What the page said in the conversation: shown as it was then, with
			// no model or cost beside it, because no model wrote it.
			turns.push({ role: "assistant", content: message.content ?? "", artifacts: message.artifacts ?? [] });
		}
	}
	return turns;
}

function assistantTurn(response: ChatResponse): Turn {
	return {
		role: "assistant",
		content: response.reply,
		toolCalls: response.toolCalls,
		artifacts: response.artifacts,
		meta: {
			rounds: response.rounds,
			latencyMs: response.latencyMs,
			model: response.model,
			stoppedBecause: response.stoppedBecause,
			tokens: response.cost?.totalTokens,
			costUsd: response.cost?.usd,
			priced: response.cost?.priced,
			agentMode: response.agentMode,
		},
	};
}

/**
 * Artifacts that mean the turn changed what the space holds: something was
 * synced or modelled, a dashboard was built, or a proposal is now waiting.
 */
const CHANGES_THE_SPACE = new Set<ChatArtifact["kind"]>(["ontologyChange", "dashboard", "proposal", "functionProposal"]);

// ── remembering which conversation is open ──────────────────────────────────

function storageKey(space: string): string {
	return `tms.chat.${session.user()?.username ?? "anonymous"}.${space}`;
}

function remembered(space: string): number | null {
	try {
		const raw = window.localStorage.getItem(storageKey(space));
		const id = raw ? Number(raw) : Number.NaN;
		return Number.isInteger(id) && id > 0 ? id : null;
	} catch {
		return null;
	}
}

function remember(space: string, sessionId: number | null): void {
	try {
		if (sessionId === null) window.localStorage.removeItem(storageKey(space));
		else window.localStorage.setItem(storageKey(space), String(sessionId));
	} catch {
		/* a private window refuses storage; the conversation still lives in memory */
	}
}

// ── the context ─────────────────────────────────────────────────────────────

interface ChatContextValue {
	conversation: (space: string) => Conversation;
	/** Reopen the conversation remembered for this space, once per sign-in. */
	restore: (space: string) => void;
	send: (space: string, message: string) => Promise<void>;
	newConversation: (space: string) => void;
	/** Open an earlier conversation. Resolves to whether it could be opened. */
	open: (space: string, sessionId: number) => Promise<boolean>;
	/** Add a turn written by the page itself, such as "Approved and built". It is stored too. */
	append: (space: string, turn: Turn) => void;
	/** The name the conversation on screen goes by, after it is renamed in the history. */
	setTitle: (space: string, title: string | null) => void;
	setDraft: (space: string, draft: string) => void;
	/** Record what is ticked for the latest turn's question, or that it was put off. */
	setAnswer: (space: string, change: { chosen?: string[]; later?: boolean }) => void;
	/** The model chosen in the picker, kept for the whole sign-in. */
	provider: string | null;
	setProvider: (provider: string | null) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
	const [conversations, setConversations] = useState<Record<string, Conversation>>({});
	const [provider, setProvider] = useState<string | null>(null);
	const { reload: reloadSpace } = useSpace();
	// The latest state for async work: a reply that lands after other changes
	// must read the conversation as it is then, not as it was when asked.
	const latest = useRef(conversations);
	latest.current = conversations;
	const providerRef = useRef(provider);
	providerRef.current = provider;
	// Spaces whose remembered conversation has been looked for already, so a
	// remount (or StrictMode's double effect) does not fetch it twice.
	const restored = useRef(new Set<string>());

	const update = useCallback((space: string, change: (current: Conversation) => Conversation) => {
		setConversations((all) => ({ ...all, [space]: change(all[space] ?? EMPTY) }));
	}, []);

	const load = useCallback(
		async (space: string, sessionId: number): Promise<boolean> => {
			update(space, (current) => ({ ...current, loading: true, error: null }));
			try {
				const body = await api.get<StoredSession>(`/api/assistant/sessions/${sessionId}`);
				remember(space, sessionId);
				update(space, (current) => ({
					...current,
					sessionId,
					title: body.title ?? null,
					turns: turnsFromMessages(body.messages),
					loading: false,
					error: null,
				}));
				return true;
			} catch (exc) {
				// Gone - deleted, or removed by the retention policy. Forget it
				// and start clean rather than showing an error for a page the
				// person did not ask to open.
				if (exc instanceof ApiError && exc.status === 404) {
					remember(space, null);
					update(space, (current) => ({ ...current, loading: false }));
				} else {
					update(space, (current) => ({ ...current, loading: false, error: (exc as Error).message }));
				}
				return false;
			}
		},
		[update],
	);

	const restore = useCallback(
		(space: string) => {
			if (!space || restored.current.has(space)) return;
			restored.current.add(space);
			const existing = latest.current[space];
			if (existing && (existing.turns.length > 0 || existing.busy)) return;
			const id = remembered(space);
			if (id !== null) void load(space, id);
		},
		[load],
	);

	const send = useCallback(
		async (space: string, message: string) => {
			const trimmed = message.trim();
			const current = latest.current[space] ?? EMPTY;
			// Not while a stored conversation is still being read back: the
			// message would go to a new session and then be painted over.
			if (!trimmed || current.busy || current.loading) return;
			const asked: Turn = { role: "user", content: trimmed };
			update(space, (c) => ({
				...c,
				error: null,
				refusal: null,
				draft: "",
				busy: true,
				turns: [...c.turns, asked],
			}));
			try {
				const chosen = providerRef.current;
				const response = await api.post<ChatResponse>("/api/assistant/chat", {
					message: trimmed,
					sessionId: current.sessionId,
					// The conversation belongs to the space it was started in.
					spaceSlug: space,
					// Omitted while the catalogue is still loading, which leaves the
					// server on its configured chain rather than guessing here.
					...(chosen ? { provider: chosen } : {}),
				});
				remember(space, response.sessionId);
				update(space, (c) => ({
					...c,
					sessionId: response.sessionId,
					turns: [...c.turns, assistantTurn(response)],
					busy: false,
					answered: c.answered + 1,
				}));
				// The navigation's counts and the lists behind them are read again,
				// wherever the person is by now: a dataset the assistant synced is
				// on the Datasets page without a reload of the browser.
				if (response.artifacts.some((artifact) => CHANGES_THE_SPACE.has(artifact.kind))) reloadSpace();
			} catch (exc) {
				const status = exc instanceof ApiError ? exc.status : 0;
				if (status === 402 || status === 429) {
					// Refused before anything was stored - out of credit, or too
					// many questions in a minute. The question goes back in the
					// box rather than sitting in the transcript with no answer.
					update(space, (c) => ({
						...c,
						busy: false,
						refusal: (exc as Error).message,
						draft: c.draft || trimmed,
						turns: c.turns.filter((turn) => turn !== asked),
					}));
				} else {
					update(space, (c) => ({ ...c, busy: false, error: (exc as Error).message }));
				}
			}
		},
		[update, reloadSpace],
	);

	const newConversation = useCallback(
		(space: string) => {
			remember(space, null);
			update(space, (c) => ({ ...EMPTY, draft: c.draft }));
		},
		[update],
	);

	const open = useCallback(
		async (space: string, sessionId: number): Promise<boolean> => {
			restored.current.add(space);
			// Not under a question still being answered: its reply would land in
			// the conversation that had replaced it.
			if (latest.current[space]?.busy) return false;
			update(space, (c) => ({ ...c, loading: true, error: null }));
			try {
				const body = await api.get<StoredSession>(`/api/assistant/sessions/${sessionId}`);
				remember(space, sessionId);
				// Swapped in only once it is in hand, so a conversation that
				// cannot be opened leaves the one on screen where it was.
				update(space, (c) => ({
					...EMPTY,
					draft: c.draft,
					sessionId,
					title: body.title ?? null,
					turns: turnsFromMessages(body.messages),
				}));
				return true;
			} catch {
				update(space, (c) => ({ ...c, loading: false }));
				// With nothing on screen - a page opened straight on a link to a
				// conversation that is not there - show what a plain visit would
				// have: the conversation remembered for this space.
				const shown = latest.current[space];
				if (!shown || (shown.turns.length === 0 && !shown.busy)) {
					const id = remembered(space);
					if (id !== null && id !== sessionId) void load(space, id);
				}
				return false;
			}
		},
		[update, load],
	);

	const append = useCallback(
		(space: string, turn: Turn) => {
			update(space, (c) => ({ ...c, turns: [...c.turns, turn] }));
			// Kept with the conversation, so it is there when it is opened again.
			// A failure here costs only that: the line is still on screen now.
			const sessionId = latest.current[space]?.sessionId;
			if (sessionId && turn.content.trim()) {
				void api
					.post(`/api/assistant/sessions/${sessionId}/notes`, {
						content: turn.content,
						artifacts: (turn.artifacts ?? []).slice(0, 4),
					})
					.catch(() => {});
			}
		},
		[update],
	);

	const setTitle = useCallback(
		(space: string, title: string | null) => update(space, (c) => ({ ...c, title })),
		[update],
	);

	const setDraft = useCallback(
		(space: string, draft: string) => update(space, (c) => ({ ...c, draft })),
		[update],
	);

	const setAnswer = useCallback(
		(space: string, change: { chosen?: string[]; later?: boolean }) =>
			update(space, (c) => {
				const at = c.turns.length;
				const current = c.answer?.at === at ? c.answer : { at, chosen: [], later: false };
				return { ...c, answer: { ...current, ...change } };
			}),
		[update],
	);

	const value = useMemo<ChatContextValue>(
		() => ({
			conversation: (space) => conversations[space] ?? EMPTY,
			restore,
			send,
			newConversation,
			open,
			append,
			setTitle,
			setDraft,
			setAnswer,
			provider,
			setProvider,
		}),
		[conversations, restore, send, newConversation, open, append, setTitle, setDraft, setAnswer, provider],
	);

	return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
	const value = useContext(ChatContext);
	if (!value) throw new Error("useChat must be used inside ChatProvider.");
	return value;
}
