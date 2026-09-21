/**
 * Tests for pipeline validation and run ordering.
 *
 * Validation is what separates the builder from a drawing tool: it checks the
 * graph against the PUBLISHED ontology, so a node naming an object type that
 * does not exist is an error rather than a pretty rectangle. The registry is
 * mocked here so the rules can be exercised without a database.
 */

import { describe, expect, it, vi } from "vitest";

// Mocked before the module under test is imported, because validateGraph
// reads the registry at call time through this import.
vi.mock("./registry", async () => {
	const actual = await vi.importActual<typeof import("./registry")>("./registry");
	return {
		...actual,
		getRegistry: () => ({
			objectTypes: [
				{ apiName: "Order", label: "Order", group: "Ops", rowCount: 90, properties: [], sourceView: "v_order" },
				{ apiName: "Shipment", label: "Shipment", group: "Ops", rowCount: 212, properties: [], sourceView: "v_shipment" },
			],
			linkTypes: [
				{
					apiName: "orderToShipment",
					label: "Order to Shipment",
					sourceObjectType: "Order",
					targetObjectType: "Shipment",
					cardinality: "one-to-many",
					matchRatio: 1,
					isVerified: true,
				},
				{
					apiName: "shipmentToCarrier",
					label: "Shipment to Carrier",
					sourceObjectType: "Shipment",
					targetObjectType: "Carrier",
					cardinality: "many-to-one",
					matchRatio: 0.42,
					isVerified: false,
				},
			],
			actionTypes: [{ apiName: "PlanOrder", label: "Plan Order", isReadOnly: false, targetObjectTypes: ["Order"] }],
			kpis: [{ apiName: "order_count", label: "Orders", category: "Ops", dependsOnSimulation: false }],
		}),
	};
});

// A plain import, not a top-level `await import`: vitest hoists vi.mock above
// the imports, so the mocked registry is already in place, and top-level await
// is not available under this project's CommonJS target.
import { topologicalOrder, validateGraph } from "./pipelines";

type Graph = Parameters<typeof validateGraph>[0];

// Every node carries a description, so the "undocumented" warning does not
// appear in tests that are about something else.
function node(id: string, kind: string, config: Record<string, unknown> = {}) {
	return {
		id,
		kind,
		name: id,
		position: { x: 0, y: 0 },
		config,
		description: `${id} description`,
	};
}

function edge(source: string, target: string) {
	return { id: `${source}->${target}`, source, target };
}

function graph(nodes: unknown[], edges: unknown[] = []): Graph {
	return { nodes, edges } as Graph;
}

function codes(report: ReturnType<typeof validateGraph>) {
	return [...report.errors, ...report.warnings].map((i) => i.code);
}

describe("ontology agreement", () => {
	it("accepts a node naming a published object type", () => {
		const report = validateGraph(
			graph([node("src", "dataSource", { connection: "postgres" }), node("ot", "objectType", { objectType: "Order" })],
				[edge("src", "ot")]),
		);
		expect(report.errors).toHaveLength(0);
		expect(report.status).toBe("valid");
	});

	it("rejects an object type that is not in the ontology", () => {
		const report = validateGraph(graph([node("ot", "objectType", { objectType: "Unicorn" })]));
		expect(codes(report)).toContain("unknown_object_type");
		expect(report.status).toBe("invalid");
	});

	it("rejects a link whose cardinality contradicts the discovered one", () => {
		// The registry discovered orderToShipment as one-to-many. A node
		// claiming many-to-one is describing a relationship that is not there.
		const report = validateGraph(
			graph([
				node("ot", "objectType", { objectType: "Order" }),
				node("lk", "linkType", { linkType: "orderToShipment", cardinality: "many-to-one" }),
			], [edge("ot", "lk")]),
		);
		expect(codes(report)).toContain("cardinality_mismatch");
	});

	it("accepts a link whose cardinality agrees", () => {
		const report = validateGraph(
			graph([
				node("ot", "objectType", { objectType: "Order" }),
				node("lk", "linkType", { linkType: "orderToShipment", cardinality: "one-to-many" }),
			], [edge("ot", "lk")]),
		);
		expect(codes(report)).not.toContain("cardinality_mismatch");
	});

	it("warns about a link that only joins some rows", () => {
		const report = validateGraph(
			graph([
				node("ot", "objectType", { objectType: "Shipment" }),
				node("lk", "linkType", { linkType: "shipmentToCarrier" }),
			], [edge("ot", "lk")]),
		);
		expect(codes(report)).toContain("partial_link");
		// A partial link is a warning, not an error: it is still a real link.
		expect(report.errors.map((e) => e.code)).not.toContain("partial_link");
	});

	it("rejects a KPI that is not in the catalogue", () => {
		const report = validateGraph(
			graph([node("dash", "dashboard", { kpis: ["order_count", "invented_kpi"] })]),
		);
		expect(codes(report)).toContain("unknown_kpi");
	});

	it("reports an action that is not wired to the object type it acts on", () => {
		const report = validateGraph(
			graph([
				node("ot", "objectType", { objectType: "Order" }),
				node("lk", "linkType", { linkType: "orderToShipment" }),
				node("act", "actionType", { actionType: "PlanOrder" }),
			], [edge("ot", "lk"), edge("lk", "act")]),
		);
		expect(codes(report)).toContain("action_input_unmapped");
	});
});

