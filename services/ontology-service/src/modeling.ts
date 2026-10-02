/**
 * Modelling connected tables into the ontology.
 *
 * The pipeline builds the TMS ontology from a fixed set of views at boot.
 * This module does the same job at runtime for any table a person connects:
 *
 *   table  ->  object type   one per table, properties classified by role
 *          ->  link types    from the source's declared foreign keys first,
 *                            then from naming conventions, each MEASURED
 *          ->  metrics       a count, a sum or average per measure, and a
 *                            distinct count per reference, sliceable by every
 *                            category and by day/week/month/quarter/year of
 *                            every date
 *
 * What it writes goes into the active ontology version of the space in scope,
 * as rows (object_type, object_property, link_type, kpi_definition) and as the
 * matching part of the OntologyDefinition document, in one transaction. A
 * re-import of the same table updates its type in place rather than adding a
 * second one, so modelling is safe to repeat.
 *
 * It never invents a value. A metric is a definition over columns that exist;
 * a link carries the share of rows that actually resolve, measured against the
 * data, and one that resolves less than half its rows on a name match alone is
 * not created at all.
 */

import type { PoolClient } from "pg";
import { pool, query } from "./db";
import { clearColumnCache } from "./kpi";
import {
	type ColumnProfile,
	humanize,
	inferRoles,
	plural,
	profileRelation,
	snake,
	singular,
	typeApiName,
	propertyApiName,
} from "./profiling";
import { activeVersion as ensureActiveVersion, publishChange } from "./definition";
import { BadRequest, currentSpace, quoteIdentifier, quoteQualified } from "./registry";

export interface SourceForeignKey {
	columns: string[];
	refSchema: string;
	refTable: string;
	refColumns: string[];
}

export interface ModelSource {
	/** Where the rows are, e.g. connection_raw.w3_shop__public__orders. */
	relation: string;
	/** The table on the source, for people: public.orders. */
	sourceName: string;
	/** The name the object type is derived from: orders -> Order. */
	tableName: string;
	datasetResourceId: number | null;
	primaryKey: string[] | null;
	uniqueColumns?: string[];
	foreignKeys: SourceForeignKey[];
	/** Shown as the type's group, e.g. the connection's name. */
	group: string | null;
	origin?: "modelled" | "combination";
	description?: string | null;
	/** Forces the api name (combinations choose their own). */
	apiName?: string;
	/**
	 * References to relations already modelled, by relation rather than by
	 * source table: a combination keeps its base type's links this way.
	 */
	directForeignKeys?: Array<{ column: string; targetRelation: string; targetColumn: string }>;
	/**
	 * Columns already known to identify rows of some type: a combination's
	 * copies of its base type's references and keys. Profiling a view sees
	 * no constraints, so without this an integer reference (ship_via) reads
	 * as a number to add up.
	 */
	identityColumns?: string[];
}

export interface ModelOutcome {
	objectTypes: Array<{
		apiName: string;
		label: string;
		relation: string;
		rowCount: number;
		properties: number;
		keyColumn: string;
		keyIsUnique: boolean;
		created: boolean;
		roles: Record<string, number>;
	}>;
	links: Array<{
		apiName: string;
		label: string;
		source: string;
		target: string;
		sourceColumn: string;
		targetColumn: string;
		method: "foreign_key" | "naming_convention";
		matchRatio: number;
	}>;
	metrics: Array<{ apiName: string; label: string; objectType: string }>;
	warnings: string[];
}

const PALETTE = ["#3f7fd8", "#d9822b", "#2e9e6b", "#9b59b6", "#c0504d", "#16a2b8", "#b8860b", "#6c757d"];
const GRAINS = ["day", "week", "month", "quarter", "year"] as const;
const LINK_MIN_RATIO_BY_NAME = 0.5;
const MAX_DIMENSIONS = 30;

interface TypeRow {
	object_type_rid: string;
	api_name: string;
	label: string;
	plural_label: string | null;
	source_view: string;
	primary_key_column: string;
	title_column: string | null;
	origin: string;
	row_count: string;
	key_is_unique: boolean;
}

interface Planned {
	source: ModelSource;
	rowCount: number;
	profiles: ColumnProfile[];
	apiName: string;
	rid: string;
	label: string;
	pluralLabel: string;
	keyColumn: string;
	keyIsUnique: boolean;
	created: boolean;
}

