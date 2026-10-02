/**
 * The ontology document, rebuilt from the tables it describes.
 *
 * The ontology used to be generated in Python from the tms_views schema and
 * published as a new version on every boot. It is authored now - object types
 * are created from synced datasets, and links, actions and metrics hang off
 * them - so there is one living version per space, edited in place, and this
 * module keeps the three things that describe it in step after every change:
 *
 *   * the OntologyDefinition document ontograph validates, exports and uses
 *     for action parameters and role checks;
 *   * the in-memory registry every query is built through;
 *   * the workspace cards (/Ontology/...) that let the rest of the UI open an
 *     object type, link, action or metric like any other resource.
 *
 * The tables are the source of truth. The document is derived from them and
 * never edited directly, which is what lets a change be one INSERT plus a call
 * to publishChange() rather than two edits that can drift apart.
 */

import {
	type ActionType,
	type AttributeDefinition,
	type EntityType,
	type OntologyDefinition,
	OntologyValidator,
	type RelationType,
} from "@ontograph/core";
import { query, queryOne } from "./db";
import { clearColumnCache } from "./kpi";
import { currentSpace, loadRegistry, NotFound } from "./registry";

/** The namespace every authored RID lives in. */
export const NAMESPACE = "tms";

const ONTOLOGY_ID = `${NAMESPACE}:TransportManagementOntology`;

// ── roles ───────────────────────────────────────────────────────────────────
//  Fixed, and mirrored by ONTOLOGY_ROLES in services/pipeline/pipeline/users.py
//  because a user's ontology_role must name one of them. What varies is which
//  actions each may run: that comes from each action's allowed_roles.

interface BaseRole {
	id: string;
	label: string;
	description: string;
	objectPermissions: string[];
}

export const BASE_ROLES: BaseRole[] = [
	{
		id: `${NAMESPACE}:AdminRole`,
		label: "Platform Administrator",
		description: "Full control over the ontology and every action.",
		objectPermissions: ["view", "create", "edit", "delete", "export"],
	},
	{
		id: `${NAMESPACE}:OperationsManagerRole`,
		label: "Operations Manager",
		description: "Owns service delivery; runs the actions that name this role.",
		objectPermissions: ["view", "edit", "export"],
	},
	{
		id: `${NAMESPACE}:DispatcherRole`,
		label: "Dispatcher",
		description: "Plans and moves freight; runs the actions that name this role.",
		objectPermissions: ["view"],
	},
	{
		id: `${NAMESPACE}:FinanceRole`,
		label: "Freight Finance",
		description: "Rates, invoices and charges; runs the actions that name this role.",
		objectPermissions: ["view", "export"],
	},
	{
		id: `${NAMESPACE}:AnalystRole`,
		label: "Business Analyst",
		description:
			"Reads everything, changes nothing. The assistant runs as the signed-in user, " +
			"and an analyst may run no action.",
		objectPermissions: ["view", "export"],
	},
];

export const ROLE_IDS = BASE_ROLES.map((role) => role.id);

// ── datatypes ───────────────────────────────────────────────────────────────

/** A PostgreSQL column type as the ontology datatype it presents as. */
export function datatypeFor(sqlType: string): AttributeDefinition["datatype"] {
	const type = sqlType.toLowerCase();
	if (type.endsWith("[]") || type === "array") return "array";
	if (["smallint", "integer", "bigint", "int2", "int4", "int8"].includes(type)) return "integer";
	if (["numeric", "decimal"].includes(type)) return "decimal";
	if (["real", "double precision", "float4", "float8"].includes(type)) return "float";
	if (["boolean", "bool"].includes(type)) return "boolean";
	if (type === "date") return "date";
	if (type.startsWith("timestamp")) return "datetime";
	if (type === "interval") return "duration";
	if (["json", "jsonb"].includes(type)) return "object";
	return "string";
}

// ── the document ────────────────────────────────────────────────────────────

