/**
 * The Ontology Builder: editing the authored ontology, and its journal.
 *
 * The ontology is one living version per space, built from datasets (see
 * authoring.ts). Every change here is done twice, in one request:
 *
 *   1. applied to the ontology tables, then published - the document rebuilt,
 *      the registry reloaded, the workspace cards refreshed (definition.ts);
 *   2. journalled to platform.ontology_edit, so "who changed this label, when,
 *      and from what" has an answer, and an edit can be undone.
 *
 * ── what cannot be edited ──────────────────────────────────────────────────
 * api_name, the RID, and source_view are fixed. The first two are how
 * everything else refers to the type - dashboards, metrics, the assistant,
 * the journal itself. source_view is the dataset the type was created from:
 * repointing it would not move the data, it would just make the type describe
 * something it is not.
 */

import { query, queryOne } from "./db";
import { activeVersion, NAMESPACE, publishChange } from "./definition";
import {
	BadRequest,
	currentSpace,
	getRegistry,
	NotFound,
	quoteIdentifier,
	quoteQualified,
	resolveObjectType,
} from "./registry";

export type EditKind = "objectType" | "property" | "linkType" | "actionType" | "metric";

export interface EditRecord {
	id: number;
	targetKind: EditKind;
	targetRid: string;
	operation: "create" | "update" | "delete";
	payload: Record<string, unknown>;
	previous: Record<string, unknown>;
	isActive: boolean;
	note: string | null;
	createdBy: string;
	createdAt: string;
}

/**
 * Fields a caller may set, per kind.
 *
 * An allow-list, not a deny-list. These become column names in an UPDATE, so
 * anything not named here never reaches SQL - and the reason a request body
 * cannot rename api_name by simply including it.
 */
const EDITABLE: Record<Exclude<EditKind, "metric">, Record<string, string>> = {
	objectType: {
		label: "label",
		pluralLabel: "plural_label",
		description: "description",
		icon: "icon",
		color: "color",
		group: "group_name",
		titleColumn: "title_column",
		displayOrder: "display_order",
		kind: "kind",
	},
	property: {
		label: "label",
		description: "description",
		semanticRole: "semantic_role",
		defaultAggregation: "default_aggregation",
		unit: "unit",
		displayOrder: "display_order",
	},
	linkType: {
		label: "label",
		description: "description",
		cardinality: "cardinality",
		inverseLabel: "inverse_label",
		isVerified: "is_verified",
	},
	actionType: {
		label: "label",
		description: "description",
		parameters: "parameters",
		requiresApproval: "requires_approval",
		approverRoles: "approver_roles",
		allowedRoles: "allowed_roles",
		isReadOnly: "is_read_only",
		tags: "tags",
	},
};

/** Values that are constrained by a CHECK, validated before they reach it. */
export const ENUMS: Record<string, string[]> = {
	kind: ["entity", "event", "role", "value"],
	semantic_role: [
		"identity",
		"title",
		"measure",
		"dimension",
		"temporal",
		"geo",
		"flag",
		"attribute",
		"provenance",
	],
	cardinality: ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"],
	default_aggregation: ["sum", "avg", "count", "min", "max"],
};

const TABLE: Record<EditKind, { table: string; ridColumn: string; versioned: boolean }> = {
	objectType: { table: "platform.object_type", ridColumn: "object_type_rid", versioned: true },
	property: { table: "platform.object_property", ridColumn: "object_property_rid", versioned: true },
	linkType: { table: "platform.link_type", ridColumn: "link_type_rid", versioned: true },
	actionType: { table: "platform.action_type", ridColumn: "action_type_rid", versioned: true },
	metric: { table: "platform.kpi_definition", ridColumn: "kpi_rid", versioned: false },
};

// ── helpers ─────────────────────────────────────────────────────────────────

async function spaceId(): Promise<number> {
	const row = await queryOne<{ space_id: number }>(
		"SELECT space_id FROM platform.space WHERE slug = $1",
		[currentSpace()],
	);
	if (!row) throw new NotFound(`No space '${currentSpace()}'.`);
	return Number(row.space_id);
}

/**
 * Turn a caller's field map into columns and values.
 *
 * A key that is not in the allow-list is refused by name, so a typo is
 * corrected rather than silently ignored - an edit that appears to work and
 * does nothing is the worst outcome here.
 */
