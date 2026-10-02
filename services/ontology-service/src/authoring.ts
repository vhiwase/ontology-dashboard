/**
 * Building the ontology from datasets.
 *
 *     dataset (a synced view, as it is)
 *        └─ object type   one per dataset, a property per column
 *             ├─ links     between object types, measured against the data
 *             ├─ actions   verbs on an object type, validated and staged
 *             └─ metrics   aggregations over an object type's properties
 *
 * A person uses these through the Datasets and Object types pages; the AI-FDE
 * uses them through the same routes, with the signed-in user's token. Nothing
 * here changes a row of data. It describes data that a sync already landed,
 * and every description is checked against that data before it is stored:
 * a primary key that is not unique, a measure that is not numeric or a
 * metric that does not compute is refused with the numbers that show why.
 *
 * ── profiling ──────────────────────────────────────────────────────────────
 * profileDataset is deterministic and cheap, and it is what makes the
 * assistant reliable at this: it hands over real distinct and null counts,
 * real sample values and suggested roles, so the model chooses between
 * candidates the data offered rather than inventing a key column.
 */

import { query, queryOne } from "./db";
import { activeVersion, datatypeFor, NAMESPACE, publishChange, ROLE_IDS } from "./definition";
import { ENUMS, journal, measureJoin } from "./builder";
import { executeKpi } from "./kpi";
import {
	BadRequest,
	currentSpace,
	getRegistry,
	NotFound,
	quoteIdentifier,
	quoteQualified,
	resolveObjectType,
	type ObjectTypeMeta,
	type PropertyMeta,
} from "./registry";
import { DATASET_SCHEMA } from "./sqlGuard";

// ── naming ──────────────────────────────────────────────────────────────────

function words(identifier: string): string[] {
	return identifier
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean);
}

export function camelCase(identifier: string): string {
	const parts = words(identifier).map((word) => word.toLowerCase());
	const joined = parts
		.map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join("");
	return /^[a-z]/.test(joined) ? joined : `p${joined}`;
}

export function pascalCase(identifier: string): string {
	const camel = camelCase(identifier);
	return camel.charAt(0).toUpperCase() + camel.slice(1);
}

