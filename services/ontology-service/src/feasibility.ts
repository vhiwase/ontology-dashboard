/**
 * Feasibility: which charts, metrics, dashboards and reports this workspace's
 * data can actually support - and what is missing for the rest.
 *
 * Asked "revenue by customer country, monthly", there are exactly three
 * honest answers, and this module decides between them from the ontology:
 *
 *   READY          a metric exists and may be sliced that way: here is the
 *                  widget that charts it
 *   NEEDS APPROVAL the data can answer it, but a building block is missing -
 *                  a link between two types, a combined dataset along links
 *                  that exist, a derived property (revenue = price x quantity),
 *                  a metric - and here are the proposals that would add it
 *   NOT POSSIBLE   the data does not contain it: here is what is missing, and
 *                  the nearest question that can be answered
 *
 * It never estimates, and it never falls back to a number from somewhere
 * else. It is deterministic - no language model - so it answers the same way
 * every time, works on a server with no model configured, and gives a model
 * that IS configured a tool whose answers it can rely on.
 */

import type { Widget } from "./dashboards";
import { defaultSlice, measureLinkNow } from "./modeling";
import { humanize, plural, singular, snake } from "./profiling";
import { dimensionsOf, pascal } from "./proposals";
import {
	getRegistry,
	type KpiMeta,
	type LinkTypeMeta,
	type ObjectTypeMeta,
	type PropertyMeta,
} from "./registry";
import { query } from "./db";
import { quoteIdentifier, quoteQualified } from "./registry";

export type Intent = "chart" | "dashboard" | "report" | "link" | "combination" | "metric" | "capabilities";
export type Status = "ready" | "needs_approval" | "not_possible";

export interface DraftProposal {
	kind: "link_type" | "metric" | "combination" | "action_type";
	title: string;
	summary: string;
	payload: Record<string, unknown>;
	/** Indexes into the same item's proposals that must be applied first. */
	dependsOn: number[];
	/** What to build once this is applied (see FollowUp in proposals.ts). */
	followUp?: { build: "dashboard" | "report"; title: string; measure: string | null; sourcePrompt: string | null };
}

export interface FeasibilityRequest {
	text?: string;
	measure?: string;
	aggregation?: string;
	dimension?: string;
	grain?: string;
	objectType?: string;
}

export interface FeasibilityItem {
	request: FeasibilityRequest;
	status: Status;
	explanation: string;
	kpi?: string;
	dimension?: string | null;
	widget?: Widget;
	proposals?: DraftProposal[];
	missing?: string[];
	alternatives?: string[];
}

export interface FeasibilityReport {
	intent: Intent;
	/** The type the request is mainly about, when one could be identified. */
	subject: string | null;
	items: FeasibilityItem[];
	summary: { ready: number; needsApproval: number; notPossible: number };
	/** For dashboards and reports: the ready widgets, laid out. */
	layout?: Widget[];
	title?: string;
}

// ── words ───────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
	"a an the of for in on to me show what whats is are was were our my we us i you please give list chart graph plot display see view get find tell much and or with from all each every this that these those it its their there which who can could would should do does did be been about into than then as at per by over across between broken down grouped split total totals".split(" "),
);

/** Words that mean the same thing in a business question, by group. */
const SYNONYMS: Record<string, string[]> = {
	revenue: ["revenue", "sale", "sales", "turnover", "income", "gmv", "earning", "earnings", "billing", "booking", "bookings"],
	customer: ["customer", "client", "account", "buyer", "shopper", "consumer"],
	order: ["order", "purchase", "transaction", "deal"],
	product: ["product", "item", "sku", "good", "article"],
	employee: ["employee", "staff", "rep", "salesperson", "seller", "agent", "worker"],
	country: ["country", "nation"],
	city: ["city", "town"],
	region: ["region", "state", "province", "territory", "area"],
	supplier: ["supplier", "vendor"],
	shipper: ["shipper", "carrier", "courier"],
	category: ["category", "group", "family", "line"],
	quantity: ["quantity", "qty", "units", "volume"],
	price: ["price"],
	freight: ["freight"],
};
// Words that ask for a count rather than name what is counted.
const COUNT_WORDS = new Set(["number", "count", "counts", "how", "many", "amount", "quantity", "volume", "unique", "distinct", "overall", "everything"]);
// Words that say when, not what: answered from a type's own dates.
const TIME_WORDS = new Set(["latest", "recent", "recently", "last", "newest", "new", "current", "this", "today", "yesterday", "past", "previous", "so", "far", "ytd", "mtd", "date"]);
const GROUP_OF = new Map<string, string>();
for (const [group, words] of Object.entries(SYNONYMS)) for (const word of words) GROUP_OF.set(word, group);

// Punctuality compares a promised date with an actual one on the same row; the
// start date, when there is one, gives the time taken.
const PROMISED_DATE = /(required|due|promised|expected|planned|deadline|target)/;
const ACTUAL_DATE = /(shipped|delivered|actual|completed|closed|arrived|paid|resolved|fulfilled|finished)/;
const START_DATE = /(order|created|placed|opened|start|booked|requested|date$)/;
const PUNCTUAL = /\b(on.?time|late|lateness|delays?|delayed|punctual|punctuality|overdue)\b/;

export function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Meaningful, singular, synonym-grouped tokens of a phrase. */
export function tokens(text: string): string[] {
	return words(text)
		.filter((w) => !STOPWORDS.has(w))
		.map((w) => singular(w))
		.map((w) => GROUP_OF.get(w) ?? w);
}

function overlap(phrase: string[], candidate: string[]): number {
	if (phrase.length === 0 || candidate.length === 0) return 0;
	const set = new Set(candidate);
	const hits = phrase.filter((t) => set.has(t)).length;
	return hits / Math.max(candidate.length, 1) + hits / Math.max(phrase.length, 1);
}

// ── parsing a request ───────────────────────────────────────────────────────

const GRAIN_WORDS: Array<[RegExp, string]> = [
	[/\b(daily|per day|by day|each day)\b/, "day"],
	[/\b(weekly|per week|by week|each week)\b/, "week"],
	[/\b(quarterly|per quarter|by quarter|each quarter)\b/, "quarter"],
	[/\b(yearly|annual|annually|per year|by year|each year)\b/, "year"],
	[/\b(monthly|per month|by month|each month|over time|trend|trends|trending|timeline|time series|history|historical)\b/, "month"],
];

export function detectIntent(text: string): Intent {
	const t = ` ${text.toLowerCase()} `;
	// "What can I build?", "what charts, KPIs and dashboards can I build from my
	// data?", "what's possible?" - a question about the data, not a chart.
	if (
		/\b(what|which)\b[^?.!]{0,80}?\b(can|could)\s+(i|we|you)\s+(build|chart|make|create|answer|see|do)\b|\bwhat('s| is) possible\b|\bcapabilit|\bwhat (can|could) (my|our|this) data\b/.test(
			t,
		)
	)
		return "capabilities";
	if (/\b(link|connect|relate|relationship between)\b/.test(t) && !/\bdashboard\b/.test(t)) return "link";
	if (/\b(combine|enrich|merge|join)\b/.test(t)) return "combination";
	if (/\breport\b/.test(t)) return "report";
	if (/\b(dashboard|board|overview|control tower|cockpit|scorecard)\b/.test(t)) return "dashboard";
	if (/\b(define|create|add|new) (a |an )?(metric|kpi|measure)\b/.test(t)) return "metric";
	return "chart";
}

/** Split "X by Y monthly" into its measure, dimension and grain. */
export function parseQuestion(text: string): {
	measure: string;
	dimension: string | null;
	grain: string | null;
	aggregation: string | null;
} {
	let lowered = ` ${text.toLowerCase().replace(/[?.!]/g, " ")} `;
	let grain: string | null = null;
	for (const [pattern, value] of GRAIN_WORDS) {
		if (pattern.test(lowered)) {
			grain = value;
			lowered = lowered.replace(pattern, " ");
			break;
		}
	}
	let aggregation: string | null = null;
	if (/\b(average|avg|mean|typical)\b/.test(lowered)) aggregation = "avg";
	else if (/\b(how many|number of|count of|count)\b/.test(lowered)) aggregation = "count";
	else if (/\b(distinct|unique|different)\b/.test(lowered)) aggregation = "count_distinct";
	else if (/\b(total|sum of|sum)\b/.test(lowered)) aggregation = "sum";
	else if (/\b(highest|maximum|max|largest|biggest)\b/.test(lowered)) aggregation = "max";
	else if (/\b(lowest|minimum|min|smallest)\b/.test(lowered)) aggregation = "min";

	const split = /\s(?:by|per|for each|for every|across|split by|broken down by|grouped by|segmented by|in each)\s/.exec(lowered);
	let measure = lowered;
	let dimension: string | null = null;
	if (split) {
		measure = lowered.slice(0, split.index);
		dimension = lowered.slice(split.index + split[0].length).trim() || null;
	}
	// "top 10 customers by revenue": the thing ranked is the dimension.
	const top = /\b(top|bottom|best|worst)\s+(\d+\s+)?([a-z ]+?)\s*$/.exec(measure.trim());
	if (top && dimension) {
		const ranked = top[3]!;
		measure = dimension;
		dimension = ranked;
	}
	measure = measure.replace(/\b(average|avg|mean|typical|how many|number of|count of|total|sum of|distinct|unique|highest|lowest|top \d+|top)\b/g, " ");
	return { measure: measure.trim(), dimension, grain, aggregation };
}

// ── resolving words to the ontology ─────────────────────────────────────────

interface PropertyMatch {
	type: ObjectTypeMeta;
	property: PropertyMeta;
	score: number;
}

function typeTokens(type: ObjectTypeMeta): string[] {
	return [...new Set([...tokens(type.label), ...tokens(type.pluralLabel ?? ""), ...tokens(type.apiName)])];
}

function propertyTokens(property: PropertyMeta): string[] {
	return [...new Set([...tokens(property.label), ...tokens(property.sqlColumn)])];
}

/** A phrase that IS a type's name ("territories", "us states"), synonyms aside. */
function namesTypeExactly(phrase: string, type: ObjectTypeMeta): boolean {
	const plain = (text: string) => words(text).map((w) => singular(w)).join(" ");
	const wanted = plain(phrase);
	return wanted !== "" && [type.label, type.pluralLabel ?? "", type.apiName].some((name) => plain(name) === wanted);
}

/** The type a phrase is mostly about, if it names one. */
export function matchType(phrase: string): ObjectTypeMeta | null {
	// An exact name wins before synonyms are consulted: "territories" is the
	// Territory type even though territory is also a word for region.
	const exact = getRegistry().objectTypes.find((type) => namesTypeExactly(phrase, type));
	if (exact) return exact;
	const want = tokens(phrase);
	let best: { type: ObjectTypeMeta; score: number } | null = null;
	for (const type of getRegistry().objectTypes) {
		const score = overlap(want, typeTokens(type));
		if (score > (best?.score ?? 0.99)) best = { type, score };
	}
	return best?.type ?? null;
}

