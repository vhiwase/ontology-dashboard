/**
 * The Ontology Builder: editing an ontology that a pipeline generates.
 *
 * Those two things are in tension, and resolving it is most of what this
 * module is. The pipeline introspects the views and publishes a NEW
 * ontology_version on every run; nothing carries forward. So writing an edit
 * straight into object_type would work until the next run and then vanish
 * without a word.
 *
 * Each edit is therefore done twice:
 *
 *   1. applied to the live version, so the UI changes immediately;
 *   2. journalled to platform.ontology_edit, keyed by RID rather than row id,
 *      so the pipeline can replay it onto the next version it publishes.
 *
 * That is what makes a hand-drawn link survive regeneration.
 *
 * ── what cannot be edited ──────────────────────────────────────────────────
 * api_name, the RID, and source_view are fixed. The first two are how
 * everything else refers to the type — dashboards, saved queries, the
 * assistant, the journal itself. source_view is what the ontology is derived
 * FROM: repointing it would not move the data, it would just make the type
 * describe something it is not.
 */

import { query, queryOne } from "./db";
import { clearColumnCache } from "./kpi";
import {
	BadRequest,
	currentSpace,
	getRegistry,
	loadRegistry,
	NotFound,
	quoteIdentifier,
	resolveObjectType,
} from "./registry";

export type EditKind = "objectType" | "property" | "linkType" | "actionType";

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
 * anything not named here never reaches SQL — the same reasoning as the
 * pipeline compiler, and the reason a request body cannot rename api_name by
 * simply including it.
 */