export function resolveFields(
	kind: EditKind,
	payload: Record<string, unknown>,
): Array<{ column: string; value: unknown }> {
	if (kind === "metric") {
		throw new BadRequest("A metric is changed by deleting it and creating it again.");
	}
	const allowed = EDITABLE[kind];
	const fields: Array<{ column: string; value: unknown }> = [];

	for (const [key, value] of Object.entries(payload)) {
		const column = allowed[key];
		if (!column) {
			throw new BadRequest(
				`'${key}' is not an editable field of a ${kind}. You may set: ${Object.keys(allowed).join(", ")}.`,
			);
		}

		const permitted = ENUMS[column];
		if (permitted && value !== null && !permitted.includes(String(value))) {
			throw new BadRequest(
				`'${value}' is not a valid ${key}. Use one of: ${permitted.join(", ")}.`,
			);
		}

		fields.push({ column, value: value === undefined ? null : value });
	}

	if (fields.length === 0) throw new BadRequest("No fields to change.");
	return fields;
}

/** The current values of the fields about to change, for the journal. */
async function readPrevious(
	kind: EditKind,
	rid: string,
	columns: string[],
	versionId: number,
): Promise<Record<string, unknown>> {
	const { table, ridColumn } = TABLE[kind];
	const projection = columns.map(quoteIdentifier).join(", ");
	const row = await queryOne<Record<string, unknown>>(
		`SELECT ${projection} FROM ${table}
		  WHERE ${quoteIdentifier(ridColumn)} = $1 AND ontology_version_id = $2`,
		[rid, versionId],
	);
	if (!row) {
		throw new NotFound(`No ${kind} '${rid}' in this space's ontology.`);
	}
	return row;
}

// ── editing ─────────────────────────────────────────────────────────────────

/** Change fields on an existing ontology object, and record the change. */
export async function editOntologyObject(
	kind: EditKind,
	rid: string,
	payload: Record<string, unknown>,
	editedBy: string,
	note?: string,
): Promise<EditRecord> {
	const { id: versionId } = await activeVersion();
	const fields = resolveFields(kind, payload);
	const previous = await readPrevious(
		kind,
		rid,
		fields.map((f) => f.column),
		versionId,
	);

	const { table, ridColumn } = TABLE[kind];
	const assignments = fields
		.map((field, index) => `${quoteIdentifier(field.column)} = $${index + 3}`)
		.join(", ");

	await query(
		`UPDATE ${table} SET ${assignments}
		  WHERE ${quoteIdentifier(ridColumn)} = $1 AND ontology_version_id = $2`,
		[rid, versionId, ...fields.map((f) => f.value)],
	);

	const record = await journal(kind, rid, "update", payload, previous, editedBy, note);
	await publishChange();
	return record;
}

/** Record a change in this space's journal. */
export async function journal(
	kind: EditKind,
	rid: string,
	operation: "create" | "update" | "delete",
	payload: Record<string, unknown>,
	previous: Record<string, unknown>,
	createdBy: string,
	note?: string,
): Promise<EditRecord> {
	const row = await queryOne<{
		ontology_edit_id: number;
		created_at: Date;
	}>(
		`INSERT INTO platform.ontology_edit
		   (space_id, target_kind, target_rid, operation, payload, previous, note, created_by)
		 VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
		 RETURNING ontology_edit_id, created_at`,
		[
			await spaceId(),
			kind,
			rid,
			operation,
			JSON.stringify(payload),
			JSON.stringify(previous),
			note ?? null,
			createdBy,
		],
	);

	return {
		id: Number(row?.ontology_edit_id ?? 0),
		targetKind: kind,
		targetRid: rid,
		operation,
		payload,
		previous,
		isActive: true,
		note: note ?? null,
		createdBy,
		createdAt: row?.created_at.toISOString() ?? new Date().toISOString(),
	};
}

// ── links ───────────────────────────────────────────────────────────────────

export interface CreateLinkRequest {
	apiName: string;
	label?: string;
	description?: string;
	sourceObjectType: string;
	targetObjectType: string;
	sourceProperty: string;
	targetProperty: string;
	cardinality?: string;
	inverseApiName?: string;
	inverseLabel?: string;
}

