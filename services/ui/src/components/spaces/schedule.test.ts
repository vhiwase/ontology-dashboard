import { describe, expect, it } from "vitest";
import { filterOptions } from "../SearchSelect";
import {
	combine,
	intervalProblem,
	intervalWords,
	monthGrid,
	sameDay,
	secondsOf,
	splitInterval,
	timeOf,
	upcomingRuns,
} from "./schedule";

describe("intervals", () => {
	it("reads an interval back in the largest unit that fits it", () => {
		expect(splitInterval(259_200)).toEqual({ count: 3, unit: "d" });
		expect(splitInterval(604_800)).toEqual({ count: 1, unit: "w" });
		expect(splitInterval(7200)).toEqual({ count: 2, unit: "h" });
		expect(splitInterval(1200)).toEqual({ count: 20, unit: "m" });
		// Nothing set yet: a day is the place to start from.
		expect(splitInterval(null)).toEqual({ count: 1, unit: "d" });
	});

	it("turns the server's shorthand into seconds, and nothing else into a number", () => {
		expect(secondsOf("3d")).toBe(259_200);
		expect(secondsOf("20m")).toBe(1200);
		expect(secondsOf("2w")).toBe(1_209_600);
		expect(secondsOf("manual")).toBeNull();
		expect(secondsOf("soon")).toBeNull();
	});

	it("says an interval the way a person would", () => {
		expect(intervalWords(1, "d")).toBe("every day");
		expect(intervalWords(3, "d")).toBe("every 3 days");
		expect(intervalWords(1, "h")).toBe("every hour");
	});

	it("refuses what the server would refuse, before it is sent", () => {
		expect(intervalProblem(3, "d")).toBeNull();
		expect(intervalProblem(0, "h")).toMatch(/whole number/);
		expect(intervalProblem(1.5, "h")).toMatch(/whole number/);
		expect(intervalProblem(Number.NaN, "h")).toMatch(/whole number/);
		expect(intervalProblem(60, "w")).toMatch(/a year/);
		expect(intervalProblem(366, "d")).toBeNull();
	});
});

describe("upcomingRuns", () => {
	const now = new Date(2026, 9, 3, 12, 30);

	it("starts at the chosen moment and keeps its rhythm", () => {
		const runs = upcomingRuns(new Date(2026, 9, 6, 2, 0), 3 * 86_400, 3, now);
		expect(runs.map((run) => [run.getDate(), run.getHours(), run.getMinutes()])).toEqual([
			[6, 2, 0],
			[9, 2, 0],
			[12, 2, 0],
		]);
	});

	// The server carries a past start forward the same way, so the preview
	// shows what will really be scheduled.
	it("carries a start already past forward to the next moment on the same rhythm", () => {
		const [first, second] = upcomingRuns(new Date(2026, 9, 3, 2, 0), 86_400, 2, now);
		expect([first?.getDate(), first?.getHours()]).toEqual([4, 2]);
		expect([second?.getDate(), second?.getHours()]).toEqual([5, 2]);
	});

	it("never offers the present moment as a run", () => {
		const [first] = upcomingRuns(now, 3600, 1, now);
		expect(first?.getTime()).toBe(now.getTime() + 3_600_000);
	});
});

describe("the calendar", () => {
	it("shows six whole weeks, starting on the chosen weekday", () => {
		// October 2026 starts on a Thursday.
		const monday = monthGrid(2026, 9, 1);
		expect(monday).toHaveLength(42);
		expect([monday[0]?.getMonth(), monday[0]?.getDate(), monday[0]?.getDay()]).toEqual([8, 28, 1]);
		expect(sameDay(monday[3]!, new Date(2026, 9, 1))).toBe(true);
		const sunday = monthGrid(2026, 9, 0);
		expect([sunday[0]?.getDate(), sunday[0]?.getDay()]).toEqual([27, 0]);
	});

	it("has every day of the month exactly once", () => {
		for (const [year, month, length] of [
			[2026, 9, 31],
			[2026, 1, 28],
			[2028, 1, 29],
		] as const) {
			const inMonth = monthGrid(year, month, 1).filter((day) => day.getMonth() === month);
			expect(inMonth.map((day) => day.getDate())).toEqual(Array.from({ length }, (_, index) => index + 1));
		}
	});

	it("joins a day and a time, and refuses a time that is not one", () => {
		const moment = combine(new Date(2026, 9, 6), "02:05");
		expect([moment?.getDate(), moment?.getHours(), moment?.getMinutes()]).toEqual([6, 2, 5]);
		expect(timeOf(moment!)).toBe("02:05");
		expect(combine(new Date(2026, 9, 6), "")).toBeNull();
		expect(combine(new Date(2026, 9, 6), "25:00")).toBeNull();
	});
});

describe("filterOptions", () => {
	const fields = [
		{ value: "general_email", label: "General Email", detail: "general_email · string" },
		{ value: "general_phone", label: "General Phone", detail: "general_phone · string" },
		{ value: "name", label: "Name", detail: "name · string" },
	];

	it("lists everything until something is typed", () => {
		expect(filterOptions(fields, "  ")).toHaveLength(3);
	});

	it("matches on the name, the value or the detail, whatever the case", () => {
		expect(filterOptions(fields, "PHONE").map((option) => option.value)).toEqual(["general_phone"]);
		expect(filterOptions(fields, "general_").map((option) => option.value)).toEqual(["general_email", "general_phone"]);
	});

	it("needs every word typed to match", () => {
		expect(filterOptions(fields, "general email").map((option) => option.value)).toEqual(["general_email"]);
		expect(filterOptions(fields, "general fax")).toEqual([]);
	});
});
