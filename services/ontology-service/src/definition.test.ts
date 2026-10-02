/**
 * The document ontograph validates, exports and checks actions against is now
 * built here from the ontology tables. These build one from rows shaped like
 * an authored ontology and hold it to ontograph's own validator - the same
 * check the Python generator's output used to pass with no errors.
 */

import { AccessController, OntologyValidator } from "@ontograph/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null) }));

import { buildDefinition, datatypeFor, inverseRid } from "./definition";

const rows = {
	version: "1.3",
	types: [
		{
			object_type_rid: "tms:Order",
			label: "Order",
			description: "Created from tms_views.v_order.",
			kind: "entity" as const,
			icon: null,
			color: "#E8A33D",
			group_name: "tms_ontology",
		},
		{
			object_type_rid: "tms:Account",
			label: "Account",
			description: null,
			kind: "entity" as const,
			icon: null,
			color: null,
			group_name: null,
		},
	],
	properties: [
		{ object_property_rid: "tms:Order.orderKey", object_type_rid: "tms:Order", label: "Order Key", description: null, datatype: "string", is_identity: true, is_nullable: false },
		{ object_property_rid: "tms:Order.accountKey", object_type_rid: "tms:Order", label: "Account Key", description: null, datatype: "string", is_identity: false, is_nullable: true },
		{ object_property_rid: "tms:Order.grossWeightKg", object_type_rid: "tms:Order", label: "Gross Weight Kg", description: null, datatype: "decimal", is_identity: false, is_nullable: true },
		{ object_property_rid: "tms:Account.accountKey", object_type_rid: "tms:Account", label: "Account Key", description: null, datatype: "string", is_identity: true, is_nullable: false },
	],
	links: [
		{
			link_type_rid: "tms:orderAccount",
			label: "Account",
			description: null,
			source_object_type: "tms:Order",
			target_object_type: "tms:Account",
			cardinality: "MANY_TO_ONE",
			inverse_api_name: "orders",
			inverse_label: "Orders",
		},
	],
	actions: [
		{
			action_type_rid: "tms:HoldOrder",
			label: "Hold Order",
			description: null,
			target_object_types: ["tms:Order"],
			parameters: [
				{ name: "orderKey", label: { en: "Order" }, type: "string" as const, required: true },
			],
			requires_approval: false,
			approver_roles: [],
			allowed_roles: ["tms:AdminRole", "tms:DispatcherRole"],
			audit_level: "full" as const,
			tags: [],
		},
	],
};

describe("buildDefinition", () => {
	it("produces a document ontograph's own validator accepts", () => {
		const definition = buildDefinition(rows);
		const result = new OntologyValidator().validate(definition);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("gives every link its inverse, pointing back", () => {
		const definition = buildDefinition(rows);
		const forward = definition.relationTypes.find((r) => r["@id"] === "tms:orderAccount");
		const inverse = definition.relationTypes.find((r) => r["@id"] === "tms:orders");
		expect(forward).toMatchObject({ domain: "tms:Order", range: "tms:Account", max: 1, inverse: "tms:orders" });
		expect(inverse).toMatchObject({ domain: "tms:Account", range: "tms:Order", max: null, inverse: "tms:orderAccount" });
		expect(definition.entityTypes.find((t) => t["@id"] === "tms:Account")?.relations).toEqual([
			{ ref: "tms:orders" },
		]);
	});

	it("is still valid with nothing in it, which is how every space starts", () => {
		const definition = buildDefinition({ version: "1.0", types: [], properties: [], links: [], actions: [] });
		expect(new OntologyValidator().validate(definition).valid).toBe(true);
		expect(definition.roles?.length).toBe(5);
	});

	it("lets a role run exactly the actions that name it", () => {
		const definition = buildDefinition(rows);
		const controller = new AccessController({ defaultPolicy: "deny" });
		controller.registerRoles(definition.roles ?? []);
		const can = (role: string) =>
			controller.check("someone", [role], "execute", "actionType", "tms:HoldOrder").allowed;
		expect(can("tms:DispatcherRole")).toBe(true);
		expect(can("tms:AdminRole")).toBe(true);
		// Not named on the action, so denied - and the analyst, which the
		// assistant's users usually are, may run nothing at all.
		expect(can("tms:FinanceRole")).toBe(false);
		expect(can("tms:AnalystRole")).toBe(false);
	});
});

describe("datatypeFor", () => {
	it("maps the landing table's types to ontology datatypes", () => {
		expect(datatypeFor("uuid")).toBe("string");
		expect(datatypeFor("text")).toBe("string");
		expect(datatypeFor("bigint")).toBe("integer");
		expect(datatypeFor("numeric")).toBe("decimal");
		expect(datatypeFor("double precision")).toBe("float");
		expect(datatypeFor("boolean")).toBe("boolean");
		expect(datatypeFor("timestamp with time zone")).toBe("datetime");
		expect(datatypeFor("date")).toBe("date");
		expect(datatypeFor("jsonb")).toBe("object");
		expect(datatypeFor("text[]")).toBe("array");
	});
});

describe("inverseRid", () => {
	it("uses the inverse's own name, or derives one", () => {
		expect(inverseRid({ link_type_rid: "tms:orderAccount", inverse_api_name: "orders" })).toBe("tms:orders");
		expect(inverseRid({ link_type_rid: "tms:orderAccount", inverse_api_name: null })).toBe("tms:orderAccountInverse");
	});
});
