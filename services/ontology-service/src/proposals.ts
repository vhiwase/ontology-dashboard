/**
 * Proposals: changes to the ontology that wait for someone to approve them.
 *
 * When a question cannot be answered with what the ontology has - "revenue by
 * customer country" needs order lines joined to orders joined to customers -
 * the answer is not to compute it some other way and not to dead-end. It is
 * to say exactly which building block is missing and to PROPOSE it:
 *
 *   link_type     connect two object types on a pair of properties
 *   metric        a new measure: count, sum, average, distinct, ratio, with
 *                 optional filters that are part of what it means
 *   combination   an object type joined along existing links, with derived
 *                 properties (price x quantity) - a new dataset, modelled
 *   action_type   a governed operation on an object type, run from its page
 *
 * Nothing is applied when a proposal is made. It is validated, its effect is
 * MEASURED (the match ratio a link would have, the headline value a metric
 * would show, sample rows of a join) and it is stored as pending. Approving it
 * validates it again - the ontology may have changed in between - and applies
 * it. A proposal can depend on others (a combination on the link it joins
 * along); approving it applies those first, so a chain is approved in one act.
 *
 * Every part of what a proposal does is compiled from the ontology: names are
 * resolved through the registry, SQL is generated from links and properties,
 * and expressions are parsed (derived.ts). A proposal never carries SQL.
 */

import type { ActionTypeMeta, KpiMeta, LinkTypeMeta, ObjectTypeMeta, PropertyMeta } from "./registry";
import { assertDerivedName, compileExpression } from "./derived";
import { query, queryOne } from "./db";
import { executeKpiWith, type KpiExecuteResult } from "./kpi";
import {
	chooseTimeColumn,
	defaultSlice,
	insertWorkspaceLink,
	measureLinkNow,
	modelSources,
	withActiveVersion,
} from "./modeling";
import { humanize, plural, snake } from "./profiling";
import {
	BadRequest,
	currentSpace,
	getRegistry,
	NotFound,
	quoteIdentifier,
	quoteQualified,
	resolveColumn,
	resolveObjectType,
} from "./registry";

export type ProposalKind = "link_type" | "metric" | "combination" | "action_type";
export type ProposalStatus = "pending" | "applied" | "rejected" | "failed";

export interface ProposalRecord {
	id: number;
	kind: ProposalKind;
	title: string;
	summary: string | null;
	payload: Record<string, unknown>;
	preview: Record<string, unknown>;
	status: ProposalStatus;
	dependsOn: number[];
	result: Record<string, unknown> | null;
	error: string | null;
	createdBy: string;
	createdVia: "user" | "assistant" | "planner";
	chatSessionId: number | null;
	decidedBy: string | null;
	decidedAt: string | null;
	decisionNote: string | null;
	createdAt: string;
	/** What to build once this is applied - see FollowUp. */
	followUp: FollowUp | null;
}

/**
 * A request that waits on a proposal: "build me a sales dashboard" on data
 * with no sales dataset becomes a proposal for the dataset with this
 * attached, and the board is built from the new type when it is approved.
 */
export interface FollowUp {
	build: "dashboard" | "report";
	title: string;
	/** The column the board leads with, e.g. a derived revenue. */
	measure: string | null;
	sourcePrompt: string | null;
}

export function parseFollowUp(raw: unknown): FollowUp | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const build = value.build === "report" ? "report" : value.build === "dashboard" ? "dashboard" : null;
	const title = typeof value.title === "string" ? value.title.trim().slice(0, 120) : "";
	if (!build || !title) return null;
	return {
		build,
		title,
		measure: typeof value.measure === "string" && value.measure.trim() ? value.measure.trim().slice(0, 63) : null,
		sourcePrompt: typeof value.sourcePrompt === "string" ? value.sourcePrompt.slice(0, 500) : null,
	};
}

type ProposalRow = {
	proposal_id: string;
	kind: ProposalKind;
	title: string;
	summary: string | null;
	payload: Record<string, unknown>;
	preview: Record<string, unknown>;
	status: ProposalStatus;
	depends_on: string[] | null;
	result: Record<string, unknown> | null;
	error: string | null;
	created_by: string;
	created_via: ProposalRecord["createdVia"];
	chat_session_id: string | null;
	decided_by: string | null;
	decided_at: Date | null;
	decision_note: string | null;
	created_at: Date;
	follow_up: unknown;
};

function toRecord(row: ProposalRow): ProposalRecord {
	return {
		id: Number(row.proposal_id),
		kind: row.kind,
		title: row.title,
		summary: row.summary,
		payload: row.payload,
		preview: row.preview,
		status: row.status,
		dependsOn: (row.depends_on ?? []).map(Number),
		result: row.result,
		error: row.error,
		createdBy: row.created_by,
		createdVia: row.created_via,
		chatSessionId: row.chat_session_id === null ? null : Number(row.chat_session_id),
		decidedBy: row.decided_by,
		decidedAt: row.decided_at?.toISOString() ?? null,
		decisionNote: row.decision_note,
		createdAt: row.created_at.toISOString(),
		followUp: parseFollowUp(row.follow_up),
	};
}

interface Draft {
	title: string;
	summary: string;
	payload: Record<string, unknown>;
	preview: Record<string, unknown>;
}

// ── shared helpers ──────────────────────────────────────────────────────────

function lowerFirst(value: string): string {
	return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

/** The type name a dataset called `value` is given on approval. */
export function pascal(value: string): string {
	return value
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
}

function uniqueName(base: string, taken: (name: string) => boolean): string {
	let candidate = base;
	for (let n = 2; taken(candidate); n += 1) candidate = `${base}${n}`;
	return candidate;
}

function str(value: unknown, field: string, required = true): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (required && !text) throw new BadRequest(`${field} is required.`);
	return text;
}

