/**
 * Deleting things, and saying first what goes with them.
 *
 * Every kind of thing on the platform could be made; only some could be
 * removed, and the ones that could were removed in ways that did not hold:
 *
 *   * "Remove" on a metric, an object type, a link or an action only took its
 *     card out of the workspace list. The cards are rebuilt from the ontology on
 *     every change, so it was back the next time anything was edited.
 *   * Removing a connection took its syncs with it and left their schedules
 *     behind, firing every tick against a sync that no longer existed.
 *   * Removing a dataset left the copied table, and the sync that would put the
 *     dataset straight back on its next run.
 *   * A function, a proposal and a schedule could not be removed at all.
 *
 * So there is one place that knows, for each kind, what deleting it means:
 *
 *   removes     what is part of it and goes with it, always - a sync's
 *               schedule, a dataset's copied table, a type's properties;
 *   dependents  things with a name of their own that cannot exist without it -
 *               the object types built on a dataset, the metrics, links and
 *               actions on an object type. They are deleted too, but only when
 *               the caller says so (cascade): a request that does not is
 *               refused with their names, so nothing built on something is
 *               ever lost to a delete that did not mention it;
 *   affects     what stays and will not be the same - a dashboard showing a
 *               metric that is going, a dataset that can no longer be refreshed.
 *
 * plan() answers with those three lists and changes nothing; the confirmation
 * a person sees is that answer. remove() carries it out.
 */

import {
	deleteOntologyObject,
	journal,
	type DeletableKind,
	type EditKind,
} from "./builder";
import { deleteSync, LANDING_SCHEMA, listSyncs, type SyncRecord } from "./connections";
import { deleteDashboard, getDashboard, listDashboards } from "./dashboards";
import { pool, query, queryOne } from "./db";
import { activeVersion, publishChange } from "./definition";
import { deleteFunction, functionRuns, getFunction, listFunctions } from "./functions";
import { clearColumnCache } from "./kpi";
import { deleteProposal, getProposal, proposalsWaitingOn } from "./proposals";
import {
	BadRequest,
	NotFound,
	currentSpace,
	getRegistry,
	hasOntology,
	loadRegistry,
	quoteQualified,
	type ActionTypeMeta,
	type KpiMeta,
	type LinkTypeMeta,
	type ObjectTypeMeta,
} from "./registry";
import { deleteSchedule, describeInterval, getSchedule } from "./schedules";
import { deleteResource } from "./spaces";
import { assertResourceInSpace, assertSyncInSpace } from "./workspaces";

export const REMOVABLE_KINDS = [
	"connection",
	"dataset",
	"sync",
	"schedule",
	"objectType",
	"linkType",
	"actionType",
	"metric",
	"function",
	"dashboard",
	"proposal",
] as const;

export type RemovableKind = (typeof REMOVABLE_KINDS)[number];

export interface RemovalItem {
	/** What it is: sync, schedule, table, objectType, metric, dashboard ... */
	kind: string;
	name: string;
	/** Anything a person should know about it in particular. */
	note?: string;
}

export interface RemovalPlan {
	kind: RemovableKind;
	/** How the caller named it: an id, an api name or a slug. */
	ref: string;
	/** What a person calls it. */
	name: string;
	removes: RemovalItem[];
	dependents: RemovalItem[];
	affects: RemovalItem[];
	/** Why it cannot be deleted at all, when it cannot. */
	refused: string | null;
}

/** Refused because things are built on it and the request did not include them. */
export class RemovalNeedsCascade extends Error {
	readonly status = 409;

	constructor(readonly plan: RemovalPlan) {
		super(
			`${plan.name} still has ${countOf(plan.dependents.length, "thing")} built on it: ` +
				`${plan.dependents.map((item) => `${label(item.kind)} ${item.name}`).join(", ")}. ` +
				"Delete those first, or delete it together with them.",
		);
	}
}

