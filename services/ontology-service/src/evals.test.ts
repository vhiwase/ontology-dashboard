/**
 * The pure surfaces of evals.ts and schedules.ts: the assertion evaluators
 * and the interval parser. These are the parts where a wrong answer is
 * silent - a suite that passes when it should fail, a cadence that accepts
 * 30 seconds - so they are tested without a database, the same standard as
 * the SQL builders in objectSet.test.ts.
 */

import { describe, expect, it } from "vitest";
import { evaluateCase, type EvalAssertion } from "./evals";
import { parseIntervalSeconds } from "./schedules";

describe("eval assertion evaluators", () => {
	const scalar = (assertions: EvalAssertion[], value: unknown) =>
		evaluateCase(
			{ assertions },
			{ returns: "scalar", value, rows: [], rowCount: value === null ? 0 : 1 },
		);

	it("equals honours an explicit tolerance and refuses non-numeric values", () => {
		expect(scalar([{ kind: "equals", value: 90, tolerance: 0.5 }], 90.4)[0].ok).toBe(true);
		expect(scalar([{ kind: "equals", value: 90 }], 90.4)[0].ok).toBe(false);
		expect(scalar([{ kind: "equals", value: 90 }], null)[0].ok).toBe(false);
	});

	it("between treats a missing bound as open", () => {
		expect(scalar([{ kind: "between", min: 0 }], 5)[0].ok).toBe(true);
		expect(scalar([{ kind: "between", max: 100 }], 1e6)[0].ok).toBe(false);
	});

	it("gt/lt compare numerically, even across a numeric string", () => {
		expect(scalar([{ kind: "gt", value: 0 }], "12")[0].ok).toBe(true);
		expect(scalar([{ kind: "lt", value: 10 }], 10)[0].ok).toBe(false);
	});

	it("null checks say which way they check", () => {
		expect(scalar([{ kind: "not_null" }], null)[0].ok).toBe(false);
		expect(scalar([{ kind: "is_null" }], null)[0].ok).toBe(true);
	});

	it("an unknown assertion kind fails loudly rather than passing silently", () => {
		expect(scalar([{ kind: "looks_fine" }], 1)[0].ok).toBe(false);
	});

	const table = (assertions: EvalAssertion[], rows: Array<Record<string, unknown>>) =>
		evaluateCase({ assertions }, { returns: "table", value: null, rows, rowCount: rows.length });

	it("row bounds and column checks read the real rows", () => {
		const rows = [
			{ lane: "Chicago → Denver", orders: 5 },
			{ lane: "Dallas → Reno", orders: 2 },
		];
		expect(table([{ kind: "rows_between", min: 1, max: 10 }], rows)[0].ok).toBe(true);
		expect(table([{ kind: "rows_between", min: 5 }], rows)[0].ok).toBe(false);
		expect(table([{ kind: "column_not_null", column: "lane" }], rows)[0].ok).toBe(true);
		expect(
			table([{ kind: "column_not_null", column: "lane" }], [{ lane: null, orders: 1 }])[0].ok,
		).toBe(false);
		expect(table([{ kind: "column_min", column: "orders", value: 2 }], rows)[0].ok).toBe(true);
		expect(table([{ kind: "column_min", column: "orders", value: 3 }], rows)[0].ok).toBe(false);
		expect(table([{ kind: "column_max", column: "orders", value: 5 }], rows)[0].ok).toBe(true);
	});

	it("a column assertion with no numeric values fails instead of vacuously passing", () => {
		expect(table([{ kind: "column_min", column: "orders", value: 0 }], [{}])[0].ok).toBe(false);
	});
});

describe("schedule interval parsing", () => {
	it("accepts whole minutes and up", () => {
		expect(parseIntervalSeconds(60)).toBe(60);
		expect(parseIntervalSeconds("3600")).toBe(3600);
	});

	it("refuses the cadences that are misconfigurations", () => {
		expect(() => parseIntervalSeconds(30)).toThrow();
		expect(() => parseIntervalSeconds(59.5)).toThrow();
		expect(() => parseIntervalSeconds("hourly")).toThrow();
		expect(() => parseIntervalSeconds(undefined)).toThrow();
	});
});
