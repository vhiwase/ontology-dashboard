/**
 * The interval parser is the whole validation surface of a cadence, and the
 * place where a wrong answer is silent: "2h" read as two seconds would hammer
 * the source, read as two days would leave a dataset stale with no error.
 */

import { describe, expect, it } from "vitest";
import { describeInterval, nextOnGrid, parseIntervalSeconds, parseStartAt } from "./schedules";

describe("parseIntervalSeconds", () => {
	it("reads the cadences people ask for", () => {
		expect(parseIntervalSeconds("20m")).toBe(1200);
		expect(parseIntervalSeconds("2h")).toBe(7200);
		expect(parseIntervalSeconds("1d")).toBe(86_400);
		expect(parseIntervalSeconds("8d")).toBe(691_200);
		expect(parseIntervalSeconds("1w")).toBe(604_800);
	});

	it("reads them written out, too", () => {
		expect(parseIntervalSeconds("20 minutes")).toBe(1200);
		expect(parseIntervalSeconds("every 2 hours")).toBe(7200);
		expect(parseIntervalSeconds("8 days")).toBe(691_200);
		expect(parseIntervalSeconds("90 secs")).toBe(90);
	});

	it("takes plain seconds, as a number or as text", () => {
		expect(parseIntervalSeconds(3600)).toBe(3600);
		expect(parseIntervalSeconds("3600")).toBe(3600);
	});

	it("refuses anything under a minute", () => {
		expect(() => parseIntervalSeconds("30s")).toThrow(/at least 60 seconds/);
		expect(() => parseIntervalSeconds(0)).toThrow(/at least 60 seconds/);
	});

	it("refuses what it cannot read rather than guessing a unit", () => {
		expect(() => parseIntervalSeconds("2 fortnights")).toThrow(/not an interval/);
		expect(() => parseIntervalSeconds("soon")).toThrow(/not an interval/);
		expect(() => parseIntervalSeconds("")).toThrow(/not an interval/);
	});

	it("refuses a cadence nobody is waiting on", () => {
		expect(() => parseIntervalSeconds("400d")).toThrow(/at most a year/);
	});
});

describe("parseStartAt", () => {
	const now = new Date("2026-10-03T07:00:00Z");

	it("is nothing when no first run was chosen", () => {
		expect(parseStartAt(undefined, now)).toBeNull();
		expect(parseStartAt(null, now)).toBeNull();
		expect(parseStartAt("", now)).toBeNull();
	});

	it("reads a date and time in the zone it was written in", () => {
		expect(parseStartAt("2026-10-06T02:00:00+05:30", now)?.toISOString()).toBe("2026-10-05T20:30:00.000Z");
		expect(parseStartAt("2026-10-05T20:30:00Z", now)?.toISOString()).toBe("2026-10-05T20:30:00.000Z");
		expect(parseStartAt("2026-10-05T20:30:00.000Z", now)?.toISOString()).toBe("2026-10-05T20:30:00.000Z");
	});

	// Without a zone the same text is a different moment on every server.
	it("refuses a time with no zone, a bare date, and anything that is not a date", () => {
		expect(() => parseStartAt("2026-10-06T02:00:00", now)).toThrow(/time zone/);
		expect(() => parseStartAt("2026-10-06", now)).toThrow(/time zone/);
		expect(() => parseStartAt("tomorrow at two", now)).toThrow(/time zone/);
		expect(() => parseStartAt(1_790_000_000, now)).toThrow(/ISO 8601/);
		expect(() => parseStartAt("2026-13-45T02:00:00Z", now)).toThrow(/not a real date/);
	});

	it("accepts a time already past, since the rhythm carries on from it", () => {
		expect(parseStartAt("2026-10-01T02:00:00Z", now)?.toISOString()).toBe("2026-10-01T02:00:00.000Z");
	});

	it("refuses a first run more than a year away in either direction", () => {
		expect(() => parseStartAt("2028-01-01T00:00:00Z", now)).toThrow(/within a year/);
		expect(() => parseStartAt("2024-01-01T00:00:00Z", now)).toThrow(/a year in the past/);
	});
});

describe("nextOnGrid", () => {
	const now = new Date("2026-10-03T07:14:08Z");
	const iso = (start: string, seconds: number) => nextOnGrid(new Date(start), seconds, now).toISOString();

	it("is the first run itself while that is still ahead", () => {
		expect(iso("2026-10-06T02:00:00Z", 86_400)).toBe("2026-10-06T02:00:00.000Z");
	});

	it("is the next moment on the same rhythm once the first run has passed", () => {
		// Daily at 02:00, set five days ago: tomorrow at 02:00, not 24h from now.
		expect(iso("2026-09-28T02:00:00Z", 86_400)).toBe("2026-10-04T02:00:00.000Z");
		// Hourly, due ten minutes ago: fifty minutes from now.
		expect(iso("2026-10-03T07:04:08Z", 3600)).toBe("2026-10-03T08:04:08.000Z");
	});

	// Otherwise a run claimed exactly on time would be due again at once.
	it("never returns the present moment", () => {
		expect(iso("2026-10-03T07:14:08Z", 600)).toBe("2026-10-03T07:24:08.000Z");
		expect(iso("2026-10-03T06:14:08Z", 3600)).toBe("2026-10-03T08:14:08.000Z");
	});
});

describe("describeInterval", () => {
	it("says it the way it was asked for", () => {
		expect(describeInterval(1200)).toBe("every 20 minutes");
		expect(describeInterval(7200)).toBe("every 2 hours");
		expect(describeInterval(86_400)).toBe("every day");
		expect(describeInterval(691_200)).toBe("every 8 days");
		expect(describeInterval(90)).toBe("every 90 seconds");
	});
});
