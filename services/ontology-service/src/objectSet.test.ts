/**
 * Tests for the object-set SQL builder.
 *
 * This file and kpi.test.ts cover the code that turns a caller's filter into
 * SQL text. The safety property being pinned down is the same in every case:
 *
 *   * identifiers come from the registry and are quoted by quoteIdentifier,
 *     which validates and refuses rather than escaping;
 *   * every caller-supplied VALUE leaves as a bound parameter, never as SQL
 *     text;
 *   * limits are clamped and coerced, because they are interpolated.
 *
 * These were the riskiest lines in the service and had no tests at all.
 */

import { describe, expect, it } from "vitest";
import { __testing } from "./objectSet";
import type { ObjectTypeMeta, PropertyMeta } from "./registry";

const { buildPredicate, castTo, makeBindings, clampLimit } = __testing;

// ── fixtures ────────────────────────────────────────────────────────────────

function property(overrides: Partial<PropertyMeta> = {}): PropertyMeta {
	return {
		rid: "tms:Order.status",
		apiName: "status",
		label: "Status",
		description: null,
		datatype: "string",
		sqlColumn: "status",
		sqlType: "text",
		isIdentity: false,
		isTitle: false,
		isNullable: true,
		isForeignKey: false,
		semanticRole: "attribute",
		defaultAggregation: null,
		unit: null,
		displayOrder: 1,
		...overrides,
	};
}

function objectType(properties: PropertyMeta[]): ObjectTypeMeta {
	return {
		apiName: "Order",
		properties,
		propertyByApiName: new Map(properties.map((p) => [p.apiName, p])),
		propertyBySqlColumn: new Map(properties.map((p) => [p.sqlColumn, p])),
	} as unknown as ObjectTypeMeta;
}

const STATUS = property();
const AMOUNT = property({
	apiName: "amount",
	sqlColumn: "amount",
	datatype: "number",
	sqlType: "numeric",
});
const ACCOUNT_KEY = property({
	apiName: "accountKey",
	sqlColumn: "account_key",
	datatype: "string",
	sqlType: "uuid",
});
const TYPE = objectType([STATUS, AMOUNT, ACCOUNT_KEY]);

function build(clause: Parameters<typeof buildPredicate>[1]) {
	const bindings = makeBindings();
	const sql = buildPredicate(TYPE, clause, bindings);
	return { sql, values: bindings.values };
}

// ── the property that matters most ──────────────────────────────────────────

describe("values never reach the SQL text", () => {
	// Each of these is a value a caller could send. Whatever it contains, it
	// must come back in `values` and appear in the SQL only as $n.
	const hostile = [
		"'; DROP TABLE tms_raw.tms_order; --",
		"1 OR 1=1",
		"\\'; DELETE FROM platform.app_user; --",
		"%' UNION SELECT password_hash FROM platform.app_user --",
		"a\u0000b",
	];

	for (const value of hostile) {
		it(`keeps ${JSON.stringify(value.slice(0, 28))} as a bound parameter`, () => {
			for (const op of ["eq", "ne", "gt", "lt", "contains", "startsWith"] as const) {
				const { sql, values } = build({ property: "status", op, value });
				expect(sql).not.toContain("DROP");
				expect(sql).not.toContain("UNION");
				expect(sql).not.toContain(value);
				expect(sql).toMatch(/\$1/);
				expect(values).toHaveLength(1);
			}
		});
	}

	it("binds every element of an IN list", () => {
		const { sql, values } = build({
			property: "status",
			op: "in",
			value: ["PLANNED", "'; DROP TABLE x; --", "DELIVERED"],
		});
		expect(sql).toBe('"status" IN ($1, $2, $3)');
		expect(values).toEqual(["PLANNED", "'; DROP TABLE x; --", "DELIVERED"]);
	});

	it("binds both ends of a BETWEEN", () => {
		const { sql, values } = build({ property: "amount", op: "between", value: [10, 20] });
		expect(sql).toBe('"amount" BETWEEN $1::numeric AND $2::numeric');
		expect(values).toEqual([10, 20]);
	});
});

