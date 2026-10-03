import { describe, expect, it } from "vitest";
import { type SessionSummary, groupLabel, groupSessions, lastUsed, sessionTitle, splitOnMatch } from "./chatHistory";

const NOW = new Date(2026, 9, 3, 15, 30); // 3 October 2026, mid-afternoon

function session(id: number, updated: Date, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		chat_session_id: id,
		title: `Question ${id}`,
		user_id: "maria",
		message_count: 2,
		updated_at: updated.toISOString(),
		...extra,
	};
}

describe("groupLabel", () => {
	it("goes by calendar days, not by 24-hour stretches", () => {
		// Twenty minutes past midnight today is today; ten to midnight is yesterday,
		// although it is only half an hour earlier.
		expect(groupLabel(new Date(2026, 9, 3, 0, 20).toISOString(), NOW)).toBe("Today");
		expect(groupLabel(new Date(2026, 9, 2, 23, 50).toISOString(), NOW)).toBe("Yesterday");
	});

	it("steps out through the week, the month, then months and years", () => {
		expect(groupLabel(new Date(2026, 8, 28, 9).toISOString(), NOW)).toBe("Previous 7 days");
		expect(groupLabel(new Date(2026, 8, 10, 9).toISOString(), NOW)).toBe("Previous 30 days");
		expect(groupLabel(new Date(2026, 6, 4, 9).toISOString(), NOW)).toBe(
			new Date(2026, 6, 4).toLocaleDateString(undefined, { month: "long" }),
		);
		expect(groupLabel(new Date(2025, 11, 31, 9).toISOString(), NOW)).toBe("2025");
	});

	it("puts a time it cannot read last rather than failing", () => {
		expect(groupLabel("not a date", NOW)).toBe("Earlier");
	});
});

describe("groupSessions", () => {
	it("keeps the order it was given under each heading", () => {
		const groups = groupSessions(
			[
				session(5, new Date(2026, 9, 3, 14)),
				session(4, new Date(2026, 9, 3, 9)),
				session(3, new Date(2026, 9, 2, 18)),
				session(2, new Date(2026, 8, 29, 18)),
			],
			NOW,
		);
		expect(groups.map((group) => [group.label, group.sessions.map((entry) => entry.chat_session_id)])).toEqual([
			["Today", [5, 4]],
			["Yesterday", [3]],
			["Previous 7 days", [2]],
		]);
	});

	it("leads with what is pinned, however old", () => {
		const groups = groupSessions(
			[session(9, new Date(2026, 9, 3, 14)), session(1, new Date(2025, 2, 1), { pinned: true })],
			NOW,
		);
		expect(groups.map((group) => group.label)).toEqual(["Pinned", "Today"]);
		expect(groups[0]!.sessions[0]!.chat_session_id).toBe(1);
	});

	it("is empty for an empty history", () => {
		expect(groupSessions([], NOW)).toEqual([]);
	});
});

describe("what a row says", () => {
	it("names a conversation by its title, or by its number when it has none", () => {
		expect(sessionTitle({ title: "  Revenue by country  ", chat_session_id: 4 })).toBe("Revenue by country");
		expect(sessionTitle({ title: null, chat_session_id: 4 })).toBe("Conversation 4");
		expect(sessionTitle({ title: "   ", chat_session_id: 4 })).toBe("Conversation 4");
	});

	it("says how long ago it was used", () => {
		expect(lastUsed(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe("just now");
		expect(lastUsed(new Date(NOW.getTime() - 12 * 60_000).toISOString(), NOW)).toBe("12 min ago");
		expect(lastUsed(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW)).toBe("3 h ago");
		expect(lastUsed("nonsense", NOW)).toBe("");
	});
});

describe("splitOnMatch", () => {
	it("marks every place the phrase occurs, whatever its case", () => {
		expect(splitOnMatch("Orders by country, and ORDERS by month", "orders")).toEqual([
			{ text: "Orders", match: true },
			{ text: " by country, and ", match: false },
			{ text: "ORDERS", match: true },
			{ text: " by month", match: false },
		]);
	});

	it("returns the text whole when there is nothing to mark", () => {
		expect(splitOnMatch("Orders by country", "")).toEqual([{ text: "Orders by country", match: false }]);
		expect(splitOnMatch("Orders by country", "freight")).toEqual([{ text: "Orders by country", match: false }]);
	});
});
