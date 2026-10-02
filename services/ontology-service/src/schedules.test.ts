/**
 * The interval parser is the whole validation surface of a cadence, and the
 * place where a wrong answer is silent: "2h" read as two seconds would hammer
 * the source, read as two days would leave a dataset stale with no error.
 */

import { describe, expect, it } from "vitest";
import { describeInterval, parseIntervalSeconds } from "./schedules";

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

describe("describeInterval", () => {
	it("says it the way it was asked for", () => {
		expect(describeInterval(1200)).toBe("every 20 minutes");
		expect(describeInterval(7200)).toBe("every 2 hours");
		expect(describeInterval(86_400)).toBe("every day");
		expect(describeInterval(691_200)).toBe("every 8 days");
		expect(describeInterval(90)).toBe("every 90 seconds");
	});
});
