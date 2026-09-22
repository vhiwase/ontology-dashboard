/**
 * Tests for the pipeline SQL compiler.
 *
 * Two things are being protected here.
 *
 * The first is injection. Node configuration is user input — a filter's
 * column, a join's key, an aggregate's alias all arrive from a form — and this
 * module is the only thing between that input and the database. Every test
 * that feeds a quote or a semicolon into a config field is asserting that it
 * is refused rather than escaped-and-hoped.
 *
 * The second is honesty about what a node produces. The engine this replaced
 * estimated row counts from fixed ratios, so a filter "kept 60%" whatever it
 * filtered. The column-resolution tests are what make the new answers real:
 * a node that names a column its input does not have must fail loudly at
 * compile time, not produce a confusing SQL error two nodes downstream.
 */

import { describe, expect, it, vi } from "vitest";

// The compiler reads the registry for object types and published views. A
// small fake keeps these tests free of a database while still exercising the
// real resolution path.
const objectType = {
	rid: "tms:Transport",
	apiName: "Transport",
	label: "Transport",
	sourceView: "tms_views.v_transport",
	primaryKeyColumn: "transport_key",
	properties: [
		{ apiName: "transportKey", sqlColumn: "transport_key" },
		{ apiName: "carrierName", sqlColumn: "carrier_name" },
		{ apiName: "totalCost", sqlColumn: "total_cost" },
	],
};

vi.mock("./db", () => ({ query: vi.fn(async () => []) }));

vi.mock("./registry", async () => {
	const actual = await vi.importActual<typeof import("./registry")>("./registry");
	return {
		...actual,
		getRegistry: () => ({
			objectTypes: [objectType],
			kpis: [{ apiName: "onTime", sourceView: "tms_views.v_kpi_carrier_scorecard" }],
		}),
		resolveObjectType: (apiName: string) => {
			if (apiName !== "Transport") throw new actual.NotFound(`Unknown object type '${apiName}'.`);
			return objectType;
		},
		resolveColumn: (type: typeof objectType, field: string) => {
			const found = type.properties.find(
				(p) => p.apiName === field || p.sqlColumn === field,
			);
			if (!found) throw new actual.BadRequest(`'${field}' is not a property.`);
			return found;
		},
	};
});

import { assertDistinctOutputs, compileNode, NotExecutable, outputTableName } from "./compile";

type Node = Parameters<typeof compileNode>[0];
type Input = Parameters<typeof compileNode>[1][number];

function node(kind: string, config: Record<string, unknown>, id = "n1"): Node {
	return { id, kind, name: "Test node", position: { x: 0, y: 0 }, config } as Node;
}

function input(columns: string[], name = "Upstream"): Input {
	return {
		relation: '"pipeline_out"."t"',
		columns,
		nodeId: "up",
		name,
		rowCount: 100,
	};
}

const TRANSPORT = ["transport_key", "carrier_name", "total_cost", "total_distance_km"];

// ── sources ─────────────────────────────────────────────────────────────────

describe("source nodes", () => {
	it("reads a view the ontology publishes", () => {
		const compiled = compileNode(node("dataSource", { sourceView: "tms_views.v_transport" }), []);
		expect(compiled.sql).toBe('SELECT * FROM "tms_views"."v_transport"');
	});

	it("refuses a view the ontology does not publish", () => {
		// The whole point: a view name arrives from config, so an arbitrary
		// relation must not become readable just by typing it in.
		expect(() =>
			compileNode(node("dataSource", { sourceView: "platform.app_user" }), []),
		).toThrow(/not a view the published ontology exposes/);
	});

	it("says what to do when no view is selected", () => {
		expect(() => compileNode(node("dataSource", {}), [])).toThrow(/no view selected/);
	});
});

// ── filters ─────────────────────────────────────────────────────────────────

