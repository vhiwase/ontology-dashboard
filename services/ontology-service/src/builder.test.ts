/**
 * Tests for the Ontology Builder's field resolution.
 *
 * This is the injection surface. A caller sends `{ fields: { label: "..." } }`
 * and those keys become COLUMN NAMES in an UPDATE against platform.object_type.
 * An allow-list is what stands between a request body and the schema, so every
 * test here is asserting that something outside the list is refused by name
 * rather than passed through or silently ignored.
 *
 * Silently ignoring matters as much as refusing. An edit that appears to work
 * and changes nothing is the worst outcome: the user believes the label is
 * fixed, the dashboard still shows the old one, and nothing anywhere says why.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null) }));
vi.mock("./kpi", () => ({ clearColumnCache: vi.fn() }));

import { resolveFields } from "./builder";

describe("editable fields", () => {
	it("maps a camelCase field to its SQL column", () => {
		const fields = resolveFields("objectType", { pluralLabel: "Orders" });
		expect(fields).toEqual([{ column: "plural_label", value: "Orders" }]);
	});

	it("refuses api_name, which everything else refers to the type by", () => {
		expect(() => resolveFields("objectType", { apiName: "Hacked" })).toThrow(
			/not an editable field/,
		);
	});

	it("refuses the RID", () => {
		expect(() => resolveFields("objectType", { rid: "tms:Other" })).toThrow(
			/not an editable field/,
		);
	});

	it("refuses source_view, which is what the type is derived from", () => {
		// Repointing this would not move any data; it would just make the type
		// describe something it is not.
		expect(() => resolveFields("objectType", { sourceView: "platform.app_user" })).toThrow(
			/not an editable field/,
		);
	});

	it("refuses a key carrying SQL rather than escaping it", () => {
		expect(() =>
			resolveFields("objectType", { "label = 'x', description": "y" }),
		).toThrow(/not an editable field/);
	});

	it("names the fields that ARE allowed, so a typo is correctable", () => {
		try {
			resolveFields("objectType", { colour: "red" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect((error as Error).message).toContain("colour");
			expect((error as Error).message).toContain("color");
		}
	});

	it("refuses an empty change rather than issuing an UPDATE with no assignments", () => {
		expect(() => resolveFields("objectType", {})).toThrow(/No fields to change/);
	});
});

describe("constrained values", () => {
	it("accepts a valid semantic role", () => {
		expect(resolveFields("property", { semanticRole: "measure" })).toEqual([
			{ column: "semantic_role", value: "measure" },
		]);
	});

	it("refuses a semantic role the CHECK would reject", () => {
		// Caught here rather than at the database, so the message names the
		// options instead of quoting a constraint.
		expect(() => resolveFields("property", { semanticRole: "wizard" })).toThrow(
			/not a valid semanticRole/,
		);
	});

	it("refuses an invalid cardinality", () => {
		expect(() => resolveFields("linkType", { cardinality: "MANY_TO_MANY_TO_MANY" })).toThrow(
			/not a valid cardinality/,
		);
	});

	it("allows null through a constrained field, which clears it", () => {
		expect(resolveFields("property", { unit: null })).toEqual([
			{ column: "unit", value: null },
		]);
	});
});

describe("per-kind allow-lists are distinct", () => {
	it("does not let an object type field be set on a property", () => {
		expect(() => resolveFields("property", { icon: "box" })).toThrow(/not an editable field/);
	});

	it("does not let a link field be set on an action", () => {
		expect(() => resolveFields("actionType", { cardinality: "ONE_TO_ONE" })).toThrow(
			/not an editable field/,
		);
	});
});
