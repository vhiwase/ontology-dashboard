import { AsyncLocalStorage } from "node:async_hooks";
import type { OntologyDefinition } from "@ontograph/core";
import { query, queryOne } from "./db";

/**
 * The in-memory view of each space's ontology.
 *
 * Loaded at boot and reloaded after every authoring change (definition.ts). Everything that builds SQL goes
 * through this registry, and only through it: a column name reaches a query only
 * after being matched against a property this registry knows about. That is the
 * single defence against injection in the whole service, so it is deliberately
 * the only path.
 */

export interface PropertyMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	datatype: string;
	sqlColumn: string;
	sqlType: string | null;
	isIdentity: boolean;
	isTitle: boolean;
	isNullable: boolean;
	isForeignKey: boolean;
	semanticRole: string;
	defaultAggregation: string | null;
	unit: string | null;
	displayOrder: number;
}

export interface ObjectTypeMeta {
	rid: string;
	apiName: string;
	label: string;
	pluralLabel: string | null;
	description: string | null;
	kind: string;
	sourceView: string;
	primaryKeyColumn: string;
	titleColumn: string | null;
	icon: string | null;
	color: string | null;
	group: string | null;
	rowCount: number;
	displayOrder: number;
	properties: PropertyMeta[];
	propertyByApiName: Map<string, PropertyMeta>;
	propertyBySqlColumn: Map<string, PropertyMeta>;
}

export interface LinkTypeMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	sourceObjectType: string;
	targetObjectType: string;
	sourceColumn: string;
	targetColumn: string;
	cardinality: string;
	inverseApiName: string | null;
	inverseLabel: string | null;
	discoveryMethod: string;
	matchRatio: number;
	matchedRows: number;
	candidateRows: number;
	isVerified: boolean;
}

export interface ActionTypeMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	targetObjectTypes: string[];
	parameters: Array<Record<string, unknown>>;
	requiresApproval: boolean;
	approverRoles: string[];
	allowedRoles: string[];
	auditLevel: string;
	isReadOnly: boolean;
	tags: string[];
}

export interface KpiMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	businessQuestion: string | null;
	category: string;
	sourceView: string;
	measureColumn: string | null;
	aggregation: string;
	numeratorColumn: string | null;
	denominatorColumn: string | null;
	dimensions: string[];
	defaultDimension: string | null;
	timeColumn: string | null;
	unit: string | null;
	valueFormat: string;
	higherIsBetter: boolean | null;
	targetValue: number | null;
	warningThreshold: number | null;
	criticalThreshold: number | null;
	relatedObjectTypes: string[];
	dependsOnSimulation: boolean;
	coverageNote: string | null;
	/** Equality conditions always applied: {sql_column: value | values}. */
	conditions?: Record<string, unknown>;
	displayOrder: number;
}

export interface Registry {
	ontologyVersionId: number;
	version: string;
	ontologyId: string;
	label: string | null;
	description: string | null;
	createdAt: string;
	definition: OntologyDefinition;
	validation: Record<string, unknown>;
	objectTypes: ObjectTypeMeta[];
	objectTypeByApiName: Map<string, ObjectTypeMeta>;
	objectTypeByRid: Map<string, ObjectTypeMeta>;
	linkTypes: LinkTypeMeta[];
	linkTypeByApiName: Map<string, LinkTypeMeta>;
	linksBySourceRid: Map<string, LinkTypeMeta[]>;
	linksByTargetRid: Map<string, LinkTypeMeta[]>;
	actionTypes: ActionTypeMeta[];
	actionTypeByApiName: Map<string, ActionTypeMeta>;
	kpis: KpiMeta[];
	kpiByApiName: Map<string, KpiMeta>;
	loadedAt: string;
}

/**
 * Raised when a space has no ontology loaded.
 *
 * Every space is given an (initially empty) ontology at boot, so this means a
 * space created since - a normal state, not a server fault. It carries a 409
 * so routes render an empty state rather than a 500.
 */
export class NoOntologyInSpace extends Error {
	readonly status = 409;

	constructor(readonly spaceSlug: string) {
		super(
			`The '${spaceSlug}' space has no ontology loaded yet. ` +
				"Create an object type from one of its datasets to start one.",
		);
	}
}