export function humanize(identifier: string): string {
	return words(identifier)
		.map((word) => (word.toLowerCase() === "pct" ? "%" : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
		.join(" ");
}

function singular(word: string): string {
	if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
	if (/(ss|us)$/i.test(word)) return word;
	if (/(sh|ch|x|z)es$/i.test(word)) return word.replace(/es$/i, "");
	if (/s$/i.test(word)) return word.replace(/s$/i, "");
	return word;
}

function plural(word: string): string {
	if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
	if (/(s|sh|ch|x|z)$/i.test(word)) return `${word}es`;
	return `${word}s`;
}

/** v_transport_leg -> TransportLeg: the view prefix is plumbing, not a name. */
export function objectTypeNameFor(sourceTable: string): string {
	const trimmed = sourceTable.replace(/^(v|vw|view|tbl|t)_/i, "");
	const parts = words(trimmed);
	if (parts.length === 0) return "Dataset";
	parts[parts.length - 1] = singular(parts[parts.length - 1]!);
	return pascalCase(parts.join("_"));
}

// ── datasets ────────────────────────────────────────────────────────────────

export interface DatasetSummary {
	resourceId: number;
	name: string;
	relation: string;
	connection: string | null;
	source: string | null;
	syncId: number | null;
	rowCount: number | null;
	columnCount: number | null;
	lastSyncedAt: string | null;
	objectTypes: string[];
}

type DatasetRow = {
	resource_id: number;
	name: string;
	target_ref: string;
	properties: Record<string, unknown>;
};

function toSummary(row: DatasetRow): DatasetSummary {
	const properties = row.properties ?? {};
	const relation = String(properties.sourceView ?? row.target_ref);
	const registry = getRegistry();
	return {
		resourceId: Number(row.resource_id),
		name: row.name,
		relation,
		connection: (properties.connectionName as string | undefined) ?? null,
		source: (properties.source as string | undefined) ?? null,
		syncId: properties.syncId === undefined ? null : Number(properties.syncId),
		rowCount: properties.rowCount === undefined ? null : Number(properties.rowCount),
		columnCount: properties.columnCount === undefined ? null : Number(properties.columnCount),
		lastSyncedAt: (properties.lastSyncedAt as string | undefined) ?? null,
		objectTypes: registry.objectTypes
			.filter((type) => type.sourceView === relation)
			.map((type) => type.apiName),
	};
}

/** Every dataset a sync has landed in this space. */
export async function listDatasets(): Promise<DatasetSummary[]> {
	const rows = await query<DatasetRow>(
		`SELECT r.resource_id, r.name, r.target_ref, r.properties
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND r.kind = 'dataset'
		  ORDER BY r.name`,
		[currentSpace()],
	);
	return rows.map(toSummary);
}

/**
 * A dataset, by resource id, by its relation (connection_raw.x), by its table
 * name or by its card's name - whichever the caller has. Only one in this
 * space, and only one whose table really exists.
 */
export async function resolveDataset(ref: string | number): Promise<DatasetSummary> {
	const text = String(ref ?? "").trim();
	if (!text) throw new BadRequest("Name a dataset: its id, its table, or connection_raw.<table>.");
	const datasets = await listDatasets();
	const lowered = text.toLowerCase();
	const found =
		datasets.find((dataset) => String(dataset.resourceId) === text) ??
		datasets.find((dataset) => dataset.relation.toLowerCase() === lowered) ??
		datasets.find((dataset) => dataset.relation.split(".").pop()!.toLowerCase() === lowered) ??
		datasets.find((dataset) => dataset.name.toLowerCase() === lowered) ??
		datasets.find((dataset) => (dataset.source ?? "").toLowerCase().endsWith(`.${lowered}`));
	if (!found) {
		throw new NotFound(
			`No dataset '${text}' in the '${currentSpace()}' space. ` +
				(datasets.length
					? `Datasets: ${datasets.map((dataset) => dataset.relation).join(", ")}.`
					: "Nothing has been synced yet: add a sync on a connection first."),
		);
	}

	const [schema, table] = found.relation.split(".");
	if (schema !== DATASET_SCHEMA || !table) {
		throw new BadRequest(`${found.relation} is not a synced dataset.`);
	}
	const exists = await queryOne(
		`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = $1 AND c.relname = $2`,
		[schema, table],
	);
	if (!exists) {
		throw new BadRequest(`${found.relation} has not been landed yet. Run its sync first.`);
	}
	return found;
}

// ── profiling ───────────────────────────────────────────────────────────────

export interface ColumnProfile {
	column: string;
	sqlType: string;
	nulls: number;
	distinct: number;
	/** Null in every row: the source does not carry it. */
	empty: boolean;
	samples: string[];
	suggested: {
		apiName: string;
		label: string;
		datatype: string;
		semanticRole: string;
		defaultAggregation: string | null;
	};
}

export interface DatasetProfile {
	dataset: DatasetSummary;
	rowCount: number;
	sampled: boolean;
	columns: ColumnProfile[];
	primaryKeyCandidates: string[];
	suggestion: {
		apiName: string;
		label: string;
		pluralLabel: string;
		primaryKey: string | null;
		titleColumn: string | null;
	};
	existingObjectTypes: string[];
}

/** Rows profiled in full; larger datasets are profiled on this many rows. */
const PROFILE_ROWS = 200_000;

const NUMERIC_TYPES = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision"]);

/** The role a column most plausibly plays, from its type, name and values. */
export function suggestRole(
	column: string,
	sqlType: string,
	stats: { rowCount: number; distinct: number; nulls: number },
	isPrimaryKey: boolean,
	isTitle: boolean,
): { semanticRole: string; defaultAggregation: string | null } {
	const name = column.toLowerCase();
	if (isPrimaryKey) return { semanticRole: "identity", defaultAggregation: null };
	if (isTitle) return { semanticRole: "title", defaultAggregation: null };
	if (sqlType === "boolean") return { semanticRole: "flag", defaultAggregation: null };
	if (sqlType === "date" || sqlType.startsWith("timestamp")) {
		return { semanticRole: "temporal", defaultAggregation: null };
	}
	if (/(^|_)(lat|latitude|lon|lng|longitude)$/.test(name)) {
		return { semanticRole: "geo", defaultAggregation: null };
	}
	if (/(^|_)(ingested|loaded|synced|source|captured)(_|$)|(^|_)data_origin$/.test(name)) {
		return { semanticRole: "provenance", defaultAggregation: null };
	}
	// A reference to another object, whatever its type: what links are drawn
	// from, and something to group by, never to add up.
	if (/(_key|_id|_uuid)$/.test(name)) {
		return { semanticRole: "dimension", defaultAggregation: null };
	}
	if (NUMERIC_TYPES.has(sqlType)) {
		// A number is only a measure when adding it up means something. Codes,
		// years and status numbers are numbers that identify rather than measure.
		if (/(_code|_no|_number|^id|_status|_type|_year|_month|_day|_seq|_sequence)$/.test(name)) {
			return { semanticRole: "dimension", defaultAggregation: null };
		}
		// The name says how it combines: a maximum of maxima, an average of
		// rates - and a per-row duration is averaged, since summing every
		// order's transit time answers no question.
		const named = /^(max|min|avg)_/.exec(name);
		if (named) return { semanticRole: "measure", defaultAggregation: named[1]! };
		if (/(pct|percent|ratio|rate|avg|average|mean)|_(days|hours|minutes|mins|seconds|secs)$/.test(name)) {
			return { semanticRole: "measure", defaultAggregation: "avg" };
		}
		return { semanticRole: "measure", defaultAggregation: "sum" };
	}
	if (stats.rowCount > 0 && stats.distinct <= Math.max(50, stats.rowCount * 0.5)) {
		return { semanticRole: "dimension", defaultAggregation: null };
	}
	return { semanticRole: "attribute", defaultAggregation: null };
}

/**
 * The dataset's columns with their real distinct and null counts, a few real
 * values each, which columns could be a primary key, and a suggested object
 * type. Nothing is written.
 */
export async function profileDataset(ref: string | number): Promise<DatasetProfile> {
	const dataset = await resolveDataset(ref);
	const [schema, table] = dataset.relation.split(".") as [string, string];

	const columns = await query<{ column_name: string; data_type: string; udt_name: string }>(
		`SELECT column_name, data_type, udt_name FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		[schema, table],
	);
	if (columns.length === 0) throw new BadRequest(`${dataset.relation} has no columns.`);

	const relation = quoteQualified(dataset.relation);
	const [{ n }] = (await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${relation}`)) as [{ n: string }];
	const rowCount = Number(n);
	const sampled = rowCount > PROFILE_ROWS;
	const from = sampled ? `(SELECT * FROM ${relation} LIMIT ${PROFILE_ROWS}) AS d` : `${relation} AS d`;

	// One pass for every column's counts. Identifiers came from the catalogue.
	const countSql = columns
		.map((column, index) => {
			const quoted = `d.${quoteIdentifier(column.column_name)}`;
			// json has no equality operator; its text form stands in for distinctness.
			const comparable = column.udt_name === "json" ? `${quoted}::text` : quoted;
			return `count(DISTINCT ${comparable})::text AS d${index}, (count(*) - count(${quoted}))::text AS n${index}`;
		})
		.join(", ");
	const counts = (await queryOne<Record<string, string>>(`SELECT ${countSql} FROM ${from}`)) ?? {};
	const profiled = sampled ? PROFILE_ROWS : rowCount;

	const sampleRows = await query<Record<string, unknown>>(`SELECT * FROM ${relation} LIMIT 25`);

	const stats = columns.map((column, index) => ({
		column: column.column_name,
		sqlType: column.data_type === "ARRAY" ? `${column.udt_name.replace(/^_/, "")}[]` : column.data_type,
		distinct: Number(counts[`d${index}`] ?? 0),
		nulls: Number(counts[`n${index}`] ?? 0),
	}));

	const primaryKeyCandidates = stats
		.filter((stat) => profiled > 0 && stat.nulls === 0 && stat.distinct === profiled)
		.filter((stat) => !["boolean", "json", "jsonb"].includes(stat.sqlType))
		.map((stat) => stat.column)
		// A column named like a key beats one that merely happens to be unique.
		.sort((a, b) => keyScore(b, table) - keyScore(a, table));
	const primaryKey = primaryKeyCandidates[0] ?? null;

	const titleColumn =
		stats
			.filter((stat) => stat.column !== primaryKey && stat.sqlType === "text" && stat.nulls < profiled)
			.sort((a, b) => titleScore(b.column, b.distinct, profiled) - titleScore(a.column, a.distinct, profiled))[0]
			?.column ?? null;

	const typeName = objectTypeNameFor(dataset.source?.split(".").pop() ?? table);

	return {
		dataset,
		rowCount,
		sampled,
		columns: stats.map((stat) => {
			const role = suggestRole(
				stat.column,
				stat.sqlType,
				{ rowCount: profiled, distinct: stat.distinct, nulls: stat.nulls },
				stat.column === primaryKey,
				stat.column === titleColumn,
			);
			return {
				...stat,
				empty: profiled > 0 && stat.nulls === profiled,
				samples: [
					...new Set(
						sampleRows
							.map((row) => row[stat.column])
							.filter((value) => value !== null && value !== undefined)
							.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 60)),
					),
				].slice(0, 3),
				suggested: {
					apiName: camelCase(stat.column),
					label: humanize(stat.column),
					datatype: datatypeFor(stat.sqlType),
					...role,
				},
			};
		}),
		primaryKeyCandidates,
		suggestion: {
			apiName: typeName,
			label: humanize(typeName),
			pluralLabel: plural(humanize(typeName)),
			primaryKey,
			titleColumn,
		},
		existingObjectTypes: dataset.objectTypes,
	};
}