function isNumeric(property: PropertyMeta): boolean {
	return /int|numeric|double|real|decimal|money/i.test(property.sqlType ?? "") ||
		["integer", "decimal", "float"].includes(property.datatype);
}

function isTemporal(property: PropertyMeta): boolean {
	return /date|timestamp/i.test(property.sqlType ?? "") || ["date", "datetime"].includes(property.datatype);
}

/** Dimensions for a metric on a type, from its classified properties. */
export function dimensionsOf(type: ObjectTypeMeta): string[] {
	const categorical = type.properties
		.filter((p) => p.semanticRole === "dimension" || p.semanticRole === "flag")
		.map((p) => p.sqlColumn);
	const grains = type.properties
		.filter((p) => p.semanticRole === "temporal")
		.flatMap((p) => ["day", "week", "month", "quarter", "year"].map((g) => `${p.sqlColumn}:${g}`));
	return [...categorical, ...grains].slice(0, 30);
}

function timeColumnOf(type: ObjectTypeMeta): string | null {
	return chooseTimeColumn(
		type.properties.map((p) => ({ name: p.sqlColumn, role: p.semanticRole }) as never),
	);
}

const CURRENCY = /(amount|price|cost|revenue|sales|charge|fee|payment|spend|budget|salary|income|profit|freight|tax|total|value)/;

// ── link_type ───────────────────────────────────────────────────────────────

async function draftLink(raw: Record<string, unknown>): Promise<Draft> {
	const source = resolveObjectType(str(raw.source, "source"));
	const target = resolveObjectType(str(raw.target, "target"));
	const sourceProperty = resolveColumn(source, str(raw.sourceProperty, "sourceProperty"));
	const targetProperty = resolveColumn(target, str(raw.targetProperty ?? target.primaryKeyColumn, "targetProperty"));
	const registry = getRegistry();
	const existing = registry.linkTypes.find(
		(l) => l.sourceObjectType === source.rid && l.targetObjectType === target.rid && l.sourceColumn === sourceProperty.sqlColumn,
	);
	if (existing) {
		throw new BadRequest(`${source.apiName}.${sourceProperty.apiName} is already linked to ${target.apiName} by '${existing.apiName}'.`);
	}
	const measured = await measureLinkNow(source.sourceView, sourceProperty.sqlColumn, target.sourceView, targetProperty.sqlColumn);
	if (measured.candidates > 0 && measured.matched === 0) {
		throw new BadRequest(
			`No value of ${source.apiName}.${sourceProperty.apiName} matches ${target.apiName}.${targetProperty.apiName}, ` +
				"so this link would connect nothing. Check which properties hold the same identifier.",
		);
	}
	const role = pascal(sourceProperty.sqlColumn.replace(/_(id|key|code|no|number|ref)$/i, "")) || target.apiName;
	const apiName = uniqueName(
		str(raw.apiName, "apiName", false) || lowerFirst(source.apiName) + role,
		(name) => registry.linkTypeByApiName.has(name),
	);
	const inverse = uniqueName(lowerFirst(target.apiName) + pascal(plural(snake(source.apiName))), (name) =>
		registry.linkTypeByApiName.has(name) || name === apiName,
	);
	const label = str(raw.label, "label", false) || `${source.label} → ${target.label}`;
	const pct = (measured.ratio * 100).toFixed(1);
	return {
		title: `Link ${source.label} to ${target.label}`,
		summary:
			`Connect each ${source.label.toLowerCase()} to its ${target.label.toLowerCase()} where ` +
			`${source.apiName}.${sourceProperty.apiName} = ${target.apiName}.${targetProperty.apiName}. ` +
			`${measured.matched.toLocaleString("en-US")} of ${measured.candidates.toLocaleString("en-US")} (${pct}%) resolve.`,
		payload: {
			source: source.apiName,
			sourceProperty: sourceProperty.sqlColumn,
			target: target.apiName,
			targetProperty: targetProperty.sqlColumn,
			apiName,
			inverseApiName: inverse,
			label,
		},
		preview: {
			matchRatio: measured.ratio,
			matched: measured.matched,
			candidates: measured.candidates,
			cardinality: measured.targetUnique ? "MANY_TO_ONE" : "MANY_TO_MANY",
			warning:
				measured.ratio < 0.5
					? `Only ${pct}% of ${source.label.toLowerCase()} rows resolve. A link this partial is real but lossy; check it is the right pair.`
					: null,
		},
	};
}

async function applyLink(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	// Validated again: the types or the link names may have changed since.
	const draft = await draftLink(payload);
	const p = draft.payload;
	const source = resolveObjectType(String(p.source));
	const target = resolveObjectType(String(p.target));
	const measured = await insertWorkspaceLink({
		apiName: String(p.apiName),
		label: String(p.label),
		description: draft.summary,
		sourceRid: source.rid,
		targetRid: target.rid,
		sourceRelation: source.sourceView,
		targetRelation: target.sourceView,
		sourceColumn: String(p.sourceProperty),
		targetColumn: String(p.targetProperty),
		inverseApiName: String(p.inverseApiName),
		inverseLabel: `${target.label} → ${source.pluralLabel ?? plural(source.label)}`,
	});
	return { linkType: p.apiName, ...measured };
}

// ── metric ──────────────────────────────────────────────────────────────────

const AGGREGATIONS = ["count", "sum", "avg", "min", "max", "count_distinct", "ratio"] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