type TypeRow = {
	object_type_rid: string;
	label: string;
	description: string | null;
	kind: "entity" | "event" | "role" | "value";
	icon: string | null;
	color: string | null;
	group_name: string | null;
};
type PropertyRow = {
	object_property_rid: string;
	object_type_rid: string;
	label: string;
	description: string | null;
	datatype: string;
	is_identity: boolean;
	is_nullable: boolean;
};
type LinkRow = {
	link_type_rid: string;
	label: string;
	description: string | null;
	source_object_type: string;
	target_object_type: string;
	cardinality: string;
	inverse_api_name: string | null;
	inverse_label: string | null;
};
type ActionRow = {
	action_type_rid: string;
	label: string;
	description: string | null;
	target_object_types: string[];
	parameters: ActionType["parameters"];
	requires_approval: boolean;
	approver_roles: string[];
	allowed_roles: string[];
	audit_level: "minimal" | "full";
	tags: string[];
};

const text = (value: string | null | undefined) => (value ? { en: value } : undefined);

/** The inverse relation's id: named on the link, or derived from it. */
export function inverseRid(link: { link_type_rid: string; inverse_api_name: string | null }): string {
	return link.inverse_api_name
		? `${NAMESPACE}:${link.inverse_api_name}`
		: `${link.link_type_rid}Inverse`;
}