/**
 * A camelCase handle for the objects on the other side of a link: from a
 * Location, its `originOrders`. Relation ids are unique across the whole
 * ontology, so the plain plural goes to the first link that wants it and later
 * ones are named for their role (origin, destination), then for the target.
 */
export function inverseNameFor(
	sourceApiName: string,
	targetApiName: string,
	linkApiName: string,
	taken: Set<string>,
): string {
	const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
	const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
	const plural = sourceApiName.endsWith("s") ? `${sourceApiName}es` : `${sourceApiName}s`;

	// orderOriginLocation, from Order to Location, plays the role "origin".
	let role = linkApiName;
	if (role.toLowerCase().startsWith(sourceApiName.toLowerCase())) role = role.slice(sourceApiName.length);
	if (role.toLowerCase().endsWith(targetApiName.toLowerCase())) role = role.slice(0, -targetApiName.length);

	const candidates = [
		lower(plural),
		role ? `${lower(role)}${plural}` : "",
		`${lower(targetApiName)}${plural}`,
		`${lower(plural)}Via${upper(linkApiName)}`,
	].filter(Boolean);
	return candidates.find((name) => !taken.has(name) && name !== linkApiName) ?? candidates[candidates.length - 1]!;
}

/** How much of a join between two properties actually resolves. */
export async function measureJoin(
	source: { sourceView: string },
	sourceColumn: string,
	target: { sourceView: string },
	targetColumn: string,
): Promise<{ matched: number; candidates: number; matchRatio: number }> {
	// Both identifiers came from the registry, so they are safe to quote here.
	const measured = await queryOne<{ candidates: string; matched: string }>(
		`SELECT count(*)::text AS candidates,
		        count(*) FILTER (WHERE EXISTS (
		          SELECT 1 FROM ${quoteQualified(target.sourceView)} t
		           WHERE t.${quoteIdentifier(targetColumn)}::text = s.${quoteIdentifier(sourceColumn)}::text
		        ))::text AS matched
		   FROM ${quoteQualified(source.sourceView)} s
		  WHERE s.${quoteIdentifier(sourceColumn)} IS NOT NULL`,
	);
	const candidates = Number(measured?.candidates ?? 0);
	const matched = Number(measured?.matched ?? 0);
	return { matched, candidates, matchRatio: candidates === 0 ? 0 : matched / candidates };
}

/**
 * Draw a link between two object types.
 *
 * Both ends are resolved through the registry, so the columns named really
 * exist on the datasets involved. The match ratio is then MEASURED rather than
 * assumed: a link that resolves 12% of its rows is a different thing from one
 * that resolves all of them, and the person - or the assistant - drawing it
 * should find that out here. A link where no value matches at all is refused:
 * it would only ever traverse to nothing.
 */