function keyScore(column: string, table: string): number {
	const name = column.toLowerCase();
	const base = table.split("__").pop()!.replace(/^v_/, "").toLowerCase();
	if (name === `${base}_key` || name === `${singular(base)}_key` || name === `${singular(base)}_id`) return 4;
	if (name === "id" || name === "key") return 3;
	if (/_(key|id|uuid)$/.test(name)) return 2;
	return 0;
}

function titleScore(column: string, distinct: number, rows: number): number {
	const name = column.toLowerCase();
	const named = /(^|_)(name|title|label|number|code|description)$/.test(name) ? 2 : 0;
	return named + (rows > 0 ? distinct / rows : 0);
}

// ── object types ────────────────────────────────────────────────────────────

export interface PropertySpec {
	column: string;
	apiName?: string;
	label?: string;
	description?: string;
	semanticRole?: string;
	defaultAggregation?: string | null;
	unit?: string | null;
}

export interface CreateObjectTypeRequest {
	dataset: string | number;
	apiName?: string;
	label?: string;
	pluralLabel?: string;
	description?: string;
	primaryKey?: string;
	titleColumn?: string;
	group?: string;
	icon?: string;
	color?: string;
	kind?: string;
	/** Omitted: every column, with its suggested role. */
	properties?: PropertySpec[];
	/** Columns to leave out when `properties` is omitted. */
	excludeColumns?: string[];
}