const EDITABLE: Record<EditKind, Record<string, string>> = {
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
const ENUMS: Record<string, string[]> = {
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

const TABLE: Record<EditKind, { table: string; ridColumn: string }> = {
	objectType: { table: "platform.object_type", ridColumn: "object_type_rid" },
	property: { table: "platform.object_property", ridColumn: "object_property_rid" },
	linkType: { table: "platform.link_type", ridColumn: "link_type_rid" },
	actionType: { table: "platform.action_type", ridColumn: "action_type_rid" },
};

// ── helpers ─────────────────────────────────────────────────────────────────

async function activeVersionId(): Promise<number> {
	const row = await queryOne<{ ontology_version_id: number }>(
		`SELECT v.ontology_version_id
		   FROM platform.ontology_version v
		   JOIN platform.space s ON s.space_id = v.space_id
		  WHERE v.is_active AND s.slug = $1`,
		[currentSpace()],
	);
	if (!row) {
		throw new BadRequest(
			`No ontology is published in the '${currentSpace()}' space, so there is nothing to edit.`,
		);
	}
	return row.ontology_version_id;
}

async function spaceId(): Promise<number> {
	const row = await queryOne<{ space_id: number }>(
		"SELECT space_id FROM platform.space WHERE slug = $1",
		[currentSpace()],
	);
	if (!row) throw new NotFound(`No space '${currentSpace()}'.`);
	return row.space_id;
}

/**
 * Turn a caller's field map into columns and values.
 *
 * Returns the SQL column names paired with bound values. A key that is not in
 * the allow-list is refused by name, so a typo is corrected rather than
 * silently ignored — an edit that appears to work and does nothing is the
 * worst outcome here.
 */
export function resolveFields(
	kind: EditKind,
	payload: Record<string, unknown>,
): Array<{ column: string; value: unknown }> {
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

		// Arrays and objects are stored as JSON/text[]; everything else binds
		// directly. Kept explicit so a caller cannot pass an object where a
		// scalar column is expected and get a confusing driver error.
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
		throw new NotFound(`No ${kind} '${rid}' in the published ontology.`);
	}
	return row;
}

// ── editing ─────────────────────────────────────────────────────────────────

/**
 * Change fields on an existing ontology object.
 *
 * Applies to the live version and records the intention. Both, or neither:
 * a journal entry whose edit did not land would be replayed onto the next
 * version and re-appear as if from nowhere.
 */
export async function editOntologyObject(
	kind: EditKind,
	rid: string,
	payload: Record<string, unknown>,
	editedBy: string,
	note?: string,
): Promise<EditRecord> {
	const versionId = await activeVersionId();
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

	// The registry is an in-memory copy of these tables, so it has to be
	// rebuilt or the UI keeps showing the old label until the next restart.
	await refresh();
	return record;
}

/** Record the intention, so the next publish can re-apply it. */
async function journal(
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
		id: row?.ontology_edit_id ?? 0,
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

async function refresh(): Promise<void> {
	clearColumnCache();
	await loadRegistry();
}

// ── links (§9) ──────────────────────────────────────────────────────────────

export interface CreateLinkRequest {
	apiName: string;
	label?: string;
	description?: string;
	sourceObjectType: string;
	targetObjectType: string;
	sourceProperty: string;
	targetProperty: string;
	cardinality?: string;
	inverseLabel?: string;
}

/**
 * Draw a link by hand.
 *
 * Both ends are resolved through the registry, so the columns named really
 * exist on the views involved. The match ratio is then MEASURED rather than
 * assumed: a hand-drawn link that resolves 12% of its rows is a different
 * thing from one that resolves all of them, and the person drawing it should
 * find that out here rather than from a half-empty table later.
 */
export async function createLinkType(
	request: CreateLinkRequest,
	createdBy: string,
): Promise<{ link: Record<string, unknown>; matchRatio: number; matched: number; candidates: number }> {
	const versionId = await activeVersionId();

	const apiName = String(request.apiName ?? "").trim();
	if (!/^[a-z][A-Za-z0-9]*$/.test(apiName)) {
		throw new BadRequest(
			"A link's api name must be camelCase and start with a lowercase letter, e.g. orderPlacedByAccount.",
		);
	}

	const source = resolveObjectType(String(request.sourceObjectType ?? ""));
	const target = resolveObjectType(String(request.targetObjectType ?? ""));

	// resolveColumn is what keeps this safe: a column name from a form is
	// matched against the registry and only its real SQL column is used.
	const sourceProperty = source.propertyByApiName.get(String(request.sourceProperty)) ??
		source.propertyBySqlColumn.get(String(request.sourceProperty));
	const targetProperty = target.propertyByApiName.get(String(request.targetProperty)) ??
		target.propertyBySqlColumn.get(String(request.targetProperty));

	if (!sourceProperty) {
		throw new BadRequest(
			`'${request.sourceProperty}' is not a property of ${source.apiName}.`,
		);
	}
	if (!targetProperty) {
		throw new BadRequest(
			`'${request.targetProperty}' is not a property of ${target.apiName}.`,
		);
	}

	const registry = getRegistry();
	if (registry.linkTypeByApiName.has(apiName)) {
		throw new BadRequest(`A link called '${apiName}' already exists.`);
	}

	const cardinality = String(request.cardinality ?? "MANY_TO_ONE").toUpperCase();
	if (!ENUMS.cardinality!.includes(cardinality)) {
		throw new BadRequest(
			`'${cardinality}' is not a cardinality. Use one of: ${ENUMS.cardinality!.join(", ")}.`,
		);
	}

	// Measure how much of the join actually resolves. Both identifiers came
	// from the registry, so they are safe to quote into this query.
	const measured = await queryOne<{ candidates: string; matched: string }>(
		`SELECT count(*)::text AS candidates,
		        count(t.${quoteIdentifier(targetProperty.sqlColumn)})::text AS matched
		   FROM ${source.sourceView} s
		   LEFT JOIN ${target.sourceView} t
		     ON s.${quoteIdentifier(sourceProperty.sqlColumn)}::text
		      = t.${quoteIdentifier(targetProperty.sqlColumn)}::text
		  WHERE s.${quoteIdentifier(sourceProperty.sqlColumn)} IS NOT NULL`,
	);

	const candidates = Number(measured?.candidates ?? 0);
	const matched = Number(measured?.matched ?? 0);
	const matchRatio = candidates === 0 ? 0 : matched / candidates;

	const rid = `tms:${apiName}`;
	await query(
		`INSERT INTO platform.link_type
		   (link_type_rid, ontology_version_id, api_name, label, description,
		    source_object_type, target_object_type, source_column, target_column,
		    cardinality, inverse_label, discovery_method, match_ratio, matched_rows,
		    candidate_rows, is_verified, is_user_defined)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,$13,$14,false,true)`,
		[
			rid,
			versionId,
			apiName,
			request.label?.trim() || apiName,
			request.description ?? null,
			source.rid,
			target.rid,
			sourceProperty.sqlColumn,
			targetProperty.sqlColumn,
			cardinality,
			request.inverseLabel ?? null,
			matchRatio.toFixed(4),
			matched,
			candidates,
		],
	);

	// Journalled with the full definition, because replay has to RE-CREATE this
	// link on the next version - the pipeline will never discover it.
	await journal(
		"linkType",
		rid,
		"create",
		{
			apiName,
			label: request.label?.trim() || apiName,
			description: request.description ?? null,
			sourceObjectType: source.apiName,
			targetObjectType: target.apiName,
			sourceProperty: sourceProperty.sqlColumn,
			targetProperty: targetProperty.sqlColumn,
			cardinality,
			inverseLabel: request.inverseLabel ?? null,
		},
		{},
		createdBy,
	);

	await refresh();
	const link = getRegistry().linkTypeByApiName.get(apiName);
	return {
		link: (link ?? {}) as unknown as Record<string, unknown>,
		matchRatio,
		matched,
		candidates,
	};
}

/**
 * Remove an ontology object.
 *
 * Only ones a person created. A pipeline-discovered link describes something
 * that is really in the data, and deleting it here would simply be undone by
 * the next run — so the refusal explains that rather than pretending.
 */
export async function deleteOntologyObject(
	kind: "linkType" | "actionType",
	rid: string,
	deletedBy: string,
): Promise<void> {
	const versionId = await activeVersionId();
	const { table, ridColumn } = TABLE[kind];

	const row = await queryOne<{ is_user_defined: boolean; api_name: string }>(
		`SELECT is_user_defined, api_name FROM ${table}
		  WHERE ${quoteIdentifier(ridColumn)} = $1 AND ontology_version_id = $2`,
		[rid, versionId],
	);
	if (!row) throw new NotFound(`No ${kind} '${rid}'.`);

	if (!row.is_user_defined) {
		throw new BadRequest(
			`'${row.api_name}' was discovered by the pipeline from the data itself, so deleting ` +
				`it here would be undone by the next run. Edit the pipeline, or hide it instead.`,
		);
	}

	await query(
		`DELETE FROM ${table} WHERE ${quoteIdentifier(ridColumn)} = $1 AND ontology_version_id = $2`,
		[rid, versionId],
	);

	// The create is withdrawn rather than a delete being journalled: replaying
	// a create followed by a delete would work, but leaves the journal
	// describing a link that never needed to exist.
	await query(
		`UPDATE platform.ontology_edit
		    SET is_active = false, withdrawn_by = $3, withdrawn_at = now()
		  WHERE space_id = $1 AND target_rid = $2 AND is_active`,
		[await spaceId(), rid, deletedBy],
	);

	await refresh();
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
		id: row.ontology_edit_id,
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
 * Applies the recorded previous values and withdraws the journal entry, so the
 * change is reversed both now and on every future publish.
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
		await deleteOntologyObject(row.target_kind as "linkType" | "actionType", row.target_rid, undoneBy);
		return;
	}

	const versionId = await activeVersionId();
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

	await refresh();
}