function metricMeta(type: ObjectTypeMeta, p: Record<string, unknown>, apiName: string): KpiMeta {
	return {
		rid: `kpi:${apiName}`,
		apiName,
		label: String(p.label),
		description: (p.description as string | null) ?? null,
		businessQuestion: (p.businessQuestion as string | null) ?? null,
		category: type.label,
		sourceView: type.sourceView,
		measureColumn: (p.measure as string | null) ?? null,
		aggregation: String(p.aggregation),
		numeratorColumn: (p.numerator as string | null) ?? null,
		denominatorColumn: (p.denominator as string | null) ?? null,
		dimensions: (p.dimensions as string[]) ?? [],
		defaultDimension: (p.defaultDimension as string | null) ?? null,
		timeColumn: (p.timeColumn as string | null) ?? null,
		unit: (p.unit as string | null) ?? null,
		valueFormat: String(p.format ?? "number"),
		higherIsBetter: null,
		targetValue: null,
		warningThreshold: null,
		criticalThreshold: null,
		relatedObjectTypes: [type.rid],
		dependsOnSimulation: false,
		coverageNote: null,
		displayOrder: 2000,
		conditions: (p.filters as Record<string, unknown>) ?? {},
		origin: "proposal",
		objectTypeRid: type.rid,
	};
}

async function draftMetric(raw: Record<string, unknown>): Promise<Draft> {
	const type = resolveObjectType(str(raw.objectType, "objectType"));
	const aggregation = str(raw.aggregation, "aggregation").toLowerCase() as Aggregation;
	if (!AGGREGATIONS.includes(aggregation)) {
		throw new BadRequest(`aggregation must be one of ${AGGREGATIONS.join(", ")}.`);
	}
	let measure: PropertyMeta | null = null;
	let numerator: PropertyMeta | null = null;
	let denominator: string | null = null;
	if (["sum", "avg", "min", "max", "count_distinct"].includes(aggregation)) {
		measure = resolveColumn(type, str(raw.measure, "measure"));
		if ((aggregation === "sum" || aggregation === "avg") && !isNumeric(measure)) {
			throw new BadRequest(`${type.apiName}.${measure.apiName} is not numeric, so it cannot be ${aggregation === "sum" ? "summed" : "averaged"}.`);
		}
		if ((aggregation === "sum" || aggregation === "avg") && ["identity", "geo"].includes(measure.semanticRole)) {
			throw new BadRequest(`${type.apiName}.${measure.apiName} is ${measure.semanticRole === "geo" ? "a coordinate" : "an identifier"}; adding it up means nothing.`);
		}
		if ((aggregation === "min" || aggregation === "max") && !isNumeric(measure) && !isTemporal(measure)) {
			throw new BadRequest(`${type.apiName}.${measure.apiName} is neither a number nor a date.`);
		}
	}
	if (aggregation === "ratio") {
		numerator = resolveColumn(type, str(raw.numerator, "numerator"));
		if (!isNumeric(numerator)) throw new BadRequest(`${numerator.apiName} is not numeric.`);
		const rawDenominator = str(raw.denominator, "denominator");
		if (rawDenominator === "*") denominator = "*";
		else {
			const property = resolveColumn(type, rawDenominator);
			if (!isNumeric(property)) throw new BadRequest(`${property.apiName} is not numeric.`);
			denominator = property.sqlColumn;
		}
	}

	// Filters that are part of the metric: keys must be properties of the type.
	const filters: Record<string, unknown> = {};
	if (raw.filters !== undefined && raw.filters !== null) {
		if (typeof raw.filters !== "object" || Array.isArray(raw.filters)) {
			throw new BadRequest("filters must be an object of property -> value.");
		}
		for (const [key, value] of Object.entries(raw.filters as Record<string, unknown>)) {
			filters[resolveColumn(type, key).sqlColumn] = value;
		}
	}

	const registry = getRegistry();
	const label = str(raw.label, "label", false) ||
		(aggregation === "count"
			? type.pluralLabel ?? plural(type.label)
			: aggregation === "ratio"
				? `${humanize(numerator!.sqlColumn)} per ${denominator === "*" ? type.label.toLowerCase() : humanize(denominator!)}`
				: `${{ sum: "Total", avg: "Average", min: "Lowest", max: "Highest", count_distinct: "Distinct" }[aggregation]} ${humanize(measure!.sqlColumn)}`);
	const apiName = uniqueName(
		snake(str(raw.apiName, "apiName", false) || `${snake(type.apiName)}_${snake(label)}`).slice(0, 60),
		(name) => registry.kpiByApiName.has(name),
	);
	const column = measure?.sqlColumn ?? numerator?.sqlColumn ?? "";
	const format =
		(raw.format as string | undefined) ??
		(aggregation === "count" || aggregation === "count_distinct"
			? "integer"
			: CURRENCY.test(column) && !/(qty|quantity|count|units)/.test(column)
				? "currency"
				: "number");
	if (!["number", "integer", "currency", "percent"].includes(format)) {
		throw new BadRequest("format must be number, integer, currency or percent.");
	}
	const timeColumn = timeColumnOf(type);
	// Extra slices beyond the type's categories and dates, each checked to be
	// a real property (with a grain only on a date).
	const extra = Array.isArray(raw.extraDimensions) ? (raw.extraDimensions as unknown[]).map(String) : [];
	const extraKeys = extra.map((entry) => {
		const [column = "", grain] = entry.split(":");
		const property = resolveColumn(type, column);
		if (grain && !(isTemporal(property) && ["day", "week", "month", "quarter", "year"].includes(grain))) {
			throw new BadRequest(`'${entry}' is not a property with a valid time grain.`);
		}
		return grain ? `${property.sqlColumn}:${grain}` : property.sqlColumn;
	});
	const dimensions = [...new Set([...dimensionsOf(type), ...extraKeys])];
	const payload = {
		objectType: type.apiName,
		aggregation,
		measure: measure?.sqlColumn ?? null,
		numerator: numerator?.sqlColumn ?? null,
		denominator,
		filters,
		label,
		description: str(raw.description, "description", false) || null,
		businessQuestion: str(raw.businessQuestion, "businessQuestion", false) || null,
		format,
		unit: (raw.unit as string | undefined) ?? (format === "percent" ? "%" : null),
		apiName,
		dimensions,
		defaultDimension: timeColumn ? `${timeColumn}:month` : defaultSlice(dimensions),
		timeColumn,
	};

	// Measured now, so the person approving it sees the number it will show.
	let preview: KpiExecuteResult | null = null;
	let previewError: string | null = null;
	try {
		preview = await executeKpiWith(metricMeta(type, payload, apiName), { totalOnly: true });
	} catch (error) {
		previewError = (error as Error).message;
	}
	if (previewError) throw new BadRequest(`This metric would not compute: ${previewError}`);
	const filterText = Object.keys(filters).length
		? ` where ${Object.entries(filters).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(" and ")}`
		: "";
	return {
		title: `New metric: ${label}`,
		summary: `${label} on ${type.pluralLabel ?? plural(type.label)} (${aggregation}${column ? ` of ${column}` : ""}${denominator ? ` over ${denominator === "*" ? "rows" : denominator}` : ""})${filterText}.`,
		payload,
		preview: { total: preview?.total ?? null, format, unit: payload.unit, sql: preview?.sql ?? null },
	};
}

