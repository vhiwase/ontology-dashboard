/**
 * The shape check and the plan walk behind every function definition. The
 * reach check itself needs a planner, so it is exercised against the live
 * database; what is pinned here is that the text checks refuse what they must
 * and that a plan's every relation is found, however deeply nested.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ pool: {}, query: vi.fn(async () => []), queryOne: vi.fn(async () => null) }));

import { assertSingleSelect, relationsInPlan } from "./sqlGuard";

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