/** Colours a new type is given in turn, so a fresh graph is not all one hue. */
const PALETTE = ["#E8A33D", "#3E9A6D", "#4C7BD9", "#C0504D", "#8E6BBF", "#2BA3A3", "#D9774C", "#6B8E23"];

/**
 * Create an object type from a dataset: a property per column, typed from the
 * dataset's own catalogue.
 *
 * Refused, with the numbers, when the primary key is not unique and non-null
 * in the data as it stands - the one property every link, action and object
 * page depends on.
 */
export async function createObjectType(
	request: CreateObjectTypeRequest,
	createdBy: string,
): Promise<Record<string, unknown>> {
	const profile = await profileDataset(request.dataset);
	const { dataset } = profile;
	const { id: versionId } = await activeVersion();
	const registry = getRegistry();

	const apiName = String(request.apiName ?? profile.suggestion.apiName).trim();
	if (!/^[A-Z][A-Za-z0-9]*$/.test(apiName)) {
		throw new BadRequest(`An object type's api name must be PascalCase, e.g. ${profile.suggestion.apiName}.`);
	}
	if ([...registry.objectTypeByApiName.keys()].some((name) => name.toLowerCase() === apiName.toLowerCase())) {
		throw new BadRequest(`An object type called '${apiName}' already exists.`);
	}

	const byColumn = new Map(profile.columns.map((column) => [column.column, column]));
	const need = (column: string | undefined | null, what: string): ColumnProfile => {
		const found = column ? byColumn.get(column) : undefined;
		if (!found) {
			throw new BadRequest(
				`'${column}' is not a column of ${dataset.relation}, so it cannot be the ${what}. ` +
					`Columns: ${profile.columns.map((c) => c.column).join(", ")}.`,
			);
		}
		return found;
	};

	const primaryKey = need(request.primaryKey ?? profile.suggestion.primaryKey, "primary key");
	if (primaryKey.nulls > 0 || primaryKey.distinct !== (profile.sampled ? Math.min(profile.rowCount, PROFILE_ROWS) : profile.rowCount)) {
		throw new BadRequest(
			`${primaryKey.column} cannot be the primary key: across ${profile.rowCount} rows it has ` +
				`${primaryKey.distinct} distinct values and ${primaryKey.nulls} nulls. A key must be unique ` +
				"and never empty." +
				(profile.primaryKeyCandidates.length
					? ` Columns that are: ${profile.primaryKeyCandidates.join(", ")}.`
					: " No single column is; sync a view that has one."),
		);
	}
	const titleColumn = request.titleColumn
		? need(request.titleColumn, "title").column
		: (profile.suggestion.titleColumn ?? primaryKey.column);

	const excluded = new Set((request.excludeColumns ?? []).map(String));
	const specs: PropertySpec[] = request.properties?.length
		? request.properties
		: profile.columns.filter((column) => !excluded.has(column.column)).map((column) => ({ column: column.column }));
	if (!specs.some((spec) => spec.column === primaryKey.column)) {
		specs.unshift({ column: primaryKey.column });
	}

	const typeRid = `${NAMESPACE}:${apiName}`;
	const seen = new Set<string>();
	const properties = specs.map((spec, index) => {
		const column = need(spec.column, "property");
		const property = {
			column: column.column,
			apiName: String(spec.apiName ?? column.suggested.apiName).trim(),
			label: String(spec.label ?? column.suggested.label).trim(),
			description: spec.description ?? null,
			datatype: column.suggested.datatype,
			sqlType: column.sqlType,
			isIdentity: column.column === primaryKey.column,
			isTitle: column.column === titleColumn,
			isNullable: column.nulls > 0,
			semanticRole:
				column.column === primaryKey.column
					? "identity"
					: String(spec.semanticRole ?? (column.column === titleColumn ? "title" : column.suggested.semanticRole)),
			defaultAggregation:
				spec.defaultAggregation === undefined ? column.suggested.defaultAggregation : spec.defaultAggregation,
			unit: spec.unit ?? null,
			displayOrder: index * 10,
		};
		if (!/^[a-z][A-Za-z0-9]*$/.test(property.apiName)) {
			throw new BadRequest(`Property name '${property.apiName}' must be camelCase.`);
		}
		if (seen.has(property.apiName)) throw new BadRequest(`Two properties are both called '${property.apiName}'.`);
		seen.add(property.apiName);
		if (!ENUMS.semantic_role!.includes(property.semanticRole)) {
			throw new BadRequest(`'${property.semanticRole}' is not a semantic role. Use one of: ${ENUMS.semantic_role!.join(", ")}.`);
		}
		if (property.semanticRole === "measure" && !NUMERIC_TYPES.has(column.sqlType)) {
			throw new BadRequest(`${column.column} is ${column.sqlType}, so it cannot be a measure: only numbers add up.`);
		}
		if (property.defaultAggregation && !ENUMS.default_aggregation!.includes(property.defaultAggregation)) {
			throw new BadRequest(`'${property.defaultAggregation}' is not an aggregation. Use one of: ${ENUMS.default_aggregation!.join(", ")}.`);
		}
		return property;
	});

	const kind = String(request.kind ?? "entity");
	if (!ENUMS.kind!.includes(kind)) throw new BadRequest(`'${kind}' is not a kind. Use one of: ${ENUMS.kind!.join(", ")}.`);

	const label = request.label?.trim() || humanize(apiName);
	await query(
		`INSERT INTO platform.object_type
		   (object_type_rid, ontology_version_id, api_name, label, plural_label, description, kind,
		    source_view, primary_key_column, title_column, icon, color, group_name, row_count,
		    display_order, is_user_defined)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true)`,
		[
			typeRid,
			versionId,
			apiName,
			label,
			request.pluralLabel?.trim() || plural(label),
			request.description ?? `Created from ${dataset.source ?? dataset.relation}.`,
			kind,
			dataset.relation,
			primaryKey.column,
			titleColumn,
			request.icon ?? null,
			request.color ?? PALETTE[registry.objectTypes.length % PALETTE.length],
			request.group ?? dataset.connection ?? null,
			profile.rowCount,
			(registry.objectTypes.length + 1) * 10,
		],
	);

	for (const property of properties) {
		await query(
			`INSERT INTO platform.object_property
			   (object_property_rid, object_type_rid, ontology_version_id, api_name, label, description,
			    datatype, sql_column, sql_type, is_identity, is_title, is_nullable, is_foreign_key,
			    semantic_role, default_aggregation, unit, display_order)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13,$14,$15,$16)`,
			[
				`${typeRid}.${property.apiName}`,
				typeRid,
				versionId,
				property.apiName,
				property.label,
				property.description,
				property.datatype,
				property.column,
				property.sqlType,
				property.isIdentity,
				property.isTitle,
				property.isNullable,
				property.semanticRole,
				property.defaultAggregation,
				property.unit,
				property.displayOrder,
			],
		);
	}

	await journal(
		"objectType",
		typeRid,
		"create",
		{
			apiName,
			dataset: dataset.relation,
			primaryKey: primaryKey.column,
			titleColumn,
			properties: properties.map((p) => ({ column: p.column, apiName: p.apiName, semanticRole: p.semanticRole })),
		},
		{},
		createdBy,
	);

	await publishChange();
	const type = resolveObjectType(apiName);
	return {
		created: true,
		apiName: type.apiName,
		rid: type.rid,
		label: type.label,
		dataset: dataset.relation,
		objects: type.rowCount,
		primaryKey: primaryKey.column,
		titleColumn,
		properties: type.properties.map((p) => ({
			apiName: p.apiName,
			column: p.sqlColumn,
			type: p.datatype,
			role: p.semanticRole,
		})),
	};
}