export function removableKind(raw: string): RemovableKind {
	// The workspace calls a metric a "kpi"; both name the same thing here.
	const kind = raw === "kpi" ? "metric" : raw;
	if (!(REMOVABLE_KINDS as readonly string[]).includes(kind)) {
		throw new BadRequest(`'${raw}' is not something that can be deleted. Use one of: ${REMOVABLE_KINDS.join(", ")}.`);
	}
	return kind as RemovableKind;
}

// ── words ───────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
	objectType: "object type",
	linkType: "link",
	actionType: "action",
	metric: "metric",
	dataset: "dataset",
	sync: "sync",
	schedule: "schedule",
	dashboard: "dashboard",
	function: "function",
	proposal: "proposal",
	table: "table",
	connection: "connection",
};

function label(kind: string): string {
	return LABELS[kind] ?? kind;
}

/** "1 metric", "3 metrics", "2 properties". */
export function countOf(n: number, noun: string, plural = `${noun}s`): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? noun : plural}`;
}

function listOf(parts: Array<[number, string]>): string {
	return parts
		.filter(([n]) => n > 0)
		.map(([n, noun]) => countOf(n, noun))
		.join(", ");
}

// ── resources ───────────────────────────────────────────────────────────────

interface ResourceRow {
	resource_id: string;
	kind: string;
	name: string;
	target_ref: string | null;
	properties: Record<string, unknown> | null;
	created_by: string;
}

async function resourceRow(ref: string, kind: "connection" | "dataset"): Promise<ResourceRow> {
	const id = Number(ref);
	if (!Number.isInteger(id) || id <= 0) throw new BadRequest(`'${ref}' is not a ${kind}'s id.`);
	await assertResourceInSpace(id, currentSpace());
	const row = await queryOne<ResourceRow>(
		`SELECT resource_id::text, kind, name, target_ref, properties, created_by
		   FROM platform.resource WHERE resource_id = $1`,
		[id],
	);
	if (!row || row.kind !== kind) throw new NotFound(`No ${kind} ${id} in this space.`);
	return row;
}

function syncItem(sync: SyncRecord): RemovalItem {
	return {
		kind: "sync",
		name: `${sync.sourceSchema}.${sync.sourceTable}`,
		// The record of its runs is rows of the sync, and goes when it does.
		note: sync.schedule
			? `with the record of its runs and its schedule (${describeInterval(sync.schedule.intervalSeconds)})`
			: "with the record of its runs",
	};
}

// ── what a dataset is made of, and who owns its table ───────────────────────

interface DatasetParts {
	relation: string | null;
	/** The sync in THIS space that lands the table, if there still is one. */
	sync: SyncRecord | null;
	/** True when the table is one this dataset's own sync wrote, so it may be dropped. */
	ownsTable: boolean;
	rows: number | null;
}

/**
 * The table behind a dataset, and whether deleting the dataset may drop it.
 *
 * Every workspace's copied tables share one schema, so "the table this card
 * names" is not enough to drop it: a card can be registered by hand with any
 * name on it. The table is this dataset's to drop only when the sync that
 * lands it is in this space - or, once that sync is gone, when the card is the
 * one a sync run registered (those are written by the system, never by a
 * person) and no other sync has claimed the table since.
 */
async function datasetParts(resource: ResourceRow): Promise<DatasetParts> {
	const properties = resource.properties ?? {};
	const relation = resource.target_ref ?? (typeof properties.sourceView === "string" ? properties.sourceView : null);
	if (!relation) return { relation: null, sync: null, ownsTable: false, rows: null };
	const [schema, table, ...rest] = relation.split(".");
	if (schema !== LANDING_SCHEMA || !table || rest.length > 0 || !/^[a-z0-9_]+$/.test(table)) {
		// A view of the source, or anything else this platform did not write.
		return { relation, sync: null, ownsTable: false, rows: null };
	}

	const owner = await queryOne<{ sync_id: string; resource_id: string; slug: string }>(
		`SELECT c.sync_id::text, c.resource_id::text, s.slug
		   FROM platform.connection_sync c
		   JOIN platform.resource r ON r.resource_id = c.resource_id
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE c.target_table = $1`,
		[table],
	);
	let sync: SyncRecord | null = null;
	let ownsTable: boolean;
	if (owner) {
		ownsTable = owner.slug === currentSpace();
		if (ownsTable) {
			sync = (await listSyncs(Number(owner.resource_id))).find((entry) => Number(entry.id) === Number(owner.sync_id)) ?? null;
		}
	} else {
		ownsTable = resource.created_by === "system" && properties.backing === "sync";
	}

	const exists = await queryOne<{ n: string }>(
		`SELECT c.reltuples::bigint::text AS n
		   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
		[LANDING_SCHEMA, table],
	);
	let rows: number | null = null;
	if (exists) {
		const counted = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoteQualified(relation)}`);
		rows = Number(counted?.n ?? 0);
	} else {
		ownsTable = false;
	}
	return { relation, sync, ownsTable, rows };
}

