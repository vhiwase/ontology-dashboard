/**
 * The judgement calls authoring makes before anything is stored: what a
 * dataset's object type is called, and which role a column plays. A wrong
 * role is the quiet failure here - a key read as a measure gets summed on a
 * dashboard - so the numbers-that-identify cases are pinned.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null) }));

import { camelCase, humanize, objectTypeNameFor, pascalCase, suggestRole } from "./authoring";

describe("naming", () => {
	it("names an object type for the view, singular, without the view prefix", () => {
		expect(objectTypeNameFor("v_order")).toBe("Order");
		expect(objectTypeNameFor("v_transport_leg")).toBe("TransportLeg");
		expect(objectTypeNameFor("v_transport_stops")).toBe("TransportStop");
		expect(objectTypeNameFor("carriers")).toBe("Carrier");
		expect(objectTypeNameFor("v_business_entity")).toBe("BusinessEntity");
		expect(objectTypeNameFor("v_address")).toBe("Address");
	});

	it("turns columns into api names and labels", () => {
		expect(camelCase("gross_weight_kg")).toBe("grossWeightKg");
		expect(camelCase("order_key")).toBe("orderKey");
		expect(pascalCase("bill_to")).toBe("BillTo");
		expect(humanize("on_time_pct")).toBe("On Time %");
	});

	it("never produces an api name that does not start with a letter", () => {
		expect(camelCase("2024_total")).toMatch(/^[a-z]/);
	});
});

describe("suggestRole", () => {
	const stats = { rowCount: 100, distinct: 100, nulls: 0 };

	it("keeps the key and the title in their roles", () => {
		expect(suggestRole("order_key", "uuid", stats, true, false).semanticRole).toBe("identity");
		expect(suggestRole("order_number", "text", stats, false, true).semanticRole).toBe("title");
	});

	it("sums a quantity and averages a rate", () => {
		expect(suggestRole("gross_weight_kg", "numeric", stats, false, false)).toEqual({
			semanticRole: "measure",
			defaultAggregation: "sum",
		});
		expect(suggestRole("on_time_pct", "numeric", stats, false, false)).toEqual({
			semanticRole: "measure",
			defaultAggregation: "avg",
		});
	});

	it("does not treat a number that identifies something as a measure", () => {
		for (const column of ["status_code", "carrier_id", "pickup_year", "line_number", "stop_sequence"]) {
			expect(suggestRole(column, "integer", stats, false, false).semanticRole).toBe("dimension");
		}
	});

	it("reads a reference to another object as a dimension, whatever its type or spread", () => {
		// 65 distinct origins across 90 orders: unique enough to look like free
		// text, but it is the column a link to Location is drawn from.
		const spread = { rowCount: 90, distinct: 65, nulls: 0 };
		expect(suggestRole("origin_location_key", "uuid", spread, false, false).semanticRole).toBe("dimension");
		expect(suggestRole("bill_to_key", "text", spread, false, false).semanticRole).toBe("dimension");
	});

	it("combines a measure the way its name says", () => {
		expect(suggestRole("max_unit_weight_kg", "numeric", stats, false, false).defaultAggregation).toBe("max");
		expect(suggestRole("min_temperature", "numeric", stats, false, false).defaultAggregation).toBe("min");
		expect(suggestRole("planned_transit_days", "numeric", stats, false, false).defaultAggregation).toBe("avg");
		expect(suggestRole("pickup_window_hours", "numeric", stats, false, false).defaultAggregation).toBe("avg");
		expect(suggestRole("piece_count", "bigint", stats, false, false).defaultAggregation).toBe("sum");
	});

	it("keeps provenance apart from the data", () => {
		expect(suggestRole("data_origin", "text", { rowCount: 90, distinct: 1, nulls: 0 }, false, false).semanticRole).toBe(
			"provenance",
		);
	});

	it("does not sum coordinates", () => {
		expect(suggestRole("origin_latitude", "double precision", stats, false, false).semanticRole).toBe("geo");
		expect(suggestRole("destination_lng", "double precision", stats, false, false).semanticRole).toBe("geo");
	});

	it("reads times, flags and repeated text for what they are", () => {
		expect(suggestRole("pickup_date", "date", stats, false, false).semanticRole).toBe("temporal");
		expect(suggestRole("created_at", "timestamp with time zone", stats, false, false).semanticRole).toBe("temporal");
		expect(suggestRole("is_closed", "boolean", stats, false, false).semanticRole).toBe("flag");
		expect(
			suggestRole("transportation_mode", "text", { rowCount: 100, distinct: 4, nulls: 0 }, false, false)
				.semanticRole,
		).toBe("dimension");
	});

	it("leaves unique free text as an attribute", () => {
		expect(suggestRole("special_instructions", "text", stats, false, false).semanticRole).toBe("attribute");
	});
});