/**
 * The space whose ontology the current request should see.
 *
 * AsyncLocalStorage rather than a parameter on getRegistry(): the registry is
 * read from thirty-five places across the SQL builders, the action layer and
 * the documentation corpus, and threading a space through all of them would
 * be a large change whose only purpose is carrying one string. The request
 * middleware enters the context once and everything underneath reads it.
 */
const requestSpace = new AsyncLocalStorage<string>();

/** Run `fn` with `spaceSlug` as the ontology in scope. */
export function withSpace<T>(spaceSlug: string, fn: () => T): T {
	return requestSpace.run(spaceSlug, fn);
}

/** Which space the caller is in, defaulting to the sandbox. */
export function currentSpace(): string {
	return requestSpace.getStore() ?? DEFAULT_SPACE;
}

export function getRegistry(): Registry {
	const space = currentSpace();
	const found = registries.get(space);
	if (found) return found;
	if (registries.size === 0) {
		throw new Error("Registry not loaded yet. Call loadRegistry() during startup.");
	}
	throw new NoOntologyInSpace(space);
}

/** Which spaces currently have a published ontology. */
export function spacesWithOntology(): string[] {
	return [...registries.keys()].sort();
}

// ── interfaces ──────────────────────────────────────────────────────────────
// InterfaceDefinitions in the document, and the types declaring `implements`
// for them. The authored ontology declares none yet; this is the read side
// for the day it does.

export interface InterfaceMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	/** Attributes every implementor carries, resolved to property names. */
	requiredAttributes: Array<{ apiName: string; label: string; required: boolean }>;
	/** Object types declaring `implements` for this interface, by api name. */
	implementors: string[];
}

function localizedText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, string>;
		return record.en ?? Object.values(record)[0] ?? "";
	}
	return "";
}

export function interfacesOf(registry: Registry): InterfaceMeta[] {
	const interfaces = registry.definition.interfaces ?? [];
	if (!interfaces.length) return [];

	// Attributes are shared across object types (462 properties collapse to
	// 238 attribute definitions), so one property per rid is enough to resolve
	// every requiredAttributes ref to a named property.
	const propertyByRid = new Map<string, { apiName: string; label: string }>();
	for (const type of registry.objectTypes) {
		for (const prop of type.properties) {
			if (!propertyByRid.has(prop.rid)) {
				propertyByRid.set(prop.rid, { apiName: prop.apiName, label: prop.label });
			}
		}
	}

	const entityTypes = [
		...(registry.definition.entityTypes ?? []),
		...(registry.definition.eventTypes ?? []),
		...(registry.definition.roleTypes ?? []),
	];
	// Entity @ids are RIDs ("ri.object.main.location"), not api names, so the
	// implementors are translated through the registry — the same lookup the
	// link endpoints do — with the raw id as the fallback for a type the
	// registry has not shredded.
	const apiNameByRid = new Map(registry.objectTypes.map((type) => [type.rid, type.apiName]));

	return interfaces.map((iface) => {
		const refs = (iface.requiredAttributes ?? []) as Array<{
			ref?: string;
			required?: boolean;
		}>;
		return {
			rid: iface["@id"],
			apiName: iface["@id"].split(":").pop() ?? iface["@id"],
			label: localizedText(iface.label),
			description: iface.description ? localizedText(iface.description) : null,
			requiredAttributes: refs.map((ref) => {
				const prop = propertyByRid.get(ref.ref ?? "");
				return {
					apiName: prop?.apiName ?? ref.ref ?? "",
					label: prop?.label ?? "",
					required: Boolean(ref.required),
				};
			}),
			implementors: entityTypes
				.filter((entity) => (entity.implements ?? []).includes(iface["@id"]))
				.map(
					(entity) =>
						apiNameByRid.get(entity["@id"]) ??
						entity["@id"].split(":").pop() ??
						entity["@id"],
				),
		};
	});
}

export function hasOntology(spaceSlug: string): boolean {
	return registries.has(spaceSlug);
}

const DEFAULT_SPACE = "sandbox";

/** One registry per space that has a published, active ontology. */
const registries = new Map<string, Registry>();

/**
 * Load every space's active ontology.
 *
 * Each space is independent: one failing to load must not prevent the others,
 * because a half-published ontology in staging should not take the sandbox
 * down with it.
 */
