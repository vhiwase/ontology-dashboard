/**
 * Tests for the parts of deleting that need no database: which kinds can be
 * deleted and how they are named, how counts are worded, and what a delete is
 * told when things are still built on what it names.
 */

import { describe, expect, it, vi } from "vitest";

// auth.ts reads its signing secret when it is imported, and removal.ts reaches
// it through the modules it deletes with.
vi.hoisted(() => {
	process.env.AUTH_JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
});

import { requiredRoleFor } from "./auth";
import { REMOVABLE_KINDS, RemovalNeedsCascade, countOf, removableKind, type RemovalPlan } from "./removal";

describe("what can be deleted", () => {
	it("covers every kind of thing a page lists", () => {
		expect([...REMOVABLE_KINDS].sort()).toEqual(
			[
				"actionType",
				"connection",
				"dashboard",
				"dataset",
				"function",
				"linkType",
				"metric",
				"objectType",
				"proposal",
				"schedule",
				"sync",
			].sort(),
		);
	});

	it("takes the workspace's name for a metric as well as the ontology's", () => {
		expect(removableKind("kpi")).toBe("metric");
		expect(removableKind("metric")).toBe("metric");
	});

	it("refuses a kind it does not know, and says which it does", () => {
		expect(() => removableKind("user")).toThrow(/not something that can be deleted.*connection.*proposal/s);
		expect(() => removableKind("")).toThrow(/not something that can be deleted/);
	});
});

describe("who may delete", () => {
	it("needs the admin role to delete, by any kind", () => {
		for (const kind of REMOVABLE_KINDS) {
			expect(requiredRoleFor("DELETE", `/removal/${kind}/anything`)).toBe("admin");
		}
		expect(requiredRoleFor("DELETE", "/resources/12")).toBe("admin");
	});

	it("lets anyone who can read ask what a delete would take with it", () => {
		expect(requiredRoleFor("GET", "/removal/dataset/12")).toBe("viewer");
		expect(requiredRoleFor("GET", "/resources/12/removal")).toBe("viewer");
	});
});

describe("how it is worded", () => {
	it("counts in the singular and the plural", () => {
		expect(countOf(1, "metric")).toBe("1 metric");
		expect(countOf(3, "metric")).toBe("3 metrics");
		expect(countOf(0, "row")).toBe("0 rows");
		expect(countOf(1200, "row")).toBe("1,200 rows");
	});

	it("takes an irregular plural", () => {
		expect(countOf(1, "property", "properties")).toBe("1 property");
		expect(countOf(9, "property", "properties")).toBe("9 properties");
	});
});

describe("a delete that did not mention what is built on it", () => {
	const plan: RemovalPlan = {
		kind: "objectType",
		ref: "Order",
		name: "Order",
		removes: [{ kind: "properties", name: "12 properties" }],
		dependents: [
			{ kind: "metric", name: "order_count" },
			{ kind: "linkType", name: "orderCustomer" },
			{ kind: "actionType", name: "HoldOrder" },
		],
		affects: [],
		refused: null,
	};

	it("is a conflict, not a failure of the request", () => {
		expect(new RemovalNeedsCascade(plan).status).toBe(409);
	});

	it("names each thing, as what it is", () => {
		const message = new RemovalNeedsCascade(plan).message;
		expect(message).toContain("Order still has 3 things built on it");
		expect(message).toContain("metric order_count");
		expect(message).toContain("link orderCustomer");
		expect(message).toContain("action HoldOrder");
		expect(message).toMatch(/Delete those first, or delete it together with them\.$/);
	});

	it("carries the plan, for a caller that wants to show it", () => {
		expect(new RemovalNeedsCascade(plan).plan).toBe(plan);
	});
});