async function applyMetric(payload: Record<string, unknown>, username: string): Promise<Record<string, unknown>> {
	const draft = await draftMetric(payload);
	const p = draft.payload;
	const type = resolveObjectType(String(p.objectType));
	const total = (draft.preview.total as number | null) ?? null;

	// The same figure made automatically when the type was modelled (the
	// average of on_time_pct, say) is adopted - given this name and format and
	// kept from then on - rather than measured twice under two names.
	const twin = automaticTwin(type, p);
	if (twin) {
		await withActiveVersion(async (client, { spaceId }) => {
			await client.query(
				`UPDATE platform.kpi_definition
				    SET label = $3, description = COALESCE($4, description), business_question = COALESCE($5, business_question),
				        unit = $6, value_format = $7, origin = 'proposal'
				  WHERE space_id = $1 AND api_name = $2`,
				[spaceId, twin.apiName, p.label, p.description, p.businessQuestion, p.unit, p.format],
			);
		});
		return { metric: twin.apiName, adopted: true, total };
	}

	await withActiveVersion(async (client, { spaceId }) => {
		await client.query(
			`INSERT INTO platform.kpi_definition
			   (space_id, kpi_rid, api_name, label, description, business_question, category, source_view,
			    measure_column, aggregation, numerator_column, denominator_column, dimensions,
			    default_dimension, time_column, unit, value_format, related_object_types,
			    depends_on_simulation, display_order, origin, object_type_rid, conditions, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false,2000,'proposal',$19,$20::jsonb,$21)`,
			[
				spaceId, `kpi:${p.apiName}`, p.apiName, p.label, p.description, p.businessQuestion, type.label,
				type.sourceView, p.measure, p.aggregation, p.numerator, p.denominator, p.dimensions,
				p.defaultDimension, p.timeColumn, p.unit, p.format, [type.rid], type.rid,
				JSON.stringify(p.filters ?? {}), username,
			],
		);
	});
	return { metric: p.apiName, total };
}

/** A metric modelling made on its own that measures exactly what `p` does. */
function automaticTwin(type: ObjectTypeMeta, p: Record<string, unknown>): KpiMeta | null {
	const unfiltered = (filters: unknown) => !filters || Object.keys(filters as object).length === 0;
	if (!unfiltered(p.filters)) return null;
	return (
		getRegistry().kpis.find(
			(k) =>
				k.origin === "modelled" &&
				k.objectTypeRid === type.rid &&
				k.aggregation === p.aggregation &&
				(k.measureColumn ?? null) === (p.measure ?? null) &&
				(k.numeratorColumn ?? null) === (p.numerator ?? null) &&
				(k.denominatorColumn ?? null) === (p.denominator ?? null) &&
				unfiltered(k.conditions),
		) ?? null
	);
}

// ── combination ─────────────────────────────────────────────────────────────

interface Hop {
	link: LinkTypeMeta;
	from: ObjectTypeMeta;
	to: ObjectTypeMeta;
	alias: string;
}

function walkPath(base: ObjectTypeMeta, path: string[], aliasStart: number): Hop[] {
	const registry = getRegistry();
	const hops: Hop[] = [];
	let current = base;
	path.forEach((name, index) => {
		const link = registry.linkTypeByApiName.get(name);
		if (!link) {
			const known = registry.linkTypes.filter((l) => l.sourceObjectType === current.rid).map((l) => l.apiName);
			throw new BadRequest(`No link '${name}'. From ${current.apiName} you can follow: ${known.join(", ") || "nothing"}.`);
		}
		if (link.sourceObjectType !== current.rid) {
			if (link.targetObjectType === current.rid) {
				throw new BadRequest(
					`'${name}' points INTO ${current.apiName}. Following it from there would repeat each ` +
						`${current.label.toLowerCase()} once per related row; use a metric on ${registry.objectTypeByRid.get(link.sourceObjectType)?.label ?? "the other type"} instead.`,
				);
			}
			throw new BadRequest(`'${name}' does not start at ${current.apiName}.`);
		}
		if (link.cardinality === "MANY_TO_MANY" || link.cardinality === "ONE_TO_MANY") {
			throw new BadRequest(`'${name}' is ${link.cardinality}; joining along it would duplicate ${current.label.toLowerCase()} rows.`);
		}
		const to = registry.objectTypeByRid.get(link.targetObjectType);
		if (!to) throw new BadRequest(`'${name}' leads to a type that no longer exists.`);
		hops.push({ link, from: current, to, alias: `j${aliasStart + index}` });
		current = to;
	});
	return hops;
}

