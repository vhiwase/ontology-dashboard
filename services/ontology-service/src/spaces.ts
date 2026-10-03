/**
 * Spaces, projects, folders and resources: where things live.
 *
 * The hierarchy is space → project → folder → resource. A resource is the
 * addressable unit — a connection, a dataset, an object type, a link, an
 * action, a metric, a dashboard — and is what the UI opens in a preview window.
 *
 * Resources point at the rest of the platform by api_name or slug rather than
 * by foreign key, so a card outlives a change to what it points at rather than
 * blocking it. The cost is that a reference can go stale, so a preview reports
 * a dangling target instead of pretending it is fine. Ontology cards are kept
 * in step by definition.ts after every authoring change.
 */

import { pool, query, queryOne } from "./db";
import {
	type ConnectionSpec,
	type ConnectionTest,
	displayDsn,
	getSync,
	isPlatformWrittenRelation,
	listSyncs,
	remoteDatabaseInfo,
	specFromProperties,
	testConnection,
} from "./connections";
import {
	BadRequest,
	NotFound,
	currentSpace,
	getRegistry,
	hasOntology,
	withSpace,
} from "./registry";

export type ResourceKind =
	| "connection"
	| "dataset"
	| "objectType"
	| "linkType"
	| "actionType"
	| "kpi"
	| "dashboard";

export interface SpaceRecord {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	isSystem: boolean;
	projectCount: number;
	hasOntology: boolean;
	ontology: {
		version: string;
		objectTypes: number;
		linkTypes: number;
		actionTypes: number;
		kpis: number;
	} | null;
}

export interface ProjectRecord {
	id: number;
	spaceId: number;
	spaceSlug: string;
	slug: string;
	name: string;
	description: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	resourceCount: number;
	folderCount: number;
}

export interface FolderRecord {
	id: number;
	projectId: number;
	parentId: number | null;
	name: string;
	path: string;
}

export interface ResourceRecord {
	id: number;
	projectId: number;
	folderId: number | null;
	kind: ResourceKind;
	name: string;
	description: string | null;
	targetRef: string | null;
	/**
	 * The relation this is ultimately read from, e.g. connection_raw.<table>.
	 * Null where there is none rather than a placeholder, so the UI can show
	 * nothing instead of something misleading.
	 */
	backingView: string | null;
	properties: Record<string, unknown>;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

// ── spaces ──────────────────────────────────────────────────────────────────

export async function listSpaces(): Promise<SpaceRecord[]> {
	const rows = await query<{
		space_id: number;
		slug: string;
		name: string;
		description: string | null;
		environment: string;
		is_system: boolean;
		project_count: string;
	}>(
		`SELECT s.*, count(p.project_id)::text AS project_count
		   FROM platform.space s
		   LEFT JOIN platform.project p ON p.space_id = s.space_id
		  GROUP BY s.space_id
		  ORDER BY CASE s.environment
		             WHEN 'sandbox' THEN 1 WHEN 'development' THEN 2
		             WHEN 'staging' THEN 3 ELSE 4 END`,
	);
	return rows.map((row) => ({
		id: row.space_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		environment: row.environment,
		isSystem: row.is_system,
		projectCount: Number(row.project_count),
		// Lets the UI show an honest empty state on switching into a space that
		// nothing has been published to, rather than discovering it by way of a
		// failed request on every ontology page at once. The counts come with
		// it so the nav rail can badge the space you are actually in — it used
		// to read them from /health, which knows only one global ontology and
		// so reported the sandbox's numbers under every space.
		hasOntology: hasOntology(row.slug),
		ontology: ontologySummary(row.slug),
	}));
}

/** The headline numbers for a space's ontology, or null where it has none. */
function ontologySummary(slug: string): SpaceRecord["ontology"] {
	if (!hasOntology(slug)) return null;
	const registry = withSpace(slug, getRegistry);
	return {
		version: registry.version,
		objectTypes: registry.objectTypes.length,
		linkTypes: registry.linkTypes.length,
		actionTypes: registry.actionTypes.length,
		kpis: registry.kpis.length,
	};
}

function slugify(value: string): string {
	const slug = value
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || `item-${Date.now()}`;
}

// ── projects ────────────────────────────────────────────────────────────────

export async function listProjects(spaceSlug?: string): Promise<ProjectRecord[]> {
	const rows = await query<{
		project_id: number;
		space_id: number;
		space_slug: string;
		slug: string;
		name: string;
		description: string | null;
		created_by: string;
		created_at: Date;
		updated_at: Date;
		resource_count: string;
		folder_count: string;
	}>(
		`SELECT p.*, s.slug AS space_slug,
		        (SELECT count(*) FROM platform.resource r WHERE r.project_id = p.project_id)::text
		          AS resource_count,
		        (SELECT count(*) FROM platform.folder f WHERE f.project_id = p.project_id)::text
		          AS folder_count
		   FROM platform.project p
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE ($1::text IS NULL OR s.slug = $1)
		  ORDER BY p.updated_at DESC`,
		[spaceSlug ?? null],
	);
	return rows.map((row) => ({
		id: row.project_id,
		spaceId: row.space_id,
		spaceSlug: row.space_slug,
		slug: row.slug,
		name: row.name,
		description: row.description,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		resourceCount: Number(row.resource_count),
		folderCount: Number(row.folder_count),
	}));
}

export async function createProject(
	spaceSlug: string,
	name: string,
	description: string | null,
	createdBy: string,
): Promise<ProjectRecord> {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) throw new BadRequest("A project needs a name.");

	const space = await queryOne<{ space_id: number }>(
		"SELECT space_id FROM platform.space WHERE slug = $1",
		[spaceSlug],
	);
	if (!space) throw new NotFound(`No space '${spaceSlug}'.`);