function matchProperty(phrase: string, roles: string[], preferType: ObjectTypeMeta | null): PropertyMatch | null {
	const want = tokens(phrase);
	if (want.length === 0) return null;
	let best: PropertyMatch | null = null;
	for (const type of getRegistry().objectTypes) {
		const typeBonus = overlap(want, typeTokens(type)) > 0 ? 0.35 : 0;
		const preferred = preferType && type.rid === preferType.rid ? 0.25 : 0;
		for (const property of type.properties) {
			if (!roles.includes(property.semanticRole)) continue;
			const own = overlap(want, propertyTokens(property));
			if (own === 0) continue;
			// A combined type repeats its base's columns; the base is the
			// better answer unless the combination is the only one with it.
			const combinedPenalty = type.origin === "combination" ? 0.05 : 0;
			const score = own + typeBonus + preferred - combinedPenalty;
			if (!best || score > best.score) best = { type, property, score };
		}
	}
	return best && best.score >= 0.6 ? best : null;
}

function matchKpi(phrase: string, aggregation: string | null, preferType: ObjectTypeMeta | null): { kpi: KpiMeta; score: number } | null {
	const want = tokens(phrase);
	if (want.length === 0) return null;
	const registry = getRegistry();
	let best: { kpi: KpiMeta; score: number } | null = null;
	for (const kpi of registry.kpis) {
		const candidate = [...new Set([...tokens(kpi.label), ...tokens(kpi.apiName.replace(/_(sum|avg|count)$/, "")), ...tokens(kpi.measureColumn ?? "")])];
		let score = overlap(want, candidate);
		if (score === 0) continue;
		if (aggregation && kpi.aggregation === aggregation) score += 0.3;
		if (aggregation && kpi.aggregation !== aggregation && !(aggregation === "count" && kpi.aggregation === "count")) score -= 0.2;
		if (preferType && kpi.objectTypeRid === preferType.rid) score += 0.2;
		if (!best || score > best.score) best = { kpi, score };
	}
	return best && best.score >= 0.8 ? best : null;
}

/** Forward many-to-one paths from one type to another, shortest first. */
export function linkPath(from: ObjectTypeMeta, to: ObjectTypeMeta, maxHops = 3): LinkTypeMeta[] | null {
	if (from.rid === to.rid) return [];
	const registry = getRegistry();
	const queue: Array<{ rid: string; path: LinkTypeMeta[] }> = [{ rid: from.rid, path: [] }];
	const seen = new Set([from.rid]);
	while (queue.length > 0) {
		const { rid, path } = queue.shift()!;
		if (path.length >= maxHops) continue;
		for (const link of registry.linksBySourceRid.get(rid) ?? []) {
			if (link.cardinality !== "MANY_TO_ONE" && link.cardinality !== "ONE_TO_ONE") continue;
			if (seen.has(link.targetObjectType)) continue;
			const next = [...path, link];
			if (link.targetObjectType === to.rid) return next;
			seen.add(link.targetObjectType);
			queue.push({ rid: link.targetObjectType, path: next });
		}
	}
	return null;
}

function dimensionKey(property: PropertyMeta, grain: string | null): string {
	return property.semanticRole === "temporal" ? `${property.sqlColumn}:${grain ?? "month"}` : property.sqlColumn;
}

function chartFor(dimension: string | null, kpi: KpiMeta): Widget["chart"] {
	if (!dimension) return "bar";
	if (dimension.includes(":")) return "line";
	return kpi.aggregation === "count" ? "bar" : "hbar";
}

/** The base type and expression for "revenue" when no column holds it. */
function revenueRecipe(): { type: ObjectTypeMeta; expression: string; name: string } | null {
	for (const type of getRegistry().objectTypes) {
		if (type.origin === "combination") continue;
		const columns = new Map(type.properties.filter((p) => p.semanticRole === "measure").map((p) => [p.sqlColumn.toLowerCase(), p.sqlColumn]));
		const price = [...columns.keys()].find((c) => /(unit_price|price|rate)$/.test(c) || c === "price");
		const quantity = [...columns.keys()].find((c) => /(quantity|qty|units)$/.test(c));
		if (!price || !quantity) continue;
		const discount = [...columns.keys()].find((c) => /discount/.test(c));
		const expression = discount
			? `${columns.get(price)} * ${columns.get(quantity)} * (1 - ${columns.get(discount)})`
			: `${columns.get(price)} * ${columns.get(quantity)}`;
		// Named "revenue", so the metric modelled on it ("Total Revenue") is the
		// one a later "revenue by ..." question finds.
		return { type, expression, name: "revenue" };
	}
	return null;
}

// ── deciding one request ────────────────────────────────────────────────────

/** "Orders per month", "Revenue by customer country". */
/**
 * What a slice is called in a title: a linked type's name column stands for
 * the type - "shipper_company_name" reads "shipper", "employee_last_name"
 * "employee" - and anything else reads as its column.
 */
export function sliceName(column: string, namesType: (phrase: string) => boolean = registryNamesType): { text: string; isType: boolean } {
	const text = humanize(column).toLowerCase();
	const match = /^(.+?) (company name|last name|full name|name)$/.exec(text);
	return match && namesType(match[1]!) ? { text: match[1]!, isType: true } : { text, isType: false };
}

function registryNamesType(phrase: string): boolean {
	try {
		return getRegistry().objectTypes.some((type) => type.origin !== "combination" && namesTypeExactly(phrase, type));
	} catch {
		return false;
	}
}

/** "Top customers", "Top ship name": a ranking names what is ranked. */
function rankedName(column: string): string {
	const slice = sliceName(column);
	return slice.isType ? plural(slice.text) : slice.text;
}

export function widgetTitle(kpi: KpiMeta, dimension: string | null): string {
	if (!dimension) return kpi.label;
	const [column = "", grain] = dimension.split(":");
	if (!grain) return `${kpi.label} by ${sliceName(column).text}`;
	// The metric's own date needs no naming; any other date does.
	return kpi.timeColumn && kpi.timeColumn !== column
		? `${kpi.label} per ${grain} (${humanize(column).toLowerCase()})`
		: `${kpi.label} per ${grain}`;
}

function readyItem(request: FeasibilityRequest, kpi: KpiMeta, dimension: string | null, title?: string): FeasibilityItem {
	const widget: Widget = dimension
		? {
				type: "chart",
				kpi: kpi.apiName,
				dimension,
				chart: chartFor(dimension, kpi),
				...(dimension.includes(":") ? { sort: "dimension_asc" as const } : { sort: "value_desc" as const, limit: 12 }),
				title: title ?? widgetTitle(kpi, dimension),
				width: 2,
			}
		: { type: "stat", kpi: kpi.apiName, title: title ?? kpi.label, width: 1 };
	return {
		request,
		status: "ready",
		explanation: dimension
			? `${widget.title ?? widgetTitle(kpi, dimension)} is ready, from the existing metric ${kpi.apiName}.`
			: `${kpi.label} is ready as a single figure, from the existing metric ${kpi.apiName}.`,
		kpi: kpi.apiName,
		dimension,
		widget,
	};
}

async function proposeJoinKey(source: ObjectTypeMeta, target: ObjectTypeMeta): Promise<DraftProposal | null> {
	// A column of the source named like the target's key, or sharing a name
	// with one of its identity columns, checked against the data.
	const generic = new Set(["id", "name", "description", "title", "notes", "created_at", "updated_at"]);
	const targetKeys = target.properties.filter((p) => p.semanticRole === "identity" || p.sqlColumn === target.primaryKeyColumn);
	for (const candidate of source.properties) {
		if (generic.has(candidate.sqlColumn)) continue;
		for (const key of targetKeys) {
			const sameName = candidate.sqlColumn === key.sqlColumn;
			const namedFor = candidate.sqlColumn === `${snake(target.apiName)}_id` && key.sqlColumn === target.primaryKeyColumn;
			if (!sameName && !namedFor) continue;
			const measured = await measureLinkNow(source.sourceView, candidate.sqlColumn, target.sourceView, key.sqlColumn).catch(() => null);
			if (!measured || measured.ratio < 0.5) continue;
			// Named here, not when it is applied, so a combination proposed in the
			// same breath can refer to it by name.
			const role = candidate.sqlColumn.replace(/_(id|key|code|no|number|ref)$/i, "").split("_").filter(Boolean)
				.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || target.apiName;
			const apiName = `${source.apiName[0]!.toLowerCase()}${source.apiName.slice(1)}${role}`;
			return {
				kind: "link_type",
				title: `Link ${source.label} to ${target.label}`,
				summary: `${source.apiName}.${candidate.sqlColumn} matches ${target.apiName}.${key.sqlColumn} for ${(measured.ratio * 100).toFixed(1)}% of rows.`,
				payload: { source: source.apiName, sourceProperty: candidate.sqlColumn, target: target.apiName, targetProperty: key.sqlColumn, apiName },
				dependsOn: [],
			};
		}
	}
	return null;
}

/** "On-time rate", "orders shipped late", "delays" - but not "latest orders". */
export function asksAboutPunctuality(phrase: string): boolean {
	return PUNCTUAL.test(phrase.toLowerCase());
}

/** "Distinct customers", preferably one with the grain asked for. */
function distinctKpiFor(type: ObjectTypeMeta, grain: string | null): KpiMeta | null {
	const many = (type.pluralLabel ?? plural(type.label)).toLowerCase();
	const distinct = getRegistry().kpis.filter((k) => k.aggregation === "count_distinct" && k.label.toLowerCase().includes(many));
	return (grain ? distinct.find((k) => k.dimensions.some((d) => d.endsWith(`:${grain}`))) : undefined) ?? distinct[0] ?? null;
}

/** The metric a punctuality question is answered from, once it exists. */
function punctualityKpi(counting: boolean): KpiMeta | null {
	const [measure, aggregation] = counting ? ["is_late", "sum"] : ["on_time_pct", "avg"];
	return getRegistry().kpis.find((k) => k.measureColumn === measure && k.aggregation === aggregation) ?? null;
}

/**
 * "On-time rate", "late orders": answered from a promised and an actual date
 * on the same rows. The flags are derived once, in a dataset that also carries
 * what the rows are sliced by, and the figure is a metric over them - the rate
 * an average of 0 or 100 per row, the count a sum of 0 or 1 - so a row with no
 * actual date yet counts as neither on time nor late.
 */