async function draftCombination(raw: Record<string, unknown>): Promise<Draft> {
	const name = str(raw.name, "name");
	if (name.length > 60) throw new BadRequest("A combination's name is at most 60 characters.");
	const base = resolveObjectType(str(raw.base, "base"));
	const joins = Array.isArray(raw.joins) ? (raw.joins as Array<Record<string, unknown>>) : [];
	const derived = Array.isArray(raw.derived) ? (raw.derived as Array<Record<string, unknown>>) : [];
	if (joins.length === 0 && derived.length === 0) {
		throw new BadRequest("A combination joins at least one linked type or derives at least one property.");
	}
	if (joins.length > 10) throw new BadRequest("At most ten joins.");

	const registry = getRegistry();
	const apiName = pascal(name);
	if (!/^[A-Z][A-Za-z0-9]*$/.test(apiName)) throw new BadRequest(`'${name}' does not make a usable type name.`);
	if (registry.objectTypeByApiName.has(apiName)) throw new BadRequest(`An object type called ${apiName} already exists.`);

	// Output columns: every base column, then the joined fields, then derived.
	const outputs = new Map<string, { sql: string; numeric: boolean; temporal?: boolean; from: string }>();
	// Columns that identify rows in the type they came from keep that role in
	// the combination: a reference copied into a view is still a reference.
	const identityColumns: string[] = [];
	for (const p of base.properties) {
		outputs.set(p.sqlColumn, { sql: `b.${quoteIdentifier(p.sqlColumn)}`, numeric: isNumeric(p), temporal: isTemporal(p), from: base.apiName });
		if (p.semanticRole === "identity" && p.sqlColumn !== base.primaryKeyColumn) identityColumns.push(p.sqlColumn);
	}
	const joinSql: string[] = [];
	const joinedHops = new Map<string, string>(); // path key -> alias, so shared prefixes join once
	let aliasCounter = 1;
	const fieldsUsed: Array<{ column: string; from: string; property: string }> = [];
	for (const join of joins) {
		const path = Array.isArray(join.path) ? (join.path as unknown[]).map(String) : join.link ? [String(join.link)] : [];
		if (path.length === 0) throw new BadRequest("Each join needs a path of one or more links.");
		const hops = walkPath(base, path, aliasCounter);
		let previousAlias = "b";
		let key = "";
		for (const hop of hops) {
			key = key ? `${key}>${hop.link.apiName}` : hop.link.apiName;
			let alias = joinedHops.get(key);
			if (!alias) {
				alias = `j${aliasCounter++}`;
				joinedHops.set(key, alias);
				const fromProp = hop.from.propertyBySqlColumn.get(hop.link.sourceColumn);
				const toProp = hop.to.propertyBySqlColumn.get(hop.link.targetColumn);
				const sameType = (fromProp?.sqlType ?? "a") === (toProp?.sqlType ?? "b");
				const left = `${previousAlias}.${quoteIdentifier(hop.link.sourceColumn)}`;
				const right = `${alias}.${quoteIdentifier(hop.link.targetColumn)}`;
				joinSql.push(
					`LEFT JOIN ${quoteQualified(hop.to.sourceView)} ${alias} ON ${sameType ? `${right} = ${left}` : `${right}::text = ${left}::text`}`,
				);
			}
			previousAlias = alias;
		}
		const finalType = hops[hops.length - 1]!.to;
		const fields = Array.isArray(join.fields) ? (join.fields as unknown[]).map(String) : [];
		if (fields.length === 0) throw new BadRequest(`Name the properties of ${finalType.apiName} to bring in.`);
		for (const field of fields) {
			const property = resolveColumn(finalType, field);
			const prefix = snake(finalType.apiName);
			let column = property.sqlColumn.startsWith(`${prefix}_`) ? property.sqlColumn : `${prefix}_${property.sqlColumn}`;
			column = uniqueName(column, (c) => outputs.has(c));
			outputs.set(column, {
				sql: `${previousAlias}.${quoteIdentifier(property.sqlColumn)}`,
				numeric: isNumeric(property),
				temporal: isTemporal(property),
				from: finalType.apiName,
			});
			if (property.semanticRole === "identity") identityColumns.push(column);
			fieldsUsed.push({ column, from: finalType.apiName, property: property.sqlColumn });
		}
	}
	const derivedUsed: Array<{ name: string; expression: string; metric?: DerivedMetric }> = [];
	for (const entry of derived) {
		const column = assertDerivedName(String(entry.name ?? ""));
		if (outputs.has(column)) throw new BadRequest(`'${column}' is already a property of this combination.`);
		const numericColumns = new Map(
			[...outputs.entries()].filter(([, value]) => value.numeric).map(([key, value]) => [key, value.sql]),
		);
		// Dates may be compared or subtracted with days_between; never added up.
		const dateColumns = new Map(
			[...outputs.entries()].filter(([, value]) => value.temporal).map(([key, value]) => [key, value.sql]),
		);
		// Any column the dataset carries may be what a sequence counts within.
		const keyColumns = new Map(
			[...outputs.entries()].filter(([, value]) => value.from !== "derived").map(([key, value]) => [key, value.sql]),
		);
		const { sql } = compileExpression(String(entry.expression ?? ""), numericColumns, dateColumns, keyColumns);
		outputs.set(column, { sql, numeric: true, from: "derived" });
		const metric = derivedMetric(entry.metric);
		derivedUsed.push({ name: column, expression: String(entry.expression), ...(metric ? { metric } : {}) });
	}

	const space = await queryOne<{ space_id: string }>("SELECT space_id::text FROM platform.space WHERE slug = $1", [currentSpace()]);
	const viewName = `s${space?.space_id ?? "0"}_${snake(apiName)}`.slice(0, 63);
	const selectList = [...outputs.entries()].map(([column, value]) => `${value.sql} AS ${quoteIdentifier(column)}`);
	const sql = `SELECT ${selectList.join(",\n       ")}\n  FROM ${quoteQualified(base.sourceView)} b\n  ${joinSql.join("\n  ")}`;

	// Measured: it has to run, and the person approving it sees real rows.
	let sample: Array<Record<string, unknown>>;
	let rowCount: number;
	try {
		sample = await query(`${sql}\n LIMIT 5`);
		const counted = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoteQualified(base.sourceView)}`);
		rowCount = Number(counted?.n ?? 0);
	} catch (error) {
		throw new BadRequest(`This combination would not run: ${(error as Error).message}`);
	}
	return {
		title: `New dataset: ${humanize(apiName)}`,
		summary:
			`${base.pluralLabel ?? plural(base.label)} with ` +
			[
				...fieldsUsed.map((f) => `${f.from}.${f.property}`),
				...derivedUsed.map((d) => `${d.name} = ${d.expression}${d.metric ? ` (measured as "${d.metric.label}")` : ""}`),
			].join(", ") +
			`. One row per ${base.label.toLowerCase()} (${rowCount.toLocaleString("en-US")} rows), modelled as the object type ${apiName}.`,
		payload: {
			name,
			apiName,
			base: base.apiName,
			joins: joins.map((join) => ({
				path: Array.isArray(join.path) ? join.path : [join.link],
				fields: join.fields,
			})),
			derived: derivedUsed,
			viewName: `ontology_views.${viewName}`,
		},
		preview: { sql, columns: [...outputs.keys()], sample, rowCount, identityColumns },
	};
}

async function applyCombination(payload: Record<string, unknown>, username: string): Promise<Record<string, unknown>> {
	const draft = await draftCombination(payload);
	const p = draft.payload;
	const base = resolveObjectType(String(p.base));
	const viewName = String(p.viewName);
	const sql = String(draft.preview.sql);
	const registry = getRegistry();
	await withActiveVersion(async (client, { spaceId }) => {
		await client.query(`CREATE OR REPLACE VIEW ${quoteQualified(viewName)} AS ${sql}`);
		await client.query(
			`INSERT INTO platform.combination (space_id, api_name, view_name, definition, sql, created_by)
			 VALUES ($1,$2,$3,$4::jsonb,$5,$6)
			 ON CONFLICT (view_name) DO UPDATE SET definition = EXCLUDED.definition, sql = EXCLUDED.sql`,
			[spaceId, p.apiName, viewName, JSON.stringify(p), sql, username],
		);
	});
	// The base type's outgoing links still hold on the combined rows, so they
	// are carried over; then the view is modelled like any table.
	const directForeignKeys = (registry.linksBySourceRid.get(base.rid) ?? [])
		.map((link) => {
			const target = registry.objectTypeByRid.get(link.targetObjectType);
			return target ? { column: link.sourceColumn, targetRelation: target.sourceView, targetColumn: link.targetColumn } : null;
		})
		.filter((fk): fk is NonNullable<typeof fk> => fk !== null);
	const model = await modelSources(
		[
			{
				relation: viewName,
				sourceName: `${base.apiName} combined (${viewName})`,
				tableName: String(p.name),
				datasetResourceId: null,
				primaryKey: base.keyIsUnique ? [base.primaryKeyColumn] : null,
				foreignKeys: [],
				directForeignKeys,
				identityColumns: (draft.preview.identityColumns as string[] | undefined) ?? [],
				group: "Combined",
				origin: "combination",
				apiName: String(p.apiName),
				description: draft.summary,
			},
		],
		username,
	);
	// The figures the derived columns were made for get the names they were
	// asked for: the automatic metric is adopted, or one is made. The dataset
	// stands either way, so a figure that cannot be made is reported, not fatal.
	const named: string[] = [];
	const notes: string[] = [];
	// Its rows are still the base type's: counted as "Orders", not "Enriched Orders".
	try {
		const counted = await applyMetric(
			{ objectType: p.apiName, aggregation: "count", label: base.pluralLabel ?? plural(base.label) },
			username,
		);
		named.push(String(counted.metric));
	} catch (error) {
		notes.push(`The row count keeps its automatic name: ${(error as Error).message}`);
	}
	for (const entry of (p.derived as Array<{ name: string; metric?: DerivedMetric }>) ?? []) {
		if (!entry.metric) continue;
		try {
			const { of, ...metric } = entry.metric;
			const made = await applyMetric(
				of
					? { objectType: p.apiName, ...metric, measure: of, filters: { [entry.name]: 1 } }
					: { objectType: p.apiName, measure: entry.name, ...metric },
				username,
			);
			named.push(String(made.metric));
		} catch (error) {
			notes.push(`"${entry.metric.label}" was not made: ${(error as Error).message}`);
		}
	}
	return {
		objectType: p.apiName,
		view: viewName,
		metrics: model.metrics.map((m) => m.apiName),
		links: model.links.map((l) => l.apiName),
		...(named.length ? { named } : {}),
		...(notes.length ? { notes } : {}),
	};
}

/** The metric a derived column is made for: "On-time rate" = avg(on_time_pct). */
export interface DerivedMetric {
	aggregation: "sum" | "avg" | "min" | "max" | "count_distinct";
	label: string;
	format?: "number" | "integer" | "currency" | "percent";
	/**
	 * count_distinct only: the column counted, over the rows this derived
	 * flag marks - "Returning customers" is the distinct customer_id of the
	 * orders flagged is_returning_customer.
	 */
	of?: string;
}

export function derivedMetric(raw: unknown): DerivedMetric | null {
	if (raw === undefined || raw === null) return null;
	const entry = raw as Record<string, unknown>;
	const aggregation = String(entry.aggregation ?? "").toLowerCase();
	if (!["sum", "avg", "min", "max", "count_distinct"].includes(aggregation)) {
		throw new BadRequest(
			"A derived property's metric adds up (sum), averages (avg), takes the min or max, or counts the distinct values of a column (count_distinct with of) over the rows it flags.",
		);
	}
	const of = entry.of === undefined || entry.of === null ? undefined : String(entry.of);
	if ((aggregation === "count_distinct") !== (of !== undefined)) {
		throw new BadRequest("count_distinct names the column it counts in 'of', and only count_distinct does.");
	}
	const label = str(entry.label, "derived[].metric.label");
	if (label.length > 60) throw new BadRequest("A metric's name is at most 60 characters.");
	const format = entry.format === undefined ? undefined : String(entry.format);
	if (format !== undefined && !["number", "integer", "currency", "percent"].includes(format)) {
		throw new BadRequest("format must be number, integer, currency or percent.");
	}
	return { aggregation, label, ...(format ? { format } : {}), ...(of ? { of } : {}) } as DerivedMetric;
}

// ── action_type ─────────────────────────────────────────────────────────────

async function draftActionType(raw: Record<string, unknown>): Promise<Draft> {
	const type = resolveObjectType(str(raw.objectType, "objectType"));
	const label = str(raw.label, "label");
	const registry = getRegistry();
	const apiName = uniqueName(pascal(str(raw.apiName, "apiName", false) || label), (name) => registry.actionTypeByApiName.has(name));
	const keyParameter = `${lowerFirst(type.apiName)}Key`;
	const parameters: Array<Record<string, unknown>> = [
		{ name: keyParameter, label: `${type.label} key`, type: "string", required: true },
	];
	// The key parameter is added here, so a payload being re-validated on
	// approval (which already carries it, with no property) does not count it.
	const requested = (Array.isArray(raw.parameters) ? (raw.parameters as Array<Record<string, unknown>>) : []).filter(
		(entry) => entry.name !== keyParameter || entry.property,
	);
	if (requested.length === 0) throw new BadRequest("An action needs at least one parameter: the property it changes.");
	for (const entry of requested) {
		const property = resolveColumn(type, str(entry.property, "parameters[].property"));
		if (property.sqlColumn === type.primaryKeyColumn) throw new BadRequest("The key identifies the object; an action cannot change it.");
		const allowed = Array.isArray(entry.allowedValues) ? (entry.allowedValues as unknown[]).map(String) : null;
		parameters.push({
			name: property.apiName,
			label: property.label,
			type: property.datatype,
			required: entry.required !== false,
			property: property.sqlColumn,
			...(allowed && allowed.length ? { validation: [{ type: "custom", value: { enum: allowed } }] } : {}),
		});
	}
	const owner = await queryOne<{ kind: string }>("SELECT kind FROM platform.space WHERE slug = $1", [currentSpace()]);
	const allowedRoles = Array.isArray(raw.allowedRoles) && raw.allowedRoles.length
		? (raw.allowedRoles as unknown[]).map(String)
		: owner?.kind === "personal"
			? ["tms:AdminRole", "tms:AnalystRole"]
			: ["tms:AdminRole"];
	return {
		title: `New action: ${label}`,
		summary:
			`Lets ${allowedRoles.map((r) => r.replace(/^tms:|Role$/g, "")).join(" and ")} run "${label}" on ${/^[aeiou]/i.test(type.label) ? "an" : "a"} ${type.label.toLowerCase()}, ` +
			`setting ${parameters.slice(1).map((p) => p.label).join(", ")}. Each run is validated, permission-checked and recorded ` +
			"in the audit trail. Synced tables are read-only copies of your database, so a run is staged with its exact payload rather than written back.",
		payload: {
			objectType: type.apiName,
			label,
			apiName,
			description: str(raw.description, "description", false) || null,
			parameters,
			allowedRoles,
		},
		preview: { parameters, targetType: type.apiName, outcome: "staged" },
	};
}

async function applyActionType(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	const draft = await draftActionType(payload);
	const p = draft.payload;
	const type = resolveObjectType(String(p.objectType));
	await withActiveVersion(async (client, { versionId }) => {
		await client.query(
			`INSERT INTO platform.action_type
			   (action_type_rid, ontology_version_id, api_name, label, description, target_object_types,
			    parameters, requires_approval, approver_roles, allowed_roles, audit_level, is_read_only, tags,
			    is_user_defined)
			 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,false,'{}',$8,'full',false,$9,true)`,
			[
				`ws:${p.apiName}`, versionId, p.apiName, p.label, p.description ?? draft.summary, [type.rid],
				JSON.stringify(p.parameters), p.allowedRoles, ["workspace"],
			],
		);
	});
	return { actionType: p.apiName };
}

// ── the lifecycle ───────────────────────────────────────────────────────────

const DRAFTERS: Record<ProposalKind, (payload: Record<string, unknown>) => Promise<Draft>> = {
	link_type: draftLink,
	metric: draftMetric,
	combination: draftCombination,
	action_type: draftActionType,
};

export async function createProposal(
	input: {
		kind?: unknown;
		payload?: unknown;
		title?: unknown;
		summary?: unknown;
		dependsOn?: unknown;
		createdVia?: unknown;
		chatSessionId?: unknown;
		followUp?: unknown;
	},
	createdBy: string,
): Promise<ProposalRecord> {
	const kind = String(input.kind ?? "") as ProposalKind;
	const drafter = DRAFTERS[kind];
	if (!drafter) throw new BadRequest(`kind must be one of ${Object.keys(DRAFTERS).join(", ")}.`);
	if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
		throw new BadRequest("payload must be an object.");
	}
	const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.map(Number).filter(Number.isInteger) : [];

	// A proposal that depends on pending ones is checked once they are applied;
	// drafting it now would fail on the link or type that does not exist yet.
	let draft: Draft;
	if (dependsOn.length > 0) {
		const pending = await query<{ proposal_id: string }>(
			`SELECT p.proposal_id FROM platform.proposal p JOIN platform.space s ON s.space_id = p.space_id
			  WHERE p.proposal_id = ANY($1) AND s.slug = $2`,
			[dependsOn, currentSpace()],
		);
		if (pending.length !== dependsOn.length) throw new BadRequest("dependsOn names a proposal that is not in this space.");
		draft = {
			title: String(input.title ?? `${kind} proposal`),
			summary: String(input.summary ?? "Validated when the proposals it depends on are applied."),
			payload: input.payload as Record<string, unknown>,
			preview: { deferred: true },
		};
	} else {
		draft = await drafter(input.payload as Record<string, unknown>);
	}
	const via = ["user", "assistant", "planner"].includes(String(input.createdVia)) ? String(input.createdVia) : "user";
	const row = await queryOne<ProposalRow>(
		`INSERT INTO platform.proposal
		   (space_id, kind, title, summary, payload, preview, depends_on, created_by, created_via, chat_session_id, follow_up)
		 SELECT s.space_id, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11::jsonb
		   FROM platform.space s WHERE s.slug = $1
		 RETURNING *`,
		[
			currentSpace(),
			kind,
			typeof input.title === "string" && input.title.trim() && dependsOn.length === 0 ? input.title.trim() : draft.title,
			draft.summary,
			JSON.stringify(draft.payload),
			JSON.stringify(draft.preview),
			dependsOn,
			createdBy,
			via,
			input.chatSessionId === undefined || input.chatSessionId === null ? null : Number(input.chatSessionId),
			((followUp) => (followUp ? JSON.stringify(followUp) : null))(parseFollowUp(input.followUp)),
		],
	);
	if (!row) throw new Error("The proposal was not stored.");
	return toRecord(row);
}

export async function listProposals(status?: string): Promise<ProposalRecord[]> {
	const rows = await query<ProposalRow>(
		`SELECT p.* FROM platform.proposal p JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND ($2::text IS NULL OR p.status = $2)
		  ORDER BY (p.status = 'pending') DESC, p.created_at DESC
		  LIMIT 200`,
		[currentSpace(), status ?? null],
	);
	return rows.map(toRecord);
}

export async function getProposal(id: number): Promise<ProposalRecord> {
	const row = await queryOne<ProposalRow>(
		`SELECT p.* FROM platform.proposal p JOIN platform.space s ON s.space_id = p.space_id
		  WHERE p.proposal_id = $1 AND s.slug = $2`,
		[id, currentSpace()],
	);
	if (!row) throw new NotFound(`No proposal ${id} in this space.`);
	return toRecord(row);
}

async function settle(id: number, status: ProposalStatus, decidedBy: string, fields: { result?: unknown; error?: string | null; note?: string | null }): Promise<ProposalRecord> {
	const row = await queryOne<ProposalRow>(
		`UPDATE platform.proposal
		    SET status = $2, decided_by = $3, decided_at = now(), result = $4::jsonb, error = $5,
		        decision_note = COALESCE($6, decision_note)
		  WHERE proposal_id = $1 RETURNING *`,
		[id, status, decidedBy, fields.result === undefined ? null : JSON.stringify(fields.result), fields.error ?? null, fields.note ?? null],
	);
	if (!row) throw new NotFound(`No proposal ${id}.`);
	return toRecord(row);
}

/**
 * Approve a proposal: apply its pending dependencies, then it.
 *
 * Returns every proposal settled on the way, in order. A failure marks that
 * proposal failed with the reason and stops, leaving the ones after it
 * pending - nothing is half-applied, because each apply is one transaction.
 */
export async function approveProposal(id: number, decidedBy: string, note?: string | null): Promise<ProposalRecord[]> {
	const settled: ProposalRecord[] = [];
	const visit = async (proposalId: number, chain: Set<number>): Promise<void> => {
		if (chain.has(proposalId)) throw new BadRequest("These proposals depend on each other in a cycle.");
		const proposal = await getProposal(proposalId);
		if (proposal.status === "applied") return;
		// A failed proposal may be approved again: what failed it - a type
		// renamed, a table mid-resync - is often gone a minute later.
		if (proposal.status !== "pending" && proposal.status !== "failed") {
			throw new BadRequest(`Proposal ${proposalId} is ${proposal.status}, so it cannot be applied.`);
		}
		for (const dependency of proposal.dependsOn) await visit(dependency, new Set([...chain, proposalId]));
		try {
			const result =
				proposal.kind === "link_type"
					? await applyLink(proposal.payload)
					: proposal.kind === "metric"
						? await applyMetric(proposal.payload, decidedBy)
						: proposal.kind === "combination"
							? await applyCombination(proposal.payload, decidedBy)
							: await applyActionType(proposal.payload);
			settled.push(await settle(proposalId, "applied", decidedBy, { result, note: proposalId === id ? note : null }));
		} catch (error) {
			settled.push(await settle(proposalId, "failed", decidedBy, { error: (error as Error).message }));
			throw new BadRequest(`Proposal ${proposalId} (${proposal.title}) could not be applied: ${(error as Error).message}`);
		}
	};
	await visit(id, new Set());
	return settled;
}

/** Record what a proposal's follow-up built (or why it could not). */
export async function recordFollowUp(id: number, built: Record<string, unknown>): Promise<ProposalRecord> {
	const row = await queryOne<ProposalRow>(
		`UPDATE platform.proposal
		    SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('built', $2::jsonb)
		  WHERE proposal_id = $1 RETURNING *`,
		[id, JSON.stringify(built)],
	);
	if (!row) throw new NotFound(`No proposal ${id}.`);
	return toRecord(row);
}

export async function rejectProposal(id: number, decidedBy: string, note?: string | null): Promise<ProposalRecord> {
	const proposal = await getProposal(id);
	if (proposal.status !== "pending") throw new BadRequest(`Proposal ${id} is already ${proposal.status}.`);
	return settle(id, "rejected", decidedBy, { note: note ?? null });
}

/** Internals for tests. */
export const __testing = { walkPath, dimensionsOf, metricMeta, uniqueName, pascal };
export type { ActionTypeMeta };