describe("filter", () => {
	it("binds values instead of interpolating them", () => {
		const compiled = compileNode(
			node("filter", { conditions: [{ field: "total_cost", operator: "gt", value: 500 }] }),
			[input(TRANSPORT)],
		);
		expect(compiled.sql).toContain('"total_cost" > $1');
		expect(compiled.params).toEqual([500]);
	});

	it("keeps a quote in a value out of the SQL entirely", () => {
		const attack = "x'; DROP TABLE platform.app_user; --";
		const compiled = compileNode(
			node("filter", { conditions: [{ field: "carrier_name", operator: "eq", value: attack }] }),
			[input(TRANSPORT)],
		);
		expect(compiled.sql).not.toContain("DROP");
		expect(compiled.sql).toContain('"carrier_name" = $1');
		// The hostile text is a parameter, where it is data and not syntax.
		expect(compiled.params).toEqual([attack]);
	});

	it("refuses a column the input does not have, and names the ones it does", () => {
		try {
			compileNode(
				node("filter", { conditions: [{ field: "salary", operator: "eq", value: 1 }] }),
				[input(TRANSPORT)],
			);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(NotExecutable);
			expect((error as Error).message).toContain("salary");
			expect((error as Error).message).toContain("carrier_name");
		}
	});

	it("refuses a column name carrying SQL", () => {
		expect(() =>
			compileNode(
				node("filter", {
					conditions: [{ field: 'total_cost" FROM x; --', operator: "eq", value: 1 }],
				}),
				[input(TRANSPORT)],
			),
		).toThrow(NotExecutable);
	});

	it("refuses an unknown operator rather than passing it through", () => {
		expect(() =>
			compileNode(
				node("filter", { conditions: [{ field: "total_cost", operator: "; DROP", value: 1 }] }),
				[input(TRANSPORT)],
			),
		).toThrow(/not a filter operator/);
	});

	it("puts contains wildcards in the parameter, not the SQL", () => {
		const compiled = compileNode(
			node("filter", { conditions: [{ field: "carrier_name", operator: "contains", value: "DHL" }] }),
			[input(TRANSPORT)],
		);
		expect(compiled.params).toEqual(["%DHL%"]);
		expect(compiled.sql).toContain("ILIKE $1");
	});

	it("passes everything through when no condition is set", () => {
		// A half-built node is a normal state, not an error.
		const compiled = compileNode(node("filter", { conditions: [] }), [input(TRANSPORT)]);
		expect(compiled.sql).toBe('SELECT * FROM "pipeline_out"."t"');
	});
});

// ── aggregate ───────────────────────────────────────────────────────────────

describe("aggregate", () => {
	it("groups and aggregates with quoted identifiers", () => {
		const compiled = compileNode(
			node("aggregate", {
				groupBy: ["carrier_name"],
				measures: [{ aggregation: "avg", field: "total_cost", alias: "avg_cost" }],
			}),
			[input(TRANSPORT)],
		);
		expect(compiled.sql).toContain('avg("total_cost") AS "avg_cost"');
		expect(compiled.sql).toContain('GROUP BY "carrier_name"');
		expect(compiled.columns).toEqual(["carrier_name", "avg_cost"]);
	});

	it("refuses an alias that is not a plain identifier", () => {
		// An alias is the one caller-chosen identifier in the statement, so it
		// goes through the same check as any other.
		expect(() =>
			compileNode(
				node("aggregate", {
					groupBy: ["carrier_name"],
					measures: [{ aggregation: "sum", field: "total_cost", alias: 'x" , (SELECT 1) AS "y' }],
				}),
				[input(TRANSPORT)],
			),
		).toThrow(/Refusing to use/);
	});

	it("refuses an unknown aggregation", () => {
		expect(() =>
			compileNode(
				node("aggregate", {
					groupBy: ["carrier_name"],
					measures: [{ aggregation: "exec", field: "total_cost" }],
				}),
				[input(TRANSPORT)],
			),
		).toThrow(/not an aggregation/);
	});

	it("supports count(*) without a field", () => {
		const compiled = compileNode(
			node("aggregate", { groupBy: ["carrier_name"], measures: [{ aggregation: "count" }] }),
			[input(TRANSPORT)],
		);
		expect(compiled.sql).toContain('count(*) AS "row_count"');
	});
});