function punctuality(request: FeasibilityRequest, counting: boolean): FeasibilityItem {
	const registry = getRegistry();
	const dateLike = (t: ObjectTypeMeta, pattern: RegExp, not?: PropertyMeta) =>
		t.properties.find((p) => p.semanticRole === "temporal" && p !== not && pattern.test(p.sqlColumn));
	const promisedOf = (t: ObjectTypeMeta) => dateLike(t, PROMISED_DATE);
	const actualOf = (t: ObjectTypeMeta) => dateLike(t, ACTUAL_DATE, promisedOf(t));
	const dated = registry.objectTypes.find((t) => t.origin !== "combination" && promisedOf(t) && actualOf(t));
	if (!dated) {
		return {
			request,
			status: "not_possible",
			explanation:
				"Being on time needs a promised date and an actual date for the same thing (a due date and a shipped date, say), " +
				"and no type in this workspace has both.",
			missing: ["a promised date and an actual date on the same rows"],
			alternatives: registry.kpis
				.filter((k) => k.dimensions.some((d) => d.endsWith(":month")))
				.slice(0, 4)
				.map((k) => `${k.label} per month`),
		};
	}
	const promised = promisedOf(dated)!.sqlColumn;
	const actual = actualOf(dated)!.sqlColumn;
	const many = dated.pluralLabel?.toLowerCase() ?? plural(dated.label.toLowerCase());
	const metric = counting
		? { measure: "is_late", aggregation: "sum", format: "integer", label: `Late ${many}` }
		: { measure: "on_time_pct", aggregation: "avg", format: "percent", label: "On-time rate" };
	const metricSummary = counting
		? `The number of ${many} with ${actual} after ${promised}.`
		: `The share of ${many} with ${actual} on or before ${promised}.`;

	// The flags were derived by an earlier approval: only the metric is new.
	const timing = registry.objectTypes.find(
		(t) => t.origin === "combination" && t.properties.some((p) => p.sqlColumn === metric.measure),
	);
	if (timing) {
		return {
			request,
			status: "needs_approval",
			explanation:
				`${timing.pluralLabel ?? timing.label} already carry \`${metric.measure}\` for each ${dated.label.toLowerCase()}. ` +
				`Approve the metric "${metric.label}" over it and it can be charted by month or by anything those rows carry.`,
			proposals: [
				{
					kind: "metric",
					title: `New metric: ${metric.label}`,
					summary: metricSummary,
					payload: { objectType: timing.apiName, ...metric },
					dependsOn: [],
				},
			],
		};
	}

	const start = dated.properties.find(
		(p) => p.semanticRole === "temporal" && p.sqlColumn !== promised && p.sqlColumn !== actual && START_DATE.test(p.sqlColumn),
	);
	// Both figures are named here, whichever was asked for: approving the
	// dataset makes them, and the next question about lateness is answered.
	const derived = [
		{
			name: "on_time_pct",
			expression: `(${actual} <= ${promised}) * 100`,
			metric: { aggregation: "avg", label: "On-time rate", format: "percent" },
		},
		{
			name: "is_late",
			expression: `(${actual} > ${promised})`,
			metric: { aggregation: "sum", label: `Late ${many}`, format: "integer" },
		},
		{
			// Late rows only: an early shipment is not "-3 days late".
			name: "days_late",
			expression: `nullif(greatest(days_between(${promised}, ${actual}), 0), 0)`,
			metric: { aggregation: "avg", label: "Average days late", format: "number" },
		},
		...(start ? [{ name: "days_to_complete", expression: `days_between(${start.sqlColumn}, ${actual})` }] : []),
	];
	// What the rows point at comes along, so the rate can be sliced by it.
	const joins = analysisJoins(dated);
	const carried = joins.map((j) => `${j.target.label.toLowerCase()} (${j.fields.map((f) => humanize(f).toLowerCase()).join(", ")})`);
	const name = freeDatasetName(`${dated.label} Timing`);
	return {
		request,
		status: "needs_approval",
		explanation:
			`${dated.pluralLabel ?? dated.label} carry a promised date (${promised}) and an actual one (${actual}). ` +
			`Approve and each ${dated.label.toLowerCase()} is flagged on time (\`${actual} <= ${promised}\`) or late, with how many days late the late ones were` +
			(start ? ` and days to complete from ${start.sqlColumn}` : "") +
			`; "On-time rate" and "Late ${many}" are measured from the flags` +
			(carried.length ? ` and can be charted by month or by ${joins.map((j) => j.target.label.toLowerCase()).join(", ")}` : " and can be charted by month") +
			`. ${dated.pluralLabel ?? dated.label} without ${actual} yet count as neither on time nor late.`,
		proposals: [
			{
				kind: "combination",
				title: `New dataset: ${name}`,
				summary:
					`${dated.pluralLabel ?? dated.label} with ${derived.map((d) => `${d.name} = \`${d.expression}\``).join(", ")}` +
					(carried.length ? `, and ${carried.join("; ")}` : "") +
					`. Measured as "On-time rate" and "Late ${many}".`,
				payload: { name, base: dated.apiName, joins: joins.map((j) => ({ path: j.path, fields: j.fields })), derived },
				dependsOn: [],
			},
		],
	};
}

async function decide(request: FeasibilityRequest): Promise<FeasibilityItem> {
	const registry = getRegistry();
	const subjectHint = request.objectType ? registry.objectTypeByApiName.get(request.objectType) ?? matchType(request.objectType) : null;
	const measurePhrase = request.measure ?? "";
	const aggregation = request.aggregation ?? null;

	// 1. What is being measured.
	const kpiMatch = matchKpi(measurePhrase, aggregation, subjectHint);
	const propertyMatch = matchProperty(measurePhrase, ["measure"], subjectHint);
	const countedType = matchType(measurePhrase) ?? subjectHint;
	let kpi: KpiMeta | null = null;
	let measureProperty: PropertyMatch | null = null;

	// The phrase is just a type's name: "total orders" is how many orders,
	// not a sum of a column that happens to mention orders.
	const namesTypeOnly = countedType !== null && namesTypeExactly(measurePhrase, countedType);
	// "Unique customers per month": counted where they appear - the distinct
	// customers on orders - which has a timeline the type itself may lack.
	const distinctOf =
		aggregation === "count_distinct" && namesTypeOnly ? distinctKpiFor(countedType!, request.grain ?? null) : null;

	if (distinctOf) {
		kpi = distinctOf;
	} else if (
		aggregation === "count" ||
		(aggregation === "sum" && namesTypeOnly) ||
		(countedType && !aggregation && (!propertyMatch || overlap(tokens(measurePhrase), typeTokens(countedType)) >= propertyMatch.score))
	) {
		// "How many orders", or a bare type name: that type's count metric. A
		// property that merely shares a word ("units on order") does not
		// outrank the type the question names.
		kpi = countedType ? registry.kpis.find((k) => k.objectTypeRid === countedType.rid && k.aggregation === "count") ?? null : null;
		if (!kpi && kpiMatch?.kpi.aggregation === "count") kpi = kpiMatch.kpi;
	} else if (propertyMatch && (!kpiMatch || propertyMatch.score >= kpiMatch.score - 0.3)) {
		// A measured property: its metric with the requested aggregation, if
		// one exists; otherwise one is proposed below.
		measureProperty = propertyMatch;
		const wanted = aggregation ?? propertyMatch.property.defaultAggregation ?? "sum";
		kpi = registry.kpis.find(
			(k) => k.objectTypeRid === propertyMatch.type.rid && k.measureColumn === propertyMatch.property.sqlColumn && k.aggregation === wanted,
		) ?? null;
	} else if (kpiMatch) {
		kpi = kpiMatch.kpi;
	}

	// 1b. Punctuality - "on-time rate", "how many orders shipped late" - is a
	// figure no column holds, but two dates on the same row do. The count of
	// orders that merely matched the noun answers a different question, so it
	// does not stand in.
	if (asksAboutPunctuality(measurePhrase) && !(kpi && asksAboutPunctuality(kpi.label))) {
		const counting = aggregation === "count" || /\b(how many|number of|count of)\b/.test(request.text ?? measurePhrase);
		const measured = punctualityKpi(counting);
		if (!measured) return punctuality(request, counting);
		kpi = measured;
		measureProperty = null;
	}

	// 1c. A count of a type answers only for the type: "customer satisfaction
	// score" is not the number of customers. Words the type's name does not
	// cover must name something the data holds, or the answer is that it
	// does not hold it.
	if (kpi?.aggregation === "count" && countedType && kpi.objectTypeRid === countedType.rid) {
		const own = typeTokens(countedType);
		const dated = countedType.properties.some((p) => p.semanticRole === "temporal");
		const unexplained = words(measurePhrase).filter((w) => {
			if (STOPWORDS.has(w) || COUNT_WORDS.has(w)) return false;
			// "Latest orders", "recent orders": a when, read from the type's dates.
			if (dated && TIME_WORDS.has(w)) return false;
			const token = GROUP_OF.get(singular(w)) ?? singular(w);
			return !own.includes(token);
		});
		const phrase = unexplained.join(" ");
		const explained =
			phrase === "" ||
			matchProperty(phrase, ["measure", "dimension", "flag", "temporal", "attribute", "title", "identity"], countedType) !== null ||
			matchType(phrase) !== null ||
			// "orders in Germany": a value the data holds, for a filter.
			(await holdsValue(countedType, unexplained));
		if (!explained) {
			const many = countedType.pluralLabel ?? plural(countedType.label);
			return {
				request,
				status: "not_possible",
				explanation: `${many} can be counted, but nothing in this workspace's data looks like "${phrase}".`,
				missing: [`a column holding ${phrase}`],
				alternatives: registry.kpis
					.filter((k) => k.objectTypeRid === countedType.rid)
					.slice(0, 4)
					.map((k) => (k.timeColumn ? `${k.label} per month` : k.label)),
			};
		}
	}

	let measureType = kpi
		? kpi.objectTypeRid ? registry.objectTypeByRid.get(kpi.objectTypeRid) ?? null : null
		: measureProperty?.type ?? countedType;

	// 2. What it is sliced by.
	let dimensionProperty: PropertyMatch | null = null;
	let wantsTime = Boolean(request.grain);
	if (request.dimension) {
		const dimensionText = request.dimension;
		if (/\b(time|date|day|week|month|quarter|year|period)\b/.test(dimensionText) && measureType) {
			wantsTime = true;
		} else {
			// "by shipper" names a TYPE: slice by what its objects are called,
			// not by their ids. Only a phrase with words beyond the type's own
			// ("customer country") is looked up as a property.
			const named = matchType(dimensionText);
			const extraWords = named ? tokens(dimensionText).filter((t) => !typeTokens(named).includes(t)) : [];
			if (named && extraWords.length === 0) {
				const title = named.properties.find((p) => p.isTitle) ?? named.properties.find((p) => p.sqlColumn === named.titleColumn) ??
					named.properties.find((p) => p.semanticRole === "dimension");
				if (title) dimensionProperty = { type: named, property: title, score: 2 };
			}
			if (!dimensionProperty) {
				dimensionProperty = matchProperty(dimensionText, ["dimension", "temporal", "flag", "title", "attribute"], measureType) ??
					matchProperty(dimensionText, ["identity"], measureType);
			}
			if (!dimensionProperty) {
				return {
					request,
					status: "not_possible",
					explanation: `Nothing in this workspace's data looks like "${dimensionText}", so there is nothing to group by.`,
					missing: [`a column holding ${dimensionText}`],
					alternatives: measureType ? dimensionsOf(measureType).filter((d) => !d.includes(":")).slice(0, 6).map((d) => `${measurePhrase || "it"} by ${humanize(d).toLowerCase()}`) : [],
				};
			}
		}
	}
	if (wantsTime && !dimensionProperty && measureType) {
		let timeType = measureType;
		// The same figure may exist on a dataset that also carries a date
		// (a combination built for it): prefer that one.
		if (kpi && !measureType.properties.some((p) => p.semanticRole === "temporal")) {
			const dated = registry.kpis.find(
				(k) =>
					k.aggregation === kpi!.aggregation &&
					k.measureColumn === kpi!.measureColumn &&
					k.timeColumn &&
					k.objectTypeRid !== kpi!.objectTypeRid &&
					registry.objectTypeByRid.get(k.objectTypeRid ?? "")?.propertyBySqlColumn.has(kpi!.measureColumn ?? ""),
			);
			const datedType = dated?.objectTypeRid ? registry.objectTypeByRid.get(dated.objectTypeRid) : undefined;
			if (dated && datedType) {
				kpi = dated;
				timeType = datedType;
				measureType = datedType;
			}
		}
		const temporal = timeType.properties.find((p) => p.semanticRole === "temporal" && p.sqlColumn === (kpi?.timeColumn ?? "")) ??
			timeType.properties.find((p) => p.semanticRole === "temporal");
		if (temporal) {
			dimensionProperty = { type: timeType, property: temporal, score: 1 };
		} else {
			// No date here, but perhaps one link away: bring it in.
			const reachable = registry.objectTypes
				.map((t) => ({ t, path: linkPath(timeType, t) }))
				.filter((x) => x.path && x.path.length > 0 && x.t.properties.some((p) => p.semanticRole === "temporal"))
				.sort((a, b) => a.path!.length - b.path!.length)[0];
			if (reachable) {
				const date = reachable.t.properties.find((p) => p.semanticRole === "temporal" && /(order|created|date|placed|invoice)/.test(p.sqlColumn)) ??
					reachable.t.properties.find((p) => p.semanticRole === "temporal")!;
				return {
					request,
					status: "needs_approval",
					explanation:
						`${timeType.pluralLabel ?? timeType.label} have no date of their own, but each one reaches ${reachable.t.label.toLowerCase()} ` +
						`(${reachable.path!.map((l) => l.apiName).join(" → ")}), which has ${date.sqlColumn}. Approve the dataset below to put ` +
						`${kpi?.label ?? measurePhrase} on a timeline.`,
					proposals: [
						{
							kind: "combination",
							title: `${timeType.label} with ${humanize(date.sqlColumn)}`,
							summary: `${timeType.pluralLabel ?? timeType.label}, each with its ${reachable.t.label.toLowerCase()}'s ${date.sqlColumn}.`,
							payload: {
								name: `${timeType.label} ${humanize(date.sqlColumn)}`.slice(0, 60),
								base: timeType.apiName,
								joins: [{ path: reachable.path!.map((l) => l.apiName), fields: [date.sqlColumn] }],
								derived: [],
							},
							dependsOn: [],
						},
					],
				};
			}
			return {
				request,
				status: "not_possible",
				explanation: `${timeType.pluralLabel ?? timeType.label} have no date, and nothing they link to has one, so there is no timeline to put ${measurePhrase || "them"} on.`,
				missing: [`a date on ${timeType.label} or on something it links to`],
				alternatives: [],
			};
		}
	}

	// 3. Revenue that no column holds: derive it from price and quantity.
	if (!kpi && !measureProperty && tokens(measurePhrase).includes("revenue")) {
		const recipe = revenueRecipe();
		if (recipe) {
			const joins: Array<Record<string, unknown>> = [];
			if (dimensionProperty && dimensionProperty.type.rid !== recipe.type.rid) {
				const path = linkPath(recipe.type, dimensionProperty.type);
				if (!path) {
					return {
						request,
						status: "not_possible",
						explanation: `Revenue can be derived on ${recipe.type.label} (\`${recipe.expression}\`), but ${recipe.type.label} has no chain of links to ${dimensionProperty.type.label}.`,
						missing: [`a link from ${recipe.type.label} towards ${dimensionProperty.type.label}`],
						alternatives: [`revenue by ${humanize(dimensionsOf(recipe.type)[0] ?? "month").toLowerCase()}`],
					};
				}
				joins.push({ path: path.map((l) => l.apiName), fields: [dimensionProperty.property.sqlColumn] });
			}
			if (wantsTime && !recipe.type.properties.some((p) => p.semanticRole === "temporal")) {
				const dated = registry.objectTypes.find((t) => t.properties.some((p) => p.semanticRole === "temporal") && linkPath(recipe.type, t)?.length);
				const path = dated ? linkPath(recipe.type, dated) : null;
				const date = dated?.properties.find((p) => p.semanticRole === "temporal");
				if (path && date && !joins.some((j) => (j.path as string[]).join() === path.map((l) => l.apiName).join())) {
					joins.push({ path: path.map((l) => l.apiName), fields: [date.sqlColumn] });
				}
			}
			return {
				request,
				status: "needs_approval",
				explanation:
					`No column holds revenue, but ${recipe.type.pluralLabel ?? recipe.type.label} carry what it is made of: ` +
					`\`${recipe.expression}\`. Approving the combined dataset below derives it per row` +
					(joins.length ? " and brings in what it is sliced by" : "") +
					"; its total-revenue metric is created with it.",
				proposals: [
					{
						kind: "combination",
						title: `${recipe.type.label} with revenue`,
						summary: `${recipe.type.pluralLabel ?? recipe.type.label} with revenue = \`${recipe.expression}\`.`,
						payload: {
							name: `${recipe.type.label} Revenue`,
							base: recipe.type.apiName,
							joins,
							derived: [{ name: recipe.name, expression: recipe.expression }],
						},
						dependsOn: [],
					},
				],
			};
		}
	}

	// 4. Nothing to measure.
	if (!kpi && !measureProperty && !countedType) {
		const sample = registry.kpis.slice(0, 8).map((k) => k.label);
		return {
			request,
			status: "not_possible",
			explanation: `Nothing in this workspace's data looks like "${measurePhrase}".`,
			missing: [`a table or column holding ${measurePhrase || "that figure"}`],
			alternatives: sample,
		};
	}

	// 5. A measure with no metric yet: propose one.
	if (!kpi && measureProperty) {
		const agg = aggregation && ["sum", "avg", "min", "max", "count_distinct"].includes(aggregation)
			? aggregation
			: measureProperty.property.defaultAggregation ?? "sum";
		const metric: DraftProposal = {
			kind: "metric",
			title: `${{ sum: "Total", avg: "Average", min: "Lowest", max: "Highest", count_distinct: "Distinct" }[agg] ?? "Total"} ${measureProperty.property.label}`,
			summary: `${agg} of ${measureProperty.type.apiName}.${measureProperty.property.sqlColumn}.`,
			payload: { objectType: measureProperty.type.apiName, aggregation: agg, measure: measureProperty.property.sqlColumn },
			dependsOn: [],
		};
		if (!dimensionProperty || dimensionProperty.type.rid === measureProperty.type.rid) {
			return {
				request,
				status: "needs_approval",
				explanation: `${measureProperty.type.label}.${measureProperty.property.label} exists, but no metric takes its ${agg} yet. Approve the metric below and it can be charted.`,
				proposals: [metric],
			};
		}
	}

	const metricType = measureType;
	if (!metricType) {
		return { request, status: "not_possible", explanation: "The measure could not be placed on an object type.", missing: [] };
	}

	// 6. Same type: ready, or ready once the dimension is allowed.
	if (!dimensionProperty) {
		if (kpi) return readyItem(request, kpi, null);
	} else if (dimensionProperty.type.rid === metricType.rid && kpi) {
		const key = dimensionKey(dimensionProperty.property, request.grain ?? null);
		if (kpi.dimensions.includes(key)) {
			const ready = readyItem(request, kpi, key);
			if (request.grain && !key.includes(":")) {
				ready.explanation += ` A chart slices one way at a time, so this is by ${dimensionProperty.property.label.toLowerCase()}; ask for it "by ${request.grain}" for the timeline.`;
			}
			return ready;
		}
		return {
			request,
			status: "needs_approval",
			explanation: `${kpi.label} exists but cannot yet be sliced by ${dimensionProperty.property.label.toLowerCase()}. Approve a version of the metric that can.`,
			proposals: [
				{
					kind: "metric",
					title: `${kpi.label} by ${dimensionProperty.property.label}`,
					summary: `Same definition as ${kpi.apiName}, sliceable by ${dimensionProperty.property.sqlColumn}.`,
					payload: {
						objectType: metricType.apiName,
						aggregation: kpi.aggregation,
						measure: kpi.measureColumn,
						numerator: kpi.numeratorColumn,
						denominator: kpi.denominatorColumn,
						label: `${kpi.label} by ${dimensionProperty.property.label}`,
						extraDimensions: [key],
					},
					dependsOn: [],
				},
			],
		};
	}

	// 7. Different types: join along links, or propose the link first.
	if (dimensionProperty && dimensionProperty.type.rid !== metricType.rid) {
		const target = dimensionProperty.type;

		// Already combined? A combination carries every column of its base and
		// the joined field under "<target>_<column>". Answer from it rather than
		// proposing the same dataset twice.
		const prefix = `${snake(target.apiName)}_`;
		const joinedName = dimensionProperty.property.sqlColumn.startsWith(prefix)
			? dimensionProperty.property.sqlColumn
			: `${prefix}${dimensionProperty.property.sqlColumn}`;
		const combined = registry.objectTypes.find(
			(t) =>
				t.origin === "combination" &&
				t.propertyBySqlColumn.has(joinedName) &&
				metricType.properties.every((p) => t.propertyBySqlColumn.has(p.sqlColumn)),
		);
		if (combined) {
			const joined = combined.propertyBySqlColumn.get(joinedName)!;
			const key = dimensionKey(joined, request.grain ?? null);
			const wantedMeasure = kpi?.measureColumn ?? measureProperty?.property.sqlColumn ?? null;
			const wantedAggregation = aggregation ?? kpi?.aggregation ?? (wantedMeasure ? "sum" : "count");
			const onCombined = registry.kpis.find(
				(k) =>
					k.objectTypeRid === combined.rid &&
					k.aggregation === wantedAggregation &&
					(k.measureColumn ?? null) === (wantedAggregation === "count" ? null : wantedMeasure),
			);
			if (onCombined && onCombined.dimensions.includes(key)) {
				return readyItem(request, onCombined, key);
			}
			return {
				request,
				status: "needs_approval",
				explanation: `${combined.label} already joins ${metricType.label} to ${target.label}; it needs a metric for this before it can be charted by ${joined.label.toLowerCase()}.`,
				proposals: [
					{
						kind: "metric",
						title: `${wantedAggregation === "count" ? combined.pluralLabel ?? combined.label : humanize(wantedMeasure ?? "")} by ${joined.label}`,
						summary: `${wantedAggregation} on ${combined.apiName}, sliceable by ${joined.sqlColumn}.`,
						payload: {
							objectType: combined.apiName,
							aggregation: wantedAggregation,
							measure: wantedAggregation === "count" ? null : wantedMeasure,
							extraDimensions: [key],
						},
						dependsOn: [],
					},
				],
			};
		}
		const path = linkPath(metricType, target);
		const proposals: DraftProposal[] = [];
		let joinPath: string[] | null = path ? path.map((l) => l.apiName) : null;
		if (!path) {
			const link = await proposeJoinKey(metricType, target);
			if (!link) {
				const inverse = linkPath(target, metricType);
				return {
					request,
					status: "not_possible",
					explanation: inverse
						? `${target.label} links to ${metricType.label}, not the other way round, so each ${target.label.toLowerCase()} has many ${metricType.pluralLabel?.toLowerCase() ?? "rows"}. Measure on ${target.label} instead, or name the column that ties one ${metricType.label.toLowerCase()} to one ${target.label.toLowerCase()}.`
						: `Nothing links ${metricType.pluralLabel ?? metricType.label} to ${target.pluralLabel ?? target.label}, and no column of one matches the other's key.`,
					missing: [`a link from ${metricType.label} to ${target.label}`],
					alternatives: dimensionsOf(metricType).filter((d) => !d.includes(":")).slice(0, 5).map((d) => `${kpi?.label ?? measurePhrase} by ${humanize(d).toLowerCase()}`),
				};
			}
			proposals.push(link);
			joinPath = [String(link.payload.apiName)];
		}
		const fields = [dimensionProperty.property.sqlColumn];
		const comboName = `${metricType.label} ${target.label} ${humanize(dimensionProperty.property.sqlColumn)}`.slice(0, 60);
		proposals.push({
			kind: "combination",
			title: `${metricType.pluralLabel ?? metricType.label} with ${target.label} ${dimensionProperty.property.label}`,
			summary: `${metricType.pluralLabel ?? metricType.label}, each with its ${target.label.toLowerCase()}'s ${dimensionProperty.property.label.toLowerCase()}, so ${kpi?.label ?? measurePhrase} can be sliced by it.`,
			payload: {
				name: comboName,
				base: metricType.apiName,
				joins: [{ path: joinPath, fields }],
				derived: [],
			},
			dependsOn: proposals.length ? [0] : [],
		});
		// The combined dataset is modelled with a count and the default sum or
		// average of each measure. Anything else (an average of a summed
		// measure, a highest, a distinct count) is chained on as its own metric.
		const measureColumn = kpi?.measureColumn ?? measureProperty?.property.sqlColumn ?? null;
		const defaultAggregation = measureProperty?.property.defaultAggregation ?? "sum";
		if (measureColumn && aggregation && aggregation !== "count" && aggregation !== defaultAggregation) {
			const prefix = `${snake(target.apiName)}_`;
			const joined = dimensionProperty.property.sqlColumn.startsWith(prefix)
				? dimensionProperty.property.sqlColumn
				: `${prefix}${dimensionProperty.property.sqlColumn}`;
			proposals.push({
				kind: "metric",
				title: `${{ avg: "Average", min: "Lowest", max: "Highest", count_distinct: "Distinct", sum: "Total" }[aggregation] ?? "Total"} ${humanize(measureColumn)} by ${dimensionProperty.property.label}`,
				summary: `${aggregation} of ${measureColumn} on the combined dataset.`,
				payload: {
					objectType: comboName.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(""),
					aggregation,
					measure: measureColumn,
					extraDimensions: [joined],
				},
				dependsOn: [proposals.length - 1],
			});
		}
		return {
			request,
			status: "needs_approval",
			explanation:
				(path
					? `${metricType.label} reaches ${target.label} through ${path.map((l) => l.apiName).join(" → ")}, but no dataset joins them yet. `
					: `${metricType.label} and ${target.label} are not linked; the link below matches them on their data. `) +
				"Approve and the combined dataset is created with its metrics, sliceable by " +
				`${dimensionProperty.property.label.toLowerCase()}.`,
			proposals,
		};
	}

	return { request, status: "not_possible", explanation: "This request could not be resolved against the ontology.", missing: [] };
}