// ── links ───────────────────────────────────────────────────────────────────

export interface LinkSuggestion {
	sourceObjectType: string;
	sourceProperty: string;
	targetObjectType: string;
	targetProperty: string;
	suggestedApiName: string;
	cardinality: "MANY_TO_ONE" | "ONE_TO_ONE";
	matched: number;
	candidates: number;
	matchRatio: number;
	reason: string;
}

/** Whether a column names another type's key: account_key -> Account.account_key. */
function refersTo(column: string, targetKey: string): boolean {
	const name = column.toLowerCase();
	const key = targetKey.toLowerCase();
	return name === key || name.endsWith(`_${key}`);
}

/**
 * Links the data supports but the ontology does not have yet.
 *
 * A column in one type that is named like another type's primary key is a
 * candidate; each candidate is then measured, and only those whose values
 * really appear on the other side are offered, with the ratio. Nothing is
 * created: this is what an editor or the assistant chooses from.
 */
export async function suggestLinks(objectType?: string): Promise<LinkSuggestion[]> {
	const registry = getRegistry();
	const types = objectType ? [resolveObjectType(objectType)] : registry.objectTypes;
	const existing = new Set(
		registry.linkTypes.map((link) => `${link.sourceObjectType}.${link.sourceColumn}->${link.targetObjectType}`),
	);

	const suggestions: LinkSuggestion[] = [];
	for (const source of types) {
		for (const property of source.properties) {
			if (property.isIdentity) continue;
			for (const target of registry.objectTypes) {
				if (target.rid === source.rid) continue;
				if (!refersTo(property.sqlColumn, target.primaryKeyColumn)) continue;
				if (existing.has(`${source.rid}.${property.sqlColumn}->${target.rid}`)) continue;

				const measured = await measureJoin(source, property.sqlColumn, target, target.primaryKeyColumn);
				if (measured.matched === 0) continue;
				const unique = await isUnique(source, property);
				const role = property.sqlColumn.toLowerCase().replace(new RegExp(`_?${target.primaryKeyColumn.toLowerCase()}$`), "");
				suggestions.push({
					sourceObjectType: source.apiName,
					sourceProperty: property.apiName,
					targetObjectType: target.apiName,
					targetProperty: target.propertyBySqlColumn.get(target.primaryKeyColumn)?.apiName ?? target.primaryKeyColumn,
					suggestedApiName: camelCase(`${source.apiName}_${role ? `${role}_` : ""}${target.apiName}`),
					cardinality: unique ? "ONE_TO_ONE" : "MANY_TO_ONE",
					...measured,
					reason: `${source.apiName}.${property.sqlColumn} is named for ${target.apiName}'s key ${target.primaryKeyColumn}.`,
				});
			}
		}
	}
	return suggestions.sort((a, b) => b.matchRatio - a.matchRatio);
}