/** Assemble the document from the rows of one version. Pure, so it is testable. */
export function buildDefinition(input: {
	version: string;
	types: TypeRow[];
	properties: PropertyRow[];
	links: LinkRow[];
	actions: ActionRow[];
}): OntologyDefinition {
	const propertiesByType = new Map<string, PropertyRow[]>();
	for (const property of input.properties) {
		const bucket = propertiesByType.get(property.object_type_rid) ?? [];
		bucket.push(property);
		propertiesByType.set(property.object_type_rid, bucket);
	}

	// One attribute per property. The generator shared attributes across types
	// by name; authored types come from unrelated datasets, where two columns
	// with one name are a coincidence rather than a shared meaning.
	const attributes: AttributeDefinition[] = input.properties.map((property) => ({
		"@id": property.object_property_rid,
		"@type": "Attribute",
		label: { en: property.label },
		...(property.description ? { description: { en: property.description } } : {}),
		datatype: property.datatype as AttributeDefinition["datatype"],
		...(property.is_identity ? { identity: true, required: true } : {}),
	}));

	const relationTypes: RelationType[] = [];
	for (const link of input.links) {
		const single = link.cardinality === "MANY_TO_ONE" || link.cardinality === "ONE_TO_ONE";
		relationTypes.push({
			"@id": link.link_type_rid,
			"@type": "RelationType",
			label: { en: link.label },
			...(link.description ? { description: { en: link.description } } : {}),
			domain: link.source_object_type,
			range: link.target_object_type,
			min: 0,
			max: single ? 1 : null,
			inverse: inverseRid(link),
		});
		relationTypes.push({
			"@id": inverseRid(link),
			"@type": "RelationType",
			label: { en: link.inverse_label ?? `${link.label} (inverse)` },
			domain: link.target_object_type,
			range: link.source_object_type,
			min: 0,
			max: link.cardinality === "ONE_TO_ONE" ? 1 : null,
			inverse: link.link_type_rid,
		});
	}

	const entity = (type: TypeRow): EntityType => ({
		"@id": type.object_type_rid,
		"@type": "EntityType",
		label: { en: type.label },
		...(type.description ? { description: { en: type.description } } : {}),
		kind: type.kind,
		attributes: (propertiesByType.get(type.object_type_rid) ?? []).map((property) => ({
			ref: property.object_property_rid,
			...(property.is_identity ? { identity: true, required: true } : {}),
		})),
		relations: [
			...input.links
				.filter((link) => link.source_object_type === type.object_type_rid)
				.map((link) => ({ ref: link.link_type_rid })),
			...input.links
				.filter((link) => link.target_object_type === type.object_type_rid)
				.map((link) => ({ ref: inverseRid(link) })),
		],
		constraints: [],
		ui: {
			...(type.color ? { color: type.color } : {}),
			...(type.icon ? { icon: type.icon } : {}),
			...(type.group_name ? { group: type.group_name } : {}),
			visible: true,
		},
	});

	const actionTypes: ActionType[] = input.actions.map((action) => ({
		"@id": action.action_type_rid,
		"@type": "ActionType",
		label: { en: action.label },
		...(action.description ? { description: { en: action.description } } : {}),
		parameters: action.parameters ?? [],
		targetTypes: action.target_object_types ?? [],
		approvalPolicy: {
			required: action.requires_approval,
			...(action.approver_roles?.length ? { approvers: action.approver_roles } : {}),
		},
		auditConfig: { enabled: true, logLevel: action.audit_level },
		permissions: { allowedRoles: action.allowed_roles ?? [] },
		tags: action.tags ?? [],
	}));

	// Roles: fixed object permissions, plus an execute rule for every action
	// that names the role. The admin may run everything; nobody else may run
	// an action that did not name them, because the controller denies by
	// default.
	const roles = BASE_ROLES.map((role) => ({
		"@id": role.id,
		"@type": "Role" as const,
		label: { en: role.label },
		description: { en: role.description },
		rules: [
			{ resource: "objectType", permissions: role.objectPermissions, resourceRef: "*" },
			...(role.id === `${NAMESPACE}:AdminRole`
				? [{ resource: "actionType", permissions: ["view", "execute"], resourceRef: "*" }]
				: input.actions
						.filter((action) => (action.allowed_roles ?? []).includes(role.id))
						.map((action) => ({
							resource: "actionType",
							permissions: ["view", "execute"],
							resourceRef: action.action_type_rid,
						}))),
		],
	}));

	return {
		"@context": {
			ontograph: "https://ontograph.dev/schema#",
			xsd: "http://www.w3.org/2001/XMLSchema#",
			[NAMESPACE]: "https://grctechllc.com/tms/ontology#",
		},
		"@id": ONTOLOGY_ID,
		"@type": "Ontology",
		version: input.version,
		label: { en: "TMS Ontology" },
		description: text(
			"Object types created from synced datasets, with the links, actions and metrics defined on them.",
		),
		entityTypes: input.types.filter((type) => type.kind !== "event" && type.kind !== "role").map(entity),
		eventTypes: input.types.filter((type) => type.kind === "event").map(entity),
		roleTypes: input.types.filter((type) => type.kind === "role").map(entity),
		relationTypes,
		attributes,
		constraints: [],
		actionTypes,
		roles: roles as unknown as OntologyDefinition["roles"],
	};
}

// ── keeping it in step ──────────────────────────────────────────────────────

async function spaceIdOf(spaceSlug: string): Promise<number> {
	const row = await queryOne<{ space_id: number }>(
		"SELECT space_id FROM platform.space WHERE slug = $1",
		[spaceSlug],
	);
	if (!row) throw new NotFound(`No space '${spaceSlug}'.`);
	return Number(row.space_id);
}

/** The active version of a space's ontology, creating an empty one if it has none. */
export async function activeVersion(spaceSlug = currentSpace()): Promise<{ id: number; version: string }> {
	const found = await queryOne<{ ontology_version_id: number; version: string }>(
		`SELECT v.ontology_version_id, v.version
		   FROM platform.ontology_version v
		   JOIN platform.space s ON s.space_id = v.space_id
		  WHERE v.is_active AND s.slug = $1`,
		[spaceSlug],
	);
	if (found) return { id: Number(found.ontology_version_id), version: found.version };

	const created = await queryOne<{ ontology_version_id: number; version: string }>(
		`INSERT INTO platform.ontology_version
		   (version, ontology_id, label, description, definition, is_active, created_by, space_id)
		 VALUES ('1.0', $1, 'TMS Ontology',
		         'Object types created from synced datasets.', '{}'::jsonb, true, 'authoring', $2)
		 ON CONFLICT DO NOTHING
		 RETURNING ontology_version_id, version`,
		[ONTOLOGY_ID, await spaceIdOf(spaceSlug)],
	);
	if (created) return { id: Number(created.ontology_version_id), version: created.version };
	// Lost a race with another request creating the same space's version.
	return activeVersion(spaceSlug);
}