	const slug = slugify(trimmed);
	const clash = await queryOne<{ project_id: number }>(
		"SELECT project_id FROM platform.project WHERE space_id = $1 AND slug = $2",
		[space.space_id, slug],
	);
	if (clash) {
		throw new BadRequest(`This space already has a project called '${trimmed}'.`);
	}

	await query(
		`INSERT INTO platform.project (space_id, slug, name, description, created_by)
		 VALUES ($1,$2,$3,$4,$5)`,
		[space.space_id, slug, trimmed, description ?? null, createdBy],
	);

	const created = (await listProjects(spaceSlug)).find((p) => p.slug === slug);
	if (!created) throw new BadRequest("The project could not be created.");
	return created;
}

// ── the stored password of a connection that is deleted ─────────────────────
//  A password typed into the connect form is kept in the vault, under a
//  reference only its connection holds. A connection can go three ways - by
//  itself, with its folder, with its project - and its password used to stay
//  behind each time: encrypted and unreachable, but still on the server after
//  the person had deleted what it was for. Each of the three removes it now.

/** The vault references held by the connections a condition selects. */
async function vaultRefsHeld(condition: string, parameters: unknown[]): Promise<string[]> {
	const rows = await query<{ ref: string }>(
		`SELECT r.properties->>'secretRef' AS ref
		   FROM platform.resource r
		  WHERE r.kind = 'connection' AND r.properties->>'secretRef' LIKE 'vault:%' AND ${condition}`,
		parameters,
	);
	return rows.map((row) => row.ref);
}

/**
 * Remove the stored passwords behind these references, where no connection
 * refers to one any more. Called after the delete, so "any more" is true.
 */
async function forgetCredentials(refs: string[]): Promise<void> {
	if (refs.length === 0) return;
	await query(
		`DELETE FROM platform.credential c
		  WHERE 'vault:' || c.credential_id = ANY($1::text[])
		    AND NOT EXISTS (
		          SELECT 1 FROM platform.resource r
		           WHERE r.kind = 'connection'
		             AND r.properties->>'secretRef' = 'vault:' || c.credential_id)`,
		[refs],
	);
}

export async function deleteProject(spaceSlug: string, projectSlug: string): Promise<void> {
	const refs = await vaultRefsHeld(
		`r.project_id IN (SELECT p.project_id
		                    FROM platform.project p JOIN platform.space s ON s.space_id = p.space_id
		                   WHERE s.slug = $1 AND p.slug = $2)`,
		[spaceSlug, projectSlug],
	);
	const row = await queryOne<{ project_id: number }>(
		`DELETE FROM platform.project p
		  USING platform.space s
		  WHERE p.space_id = s.space_id AND s.slug = $1 AND p.slug = $2
		RETURNING p.project_id`,
		[spaceSlug, projectSlug],
	);
	if (!row) throw new NotFound(`No project '${projectSlug}' in '${spaceSlug}'.`);
	await forgetCredentials(refs);
}

async function requireProject(
	spaceSlug: string,
	projectSlug: string,
): Promise<{ project_id: number }> {
	const row = await queryOne<{ project_id: number }>(
		`SELECT p.project_id
		   FROM platform.project p JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND p.slug = $2`,
		[spaceSlug, projectSlug],
	);
	if (!row) throw new NotFound(`No project '${projectSlug}' in space '${spaceSlug}'.`);
	return row;
}

// ── folders ─────────────────────────────────────────────────────────────────

export async function createFolder(
	spaceSlug: string,
	projectSlug: string,
	name: string,
	parentId: number | null,
	createdBy: string,
): Promise<FolderRecord> {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) throw new BadRequest("A folder needs a name.");
	if (trimmed.includes("/")) throw new BadRequest("A folder name cannot contain '/'.");

	const project = await requireProject(spaceSlug, projectSlug);

	let parentPath = "";
	if (parentId !== null) {
		const parent = await queryOne<{ path: string; project_id: number }>(
			"SELECT path, project_id FROM platform.folder WHERE folder_id = $1",
			[parentId],
		);
		if (!parent || parent.project_id !== project.project_id) {
			throw new BadRequest("The parent folder is not in this project.");
		}
		parentPath = parent.path;
	}
	const path = `${parentPath}/${trimmed}`;

	const clash = await queryOne<{ folder_id: number }>(
		"SELECT folder_id FROM platform.folder WHERE project_id = $1 AND path = $2",
		[project.project_id, path],
	);
	if (clash) throw new BadRequest(`'${path}' already exists in this project.`);

	const row = await queryOne<{
		folder_id: number;
		project_id: number;
		parent_id: number | null;
		name: string;
		path: string;
	}>(
		`INSERT INTO platform.folder (project_id, parent_id, name, path, created_by)
		 VALUES ($1,$2,$3,$4,$5) RETURNING *`,
		[project.project_id, parentId, trimmed, path, createdBy],
	);
	if (!row) throw new BadRequest("The folder could not be created.");
	return {
		id: row.folder_id,
		projectId: row.project_id,
		parentId: row.parent_id,
		name: row.name,
		path: row.path,
	};
}

export async function deleteFolder(folderId: number): Promise<void> {
	// The folder takes everything under it, however deep.
	const refs = await vaultRefsHeld(
		`r.folder_id IN (
		   WITH RECURSIVE tree AS (
		     SELECT folder_id FROM platform.folder WHERE folder_id = $1
		     UNION ALL
		     SELECT f.folder_id FROM platform.folder f JOIN tree t ON f.parent_id = t.folder_id)
		   SELECT folder_id FROM tree)`,
		[folderId],
	);
	const row = await queryOne<{ folder_id: number }>(
		"DELETE FROM platform.folder WHERE folder_id = $1 RETURNING folder_id",
		[folderId],
	);
	if (!row) throw new NotFound(`No folder ${folderId}.`);
	await forgetCredentials(refs);
}

