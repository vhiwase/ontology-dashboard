/**
 * The conversation history, beside the conversation.
 *
 * Every conversation with the assistant is kept in the database - each
 * question, each answer, the tool calls behind it and what it cost - and has
 * been all along. What there was to reach it with was a History button and a
 * window that opened over the page: a list seen only by someone who went
 * looking for it. So the history looked as if it was not kept at all, and a
 * conversation left for another page looked lost.
 *
 * It is a panel now, always there on the left: the conversations of this space,
 * newest first under headings by when each was last used, with the one on
 * screen marked. Each can be opened, renamed, pinned to the top and deleted,
 * and the whole history can be searched - through what was asked and what was
 * answered, not only the titles.
 *
 * Deleting erases what was said and takes the conversation out of the list.
 * What it cost stays on record: a person's monthly credit and the spend report
 * are sums of those costs, and tidying a conversation away must not hand the
 * credit back.
 *
 * An administrator may see everyone's conversations in a space (the server
 * allows it, as it did for the old window), behind a switch that starts on
 * their own: someone else's thread should never be mistaken for one's own.
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, session } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { type SessionSummary, groupSessions, lastUsed, sessionTitle, splitOnMatch } from "./chatHistory";
import { Spinner } from "./common";
import { Icon } from "./icons";

const PAGE = 40;

interface SessionPage {
	sessions: SessionSummary[];
	total: number;
	hasMore: boolean;
	/** Days idle after which one that is not pinned is removed; 0 when none is. */
	retentionDays?: number;
}

