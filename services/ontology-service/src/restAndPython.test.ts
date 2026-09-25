/**
 * Tests for the REST connector and the Python transform contract.
 *
 * Both take data from outside and turn it into a table, so both have the same
 * two risks: something from outside becoming SQL syntax, and something from
 * outside being silently misread. The cases below are the ones where a wrong
 * answer would look like a right one — a records path that misses, a JSON key
 * that is not an identifier, a transform that declares an output and never
 * writes it.
 */

import { describe, expect, it } from "vitest";
import {
	assertRecordsPath,
	assertRestPath,
	displayDsn,
	extractRecords,
	joinUrl,
	shapeRestRecords,
	specFromProperties,
	validateSyncRequest,
} from "./connections";
import { columnsOfRows, columnTypeFor, normaliseColumnName } from "./inferTypes";
import { assertWritableOutput, TransformFailed } from "./pythonTransforms";

describe("joinUrl", () => {
	it("joins without doubling or dropping the separator", () => {
		expect(joinUrl("https://api.example.com/v1", "/orders")).toBe("https://api.example.com/v1/orders");
		expect(joinUrl("https://api.example.com/v1/", "orders")).toBe("https://api.example.com/v1/orders");
		expect(joinUrl("https://api.example.com", "")).toBe("https://api.example.com");
	});
});

describe("assertRestPath", () => {
	it("accepts a path, with a query string", () => {
		expect(assertRestPath("/orders")).toBe("/orders");
		expect(assertRestPath("orders?status=open")).toBe("orders?status=open");
	});

	it("refuses a whole URL", () => {
		// Otherwise a sync could quietly point somewhere other than the source
		// that was registered and tested.
		expect(() => assertRestPath("https://elsewhere.example.com/orders")).toThrow(/whole URL/);
	});

	it("refuses traversal out of the base URL", () => {
		expect(() => assertRestPath("/v1/../../admin")).toThrow(/walks out/);
	});

	it("refuses spaces rather than guessing an encoding", () => {
		expect(() => assertRestPath("/order list")).toThrow(/cannot contain spaces/);
	});
});

describe("assertRecordsPath", () => {
	it("accepts dotted field names, and nothing", () => {
		expect(assertRecordsPath("data.items")).toBe("data.items");
		expect(assertRecordsPath("")).toBeNull();
		expect(assertRecordsPath(null)).toBeNull();
	});

	it("refuses indexes and wildcards", () => {
		expect(() => assertRecordsPath("data[0].items")).toThrow(/not a records path/);
		expect(() => assertRecordsPath("data.*")).toThrow(/not a records path/);
	});
});

describe("extractRecords", () => {
	it("takes a bare array as the records", () => {
		expect(extractRecords([{ a: 1 }, { a: 2 }], null)).toHaveLength(2);
	});

	it("walks a declared path", () => {
		const payload = { data: { items: [{ a: 1 }] }, meta: { total: 1 } };
		expect(extractRecords(payload, "data.items")).toEqual([{ a: 1 }]);
	});

	it("says what it actually found when the path misses", () => {
		expect(() => extractRecords({ data: {} }, "data.items")).toThrow(/'items' is not in it/);
		expect(() => extractRecords(42, null)).toThrow(/Set the records path/);
	});

	it("takes a single object as a single row", () => {
		expect(extractRecords({ status: "ok" }, null)).toEqual([{ status: "ok" }]);
	});

	it("refuses an envelope without a path, and says where the records look to be", () => {
		// The failure this prevents: landing one row that contains the whole
		// document, and calling it a successful sync.
		expect(() => extractRecords({ data: { items: [{ a: 1 }] }, total: 1 }, null)).toThrow(
			/'data.items'/,
		);
		expect(() => extractRecords({ items: [{ a: 1 }] }, null)).toThrow(/'items'/);
	});

	it("refuses an array of scalars", () => {
		expect(() => extractRecords([1, 2, 3], null)).toThrow(/not objects/);
	});
});

describe("normaliseColumnName", () => {
	it("turns a JSON key into a column name", () => {
		expect(normaliseColumnName("orderNumber", 0)).toBe("order_number");
		expect(normaliseColumnName("Gross Weight (kg)", 0)).toBe("gross_weight_kg");
		expect(normaliseColumnName("already_fine", 0)).toBe("already_fine");
	});

	it("still produces something addressable from a hostile key", () => {
		expect(normaliseColumnName("2024", 0)).toBe("f_2024");
		expect(normaliseColumnName("***", 3)).toBe("field_4");
		expect(normaliseColumnName('a"; DROP TABLE x; --', 0)).toBe("a_drop_table_x");
	});
});

