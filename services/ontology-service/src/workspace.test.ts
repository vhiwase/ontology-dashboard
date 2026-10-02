/**
 * Tests for the pieces that turn a user's tables into an ontology and keep
 * one user's workspace away from another's: role inference, request parsing,
 * derived expressions, follow-ups, registration, space roles, connection host
 * vetting and the credential vault.
 *
 * All pure: nothing here touches the database.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

// auth.ts reads its signing secret when it is imported, so the secret has to
// exist before the imports below run.
vi.hoisted(() => {
	process.env.AUTH_JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
});
import { effectiveRole, personalSpaceRefusal, validateRegistration, type Principal, type SpaceAccess } from "./auth";
import { isLinkLocal, isLoopback, isPrivateAddress } from "./connectionPolicy";
import { assertDerivedName, compileExpression } from "./derived";
import { asksAboutPunctuality, detectIntent, parseQuestion, sliceName, tokens, widgetTitle } from "./feasibility";
import { defaultSlice } from "./modeling";
import { humanize, inferRoles, plural, singular, typeApiName, type ColumnInfo, type ColumnStats } from "./profiling";
import { derivedMetric, parseFollowUp } from "./proposals";
import type { KpiMeta } from "./registry";
import { __testing as vaultTesting, decrypt, encrypt, isVaultRef } from "./vault";

// ── profiling: what each column of a table is for ───────────────────────────

function column(name: string, dataType: string, stats: Partial<ColumnStats> = {}): ColumnInfo & ColumnStats {
	return {
		name,
		dataType,
		udtName: dataType,
		nonNull: 100,
		distinct: 100,
		min: null,
		max: null,
		...stats,
	} as ColumnInfo & ColumnStats;
}

describe("inferRoles", () => {
	const roles = (columns: Array<ColumnInfo & ColumnStats>, foreignKeys: string[] = [], primaryKey: string[] | null = ["id"]) =>
		Object.fromEntries(
			inferRoles(100, columns, { primaryKey, foreignKeyColumns: new Set(foreignKeys) }).map((p) => [p.name, p]),
		);

	it("keeps keys and declared references out of the sums", () => {
		const r = roles([column("id", "integer"), column("ship_via", "integer", { distinct: 3 })], ["ship_via"]);
		expect(r.id!.role).toBe("identity");
		expect(r.ship_via!.role).toBe("identity");
		expect(r.ship_via!.isForeignKey).toBe(true);
	});

	it("reads an un-declared integer reference as a number to add (why combinations pass identity columns)", () => {
		const r = roles([column("id", "integer"), column("ship_via", "integer", { distinct: 3 })]);
		expect(r.ship_via!.role).toBe("measure");
	});

	it("averages prices and rates, sums amounts, and formats money", () => {
		const r = roles([
			column("id", "integer"),
			column("unit_price", "numeric", { min: "1", max: "200" }),
			column("freight", "numeric", { min: "0", max: "900" }),
			column("discount_pct", "numeric", { min: "0", max: "25" }),
		]);
		expect(r.unit_price!.defaultAggregation).toBe("avg");
		expect(r.unit_price!.format).toBe("currency");
		expect(r.freight!.defaultAggregation).toBe("sum");
		expect(r.freight!.format).toBe("currency");
		expect(r.discount_pct!.format).toBe("percent");
	});

	it("groups by low-cardinality text, names rows by their title, and keeps contact details out", () => {
		const r = roles([
			column("id", "integer"),
			column("country", "text", { distinct: 21 }),
			column("company_name", "text", { distinct: 100, nonNull: 100 }),
			column("postal_code", "text", { distinct: 20 }),
			column("photo_path", "text", { distinct: 9 }),
			column("ship_address", "text", { distinct: 40 }),
			column("order_date", "date"),
		]);
		expect(r.country!.role).toBe("dimension");
		// The most name-like unique text names each row.
		expect(r.company_name!.role).toBe("title");
		expect(r.company_name!.isTitle).toBe(true);
		expect(r.postal_code!.role).toBe("attribute");
		expect(r.photo_path!.role).toBe("attribute");
		expect(r.ship_address!.role).toBe("attribute");
		expect(r.order_date!.role).toBe("temporal");
	});
});

describe("names", () => {
	it("derives type names and labels from tables", () => {
		expect(typeApiName("order_details")).toBe("OrderDetail");
		expect(typeApiName("categories")).toBe("Category");
		expect(singular("addresses")).toBe("address");
		expect(plural("category")).toBe("categories");
		expect(humanize("ship_country")).toBe("Ship Country");
	});
});

// ── feasibility: reading a request ──────────────────────────────────────────

describe("detectIntent", () => {
	it.each([
		["what can I build?", "capabilities"],
		["What charts, KPIs and dashboards can I build from my data?", "capabilities"],
		["which customers can you show by revenue", "chart"],
		["build me a sales dashboard", "dashboard"],
		["write a report on orders I can share", "report"],
		["link orders to customers", "link"],
		["combine orders with customer details", "combination"],
		["define a new metric for late orders", "metric"],
		["revenue by country", "chart"],
	])("%s -> %s", (text, intent) => {
		expect(detectIntent(text)).toBe(intent);
	});
});

describe("parseQuestion", () => {
	it("splits measure, dimension and grain", () => {
		expect(parseQuestion("total revenue by customer country")).toMatchObject({
			measure: "revenue",
			dimension: "customer country",
			aggregation: "sum",
		});
		expect(parseQuestion("average freight per month")).toMatchObject({ grain: "month", aggregation: "avg" });
	});

	it("reads a top-N ranking as the thing ranked by the measure", () => {
		expect(parseQuestion("top 10 customers by revenue")).toMatchObject({ measure: "revenue", dimension: "customers" });
	});

	it("groups business synonyms", () => {
		expect(tokens("sales")).toEqual(["revenue"]);
		expect(tokens("clients")).toEqual(["customer"]);
	});
});

describe("widgetTitle", () => {
	const kpi = { label: "Total Revenue", timeColumn: "order_date" } as KpiMeta;
	it("names timelines by grain and slices by dimension", () => {
		expect(widgetTitle(kpi, "order_date:month")).toBe("Total Revenue per month");
		expect(widgetTitle(kpi, "shipped_date:week")).toBe("Total Revenue per week (shipped date)");
		expect(widgetTitle(kpi, "customer_country")).toBe("Total Revenue by customer country");
		expect(widgetTitle(kpi, null)).toBe("Total Revenue");
	});
});

describe("sliceName", () => {
	const types = (phrase: string) => ["shipper", "employee", "customer", "category"].includes(phrase);
	it("lets a linked type's name stand for the type", () => {
		expect(sliceName("shipper_company_name", types)).toEqual({ text: "shipper", isType: true });
		expect(sliceName("employee_last_name", types)).toEqual({ text: "employee", isType: true });
		expect(sliceName("category_name", types)).toEqual({ text: "category", isType: true });
	});
	it("leaves other columns as they are", () => {
		expect(sliceName("ship_name", types)).toEqual({ text: "ship name", isType: false });
		expect(sliceName("customer_country", types)).toEqual({ text: "customer country", isType: false });
	});
});

// ── derived properties: arithmetic only ─────────────────────────────────────

describe("compileExpression", () => {
	const allowed = new Map([
		["unit_price", 'b."unit_price"'],
		["quantity", 'b."quantity"'],
		["discount", 'b."discount"'],
	]);

	it("compiles arithmetic over allowed numeric columns", () => {
		const { sql, columns } = compileExpression("unit_price * quantity * (1 - discount)", allowed);
		expect(sql).toContain('b."unit_price"');
		expect(sql).toContain('b."discount"');
		expect(columns.sort()).toEqual(["discount", "quantity", "unit_price"]);
	});

	it.each([
		"unit_price * secret_column",
		"pg_read_file('x')",
		"unit_price; drop table orders",
		"unit_price * quantity -- comment",
		"(select 1)",
	])("refuses %s", (source) => {
		expect(() => compileExpression(source, allowed)).toThrow();
	});

	it("allows only plain names for the new property", () => {
		expect(assertDerivedName("Revenue")).toBe("revenue");
		expect(() => assertDerivedName("x; drop")).toThrow();
		expect(() => assertDerivedName("1st")).toThrow();
	});
});

// ── proposals: what to build once approved ──────────────────────────────────

describe("parseFollowUp", () => {
	it("keeps a well-formed follow-up and trims what it carries", () => {
		expect(parseFollowUp({ build: "report", title: "  Sales report ", measure: "revenue", sourcePrompt: "q" })).toEqual({
			build: "report",
			title: "Sales report",
			measure: "revenue",
			sourcePrompt: "q",
		});
	});

	it.each([null, "x", [], { build: "pipeline", title: "t" }, { build: "dashboard" }, { build: "dashboard", title: "  " }])(
		"drops %j",
		(raw) => {
			expect(parseFollowUp(raw)).toBeNull();
		},
	);
});

// ── registration and roles ──────────────────────────────────────────────────

describe("validateRegistration", () => {
	it("accepts a sound form", () => {
		const { input, errors } = validateRegistration({ username: "Maria", password: "Correct-Horse-42!", email: "m@example.com" });
		expect(errors).toEqual([]);
		expect(input?.username).toBe("maria");
	});

	it("reports every problem at once", () => {
		const { input, errors } = validateRegistration({ username: "admin", password: "aaaa", email: "not-an-email" });
		expect(input).toBeNull();
		expect(errors.length).toBeGreaterThanOrEqual(4);
	});

	it("refuses a password containing the username", () => {
		expect(validateRegistration({ username: "maria", password: "maria-is-great-123" }).errors).toContain(
			"Password must not contain the username.",
		);
	});
});

describe("space roles", () => {
	const self: Principal = { userId: 9, username: "maria", role: "analyst", ontologyRole: "tms:AnalystRole", signupSource: "self" };
	const own: SpaceAccess = { slug: "u-maria", kind: "personal", isOwner: true, memberRole: null };
	const shared = (memberRole: SpaceAccess["memberRole"]): SpaceAccess => ({ slug: "sales", kind: "environment", isOwner: false, memberRole });

	it("makes an owner the admin of their own workspace only", () => {
		expect(effectiveRole(self, own)).toBe("admin");
		expect(effectiveRole(self, shared("editor"))).toBe("analyst");
		expect(effectiveRole(self, shared("viewer"))).toBe("viewer");
		expect(effectiveRole(self, shared(null))).toBe("viewer");
	});

	it("refuses platform-wide features in a personal workspace", () => {
		expect(personalSpaceRefusal("GET", "/spaces/database", self, own)).toMatch(/not available in a personal workspace/);
		expect(personalSpaceRefusal("POST", "/spaces/sandbox/seed", self, own)).not.toBeNull();
		expect(personalSpaceRefusal("POST", "/proposals", self, own)).toBeNull();
	});

	it("offers SQL functions in a personal workspace, read-scoped to its own tables (see sqlGuard)", () => {
		expect(personalSpaceRefusal("POST", "/functions", self, own)).toBeNull();
		expect(personalSpaceRefusal("PATCH", "/functions/revenue", self, own)).toBeNull();
		// The owner approves their own; in a shared space that stays an admin's.
		expect(effectiveRole(self, own)).toBe("admin");
		expect(effectiveRole(self, shared("editor"))).toBe("analyst");
	});
});

// ── connections: where a workspace may connect ──────────────────────────────

describe("address classes", () => {
	it.each([
		["169.254.169.254", true],
		["::ffff:169.254.169.254", true],
		["fe80::1", true],
		["10.0.0.5", false],
	])("link-local %s -> %s", (address, expected) => {
		expect(isLinkLocal(address)).toBe(expected);
	});

	it("knows loopback and private ranges", () => {
		expect(isLoopback("127.0.0.1")).toBe(true);
		expect(isLoopback("::1")).toBe(true);
		for (const address of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fd00::1"]) {
			expect(isPrivateAddress(address)).toBe(true);
		}
		for (const address of ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) {
			expect(isPrivateAddress(address)).toBe(false);
		}
	});
});

// ── the credential vault ────────────────────────────────────────────────────

describe("vault", () => {
	beforeAll(() => {
		process.env.CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
		vaultTesting.resetKey();
	});

	it("round-trips a secret and stores no plaintext", () => {
		const sealed = encrypt("s3cret-password");
		expect(sealed.ciphertext).not.toContain("s3cret");
		expect(decrypt(sealed)).toBe("s3cret-password");
	});

	it("refuses a tampered ciphertext", () => {
		const sealed = encrypt("s3cret-password");
		const flipped = Buffer.from(sealed.ciphertext, "base64");
		flipped[0] = flipped[0]! ^ 1;
		expect(() => decrypt({ ...sealed, ciphertext: flipped.toString("base64") })).toThrow(/integrity/);
	});

	it("refuses a secret sealed under another key", () => {
		const sealed = encrypt("s3cret-password");
		process.env.CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
		vaultTesting.resetKey();
		expect(() => decrypt(sealed)).toThrow(/different vault key/);
	});

	it("recognises its own references only", () => {
		expect(isVaultRef("vault:12")).toBe(true);
		expect(isVaultRef("env:DATABASE_URL")).toBe(false);
		expect(isVaultRef(null)).toBe(false);
	});
});

// ── derived dates: on time, days late ───────────────────────────────────────

describe("derived expressions over dates", () => {
	const numbers = new Map([["quantity", 'b."quantity"']]);
	const dates = new Map([
		["shipped_date", 'b."shipped_date"'],
		["required_date", 'b."required_date"'],
	]);

	it("compares two dates into a 0/1 flag that leaves missing dates out", () => {
		const { sql, columns } = compileExpression("(shipped_date <= required_date) * 100", numbers, dates);
		expect(sql).toContain(`WHEN (b."shipped_date")::date IS NULL OR (b."required_date")::date IS NULL THEN NULL`);
		expect(sql).toContain(`WHEN (b."shipped_date")::date <= (b."required_date")::date THEN 1 ELSE 0`);
		expect(columns.sort()).toEqual(["required_date", "shipped_date"]);
	});

	it("counts days between two dates", () => {
		const { sql } = compileExpression("days_between(required_date, shipped_date)", numbers, dates);
		expect(sql).toBe(`((b."shipped_date")::date - (b."required_date")::date)::numeric`);
	});

	it.each([
		["shipped_date", /must be a number/],
		["shipped_date - required_date", /days_between/],
		["shipped_date <= quantity", /two numbers or two dates/],
		["days_between(quantity, shipped_date)", /two dates/],
		["a < b < c", /two values at a time/],
	])("refuses %s", (source, message) => {
		expect(() => compileExpression(source, new Map([...numbers, ["a", "a"], ["b", "b"], ["c", "c"]]), dates)).toThrow(message);
	});

	it("still accepts plain arithmetic and != / ==", () => {
		expect(compileExpression("quantity * 2", numbers).sql).toBe(`(b."quantity" * 2::numeric)`);
		expect(compileExpression("quantity != 0", numbers).sql).toContain("<> 0::numeric");
		expect(compileExpression("quantity == 0", numbers).sql).toContain("= 0::numeric");
	});
});

describe("punctuality questions", () => {
	it.each(["on-time delivery rate", "orders shipped late", "average delay", "overdue invoices", "Late orders", "On-time rate"])(
		"reads %s as being about punctuality",
		(phrase) => expect(asksAboutPunctuality(phrase)).toBe(true),
	);
	it.each(["latest orders", "revenue by month", "translated titles", "plate count"])("does not read %s that way", (phrase) =>
		expect(asksAboutPunctuality(phrase)).toBe(false),
	);
});

describe("derivedMetric", () => {
	it("is optional", () => {
		expect(derivedMetric(undefined)).toBeNull();
		expect(derivedMetric(null)).toBeNull();
	});
	it("names the figure a derived column is made for", () => {
		expect(derivedMetric({ aggregation: "AVG", label: "On-time rate", format: "percent" })).toEqual({
			aggregation: "avg",
			label: "On-time rate",
			format: "percent",
		});
		expect(derivedMetric({ aggregation: "sum", label: "Late orders" })).toEqual({ aggregation: "sum", label: "Late orders" });
	});
	it.each([
		[{ aggregation: "count", label: "x" }, /sum|avg/],
		[{ aggregation: "sum" }, /label is required/],
		[{ aggregation: "sum", label: "x".repeat(61) }, /at most 60/],
		[{ aggregation: "avg", label: "x", format: "stars" }, /format must be/],
	])("refuses %j", (raw, message) => expect(() => derivedMetric(raw)).toThrow(message));
});

describe("defaultSlice", () => {
	it("slices a type with no dates by where or what kind first", () => {
		expect(defaultSlice(["contact_title", "city", "region", "country"])).toBe("country");
		expect(defaultSlice(["contact_title", "category_name"])).toBe("category_name");
	});
	it("never starts with a contact's details when anything else exists", () => {
		expect(defaultSlice(["contact_title", "title_of_courtesy", "city"])).toBe("city");
		expect(defaultSlice(["contact_title"])).toBe("contact_title");
		expect(defaultSlice(["order_date:month"])).toBeNull();
	});
});