// ── the tree ────────────────────────────────────────────────────────────────

export interface ProjectTree {
	project: ProjectRecord;
	folders: FolderRecord[];
	resources: ResourceRecord[];
}

/**
 * The relation a resource is ultimately backed by: the synced table.
 *
 * Only a dataset stores this on itself. An object type, a metric, a link and
 * an action all resolve theirs through the registry, because the ontology owns
 * that mapping and duplicating it onto the resource row would let the two
 * drift apart.
 *
 * Null where there genuinely is none - a dashboard reads many metrics - and
 * null is shown as nothing rather than as a guess.
 */
function backingViewOf(
	kind: ResourceKind,
	targetRef: string | null,
	properties: Record<string, unknown>,
): string | null {
	const declared = properties?.sourceView;
	if (typeof declared === "string" && declared) return declared;

	// A connection is resolved before the targetRef guard below, because it has
	// no target: it points at a database rather than at something in the
	// ontology, and its backing is recorded in its own properties.
	if (kind === "connection") {
		const database = properties?.database;
		if (typeof database === "string" && database) return database;
		const dsn = properties?.dsn;
		if (typeof dsn === "string") {
			const path = dsn.split("/").pop()?.split("?")[0];
			if (path) return path;
		}
		return null;
	}

	if (!targetRef) return null;
	if (!hasOntology(currentSpace())) return null;
	const registry = getRegistry();

	switch (kind) {
		case "dataset":
			// The landed table, connection_raw.<table>.
			return targetRef.includes(".") ? targetRef : null;
		case "objectType":
			return registry.objectTypeByApiName.get(targetRef)?.sourceView ?? null;
		case "kpi":
			return registry.kpiByApiName.get(targetRef)?.sourceView ?? null;
		case "linkType": {
			// A link is between two object types; the view it is resolved over is
			// the source's, which is where the foreign key lives.
			const link = registry.linkTypeByApiName.get(targetRef);
			if (!link) return null;
			return registry.objectTypeByRid.get(link.sourceObjectType)?.sourceView ?? null;
		}
		case "actionType": {
			// An action edits an object type, and targetObjectTypes holds RIDs
			// (tms:Shipment) rather than api names - the same distinction that
			// once made every object type report "0 links". Resolved by RID.
			const action = registry.actionTypeByApiName.get(targetRef);
			const firstTarget = action?.targetObjectTypes?.[0];
			if (!firstTarget) return null;
			return registry.objectTypeByRid.get(firstTarget)?.sourceView ?? null;
		}
		default:
			return null;
	}
}