// ── calculated columns ──────────────────────────────────────────────────────

describe("calculate", () => {
	it("divides two columns, guarding against a zero denominator", () => {
		const compiled = compileNode(
			node("filter", {
				mode: "calculate",
				alias: "cost_per_km",
				left: "total_cost",
				right: "total_distance_km",
				operator: "divide",
			}),
			[input(TRANSPORT)],
		);
		// A row whose distance is zero should produce null, not fail the run.
		expect(compiled.sql).toContain("CASE WHEN");
		expect(compiled.sql).toContain('AS "cost_per_km"');
	});

	it("binds a constant operand", () => {
		const compiled = compileNode(
			node("filter", {
				mode: "calculate",
				alias: "doubled",
				left: "total_cost",
				operator: "multiply",
				rightValue: 2,
			}),
			[input(TRANSPORT)],
		);
		expect(compiled.params).toEqual([2]);
	});

	it("refuses to shadow a column the input already has", () => {
		// This is the bug the first real run hit: v_transport already publishes
		// cost_per_km, and `SELECT *, … AS cost_per_km` is invalid SQL. The
		// message has to name the clash rather than leave Postgres to say
		// "column specified more than once" with no node attached.
		try {
			compileNode(
				node("filter", {
					mode: "calculate",
					alias: "cost_per_km",
					left: "total_cost",
					right: "total_distance_km",
					operator: "divide",
				}),
				[input([...TRANSPORT, "cost_per_km"])],
			);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect((error as Error).message).toContain("cost_per_km");
			expect((error as Error).message).toContain("replace");
		}
	});

	it("overwrites the column when replace is set explicitly", () => {
		const compiled = compileNode(
			node("filter", {
				mode: "calculate",
				alias: "cost_per_km",
				left: "total_cost",
				right: "total_distance_km",
				operator: "divide",
				replace: true,
			}),
			[input([...TRANSPORT, "cost_per_km"])],
		);
		// The old column is projected away rather than duplicated.
		expect(compiled.sql).not.toMatch(/"cost_per_km".*AS "cost_per_km"/);
		expect(compiled.columns.filter((c) => c === "cost_per_km")).toHaveLength(1);
	});
});

// ── raw SQL ─────────────────────────────────────────────────────────────────

describe("raw SQL node", () => {
	it("accepts a plain SELECT and substitutes the input relation", () => {
		const compiled = compileNode(node("sql", { sql: "SELECT * FROM input WHERE 1=1" }), [
			input(TRANSPORT),
		]);
		expect(compiled.sql).toContain('"pipeline_out"."t"');
	});

	it.each([
		["DROP TABLE platform.app_user"],
		["INSERT INTO platform.dashboard (slug) VALUES ('x')"],
		["UPDATE platform.app_user SET role = 'admin'"],
		["DELETE FROM platform.dashboard"],
		["TRUNCATE platform.app_user"],
		["GRANT ALL ON platform.app_user TO public"],
	])("refuses %s", (statement) => {
		expect(() => compileNode(node("sql", { sql: statement }), [input(TRANSPORT)])).toThrow(
			/must be a single SELECT/,
		);
	});

	it("refuses a stacked statement", () => {
		expect(() =>
			compileNode(node("sql", { sql: "SELECT 1; DROP TABLE platform.app_user" }), [
				input(TRANSPORT),
			]),
		).toThrow(/one statement/);
	});

	it("refuses a statement stacked behind a line comment", () => {
		// `-- x` would hide the semicolon from a naive check, so comments are
		// stripped before the statement count is taken.
		expect(() =>
			compileNode(node("sql", { sql: "SELECT 1 -- harmless\n; DROP TABLE platform.app_user" }), [
				input(TRANSPORT),
			]),
		).toThrow(/one statement/);
	});

	it("refuses a statement stacked behind a block comment", () => {
		expect(() =>
			compileNode(node("sql", { sql: "SELECT 1 /* x */ ; DELETE FROM platform.dashboard" }), [
				input(TRANSPORT),
			]),
		).toThrow(/one statement/);
	});

	it("allows a trailing semicolon, which is just tidiness", () => {
		expect(() =>
			compileNode(node("sql", { sql: "SELECT * FROM input;" }), [input(TRANSPORT)]),
		).not.toThrow();
	});

	it("allows a read-only WITH", () => {
		expect(() =>
			compileNode(node("sql", { sql: "WITH x AS (SELECT 1 AS n) SELECT * FROM x" }), [
				input(TRANSPORT),
			]),
		).not.toThrow();
	});
});