async function isUnique(type: ObjectTypeMeta, property: PropertyMeta): Promise<boolean> {
	const row = await queryOne<{ dup: boolean }>(
		`SELECT count(${quoteIdentifier(property.sqlColumn)}) <> count(DISTINCT ${quoteIdentifier(property.sqlColumn)}) AS dup
		   FROM ${quoteQualified(type.sourceView)}`,
	);
	return row ? !row.dup : false;
}

// ── actions ─────────────────────────────────────────────────────────────────

export interface ActionParameterSpec {
	name: string;
	type?: string;
	label?: string;
	description?: string;
	required?: boolean;
	enum?: Array<string | number>;
	defaultValue?: unknown;
}

export interface CreateActionRequest {
	apiName: string;
	label?: string;
	description?: string;
	objectType: string;
	parameters?: ActionParameterSpec[];
	allowedRoles?: string[];
	requiresApproval?: boolean;
	approverRoles?: string[];
	tags?: string[];
}

const PARAMETER_TYPES = ["string", "integer", "float", "decimal", "boolean", "date", "datetime"];

function resolveRole(role: string): string {
	const text = String(role).trim();
	const found = ROLE_IDS.find(
		(id) => id.toLowerCase() === text.toLowerCase() || id.split(":")[1]!.toLowerCase() === text.toLowerCase(),
	);
	if (!found) throw new BadRequest(`'${role}' is not a role. Roles: ${ROLE_IDS.join(", ")}.`);
	return found;
}

/**
 * Declare an action on an object type.
 *
 * It always takes the target object's key as its first parameter, which is
 * how a run names the object it acts on. Running it validates the parameters,
 * checks the runner's role and records the exact request in the audit trail -
 * and stages it: a dataset is a copy of the source, and this platform has no
 * write-back to it, so claiming the change was made would be false.
 */