export async function createLinkType(
	request: CreateLinkRequest,
	createdBy: string,
): Promise<{ link: Record<string, unknown>; matchRatio: number; matched: number; candidates: number }> {
	const { id: versionId } = await activeVersion();

	const apiName = String(request.apiName ?? "").trim();
	if (!/^[a-z][A-Za-z0-9]*$/.test(apiName)) {
		throw new BadRequest(
			"A link's api name must be camelCase and start with a lowercase letter, e.g. orderAccount.",
		);
	}

	const source = resolveObjectType(String(request.sourceObjectType ?? ""));
	const target = resolveObjectType(String(request.targetObjectType ?? ""));

	const sourceProperty =
		source.propertyByApiName.get(String(request.sourceProperty)) ??
		source.propertyBySqlColumn.get(String(request.sourceProperty));
	const targetProperty =
		target.propertyByApiName.get(String(request.targetProperty)) ??
		target.propertyBySqlColumn.get(String(request.targetProperty));

	if (!sourceProperty) {
		throw new BadRequest(
			`'${request.sourceProperty}' is not a property of ${source.apiName}. It has: ` +
				source.properties.map((p) => p.apiName).join(", "),
		);
	}
	if (!targetProperty) {
		throw new BadRequest(
			`'${request.targetProperty}' is not a property of ${target.apiName}. It has: ` +
				target.properties.map((p) => p.apiName).join(", "),
		);
	}

	const registry = getRegistry();
	const relationIds = new Set(
		registry.linkTypes.flatMap((link) => [link.apiName, link.inverseApiName ?? ""]),
	);
	if (relationIds.has(apiName)) {
		throw new BadRequest(`A link called '${apiName}' already exists.`);
	}

	const cardinality = String(request.cardinality ?? "MANY_TO_ONE").toUpperCase();
	if (!ENUMS.cardinality!.includes(cardinality)) {
		throw new BadRequest(
			`'${cardinality}' is not a cardinality. Use one of: ${ENUMS.cardinality!.join(", ")}.`,
		);
	}

	const inverseApiName =
		request.inverseApiName?.trim() || inverseNameFor(source.apiName, target.apiName, apiName, relationIds);
	if (!/^[a-z][A-Za-z0-9]*$/.test(inverseApiName) || relationIds.has(inverseApiName) || inverseApiName === apiName) {
		throw new BadRequest(`'${inverseApiName}' cannot be the inverse's name: it is taken or not camelCase.`);
	}

	const { matched, candidates, matchRatio } = await measureJoin(
		source,
		sourceProperty.sqlColumn,
		target,
		targetProperty.sqlColumn,
	);
	if (candidates > 0 && matched === 0) {
		throw new BadRequest(
			`None of the ${candidates} ${source.apiName}.${sourceProperty.apiName} values appear in ` +
				`${target.apiName}.${targetProperty.apiName}, so this link would never lead anywhere. ` +
				"Check the two properties hold the same kind of key.",
		);
	}

	const rid = `${NAMESPACE}:${apiName}`;
	const label = request.label?.trim() || target.label;
	const inverseLabel = request.inverseLabel?.trim() || source.pluralLabel || `${source.label}s`;
	await query(
		`INSERT INTO platform.link_type
		   (link_type_rid, ontology_version_id, api_name, label, description,
		    source_object_type, target_object_type, source_column, target_column,
		    cardinality, inverse_api_name, inverse_label, discovery_method, match_ratio,
		    matched_rows, candidate_rows, is_verified, is_user_defined)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13,$14,$15,$16,true)`,
		[
			rid,
			versionId,
			apiName,
			label,
			request.description ?? null,
			source.rid,
			target.rid,
			sourceProperty.sqlColumn,
			targetProperty.sqlColumn,
			cardinality,
			inverseApiName,
			inverseLabel,
			matchRatio.toFixed(4),
			matched,
			candidates,
			// A link that resolves every reference is verified by the data itself.
			candidates > 0 && matched === candidates,
		],
	);

	await journal(
		"linkType",
		rid,
		"create",
		{
			apiName,
			label,
			description: request.description ?? null,
			sourceObjectType: source.apiName,
			targetObjectType: target.apiName,
			sourceProperty: sourceProperty.apiName,
			targetProperty: targetProperty.apiName,
			cardinality,
			inverseApiName,
			inverseLabel,
		},
		{},
		createdBy,
	);

	await publishChange();
	const link = getRegistry().linkTypeByApiName.get(apiName);
	return {
		link: (link ?? {}) as unknown as Record<string, unknown>,
		matchRatio,
		matched,
		candidates,
	};
}

// ── deleting ────────────────────────────────────────────────────────────────

export type DeletableKind = "objectType" | "linkType" | "actionType" | "metric";

/** What still refers to an object type, which must go before it can. */
function dependentsOf(typeRid: string): string[] {
	const registry = getRegistry();
	return [
		...registry.linkTypes
			.filter((link) => link.sourceObjectType === typeRid || link.targetObjectType === typeRid)
			.map((link) => `link ${link.apiName}`),
		...registry.actionTypes
			.filter((action) => action.targetObjectTypes.includes(typeRid))
			.map((action) => `action ${action.apiName}`),
		...registry.kpis
			.filter((kpi) => kpi.relatedObjectTypes.includes(typeRid))
			.map((kpi) => `metric ${kpi.apiName}`),
	];
}

/**
 * Remove an ontology object.
 *
 * An object type with links, actions or metrics on it is refused with their
 * names, rather than taking them with it: deleting one card should not quietly
 * empty three pages. The create in the journal is withdrawn, and the delete
 * recorded, so the history says what happened.
 */