/** Views that read a table: a combined dataset is one. */
async function viewsReading(relation: string): Promise<string[]> {
	const [schema, table] = relation.split(".");
	const rows = await query<{ view: string }>(
		`SELECT DISTINCT vn.nspname || '.' || v.relname AS view
		   FROM pg_depend d
		   JOIN pg_rewrite r ON r.oid = d.objid
		   JOIN pg_class v ON v.oid = r.ev_class
		   JOIN pg_namespace vn ON vn.oid = v.relnamespace
		   JOIN pg_class t ON t.oid = d.refobjid
		   JOIN pg_namespace tn ON tn.oid = t.relnamespace
		  WHERE tn.nspname = $1 AND t.relname = $2 AND v.oid <> t.oid
		  ORDER BY 1`,
		[schema, table],
	);
	return rows.map((row) => row.view);
}

// ── what is built on an object type ─────────────────────────────────────────

interface TypeParts {
	type: ObjectTypeMeta;
	links: LinkTypeMeta[];
	actions: ActionTypeMeta[];
	metrics: KpiMeta[];
}

function typeParts(type: ObjectTypeMeta): TypeParts {
	const registry = getRegistry();
	return {
		type,
		links: registry.linkTypes.filter((link) => link.sourceObjectType === type.rid || link.targetObjectType === type.rid),
		actions: registry.actionTypes.filter((action) => action.targetObjectTypes.includes(type.rid)),
		// A metric belongs to the type it measures. One that only mentions the
		// type among several is left, and named as affected.
		metrics: registry.kpis.filter((kpi) => kpi.objectTypeRid === type.rid),
	};
}

function typeDependents(parts: TypeParts): RemovalItem[] {
	return [
		...parts.metrics.map((kpi) => ({ kind: "metric", name: kpi.apiName, note: kpi.label })),
		...parts.links.map((link) => ({ kind: "linkType", name: link.apiName, note: link.label })),
		...parts.actions.map((action) => ({ kind: "actionType", name: action.apiName, note: action.label })),
	];
}

/** Dashboards and reports showing any of these metrics, with how many widgets each. */
async function boardsShowing(metricApiNames: string[]): Promise<RemovalItem[]> {
	if (metricApiNames.length === 0) return [];
	const wanted = new Set(metricApiNames);
	const boards = await listDashboards(currentSpace());
	const out: RemovalItem[] = [];
	for (const board of boards) {
		const widgets = board.layout.filter((widget) => widget.kpi && wanted.has(widget.kpi)).length;
		if (widgets > 0) {
			out.push({
				kind: "dashboard",
				name: board.title,
				note: `${countOf(widgets, "widget")} of its ${board.layout.length} will show an error instead of a figure`,
			});
		}
	}
	return out;
}

function ontologyObject<T extends { rid: string; apiName: string }>(
	what: string,
	ref: string,
	all: T[],
): T {
	const found = all.find((entry) => entry.apiName === ref || entry.rid === ref);
	if (!found) throw new NotFound(`No ${what} '${ref}' in this space's ontology.`);
	return found;
}

function registryOrNone() {
	if (!hasOntology(currentSpace())) throw new NotFound("This space has no ontology, so there is nothing of that kind here.");
	return getRegistry();
}

// ── the plan ────────────────────────────────────────────────────────────────

