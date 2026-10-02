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
import { measureLinkNow } from "./modeling";
import { humanize, plural, singular, snake } from "./profiling";
import { dimensionsOf } from "./proposals";
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
const GROUP_OF = new Map<string, string>();
for (const [group, words] of Object.entries(SYNONYMS)) for (const word of words) GROUP_OF.set(word, group);

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
	if (/\b(what|which) (can|could) (i|we|you) (build|chart|make|create|answer|see)|\bwhat('s| is) possible\b|\bcapabilit/.test(t)) return "capabilities";
	if (/\b(link|connect|relate|relationship between)\b/.test(t) && !/\bdashboard\b/.test(t)) return "link";
	if (/\b(combine|enrich|merge)\b/.test(t)) return "combination";
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

/** The type a phrase is mostly about, if it names one. */
export function matchType(phrase: string): ObjectTypeMeta | null {
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
export function widgetTitle(kpi: KpiMeta, dimension: string | null): string {
	if (!dimension) return kpi.label;
	const [column = "", grain] = dimension.split(":");
	if (!grain) return `${kpi.label} by ${humanize(column).toLowerCase()}`;
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

	if (aggregation === "count" || (countedType && !aggregation && (!propertyMatch || overlap(tokens(measurePhrase), typeTokens(countedType)) >= propertyMatch.score))) {
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
						explanation: `Revenue can be derived on ${recipe.type.label} (${recipe.expression}), but ${recipe.type.label} has no chain of links to ${dimensionProperty.type.label}.`,
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
					`${recipe.expression}. Approving the combined dataset below derives it per row` +
					(joins.length ? " and brings in what it is sliced by" : "") +
					"; its total-revenue metric is created with it.",
				proposals: [
					{
						kind: "combination",
						title: `${recipe.type.label} with revenue`,
						summary: `${recipe.type.pluralLabel ?? recipe.type.label} with line_total = ${recipe.expression}.`,
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

	// 4a. Punctuality needs a promised and an actual date; say what exists.
	if (!kpi && !measureProperty && /\b(on.?time|late|lateness|delay|delayed|punctual)/.test(measurePhrase)) {
		const dated = registry.objectTypes.find(
			(t) =>
				t.properties.some((p) => p.semanticRole === "temporal" && /(required|due|promised|expected|planned|deadline)/.test(p.sqlColumn)) &&
				t.properties.some((p) => p.semanticRole === "temporal" && /(shipped|delivered|actual|completed|closed|arrived)/.test(p.sqlColumn)),
		);
		return {
			request,
			status: "not_possible",
			explanation: dated
				? `There is no on-time measure yet. ${dated.pluralLabel ?? dated.label} carry a promised date and an actual date ` +
					`(${dated.properties.filter((p) => p.semanticRole === "temporal").map((p) => p.sqlColumn).join(", ")}), so one could be ` +
					"defined by comparing them - comparisons between dates are not something this workspace can derive automatically yet."
				: "Punctuality needs a promised date and an actual date for the same thing, and no type in this workspace has both.",
			missing: dated ? ["a derived on-time flag (date comparison)"] : ["a promised date and an actual date"],
			alternatives: registry.kpis.slice(0, 5).map((k) => k.label),
		};
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

const CONTACT_LIKE = /(address|street|postal|zip|phone|fax|url|email|homepage|photo|picture|notes|password|token|extension)/i;

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
	const registry = getRegistry();
	const topicTokens = tokens(topic);
	const recipe = topicTokens.includes("revenue") ? revenueRecipe() : null;
	const measureMatch = recipe ? null : topic ? matchProperty(topic, ["measure"], null) : null;
	const base =
		recipe?.type ??
		(measureMatch && measureMatch.type.origin !== "combination" ? measureMatch.type : null) ??
		(topic ? matchType(topic) : null) ??
		pickSubject("");
	if (!base) return null;
	const joins = analysisJoins(base);
	const hasOwnDate = base.properties.some((p) => p.semanticRole === "temporal");
	const joinedDate = joins.some((j) => j.target.properties.some((p) => j.fields.includes(p.sqlColumn) && p.semanticRole === "temporal"));
	if (joins.length === 0 || (!hasOwnDate && !joinedDate && joins.length < 2)) return null;

	// "Sales Order Detail" for a figure; "Enriched Product" when the topic is
	// the type itself (or there is none).
	const topicIsType = !topic || overlap(tokens(topic), typeTokens(base)) > 0;
	let name = (topicIsType ? `Enriched ${base.label}` : `${titleCase(topic)} ${base.label}`).slice(0, 60);
	for (let n = 2; registry.objectTypeByApiName.has(name.replace(/[^A-Za-z0-9]+/g, " ").split(" ").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")); n += 1) {
		name = `${name.replace(/ \d+$/, "")} ${n}`;
	}
	const measure = recipe?.name ?? measureMatch?.property.sqlColumn ?? null;
	const carried = joins.map((j) => `${j.target.label.toLowerCase()} (${j.fields.map((f) => humanize(f).toLowerCase()).join(", ")})`);
	const proposal: DraftProposal = {
		kind: "combination",
		title: `New dataset: ${name}`,
		summary:
			`${base.pluralLabel ?? plural(base.label)}, one row each, with ` +
			carried.join("; ") +
			(recipe ? `, and revenue = ${recipe.expression}` : "") +
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
				(recipe ? `, with revenue worked out as ${recipe.expression}` : "") +
				`. That is one new dataset (nothing in your database changes). Approve it and the ${intent} is built straight away - ` +
				"headline figures, a monthly timeline and the main breakdowns.",
			proposals: [proposal],
		},
	};
}

// ── dashboards and capabilities ─────────────────────────────────────────────

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
	const sums = [
		...(lead ? [lead] : []),
		...metrics.filter((k) => k !== lead && (k.aggregation === "sum" || k.aggregation === "avg")),
	].slice(0, 3);
	const distinct = lead ? metrics.find((k) => k.aggregation === "count_distinct") : undefined;
	const headline = (lead ? [lead, distinct ?? count, ...sums.slice(1)] : [count, ...sums])
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

	const primary = lead ?? sums.find((k) => k.aggregation === "sum") ?? count;
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
		const useful = measured.filter((x) => x.n >= 2);
		// A share of a small whole reads best as a donut: who carried it, which
		// channel - a place is better ranked than pied.
		const donut = useful
			.filter((x) => x.n <= 4)
			.sort((a, b) => Number(a.family === "where") - Number(b.family === "where") || a.n - b.n)[0];
		if (donut) {
			layout.push({ type: "chart", kpi: primary.apiName, dimension: donut.d, chart: "donut", title: `${primary.label} by ${humanize(donut.d).toLowerCase()}`, width: 2 });
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
			layout.push({ type: "chart", kpi: primary.apiName, dimension: d, chart: "hbar", sort: "value_desc", limit: 10, title: `${primary.label} by ${humanize(d).toLowerCase()}`, width: 2 });
		}
		// The table ranks the finest dimension: the top customers, the top products.
		const tableDimension = [...useful]
			.filter((x) => x !== donut && !shown.includes(x) && x.family !== "where")
			.sort((a, b) => b.n - a.n)[0];
		if (tableDimension) {
			const used = layout.reduce((sum, w) => sum + (w.width ?? 1), 0) % 4;
			layout.push({ type: "table", kpi: primary.apiName, dimension: tableDimension.d, sort: "value_desc", limit: 15, title: `Top ${humanize(tableDimension.d).toLowerCase()} by ${primary.label.toLowerCase()}`, width: used === 2 ? 2 : 4 });
		}
	}
	return { layout, items };
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
	for (const type of registry.objectTypes) {
		const metrics = registry.kpis.filter((k) => k.objectTypeRid === type.rid);
		for (const kpi of metrics.slice(0, 3)) {
			items.push(readyItem({ measure: kpi.label, objectType: type.apiName }, kpi, kpi.defaultDimension));
		}
		// Slices one link away that need a combined dataset first.
		for (const link of registry.linksBySourceRid.get(type.rid) ?? []) {
			const target = registry.objectTypeByRid.get(link.targetObjectType);
			const dimension = target?.properties.find((p) => p.semanticRole === "dimension");
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
	} else if ((intent === "dashboard" || intent === "report") && !(input.requests?.length) && !/\s(by|per)\s/.test(` ${text.toLowerCase()} `)) {
		const topic = text
			.replace(
				/\b(build|create|make|write|generate|prepare|draft|give|show|me|us|i|we|can|could|want|need|share|send|a|an|the|new|dashboard|dashboards|report|reports|board|overview|for|about|on|of|with|my|our|please|that|to)\b/gi,
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
			const namesType =
				Boolean(topic) &&
				[subject.label, subject.pluralLabel ?? "", subject.apiName].some((name) => name.toLowerCase() === topic.toLowerCase());
			title =
				topic && !namesType
					? `${topic.charAt(0).toUpperCase()}${topic.slice(1)} ${intent === "report" ? "report" : "dashboard"}`
					: `${subject.pluralLabel ?? plural(subject.label)} ${intent === "report" ? "report" : "overview"}`;
			// "A sales dashboard" asks for sales: the board leads with that
			// figure when one exists, on whichever type holds it.
			const topical = topic && !matchType(topic) ? await decide({ text: topic, measure: topic }) : null;
			const leadKpi = topical?.status === "ready" && topical.kpi ? getRegistry().kpiByApiName.get(topical.kpi) : undefined;
			if (leadKpi?.objectTypeRid && leadKpi.objectTypeRid !== subject.rid) {
				subject = getRegistry().objectTypeByRid.get(leadKpi.objectTypeRid) ?? subject;
			}
			const measure = leadKpi?.measureColumn ?? (recipe && subject.propertyBySqlColumn.has(recipe.name) ? recipe.name : null);
			const plan = await planBoard(subject, { measure });
			const charts = plan.layout.filter((w) => w.type !== "stat");
			const thin = !charts.some((w) => w.dimension?.includes(":")) || charts.length < 3;
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
