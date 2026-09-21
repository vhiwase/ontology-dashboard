/**
 * Tests for the KPI SQL builder.
 *
 * Same property as objectSet.test.ts: column names are checked against the
 * view's real columns before being quoted, filter values are always bound, and
 * the limit is clamped because it is interpolated.
 *
 * The filter path is the one worth guarding hardest. It takes a caller-supplied
 * object whose KEYS become column names, which is the shape most likely to
 * turn into an injection if the allowlist check is ever dropped.
 */

import { describe, expect, it } from "vitest";
import { __testing } from "./kpi";
import type { KpiMeta } from "./registry";

const { clampLimit, valueExpression, buildFilters } = __testing;

// ── fixtures ────────────────────────────────────────────────────────────────

// Mirrors the ColumnMeta in kpi.ts. It is not exported, so this shape has to
// match it; the typecheck catches it if the real one gains a field.
type ColumnMeta = { name: string; sqlType: string };

function columns(...names: string[]): Map<string, ColumnMeta> {
	return new Map(names.map((name) => [name, { name, sqlType: "text" }]));
}

function kpi(overrides: Partial<KpiMeta> = {}): KpiMeta {
	return {
		apiName: "OnTimeDeliveryRate",
		sourceView: "tms_views.v_kpi_service",
		aggregation: "sum",
		measureColumn: "delivered_count",
		numeratorColumn: null,
		denominatorColumn: null,
		valueFormat: "number",
		...overrides,
	} as unknown as KpiMeta;
}

const COLUMNS = columns("delivered_count", "promised_count", "carrier_name", "ship_date");

// ── filters ─────────────────────────────────────────────────────────────────

describe("filter columns are allowlisted against the view", () => {
	it("rejects a column the view does not expose", () => {
		expect(() =>
			buildFilters(kpi(), COLUMNS, { "carrier_name; DROP TABLE x": "ACME" }),
		).toThrow(/Cannot filter/);
	});

	it("names the columns that are available when one is rejected", () => {
		expect(() => buildFilters(kpi(), COLUMNS, { nope: 1 })).toThrow(/carrier_name/);
	});

	it("rejects a quoted-identifier break-out attempt", () => {
		expect(() =>
			buildFilters(kpi(), COLUMNS, { 'carrier_name" = x OR "1': "1" }),
		).toThrow(/Cannot filter/);
	});
});

describe("filter values are always bound", () => {
	it("binds a scalar and casts both sides to text", () => {
		const { sql, values } = buildFilters(kpi(), COLUMNS, {
			carrier_name: "'; DROP TABLE platform.app_user; --",
		});
		expect(sql).toBe('WHERE "carrier_name"::text = $1::text');
		expect(values).toEqual(["'; DROP TABLE platform.app_user; --"]);
		expect(sql).not.toContain("DROP");
	});

	it("binds every element of an array filter", () => {
		const { sql, values } = buildFilters(kpi(), COLUMNS, {
			carrier_name: ["ACME", "' OR 1=1 --"],
		});
		expect(sql).toBe('WHERE "carrier_name"::text IN ($1, $2)');
		expect(values).toEqual(["ACME", "' OR 1=1 --"]);
	});

	it("ANDs multiple filters and numbers the placeholders in order", () => {
		const { sql, values } = buildFilters(kpi(), COLUMNS, {
			carrier_name: "ACME",
			ship_date: "2026-01-01",
		});
		expect(sql).toBe(
			'WHERE "carrier_name"::text = $1::text AND "ship_date"::text = $2::text',
		);
		expect(values).toEqual(["ACME", "2026-01-01"]);
	});
});

describe("filters that mean 'no filter'", () => {
	it.each([
		["undefined", undefined],
		["null", null],
		["empty string", ""],
		["the __all__ sentinel", "__all__"],
		["an empty array", []],
	])("skips %s", (_label, value) => {
		const { sql, values, applied } = buildFilters(kpi(), COLUMNS, { carrier_name: value });
		expect(sql).toBe("");
		expect(values).toHaveLength(0);
		expect(applied).toEqual({});
	});

	it("reports back only the filters it actually applied", () => {
		const { applied } = buildFilters(kpi(), COLUMNS, {
			carrier_name: "ACME",
			ship_date: "__all__",
		});
		expect(applied).toEqual({ carrier_name: "ACME" });
	});
});

// ── aggregation ─────────────────────────────────────────────────────────────

describe("valueExpression", () => {
	it("builds each supported aggregation over a quoted column", () => {
		for (const aggregation of ["sum", "avg", "min", "max"] as const) {
			expect(valueExpression(kpi({ aggregation }), COLUMNS)).toBe(
				`${aggregation}("delivered_count")`,
			);
		}
	});

	it("counts rows without needing a measure column", () => {
		expect(valueExpression(kpi({ aggregation: "count", measureColumn: null }), COLUMNS)).toBe(
			"count(*)",
		);
	});

	it("guards a ratio against divide-by-zero", () => {
		const expression = valueExpression(
			kpi({
				aggregation: "ratio",
				numeratorColumn: "delivered_count",
				denominatorColumn: "promised_count",
			}),
			COLUMNS,
		);
		expect(expression).toContain("NULLIF");
		expect(expression).toBe('sum("delivered_count") / NULLIF(sum("promised_count"), 0)');
	});

	it("scales a percent ratio by 100", () => {
		expect(
			valueExpression(
				kpi({
					aggregation: "ratio",
					numeratorColumn: "delivered_count",
					denominatorColumn: "promised_count",
					valueFormat: "percent",
				}),
				COLUMNS,
			),
		).toMatch(/^100\.0 \* /);
	});

	it("refuses a measure column the view does not have", () => {
		expect(() => valueExpression(kpi({ measureColumn: "invented" }), COLUMNS)).toThrow(
			/does not have/,
		);
	});

	it("refuses a KPI whose measure column is missing entirely", () => {
		expect(() => valueExpression(kpi({ measureColumn: null }), COLUMNS)).toThrow(
			/no measure column/,
		);
	});

	it("refuses an unsupported aggregation rather than emitting it", () => {
		expect(() =>
			valueExpression(kpi({ aggregation: "median" as never }), COLUMNS),
		).toThrow(/unsupported aggregation/);
	});
});

// ── limits ──────────────────────────────────────────────────────────────────

describe("clampLimit", () => {
	it("honours the per-call ceiling", () => {
		expect(clampLimit(10_000, 25, 500)).toBe(500);
		expect(clampLimit(10_000, 100, 1000)).toBe(1000);
	});

	it("always returns a finite integer in range", () => {
		for (const supplied of ["abc", "5; DROP TABLE x", {}, [], Number.NaN, Infinity]) {
			const result = clampLimit(supplied, 25, 500);
			expect(Number.isInteger(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(1);
			expect(result).toBeLessThanOrEqual(500);
		}
	});
});
