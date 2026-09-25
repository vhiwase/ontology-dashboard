/**
 * Tests for the parts of a connection that can be judged without a network.
 *
 * The three that matter are all about something reaching SQL as syntax rather
 * than as a parameter: the landing table's name, the type a remote column
 * lands as, and the identifiers a sync declares. Each is a place where taking
 * the caller's word for it would be an injection, so each is checked here.
 */

import { describe, expect, it } from "vitest";
import {
	displayDsn,
	localTypeFor,
	specFromProperties,
	syncTargetTableName,
	validateSyncRequest,
} from "./connections";

describe("syncTargetTableName", () => {
	it("says where the rows came from", () => {
		expect(syncTargetTableName("TMS Postgres", "tms_views", "v_order")).toBe(
			"tms_postgres__tms_views__v_order",
		);
	});

	it("reduces anything that is not a letter or a digit", () => {
		expect(syncTargetTableName("Warehouse (EU-West)", "public", "orders")).toBe(
			"warehouse_eu_west__public__orders",
		);
	});

	it("refuses a name with nothing usable left in it", () => {
		expect(() => syncTargetTableName("***", "public", "orders")).toThrow(/letter or a digit/);
	});

	it("stays inside PostgreSQL's 63-character identifier limit", () => {
		const name = syncTargetTableName("a".repeat(40), "b".repeat(40), "c".repeat(40));
		expect(name.length).toBeLessThanOrEqual(63);
		// Truncated from the left, so the table name — the part that
		// distinguishes two syncs of the same shape — survives.
		expect(name.endsWith("c".repeat(40))).toBe(true);
	});
});

describe("localTypeFor", () => {
	it("keeps a type that has a local equivalent", () => {
		expect(localTypeFor("int4")).toEqual({ type: "integer", widened: false });
		expect(localTypeFor("timestamptz")).toEqual({ type: "timestamptz", widened: false });
		expect(localTypeFor("uuid")).toEqual({ type: "uuid", widened: false });
		expect(localTypeFor("text")).toEqual({ type: "text", widened: false });
	});

	it("widens a type it does not know, and says so", () => {
		// An enum, a domain or PostGIS geometry. The driver hands these back as
		// strings, so text holds them exactly as they arrive — but the caller
		// has to be told, or a number arriving as text looks like a bug.
		expect(localTypeFor("order_status_enum")).toEqual({ type: "text", widened: true });
		expect(localTypeFor("geometry")).toEqual({ type: "text", widened: true });
	});

	it("maps an array to an array of the mapped element type", () => {
		expect(localTypeFor("_int4")).toEqual({ type: "integer[]", widened: false });
		expect(localTypeFor("_mystery")).toEqual({ type: "text[]", widened: true });
	});

	it("never returns anything that could carry SQL", () => {
		// The point of the fixed table: whatever the far side calls a type, what
		// comes back here is one of ours.
		const hostile = localTypeFor("text); DROP TABLE orders; --");
		expect(hostile.type).toBe("text");
	});
});

describe("validateSyncRequest", () => {
	const base = { name: "orders", sourceSchema: "public", sourceTable: "orders" };

	it("accepts a plain snapshot", () => {
		expect(validateSyncRequest(base)).toEqual({
			name: "orders",
			description: null,
			sourceSchema: "public",
			sourceTable: "orders",
			// Null for a PostgreSQL sync: they are the REST connector's fields.
			sourcePath: null,
			recordsPath: null,
			mode: "snapshot",
			cursorColumn: null,
			rowLimit: 50_000,
		});
	});

	it("refuses a schema or table that is not a plain identifier", () => {
		expect(() => validateSyncRequest({ ...base, sourceTable: 'orders"; DROP TABLE x; --' })).toThrow(
			/not a plain identifier/,
		);
		expect(() => validateSyncRequest({ ...base, sourceSchema: "pg catalog" })).toThrow(
			/not a plain identifier/,
		);
	});

	it("refuses an incremental sync with no cursor", () => {
		// Without one every run re-reads the whole table and appends it, which
		// doubles the dataset rather than failing.
		expect(() => validateSyncRequest({ ...base, mode: "incremental" })).toThrow(/cursor column/);
	});

	it("checks the cursor column is an identifier too", () => {
		expect(() =>
			validateSyncRequest({ ...base, mode: "incremental", cursorColumn: "updated_at; --" }),
		).toThrow(/not a plain identifier/);
	});

	it("bounds the reader", () => {
		expect(() => validateSyncRequest({ ...base, rowLimit: 0 })).toThrow(/between 1 and/);
		expect(() => validateSyncRequest({ ...base, rowLimit: 5_000_000 })).toThrow(/between 1 and/);
		expect(validateSyncRequest({ ...base, rowLimit: 100 }).rowLimit).toBe(100);
	});

	it("needs a name", () => {
		expect(() => validateSyncRequest({ ...base, name: "  " })).toThrow(/needs a name/);
	});
});

describe("displayDsn", () => {
	it("never carries a password", () => {
		const dsn = displayDsn({
			name: "source",
			engine: "postgresql",
			host: "db.internal",
			port: 5432,
			database: "warehouse",
			username: "reader",
			secretRef: "/run/secrets/postgres_password",
		});
		expect(dsn).toBe("postgresql://reader:***@db.internal:5432/warehouse");
		expect(dsn).not.toContain("secrets");
	});
});

describe("specFromProperties", () => {
	it("returns null for the platform's own database, which has no host to dial", () => {
		expect(specFromProperties("tms_ontology", { engine: "PostgreSQL" })).toBeNull();
	});

	it("reads back what was stored, defaulting the port", () => {
		const spec = specFromProperties("source", {
			host: "db.internal",
			database: "warehouse",
			username: "reader",
			secretRef: "PGPASSWORD",
		});
		expect(spec).toMatchObject({
			host: "db.internal",
			port: 5432,
			database: "warehouse",
			username: "reader",
			secretRef: "PGPASSWORD",
			sslMode: "prefer",
		});
	});
});
