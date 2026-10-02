/**
 * The shape check and the plan walk behind every function definition. The
 * reach check itself needs a planner, so it is exercised against the live
 * database; what is pinned here is that the text checks refuse what they must
 * and that a plan's every relation is found, however deeply nested.
 */

import { describe, expect, it, vi } from "vitest";

// The plan the "planner" reports for whatever is explained: one scan per relation.
const planned = vi.hoisted(() => ({ relations: [] as string[] }));

vi.mock("./db", () => ({
	pool: {
		connect: async () => ({
			release: () => {},
			query: async (sql: string) => {
				if (sql.startsWith("EXPLAIN")) {
					const Plans = planned.relations.map((r) => {
						const [Schema, name] = r.split(".");
						return { "Node Type": "Seq Scan", Schema, "Relation Name": name };
					});
					return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Append", Plans } }] }] };
				}
				return { rows: [], fields: [{ name: "n" }] };
			},
		}),
	},
	query: vi.fn(async () => []),
	queryOne: vi.fn(async () => null),
}));

import { assertSingleSelect, inspectSelect, relationsInPlan } from "./sqlGuard";

describe("assertSingleSelect", () => {
	it("accepts one SELECT or WITH, and drops a trailing semicolon", () => {
		expect(assertSingleSelect("SELECT 1;")).toBe("SELECT 1");
		expect(assertSingleSelect("with x as (select 1) select * from x")).toMatch(/^with/);
	});

	it("refuses a second statement, however it is hidden", () => {
		expect(() => assertSingleSelect("SELECT 1; DROP TABLE x")).toThrow(/one statement/);
		expect(() => assertSingleSelect("SELECT 1 /* ; */; DELETE FROM x")).toThrow(/one statement/);
	});

	it("does not let a comment hide the first keyword", () => {
		expect(() => assertSingleSelect("-- SELECT\nDELETE FROM x")).toThrow(/single SELECT/);
	});

	it("refuses anything but a read", () => {
		expect(() => assertSingleSelect("UPDATE x SET y = 1")).toThrow(/single SELECT/);
		expect(() => assertSingleSelect("")).toThrow(/empty/);
	});

	it("refuses server functions that reach outside the data", () => {
		expect(() => assertSingleSelect("SELECT pg_read_file('/etc/passwd')")).toThrow(/reaches outside/);
		expect(() => assertSingleSelect("SELECT * FROM pg_ls_dir('.')")).toThrow(/reaches outside/);
		expect(() => assertSingleSelect("select pg_sleep(100)")).toThrow(/reaches outside/);
		expect(() => assertSingleSelect("SELECT set_config('role', 'x', false)")).toThrow(/reaches outside/);
	});

	it("refuses functions that run SQL handed to them as text", () => {
		// The planner reports these as a function call, not as what the text reads.
		expect(() => assertSingleSelect("SELECT * FROM ts_stat('select to_tsvector(password_hash) from platform.app_user')")).toThrow(
			/reaches outside/,
		);
		expect(() => assertSingleSelect("SELECT ts_rewrite(to_tsquery('a'), 'SELECT 1')")).toThrow(/reaches outside/);
		expect(() => assertSingleSelect("SELECT schema_to_xml('platform', true, false, '')")).toThrow(/reaches outside/);
		expect(() => assertSingleSelect("SELECT cursor_to_xml('c', 1, true, false, '')")).toThrow(/reaches outside/);
	});

	it("refuses a query carried inside a string, quoted or dollar-quoted", () => {
		expect(() => assertSingleSelect("SELECT x FROM t WHERE y = ' select 1'")).toThrow(/inside a string/);
		expect(() => assertSingleSelect("SELECT $q$WITH a AS (SELECT 1) SELECT 1$q$")).toThrow(/inside a string/);
		// Ordinary text that merely contains the word is fine.
		expect(assertSingleSelect("SELECT x FROM t WHERE note = 'pick from shelf'")).toMatch(/pick from shelf/);
	});
});

describe("reach", () => {
	const own = { tablePrefix: "w5_", owner: "this workspace's" };

	it("reads every synced dataset in a shared space", async () => {
		planned.relations = ["connection_raw.w5_shop__public__orders", "connection_raw.w6_other__public__orders"];
		await expect(inspectSelect("SELECT 1 FROM x")).resolves.toMatchObject({ relations: planned.relations });
	});

	it("reads only the workspace's own tables, including under a combined dataset", async () => {
		planned.relations = ["connection_raw.w5_shop__public__orders", "connection_raw.w5_shop__public__customers"];
		await expect(inspectSelect("SELECT 1 FROM ontology_views.s5_order_history", own)).resolves.toBeTruthy();
	});

	it("refuses another workspace's table, however it is reached", async () => {
		planned.relations = ["connection_raw.w5_shop__public__orders", "connection_raw.w55_other__public__orders"];
		await expect(inspectSelect("SELECT 1 FROM x", own)).rejects.toThrow(/only this workspace's synced datasets.*w55_other/);
		planned.relations = ["platform.app_user"];
		await expect(inspectSelect("SELECT 1 FROM x", own)).rejects.toThrow(/only synced datasets/);
	});
});

describe("relationsInPlan", () => {
	it("finds every relation in a nested plan, once each", () => {
		const plan = {
			"Node Type": "Hash Join",
			Plans: [
				{ "Node Type": "Seq Scan", "Relation Name": "tms_ontology__tms_views__v_order", Schema: "connection_raw" },
				{
					"Node Type": "Hash",
					Plans: [
						{ "Node Type": "Seq Scan", "Relation Name": "app_user", Schema: "platform" },
						{ "Node Type": "Seq Scan", "Relation Name": "tms_ontology__tms_views__v_order", Schema: "connection_raw" },
					],
				},
			],
		};
		expect(relationsInPlan(plan)).toEqual([
			"connection_raw.tms_ontology__tms_views__v_order",
			"platform.app_user",
		]);
	});
});