export async function createActionType(
	request: CreateActionRequest,
	createdBy: string,
): Promise<Record<string, unknown>> {
	const { id: versionId } = await activeVersion();
	const registry = getRegistry();

	const apiName = String(request.apiName ?? "").trim();
	if (!/^[A-Z][A-Za-z0-9]*$/.test(apiName)) {
		throw new BadRequest("An action's api name must be PascalCase and start with a verb, e.g. HoldShipment.");
	}
	if (registry.actionTypes.some((action) => action.apiName.toLowerCase() === apiName.toLowerCase())) {
		throw new BadRequest(`An action called '${apiName}' already exists.`);
	}
	const target = resolveObjectType(String(request.objectType ?? ""));
	const keyName = `${camelCase(target.apiName)}Key`;

	const parameters = [
		{
			name: keyName,
			label: { en: target.label },
			type: "string",
			required: true,
			description: { en: `The ${target.label} this acts on (its ${target.primaryKeyColumn}).` },
		},
		...(request.parameters ?? []).map((spec) => {
			const name = String(spec.name ?? "").trim();
			if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new BadRequest(`Parameter '${name}' must be camelCase.`);
			if (name === keyName) throw new BadRequest(`'${keyName}' is added for you; do not declare it.`);
			const type = String(spec.type ?? "string");
			if (!PARAMETER_TYPES.includes(type)) {
				throw new BadRequest(`'${type}' is not a parameter type. Use one of: ${PARAMETER_TYPES.join(", ")}.`);
			}
			return {
				name,
				label: { en: spec.label?.trim() || humanize(name) },
				type,
				required: Boolean(spec.required),
				...(spec.description ? { description: { en: spec.description } } : {}),
				...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
				...(spec.enum?.length ? { validation: [{ type: "custom", value: { enum: spec.enum } }] } : {}),
			};
		}),
	];
	const names = parameters.map((parameter) => parameter.name);
	if (new Set(names).size !== names.length) throw new BadRequest("Two parameters share a name.");

	const allowedRoles = [...new Set([`${NAMESPACE}:AdminRole`, ...(request.allowedRoles ?? [`${NAMESPACE}:OperationsManagerRole`]).map(resolveRole)])];
	const approverRoles = (request.approverRoles ?? []).map(resolveRole);
	const rid = `${NAMESPACE}:${apiName}`;

	await query(
		`INSERT INTO platform.action_type
		   (action_type_rid, ontology_version_id, api_name, label, description, target_object_types,
		    parameters, requires_approval, approver_roles, allowed_roles, audit_level, is_read_only,
		    tags, is_user_defined)
		 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'full',false,$11,true)`,
		[
			rid,
			versionId,
			apiName,
			request.label?.trim() || humanize(apiName),
			request.description ?? null,
			[target.rid],
			JSON.stringify(parameters),
			Boolean(request.requiresApproval),
			approverRoles,
			allowedRoles,
			request.tags ?? [],
		],
	);

	await journal("actionType", rid, "create", { ...request, allowedRoles }, {}, createdBy);
	await publishChange();

	const created = getRegistry().actionTypeByApiName.get(apiName);
	return {
		created: true,
		apiName,
		rid,
		objectType: target.apiName,
		parameters: created?.parameters ?? parameters,
		allowedRoles,
		requiresApproval: Boolean(request.requiresApproval),
		note: "Running it validates, checks the role and records the request; it is staged, not written back.",
	};
}

// ── metrics ─────────────────────────────────────────────────────────────────

export interface CreateMetricRequest {
	apiName: string;
	label?: string;
	description?: string;
	businessQuestion?: string;
	category?: string;
	objectType: string;
	aggregation: string;
	measure?: string;
	numerator?: string;
	denominator?: string;
	dimensions?: string[];
	defaultDimension?: string;
	timeProperty?: string;
	/** Always applied: {"isUnplanned": true} counts only unplanned orders. */
	where?: Record<string, unknown>;
	unit?: string;
	valueFormat?: string;
	higherIsBetter?: boolean;
	target?: number;
}

const AGGREGATIONS = ["count", "count_distinct", "sum", "avg", "min", "max", "ratio"];
const VALUE_FORMATS = ["number", "integer", "currency", "percent", "duration_hours", "duration_days", "weight_kg", "distance_km"];

/**
 * Define a metric over an object type, then compute it once before keeping it.
 *
 * Measures must be numeric properties and dimensions must be properties of the
 * same type, both resolved through the registry; a ratio is sum over sum, never
 * an average of per-row ratios. The trial run is the last check: a metric that
 * does not compute is refused with the database's message rather than stored
 * to fail on a dashboard.
 */