// ── analysis datasets ───────────────────────────────────────────────────────
//
//  A board needs a timeline and a few ways to slice its main figure. When the
//  type a request is about has neither - order lines whose date and customer
//  live one or two links away - the answer is one wide dataset: the fact rows
//  with the date, name and main categories of everything they point at. It is
//  a combination like any other, so it waits for approval, and the board the
//  person asked for is built from it the moment it is approved.

const CONTACT_LIKE = /(address|street|postal|zip|phone|fax|url|email|homepage|photo|picture|notes|password|token|extension|contact_|job_title|title_of_courtesy|salutation)/i;

function dimensionRank(property: PropertyMeta): number {
	const column = property.sqlColumn.toLowerCase();
	if (/country|region|state|territory|province/.test(column)) return 0;
	if (/category|type|segment|class|kind|status|tier|channel|group/.test(column)) return 1;
	if (/city/.test(column)) return 2;
	return 3;
}

/** What a linked type contributes: its main date, its name, its main categories. */
export function carriedFields(type: ObjectTypeMeta): string[] {
	const fields: string[] = [];
	const dates = type.properties
		.filter((p) => p.semanticRole === "temporal" && !/(birth|hire|modified|updated|created)/i.test(p.sqlColumn))
		.sort((a, b) => a.displayOrder - b.displayOrder);
	fields.push(...dates.slice(0, 2).map((p) => p.sqlColumn));
	// A name says which customer or product; an event (anything dated) has
	// no name worth ranking by, only its date and categories.
	const title = dates.length === 0
		? type.properties.find((p) => p.isTitle && !CONTACT_LIKE.test(p.sqlColumn) && p.sqlColumn !== type.primaryKeyColumn)
		: undefined;
	if (title) fields.push(title.sqlColumn);
	const dimensions = type.properties
		.filter(
			(p) =>
				p.semanticRole === "dimension" &&
				!CONTACT_LIKE.test(p.sqlColumn) &&
				p.sqlColumn !== title?.sqlColumn &&
				// Text categories: a numeric "level" groups badly next to names.
				!/int|numeric|double|real|decimal/.test((p.sqlType ?? "").toLowerCase()),
		)
		.sort((a, b) => dimensionRank(a) - dimensionRank(b) || a.displayOrder - b.displayOrder);
	fields.push(...dimensions.slice(0, 2).map((p) => p.sqlColumn));
	return [...new Set(fields)];
}