export async function planRemoval(kind: RemovableKind, ref: string): Promise<RemovalPlan> {
	const plan = (name: string, parts: Partial<Omit<RemovalPlan, "kind" | "ref" | "name">> = {}): RemovalPlan => ({
		kind,
		ref,
		name,
		removes: parts.removes ?? [],
		dependents: parts.dependents ?? [],
		affects: parts.affects ?? [],
		refused: parts.refused ?? null,
	});

	switch (kind) {
		case "connection": {
			const resource = await resourceRow(ref, "connection");
			const syncs = await listSyncs(Number(resource.resource_id));
			const secretRef = resource.properties?.secretRef;
			const datasets = await query<{ name: string }>(
				`SELECT r.name FROM platform.resource r
				  WHERE r.resource_id = ANY($1::bigint[]) ORDER BY r.name`,
				[syncs.map((sync) => sync.datasetResourceId).filter((id): id is number => id !== null)],
			);
			return plan(resource.name, {
				removes: [
					...syncs.map(syncItem),
					...(typeof secretRef === "string" && secretRef.startsWith("vault:")
						? [{ kind: "password", name: "its stored password" }]
						: []),
				],
				affects: datasets.map((dataset) => ({
					kind: "dataset",
					name: dataset.name,
					note: "stays, with the rows it has now, and can no longer be refreshed",
				})),
			});
		}

		case "sync": {
			const id = Number(ref);
			if (!Number.isInteger(id) || id <= 0) throw new BadRequest(`'${ref}' is not a sync's id.`);
			await assertSyncInSpace(id, currentSpace());
			const owner = await queryOne<{ resource_id: string }>(
				"SELECT resource_id::text FROM platform.connection_sync WHERE sync_id = $1",
				[id],
			);
			const sync = owner ? (await listSyncs(Number(owner.resource_id))).find((entry) => Number(entry.id) === id) : null;
			if (!sync) throw new NotFound(`No sync ${id} in this space.`);
			const dataset =
				sync.datasetResourceId === null
					? null
					: await queryOne<{ name: string }>("SELECT name FROM platform.resource WHERE resource_id = $1", [
							sync.datasetResourceId,
						]);
			const ran = await queryOne<{ n: string }>(
				"SELECT count(*)::text AS n FROM platform.connection_sync_run WHERE sync_id = $1",
				[id],
			);
			const runs = Number(ran?.n ?? 0);
			return plan(`${sync.sourceSchema}.${sync.sourceTable}`, {
				removes: [
					...(sync.schedule
						? [{ kind: "schedule", name: `its schedule (${describeInterval(sync.schedule.intervalSeconds)})` }]
						: []),
					...(runs > 0 ? [{ kind: "runs", name: countOf(runs, "recorded run") }] : []),
				],
				affects: dataset
					? [{ kind: "dataset", name: dataset.name, note: "stays, with the rows it has now, and can no longer be refreshed" }]
					: [],
			});
		}

		case "schedule": {
			const id = Number(ref);
			if (!Number.isInteger(id) || id <= 0) throw new BadRequest(`'${ref}' is not a schedule's id.`);
			const schedule = await getSchedule(id, currentSpace());
			return plan(schedule.name, {
				affects: [
					{
						kind: "sync",
						name: schedule.name,
						note: "stays, and runs only when someone starts it",
					},
				],
			});
		}

		case "dataset": {
			const resource = await resourceRow(ref, "dataset");
			const parts = await datasetParts(resource);
			const registry = hasOntology(currentSpace()) ? getRegistry() : null;
			const relation = parts.relation;
			const direct = registry && relation ? registry.objectTypes.filter((type) => type.sourceView === relation) : [];
			// A combined dataset is a view over copied tables: it reads this one
			// without being built "on" it, and cannot outlive it either.
			const views = relation && parts.ownsTable ? await viewsReading(relation) : [];
			const combined = registry ? registry.objectTypes.filter((type) => views.includes(type.sourceView)) : [];
			const types = [...direct, ...combined.filter((type) => !direct.includes(type))];
			const unknownViews = views.filter((view) => !combined.some((type) => type.sourceView === view));
			const everyMetric = types.flatMap((type) => typeParts(type).metrics.map((kpi) => kpi.apiName));
			const functions = relation
				? (await listFunctions()).filter((fn) => fn.readsViews.includes(relation))
				: [];
			return plan(resource.name, {
				removes: [
					...(parts.ownsTable && relation
						? [{ kind: "table", name: relation, note: `the copy of the source: ${countOf(parts.rows ?? 0, "row")}` }]
						: []),
					...(parts.sync ? [syncItem(parts.sync)] : []),
				],
				dependents: types.map((type) => {
					const built = typeParts(type);
					const summary = listOf([
						[built.metrics.length, "metric"],
						[built.links.length, "link"],
						[built.actions.length, "action"],
					]);
					return {
						kind: "objectType",
						name: type.apiName,
						note: `${type.origin === "combination" ? "a combined dataset that reads it" : "built on it"}${summary ? `, with ${summary}` : ""}`,
					};
				}),
				affects: [
					...(await boardsShowing(everyMetric)),
					...functions.map((fn) => ({
						kind: "function",
						name: fn.apiName,
						note: "reads this table and will fail until its definition is changed",
					})),
				],
				refused:
					unknownViews.length > 0
						? `${unknownViews.join(", ")} ${unknownViews.length === 1 ? "reads" : "read"} this table and ${unknownViews.length === 1 ? "is" : "are"} not part of this space's model, so the table cannot be dropped from here.`
						: null,
			});
		}

		case "objectType": {
			const type = ontologyObject("object type", ref, registryOrNone().objectTypes);
			const parts = typeParts(type);
			const mentions = getRegistry().kpis.filter(
				(kpi) => kpi.objectTypeRid !== type.rid && kpi.relatedObjectTypes.includes(type.rid),
			);
			return plan(type.apiName, {
				removes: [
					{ kind: "properties", name: countOf(type.properties.length, "property", "properties") },
					...(type.origin === "combination" ? [{ kind: "view", name: type.sourceView, note: "the combined view" }] : []),
				],
				dependents: typeDependents(parts),
				affects: [
					...(await boardsShowing(parts.metrics.map((kpi) => kpi.apiName))),
					...mentions.map((kpi) => ({ kind: "metric", name: kpi.apiName, note: "names this object type and stays" })),
				],
				refused:
					type.origin === "pipeline"
						? `${type.apiName} is generated by the pipeline and is rebuilt on its next run; it cannot be deleted here.`
						: null,
			});
		}

		case "linkType": {
			const link = ontologyObject("link", ref, registryOrNone().linkTypes);
			return plan(link.apiName);
		}

		case "actionType": {
			const action = ontologyObject("action", ref, registryOrNone().actionTypes);
			return plan(action.apiName, {
				affects: [{ kind: "audit", name: "its audit trail", note: "every run already recorded is kept" }],
			});
		}

		case "metric": {
			const kpi = ontologyObject("metric", ref, registryOrNone().kpis);
			return plan(kpi.apiName, { affects: await boardsShowing([kpi.apiName]) });
		}

		case "function": {
			const fn = await getFunction(ref);
			const runs = await functionRuns(fn.apiName, 200).catch(() => []);
			return plan(fn.apiName, {
				removes:
					runs.length > 0
						? [{ kind: "runs", name: `${runs.length >= 200 ? "200 or more" : runs.length} recorded ${runs.length === 1 ? "run" : "runs"}` }]
						: [],
			});
		}

		case "dashboard": {
			const board = await getDashboard(ref, currentSpace());
			return plan(board.title);
		}

		case "proposal": {
			const id = Number(ref);
			if (!Number.isInteger(id) || id <= 0) throw new BadRequest(`'${ref}' is not a proposal's id.`);
			const proposal = await getProposal(id);
			const waiting = await proposalsWaitingOn(id);
			return plan(proposal.title, {
				affects:
					proposal.status === "applied"
						? [{ kind: "model", name: "what it added", note: "stays in your model; deleting the proposal does not undo it" }]
						: [],
				refused:
					waiting.length > 0
						? `${waiting.map((entry) => `Proposal #${entry.id} (${entry.title})`).join(", ")} ${waiting.length === 1 ? "is" : "are"} waiting on this one. Decide or delete ${waiting.length === 1 ? "it" : "them"} first.`
						: null,
			});
		}
	}
}