export async function loadRegistry(onlySpace?: string): Promise<Registry> {
	// One space's change reloads that space; everything else is left as it is.
	if (onlySpace) {
		registries.set(onlySpace, await loadRegistryForSpace(onlySpace));
		return registries.get(onlySpace)!;
	}

	const spaces = await query<{ slug: string }>(
		`SELECT s.slug
		   FROM platform.space s
		   JOIN platform.ontology_version v ON v.space_id = s.space_id AND v.is_active
		  ORDER BY s.slug`,
	);

	registries.clear();
	for (const { slug } of spaces) {
		try {
			registries.set(slug, await loadRegistryForSpace(slug));
		} catch (error) {
			console.error(
				JSON.stringify({
					level: "error",
					message: "Could not load the ontology for a space",
					space: slug,
					error: (error as Error).message,
				}),
			);
		}
	}

	const first = registries.get(DEFAULT_SPACE) ?? [...registries.values()][0];
	if (!first) {
		throw new Error("No active ontology in any space; ensureOntologies() runs before this at boot.");
	}
	return first;
}

async function loadRegistryForSpace(spaceSlug: string): Promise<Registry> {
	const versionRow = await queryOne<{
		ontology_version_id: number;
		version: string;
		ontology_id: string;
		label: string | null;
		description: string | null;
		definition: OntologyDefinition;
		validation: Record<string, unknown>;
		created_at: Date;
	}>(
		`SELECT v.ontology_version_id, v.version, v.ontology_id, v.label, v.description,
		        v.definition, v.validation, v.created_at
		   FROM platform.ontology_version v
		   JOIN platform.space s ON s.space_id = v.space_id
		  WHERE v.is_active AND s.slug = $1`,
		[spaceSlug],
	);
	if (!versionRow) {
		throw new NoOntologyInSpace(spaceSlug);
	}
	const versionId = versionRow.ontology_version_id;

	const typeRows = await query<{
		object_type_rid: string;
		api_name: string;
		label: string;
		plural_label: string | null;
		description: string | null;
		kind: string;
		source_view: string;
		primary_key_column: string;
		title_column: string | null;
		icon: string | null;
		color: string | null;
		group_name: string | null;
		row_count: string;
		display_order: number;
	}>(
		`SELECT * FROM platform.object_type
		  WHERE ontology_version_id = $1
		  ORDER BY display_order, api_name`,
		[versionId],
	);

	const propertyRows = await query<{
		object_property_rid: string;
		object_type_rid: string;
		api_name: string;
		label: string;
		description: string | null;
		datatype: string;
		sql_column: string;
		sql_type: string | null;
		is_identity: boolean;
		is_title: boolean;
		is_nullable: boolean;
		is_foreign_key: boolean;
		semantic_role: string;
		default_aggregation: string | null;
		unit: string | null;
		display_order: number;
	}>(
		// Joined on the version too (0013): 'tms:Order' now names a row in each
		// published version, so matching on the RID alone would return one copy
		// of every property per version that has ever held that type.
		`SELECT p.* FROM platform.object_property p
		   JOIN platform.object_type t
		     ON t.ontology_version_id = p.ontology_version_id
		    AND t.object_type_rid = p.object_type_rid
		  WHERE t.ontology_version_id = $1
		  ORDER BY p.object_type_rid, p.display_order`,
		[versionId],
	);

	const propertiesByType = new Map<string, PropertyMeta[]>();
	for (const row of propertyRows) {
		const meta: PropertyMeta = {
			rid: row.object_property_rid,
			apiName: row.api_name,
			label: row.label,
			description: row.description,
			datatype: row.datatype,
			sqlColumn: row.sql_column,
			sqlType: row.sql_type,
			isIdentity: row.is_identity,
			isTitle: row.is_title,
			isNullable: row.is_nullable,
			isForeignKey: row.is_foreign_key,
			semanticRole: row.semantic_role,
			defaultAggregation: row.default_aggregation,
			unit: row.unit,
			displayOrder: row.display_order,
		};
		const bucket = propertiesByType.get(row.object_type_rid);
		if (bucket) bucket.push(meta);
		else propertiesByType.set(row.object_type_rid, [meta]);
	}

	const objectTypes: ObjectTypeMeta[] = typeRows.map((row) => {
		const properties = propertiesByType.get(row.object_type_rid) ?? [];
		return {
			rid: row.object_type_rid,
			apiName: row.api_name,
			label: row.label,
			pluralLabel: row.plural_label,
			description: row.description,
			kind: row.kind,
			sourceView: row.source_view,
			primaryKeyColumn: row.primary_key_column,
			titleColumn: row.title_column,
			icon: row.icon,
			color: row.color,
			group: row.group_name,
			rowCount: Number(row.row_count),
			displayOrder: row.display_order,
			properties,
			propertyByApiName: new Map(properties.map((p) => [p.apiName, p])),
			propertyBySqlColumn: new Map(properties.map((p) => [p.sqlColumn, p])),
		};
	});

	const linkRows = await query<{
		link_type_rid: string;
		api_name: string;
		label: string;
		description: string | null;
		source_object_type: string;
		target_object_type: string;
		source_column: string;
		target_column: string;
		cardinality: string;
		inverse_api_name: string | null;
		inverse_label: string | null;
		discovery_method: string;
		match_ratio: string | null;
		matched_rows: string | null;
		candidate_rows: string | null;
		is_verified: boolean;
	}>(
		`SELECT * FROM platform.link_type
		  WHERE ontology_version_id = $1
		  ORDER BY source_object_type, api_name`,
		[versionId],
	);

	const linkTypes: LinkTypeMeta[] = linkRows.map((row) => ({
		rid: row.link_type_rid,
		apiName: row.api_name,
		label: row.label,
		description: row.description,
		sourceObjectType: row.source_object_type,
		targetObjectType: row.target_object_type,
		sourceColumn: row.source_column,
		targetColumn: row.target_column,
		cardinality: row.cardinality,
		inverseApiName: row.inverse_api_name,
		inverseLabel: row.inverse_label,
		discoveryMethod: row.discovery_method,
		matchRatio: Number(row.match_ratio ?? 0),
		matchedRows: Number(row.matched_rows ?? 0),
		candidateRows: Number(row.candidate_rows ?? 0),
		isVerified: row.is_verified,
	}));

	const actionRows = await query<{
		action_type_rid: string;
		api_name: string;
		label: string;
		description: string | null;
		target_object_types: string[];
		parameters: Array<Record<string, unknown>>;
		requires_approval: boolean;
		approver_roles: string[];
		allowed_roles: string[];
		audit_level: string;
		is_read_only: boolean;
		tags: string[];
	}>(
		`SELECT * FROM platform.action_type
		  WHERE ontology_version_id = $1 ORDER BY api_name`,
		[versionId],
	);

	const actionTypes: ActionTypeMeta[] = actionRows.map((row) => ({
		rid: row.action_type_rid,
		apiName: row.api_name,
		label: row.label,
		description: row.description,
		targetObjectTypes: row.target_object_types ?? [],
		parameters: row.parameters ?? [],
		requiresApproval: row.requires_approval,
		approverRoles: row.approver_roles ?? [],
		allowedRoles: row.allowed_roles ?? [],
		auditLevel: row.audit_level,
		isReadOnly: row.is_read_only,
		tags: row.tags ?? [],
	}));

	// The metric catalogue is per-space (0012), so it is filtered by slug
	// rather than by ontology version: kpi_definition has no version column.
	const kpiRows = await query<Record<string, any>>(
		`SELECT k.*
		   FROM platform.kpi_definition k
		   JOIN platform.space s ON s.space_id = k.space_id
		  WHERE s.slug = $1
		  ORDER BY k.display_order, k.api_name`,
		[spaceSlug],
	);
	const kpis: KpiMeta[] = kpiRows.map((row) => ({
		rid: row.kpi_rid,
		apiName: row.api_name,
		label: row.label,
		description: row.description,
		businessQuestion: row.business_question,
		category: row.category,
		sourceView: row.source_view,
		measureColumn: row.measure_column,
		aggregation: row.aggregation,
		numeratorColumn: row.numerator_column,
		denominatorColumn: row.denominator_column,
		dimensions: row.dimensions ?? [],
		defaultDimension: row.default_dimension,
		timeColumn: row.time_column,
		unit: row.unit,
		valueFormat: row.value_format,
		higherIsBetter: row.higher_is_better,
		targetValue: row.target_value === null ? null : Number(row.target_value),
		warningThreshold: row.warning_threshold === null ? null : Number(row.warning_threshold),
		criticalThreshold: row.critical_threshold === null ? null : Number(row.critical_threshold),
		relatedObjectTypes: row.related_object_types ?? [],
		dependsOnSimulation: row.depends_on_simulation,
		coverageNote: row.coverage_note,
		conditions: row.conditions ?? {},
		displayOrder: row.display_order,
	}));

	const linksBySourceRid = new Map<string, LinkTypeMeta[]>();
	const linksByTargetRid = new Map<string, LinkTypeMeta[]>();
	for (const link of linkTypes) {
		const source = linksBySourceRid.get(link.sourceObjectType);
		if (source) source.push(link);
		else linksBySourceRid.set(link.sourceObjectType, [link]);

		const target = linksByTargetRid.get(link.targetObjectType);
		if (target) target.push(link);
		else linksByTargetRid.set(link.targetObjectType, [link]);
	}

	const registry: Registry = {
		ontologyVersionId: versionId,
		version: versionRow.version,
		ontologyId: versionRow.ontology_id,
		label: versionRow.label,
		description: versionRow.description,
		createdAt: versionRow.created_at.toISOString(),
		definition: versionRow.definition,
		validation: versionRow.validation ?? {},
		objectTypes,
		objectTypeByApiName: new Map(objectTypes.map((t) => [t.apiName, t])),
		objectTypeByRid: new Map(objectTypes.map((t) => [t.rid, t])),
		linkTypes,
		linkTypeByApiName: new Map(linkTypes.map((l) => [l.apiName, l])),
		linksBySourceRid,
		linksByTargetRid,
		actionTypes,
		actionTypeByApiName: new Map(actionTypes.map((a) => [a.apiName, a])),
		kpis,
		kpiByApiName: new Map(kpis.map((k) => [k.apiName, k])),
		loadedAt: new Date().toISOString(),
	};

	console.log(
		`[registry] ${spaceSlug}: ontology v${registry.version} (id ${versionId}): ` +
			`${objectTypes.length} object types, ${propertyRows.length} properties, ` +
			`${linkTypes.length} link types, ${actionTypes.length} actions, ${kpis.length} KPIs.`,
	);
	return registry;
}