describe("graph structure", () => {
	it("rejects a connection the node types do not allow", () => {
		// A data source is a root and accepts no input.
		const report = validateGraph(
			graph([node("ot", "objectType", { objectType: "Order" }), node("src", "dataSource", { connection: "pg" })],
				[edge("ot", "src")]),
		);
		expect(codes(report)).toContain("illegal_connection");
	});

	it("rejects an edge pointing at a node that is not on the canvas", () => {
		const report = validateGraph(graph([node("a", "dataset")], [edge("a", "ghost")]));
		expect(codes(report)).toContain("dangling_edge");
	});

	it("detects a cycle", () => {
		const report = validateGraph(
			graph([node("a", "filter"), node("b", "filter"), node("c", "filter")],
				[edge("a", "b"), edge("b", "c"), edge("c", "a")]),
		);
		expect(codes(report)).toContain("cycle");
	});

	it("does not call a diamond a cycle", () => {
		// a -> b, a -> c, b -> d, c -> d revisits d but is acyclic.
		const report = validateGraph(
			graph([node("a", "dataset"), node("b", "filter"), node("c", "filter"), node("d", "join", { on: "id" })],
				[edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]),
		);
		expect(codes(report)).not.toContain("cycle");
	});

	it("rejects duplicate node ids", () => {
		const report = validateGraph(graph([node("same", "dataset"), node("same", "filter")]));
		expect(codes(report)).toContain("duplicate_id");
	});

	it("requires a join to have two inputs and a key", () => {
		const report = validateGraph(
			graph([node("a", "dataset"), node("j", "join")], [edge("a", "j")]),
		);
		expect(codes(report)).toContain("join_needs_two");
		expect(codes(report)).toContain("unconfigured");
	});

	it("warns rather than errors on an undocumented node", () => {
		const report = validateGraph(
			graph([{ id: "n", kind: "dataset", name: "n", position: { x: 0, y: 0 }, config: {} }]),
		);
		expect(report.warnings.map((w) => w.code)).toContain("undocumented");
		expect(report.status).toBe("warnings");
	});

	it("attaches each issue to a node so the canvas can focus it", () => {
		const report = validateGraph(graph([node("ot", "objectType", { objectType: "Nope" })]));
		const issue = report.errors.find((e) => e.code === "unknown_object_type");
		expect(issue?.nodeId).toBe("ot");
	});
});

describe("topologicalOrder", () => {
	it("returns dependencies before dependents", () => {
		const g = graph(
			[node("c", "objectType"), node("a", "dataSource"), node("b", "filter")],
			[edge("a", "b"), edge("b", "c")],
		);
		expect(topologicalOrder(g).map((n) => n.id)).toEqual(["a", "b", "c"]);
	});

	it("still returns every node when the graph has a cycle", () => {
		// A run must not silently skip nodes; validation reports the cycle.
		const g = graph([node("a", "filter"), node("b", "filter")], [edge("a", "b"), edge("b", "a")]);
		expect(topologicalOrder(g).map((n) => n.id).sort()).toEqual(["a", "b"]);
	});

	it("handles an empty graph", () => {
		expect(topologicalOrder(graph([]))).toEqual([]);
	});
});