/**
 * Every type a fact type reaches along many-to-one links (two hops), with
 * what each contributes. Many-to-one only, so the dataset keeps one row per
 * fact row and every total over it stays true.
 */
export function analysisJoins(base: ObjectTypeMeta, maxHops = 2): Array<{ path: string[]; fields: string[]; target: ObjectTypeMeta }> {
	const registry = getRegistry();
	const joins: Array<{ path: string[]; fields: string[]; target: ObjectTypeMeta }> = [];
	const seen = new Set([base.rid]);
	const queue: Array<{ type: ObjectTypeMeta; path: string[] }> = [{ type: base, path: [] }];
	while (queue.length > 0 && joins.length < 8) {
		const { type, path } = queue.shift()!;
		if (path.length >= maxHops) continue;
		for (const link of registry.linksBySourceRid.get(type.rid) ?? []) {
			if (link.cardinality !== "MANY_TO_ONE" && link.cardinality !== "ONE_TO_ONE") continue;
			const target = registry.objectTypeByRid.get(link.targetObjectType);
			if (!target || seen.has(target.rid) || target.origin === "combination") continue;
			seen.add(target.rid);
			const nextPath = [...path, link.apiName];
			const fields = carriedFields(target);
			if (fields.length > 0) joins.push({ path: nextPath, fields, target });
			queue.push({ type: target, path: nextPath });
		}
	}
	return joins.slice(0, 8);
}

/** "Enriched Order": the wide dataset an earlier approval made of `type`. */
function enrichedOf(type: ObjectTypeMeta): ObjectTypeMeta | null {
	return (
		getRegistry().objectTypes.find(
			(t) => t.origin === "combination" && /^enriched\s/i.test(t.label) && namesTypeExactly(t.label.replace(/^enriched\s+/i, ""), type),
		) ?? null
	);
}

/**
 * A dataset name no type has taken yet - "Order Timing", then "Order Timing 2" -
 * checked against the type name approving it would create.
 */
function freeDatasetName(base: string): string {
	const taken = getRegistry().objectTypeByApiName;
	let name = base.slice(0, 60);
	for (let n = 2; taken.has(pascal(name)); n += 1) name = `${base.slice(0, 56)} ${n}`;
	return name;
}

