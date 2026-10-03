/**
 * The conversation history, as the list beside the assistant reads it.
 *
 * Kept apart from the panel that draws it so the grouping - which is the part
 * with rules - can be tested without a browser: pinned first, then by how long
 * ago each conversation was last used, in the steps a person thinks in.
 */

/** One conversation as /api/assistant/sessions lists it. */
export interface SessionSummary {
	chat_session_id: number;
	title: string | null;
	user_id: string;
	message_count: number;
	created_at?: string;
	updated_at: string;
	pinned?: boolean;
	/** Where a search matched, when it matched something said rather than the title. */
	snippet?: string | null;
}

export interface SessionGroup {
	label: string;
	sessions: SessionSummary[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The heading a conversation last used at `updatedAt` sits under. */
export function groupLabel(updatedAt: string, now: Date): string {
	const when = new Date(updatedAt);
	if (Number.isNaN(when.getTime())) return "Earlier";
	const days = Math.round((startOfDay(now) - startOfDay(when)) / DAY);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 7) return "Previous 7 days";
	if (days < 30) return "Previous 30 days";
	// Past a month, by month in this year and by year before it.
	if (when.getFullYear() === now.getFullYear()) {
		return when.toLocaleDateString(undefined, { month: "long" });
	}
	return String(when.getFullYear());
}

/**
 * Sessions under their headings, in the order given.
 *
 * The server sends pinned ones first and the rest newest first, so walking the
 * list once keeps both orders; a heading appears where its first conversation
 * does.
 */
export function groupSessions(sessions: SessionSummary[], now: Date = new Date()): SessionGroup[] {
	const groups: SessionGroup[] = [];
	const byLabel = new Map<string, SessionGroup>();
	for (const entry of sessions) {
		const label = entry.pinned ? "Pinned" : groupLabel(entry.updated_at, now);
		let group = byLabel.get(label);
		if (!group) {
			group = { label, sessions: [] };
			byLabel.set(label, group);
			groups.push(group);
		}
		group.sessions.push(entry);
	}
	// Pinned leads, whatever came first on the wire.
	groups.sort((a, b) => Number(b.label === "Pinned") - Number(a.label === "Pinned"));
	return groups;
}

/** What a conversation is called in the list: its name, or its number when it has none. */
export function sessionTitle(entry: Pick<SessionSummary, "title" | "chat_session_id">): string {
	const title = (entry.title ?? "").trim();
	return title || `Conversation ${entry.chat_session_id}`;
}

/** "just now", "12 min ago", "3 h ago", then the date. */
export function lastUsed(iso: string, now: Date = new Date()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const minutes = Math.round((now.getTime() - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The pieces of `text` around each place `phrase` occurs, to mark the match. */
export function splitOnMatch(text: string, phrase: string): Array<{ text: string; match: boolean }> {
	const needle = phrase.trim().toLowerCase();
	if (!needle) return [{ text, match: false }];
	const parts: Array<{ text: string; match: boolean }> = [];
	const lower = text.toLowerCase();
	let from = 0;
	for (;;) {
		const at = lower.indexOf(needle, from);
		if (at < 0) break;
		if (at > from) parts.push({ text: text.slice(from, at), match: false });
		parts.push({ text: text.slice(at, at + needle.length), match: true });
		from = at + needle.length;
	}
	if (from < text.length) parts.push({ text: text.slice(from), match: false });
	return parts.length > 0 ? parts : [{ text, match: false }];
}