// ── safe identifier resolution ──────────────────────────────────────────────

export class BadRequest extends Error {
	status = 400;
}

export class NotFound extends Error {
	status = 404;
}

/** Resolve an object type by api name, case-insensitively. */
export function resolveObjectType(apiName: string): ObjectTypeMeta {
	const registry = getRegistry();
	const exact = registry.objectTypeByApiName.get(apiName);
	if (exact) return exact;
	const lowered = apiName.toLowerCase();
	const found = registry.objectTypes.find((t) => t.apiName.toLowerCase() === lowered);
	if (found) return found;
	throw new NotFound(
		`Unknown object type '${apiName}'. Known types: ` +
			registry.objectTypes.map((t) => t.apiName).join(", "),
	);
}

/**
 * Turn a caller-supplied field name into a real SQL column.
 *
 * Accepts either the ontology api name (camelCase) or the underlying SQL column,
 * and returns the SQL column only if the registry knows it. Anything else is a
 * 400, so no caller-controlled string ever reaches a query.
 */
export function resolveColumn(type: ObjectTypeMeta, field: string): PropertyMeta {
	const byApi = type.propertyByApiName.get(field);
	if (byApi) return byApi;
	const bySql = type.propertyBySqlColumn.get(field);
	if (bySql) return bySql;
	const lowered = field.toLowerCase();
	const loose = type.properties.find(
		(p) => p.apiName.toLowerCase() === lowered || p.sqlColumn.toLowerCase() === lowered,
	);
	if (loose) return loose;
	throw new BadRequest(
		`'${field}' is not a property of ${type.apiName}. Available: ` +
			type.properties.map((p) => p.apiName).join(", "),
	);
}

/** A qualified view name is only ever used after the registry vouched for it. */
export function assertKnownView(view: string): string {
	const registry = getRegistry();
	const known =
		registry.objectTypes.some((t) => t.sourceView === view) ||
		registry.kpis.some((k) => k.sourceView === view);
	if (!known) {
		throw new BadRequest(`View '${view}' is not part of the published ontology.`);
	}
	return view;
}

/** Double-quote an identifier that the registry has already vouched for. */
export function quoteIdentifier(identifier: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
		// Registry-sourced names are all plain snake_case; anything else means the
		// registry itself is carrying something unexpected, so refuse rather than
		// escape it and hope.
		throw new BadRequest(`Refusing to use '${identifier}' as an SQL identifier.`);
	}
	return `"${identifier}"`;
}

/** schema.view -> "schema"."view", validated segment by segment. */
export function quoteQualified(qualified: string): string {
	return qualified.split(".").map(quoteIdentifier).join(".");
}