function toResource(row: {
	resource_id: number;
	project_id: number;
	folder_id: number | null;
	kind: ResourceKind;
	name: string;
	description: string | null;
	target_ref: string | null;
	properties: Record<string, unknown>;
	created_by: string;
	created_at: Date;
	updated_at: Date;
}): ResourceRecord {
	return {
		id: row.resource_id,
		projectId: row.project_id,
		folderId: row.folder_id,
		kind: row.kind,
		name: row.name,
		description: row.description,
		targetRef: row.target_ref,
		backingView: backingViewOf(row.kind, row.target_ref, row.properties ?? {}),
		properties: row.properties ?? {},
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

export async function projectTree(
	spaceSlug: string,
	projectSlug: string,
): Promise<ProjectTree> {
	const project = (await listProjects(spaceSlug)).find((p) => p.slug === projectSlug);
	if (!project) throw new NotFound(`No project '${projectSlug}' in space '${spaceSlug}'.`);

	const folders = await query<{
		folder_id: number;
		project_id: number;
		parent_id: number | null;
		name: string;
		path: string;
	}>(
		"SELECT * FROM platform.folder WHERE project_id = $1 ORDER BY path",
		[project.id],
	);

	const resources = await query<Parameters<typeof toResource>[0]>(
		"SELECT * FROM platform.resource WHERE project_id = $1 ORDER BY kind, name",
		[project.id],
	);

	return {
		project,
		folders: folders.map((row) => ({
			id: row.folder_id,
			projectId: row.project_id,
			parentId: row.parent_id,
			name: row.name,
			path: row.path,
		})),
		resources: resources.map(toResource),
	};
}

// ── resources ───────────────────────────────────────────────────────────────

export interface CreateResourceRequest {
	kind: ResourceKind;
	name: string;
	description?: string | null;
	folderId?: number | null;
	targetRef?: string | null;
	properties?: Record<string, unknown>;
}

export async function createResource(
	spaceSlug: string,
	projectSlug: string,
	request: CreateResourceRequest,
	createdBy: string,
): Promise<ResourceRecord> {
	const name = String(request.name ?? "").trim();
	if (!name) throw new BadRequest("A resource needs a name.");

	const project = await requireProject(spaceSlug, projectSlug);

	const clash = await queryOne<{ resource_id: number }>(
		`SELECT resource_id FROM platform.resource
		  WHERE project_id = $1 AND folder_id IS NOT DISTINCT FROM $2 AND name = $3`,
		[project.project_id, request.folderId ?? null, name],
	);
	if (clash) throw new BadRequest(`'${name}' already exists in this folder.`);

	const row = await queryOne<Parameters<typeof toResource>[0]>(
		`INSERT INTO platform.resource
		   (project_id, folder_id, kind, name, description, target_ref, properties, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
		[
			project.project_id,
			request.folderId ?? null,
			request.kind,
			name,
			request.description ?? null,
			request.targetRef ?? null,
			JSON.stringify(request.properties ?? {}),
			createdBy,
		],
	);
	if (!row) throw new BadRequest("The resource could not be created.");
	return toResource(row);
}

export async function deleteResource(resourceId: number): Promise<void> {
	const row = await queryOne<{ resource_id: number; kind: string; properties: Record<string, unknown> | null }>(
		"DELETE FROM platform.resource WHERE resource_id = $1 RETURNING resource_id, kind, properties",
		[resourceId],
	);
	if (!row) throw new NotFound(`No resource ${resourceId}.`);
	const ref = row.kind === "connection" ? row.properties?.secretRef : null;
	if (typeof ref === "string" && ref.startsWith("vault:")) await forgetCredentials([ref]);
}

export async function renameResource(
	resourceId: number,
	name: string,
): Promise<ResourceRecord> {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) throw new BadRequest("A resource needs a name.");
	const row = await queryOne<Parameters<typeof toResource>[0]>(
		`UPDATE platform.resource SET name = $1, updated_at = now()
		  WHERE resource_id = $2 RETURNING *`,
		[trimmed, resourceId],
	);
	if (!row) throw new NotFound(`No resource ${resourceId}.`);
	return toResource(row);
}

// ── live database info ──────────────────────────────────────────────────────

export interface DatabaseInfo {
	/** The DSN with the password removed. It is never returned with one. */
	dsn: string;
	database: string;
	version: string;
	sizeBytes: number;
	sizePretty: string;
	connections: { current: number; max: number };
	schemas: Array<{
		schema: string;
		tables: number;
		views: number;
		rows: number;
		unanalysed: number;
	}>;
	collectedAt: string;
}

/** Strip the password out of a DSN before it is ever sent anywhere. */
function safeDsn(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.password) url.password = "***";
		return url.toString();
	} catch {
		// Not a URL-shaped DSN; return the scheme only rather than risk leaking
		// whatever else is in there.
		return raw.split("@").pop() ?? "(unparseable)";
	}
}

/** The DSN the pool was built from, however it was supplied. */
function rawDsn(): string {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	const path = process.env.DATABASE_URL_FILE;
	if (!path) return "";
	try {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

/**
 * The platform's own database, as a connection anyone could have registered.
 *
 * Host, port, database and user are taken from the DSN the service is already
 * using; the password is not — what is stored is the PATH of the Docker secret
 * that holds it, and only when that file is actually readable here. A
 * credential in platform.resource would be readable by anyone who can read the
 * workspace and would land in every backup.
 */
function platformConnectionProperties(): Record<string, unknown> {
	const dsn = rawDsn();
	let host = "";
	let port = 5432;
	let database = "";
	let username = "";
	try {
		const url = new URL(dsn);
		host = url.hostname;
		port = Number(url.port) || 5432;
		database = decodeURIComponent(url.pathname.replace(/^\//, ""));
		username = decodeURIComponent(url.username);
	} catch {
		return {};
	}
	if (!host) return {};

	const secretPath = "/run/secrets/postgres_password";
	let secretRef: string | null = null;
	try {
		const { accessSync } = require("node:fs") as typeof import("node:fs");
		accessSync(secretPath);
		secretRef = secretPath;
	} catch {
		// Not mounted here. The connection is still registered and still says
		// where it points; a test will say plainly that it has no credential.
		secretRef = null;
	}

	return { host, port, database, username, secretRef, sslMode: "prefer" };
}

/**
 * What the sandbox connection resource shows: the database this platform is
 * actually running against, read live rather than stored at seed time.
 */
export async function databaseInfo(): Promise<DatabaseInfo> {
	const [meta] = await query<{
		database: string;
		version: string;
		size_bytes: string;
		size_pretty: string;
	}>(
		`SELECT current_database() AS database,
		        version()          AS version,
		        pg_database_size(current_database())::text            AS size_bytes,
		        pg_size_pretty(pg_database_size(current_database()))   AS size_pretty`,
	);

	const [conns] = await query<{ current: string; max: string }>(
		`SELECT (SELECT count(*) FROM pg_stat_activity
		          WHERE datname = current_database())::text AS current,
		        current_setting('max_connections')          AS max`,
	);

	// Live row counts come from the planner's statistics rather than count(*):
	// exact counts over every table would be a table scan per table on every
	// panel open, and an estimate is the right precision for "how big is this".
	//
	// GREATEST(reltuples, 0) because Postgres stores -1 for a table that has
	// never been analysed, and summing those produced negative row counts - a
	// schema of five unanalysed tables reported "-5 rows".
	const schemas = await query<{
		schema: string;
		tables: string;
		views: string;
		rows: string;
		unanalysed: string;
	}>(
		`SELECT n.nspname AS schema,
		        count(*) FILTER (WHERE c.relkind = 'r')::text AS tables,
		        count(*) FILTER (WHERE c.relkind IN ('v','m'))::text AS views,
		        COALESCE(sum(GREATEST(c.reltuples, 0))
		                 FILTER (WHERE c.relkind = 'r'), 0)::bigint::text AS rows,
		        count(*) FILTER (WHERE c.relkind = 'r' AND c.reltuples < 0)::text AS unanalysed
		   FROM pg_class c
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
		  GROUP BY n.nspname ORDER BY n.nspname`,
	);

	return {
		dsn: safeDsn(
			process.env.DATABASE_URL ??
				(() => {
					// The DSN arrives as a Docker secret file, so read what the pool
					// was actually built from rather than an env var that is unset.
					try {
						const path = process.env.DATABASE_URL_FILE;
						if (!path) return "postgresql://…";
						// eslint-disable-next-line @typescript-eslint/no-var-requires
						const { readFileSync } = require("node:fs") as typeof import("node:fs");
						return readFileSync(path, "utf8").trim();
					} catch {
						return "postgresql://…";
					}
				})(),
		),
		database: meta?.database ?? "unknown",
		version: (meta?.version ?? "").split(" on ")[0] ?? "unknown",
		sizeBytes: Number(meta?.size_bytes ?? 0),
		sizePretty: meta?.size_pretty ?? "unknown",
		connections: {
			current: Number(conns?.current ?? 0),
			max: Number(conns?.max ?? 0),
		},
		schemas: schemas.map((row) => ({
			schema: row.schema,
			tables: Number(row.tables),
			views: Number(row.views),
			rows: Number(row.rows),
			// Tables the planner has no statistics for, so `rows` understates them.
			unanalysed: Number(row.unanalysed),
		})),
		collectedAt: new Date().toISOString(),
	};
}

// ── resource preview ────────────────────────────────────────────────────────

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
}

export interface ResourcePreview {
	resource: ResourceRecord;
	/** False when target_ref no longer resolves, which a regenerated ontology can cause. */
	resolved: boolean;
	detail: Record<string, unknown>;
	schema: ColumnInfo[];
	/** A handful of real rows, for the dataset preview tab. */
	sample: Array<Record<string, unknown>>;
	rowCount: number | null;
	lineage: LineageSide;
}

export interface LineageEntry {
	/** What this is, so the UI can show the right glyph and offer a preview. */
	kind: ResourceKind | "view" | "connection";
	name: string;
	/** How it relates: "backed by", "produces", "used by" … */
	relation: string;
	detail?: string | null;
}

export interface LineageSide {
	upstream: LineageEntry[];
	downstream: LineageEntry[];
}

/** An object type RID resolved to its api name, falling back to the RID. */
function ridToApiName(
	registry: ReturnType<typeof getRegistry>,
	rid: string,
): string {
	return registry.objectTypes.find((type) => type.rid === rid)?.apiName ?? rid;
}

/** Columns of a view or table, from the catalogue rather than by guessing. */
async function columnsOf(qualified: string): Promise<ColumnInfo[]> {
	const [schema, name] = qualified.includes(".")
		? qualified.split(".")
		: ["public", qualified];
	const rows = await query<{ column_name: string; data_type: string; is_nullable: string }>(
		`SELECT column_name, data_type, is_nullable
		   FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2
		  ORDER BY ordinal_position`,
		[schema, name],
	);
	return rows.map((row) => ({
		name: row.column_name,
		type: row.data_type,
		nullable: row.is_nullable === "YES",
	}));
}

/**
 * A few rows from a view, for the preview tab.
 *
 * The view name is validated against the published ontology before it is
 * interpolated: it comes from a resource someone created, and a resource is
 * user input however ordinary it looks.
 */
async function sampleOf(
	qualified: string,
	limit: number,
): Promise<{ rows: Array<Record<string, unknown>>; total: number | null }> {
	// Two ways a relation earns the right to be read here: an object type or a
	// metric is built on it, or a sync landed it.
	const known = hasOntology(currentSpace())
		? (() => {
				const registry = getRegistry();
				return (
					registry.objectTypes.some((type) => type.sourceView === qualified) ||
					registry.kpis.some((kpi) => kpi.sourceView === qualified)
				);
			})()
		: false;
	if (!known && !(await isPlatformWrittenRelation(qualified))) return { rows: [], total: null };

	for (const part of qualified.split(".")) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) return { rows: [], total: null };
	}
	const quoted = qualified.split(".").map((part) => `"${part}"`).join(".");
	const bounded = Math.min(Math.max(1, limit), 50);

	const rows = await query<Record<string, unknown>>(
		`SELECT * FROM ${quoted} LIMIT ${bounded}`,
	);
	const [count] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoted}`);
	return { rows, total: Number(count?.n ?? 0) };
}

export async function previewResource(resourceId: number): Promise<ResourcePreview> {
	const row = await queryOne<Parameters<typeof toResource>[0]>(
		"SELECT * FROM platform.resource WHERE resource_id = $1",
		[resourceId],
	);
	if (!row) throw new NotFound(`No resource ${resourceId}.`);
	const resource = toResource(row);

	const registry = getRegistry();
	const empty: ResourcePreview = {
		resource,
		resolved: true,
		detail: {},
		schema: [],
		sample: [],
		rowCount: null,
		lineage: { upstream: [], downstream: [] },
	};

	switch (resource.kind) {
		case "connection": {
			// The syncs are this connection's downstream: they are the only way
			// anything crosses it, and a connection with none is the state the
			// preview should make obvious rather than hide.
			const syncs = await listSyncs(resource.id);
			return {
				...empty,
				detail: {
					...(await connectionDetail(resource.name, resource.properties)),
					syncCount: syncs.length,
					lastTest: resource.properties.lastTest ?? null,
				},
				lineage: {
					upstream: [],
					downstream: syncs.map((sync) => ({
						kind: "dataset" as const,
						name: sync.targetTable,
						relation: "synced as",
						detail:
							`${sync.sourceSchema}.${sync.sourceTable}` +
							(sync.lastRun
								? ` · ${sync.lastRun.status}, ${sync.lastRun.rowsAfter ?? 0} rows`
								: " · never run"),
					})),
				},
			};
		}

		case "dataset": {
			const view = String(resource.properties.sourceView ?? "");
			const schema = view ? await columnsOf(view) : [];
			const { rows, total } = view ? await sampleOf(view, 12) : { rows: [], total: null };
			const syncId = resource.properties.syncId;
			const sync = syncId === undefined ? null : await getSync(Number(syncId)).catch(() => null);
			// The object types built on this dataset are its downstream.
			const downstream: LineageEntry[] = registry.objectTypes
				.filter((type) => type.sourceView === view)
				.map((type) => ({
					kind: "objectType" as const,
					name: type.apiName,
					relation: "modelled as",
					detail: `${type.rowCount.toLocaleString("en-US")} objects`,
				}));
			return {
				...empty,
				resolved: schema.length > 0,
				detail: {
					sourceView: view,
					source: resource.properties.source ?? null,
					connection: resource.properties.connectionName ?? null,
					lastSyncedAt: resource.properties.lastSyncedAt ?? null,
					syncId: sync?.id ?? null,
					schedule: sync?.schedule ?? null,
					lastRun: sync?.lastRun ?? null,
				},
				schema,
				sample: rows,
				rowCount: total,
				lineage: {
					upstream: sync
						? [
								{
									kind: "connection" as const,
									name: sync.connectionName,
									relation: "read from",
									detail: "PostgreSQL",
								},
								{
									kind: "view" as const,
									name: `${sync.sourceSchema}.${sync.sourceTable}`,
									relation: "synced as it is",
									detail: sync.schedule ? `every ${sync.schedule.intervalSeconds}s` : "on demand",
								},
							]
						: [],
					downstream,
				},
			};
		}

		case "objectType": {
			const type = registry.objectTypes.find((t) => t.apiName === resource.targetRef);
			if (!type) return { ...empty, resolved: false };
			// Compared against the RID, not the api name: LinkTypeMeta holds
			// sourceObjectType as "tms:Order" while apiName is "Order", so the
			// api-name comparison matched nothing and every object type reported
			// "0 links" however many it really had.
			const links = registry.linkTypes.filter(
				(link) => link.sourceObjectType === type.rid || link.targetObjectType === type.rid,
			);
			const actions = registry.actionTypes.filter((action) =>
				action.targetObjectTypes.includes(type.rid),
			);
			return {
				...empty,
				detail: {
					apiName: type.apiName,
					label: type.label,
					group: type.group,
					description: type.description,
					sourceView: type.sourceView,
					primaryKey: type.primaryKeyColumn,
					titleColumn: type.titleColumn,
					propertyCount: type.properties.length,
					linkCount: links.length,
					actionCount: actions.length,
				},
				schema: type.properties.map((property) => ({
					name: property.apiName,
					type: property.datatype,
					nullable: property.isNullable,
				})),
				rowCount: type.rowCount,
				lineage: {
					upstream: [
						{ kind: "dataset" as const, name: type.sourceView, relation: "created from" },
					],
					downstream: [
						...links.map((link) => ({
							kind: "linkType" as const,
							name: link.apiName,
							relation: "links to",
							detail: `${ridToApiName(registry, link.sourceObjectType)} → ${ridToApiName(
								registry,
								link.targetObjectType,
							)} (${link.cardinality})`,
						})),
						...actions.map((action) => ({
							kind: "actionType" as const,
							name: action.apiName,
							relation: action.isReadOnly ? "read by" : "mutated by",
							detail: action.label,
						})),
					],
				},
			};
		}

		case "linkType": {
			const link = registry.linkTypes.find((l) => l.apiName === resource.targetRef);
			if (!link) return { ...empty, resolved: false };
			return {
				...empty,
				detail: {
					apiName: link.apiName,
					label: link.label,
					// Resolved from RID to api name, so the window reads
					// "Order -> Shipment" rather than "tms:Order -> tms:Shipment".
					source: ridToApiName(registry, link.sourceObjectType),
					target: ridToApiName(registry, link.targetObjectType),
					sourceColumn: link.sourceColumn,
					targetColumn: link.targetColumn,
					cardinality: link.cardinality,
					matchRatio: link.matchRatio,
					matchedRows: link.matchedRows,
					candidateRows: link.candidateRows,
					isVerified: link.isVerified,
					discoveryMethod: link.discoveryMethod,
				},
				lineage: {
					upstream: [
						{
							kind: "objectType" as const,
							name: ridToApiName(registry, link.sourceObjectType),
							relation: "from",
							detail: link.sourceColumn,
						},
					],
					downstream: [
						{
							kind: "objectType" as const,
							name: ridToApiName(registry, link.targetObjectType),
							relation: "to",
							detail: link.targetColumn,
						},
					],
				},
			};
		}

		case "actionType": {
			const action = registry.actionTypes.find((a) => a.apiName === resource.targetRef);
			if (!action) return { ...empty, resolved: false };
			const targets = registry.objectTypes
				.filter((type) => action.targetObjectTypes.includes(type.rid))
				.map((type) => type.apiName);
			return {
				...empty,
				detail: {
					apiName: action.apiName,
					label: action.label,
					description: action.description,
					isReadOnly: action.isReadOnly,
					requiresApproval: action.requiresApproval,
					allowedRoles: action.allowedRoles,
					parameters: action.parameters,
					targetObjectTypes: targets,
				},
				lineage: {
					upstream: targets.map((name) => ({
						kind: "objectType" as const,
						name,
						relation: "acts on",
					})),
					downstream: action.isReadOnly
						? []
						: [
								{
									kind: "dataset" as const,
									name: "action_audit",
									relation: "records to",
									detail: "every apply writes an audit row",
								},
							],
				},
			};
		}

		case "kpi": {
			const kpi = registry.kpis.find((k) => k.apiName === resource.targetRef);
			if (!kpi) return { ...empty, resolved: false };
			return {
				...empty,
				detail: {
					apiName: kpi.apiName,
					label: kpi.label,
					category: kpi.category,
					description: kpi.description,
					businessQuestion: kpi.businessQuestion,
					unit: kpi.unit,
					aggregation: kpi.aggregation,
					sourceView: kpi.sourceView,
					dimensions: kpi.dimensions,
					dependsOnSimulation: kpi.dependsOnSimulation,
				},
				lineage: {
					upstream: [{ kind: "view" as const, name: kpi.sourceView, relation: "computed from" }],
					downstream: [],
				},
			};
		}

		case "dashboard": {
			const dashboard = await queryOne<{
				slug: string;
				title: string;
				description: string | null;
				layout: unknown[];
				is_ai_generated: boolean;
				updated_at: Date;
			}>("SELECT * FROM platform.dashboard WHERE slug = $1", [resource.targetRef]);
			if (!dashboard) return { ...empty, resolved: false };

			// A dashboard's lineage is its widgets' metrics, and the datasets those
			// are computed from: "where did this number come from" is the question
			// a dashboard most invites.
			const widgets = Array.isArray(dashboard.layout) ? dashboard.layout : [];
			const referenced = [
				...new Set(
					widgets
						.map((widget) => String((widget as { kpi?: unknown }).kpi ?? ""))
						.filter(Boolean),
				),
			];

			const kpiEntries: LineageEntry[] = referenced.map((apiName) => {
				const kpi = registry.kpis.find((k) => k.apiName === apiName);
				return {
					kind: "kpi" as const,
					name: apiName,
					relation: "shows",
					detail: kpi ? kpi.label : "not in the current catalogue",
				};
			});

			// The distinct views behind those metrics, which is where the numbers
			// actually come from.
			const viewEntries: LineageEntry[] = [
				...new Set(
					referenced
						.map((apiName) => registry.kpis.find((k) => k.apiName === apiName)?.sourceView)
						.filter((view): view is string => Boolean(view)),
				),
			].map((view) => ({ kind: "view" as const, name: view, relation: "computed from" }));

			return {
				...empty,
				detail: {
					slug: dashboard.slug,
					title: dashboard.title,
					description: dashboard.description,
					widgets: widgets.length,
					metrics: referenced.length,
					isAiGenerated: dashboard.is_ai_generated,
					updatedAt: dashboard.updated_at.toISOString(),
				},
				lineage: {
					upstream: [...viewEntries, ...kpiEntries],
					downstream: [],
				},
			};
		}

		default:
			return empty;
	}
}

/**
 * Set the sandbox up for the flow: a project with /Connections, /Datasets,
 * /Ontology and /Outputs, and the platform's own database registered as a
 * connection, so its tms_views can be synced straight away.
 *
 * Idempotent: it adds only what is missing, so it runs on every boot. Datasets
 * are not seeded: a dataset is what a sync lands, so they appear when one runs.
 *
 * The connection is part of the first setup, not something kept in place: it
 * is added together with its /Connections folder and not again. It used to be
 * added whenever the sandbox had none, so deleting it lasted until the next
 * restart, when it came back without its syncs. `restore` asks for it back on
 * purpose - the "set up the sandbox" button.
 */
export async function seedSandbox(
	createdBy = "system",
	options: { restore?: boolean } = {},
): Promise<{ created: boolean; added: number }> {
	const existing = await listProjects("sandbox");
	const hadProject = existing.length > 0;

	const project = hadProject
		? (existing.find((p) => p.slug === "tms-platform") ?? existing[0])
		: await createProject(
				"sandbox",
				"TMS Platform",
				"Connections, the datasets they sync, and the ontology built on them.",
				createdBy,
			);
	if (!project) throw new BadRequest("The sandbox project could not be resolved.");

	let added = 0;
	let firstSetup = !hadProject;
	const ensureFolder = async (name: string) => {
		const found = await queryOne<{ folder_id: number }>(
			"SELECT folder_id FROM platform.folder WHERE project_id = $1 AND path = $2",
			[project.id, `/${name}`],
		);
		if (found) return Number(found.folder_id);
		added += 1;
		// The folder the connection lives in is made on the first setup only,
		// so making it now means this is that setup.
		if (name === "Connections") firstSetup = true;
		return (await createFolder("sandbox", project.slug, name, null, createdBy)).id;
	};

	const connections = await ensureFolder("Connections");
	await ensureFolder("Datasets");
	await ensureFolder("Ontology");
	await ensureFolder("Outputs");

	const hasConnection = await queryOne(
		"SELECT 1 FROM platform.resource WHERE project_id = $1 AND kind = 'connection'",
		[project.id],
	);
	if (!hasConnection && (firstSetup || options.restore)) {
		const info = await databaseInfo();
		await createResource(
			"sandbox",
			project.slug,
			{
				kind: "connection",
				name: info.database,
				description:
					"PostgreSQL: the TMS database this platform runs beside. Its tms_views " +
					"schema presents the captured TMS data as views.",
				folderId: connections,
				targetRef: null,
				// Host, user and the credential REFERENCE, so it can be tested and
				// synced through like any other connection.
				properties: {
					engine: "PostgreSQL",
					connector: "PostgreSQL",
					dsn: info.dsn,
					...platformConnectionProperties(),
				},
			},
			createdBy,
		);
		added += 1;
	}

	return { created: !hadProject, added };
}

/**
 * Every connection in a space, whichever project holds it, with how many
 * syncs pull through it. What the Connections page and the assistant list.
 */
export async function listConnections(spaceSlug = currentSpace()): Promise<
	Array<ResourceRecord & { syncCount: number; projectSlug: string }>
> {
	const rows = await query<Parameters<typeof toResource>[0] & { sync_count: string; project_slug: string }>(
		`SELECT r.*, p.slug AS project_slug,
		        (SELECT count(*) FROM platform.connection_sync cs WHERE cs.resource_id = r.resource_id)::text
		          AS sync_count
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND r.kind = 'connection'
		  ORDER BY r.name`,
		[spaceSlug],
	);
	return rows.map((row) => ({
		...toResource(row),
		syncCount: Number(row.sync_count),
		projectSlug: row.project_slug,
	}));
}

/** Kept so the pool is reachable for a health probe without another import. */
export const _pool = pool;


/**
 * Find the resource that represents something the caller already knows by
 * api_name or slug.
 *
 * This is what lets any page open the preview window for a thing it is already
 * showing — a row in the object explorer, a chip in an assistant answer —
 * without that page having to load and walk the whole resource tree to find
 * the matching id.
 *
 * Returns null rather than throwing when nothing matches: a reference to
 * an object type that was never registered as a resource is an ordinary state,
 * not an error, and the caller simply does not offer the preview.
 */
export async function lookupResource(
	kind: string,
	targetRef: string,
	spaceSlug?: string,
): Promise<ResourceRecord | null> {
	if (!kind || !targetRef) return null;
	const row = await queryOne<Parameters<typeof toResource>[0]>(
		`SELECT r.*
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space   s ON s.space_id   = p.space_id
		  WHERE r.kind = $1
		    -- A dataset is also found by its name (v_order), which is how people
		    -- and the assistant refer to it, not only by connection_raw.<table>.
		    AND (r.target_ref = $2 OR (r.kind = 'dataset' AND r.name = $2))
		    AND ($3::text IS NULL OR s.slug = $3)
		  ORDER BY (s.slug = 'sandbox') DESC, (r.target_ref = $2) DESC, r.resource_id
		  LIMIT 1`,
		[kind, targetRef, spaceSlug ?? null],
	);
	return row ? toResource(row) : null;
}

// ── connections ─────────────────────────────────────────────────────────────
//
//  Registering one is resource work and lives here; everything that reaches
//  the far side — testing, the catalogue, and the syncs that bring rows across
//  — lives in connections.ts. The dependency runs one way, spaces → connections,
//  so a connection can be previewed without connections.ts needing to know what
//  a project is.

/** Create a connection resource, testing it first so it is never stored blind. */
export async function createConnection(
	spaceSlug: string,
	projectSlug: string,
	spec: ConnectionSpec,
	createdBy: string,
): Promise<{ resource: ResourceRecord; test: ConnectionTest }> {
	if (!spec.name?.trim()) throw new BadRequest("A connection needs a name.");

	if (!spec.host?.trim()) throw new BadRequest("A connection needs a host.");
	if (!spec.database?.trim()) throw new BadRequest("A connection needs a database.");
	if (!spec.username?.trim()) throw new BadRequest("A connection needs a username.");

	const port = Number(spec.port) || 5432;
	const normalised: ConnectionSpec = { ...spec, port, host: spec.host.trim() };
	const properties = {
		engine: "PostgreSQL",
		connector: "PostgreSQL",
		host: normalised.host,
		port,
		database: normalised.database,
		username: normalised.username,
		// The reference, never the credential.
		secretRef: normalised.secretRef ?? null,
		sslMode: normalised.sslMode ?? "prefer",
		dsn: displayDsn(normalised),
	};

	// Tested before it is stored, so a wrong host or an unreadable secret is
	// found now rather than by whoever tries to sync.
	const test = await testConnection(normalised);

	const resource = await createResource(
		spaceSlug,
		projectSlug,
		{
			kind: "connection",
			name: normalised.name.trim(),
			description: normalised.description ?? `PostgreSQL at ${normalised.host}:${normalised.port}`,
			folderId: normalised.folderId ?? null,
			targetRef: null,
			properties: { ...properties, lastTest: test },
		},
		createdBy,
	);

	return { resource, test };
}

/** Re-test a stored connection and record the outcome on it. */
export async function retestConnection(resourceId: number): Promise<ConnectionTest> {
	const row = await queryOne<Parameters<typeof toResource>[0]>(
		"SELECT * FROM platform.resource WHERE resource_id = $1 AND kind = 'connection'",
		[resourceId],
	);
	if (!row) throw new NotFound(`No connection resource ${resourceId}.`);

	const spec = specFromProperties(row.name, row.properties ?? {});
	// A connection with no host describes the database this service is already
	// using, and has nothing of its own to dial.
	if (!spec) {
		const info = await databaseInfo();
		return {
			ok: true,
			latencyMs: 0,
			detail: "This is the platform's own database, already connected.",
			serverVersion: info.version,
			testedAt: new Date().toISOString(),
		};
	}

	const test = await testConnection(spec);

	await query(
		`UPDATE platform.resource
		    SET properties = jsonb_set(properties, '{lastTest}', $1::jsonb, true),
		        updated_at = now()
		  WHERE resource_id = $2`,
		[JSON.stringify(test), resourceId],
	);

	return test;
}

/**
 * The live detail behind a connection: what the database it points at reports
 * about itself.
 *
 * Asked of the host the connection names. The preview used to answer with
 * databaseInfo() whatever the connection pointed at, so a source on another
 * machine was described with this platform's own version, size and schema
 * list — a wrong answer that looked exactly like a right one.
 */
async function connectionDetail(
	name: string,
	properties: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const spec = specFromProperties(name, properties);
	if (!spec) return { ...(await databaseInfo()), isPlatformDatabase: true };

	try {
		const info = await remoteDatabaseInfo(spec);
		return {
			...info,
			host: spec.host,
			port: spec.port,
			username: spec.username,
			sslMode: spec.sslMode,
			secretRef: spec.secretRef,
			dsn: displayDsn(spec),
			isPlatformDatabase: false,
		};
	} catch (error) {
		// A source that is down is a normal state for a preview to report, and
		// it is not the same as a resource that no longer resolves.
		return {
			host: spec.host,
			port: spec.port,
			database: spec.database,
			username: spec.username,
			sslMode: spec.sslMode,
			secretRef: spec.secretRef,
			dsn: displayDsn(spec),
			isPlatformDatabase: false,
			unreachable: (error as Error).message,
		};
	}
}