// ── carrying it out ─────────────────────────────────────────────────────────

async function spaceIdOf(slug: string): Promise<number> {
	const row = await queryOne<{ space_id: string }>("SELECT space_id::text FROM platform.space WHERE slug = $1", [slug]);
	if (!row) throw new NotFound(`No space '${slug}'.`);
	return Number(row.space_id);
}

/**
 * Remove an object type with everything built on it, in one transaction.
 *
 * Each thing removed is written to the change history as its own deletion, so
 * the journal reads as what happened - "metric order_count deleted" - rather
 * than as one entry for a type that says nothing of what went with it.
 */
async function removeObjectTypeDeep(type: ObjectTypeMeta, actor: string): Promise<void> {
	const parts = typeParts(type);
	const { id: versionId } = await activeVersion();
	const spaceId = await spaceIdOf(currentSpace());
	const gone: Array<{ kind: EditKind; rid: string; apiName: string }> = [
		...parts.metrics.map((kpi) => ({ kind: "metric" as const, rid: kpi.rid, apiName: kpi.apiName })),
		...parts.links.map((link) => ({ kind: "linkType" as const, rid: link.rid, apiName: link.apiName })),
		...parts.actions.map((action) => ({ kind: "actionType" as const, rid: action.rid, apiName: action.apiName })),
		{ kind: "objectType", rid: type.rid, apiName: type.apiName },
	];

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"DELETE FROM platform.kpi_definition WHERE space_id = $1 AND kpi_rid = ANY($2::text[])",
			[spaceId, parts.metrics.map((kpi) => kpi.rid)],
		);
		await client.query(
			"DELETE FROM platform.link_type WHERE ontology_version_id = $1 AND link_type_rid = ANY($2::text[])",
			[versionId, parts.links.map((link) => link.rid)],
		);
		await client.query(
			"DELETE FROM platform.action_type WHERE ontology_version_id = $1 AND action_type_rid = ANY($2::text[])",
			[versionId, parts.actions.map((action) => action.rid)],
		);
		await client.query(
			"DELETE FROM platform.object_property WHERE ontology_version_id = $1 AND object_type_rid = $2",
			[versionId, type.rid],
		);
		const removed = await client.query(
			"DELETE FROM platform.object_type WHERE ontology_version_id = $1 AND object_type_rid = $2",
			[versionId, type.rid],
		);
		if (!removed.rowCount) throw new NotFound(`No object type '${type.apiName}' in this space's ontology.`);
		if (type.origin === "combination") {
			await client.query(`DROP VIEW IF EXISTS ${quoteQualified(type.sourceView)}`);
			await client.query("DELETE FROM platform.combination WHERE space_id = $1 AND view_name = $2", [
				spaceId,
				type.sourceView,
			]);
		}
		// What was recorded about these objects no longer applies to anything.
		await client.query(
			`UPDATE platform.ontology_edit
			    SET is_active = false, withdrawn_by = $3, withdrawn_at = now()
			  WHERE space_id = $1 AND target_rid = ANY($2::text[]) AND is_active`,
			[spaceId, gone.map((entry) => entry.rid), actor],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}

	for (const entry of gone) {
		await journal(
			entry.kind,
			entry.rid,
			"delete",
			{},
			{ apiName: entry.apiName },
			actor,
			entry.rid === type.rid ? undefined : `Deleted with ${type.apiName}.`,
		);
	}
	clearColumnCache();
	await publishChange();
}