describe("shapeRestRecords", () => {
	it("renames keys to column names and says which", () => {
		const { rows, renamed } = shapeRestRecords([{ orderNumber: "A1", lane: "X" }]);
		expect(rows).toEqual([{ order_number: "A1", lane: "X" }]);
		expect(renamed).toEqual([{ from: "orderNumber", to: "order_number" }]);
	});

	it("keeps both fields when two keys normalise the same way", () => {
		// Dropping one silently is the worse outcome: the sync would report a
		// clean run with a field missing.
		const { rows } = shapeRestRecords([{ orderNumber: 1, "order number": 2 }]);
		expect(Object.keys(rows[0]!)).toEqual(["order_number", "order_number_2"]);
	});

	it("carries a nested value through as JSON text rather than losing it", () => {
		const { rows } = shapeRestRecords([{ stops: [{ city: "Troy" }] }]);
		expect(rows[0]!.stops).toBe('[{"city":"Troy"}]');
	});

	it("unions the fields across records", () => {
		// A REST payload routinely omits a null field, and taking the first
		// record as the schema would drop a column every later record has.
		const { rows } = shapeRestRecords([{ a: 1 }, { a: 2, b: 3 }]);
		expect(columnsOfRows(rows).map((c) => c.name)).toEqual(["a", "b"]);
	});
});

describe("columnTypeFor", () => {
	it("narrows only when every value fits", () => {
		expect(columnTypeFor([1, 2, 3])).toBe("bigint");
		expect(columnTypeFor([1, 2.5])).toBe("numeric");
		expect(columnTypeFor([true, false])).toBe("boolean");
		expect(columnTypeFor([{ a: 1 }])).toBe("jsonb");
	});

	it("widens to text on the first value that does not", () => {
		expect(columnTypeFor([1, 2, "n/a"])).toBe("text");
		expect(columnTypeFor([true, 1])).toBe("text");
	});

	it("keeps decimals that crossed as strings numeric", () => {
		// They cross as strings so 1200212.47 does not come back as
		// 1200212.469999999.
		expect(columnTypeFor(["1200212.47", "3.00"])).toBe("numeric");
	});

	it("gives an all-null column text, because nothing was learned", () => {
		expect(columnTypeFor([null, null])).toBe("text");
		expect(columnTypeFor([])).toBe("text");
	});
});

describe("assertWritableOutput", () => {
	it("accepts a repo_out table", () => {
		expect(assertWritableOutput("repo_out.lanes", "transforms/a.py")).toEqual({
			relation: "repo_out.lanes",
			table: "lanes",
		});
	});

	it("fails a transform that declares no Output, and says what to add", () => {
		// The rule that makes a python repository coherent: a build that goes
		// green without producing a dataset is the outcome this prevents.
		expect(() => assertWritableOutput(null, "transforms/a.py")).toThrow(TransformFailed);
		expect(() => assertWritableOutput(null, "transforms/a.py")).toThrow(
			/declares no Output.*@transform\(output=Output/s,
		);
	});

	it("refuses to write outside repo_out", () => {
		expect(() => assertWritableOutput("tms_views.v_order", "transforms/a.py")).toThrow(
			/may only write into repo_out/,
		);
	});

	it("refuses an output that is not a plain table name", () => {
		expect(() => assertWritableOutput('repo_out."x"; DROP TABLE y', "transforms/a.py")).toThrow(
			/not a plain lower-case identifier/,
		);
	});
});

describe("REST connections", () => {
	it("never shows a credential", () => {
		const dsn = displayDsn({
			name: "tms",
			engine: "rest",
			baseUrl: "https://api.example.com/v1",
			authScheme: "bearer",
			secretRef: "TMS_TOKEN",
		});
		expect(dsn).toBe("https://api.example.com/v1 (bearer)");
		expect(dsn).not.toContain("TMS_TOKEN");
	});

	it("reads a stored REST connection back", () => {
		const spec = specFromProperties("tms", {
			engine: "rest",
			baseUrl: "https://api.example.com/v1",
			authScheme: "header",
			headerName: "X-API-Key",
			secretRef: "TMS_KEY",
		});
		expect(spec).toMatchObject({ engine: "rest", authScheme: "header", headerName: "X-API-Key" });
	});

	it("names a REST sync's landing table after its path", () => {
		const valid = validateSyncRequest({ name: "orders", sourcePath: "/v1/orders" }, "rest");
		expect(valid).toMatchObject({
			sourceSchema: "rest",
			sourceTable: "v1_orders",
			sourcePath: "/v1/orders",
		});
	});

	it("still needs a cursor for an incremental REST sync", () => {
		expect(() =>
			validateSyncRequest({ name: "orders", sourcePath: "/orders", mode: "incremental" }, "rest"),
		).toThrow(/cursor field/);
	});
});