// ── joins and unions ────────────────────────────────────────────────────────

describe("join", () => {
	it("aliases a duplicated column rather than emitting it twice", () => {
		const compiled = compileNode(
			node("join", { leftKey: "carrier_name", rightKey: "carrier_name", joinType: "left" }),
			[input(["carrier_name", "total_cost"], "L"), input(["carrier_name", "region"], "R")],
		);
		expect(compiled.columns).toEqual(["carrier_name", "total_cost", "carrier_name_right", "region"]);
		expect(compiled.sql).toContain("LEFT JOIN");
	});

	it("refuses an unknown join type", () => {
		expect(() =>
			compileNode(node("join", { leftKey: "a", rightKey: "a", joinType: "cross; DROP" }), [
				input(["a"]),
				input(["a"]),
			]),
		).toThrow(/not a join type/);
	});

	it("refuses a join with one input", () => {
		expect(() =>
			compileNode(node("join", { leftKey: "a", rightKey: "a" }), [input(["a"])]),
		).toThrow(/exactly two inputs/);
	});
});

describe("union", () => {
	it("uses only the columns every input shares", () => {
		const compiled = compileNode(node("filter", { mode: "union" }), [
			input(["a", "b", "c"]),
			input(["a", "b", "z"]),
		]);
		expect(compiled.columns).toEqual(["a", "b"]);
		expect(compiled.sql).toContain("UNION ALL");
	});

	it("refuses inputs with nothing in common", () => {
		expect(() =>
			compileNode(node("filter", { mode: "union" }), [input(["a"]), input(["z"])]),
		).toThrow(/share no columns/);
	});
});

// ── non-executable kinds ────────────────────────────────────────────────────

describe("nodes that do not produce a relation", () => {
	it.each([["linkType"], ["actionType"], ["dashboard"], ["llm"], ["python"]])(
		"%s is refused with a reason rather than compiled",
		(kind) => {
			expect(() => compileNode(node(kind, {}), [input(TRANSPORT)])).toThrow(NotExecutable);
		},
	);
});

// ── output naming ───────────────────────────────────────────────────────────

describe("output table names", () => {
	it("sanitises a hostile node id", () => {
		const table = outputTableName("my-pipeline", 'n"; DROP TABLE x; --');
		expect(table).toMatch(/^[a-z0-9_]+$/);
	});

	it("stays within Postgres's identifier limit", () => {
		const table = outputTableName("a".repeat(120), "b".repeat(120));
		expect(table.length).toBeLessThanOrEqual(63);
	});

	it("catches two node ids that would collide once sanitised", () => {
		// 'a-b' and 'a_b' both sanitise to 'a_b', so one would silently
		// overwrite the other's output.
		const graph = {
			nodes: [
				{ id: "a-b", kind: "filter", name: "x", position: { x: 0, y: 0 }, config: {} },
				{ id: "a_b", kind: "filter", name: "y", position: { x: 0, y: 0 }, config: {} },
			],
			edges: [],
		};
		expect(() => assertDistinctOutputs(graph as never, "p")).toThrow(/same table/);
	});
});