describe("identifiers come from the registry", () => {
	it("refuses a property the object type does not declare", () => {
		expect(() =>
			build({ property: "status; DROP TABLE x", op: "eq", value: "x" }),
		).toThrow(/not a property of Order/);
	});

	it("names the available properties when one is unknown", () => {
		expect(() => build({ property: "nope", op: "eq", value: 1 })).toThrow(/status/);
	});

	it("quotes the column it does use", () => {
		const { sql } = build({ property: "accountKey", op: "isNull" });
		expect(sql).toBe('"account_key" IS NULL');
	});
});

// ── operator semantics ──────────────────────────────────────────────────────

describe("operators", () => {
	it("treats eq with null as IS NULL and binds nothing", () => {
		const { sql, values } = build({ property: "status", op: "eq", value: null });
		expect(sql).toBe('"status" IS NULL');
		expect(values).toHaveLength(0);
	});

	it("treats ne with null as IS NOT NULL", () => {
		const { sql } = build({ property: "status", op: "ne", value: null });
		expect(sql).toBe('"status" IS NOT NULL');
	});

	it("uses IS DISTINCT FROM for ne, so NULL rows are not silently dropped", () => {
		const { sql } = build({ property: "status", op: "ne", value: "PLANNED" });
		expect(sql).toBe('("status" IS DISTINCT FROM $1)');
	});

	it("turns an empty IN list into false rather than invalid SQL", () => {
		const { sql, values } = build({ property: "status", op: "in", value: [] });
		expect(sql).toBe("false");
		expect(values).toHaveLength(0);
	});

	it("turns an empty NOT IN list into true", () => {
		expect(build({ property: "status", op: "notIn", value: [] }).sql).toBe("true");
	});

	it("wraps contains in % on both sides", () => {
		const { values } = build({ property: "status", op: "contains", value: "PLAN" });
		expect(values).toEqual(["%PLAN%"]);
	});

	it("anchors startsWith and endsWith correctly", () => {
		expect(build({ property: "status", op: "startsWith", value: "P" }).values).toEqual(["P%"]);
		expect(build({ property: "status", op: "endsWith", value: "D" }).values).toEqual(["%D"]);
	});

	it("rejects a between without exactly two elements", () => {
		expect(() => build({ property: "amount", op: "between", value: [1] })).toThrow(
			/two-element/,
		);
		expect(() => build({ property: "amount", op: "between", value: "1,2" })).toThrow(
			/two-element/,
		);
	});

	it("rejects an unknown operator", () => {
		expect(() =>
			build({ property: "status", op: "sqli" as never, value: 1 }),
		).toThrow(/Unsupported filter operator/);
	});
});

describe("castTo", () => {
	it("casts to the column type so uuid = text does not error", () => {
		expect(castTo(ACCOUNT_KEY, "$1")).toBe("$1::uuid");
		expect(castTo(AMOUNT, "$1")).toBe("$1::numeric");
	});

	it("leaves text alone", () => {
		expect(castTo(STATUS, "$1")).toBe("$1");
	});
});

// ── limits, which are interpolated rather than bound ────────────────────────

describe("clampLimit", () => {
	it("uses the fallback when nothing is supplied", () => {
		expect(clampLimit(undefined, 50)).toBe(50);
		expect(clampLimit(null, 50)).toBe(50);
	});

	it("clamps into range", () => {
		expect(clampLimit(0, 50)).toBe(1);
		expect(clampLimit(-10, 50)).toBe(1);
		expect(clampLimit(10_000, 50)).toBe(500);
	});

	it("always returns a finite integer, whatever it is handed", () => {
		// This is the point of the function: the result is interpolated into SQL,
		// so it must never be NaN, Infinity or a fraction.
		for (const supplied of ["abc", "5; DROP TABLE x", {}, [], Number.NaN, Infinity, "1e400"]) {
			const result = clampLimit(supplied, 50);
			expect(Number.isInteger(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(1);
			expect(result).toBeLessThanOrEqual(500);
		}
	});

	it("floors a fractional limit", () => {
		expect(clampLimit(10.9, 50)).toBe(10);
	});

	it("accepts a numeric string, which is what a query parameter is", () => {
		expect(clampLimit("25", 50)).toBe(25);
	});
});
