/**
 * Tests for what a repository file declares.
 *
 * Parsing is where a build decides what a file MEANS — which connection to
 * pull through, which table to write, what to call a function — so a file that
 * says something ambiguous has to be refused rather than guessed at. These are
 * the rules a build enforces before it touches the database.
 */

import { describe, expect, it } from "vitest";
import {
	assertRepoPath,
	languageForPath,
	parseFunctionFile,
	parseHeader,
	parseSyncFile,
	parseTransform,
} from "./repos";

describe("assertRepoPath", () => {
	it("accepts an ordinary relative path", () => {
		expect(assertRepoPath("functions/avg_weight.sql")).toBe("functions/avg_weight.sql");
	});

	it("normalises a Windows separator", () => {
		expect(assertRepoPath("functions\\avg.sql")).toBe("functions/avg.sql");
	});

	it("refuses traversal and absolute paths", () => {
		// Nothing here touches a filesystem today. The check is in place for the
		// day something does.
		expect(() => assertRepoPath("../../etc/passwd")).toThrow(/not a valid path/);
		expect(() => assertRepoPath("/etc/passwd")).toThrow(/relative/);
		expect(() => assertRepoPath("a/./b.sql")).toThrow(/not a valid path/);
	});

	it("refuses characters a path has no business holding", () => {
		expect(() => assertRepoPath("functions/a b.sql")).toThrow(/letters, digits/);
		expect(() => assertRepoPath("functions/a;b.sql")).toThrow(/letters, digits/);
	});
});

describe("languageForPath", () => {
	it("maps the extensions a repository understands", () => {
		expect(languageForPath("a.sql")).toBe("sql");
		expect(languageForPath("a.py")).toBe("python");
		expect(languageForPath("a.ts")).toBe("typescript");
		expect(languageForPath("a.json")).toBe("json");
		expect(languageForPath("README.md")).toBe("markdown");
	});

	it("refuses anything else rather than guessing", () => {
		expect(() => languageForPath("a.exe")).toThrow(/no extension this repository understands/);
	});
});

describe("parseHeader", () => {
	it("reads key: value lines in any of the three comment styles", () => {
		expect(parseHeader("-- name: A\nSELECT 1").header).toEqual({ name: "A" });
		expect(parseHeader("# name: A\nprint(1)").header).toEqual({ name: "A" });
		expect(parseHeader("// name: A\nexport {}").header).toEqual({ name: "A" });
	});

	it("reads the @form without a colon", () => {
		expect(parseHeader("-- @output repo_out.t\nSELECT 1").header).toEqual({
			output: "repo_out.t",
		});
	});

	it("does not read prose as a declaration", () => {
		// Without the colon rule, "-- Orders grouped by lane" would become
		// { orders: "grouped by lane" } and quietly shadow a real key.
		const { header } = parseHeader("-- Orders grouped by lane\n-- name: A\nSELECT 1");
		expect(header).toEqual({ name: "A" });
	});

	it("keeps the first declaration when a word repeats", () => {
		const { header } = parseHeader("-- name: First\n-- name: Second\nSELECT 1");
		expect(header.name).toBe("First");
	});

	it("ends the header at the first line that is not a comment", () => {
		const { body } = parseHeader("-- name: A\n\nSELECT 1\n-- a trailing comment");
		expect(body).toBe("SELECT 1\n-- a trailing comment");
	});
});