/** "1.4" -> "1.5". The minor number counts published changes. */
function bumped(version: string): string {
	const [major, minor] = version.split(".");
	return `${major || "1"}.${(Number(minor) || 0) + 1}`;
}

/**
 * Rebuild a space's document from its rows, store it with its validation,
 * reload the registry and refresh the workspace cards.
 *
 * Every authoring change ends here. `bump` is false only at boot, where the
 * document is rebuilt in case this code changed but the ontology did not.
 */
export async function publishChange(spaceSlug = currentSpace(), bump = true): Promise<void> {
	const { id, version } = await activeVersion(spaceSlug);

	const [types, properties, links, actions] = await Promise.all([
		query<TypeRow>(
			`SELECT object_type_rid, label, description, kind, icon, color, group_name
			   FROM platform.object_type WHERE ontology_version_id = $1
			  ORDER BY display_order, api_name`,
			[id],
		),
		query<PropertyRow>(
			`SELECT object_property_rid, object_type_rid, label, description, datatype,
			        is_identity, is_nullable
			   FROM platform.object_property WHERE ontology_version_id = $1
			  ORDER BY object_type_rid, display_order`,
			[id],
		),
		query<LinkRow>(
			`SELECT link_type_rid, label, description, source_object_type, target_object_type,
			        cardinality, inverse_api_name, inverse_label
			   FROM platform.link_type WHERE ontology_version_id = $1 ORDER BY api_name`,
			[id],
		),
		query<ActionRow>(
			`SELECT action_type_rid, label, description, target_object_types, parameters,
			        requires_approval, approver_roles, allowed_roles, audit_level, tags
			   FROM platform.action_type WHERE ontology_version_id = $1 ORDER BY api_name`,
			[id],
		),
	]);

	const nextVersion = bump ? bumped(version) : version;
	const definition = buildDefinition({ version: nextVersion, types, properties, links, actions });
	const validation = new OntologyValidator().validate(definition);

	await query(
		`UPDATE platform.ontology_version
		    SET definition = $2::jsonb, validation = $3::jsonb, version = $4,
		        object_type_count = $5, link_type_count = $6, action_type_count = $7
		  WHERE ontology_version_id = $1`,
		[
			id,
			JSON.stringify(definition),
			JSON.stringify(validation),
			nextVersion,
			types.length,
			links.length,
			actions.length,
		],
	);

	clearColumnCache();
	await loadRegistry(spaceSlug);
	await syncOntologyCards(spaceSlug, id);
}

/** At boot: every space has an active ontology, and every document is current. */
export async function ensureOntologies(): Promise<void> {
	const spaces = await query<{ slug: string }>("SELECT slug FROM platform.space ORDER BY slug");
	// Every version first, then every document: publishing reloads the whole
	// registry, which should never see a space half set up.
	for (const { slug } of spaces) await activeVersion(slug);
	for (const { slug } of spaces) await publishChange(slug, false);
}

// ── workspace cards ─────────────────────────────────────────────────────────
//  Written with SQL rather than through spaces.ts, which imports modules that
//  import this one. A card is a pointer by api name, so keeping them in step
//  is an upsert of what exists and a delete of what no longer does.

const CARD_FOLDERS: Record<string, string> = {
	objectType: "Object types",
	linkType: "Links",
	actionType: "Action Types",
	kpi: "Metrics",
};