async function removeDatasetDeep(resource: ResourceRow, plan: RemovalPlan, actor: string): Promise<void> {
	const parts = await datasetParts(resource);
	// The types first: a combined dataset is a view over the table, and a
	// table cannot be dropped from under a view.
	for (const dependent of plan.dependents) {
		const type = getRegistry().objectTypeByApiName.get(dependent.name);
		if (type) await removeObjectTypeDeep(type, actor);
	}
	if (parts.sync) await deleteSync(Number(parts.sync.id));
	if (parts.ownsTable && parts.relation) {
		try {
			await query(`DROP TABLE IF EXISTS ${quoteQualified(parts.relation)}`);
		} catch (error) {
			const views = await viewsReading(parts.relation).catch(() => []);
			throw new BadRequest(
				views.length > 0
					? `${parts.relation} is still read by ${views.join(", ")}, so it could not be dropped.`
					: `${parts.relation} could not be dropped: ${(error as Error).message}`,
			);
		}
	}
	await deleteResource(Number(resource.resource_id));
	clearColumnCache();
	if (hasOntology(currentSpace())) await loadRegistry(currentSpace());
}

/**
 * Delete something, as planRemoval described it.
 *
 * Returns the plan that was carried out, so the caller can say what went.
 */
export async function removeThing(
	kind: RemovableKind,
	ref: string,
	actor: string,
	options: { cascade?: boolean } = {},
): Promise<RemovalPlan> {
	const plan = await planRemoval(kind, ref);
	if (plan.refused) throw new BadRequest(plan.refused);
	if (plan.dependents.length > 0 && !options.cascade) throw new RemovalNeedsCascade(plan);

	switch (kind) {
		case "connection": {
			const id = Number(ref);
			// Each sync through deleteSync, which takes its schedule with it; the
			// cascade from the resource row alone would leave the schedules firing.
			for (const sync of await listSyncs(id)) await deleteSync(Number(sync.id));
			await deleteResource(id);
			break;
		}
		case "sync":
			await deleteSync(Number(ref));
			break;
		case "schedule":
			await deleteSchedule(Number(ref), currentSpace());
			break;
		case "dataset":
			await removeDatasetDeep(await resourceRow(ref, "dataset"), plan, actor);
			break;
		case "objectType":
			await removeObjectTypeDeep(ontologyObject("object type", ref, getRegistry().objectTypes), actor);
			break;
		case "linkType":
		case "actionType":
		case "metric": {
			const registry = getRegistry();
			const all: Array<{ rid: string; apiName: string }> =
				kind === "linkType" ? registry.linkTypes : kind === "actionType" ? registry.actionTypes : registry.kpis;
			await deleteOntologyObject(kind as DeletableKind, ontologyObject(label(kind), ref, all).rid, actor);
			break;
		}
		case "function":
			await deleteFunction(ref);
			break;
		case "dashboard": {
			await deleteDashboard(ref, currentSpace());
			// A card pointing at it, where one was registered by hand.
			await query(
				`DELETE FROM platform.resource r USING platform.project p, platform.space s
				  WHERE p.project_id = r.project_id AND s.space_id = p.space_id
				    AND s.slug = $1 AND r.kind = 'dashboard' AND r.target_ref = $2`,
				[currentSpace(), ref],
			);
			break;
		}
		case "proposal":
			await deleteProposal(Number(ref));
			break;
	}
	return plan;
}

/** The kind and reference a workspace card stands for, to delete what is behind it. */
export async function removalTargetOf(resourceId: number): Promise<{ kind: RemovableKind; ref: string } | null> {
	const row = await queryOne<{ kind: string; target_ref: string | null }>(
		"SELECT kind, target_ref FROM platform.resource WHERE resource_id = $1",
		[resourceId],
	);
	if (!row) throw new NotFound(`No resource ${resourceId}.`);
	switch (row.kind) {
		case "connection":
		case "dataset":
			return { kind: row.kind, ref: String(resourceId) };
		case "objectType":
		case "linkType":
		case "actionType":
			return row.target_ref ? { kind: row.kind, ref: row.target_ref } : null;
		case "kpi":
			return row.target_ref ? { kind: "metric", ref: row.target_ref } : null;
		case "dashboard":
			return row.target_ref ? { kind: "dashboard", ref: row.target_ref } : null;
		default:
			return null;
	}
}