export async function deleteOntologyObject(
	kind: DeletableKind,
	rid: string,
	deletedBy: string,
): Promise<void> {
	const { id: versionId } = await activeVersion();
	const { table, ridColumn, versioned } = TABLE[kind];

	if (kind === "objectType") {
		const dependents = dependentsOf(rid);
		if (dependents.length > 0) {
			throw new BadRequest(
				`${rid} is still used by ${dependents.join(", ")}. Delete those first.`,
			);
		}
	}

	const scope = versioned ? "ontology_version_id = $2" : "space_id = $2";
	const scopeValue = versioned ? versionId : await spaceId();
	const row = await queryOne<{ api_name: string }>(
		`DELETE FROM ${table} WHERE ${quoteIdentifier(ridColumn)} = $1 AND ${scope} RETURNING api_name`,
		[rid, scopeValue],
	);
	if (!row) throw new NotFound(`No ${kind} '${rid}' in this space's ontology.`);

	await query(
		`UPDATE platform.ontology_edit
		    SET is_active = false, withdrawn_by = $3, withdrawn_at = now()
		  WHERE space_id = $1 AND target_rid = $2 AND is_active`,
		[await spaceId(), rid, deletedBy],
	);
	await journal(kind, rid, "delete", {}, { apiName: row.api_name }, deletedBy);

	await publishChange();
}

// ── the journal ─────────────────────────────────────────────────────────────

export async function listEdits(limit = 50): Promise<EditRecord[]> {
	const bounded = Math.min(Math.max(1, limit), 200);
	const rows = await query<{
		ontology_edit_id: number;
		target_kind: EditKind;
		target_rid: string;
		operation: EditRecord["operation"];
		payload: Record<string, unknown>;
		previous: Record<string, unknown>;
		is_active: boolean;
		note: string | null;
		created_by: string;
		created_at: Date;
	}>(
		`SELECT e.* FROM platform.ontology_edit e
		   JOIN platform.space s ON s.space_id = e.space_id
		  WHERE s.slug = $1
		  ORDER BY e.created_at DESC
		  LIMIT ${bounded}`,
		[currentSpace()],
	);

	return rows.map((row) => ({
		id: Number(row.ontology_edit_id),
		targetKind: row.target_kind,
		targetRid: row.target_rid,
		operation: row.operation,
		payload: row.payload ?? {},
		previous: row.previous ?? {},
		isActive: row.is_active,
		note: row.note,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
	}));
}

/**
 * Undo an edit.
 *
 * An update puts the recorded previous values back; a create deletes what it
 * created. Either way the entry is withdrawn, so the journal shows it undone.
 */
export async function undoEdit(editId: number, undoneBy: string): Promise<void> {
	const row = await queryOne<{
		target_kind: EditKind;
		target_rid: string;
		operation: string;
		previous: Record<string, unknown>;
		is_active: boolean;
	}>(
		`SELECT e.target_kind, e.target_rid, e.operation, e.previous, e.is_active
		   FROM platform.ontology_edit e
		   JOIN platform.space s ON s.space_id = e.space_id
		  WHERE e.ontology_edit_id = $1 AND s.slug = $2`,
		[editId, currentSpace()],
	);
	if (!row) throw new NotFound(`No edit ${editId} in this space.`);
	if (!row.is_active) throw new BadRequest("That edit has already been withdrawn.");

	if (row.operation === "create") {
		if (row.target_kind === "property") {
			throw new BadRequest("A property is removed with its object type.");
		}
		await deleteOntologyObject(row.target_kind, row.target_rid, undoneBy);
		return;
	}
	if (row.operation === "delete") {
		throw new BadRequest("A delete is undone by creating the object again.");
	}

	const { id: versionId } = await activeVersion();
	const { table, ridColumn } = TABLE[row.target_kind];
	const columns = Object.keys(row.previous);
	if (columns.length > 0) {
		const assignments = columns
			.map((column, index) => `${quoteIdentifier(column)} = $${index + 3}`)
			.join(", ");
		await query(
			`UPDATE ${table} SET ${assignments}
			  WHERE ${quoteIdentifier(ridColumn)} = $1 AND ontology_version_id = $2`,
			[row.target_rid, versionId, ...columns.map((c) => row.previous[c])],
		);
	}

	await query(
		`UPDATE platform.ontology_edit
		    SET is_active = false, withdrawn_by = $2, withdrawn_at = now()
		  WHERE ontology_edit_id = $1`,
		[editId, undoneBy],
	);

	await publishChange();
}
