/** The derived-property language: what sequence_of compiles to, and what it refuses. */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.AUTH_JWT_SECRET ??= "test-secret-test-secret-test-secret-0123";
});

import { compileExpression } from "./derived";

const numeric = new Map([["order_id", 'b."order_id"']]);
const dates = new Map([["order_date", 'b."order_date"']]);
const keys = new Map([
	["customer_id", 'b."customer_id"'],
	["order_id", 'b."order_id"'],
	["order_date", 'b."order_date"'],
]);

describe("sequence_of", () => {
	it("numbers each key's rows in date order, ties broken by the third column", () => {
		const { sql } = compileExpression("sequence_of(customer_id, order_date, order_id)", numeric, dates, keys);
		expect(sql).toBe('(row_number() OVER (PARTITION BY b."customer_id" ORDER BY b."order_date", b."order_id"))::numeric');
	});

	it("compares like any number, so a first row is a flag", () => {
		const { sql } = compileExpression("(sequence_of(customer_id, order_date) = 1)", numeric, dates, keys);
		expect(sql).toContain("row_number() OVER (PARTITION BY b.\"customer_id\" ORDER BY b.\"order_date\")");
		expect(sql).toContain("THEN 1 ELSE 0 END");
	});

	it("orders by a date and counts within a named column only", () => {
		expect(() => compileExpression("sequence_of(customer_id, order_id)", numeric, dates, keys)).toThrow(/date/);
		expect(() => compileExpression("sequence_of(customer_id + 1, order_date)", numeric, dates, keys)).toThrow(/property name/);
		expect(() => compileExpression("sequence_of(nobody, order_date)", numeric, dates, keys)).toThrow(/property name/);
	});

	it("is not available where no key columns are offered", () => {
		expect(() => compileExpression("sequence_of(customer_id, order_date)", numeric, dates)).toThrow(/property name/);
	});
});