describe("parseTransform", () => {
	it("reads the output and the statement under it", () => {
		const parsed = parseTransform("-- @output repo_out.lanes\nSELECT 1 AS a", "transforms/a.sql");
		expect(parsed).toEqual({ output: "repo_out.lanes", outputTable: "lanes", sql: "SELECT 1 AS a" });
	});

	it("refuses a transform that does not say where it writes", () => {
		expect(() => parseTransform("SELECT 1", "transforms/a.sql")).toThrow(/does not say where it writes/);
	});

	it("refuses to write outside repo_out", () => {
		// The view layer is the contract the ontology is generated from. A build
		// that could replace a view could silently change every object type.
		expect(() => parseTransform("-- @output tms_views.v_order\nSELECT 1", "transforms/a.sql")).toThrow(
			/may only write into repo_out/,
		);
		expect(() => parseTransform("-- @output public.t\nSELECT 1", "transforms/a.sql")).toThrow(
			/may only write into repo_out/,
		);
	});

	it("refuses an output that is not a plain table name", () => {
		expect(() =>
			parseTransform('-- @output repo_out."t"; DROP TABLE x\nSELECT 1', "transforms/a.sql"),
		).toThrow(/not a schema-qualified table name|not a plain lower-case identifier/);
	});

	it("refuses a header with nothing under it", () => {
		expect(() => parseTransform("-- @output repo_out.t\n", "transforms/a.sql")).toThrow(
			/no SELECT under it/,
		);
	});
});

describe("parseFunctionFile", () => {
	const sql = [
		"-- name: Average Weight Per Piece",
		"-- description: Mean weight of one piece.",
		"-- businessQuestion: How heavy is a piece?",
		"-- returns: scalar",
		"-- unit: kg",
		"SELECT 1",
	].join("\n");

	it("reads the header and the definition", () => {
		expect(parseFunctionFile(sql, "functions/avg.sql")).toEqual({
			name: "Average Weight Per Piece",
			description: "Mean weight of one piece.",
			businessQuestion: "How heavy is a piece?",
			returns: "scalar",
			returnType: null,
			unit: "kg",
			valueFormat: "number",
			language: "sql",
			definition: "SELECT 1",
		});
	});

	it("defaults the return shape to a scalar", () => {
		expect(parseFunctionFile("-- name: A\nSELECT 1", "functions/a.sql").returns).toBe("scalar");
	});

	it("refuses a file with no name", () => {
		// The name is what the api name and rid are derived from, and those are
		// frozen once created, so a file cannot be allowed to omit it.
		expect(() => parseFunctionFile("SELECT 1", "functions/a.sql")).toThrow(/has no name/);
	});

	it("refuses a return shape it does not have", () => {
		expect(() => parseFunctionFile("-- name: A\n-- returns: graph\nSELECT 1", "functions/a.sql")).toThrow(
			/not a return shape/,
		);
	});

	it("carries the language, including the ones that will not execute here", () => {
		expect(parseFunctionFile("# name: A\nreturn 1", "functions/a.py").language).toBe("python");
		expect(parseFunctionFile("// name: A\nreturn 1", "functions/a.ts").language).toBe("typescript");
	});

	it("refuses a markdown file as a function", () => {
		expect(() => parseFunctionFile("-- name: A\nx", "functions/a.md")).toThrow(
			/not a function definition/,
		);
	});
});

describe("parseSyncFile", () => {
	it("reads a declared sync", () => {
		const parsed = parseSyncFile(
			JSON.stringify({
				connection: "tms_ontology",
				name: "orders",
				source: { schema: "tms_views", table: "v_order" },
				mode: "snapshot",
				rowLimit: 100,
			}),
			"syncs/orders.sync.json",
		);
		expect(parsed).toMatchObject({
			connection: "tms_ontology",
			name: "orders",
			sourceSchema: "tms_views",
			sourceTable: "v_order",
			mode: "snapshot",
			rowLimit: 100,
		});
	});

	it("names the file when the JSON is bad", () => {
		expect(() => parseSyncFile("{not json", "syncs/a.sync.json")).toThrow(
			/syncs\/a.sync.json is not valid JSON/,
		);
	});

	it("refuses a sync that does not name a connection", () => {
		expect(() => parseSyncFile(JSON.stringify({ name: "orders" }), "syncs/a.sync.json")).toThrow(
			/does not name a connection/,
		);
	});
});