function lowerFirst(value: string): string {
	return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function pascal(value: string): string {
	return value
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
}

function unique(base: string, taken: Set<string>): string {
	let candidate = base;
	for (let n = 2; taken.has(candidate) || taken.has(candidate.toLowerCase()); n += 1) candidate = `${base}${n}`;
	taken.add(candidate);
	taken.add(candidate.toLowerCase());
	return candidate;
}

/** The space and active ontology version, locked so two models cannot interleave. */
async function activeVersion(client: PoolClient): Promise<{ versionId: number; spaceId: number }> {
	const result = await client.query<{ ontology_version_id: string; space_id: string }>(
		`SELECT v.ontology_version_id, v.space_id
		   FROM platform.ontology_version v JOIN platform.space s ON s.space_id = v.space_id
		  WHERE v.is_active AND s.slug = $1
		  FOR UPDATE OF v`,
		[currentSpace()],
	);
	const row = result.rows[0];
	if (!row) {
		// A space starts with no ontology; definition.ts creates its empty
		// active version (committed on its own), and this transaction locks it.
		await ensureActiveVersion(currentSpace());
		return activeVersion(client);
	}
	return { versionId: Number(row.ontology_version_id), spaceId: Number(row.space_id) };
}

/** Which date column a metric is placed in time by, when a type has several. */
export function chooseTimeColumn(profiles: ColumnProfile[]): string | null {
	const temporal = profiles.filter((p) => p.role === "temporal");
	if (temporal.length === 0) return null;
	const preferred = temporal.find((p) =>
		/(order|created|placed|invoice|transaction|sale|event|occurred|booked|purchase|payment|signup|start)/.test(p.name.toLowerCase()),
	);
	// A person's birth date places nothing in business time; when there is any
	// other date (a hire date, say) that one is the timeline.
	const ordinary = temporal.find((p) => !/(birth|dob|born|death|deceased|expir)/.test(p.name.toLowerCase()));
	return (preferred ?? ordinary ?? temporal[0]!).name;
}

/**
 * How a type with no dates is sliced first: by where or what kind (country,
 * category, status) before anything else, and never by a contact's details.
 */
export function defaultSlice(dimensions: string[]): string | null {
	const categorical = dimensions.filter((d) => !d.includes(":"));
	const usable = categorical.filter((d) => !/(contact_|job_title|title_of_courtesy|salutation|phone|fax|email|address|postal|zip)/.test(d));
	// Country before region: regions are often blank outside a few countries.
	for (const kind of [/country|nation/, /region|state|province|territory/, /category|segment|type|status|tier|channel|group/]) {
		const hit = usable.find((d) => kind.test(d));
		if (hit) return hit;
	}
	return usable[0] ?? categorical[0] ?? null;
}

/** The dimensions every metric on a type may be sliced by. */
export function dimensionsFor(profiles: ColumnProfile[]): string[] {
	const categorical = profiles.filter((p) => p.role === "dimension" || p.role === "flag").map((p) => p.name);
	const grains = profiles
		.filter((p) => p.role === "temporal")
		.flatMap((p) => GRAINS.map((grain) => `${p.name}:${grain}`));
	return [...categorical, ...grains].slice(0, MAX_DIMENSIONS);
}

export interface MetricSpec {
	apiName: string;
	label: string;
	description: string;
	businessQuestion: string;
	aggregation: "count" | "sum" | "avg" | "count_distinct";
	measureColumn: string | null;
	valueFormat: "number" | "integer" | "currency" | "percent";
	unit: string | null;
	higherIsBetter: boolean | null;
}

/**
 * The default metrics for one modelled type. Pure, for tests.
 *
 * `references` names the type a reference column links to, so a distinct
 * count over orders.ship_via reads "Distinct shippers", not "Distinct ship vias".
 */
export function metricsFor(
	apiName: string,
	label: string,
	pluralLabel: string,
	profiles: ColumnProfile[],
	references: Map<string, string> = new Map(),
): MetricSpec[] {
	const base = snake(apiName);
	const specs: MetricSpec[] = [
		{
			apiName: `${base}_count`,
			label: pluralLabel,
			description: `Number of ${pluralLabel.toLowerCase()}.`,
			businessQuestion: `How many ${pluralLabel.toLowerCase()} are there?`,
			aggregation: "count",
			measureColumn: null,
			valueFormat: "integer",
			unit: null,
			higherIsBetter: null,
		},
	];
	for (const p of profiles.filter((x) => x.role === "measure")) {
		const average = p.defaultAggregation === "avg";
		const name = humanize(p.name);
		specs.push({
			apiName: `${base}_${snake(p.name)}_${average ? "avg" : "sum"}`,
			label: average ? `Average ${name}` : `Total ${name}`,
			description: `${average ? "Average" : "Sum"} of ${p.name} across ${pluralLabel.toLowerCase()}.`,
			businessQuestion: `What is the ${average ? "average" : "total"} ${name.toLowerCase()} of our ${pluralLabel.toLowerCase()}?`,
			aggregation: average ? "avg" : "sum",
			measureColumn: p.name,
			valueFormat: p.format === "integer" && average ? "number" : p.format,
			unit: p.unit,
			higherIsBetter: null,
		});
	}
	for (const p of profiles.filter((x) => x.isForeignKey || (x.role === "identity" && !x.isKey))) {
		const referenced =
			references.get(p.name) ?? (humanize(p.name.replace(/_(id|key|code|no|number|ref)$/i, "")) || humanize(p.name));
		specs.push({
			apiName: `${base}_distinct_${snake(p.name)}`,
			label: `Distinct ${plural(referenced.toLowerCase())}`,
			description: `Number of different ${p.name} values among ${pluralLabel.toLowerCase()}.`,
			businessQuestion: `How many different ${plural(referenced.toLowerCase())} appear in ${pluralLabel.toLowerCase()}?`,
			aggregation: "count_distinct",
			measureColumn: p.name,
			valueFormat: "integer",
			unit: null,
			higherIsBetter: null,
		});
	}
	void label;
	return specs;
}

/** Share of non-null source values that resolve to a target row. */
async function measureLink(
	client: PoolClient,
	sourceRelation: string,
	sourceColumn: string,
	targetRelation: string,
	targetColumn: string,
): Promise<{ candidates: number; matched: number; ratio: number; targetUnique: boolean }> {
	const s = quoteIdentifier(sourceColumn);
	const t = quoteIdentifier(targetColumn);
	const measured = await client.query<{ candidates: string; matched: string; target_rows: string; target_distinct: string }>(
		`SELECT
		   (SELECT count(*) FROM ${quoteQualified(sourceRelation)} WHERE ${s} IS NOT NULL)::text AS candidates,
		   (SELECT count(*) FROM ${quoteQualified(sourceRelation)} src
		     WHERE src.${s} IS NOT NULL
		       AND src.${s}::text IN (SELECT ${t}::text FROM ${quoteQualified(targetRelation)} WHERE ${t} IS NOT NULL))::text AS matched,
		   (SELECT count(${t}) FROM ${quoteQualified(targetRelation)})::text AS target_rows,
		   (SELECT count(DISTINCT ${t}) FROM ${quoteQualified(targetRelation)})::text AS target_distinct`,
	);
	const row = measured.rows[0]!;
	const candidates = Number(row.candidates);
	const matched = Number(row.matched);
	return {
		candidates,
		matched,
		ratio: candidates === 0 ? 0 : matched / candidates,
		targetUnique: Number(row.target_rows) === Number(row.target_distinct),
	};
}

/**
 * Model a set of tables into the active ontology of the space in scope.
 *
 * `relationBySource` maps a source table (schema.table on the far side) to
 * where it landed here, covering earlier imports as well as this one, so a
 * foreign key to a table imported last week still becomes a link.
 */
export async function modelSources(
	sources: ModelSource[],
	createdBy: string,
	relationBySource: Map<string, string> = new Map(),
): Promise<ModelOutcome> {
	if (sources.length === 0) throw new BadRequest("Name at least one table to model.");
	const outcome: ModelOutcome = { objectTypes: [], links: [], metrics: [], warnings: [] };

	// Profiling reads every row once per table, so it happens before the
	// transaction rather than while holding its lock.
	const profiled = [];
	for (const source of sources) {
		const { rowCount, columns } = await profileRelation(source.relation);
		const foreignKeyColumns = new Set([
			...source.foreignKeys.filter((fk) => fk.columns.length === 1).map((fk) => fk.columns[0]!),
			...(source.directForeignKeys ?? []).map((fk) => fk.column),
			...(source.identityColumns ?? []),
		]);
		const profiles = inferRoles(rowCount, columns, {
			primaryKey: source.primaryKey,
			foreignKeyColumns,
			uniqueColumns: new Set(source.uniqueColumns ?? []),
		});
		if (rowCount === 0) outcome.warnings.push(`${source.sourceName} has no rows yet; its metrics will read as empty until it does.`);
		profiled.push({ source, rowCount, profiles });
		relationBySource.set(source.sourceName, source.relation);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const { versionId, spaceId } = await activeVersion(client);

		const existing = (
			await client.query<TypeRow>(
				`SELECT object_type_rid, api_name, label, plural_label, source_view, primary_key_column,
				        title_column, origin, row_count::text, key_is_unique
				   FROM platform.object_type WHERE ontology_version_id = $1`,
				[versionId],
			)
		).rows;
		const takenNames = new Set(existing.flatMap((t) => [t.api_name, t.api_name.toLowerCase()]));

		// ── object types ──────────────────────────────────────────────────────
		const planned: Planned[] = profiled.map(({ source, rowCount, profiles }, index) => {
			const prior = existing.find((t) => t.source_view === source.relation);
			const apiName = prior?.api_name ?? unique(source.apiName ?? typeApiName(source.tableName), takenNames);
			const words = humanize(singular(source.tableName.split(".").pop() ?? source.tableName));
			const label = source.apiName ? humanize(source.apiName) : words;
			const key = profiles.find((p) => p.isKey);
			void index;
			return {
				source,
				rowCount,
				profiles,
				apiName,
				rid: prior?.object_type_rid ?? `ws:${apiName}`,
				label,
				pluralLabel: label.split(" ").slice(0, -1).concat(plural(label.split(" ").pop()!)).join(" "),
				keyColumn: key?.name ?? profiles[0]!.name,
				keyIsUnique: Boolean(key),
				created: !prior,
			};
		});

		const colorOffset = existing.filter((t) => t.origin !== "pipeline").length;
		for (const [index, plan] of planned.entries()) {
			const title = plan.profiles.find((p) => p.isTitle)?.name ?? null;
			const description =
				plan.source.description ??
				`${plan.pluralLabel}, modelled from ${plan.source.sourceName}. ${plan.rowCount.toLocaleString("en-US")} rows when last synced.`;
			if (plan.created) {
				await client.query(
					`INSERT INTO platform.object_type
					   (object_type_rid, ontology_version_id, api_name, label, plural_label, description, kind,
					    source_view, primary_key_column, title_column, icon, color, group_name, row_count,
					    display_order, origin, dataset_resource_id, key_is_unique)
					 VALUES ($1,$2,$3,$4,$5,$6,'entity',$7,$8,$9,NULL,$10,$11,$12,$13,$14,$15,$16)`,
					[
						plan.rid, versionId, plan.apiName, plan.label, plan.pluralLabel, description,
						plan.source.relation, plan.keyColumn, title,
						PALETTE[(colorOffset + index) % PALETTE.length], plan.source.group, plan.rowCount,
						500 + colorOffset + index, plan.source.origin ?? "modelled",
						plan.source.datasetResourceId, plan.keyIsUnique,
					],
				);
			} else {
				await client.query(
					`UPDATE platform.object_type
					    SET description = $3, primary_key_column = $4, title_column = $5, row_count = $6,
					        key_is_unique = $7, dataset_resource_id = COALESCE($8, dataset_resource_id),
					        group_name = COALESCE($9, group_name)
					  WHERE ontology_version_id = $1 AND object_type_rid = $2`,
					[versionId, plan.rid, description, plan.keyColumn, title, plan.rowCount, plan.keyIsUnique,
						plan.source.datasetResourceId, plan.source.group],
				);
				await client.query(
					"DELETE FROM platform.object_property WHERE ontology_version_id = $1 AND object_type_rid = $2",
					[versionId, plan.rid],
				);
			}

			const takenProps = new Set<string>();
			for (const [order, p] of plan.profiles.entries()) {
				const propApi = unique(propertyApiName(p.name), takenProps);
				await client.query(
					`INSERT INTO platform.object_property
					   (object_property_rid, ontology_version_id, object_type_rid, api_name, label, description,
					    datatype, sql_column, sql_type, is_identity, is_title, is_nullable, is_foreign_key,
					    semantic_role, default_aggregation, unit, display_order)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
					[
						`${plan.rid}.${propApi}`, versionId, plan.rid, propApi, humanize(p.name), p.reason,
						p.datatype, p.name, p.dataType, p.role === "identity", p.isTitle,
						p.nonNull < plan.rowCount, p.isForeignKey, p.role, p.defaultAggregation, p.unit, (order + 1) * 10,
					],
				);
			}
			const roles: Record<string, number> = {};
			for (const p of plan.profiles) roles[p.role] = (roles[p.role] ?? 0) + 1;
			outcome.objectTypes.push({
				apiName: plan.apiName,
				label: plan.label,
				relation: plan.source.relation,
				rowCount: plan.rowCount,
				properties: plan.profiles.length,
				keyColumn: plan.keyColumn,
				keyIsUnique: plan.keyIsUnique,
				created: plan.created,
				roles,
			});
			if (!plan.keyIsUnique) {
				outcome.warnings.push(
					`${plan.source.sourceName} has no column that is unique on every row, so opening one ${plan.label} by its key may match several rows.`,
				);
			}
		}

		// ── links ─────────────────────────────────────────────────────────────
		const allTypes = [
			...existing
				.filter((t) => !planned.some((p) => p.rid === t.object_type_rid))
				.map((t) => ({ rid: t.object_type_rid, apiName: t.api_name, label: t.label, relation: t.source_view, key: t.primary_key_column, keyIsUnique: t.key_is_unique })),
			...planned.map((p) => ({ rid: p.rid, apiName: p.apiName, label: p.label, relation: p.source.relation, key: p.keyColumn, keyIsUnique: p.keyIsUnique })),
		];
		const typeByRelation = new Map(allTypes.map((t) => [t.relation, t]));
		const existingLinks = (
			await client.query<{ api_name: string; source_object_type: string; source_column: string; target_object_type: string }>(
				"SELECT api_name, source_object_type, source_column, target_object_type FROM platform.link_type WHERE ontology_version_id = $1",
				[versionId],
			)
		).rows;
		const takenLinks = new Set(existingLinks.flatMap((l) => [l.api_name, l.api_name.toLowerCase()]));
		const hasLink = (source: string, column: string, target: string) =>
			existingLinks.some((l) => l.source_object_type === source && l.source_column === column && l.target_object_type === target);

		const addLink = async (
			plan: Planned,
			column: string,
			target: { rid: string; apiName: string; label: string; relation: string },
			targetColumn: string,
			method: "foreign_key" | "naming_convention",
		): Promise<void> => {
			if (hasLink(plan.rid, column, target.rid)) return;
			const measured = await measureLink(client, plan.source.relation, column, target.relation, targetColumn);
			if (method === "naming_convention" && measured.ratio < LINK_MIN_RATIO_BY_NAME) return;
			// Named for the column, not the target: an order's billing and
			// shipping address are two links to the same type, and the column is
			// what tells them apart (orderBillingAddress, orderShippingAddress).
			const role = pascal(column.replace(/_(id|key|code|no|number|ref)$/i, "")) || target.apiName;
			const apiName = unique(lowerFirst(plan.apiName) + role, takenLinks);
			const inverse = unique(lowerFirst(target.apiName) + pascal(plural(snake(plan.apiName))), takenLinks);
			const roleLabel = humanize(role);
			const label =
				roleLabel.toLowerCase() === target.label.toLowerCase()
					? `${plan.label} → ${target.label}`
					: `${plan.label} → ${roleLabel} (${target.label})`;
			await client.query(
				`INSERT INTO platform.link_type
				   (link_type_rid, ontology_version_id, api_name, label, description, source_object_type,
				    target_object_type, source_column, target_column, cardinality, inverse_api_name,
				    inverse_label, discovery_method, match_ratio, matched_rows, candidate_rows, is_verified,
				    is_user_defined)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false)`,
				[
					`ws:${apiName}`, versionId, apiName, label,
					method === "foreign_key"
						? `Declared by the source: ${plan.source.sourceName}.${column} is a foreign key to ${target.label}.${targetColumn}.`
						: `${column} matches ${target.label}.${targetColumn} by name, and ${(measured.ratio * 100).toFixed(1)}% of its values resolve.`,
					plan.rid, target.rid, column, targetColumn,
					measured.targetUnique ? "MANY_TO_ONE" : "MANY_TO_MANY",
					inverse, `${target.label} → ${plan.pluralLabel}`, method,
					measured.ratio.toFixed(4), measured.matched, measured.candidates, measured.ratio >= 0.999,
				],
			);
			existingLinks.push({ api_name: apiName, source_object_type: plan.rid, source_column: column, target_object_type: target.rid });
			outcome.links.push({
				apiName, label, source: plan.apiName, target: target.apiName, sourceColumn: column,
				targetColumn, method, matchRatio: measured.ratio,
			});
			if (measured.ratio < 0.999 && measured.candidates > 0) {
				outcome.warnings.push(
					`${label}: ${measured.candidates - measured.matched} of ${measured.candidates} ${plan.pluralLabel.toLowerCase()} reference a ${target.label.toLowerCase()} that was not synced (or does not exist).`,
				);
			}
		};

		for (const plan of planned) {
			// 1. Foreign keys the source declares.
			for (const fk of plan.source.foreignKeys) {
				if (fk.columns.length !== 1 || fk.refColumns.length !== 1) {
					outcome.warnings.push(`${plan.source.sourceName}: a composite foreign key (${fk.columns.join(", ")}) was not turned into a link.`);
					continue;
				}
				const targetRelation = relationBySource.get(`${fk.refSchema}.${fk.refTable}`);
				const target = targetRelation ? typeByRelation.get(targetRelation) : undefined;
				if (!target) {
					outcome.warnings.push(
						`${plan.source.sourceName}.${fk.columns[0]} refers to ${fk.refSchema}.${fk.refTable}, which has not been imported. Import it to get the link.`,
					);
					continue;
				}
				await addLink(plan, fk.columns[0]!, target, fk.refColumns[0]!, "foreign_key");
			}
			// 1b. References carried over from the type a combination is built on.
			for (const fk of plan.source.directForeignKeys ?? []) {
				const target = typeByRelation.get(fk.targetRelation);
				if (target && plan.profiles.some((p) => p.name === fk.column)) {
					await addLink(plan, fk.column, target, fk.targetColumn, "foreign_key");
				}
			}
			// 2. Columns named for another type's key, verified against the data.
			for (const p of plan.profiles) {
				if (p.isKey || p.isForeignKey || p.role !== "identity") continue;
				const stem = p.name.toLowerCase().replace(/_(id|key|code|no|number)$/, "");
				for (const target of allTypes) {
					// A name match only means something against a real key: a type
					// whose "key" repeats across rows is not a thing to point at.
					if (target.rid === plan.rid || !target.keyIsUnique) continue;
					const targetStem = snake(target.apiName);
					const keyMatches =
						target.key.toLowerCase() === p.name.toLowerCase() ||
						((stem === targetStem || stem === snake(singular(targetStem))) &&
							["id", `${targetStem}_id`, "key", "code"].includes(target.key.toLowerCase()));
					if (keyMatches) await addLink(plan, p.name, target, target.key, "naming_convention");
				}
			}
		}

		// ── metrics ───────────────────────────────────────────────────────────
		const existingMetrics = (
			await client.query<{
				api_name: string;
				object_type_rid: string | null;
				origin: string;
				measure_column: string | null;
				aggregation: string;
				unfiltered: boolean;
			}>(
				`SELECT api_name, object_type_rid, origin, measure_column, aggregation,
				        (conditions IS NULL OR conditions = '{}'::jsonb) AS unfiltered
				   FROM platform.kpi_definition WHERE space_id = $1`,
				[spaceId],
			)
		).rows;
		const takenMetrics = new Set(
			existingMetrics
				.filter((row) => !(row.origin === "modelled" && planned.some((p) => p.rid === row.object_type_rid)))
				.map((row) => row.api_name),
		);
		// A metric someone approved in place of an automatic one keeps its
		// place: modelling the type again does not add the automatic twin back.
		const adopted = new Set(
			existingMetrics
				.filter((row) => row.origin !== "modelled" && row.unfiltered)
				.map((row) => `${row.object_type_rid}|${row.measure_column}|${row.aggregation}`),
		);
		for (const plan of planned) {
			await client.query(
				"DELETE FROM platform.kpi_definition WHERE space_id = $1 AND object_type_rid = $2 AND origin = 'modelled'",
				[spaceId, plan.rid],
			);
			const dimensions = dimensionsFor(plan.profiles);
			const timeColumn = chooseTimeColumn(plan.profiles);
			const defaultDimension = timeColumn ? `${timeColumn}:month` : defaultSlice(dimensions);
			const references = new Map(
				existingLinks
					.filter((link) => link.source_object_type === plan.rid)
					.map((link) => [link.source_column, allTypes.find((t) => t.rid === link.target_object_type)?.label ?? ""] as const)
					.filter(([, target]) => Boolean(target)),
			);
			for (const [order, metric] of metricsFor(plan.apiName, plan.label, plan.pluralLabel, plan.profiles, references).entries()) {
				if (adopted.has(`${plan.rid}|${metric.measureColumn ?? null}|${metric.aggregation}`)) continue;
				const apiName = unique(metric.apiName, takenMetrics);
				await client.query(
					`INSERT INTO platform.kpi_definition
					   (space_id, kpi_rid, api_name, label, description, business_question, category, source_view,
					    measure_column, aggregation, dimensions, default_dimension, time_column, unit, value_format,
					    higher_is_better, related_object_types, depends_on_simulation, display_order, origin,
					    object_type_rid, created_by)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18,'modelled',$19,$20)
					 ON CONFLICT (space_id, kpi_rid) DO UPDATE SET
					   api_name = EXCLUDED.api_name, label = EXCLUDED.label, description = EXCLUDED.description,
					   business_question = EXCLUDED.business_question, category = EXCLUDED.category,
					   source_view = EXCLUDED.source_view, measure_column = EXCLUDED.measure_column,
					   aggregation = EXCLUDED.aggregation, dimensions = EXCLUDED.dimensions,
					   default_dimension = EXCLUDED.default_dimension, time_column = EXCLUDED.time_column,
					   unit = EXCLUDED.unit, value_format = EXCLUDED.value_format, origin = 'modelled',
					   object_type_rid = EXCLUDED.object_type_rid`,
					[
						spaceId, `kpi:${apiName}`, apiName, metric.label, metric.description, metric.businessQuestion,
						plan.label, plan.source.relation, metric.measureColumn, metric.aggregation, dimensions,
						defaultDimension,
						timeColumn, metric.unit, metric.valueFormat, metric.higherIsBetter, [plan.rid],
						1000 + order, plan.rid, createdBy,
					],
				);
				outcome.metrics.push({ apiName, label: metric.label, objectType: plan.apiName });
			}
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}

	clearColumnCache();
	await publishChange(currentSpace());
	return outcome;
}

/** measureLink outside a transaction, for a proposal's preview. */
export async function measureLinkNow(
	sourceRelation: string,
	sourceColumn: string,
	targetRelation: string,
	targetColumn: string,
): Promise<{ candidates: number; matched: number; ratio: number; targetUnique: boolean }> {
	const client = await pool.connect();
	try {
		return await measureLink(client, sourceRelation, sourceColumn, targetRelation, targetColumn);
	} finally {
		client.release();
	}
}

/**
 * Add one link to the workspace ontology: an approved proposal, or a link
 * someone drew. Measured on insert, like every other link.
 */
export async function insertWorkspaceLink(request: {
	apiName: string;
	label: string;
	description: string;
	sourceRid: string;
	targetRid: string;
	sourceRelation: string;
	targetRelation: string;
	sourceColumn: string;
	targetColumn: string;
	inverseApiName: string;
	inverseLabel: string;
}): Promise<{ matchRatio: number; matched: number; candidates: number; cardinality: string }> {
	const client = await pool.connect();
	let outcome: { matchRatio: number; matched: number; candidates: number; cardinality: string };
	try {
		await client.query("BEGIN");
		const { versionId } = await activeVersion(client);
		const measured = await measureLink(
			client,
			request.sourceRelation,
			request.sourceColumn,
			request.targetRelation,
			request.targetColumn,
		);
		const cardinality = measured.targetUnique ? "MANY_TO_ONE" : "MANY_TO_MANY";
		await client.query(
			`INSERT INTO platform.link_type
			   (link_type_rid, ontology_version_id, api_name, label, description, source_object_type,
			    target_object_type, source_column, target_column, cardinality, inverse_api_name,
			    inverse_label, discovery_method, match_ratio, matched_rows, candidate_rows, is_verified,
			    is_user_defined)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13,$14,$15,$16,true)`,
			[
				`ws:${request.apiName}`, versionId, request.apiName, request.label, request.description,
				request.sourceRid, request.targetRid, request.sourceColumn, request.targetColumn, cardinality,
				request.inverseApiName, request.inverseLabel, measured.ratio.toFixed(4), measured.matched,
				measured.candidates, measured.ratio >= 0.999,
			],
		);
		await client.query("COMMIT");
		outcome = { matchRatio: measured.ratio, matched: measured.matched, candidates: measured.candidates, cardinality };
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
		clearColumnCache();
	}
	await publishChange(currentSpace());
	return outcome;
}

/** Run `work` inside a transaction on the active version, then resync and reload. */
export async function withActiveVersion<T>(
	work: (client: PoolClient, version: { versionId: number; spaceId: number }) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	let result: T;
	try {
		await client.query("BEGIN");
		const version = await activeVersion(client);
		result = await work(client, version);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
		clearColumnCache();
	}
	// The document, the registry and the workspace cards follow the rows.
	await publishChange(currentSpace());
	return result;
}


/** Remove a modelled or combined type with its properties, links and metrics. */
export async function removeModelledType(apiName: string): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const { versionId, spaceId } = await activeVersion(client);
		const type = (
			await client.query<{ object_type_rid: string; origin: string; source_view: string }>(
				"SELECT object_type_rid, origin, source_view FROM platform.object_type WHERE ontology_version_id = $1 AND api_name = $2",
				[versionId, apiName],
			)
		).rows[0];
		if (!type) throw new BadRequest(`No object type '${apiName}' in this space.`);
		if (type.origin === "pipeline") {
			throw new BadRequest(`${apiName} is generated by the pipeline and is rebuilt on its next run; it cannot be removed here.`);
		}
		await client.query(
			"DELETE FROM platform.link_type WHERE ontology_version_id = $1 AND (source_object_type = $2 OR target_object_type = $2)",
			[versionId, type.object_type_rid],
		);
		await client.query("DELETE FROM platform.object_property WHERE ontology_version_id = $1 AND object_type_rid = $2", [versionId, type.object_type_rid]);
		await client.query("DELETE FROM platform.object_type WHERE ontology_version_id = $1 AND object_type_rid = $2", [versionId, type.object_type_rid]);
		await client.query("DELETE FROM platform.kpi_definition WHERE space_id = $1 AND object_type_rid = $2", [spaceId, type.object_type_rid]);
		if (type.origin === "combination") {
			await client.query(`DROP VIEW IF EXISTS ${quoteQualified(type.source_view)}`);
			await client.query("DELETE FROM platform.combination WHERE space_id = $1 AND view_name = $2", [spaceId, type.source_view]);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
	clearColumnCache();
	await publishChange(currentSpace());
}

/** Object types in the space that were modelled from connected tables. */
export async function modelledTypes(): Promise<Array<{ apiName: string; relation: string; origin: string }>> {
	const rows = await query<{ api_name: string; source_view: string; origin: string }>(
		`SELECT t.api_name, t.source_view, t.origin
		   FROM platform.object_type t
		   JOIN platform.ontology_version v ON v.ontology_version_id = t.ontology_version_id AND v.is_active
		   JOIN platform.space s ON s.space_id = v.space_id
		  WHERE s.slug = $1 AND t.origin <> 'pipeline'
		  ORDER BY t.display_order`,
		[currentSpace()],
	);
	return rows.map((row) => ({ apiName: row.api_name, relation: row.source_view, origin: row.origin }));
}