function titleCase(text: string): string {
	return text.replace(/\b([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The analysis dataset for a board on `topic`, or null when the fact type
 * reaches nothing worth carrying in.
 */
function analysisDataset(
	topic: string,
	intent: "dashboard" | "report",
	boardTitle: string,
	sourcePrompt: string,
): { item: FeasibilityItem } | null {
	const topicTokens = tokens(topic);
	const recipe = topicTokens.includes("revenue") ? revenueRecipe() : null;
	const measureMatch = recipe ? null : topic ? matchProperty(topic, ["measure"], null) : null;
	const named = topic ? matchType(topic) : null;
	// The type a topic names outranks a property that merely shares a word
	// with it: "orders" is Order, not Product's units on order.
	const namedWins = named !== null && (!measureMatch || overlap(topicTokens, typeTokens(named)) >= measureMatch.score);
	const base =
		recipe?.type ??
		(namedWins ? named : null) ??
		(measureMatch && measureMatch.type.origin !== "combination" ? measureMatch.type : null) ??
		named ??
		pickSubject("");
	// Already enriched by an earlier approval: the board is built on that.
	if (!base || (!recipe && enrichedOf(base))) return null;
	const joins = analysisJoins(base);
	const hasOwnDate = base.properties.some((p) => p.semanticRole === "temporal");
	const joinedDate = joins.some((j) => j.target.properties.some((p) => j.fields.includes(p.sqlColumn) && p.semanticRole === "temporal"));
	if (joins.length === 0 || (!hasOwnDate && !joinedDate && joins.length < 2)) return null;

	// "Sales Order Detail" for a figure; "Enriched Product" when the topic is
	// the type itself (or there is none).
	const topicIsType = !topic || overlap(tokens(topic), typeTokens(base)) > 0;
	const name = freeDatasetName(topicIsType ? `Enriched ${base.label}` : `${titleCase(topic)} ${base.label}`);
	const measure = recipe?.name ?? measureMatch?.property.sqlColumn ?? null;
	const carried = joins.map((j) => `${j.target.label.toLowerCase()} (${j.fields.map((f) => humanize(f).toLowerCase()).join(", ")})`);
	const proposal: DraftProposal = {
		kind: "combination",
		title: `New dataset: ${name}`,
		summary:
			`${base.pluralLabel ?? plural(base.label)}, one row each, with ` +
			carried.join("; ") +
			(recipe ? `, and revenue = \`${recipe.expression}\`` : "") +
			`. Approve it and the ${intent} "${boardTitle}" is built from it.`,
		payload: {
			name,
			base: base.apiName,
			joins: joins.map((j) => ({ path: j.path, fields: j.fields })),
			derived: recipe ? [{ name: recipe.name, expression: recipe.expression }] : [],
		},
		dependsOn: [],
		followUp: { build: intent, title: boardTitle, measure, sourcePrompt },
	};
	return {
		item: {
			request: { text: sourcePrompt, measure: topic || undefined },
			status: "needs_approval",
			explanation:
				`To build "${boardTitle}" properly, ${base.pluralLabel?.toLowerCase() ?? plural(base.label.toLowerCase())} need what they point at in one place: ` +
				carried.join("; ") +
				(recipe ? `, with revenue worked out as \`${recipe.expression}\`` : "") +
				`. That is one new dataset (nothing in your database changes). Approve it and the ${intent} is built straight away - ` +
				"headline figures, a monthly timeline and the main breakdowns.",
			proposals: [proposal],
		},
	};
}

// ── links and combinations asked for by name ────────────────────────────────
//
//  "Link orders to shippers", "connect invoices and customers on cust_ref",
//  "combine order details with their products and categories". The types are
//  read from the words, the key is found in the data (or taken from the
//  request), and the result is a proposal - never an applied change.

const FILLER =
	/\b(please|can|could|would|you|i|we|want|wanna|like|need|create|add|make|build|set|up|a|an|the|new|my|our|their|its|of|for|me|us)\b/g;

/**
 * Split a request into the phrases between connectives, each cleaned of
 * `noise`. Each phrase comes in two forms: as written (so "us states" can
 * name the US State type) and without filler words ("my orders" -> "orders").
 */
function phrasesOf(text: string, separators: RegExp, noise: RegExp): Array<{ raw: string; clean: string }> {
	return text
		.toLowerCase()
		.split(separators)
		.map((part) => {
			const raw = part.replace(noise, " ").replace(/\s+/g, " ").trim();
			return { raw, clean: raw.replace(FILLER, " ").replace(/\s+/g, " ").trim() };
		})
		.filter((phrase) => phrase.clean || phrase.raw);
}

/** Distinct object types named in a phrase list, in the order named. */
function namedTypes(phrases: Array<{ raw: string; clean: string }>): ObjectTypeMeta[] {
	const registry = getRegistry();
	const out: ObjectTypeMeta[] = [];
	for (const phrase of phrases) {
		// The trailing words as written first ("i want to see us states" ends in
		// a type name), then the cleaned phrase through the usual matching.
		const rawWords = phrase.raw.split(" ");
		let type: ObjectTypeMeta | null = null;
		for (let start = 0; start < rawWords.length && !type; start += 1) {
			const tail = rawWords.slice(start).join(" ");
			type = registry.objectTypes.find((candidate) => namesTypeExactly(tail, candidate)) ?? null;
		}
		type = type ?? (phrase.clean ? matchType(phrase.clean) : null);
		if (type && !out.some((t) => t.rid === type!.rid)) out.push(type);
	}
	return out;
}

/**
 * A key that joins `source` to `target` found by its values: an identifier
 * column of the source whose values are (almost) all keys of the target.
 * Only identifier columns are tried - a quantity of 1 to 3 would "match"
 * three shipper ids perfectly and mean nothing.
 */
async function joinKeyByValues(source: ObjectTypeMeta, target: ObjectTypeMeta): Promise<DraftProposal | null> {
	const key = target.properties.find((p) => p.sqlColumn === target.primaryKeyColumn);
	if (!key || !target.keyIsUnique) return null;
	const registry = getRegistry();
	const linked = new Set((registry.linksBySourceRid.get(source.rid) ?? []).map((link) => link.sourceColumn));
	const candidates = source.properties
		.filter(
			(p) =>
				p.semanticRole === "identity" &&
				p.sqlColumn !== source.primaryKeyColumn &&
				// Already a reference to something else.
				!linked.has(p.sqlColumn) &&
				// Named for another type (category_id is a category, whatever
				// employee ids its values happen to fall within).
				!registry.objectTypes.some((other) => {
					if (other.rid === target.rid) return false;
					const stem = p.sqlColumn.replace(/_(id|key|code|no|number|ref)$/i, "");
					return stem !== p.sqlColumn && namesTypeExactly(stem.replace(/_/g, " "), other);
				}),
		)
		.slice(0, 8);
	let best: { property: PropertyMeta; ratio: number; matched: number } | null = null;
	for (const property of candidates) {
		const measured = await measureLinkNow(source.sourceView, property.sqlColumn, target.sourceView, key.sqlColumn).catch(() => null);
		if (measured && measured.ratio >= 0.9 && (!best || measured.ratio > best.ratio)) {
			best = { property, ratio: measured.ratio, matched: measured.matched };
		}
	}
	if (!best) return null;
	const role = best.property.sqlColumn.replace(/_(id|key|code|no|number|ref)$/i, "").split("_").filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || target.apiName;
	return {
		kind: "link_type",
		title: `Link ${source.label} to ${target.label}`,
		summary: `${source.apiName}.${best.property.sqlColumn} holds ${target.apiName} keys: ${(best.ratio * 100).toFixed(1)}% of its values resolve.`,
		payload: {
			source: source.apiName,
			sourceProperty: best.property.sqlColumn,
			target: target.apiName,
			targetProperty: key.sqlColumn,
			apiName: `${source.apiName[0]!.toLowerCase()}${source.apiName.slice(1)}${role}`,
		},
		dependsOn: [],
	};
}

/** Any way to draft a link from `source` to `target`: by name, then by values. */
async function draftJoin(source: ObjectTypeMeta, target: ObjectTypeMeta): Promise<DraftProposal | null> {
	return (await proposeJoinKey(source, target)) ?? (await joinKeyByValues(source, target));
}

function existingLink(a: ObjectTypeMeta, b: ObjectTypeMeta): LinkTypeMeta | undefined {
	return getRegistry().linkTypes.find(
		(link) =>
			(link.sourceObjectType === a.rid && link.targetObjectType === b.rid) ||
			(link.sourceObjectType === b.rid && link.targetObjectType === a.rid),
	);
}

export async function linkRequest(text: string): Promise<FeasibilityItem> {
	const request: FeasibilityRequest = { text };
	const lowered = ` ${text.toLowerCase()} `;
	// "... on ship_via", "... using cust_ref = customer_id"
	const on = /\b(?:on|using|via|where)\s+([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?(?:\s*=\s*([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?)?/.exec(lowered);
	const types = namedTypes(
		phrasesOf(
			on ? lowered.replace(on[0], " ") : lowered,
			/\bto\b|\bwith\b|\band\b|,|&/,
			/\b(link|links|linked|connect|connected|relate|related|relationship|relationships|associate|map|between|from)\b/g,
		),
	);
	const registry = getRegistry();
	if (types.length < 2) {
		return {
			request,
			status: "not_possible",
			explanation:
				types.length === 1
					? `I found ${types[0]!.label} in that, but not what to link it to. Name the other type - for example "link ${types[0]!.pluralLabel?.toLowerCase() ?? types[0]!.label.toLowerCase()} to ${registry.objectTypes.find((t) => t.rid !== types[0]!.rid)?.pluralLabel?.toLowerCase() ?? "customers"}".`
					: "Name the two object types to link - for example \"link orders to customers\".",
			missing: ["two object types to link"],
			alternatives: registry.objectTypes.slice(0, 6).map((t) => t.pluralLabel ?? t.label),
		};
	}
	const [source, target] = types as [ObjectTypeMeta, ObjectTypeMeta];
	const existing = existingLink(source, target);
	if (existing) {
		return {
			request,
			status: "ready",
			explanation:
				`${source.label} and ${target.label} are already linked by ${existing.apiName} ` +
				`(${(existing.matchRatio * 100).toFixed(1)}% of rows resolve). You can slice by it, follow it in the explorer, or combine the two into one dataset.`,
		};
	}

	let draft: DraftProposal | null = null;
	if (on) {
		// The person named the column: use it, on whichever side holds it.
		const sourceColumn = on[2] ?? on[1]!;
		const targetColumn = on[4] ?? on[3] ?? null;
		const sides: Array<[ObjectTypeMeta, ObjectTypeMeta]> = [[source, target], [target, source]];
		for (const [from, to] of sides) {
			const property = from.propertyBySqlColumn.get(sourceColumn) ?? from.properties.find((p) => p.apiName.toLowerCase() === sourceColumn);
			if (!property) continue;
			const toKey = targetColumn
				? (to.propertyBySqlColumn.get(targetColumn) ?? null)
				: (to.properties.find((p) => p.sqlColumn === to.primaryKeyColumn) ?? null);
			if (!toKey) continue;
			const measured = await measureLinkNow(from.sourceView, property.sqlColumn, to.sourceView, toKey.sqlColumn).catch(() => null);
			if (!measured || measured.matched === 0) {
				return {
					request,
					status: "not_possible",
					explanation: `None of the values in ${from.apiName}.${property.sqlColumn} match ${to.apiName}.${toKey.sqlColumn}, so a link on that column would connect nothing.`,
					missing: [`a column of ${from.label} whose values are ${to.label} keys`],
				};
			}
			draft = {
				kind: "link_type",
				title: `Link ${from.label} to ${to.label}`,
				summary: `${from.apiName}.${property.sqlColumn} = ${to.apiName}.${toKey.sqlColumn}: ${(measured.ratio * 100).toFixed(1)}% of rows resolve.`,
				payload: { source: from.apiName, sourceProperty: property.sqlColumn, target: to.apiName, targetProperty: toKey.sqlColumn },
				dependsOn: [],
			};
			break;
		}
		if (!draft) {
			return {
				request,
				status: "not_possible",
				explanation: `Neither ${source.label} nor ${target.label} has a column called ${sourceColumn}.`,
				missing: [`the column ${sourceColumn}`],
				alternatives: [...source.properties, ...target.properties].filter((p) => p.semanticRole === "identity").slice(0, 6).map((p) => p.sqlColumn),
			};
		}
	} else {
		draft = (await draftJoin(source, target)) ?? (await draftJoin(target, source));
	}
	if (!draft) {
		const key = target.properties.find((p) => p.sqlColumn === target.primaryKeyColumn);
		return {
			request,
			status: "not_possible",
			explanation:
				`No column of ${source.label} holds ${target.label} keys${key ? ` (${key.sqlColumn})` : ""}, by name or by value. ` +
				`If one does under another name, say which: "link ${source.pluralLabel?.toLowerCase() ?? source.label.toLowerCase()} to ${target.pluralLabel?.toLowerCase() ?? target.label.toLowerCase()} on <column>".`,
			missing: [`a column of ${source.label} that refers to ${target.label}`],
		};
	}
	return {
		request,
		status: "needs_approval",
		explanation: `${draft.summary} Approve the link and ${source.pluralLabel?.toLowerCase() ?? source.label.toLowerCase()} can be sliced by anything about their ${target.label.toLowerCase()}.`,
		proposals: [draft],
	};
}

export async function combinationRequest(text: string): Promise<FeasibilityItem> {
	const request: FeasibilityRequest = { text };
	const named = namedTypes(
		phrasesOf(
			text,
			/\bwith\b|\band\b|\bplus\b|\bto\b|,|&/,
			/\b(combine|combined|enrich|enriched|merge|merged|join|joined|into|one|single|dataset|data|set|table|view|info|information|fields|columns|attributes|everything|all|bring|in)\b/g,
		),
	);
	if (named.length === 0) {
		return {
			request,
			status: "not_possible",
			explanation: "Name the type to start from and what to bring in - for example \"combine orders with their customers\".",
			missing: ["an object type to combine"],
			alternatives: getRegistry().objectTypes.slice(0, 6).map((t) => t.pluralLabel ?? t.label),
		};
	}
	let base = named[0]!;
	let targets = named.slice(1);
	const notes: string[] = [];
	// "Combine customers with their orders": one customer has many orders, so
	// the rows to keep are the orders. Turned around rather than refused.
	if (targets.length === 1 && !linkPath(base, targets[0]!) && linkPath(targets[0]!, base)) {
		notes.push(`Each ${base.label.toLowerCase()} has many ${targets[0]!.pluralLabel?.toLowerCase() ?? targets[0]!.label.toLowerCase()}, so the dataset keeps one row per ${targets[0]!.label.toLowerCase()} and brings the ${base.label.toLowerCase()} in.`);
		[base, targets] = [targets[0]!, [base]];
	}
	const proposals: DraftProposal[] = [];
	const joins: Array<{ path: string[]; fields: string[]; target: ObjectTypeMeta }> = [];
	if (targets.length === 0) {
		joins.push(...analysisJoins(base));
	}
	for (const target of targets) {
		const path = linkPath(base, target);
		const fields = carriedFields(target);
		if (fields.length === 0) {
			notes.push(`${target.label} has no dates, names or categories to bring in.`);
			continue;
		}
		if (path && path.length > 0) {
			joins.push({ path: path.map((l) => l.apiName), fields, target });
			continue;
		}
		const link = await draftJoin(base, target);
		if (!link) {
			notes.push(`${base.label} has no column that refers to ${target.label}, so it cannot be brought in yet.`);
			continue;
		}
		const apiName = String(link.payload.apiName ?? `${base.apiName[0]!.toLowerCase()}${base.apiName.slice(1)}${target.apiName}`);
		link.payload.apiName = apiName;
		proposals.push(link);
		joins.push({ path: [apiName], fields, target });
	}
	if (joins.length === 0) {
		return {
			request,
			status: "not_possible",
			explanation: notes.join(" ") || `${base.label} links to nothing that could be brought in.`,
			missing: ["a link to bring the other type in"],
		};
	}
	const name = freeDatasetName(`Enriched ${base.label}`);
	const carried = joins.map((j) => `${j.target.label.toLowerCase()} (${j.fields.map((f) => humanize(f).toLowerCase()).join(", ")})`);
	proposals.push({
		kind: "combination",
		title: `New dataset: ${name}`,
		summary: `${base.pluralLabel ?? plural(base.label)}, one row each, with ${carried.join("; ")}.`,
		payload: { name, base: base.apiName, joins: joins.map((j) => ({ path: j.path, fields: j.fields })), derived: [] },
		dependsOn: proposals.map((_, index) => index),
	});
	return {
		request,
		status: "needs_approval",
		explanation:
			`${notes.length ? `${notes.join(" ")} ` : ""}One new dataset: ${base.pluralLabel?.toLowerCase() ?? plural(base.label.toLowerCase())} with ${carried.join("; ")}. ` +
			"It is a view over your synced tables (nothing in your database changes), modelled with its own metrics once approved.",
		proposals,
	};
}

// ── dashboards and capabilities ─────────────────────────────────────────────

/** Whether one of a type's categories holds one of `values` ("Germany"). */
async function holdsValue(type: ObjectTypeMeta, values: string[]): Promise<boolean> {
	const columns = type.properties.filter((p) => p.semanticRole === "dimension" || p.semanticRole === "title").slice(0, 12);
	if (columns.length === 0 || values.length === 0) return false;
	const candidates = [...new Set([values.join(" "), ...values])].map((v) => v.toLowerCase());
	try {
		const checks = columns.map((p) => `lower(${quoteIdentifier(p.sqlColumn)}::text) = ANY($1::text[])`).join(" OR ");
		const rows = await query(`SELECT 1 FROM ${quoteQualified(type.sourceView)} WHERE ${checks} LIMIT 1`, [candidates]);
		return rows.length > 0;
	} catch {
		return false;
	}
}

async function cardinality(type: ObjectTypeMeta, column: string): Promise<number> {
	try {
		const [row] = await query<{ n: string }>(
			`SELECT count(DISTINCT ${quoteIdentifier(column)})::text AS n FROM ${quoteQualified(type.sourceView)}`,
		);
		return Number(row?.n ?? 0);
	} catch {
		return 0;
	}
}

/** The most useful type to build a board around: the one with the most to measure and slice. */
export function pickSubject(text: string): ObjectTypeMeta | null {
	const registry = getRegistry();
	const named = text ? matchType(text) : null;
	if (named) return named;
	const scored = registry.objectTypes
		.map((type) => ({
			type,
			score:
				registry.kpis.filter((k) => k.objectTypeRid === type.rid).length * 2 +
				type.properties.filter((p) => p.semanticRole === "temporal").length * 3 +
				(registry.linksBySourceRid.get(type.rid)?.length ?? 0) * 2 +
				Math.log10(Math.max(type.rowCount, 1)),
		}))
		.sort((a, b) => b.score - a.score);
	return scored[0]?.type ?? null;
}

/**
 * Lay out a board from the metrics a type already has: headline numbers
 * across the top, its timeline, then its strongest slices. Only READY widgets
 * go on it; what would need approval is returned separately.
 */
export async function planBoard(
	subject: ObjectTypeMeta,
	options: { measure?: string | null } = {},
): Promise<{ layout: Widget[]; items: FeasibilityItem[] }> {
	const registry = getRegistry();
	const metrics = registry.kpis.filter((k) => k.objectTypeRid === subject.rid);
	const layout: Widget[] = [];
	const items: FeasibilityItem[] = [];
	const count = metrics.find((k) => k.aggregation === "count");
	// The figure the board was asked for leads it: a sales board opens on revenue.
	const lead = options.measure
		? metrics.find((k) => k.measureColumn === options.measure && k.aggregation === "sum") ??
			metrics.find((k) => k.measureColumn === options.measure)
		: undefined;
	// Figures someone named when approving them (an on-time rate, late
	// orders) come before the ones modelling made on its own.
	const named = metrics.filter(
		(k) => k !== lead && k !== count && k.origin === "proposal" && Object.keys(k.baseFilters ?? {}).length === 0,
	);
	// A rate leads with its companions (other averages) before totals.
	const rateLed = lead !== undefined && !isAdditive(lead);
	const sums = [
		...(lead ? [lead] : []),
		...named,
		...metrics
			.filter((k) => k !== lead && !named.includes(k) && (k.aggregation === "sum" || k.aggregation === "avg"))
			.sort((a, b) => (rateLed ? Number(a.aggregation !== lead!.aggregation) - Number(b.aggregation !== lead!.aggregation) : 0)),
	].slice(0, 4);
	const distinct = lead ? metrics.find((k) => k.aggregation === "count_distinct") : undefined;
	const headline = (lead ? [lead, ...named, rateLed ? undefined : distinct ?? count, ...sums.slice(1)] : [count, ...sums])
		.filter((k, index, all): k is KpiMeta => Boolean(k) && all.indexOf(k) === index)
		.slice(0, 4);
	for (const kpi of headline) {
		layout.push({ type: "stat", kpi: kpi.apiName, title: kpi.label, width: 1 });
		items.push(readyItem({ measure: kpi.label }, kpi, null));
	}
	// Fill the stat row to four so the grid stays even.
	while (layout.length > 0 && layout.length < 4) {
		const extra = metrics.find((k) => !layout.some((w) => w.kpi === k.apiName) && k.aggregation === "count_distinct");
		if (!extra) break;
		layout.push({ type: "stat", kpi: extra.apiName, title: extra.label, width: 1 });
	}
	if (layout.length % 4 !== 0) layout[layout.length - 1]!.width = 1 + (4 - (layout.length % 4));

	// Without a figure asked for, the board is about the things themselves:
	// "Orders per month", "Orders by country" - not whichever total comes first.
	const primary = lead ?? count ?? sums.find((k) => k.aggregation === "sum");
	if (primary?.timeColumn) {
		const dimension = `${primary.timeColumn}:month`;
		if (primary.dimensions.includes(dimension)) {
			layout.push({ type: "chart", kpi: primary.apiName, dimension, chart: "area", sort: "dimension_asc", title: `${primary.label} per month`, width: 4 });
		}
	}
	if (primary) {
		const categorical = primary.dimensions.filter((d) => !d.includes(":"));
		const measured = await Promise.all(
			categorical.slice(0, 24).map(async (d) => ({ d, n: await cardinality(subject, d), family: family(d) })),
		);
		// Contact details (a contact's job title, a phone) slice nothing useful.
		const useful = measured.filter((x) => x.n >= 2 && !CONTACT_LIKE.test(x.d));
		// A share of a small whole reads best as a donut: who carried it, which
		// channel - a place is better ranked than pied.
		// An average is not a share of anything, so it is compared in bars.
		const donut = useful
			.filter((x) => x.n <= 4)
			.sort((a, b) => Number(a.family === "where") - Number(b.family === "where") || a.n - b.n)[0];
		if (donut) {
			layout.push({
				type: "chart",
				kpi: primary.apiName,
				dimension: donut.d,
				chart: isAdditive(primary) ? "donut" : "hbar",
				sort: isAdditive(primary) ? undefined : "value_desc",
				title: `${primary.label} by ${sliceName(donut.d).text}`,
				width: 2,
			});
		}
		// Then one ranked slice per kind of question - where, what, who - so a
		// wide dataset does not fill the board with three versions of country.
		const shown: typeof useful = [];
		const slices = categorical.length >= 5 ? 3 : 2;
		for (const kind of ["where", "what", "who", "other"] as const) {
			if (shown.length >= (donut ? slices - (slices === 3 ? 0 : 1) : slices)) break;
			// Countries before regions; a slice of two bars only when nothing
			// richer exists; otherwise the dataset's own order (its base first).
			const pick = useful
				.filter((x) => x !== donut && x.family === kind && x.n <= 60)
				.sort(
					(a, b) =>
						nameRank(a.d) - nameRank(b.d) ||
						Number(a.n < 5) - Number(b.n < 5) ||
						categorical.indexOf(a.d) - categorical.indexOf(b.d),
				)[0];
			if (pick) shown.push(pick);
		}
		for (const { d } of shown) {
			layout.push({ type: "chart", kpi: primary.apiName, dimension: d, chart: "hbar", sort: "value_desc", limit: 10, title: `${primary.label} by ${sliceName(d).text}`, width: 2 });
		}
		// The table ranks the finest dimension - the top customers, the top
		// products - by a figure that adds up: an average over a handful of
		// rows would put whoever had one good order on top.
		const ranked = isAdditive(primary) ? primary : named.find(isAdditive) ?? count;
		const tableDimension = [...useful]
			.filter((x) => x !== donut && !shown.includes(x) && x.family !== "where" && ranked?.dimensions.includes(x.d))
			.sort((a, b) => whoRank(a.d) - whoRank(b.d) || b.n - a.n)[0];
		if (tableDimension && ranked) {
			const used = layout.reduce((sum, w) => sum + (w.width ?? 1), 0) % 4;
			layout.push({ type: "table", kpi: ranked.apiName, dimension: tableDimension.d, sort: "value_desc", limit: 15, title: `Top ${rankedName(tableDimension.d)} by ${ranked.label.toLowerCase()}`, width: used === 2 ? 2 : 4 });
		}
	}
	return { layout, items };
}

/** Totals and counts add up across rows; averages and ratios do not. */
function isAdditive(kpi: KpiMeta): boolean {
	return ["sum", "count", "count_distinct"].includes(kpi.aggregation);
}

/** For a ranking table: customers before staff, staff before anything else. */
function whoRank(column: string): number {
	const lowered = column.toLowerCase();
	if (/customer|client|company|account/.test(lowered)) return 0;
	if (/employee|staff|rep|agent|owner|manager|supplier|vendor|product/.test(lowered)) return 1;
	return 2;
}

function nameRank(column: string): number {
	const lowered = column.toLowerCase();
	if (/country|nation/.test(lowered)) return 0;
	if (/region|state|territory|province/.test(lowered)) return 1;
	if (/category|type|segment|class|kind|status|tier|channel|group/.test(lowered)) return 1;
	if (/city/.test(lowered)) return 2;
	return 3;
}

/** The kind of question a dimension answers. */
function family(column: string): "where" | "what" | "who" | "other" {
	const lowered = column.toLowerCase();
	// A contact's job title says little about who bought.
	if (/contact/.test(lowered)) return "other";
	if (/country|nation|region|state|territory|province|city|zone|market/.test(lowered)) return "where";
	if (/category|type|segment|class|kind|status|tier|channel|group|product|line|brand/.test(lowered)) return "what";
	if (/customer|client|employee|staff|rep|agent|owner|manager|supplier|vendor|shipper|carrier|company|last_name|first_name|name/.test(lowered)) return "who";
	return "other";
}

/**
 * The type a board on `topic` should be built on: of the types the topic
 * names (or that hold its measure), the one with the most to show - a
 * timeline, ways to slice, and the measure itself.
 */
function boardSubject(topic: string, measure: string | null): ObjectTypeMeta | null {
	const registry = getRegistry();
	const want = tokens(topic);
	const candidates = registry.objectTypes.filter(
		(type) => (want.length > 0 && overlap(want, typeTokens(type)) > 0) || (measure !== null && type.propertyBySqlColumn.has(measure)),
	);
	if (candidates.length === 0) return pickSubject(topic);
	// "An orders dashboard" is about orders, however much richer a dataset
	// that merely mentions them is.
	const exact = candidates.find((type) => namesTypeExactly(topic, type));
	if (exact) return enrichedOf(exact) ?? exact;
	const richness = (type: ObjectTypeMeta): number => {
		const metrics = registry.kpis.filter((k) => k.objectTypeRid === type.rid);
		const timeline = metrics.some((k) => k.dimensions.some((d) => d.includes(":"))) ? 3 : 0;
		const slices = Math.min(new Set(metrics.flatMap((k) => k.dimensions.filter((d) => !d.includes(":")))).size, 6);
		const holdsMeasure = measure !== null && type.propertyBySqlColumn.has(measure) ? 2 : 0;
		return timeline + slices + holdsMeasure;
	};
	return [...candidates].sort((a, b) => richness(b) - richness(a))[0] ?? null;
}

/** Everything a workspace can chart right now, and what approval would add. */
async function capabilities(): Promise<FeasibilityItem[]> {
	const registry = getRegistry();
	const items: FeasibilityItem[] = [];
	// Biggest first: the main facts lead. An empty table has nothing to chart.
	const types = [...registry.objectTypes].filter((type) => type.rowCount > 0).sort((a, b) => b.rowCount - a.rowCount);
	for (const type of types) {
		const metrics = registry.kpis.filter((k) => k.objectTypeRid === type.rid);
		for (const kpi of metrics.slice(0, 3)) {
			items.push(readyItem({ measure: kpi.label, objectType: type.apiName }, kpi, kpi.defaultDimension));
		}
		// Slices one link away that need a combined dataset first. A link from
		// a type to itself (an employee's manager) is left to a specific ask.
		for (const link of registry.linksBySourceRid.get(type.rid) ?? []) {
			if (link.targetObjectType === type.rid) continue;
			const target = registry.objectTypeByRid.get(link.targetObjectType);
			// The slice the linked type is best known by: its country or kind,
			// never a contact's details.
			const sliceColumn = defaultSlice(
				(target?.properties ?? []).filter((p) => p.semanticRole === "dimension" && !CONTACT_LIKE.test(p.sqlColumn)).map((p) => p.sqlColumn),
			);
			const dimension = target?.properties.find((p) => p.sqlColumn === sliceColumn);
			const count = metrics.find((k) => k.aggregation === "count");
			if (!target || !dimension || !count) continue;
			items.push({
				request: { measure: count.label, dimension: `${target.label} ${dimension.label}`, objectType: type.apiName },
				status: "needs_approval",
				explanation: `${count.label} by ${target.label.toLowerCase()} ${dimension.label.toLowerCase()} needs ${type.label} joined to ${target.label} along ${link.apiName}.`,
			});
		}
	}
	if (registry.objectTypes.length === 0) {
		items.push({
			request: {},
			status: "not_possible",
			explanation: "This workspace has no data yet. Connect a PostgreSQL database and import tables; every chart starts from there.",
			missing: ["a connected table"],
		});
	}
	return items;
}

/** Answer a feasibility question, from free text or structured requests. */
export async function assess(input: { text?: string; requests?: FeasibilityRequest[]; intent?: Intent; objectType?: string }): Promise<FeasibilityReport> {
	const text = String(input.text ?? "").trim();
	const intent: Intent = input.intent ?? (text ? detectIntent(text) : "chart");
	const items: FeasibilityItem[] = [];
	let layout: Widget[] | undefined;
	let subject: ObjectTypeMeta | null = input.objectType ? matchType(input.objectType) : null;
	let title: string | undefined;

	if (intent === "capabilities") {
		items.push(...(await capabilities()));
	} else if (intent === "link" && !(input.requests?.length)) {
		items.push(await linkRequest(text));
	} else if (intent === "combination" && !(input.requests?.length)) {
		items.push(await combinationRequest(text));
	} else if ((intent === "dashboard" || intent === "report") && !(input.requests?.length) && !/\s(by|per)\s/.test(` ${text.toLowerCase()} `)) {
		const topic = text
			.replace(
				// Whole words only: the "on" of "on-time" stays.
				/(?<![\p{L}\p{N}-])(build|create|make|write|generate|prepare|draft|give|show|me|us|i|we|can|could|want|need|share|send|a|an|the|new|dashboard|dashboards|report|reports|board|overview|for|about|on|of|with|my|our|please|that|to)(?![\p{L}\p{N}-])/giu,
				" ",
			)
			.replace(/[^\p{L}\p{N} -]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
		const recipe = tokens(topic).includes("revenue") ? revenueRecipe() : null;
		subject = subject ?? boardSubject(topic, recipe?.name ?? null);
		if (subject) {
			// Named for what was asked ("Sales dashboard") when the topic is a
			// figure rather than one of the types; otherwise for the type.
			const namedType = topic ? getRegistry().objectTypes.find((type) => namesTypeExactly(topic, type)) : undefined;
			const namesType = namedType !== undefined;
			// "Orders overview" whether it is built on Order or on the dataset
			// that enriches it.
			const about = namedType ?? subject;
			title =
				topic && !namesType
					? `${topic.charAt(0).toUpperCase()}${topic.slice(1)} ${intent === "report" ? "report" : "dashboard"}`
					: `${about.pluralLabel ?? plural(about.label)} ${intent === "report" ? "report" : "overview"}`;
			// "A sales dashboard" asks for sales: the board leads with that
			// figure when one exists, on whichever type holds it.
			const topical = topic && !matchType(topic) ? await decide({ text: topic, measure: topic }) : null;
			// A board about being on time needs its flags first: that proposal,
			// with the board built from it the moment it is approved.
			const makes = asksAboutPunctuality(topic) && topical?.status === "needs_approval" ? topical.proposals?.at(-1) : undefined;
			if (makes) {
				const derived = (makes.payload.derived as Array<{ name: string; metric?: unknown }> | undefined) ?? [];
				makes.followUp = {
					build: intent,
					title,
					measure: derived.find((d) => d.metric)?.name ?? (typeof makes.payload.measure === "string" ? makes.payload.measure : null),
					sourcePrompt: text,
				};
				items.push({
					...topical!,
					request: { text, measure: topic },
					explanation: `${topical!.explanation} Approve it and the ${intent} "${title}" is built from it straight away.`,
				});
			}
			const leadKpi = topical?.status === "ready" && topical.kpi ? getRegistry().kpiByApiName.get(topical.kpi) : undefined;
			if (leadKpi?.objectTypeRid && leadKpi.objectTypeRid !== subject.rid) {
				subject = getRegistry().objectTypeByRid.get(leadKpi.objectTypeRid) ?? subject;
			}
			const measure = leadKpi?.measureColumn ?? (recipe && subject.propertyBySqlColumn.has(recipe.name) ? recipe.name : null);
			const plan = makes ? null : await planBoard(subject, { measure });
			if (plan) {
				const charts = plan.layout.filter((w) => w.type !== "stat");
				const slices = charts.filter((w) => w.type === "chart" && !w.dimension?.includes(":")).length;
				const thin = !charts.some((w) => w.dimension?.includes(":")) || slices < 2;
				const topicMissing = Boolean(topic) && !namesType && measure === null;
				// A board with no timeline or almost nothing to slice, or one that
				// cannot show what it was asked about, is better built on one wide
				// dataset: proposed, and built the moment it is approved.
				const wide = thin || topicMissing ? analysisDataset(topic, intent, title, text) : null;
				if (wide) {
					items.push(wide.item);
				} else {
					layout = plan.layout;
					items.push(...plan.items);
					if (topical && topical.status !== "ready") items.push(topical);
				}
			}
		} else {
			items.push(...(await capabilities()));
		}
	} else {
		const requests: FeasibilityRequest[] = input.requests?.length
			? input.requests
			: text
				? text
						.split(/\s*(?:;|\band also\b|\bplus\b)\s*/i)
						.filter(Boolean)
						.map((part) => {
							const parsed = parseQuestion(part);
							return {
								text: part,
								measure: parsed.measure,
								dimension: parsed.dimension ?? undefined,
								grain: parsed.grain ?? undefined,
								aggregation: parsed.aggregation ?? undefined,
								objectType: input.objectType,
							};
						})
				: [];
		for (const request of requests) {
			const parsed = request.text && !request.measure ? parseQuestion(request.text) : null;
			items.push(
				await decide({
					...request,
					measure: request.measure ?? parsed?.measure,
					dimension: request.dimension ?? parsed?.dimension ?? undefined,
					grain: request.grain ?? parsed?.grain ?? undefined,
					aggregation: request.aggregation ?? parsed?.aggregation ?? undefined,
				}),
			);
		}
		if (intent === "dashboard" || intent === "report") {
			layout = items.filter((i) => i.widget).map((i) => i.widget!);
		}
		const first = items.find((i) => i.kpi);
		const kpi = first?.kpi ? getRegistry().kpiByApiName.get(first.kpi) : undefined;
		subject = subject ?? (kpi?.objectTypeRid ? getRegistry().objectTypeByRid.get(kpi.objectTypeRid) ?? null : null);
	}

	return {
		intent,
		subject: subject?.apiName ?? null,
		items,
		summary: {
			ready: items.filter((i) => i.status === "ready").length,
			needsApproval: items.filter((i) => i.status === "needs_approval").length,
			notPossible: items.filter((i) => i.status === "not_possible").length,
		},
		...(layout ? { layout } : {}),
		...(title ? { title } : {}),
	};
}

export const __testing = { decide, readyItem, revenueRecipe, chartFor, overlap };
