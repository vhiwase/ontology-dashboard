/**
 * Feasibility decisions against a small orders model: what is ready, what
 * needs an approval first, and what the data cannot answer.
 *
 * The registry is a fixture and the database is mocked: a category value
 * lookup ("orders in Germany") finds Germany, and every slice has a handful
 * of values.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KpiMeta, LinkTypeMeta, ObjectTypeMeta, PropertyMeta, Registry } from "./registry";

vi.hoisted(() => {
	process.env.AUTH_JWT_SECRET ??= "test-secret-test-secret-test-secret-0123";
});

function prop(sqlColumn: string, semanticRole: string, extra: Partial<PropertyMeta> = {}): PropertyMeta {
	const numeric = ["measure", "identity"].includes(semanticRole);
	return {
		rid: `prop:${sqlColumn}`,
		apiName: sqlColumn.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
		label: sqlColumn.replace(/_/g, " "),
		description: null,
		datatype: semanticRole === "temporal" ? "date" : numeric ? "decimal" : "string",
		sqlColumn,
		sqlType: semanticRole === "temporal" ? "date" : numeric ? "numeric" : "text",
		isIdentity: semanticRole === "identity",
		isTitle: false,
		isNullable: true,
		isForeignKey: false,
		semanticRole,
		defaultAggregation: semanticRole === "measure" ? "sum" : null,
		unit: null,
		displayOrder: 0,
		...extra,
	};
}

function type(apiName: string, label: string, pluralLabel: string, properties: PropertyMeta[], extra: Partial<ObjectTypeMeta> = {}): ObjectTypeMeta {
	properties.forEach((p, index) => (p.displayOrder = index));
	return {
		rid: `type:${apiName}`,
		apiName,
		label,
		pluralLabel,
		description: null,
		kind: "entity",
		sourceView: `ws.${apiName.toLowerCase()}`,
		primaryKeyColumn: properties[0]!.sqlColumn,
		titleColumn: properties.find((p) => p.isTitle)?.sqlColumn ?? null,
		icon: null,
		color: null,
		group: null,
		rowCount: 100,
		displayOrder: 0,
		origin: "modelled",
		keyIsUnique: true,
		properties,
		propertyByApiName: new Map(properties.map((p) => [p.apiName, p])),
		propertyBySqlColumn: new Map(properties.map((p) => [p.sqlColumn, p])),
		...extra,
	};
}

function kpi(apiName: string, label: string, on: ObjectTypeMeta, aggregation: string, measureColumn: string | null, extra: Partial<KpiMeta> = {}): KpiMeta {
	const timeColumn = on.properties.find((p) => p.semanticRole === "temporal")?.sqlColumn ?? null;
	const categorical = on.properties.filter((p) => p.semanticRole === "dimension").map((p) => p.sqlColumn);
	const grains = on.properties
		.filter((p) => p.semanticRole === "temporal")
		.flatMap((p) => ["day", "week", "month", "quarter", "year"].map((g) => `${p.sqlColumn}:${g}`));
	return {
		rid: `kpi:${apiName}`,
		apiName,
		label,
		description: null,
		businessQuestion: null,
		category: on.label,
		sourceView: on.sourceView,
		measureColumn,
		aggregation,
		numeratorColumn: null,
		denominatorColumn: null,
		dimensions: [...categorical, ...grains],
		defaultDimension: timeColumn ? `${timeColumn}:month` : (categorical[0] ?? null),
		timeColumn,
		unit: null,
		valueFormat: "number",
		higherIsBetter: null,
		targetValue: null,
		warningThreshold: null,
		criticalThreshold: null,
		relatedObjectTypes: [on.rid],
		dependsOnSimulation: false,
		coverageNote: null,
		displayOrder: 0,
		conditions: {},
		origin: "modelled",
		objectTypeRid: on.rid,
		...extra,
	};
}

function link(apiName: string, from: ObjectTypeMeta, to: ObjectTypeMeta, sourceColumn: string): LinkTypeMeta {
	return {
		rid: `link:${apiName}`,
		apiName,
		label: apiName,
		description: null,
		sourceObjectType: from.rid,
		targetObjectType: to.rid,
		sourceColumn,
		targetColumn: to.primaryKeyColumn,
		cardinality: "MANY_TO_ONE",
		inverseApiName: null,
		inverseLabel: null,
		discoveryMethod: "foreign_key",
		matchRatio: 1,
		matchedRows: 100,
		candidateRows: 100,
		isVerified: true,
	} as LinkTypeMeta;
}

// ── the model: orders, customers, shippers, products ────────────────────────

const customer = type("Customer", "Customer", "Customers", [
	prop("customer_id", "identity"),
	prop("company_name", "title", { isTitle: true }),
	prop("contact_title", "dimension"),
	prop("country", "dimension"),
]);
const shipper = type("Shipper", "Shipper", "Shippers", [prop("shipper_id", "identity"), prop("company_name", "title", { isTitle: true })]);
const order = type("Order", "Order", "Orders", [
	prop("order_id", "identity"),
	prop("customer_id", "identity"),
	prop("ship_via", "identity"),
	prop("order_date", "temporal"),
	prop("required_date", "temporal"),
	prop("shipped_date", "temporal"),
	prop("freight", "measure"),
	prop("ship_country", "dimension"),
]);
const product = type("Product", "Product", "Products", [
	prop("product_id", "identity"),
	prop("product_name", "title", { isTitle: true }),
	prop("units_in_stock", "measure"),
	prop("units_on_order", "measure"),
]);
// What approving the timing proposal creates.
const timing = type(
	"OrderTiming",
	"Order Timing",
	"Order Timings",
	[
		...order.properties.map((p) => ({ ...p })),
		prop("on_time_pct", "measure", { defaultAggregation: "avg" }),
		prop("is_late", "measure"),
		prop("days_late", "measure", { defaultAggregation: "avg" }),
	],
	{ origin: "combination" },
);

const baseKpis = [
	kpi("order_count", "Orders", order, "count", null),
	kpi("order_freight_sum", "Total Freight", order, "sum", "freight"),
	kpi("order_distinct_customer_id", "Distinct customers", order, "count_distinct", "customer_id"),
	kpi("customer_count", "Customers", customer, "count", null),
	kpi("product_count", "Products", product, "count", null),
	kpi("product_units_on_order_sum", "Total Units On Order", product, "sum", "units_on_order"),
];

let registry: Registry;

function install(types: ObjectTypeMeta[], kpis: KpiMeta[]): void {
	const links = [link("orderCustomer", order, customer, "customer_id"), link("orderShipVia", order, shipper, "ship_via")];
	const bySource = new Map<string, LinkTypeMeta[]>();
	for (const l of links) bySource.set(l.sourceObjectType, [...(bySource.get(l.sourceObjectType) ?? []), l]);
	registry = {
		objectTypes: types,
		objectTypeByApiName: new Map(types.map((t) => [t.apiName, t])),
		objectTypeByRid: new Map(types.map((t) => [t.rid, t])),
		linkTypes: links,
		linkTypeByApiName: new Map(links.map((l) => [l.apiName, l])),
		linksBySourceRid: bySource,
		linksByTargetRid: new Map(),
		actionTypes: [],
		actionTypeByApiName: new Map(),
		kpis,
		kpiByApiName: new Map(kpis.map((k) => [k.apiName, k])),
	} as unknown as Registry;
}

// The category values each view holds, for questions that name one.
const VIEW_VALUES: Record<string, Record<string, string[]>> = {
	"ws.order": { ship_country: ["Germany", "France", "Brazil"] },
	"ws.customer": { country: ["Germany", "Brazil", "Mexico"], company_name: ["Alfreds Futterkiste"], contact_title: ["Owner"] },
	"ws.shipper": { company_name: ["Speedy Express"] },
	"ws.ordertiming": {
		ship_country: ["Germany", "France", "Brazil"],
		customer_country: ["Germany", "Brazil", "Mexico"],
		shipper_company_name: ["Speedy Express"],
	},
};

vi.mock("./db", () => ({
	query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/information_schema\.columns/.test(sql)) {
			const view = `${params[0]}.${params[1]}`;
			return Object.keys(VIEW_VALUES[view] ?? {}).map((column_name) => ({ column_name, data_type: "text" }));
		}
		if (/SELECT DISTINCT/.test(sql)) {
			const view = /FROM "?([\w]+)"?\."?([\w]+)"?/.exec(sql);
			const column = /SELECT DISTINCT "?(\w+)"?::text/.exec(sql)?.[1] ?? "";
			const values = view ? VIEW_VALUES[`${view[1]}.${view[2]}`]?.[column] ?? [] : [];
			return values.map((v) => ({ v }));
		}
		if (/bool_or/.test(sql)) {
			const view = /FROM "?([\w]+)"?\."?([\w]+)"?/.exec(sql);
			const columns = view ? VIEW_VALUES[`${view[1]}.${view[2]}`] ?? {} : {};
			const row: Record<string, boolean> = {};
			Object.values(columns).forEach((values, i) => (row[`c${i}`] = values.includes(String(params[0]))));
			return [row];
		}
		if (/count\(DISTINCT/.test(sql)) return [{ n: "5" }];
		// A category lookup: Germany is a country the orders were shipped to.
		const values = (params[0] as string[] | undefined) ?? [];
		return values.includes("germany") ? [{ "?column?": 1 }] : [];
	}),
	queryOne: vi.fn(async () => null),
	pool: { connect: vi.fn() },
}));

vi.mock("./registry", async () => {
	const actual = await vi.importActual<typeof import("./registry")>("./registry");
	return { ...actual, getRegistry: () => registry, currentSpace: () => "u-test" };
});

import { assess, planBoard, valueMentions, withoutMentions } from "./feasibility";

const first = async (text: string) => (await assess({ text })).items[0]!;

beforeEach(() => install([order, customer, shipper, product], [...baseKpis]));

describe("counting things", () => {
	it("reads a total of a type as how many there are", async () => {
		const item = await first("total orders");
		expect(item.status).toBe("ready");
		expect(item.kpi).toBe("order_count");
	});

	it("counts unique customers where they appear, with a timeline", async () => {
		const item = await first("unique customers per month");
		expect(item.status).toBe("ready");
		expect(item.kpi).toBe("order_distinct_customer_id");
		expect(item.widget?.dimension).toBe("order_date:month");
	});

	it("keeps a value the data holds as part of the question", async () => {
		expect((await first("orders in germany")).status).toBe("ready");
	});

	it.each([
		["customer satisfaction score by month", "satisfaction score"],
		["active customers", "active"],
		["customer lifetime value", "lifetime value"],
	])("does not answer %s with a count", async (text, missing) => {
		const item = await first(text);
		expect(item.status).toBe("not_possible");
		expect(item.missing?.[0]).toContain(missing);
		expect(item.explanation).toContain("can be counted");
	});
});

describe("values named in a question", () => {
	const enrichedTiming = () =>
		type(
			"OrderTiming",
			"Order Timing",
			"Order Timings",
			[
				...order.properties.map((p) => ({ ...p })),
				prop("customer_country", "dimension"),
				prop("shipper_company_name", "dimension"),
			],
			{ origin: "combination" },
		);

	it("narrows a figure to the value instead of answering for everything", async () => {
		const item = await first("total freight in Germany");
		expect(item.status).toBe("ready");
		expect(item.kpi).toBe("order_freight_sum");
		expect(item.filters).toEqual({ ship_country: "Germany" });
		expect(item.widget?.filters).toEqual({ ship_country: "Germany" });
		expect(item.widget?.title).toContain("Germany");
	});

	it("keeps the subject the value qualifies", async () => {
		const item = await first("how many customers in Mexico");
		expect(item.kpi).toBe("customer_count");
		expect(item.filters).toEqual({ country: "Mexico" });
	});

	it("collects several values of one column", async () => {
		const item = await first("orders in Germany and France");
		expect(item.filters).toEqual({ ship_country: ["Germany", "France"] });
	});

	it("does not answer 'customers in Brazil' with where orders were shipped", async () => {
		const item = await first("orders from customers in Brazil");
		expect(item.status).toBe("not_possible");
		expect(item.explanation).toContain("ship country");
		expect(item.alternatives).toContain("Combine orders with their customers");
	});

	it("answers from a dataset with one row per order that carries the column", async () => {
		const timing = enrichedTiming();
		install([order, customer, shipper, product, timing], [...baseKpis, kpi("order_timing_count", "Orders", timing, "count", null)]);
		const brazil = await first("orders from customers in Brazil");
		expect(brazil.status).toBe("ready");
		expect(brazil.kpi).toBe("order_timing_count");
		expect(brazil.filters).toEqual({ customer_country: "Brazil" });
		const speedy = await first("how many orders shipped via Speedy Express");
		expect(speedy.kpi).toBe("order_timing_count");
		expect(speedy.filters).toEqual({ shipper_company_name: "Speedy Express" });
	});

	it("reads the question without the values it names", async () => {
		const text = "orders from customers in Brazil by month";
		expect(withoutMentions(text, await valueMentions(text))).toBe("orders by month");
		const kept = "how many customers in Mexico";
		expect(withoutMentions(kept, await valueMentions(kept))).toBe("how many customers");
	});

	it("leaves words the ontology already uses alone", async () => {
		// "Owner" is a contact title, but nothing here asks about one.
		expect(await valueMentions("orders per month")).toEqual([]);
		expect((await first("total freight")).filters).toBeUndefined();
	});
});

describe("new and returning", () => {
	const history = () =>
		type(
			"OrderHistory",
			"Order History",
			"Order Histories",
			[
				...order.properties.map((p) => ({ ...p })),
				prop("customer_order_number", "measure"),
				prop("is_new_customer", "measure"),
				prop("is_returning_customer", "measure"),
			],
			{ origin: "combination" },
		);

	it("proposes numbering each customer's orders, measured as new and returning customers", async () => {
		const item = await first("new customers per month");
		expect(item.status).toBe("needs_approval");
		const [proposal] = item.proposals!;
		expect(proposal!.kind).toBe("combination");
		expect(proposal!.payload.base).toBe("Order");
		const derived = proposal!.payload.derived as Array<{ name: string; expression: string; metric?: Record<string, unknown> }>;
		expect(derived.find((d) => d.name === "is_new_customer")).toMatchObject({
			expression: "(sequence_of(customer_id, order_date, order_id) = 1)",
			metric: { aggregation: "sum", label: "New customers" },
		});
		expect(derived.find((d) => d.name === "is_returning_customer")?.metric).toMatchObject({
			aggregation: "count_distinct",
			of: "customer_id",
			label: "Returning customers",
		});
	});

	it("does not answer 'first-time customers' with the number of customers", async () => {
		const item = await first("first-time customers by country");
		expect(item.status).toBe("needs_approval");
		expect(item.kpi).toBeUndefined();
	});

	it("reads 'new vs returning' as both figures, from one dataset", async () => {
		const report = await assess({ text: "new vs returning customers per month" });
		expect(report.items.map((i) => i.explanation.split(" needs")[0])).toEqual(["New customers", "Returning customers"]);
		expect(report.items[0]!.proposals![0]!.payload).toEqual(report.items[1]!.proposals![0]!.payload);
	});

	it("proposes only the metric once the numbered dataset exists", async () => {
		install([order, customer, shipper, product, history()], [...baseKpis]);
		const item = await first("returning customers per month");
		expect(item.proposals).toHaveLength(1);
		expect(item.proposals![0]).toMatchObject({
			kind: "metric",
			payload: { objectType: "OrderHistory", aggregation: "count_distinct", measure: "customer_id", filters: { is_returning_customer: 1 } },
		});
	});

	it("answers from the metrics once they exist", async () => {
		const h = history();
		install(
			[order, customer, shipper, product, h],
			[
				...baseKpis,
				kpi("order_history_is_new_customer_sum", "New customers", h, "sum", "is_new_customer"),
				kpi("returning_customers", "Returning customers", h, "count_distinct", "customer_id", { conditions: { is_returning_customer: 1 } }),
			],
		);
		const fresh = await first("new customers per month");
		expect(fresh).toMatchObject({ status: "ready", kpi: "order_history_is_new_customer_sum", dimension: "order_date:month" });
		expect((await first("repeat customers")).kpi).toBe("returning_customers");
	});
});

describe("punctuality", () => {
	it("proposes one timing dataset whose flags name their metrics", async () => {
		const item = await first("on-time delivery rate by month");
		expect(item.status).toBe("needs_approval");
		expect(item.proposals).toHaveLength(1);
		const proposal = item.proposals![0]!;
		expect(proposal.kind).toBe("combination");
		expect(proposal.payload.name).toBe("Order Timing");
		const derived = proposal.payload.derived as Array<{ name: string; expression: string; metric?: Record<string, string> }>;
		const byName = new Map(derived.map((d) => [d.name, d]));
		expect(byName.get("on_time_pct")).toMatchObject({
			expression: "(shipped_date <= required_date) * 100",
			metric: { aggregation: "avg", label: "On-time rate", format: "percent" },
		});
		expect(byName.get("is_late")?.metric).toMatchObject({ aggregation: "sum", label: "Late orders" });
		expect(byName.get("days_late")?.expression).toBe("nullif(greatest(days_between(required_date, shipped_date), 0), 0)");
		expect(byName.get("days_to_complete")?.expression).toBe("days_between(order_date, shipped_date)");
		// What the orders point at comes along, so the rate can be sliced by it.
		expect((proposal.payload.joins as unknown[]).length).toBeGreaterThan(0);
	});

	it("does not answer a lateness question with the count of orders", async () => {
		const item = await first("how many orders shipped late");
		expect(item.status).toBe("needs_approval");
		expect(item.kpi ?? null).toBeNull();
	});

	it("leaves 'latest' alone", async () => {
		expect((await first("latest orders")).kpi).toBe("order_count");
		// A type with no dates has no "latest": that word is unexplained.
		expect((await first("latest products")).status).toBe("not_possible");
	});

	it("answers from the on-time metric once it exists", async () => {
		const rate = kpi("order_timing_on_time_pct_avg", "On-time rate", timing, "avg", "on_time_pct", { origin: "proposal" });
		install([order, customer, shipper, product, timing], [...baseKpis, rate]);
		const item = await first("on-time delivery rate by month");
		expect(item.status).toBe("ready");
		expect(item.kpi).toBe("order_timing_on_time_pct_avg");
		expect(item.widget?.dimension).toBe("order_date:month");
	});

	it("proposes only the missing metric on a timing dataset approved earlier", async () => {
		install([order, customer, shipper, product, timing], [...baseKpis]);
		const item = await first("how many orders shipped late");
		expect(item.status).toBe("needs_approval");
		expect(item.proposals?.map((p) => p.kind)).toEqual(["metric"]);
		expect(item.proposals?.[0]?.payload).toMatchObject({ objectType: "OrderTiming", measure: "is_late", aggregation: "sum" });
	});

	it("says what is missing when no type has both dates", async () => {
		const undated = type("Order", "Order", "Orders", order.properties.filter((p) => p.sqlColumn !== "required_date").map((p) => ({ ...p })));
		install([undated, customer, shipper, product], baseKpis.map((k) => ({ ...k, objectTypeRid: k.objectTypeRid })));
		const item = await first("on-time delivery rate");
		expect(item.status).toBe("not_possible");
		expect(item.missing?.[0]).toContain("promised date");
	});
});

describe("boards led by a rate", () => {
	it("compares an average in bars and ranks its table by a figure that adds up", async () => {
		const rate = kpi("order_timing_on_time_pct_avg", "On-time rate", timing, "avg", "on_time_pct", { origin: "proposal" });
		const late = kpi("order_timing_is_late_sum", "Late orders", timing, "sum", "is_late", { origin: "proposal" });
		const count = kpi("order_timing_count", "Orders", timing, "count", null, { origin: "proposal" });
		install([order, customer, shipper, product, timing], [...baseKpis, rate, late, count]);
		const { layout } = await planBoard(timing, { measure: "on_time_pct" });
		const stats = layout.filter((w) => w.type === "stat").map((w) => w.title);
		expect(stats.slice(0, 2)).toEqual(["On-time rate", "Late orders"]);
		expect(layout.some((w) => w.chart === "donut")).toBe(false);
		const table = layout.find((w) => w.type === "table");
		if (table) expect(table.kpi).toBe("order_timing_is_late_sum");
	});
});