export function ChatHistoryPanel({
	space,
	currentId,
	refreshKey,
	busy,
	onOpen,
	onNew,
	onDeleted,
	onRenamed,
	onClose,
}: {
	space: string;
	/** The conversation on screen, marked in the list. */
	currentId: number | null;
	/** Changes when the list should be read again: an answer arrived, a conversation began. */
	refreshKey: string | number;
	/** A question is being answered: another conversation cannot be opened under it. */
	busy: boolean;
	onOpen: (sessionId: number) => void;
	onNew: () => void;
	onDeleted: (sessionId: number) => void;
	onRenamed?: (sessionId: number, title: string) => void;
	/** Put the panel away. */
	onClose: () => void;
}) {
	const me = session.user();
	const isAdmin = me?.role === "admin";
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [total, setTotal] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	// The clean-up this deployment runs, if any: the footer says what it does
	// rather than promising to keep what it will remove.
	const [retentionDays, setRetentionDays] = useState(0);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	// What the list on screen was searched for: the box, a moment later.
	const [searched, setSearched] = useState("");
	const [everyone, setEveryone] = useState(false);
	const [renaming, setRenamingState] = useState<number | null>(null);
	// The same, readable at once by a handler that fires in the same tick as
	// the one that changed it (Escape, then the blur it causes).
	const renamingRef = useRef<number | null>(null);
	const setRenaming = (id: number | null) => {
		renamingRef.current = id;
		setRenamingState(id);
	};
	const [draftTitle, setDraftTitle] = useState("");
	const [removing, setRemoving] = useState<SessionSummary | null>(null);
	const [working, setWorking] = useState<number | null>(null);
	// The latest request made, so a slow answer to an earlier search cannot
	// replace the result of a later one.
	const latest = useRef(0);

	// Typing searches after a short pause rather than on every key.
	useEffect(() => {
		const timer = window.setTimeout(() => setSearched(query.trim()), 250);
		return () => window.clearTimeout(timer);
	}, [query]);

	const read = useCallback(
		async (offset: number): Promise<SessionPage> => {
			const params = new URLSearchParams({ space, limit: String(PAGE), offset: String(offset) });
			if (searched) params.set("q", searched);
			if (!(isAdmin && everyone)) params.set("scope", "mine");
			return api.get<SessionPage>(`/api/assistant/sessions?${params.toString()}`);
		},
		[space, searched, isAdmin, everyone],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger
	useEffect(() => {
		const request = ++latest.current;
		setError(null);
		read(0)
			.then((page) => {
				if (request !== latest.current) return;
				setSessions(page.sessions.map(normalise));
				setTotal(page.total ?? page.sessions.length);
				setHasMore(Boolean(page.hasMore));
				setRetentionDays(Math.max(0, Number(page.retentionDays) || 0));
			})
			.catch((exc: Error) => {
				if (request !== latest.current) return;
				setError(exc.message);
				setSessions((current) => current ?? []);
			});
	}, [read, refreshKey]);

	async function loadMore() {
		if (!sessions || loadingMore) return;
		setLoadingMore(true);
		const request = latest.current;
		try {
			const page = await read(sessions.length);
			if (request !== latest.current) return;
			const have = new Set(sessions.map((entry) => entry.chat_session_id));
			setSessions([...sessions, ...page.sessions.map(normalise).filter((entry) => !have.has(entry.chat_session_id))]);
			setHasMore(Boolean(page.hasMore));
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setLoadingMore(false);
		}
	}

	/**
	 * Save the name being typed. Reached by Enter and by clicking away, which
	 * can both happen for one edit, and not at all after Escape - so it acts
	 * only while this row is still the one being renamed.
	 */
	async function rename(entry: SessionSummary) {
		if (renamingRef.current !== entry.chat_session_id) return;
		renamingRef.current = null;
		const title = draftTitle.trim();
		if (!title || title === sessionTitle(entry)) {
			setRenaming(null);
			return;
		}
		setWorking(entry.chat_session_id);
		setError(null);
		try {
			const saved = await api.patch<{ title: string }>(`/api/assistant/sessions/${entry.chat_session_id}`, { title });
			setSessions((current) =>
				(current ?? []).map((item) =>
					item.chat_session_id === entry.chat_session_id ? { ...item, title: saved.title } : item,
				),
			);
			onRenamed?.(entry.chat_session_id, saved.title);
			setRenaming(null);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setWorking(null);
		}
	}

	async function togglePin(entry: SessionSummary) {
		setWorking(entry.chat_session_id);
		setError(null);
		try {
			await api.patch(`/api/assistant/sessions/${entry.chat_session_id}`, { pinned: !entry.pinned });
			// Read again rather than moved by hand: a pin changes where it sorts.
			const page = await read(0);
			setSessions(page.sessions.map(normalise));
			setTotal(page.total ?? page.sessions.length);
			setHasMore(Boolean(page.hasMore));
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setWorking(null);
		}
	}

	async function remove(entry: SessionSummary) {
		setWorking(entry.chat_session_id);
		setError(null);
		try {
			await api.del(`/api/assistant/sessions/${entry.chat_session_id}`);
			setSessions((current) => (current ?? []).filter((item) => item.chat_session_id !== entry.chat_session_id));
			setTotal((current) => Math.max(0, current - 1));
			onDeleted(entry.chat_session_id);
			setRemoving(null);
		} catch (exc) {
			setError((exc as Error).message);
			setRemoving(null);
		} finally {
			setWorking(null);
		}
	}

	const groups = groupSessions(sessions ?? []);

	return (
		<aside className="chat-history" aria-label="Conversation history">
			<div className="chat-history-head">
				<span className="chat-history-title">
					<Icon name="history" size={15} />
					History
				</span>
				<button type="button" className="icon-btn" onClick={onClose} title="Hide the history" aria-label="Hide the history">
					<Icon name="panelLeft" size={16} />
				</button>
			</div>

			{/* "New chat", not "New conversation": the bar above the transcript
			    already has that button, and there must be exactly one of it. */}
			<button type="button" className="btn chat-history-new" onClick={onNew} disabled={busy}>
				<Icon name="plus" size={14} />
				New chat
			</button>

			{/* search-field: the magnifier every search box here carries. */}
			<input
				className="search-field chat-history-search"
				type="search"
				value={query}
				placeholder="Search questions and answers"
				aria-label="Search conversations"
				onChange={(event) => setQuery(event.target.value)}
			/>

			{isAdmin && (
				<div className="segmented chat-history-scope" role="radiogroup" aria-label="Whose conversations">
					<button type="button" role="radio" aria-checked={!everyone} className={!everyone ? "active" : ""} onClick={() => setEveryone(false)}>
						Mine
					</button>
					<button type="button" role="radio" aria-checked={everyone} className={everyone ? "active" : ""} onClick={() => setEveryone(true)}>
						Everyone's
					</button>
				</div>
			)}

			{error && (
				<p className="chat-history-error" role="alert">
					{error}
				</p>
			)}

			<div className="chat-history-list">
				{sessions === null ? (
					<div className="chat-history-loading">
						<Spinner label="Loading your conversations" />
					</div>
				) : sessions.length === 0 ? (
					<p className="chat-history-empty muted">
						{searched
							? `No conversation mentions “${searched}”.`
							: "No conversations here yet. The first question you ask starts one, and it is kept here."}
					</p>
				) : (
					groups.map((group) => (
						<section key={group.label} className="chat-history-group">
							<h3>{group.label}</h3>
							<ul>
								{group.sessions.map((entry) => {
									const current = entry.chat_session_id === currentId;
									const title = sessionTitle(entry);
									const mine = !me || entry.user_id === me.username;
									if (renaming === entry.chat_session_id) {
										return (
											<li key={entry.chat_session_id} className="chat-history-item renaming">
												<form
													onSubmit={(event: FormEvent) => {
														event.preventDefault();
														void rename(entry);
													}}
												>
													<input
														autoFocus
														value={draftTitle}
														maxLength={120}
														aria-label="Conversation name"
														onChange={(event) => setDraftTitle(event.target.value)}
														onKeyDown={(event) => {
															if (event.key === "Escape") setRenaming(null);
														}}
														onBlur={() => void rename(entry)}
													/>
												</form>
											</li>
										);
									}
									return (
										<li
											key={entry.chat_session_id}
											className={`chat-history-item ${current ? "current" : ""} ${entry.pinned ? "pinned" : ""}`}
										>
											<button
												type="button"
												className="chat-history-open"
												onClick={() => onOpen(entry.chat_session_id)}
												aria-current={current ? "true" : undefined}
												disabled={busy && !current}
												title={busy && !current ? "An answer is on its way. Open another conversation once it arrives." : title}
											>
												<span className="chat-history-name">
													{entry.pinned && <Icon name="pin" size={11} className="chat-history-pinmark" />}
													<Marked text={title} phrase={searched} />
												</span>
												{entry.snippet && (
													<span className="chat-history-snippet">
														<Marked text={entry.snippet} phrase={searched} />
													</span>
												)}
												<span className="chat-history-meta">
													{entry.message_count} message{entry.message_count === 1 ? "" : "s"} · {lastUsed(entry.updated_at)}
													{!mine ? ` · ${entry.user_id}` : ""}
												</span>
											</button>
											<span className="chat-history-actions">
												<button
													type="button"
													className="icon-btn"
													disabled={working === entry.chat_session_id}
													onClick={() => void togglePin(entry)}
													title={
														entry.pinned
															? "Unpin"
															: retentionDays > 0
																? `Pin to the top, and keep it past the ${retentionDays}-day clean-up`
																: "Pin to the top"
													}
													aria-label={`${entry.pinned ? "Unpin" : "Pin"}: ${title}`}
												>
													<Icon name={entry.pinned ? "pinOff" : "pin"} size={13} />
												</button>
												<button
													type="button"
													className="icon-btn"
													disabled={working === entry.chat_session_id}
													onClick={() => {
														setDraftTitle(title);
														setRenaming(entry.chat_session_id);
													}}
													title="Rename"
													aria-label={`Rename: ${title}`}
												>
													<Icon name="pencil" size={13} />
												</button>
												<button
													type="button"
													className="icon-btn row-delete"
													disabled={working === entry.chat_session_id}
													onClick={() => setRemoving(entry)}
													title="Delete"
													aria-label={`Delete: ${title}`}
												>
													<Icon name="trash" size={13} />
												</button>
											</span>
										</li>
									);
								})}
							</ul>
						</section>
					))
				)}
				{hasMore && (
					<button type="button" className="btn sm ghost chat-history-more" onClick={() => void loadMore()} disabled={loadingMore}>
						{loadingMore ? "Loading…" : "Show older conversations"}
					</button>
				)}
			</div>

			{sessions !== null && sessions.length > 0 && (
				<p className="chat-history-foot muted">
					{searched
						? `${total} of your conversations ${total === 1 ? "matches" : "match"}`
						: retentionDays > 0
							? `${total} conversation${total === 1 ? "" : "s"}. One left unused for ${retentionDays} day${retentionDays === 1 ? "" : "s"} is removed, unless it is pinned.`
							: `${total} conversation${total === 1 ? "" : "s"}, kept until you delete ${total === 1 ? "it" : "them"}`}
				</p>
			)}

			{removing && (
				<ConfirmDialog
					title={`Delete “${sessionTitle(removing)}”?`}
					icon="trash"
					cancelLabel="Keep it"
					busy={working === removing.chat_session_id}
					onCancel={() => setRemoving(null)}
					choices={[
						{
							label: working === removing.chat_session_id ? "Deleting…" : "Delete this conversation",
							tone: "danger",
							onSelect: () => void remove(removing),
						},
					]}
				>
					<p>
						Its {removing.message_count} message{removing.message_count === 1 ? "" : "s"} are erased - the questions, the
						answers and what was attached to them - and it leaves this list. It cannot be opened or brought back.
					</p>
					<p>
						Anything it built stays: dashboards, metrics and proposals are kept. What it cost also stays in the usage
						record, so deleting it does not change your AI credit.
					</p>
				</ConfirmDialog>
			)}
		</aside>
	);
}

/** Ids arrive as text from the database driver; made numbers once, here. */
function normalise(entry: SessionSummary): SessionSummary {
	return { ...entry, chat_session_id: Number(entry.chat_session_id), message_count: Number(entry.message_count) };
}

/** Text with the searched phrase marked where it occurs. */
function Marked({ text, phrase }: { text: string; phrase: string }) {
	if (!phrase) return <>{text}</>;
	return (
		<>
			{splitOnMatch(text, phrase).map((part, index) =>
				part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
			)}
		</>
	);
}