async function ensureFolder(projectId: number, path: string): Promise<number> {
	let parentId: number | null = null;
	let current = "";
	for (const name of path.split("/").filter(Boolean)) {
		current = `${current}/${name}`;
		const found: { folder_id: number } | null = await queryOne<{ folder_id: number }>(
			"SELECT folder_id FROM platform.folder WHERE project_id = $1 AND path = $2",
			[projectId, current],
		);
		if (found) {
			parentId = Number(found.folder_id);
			continue;
		}
		const created: { folder_id: number } | null = await queryOne<{ folder_id: number }>(
			`INSERT INTO platform.folder (project_id, parent_id, name, path, created_by)
			 VALUES ($1,$2,$3,$4,'system') RETURNING folder_id`,
			[projectId, parentId, name, current],
		);
		parentId = Number(created!.folder_id);
	}
	return parentId!;
}

/** The project a space's ontology cards live in: its oldest, or a new one. */
async function homeProject(spaceSlug: string): Promise<number> {
	const found = await queryOne<{ project_id: number }>(
		`SELECT p.project_id FROM platform.project p
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 ORDER BY p.created_at, p.project_id LIMIT 1`,
		[spaceSlug],
	);
	if (found) return Number(found.project_id);
	const created = await queryOne<{ project_id: number }>(
		`INSERT INTO platform.project (space_id, slug, name, description, created_by)
		 VALUES ($1, 'workspace', 'Workspace', 'Connections, datasets and the ontology built on them.', 'system')
		 RETURNING project_id`,
		[await spaceIdOf(spaceSlug)],
	);
	return Number(created!.project_id);
}

async function syncOntologyCards(spaceSlug: string, versionId: number): Promise<void> {
	const wanted = await query<{ kind: string; ref: string; description: string | null }>(
		`SELECT 'objectType' AS kind, api_name AS ref, description
		   FROM platform.object_type WHERE ontology_version_id = $1
		 UNION ALL
		 SELECT 'linkType', api_name, description FROM platform.link_type WHERE ontology_version_id = $1
		 UNION ALL
		 SELECT 'actionType', api_name, description FROM platform.action_type WHERE ontology_version_id = $1
		 UNION ALL
		 SELECT 'kpi', k.api_name, k.description
		   FROM platform.kpi_definition k JOIN platform.space s ON s.space_id = k.space_id
		  WHERE s.slug = $2`,
		[versionId, spaceSlug],
	);

	const existing = await query<{ resource_id: number; kind: string; target_ref: string }>(
		`SELECT r.resource_id, r.kind, r.target_ref
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND r.kind IN ('objectType','linkType','actionType','kpi')`,
		[spaceSlug],
	);

	const want = new Set(wanted.map((row) => `${row.kind}:${row.ref}`));
	const have = new Set(existing.map((row) => `${row.kind}:${row.target_ref}`));

	const stale = existing.filter((row) => !want.has(`${row.kind}:${row.target_ref}`));
	if (stale.length > 0) {
		await query("DELETE FROM platform.resource WHERE resource_id = ANY($1::bigint[])", [
			stale.map((row) => row.resource_id),
		]);
	}

	const missing = wanted.filter((row) => !have.has(`${row.kind}:${row.ref}`));
	if (missing.length === 0) return;

	const projectId = await homeProject(spaceSlug);
	for (const row of missing) {
		const folderId = await ensureFolder(projectId, `/Ontology/${CARD_FOLDERS[row.kind]}`);
		await query(
			`INSERT INTO platform.resource
			   (project_id, folder_id, kind, name, description, target_ref, properties, created_by)
			 VALUES ($1,$2,$3,$4,$5,$4,'{}'::jsonb,'system')
			 ON CONFLICT (project_id, folder_id, name) DO NOTHING`,
			[projectId, folderId, row.kind, row.ref, row.description],
		);
	}
}