export async function createMetric(
	request: CreateMetricRequest,
	createdBy: string,
): Promise<Record<string, unknown>> {
	const registry = getRegistry();
	const apiName = String(request.apiName ?? "").trim();
	if (!/^[a-z][a-z0-9_]*$/.test(apiName)) {
		throw new BadRequest("A metric's api name is snake_case, e.g. total_gross_weight_kg.");
	}
	if (registry.kpiByApiName.has(apiName)) throw new BadRequest(`A metric called '${apiName}' already exists.`);

	const type = resolveObjectType(String(request.objectType ?? ""));
	const property = (ref: string | undefined, what: string): PropertyMeta => {
		const found = ref ? (type.propertyByApiName.get(ref) ?? type.propertyBySqlColumn.get(ref)) : undefined;
		if (!found) {
			throw new BadRequest(
				`'${ref}' is not a property of ${type.apiName}, so it cannot be the ${what}. ` +
					`Properties: ${type.properties.map((p) => p.apiName).join(", ")}.`,
			);
		}
		return found;
	};
	const numeric = (p: PropertyMeta, what: string) => {
		if (!["integer", "decimal", "float"].includes(p.datatype)) {
			throw new BadRequest(`${p.apiName} is ${p.datatype}, so it cannot be the ${what}: only numbers aggregate.`);
		}
		return p;
	};

	const aggregation = String(request.aggregation ?? "").toLowerCase();
	if (!AGGREGATIONS.includes(aggregation)) {
		throw new BadRequest(`'${request.aggregation}' is not an aggregation. Use one of: ${AGGREGATIONS.join(", ")}.`);
	}

	let measure: PropertyMeta | null = null;
	let numerator: PropertyMeta | null = null;
	let denominator: PropertyMeta | null = null;
	if (aggregation === "ratio") {
		numerator = numeric(property(request.numerator, "numerator"), "numerator");
		denominator = numeric(property(request.denominator, "denominator"), "denominator");
	} else if (aggregation === "count_distinct") {
		measure = property(request.measure, "measure");
	} else if (aggregation !== "count") {
		measure = numeric(property(request.measure, "measure"), "measure");
	}

	const dimensions = [...new Set((request.dimensions ?? []).map((ref) => property(ref, "dimension").sqlColumn))];
	const defaultDimension = request.defaultDimension ? property(request.defaultDimension, "default dimension").sqlColumn : null;
	if (defaultDimension && !dimensions.includes(defaultDimension)) dimensions.unshift(defaultDimension);
	const timeColumn = request.timeProperty ? property(request.timeProperty, "time property").sqlColumn : null;
	if (timeColumn && !dimensions.includes(timeColumn)) dimensions.push(timeColumn);

	const conditions: Record<string, unknown> = {};
	for (const [ref, value] of Object.entries(request.where ?? {})) {
		const scalar = (item: unknown) => item === null || ["string", "number", "boolean"].includes(typeof item);
		if (Array.isArray(value) ? value.length === 0 || !value.every(scalar) : !scalar(value) || value === null) {
			throw new BadRequest(`The condition on '${ref}' must be a value or a list of values.`);
		}
		conditions[property(ref, "condition").sqlColumn] = value;
	}

	const valueFormat = String(request.valueFormat ?? (aggregation === "count" || aggregation === "count_distinct" ? "integer" : "number"));
	if (!VALUE_FORMATS.includes(valueFormat)) {
		throw new BadRequest(`'${valueFormat}' is not a value format. Use one of: ${VALUE_FORMATS.join(", ")}.`);
	}
	const category = String(request.category ?? "operations").toLowerCase().replace(/[^a-z_]/g, "_") || "operations";

	const spaceRow = await queryOne<{ space_id: number }>("SELECT space_id FROM platform.space WHERE slug = $1", [currentSpace()]);
	const rid = `kpi:${apiName}`;
	await query(
		`INSERT INTO platform.kpi_definition
		   (space_id, kpi_rid, api_name, label, description, business_question, category, source_view,
		    measure_column, aggregation, numerator_column, denominator_column, dimensions,
		    default_dimension, time_column, unit, value_format, higher_is_better, target_value,
		    related_object_types, depends_on_simulation, display_order, conditions, object_type_rid)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,false,$21,$22::jsonb,$23)`,
		[
			spaceRow!.space_id,
			rid,
			apiName,
			request.label?.trim() || humanize(apiName),
			request.description ?? null,
			request.businessQuestion ?? null,
			category,
			type.sourceView,
			measure?.sqlColumn ?? null,
			aggregation,
			numerator?.sqlColumn ?? null,
			denominator?.sqlColumn ?? null,
			dimensions,
			defaultDimension,
			timeColumn,
			request.unit ?? null,
			valueFormat,
			request.higherIsBetter ?? null,
			request.target ?? null,
			[type.rid],
			(registry.kpis.length + 1) * 10,
			JSON.stringify(conditions),
			// What the metric measures: the board planner and the feasibility
			// check find a type's metrics by it.
			type.rid,
		],
	);

	await publishChange();

	// The trial run. Removed again if it does not compute.
	try {
		const trial = await executeKpi(apiName, { totalOnly: true });
		await journal("metric", rid, "create", { ...request }, {}, createdBy);
		return {
			created: true,
			apiName,
			label: trial.label,
			objectType: type.apiName,
			aggregation,
			dimensions,
			conditions,
			value: trial.total,
			unit: request.unit ?? null,
		};
	} catch (error) {
		await query("DELETE FROM platform.kpi_definition WHERE space_id = $1 AND kpi_rid = $2", [spaceRow!.space_id, rid]);
		await publishChange();
		throw new BadRequest(`The metric does not compute, so it was not kept: ${(error as Error).message}`);
	}
}
