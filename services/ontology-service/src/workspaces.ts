/**
 * Workspaces: which space a request is about, and whether the caller may be
 * there at all.
 *
 * Every space used to be visible to every user, because the platform was one
 * team's tool. A person who registers now gets a PERSONAL workspace of their
 * own - their connections, synced tables, ontology, metrics, dashboards,
 * reports and conversations - which nobody else can open (administrators
 * aside). The shared environment spaces (sandbox, development, staging,
 * production) stay as they were for accounts an administrator created, and a
 * self-registered account sees one only once it has been added as a member.
 *
 * The space is resolved ONCE per request, by the middleware below, and pushed
 * into the request's `space` query parameter as well as the AsyncLocalStorage
 * context the registry reads. Routes written before this module treated the
 * space as optional and, without one, queried every space at once; resolving
 * it here means each of them is scoped without being rewritten, and a route
 * added later is scoped by default.
 *
 * Asking for a space you cannot open answers 404, not 403: whether another
 * person's workspace exists is itself something not to reveal.
 */

import type { NextFunction, Request, Response } from "express";
import type { Principal, SpaceAccess } from "./auth";
import { pool, query, queryOne } from "./db";
import { NotFound, reloadSpace, withSpace } from "./registry";

export interface SpaceInfo {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	kind: "environment" | "personal";
	ownerUsername: string | null;
}

type SpaceRow = {
	space_id: string | number;
	slug: string;
	name: string;
	description: string | null;
	environment: string;
	kind: "environment" | "personal" | null;
	owner_username: string | null;
};

function toInfo(row: SpaceRow): SpaceInfo {
	return {
		id: Number(row.space_id),
		slug: row.slug,
		name: row.name,
		description: row.description,
		environment: row.environment,
		kind: row.kind ?? "environment",
		ownerUsername: row.owner_username,
	};
}

// The space table is small and changes rarely: a few environment spaces plus
// one per user. Cached, and invalidated whenever this module writes to it.
let cache: Map<string, SpaceInfo> | null = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

export function invalidateSpaceCache(): void {
	cache = null;
}

async function spaces(): Promise<Map<string, SpaceInfo>> {
	if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
	const rows = await query<SpaceRow>(
		"SELECT space_id, slug, name, description, environment, kind, owner_username FROM platform.space",
	);
	cache = new Map(rows.map((row) => [row.slug, toInfo(row)]));
	cachedAt = Date.now();
	return cache;
}

export async function spaceBySlug(slug: string): Promise<SpaceInfo | null> {
	const found = (await spaces()).get(slug);
	if (found) return found;
	// A space created by another replica since the cache was filled.
	const row = await queryOne<SpaceRow>(
		"SELECT space_id, slug, name, description, environment, kind, owner_username FROM platform.space WHERE slug = $1",
		[slug],
	);
	if (!row) return null;
	invalidateSpaceCache();
	return toInfo(row);
}

async function memberRole(spaceId: number, username: string): Promise<"viewer" | "editor" | null> {
	const row = await queryOne<{ role: "viewer" | "editor" }>(
		"SELECT role FROM platform.space_member WHERE space_id = $1 AND username = $2",
		[spaceId, username],
	);
	return row?.role ?? null;
}

/** The caller's standing in a space, or null when they may not open it. */
export async function accessFor(principal: Principal, space: SpaceInfo): Promise<SpaceAccess | null> {
	if (space.kind === "personal") {
		const isOwner = space.ownerUsername === principal.username;
		if (!isOwner && principal.role !== "admin") return null;
		return { slug: space.slug, kind: "personal", isOwner, memberRole: null };
	}
	const role = principal.signupSource === "self" ? await memberRole(space.id, principal.username) : null;
	if (principal.signupSource === "self" && principal.role !== "admin" && role === null) return null;
	return { slug: space.slug, kind: "environment", isOwner: false, memberRole: role };
}

/** Every space the caller may open: their own workspace first. */
export async function accessibleSpaces(principal: Principal): Promise<SpaceInfo[]> {
	const all = [...(await spaces()).values()];
	const visible: SpaceInfo[] = [];
	for (const space of all) {
		if (space.kind === "personal" && space.ownerUsername !== principal.username) {
			// Administrators can open any workspace by slug, but listing every
			// user's workspace in their switcher would bury the shared ones.
			continue;
		}
		if (await accessFor(principal, space)) visible.push(space);
	}
	const order = (space: SpaceInfo) =>
		space.kind === "personal"
			? 0
			: ({ sandbox: 1, development: 2, staging: 3, production: 4 } as Record<string, number>)[space.environment] ?? 5;
	return visible.sort((a, b) => order(a) - order(b));
}

/** A slug for someone's workspace that no other space already uses. */
async function personalSlug(username: string): Promise<string> {
	const base = `u-${username.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 50);
	let candidate = base;
	for (let n = 2; await spaceBySlug(candidate); n += 1) candidate = `${base}-${n}`;
	return candidate;
}

/**
 * The ontology a new workspace starts with: valid, and empty.
 *
 * Roles are copied from an existing ontology when there is one, because a
 * user's ontology_role has to resolve against the roles of the ontology in
 * scope for the action layer to work in their workspace.
 */
async function emptyDefinition(): Promise<Record<string, unknown>> {
	const donor = await queryOne<{ roles: unknown }>(
		`SELECT definition->'roles' AS roles FROM platform.ontology_version
		  WHERE is_active AND jsonb_typeof(definition->'roles') = 'array'
		  ORDER BY ontology_version_id LIMIT 1`,
	);
	const roles = Array.isArray(donor?.roles)
		? donor.roles
		: [
				{
					"@id": "tms:AdminRole",
					"@type": "Role",
					label: { en: "Administrator" },
					rules: [
						{ resource: "objectType", resourceRef: "*", permissions: ["view", "create", "edit", "delete", "export"] },
						{ resource: "actionType", resourceRef: "*", permissions: ["view", "execute"] },
					],
				},
				{
					"@id": "tms:AnalystRole",
					"@type": "Role",
					label: { en: "Analyst" },
					rules: [{ resource: "objectType", resourceRef: "*", permissions: ["view", "export"] }],
				},
			];
	return {
		"@context": {
			ontograph: "https://ontograph.dev/schema#",
			ws: "https://ontograph.dev/workspace#",
			xsd: "http://www.w3.org/2001/XMLSchema#",
		},
		"@id": "ws:Workspace",
		"@type": "Ontology",
		version: "1.0.0",
		label: { en: "Workspace ontology" },
		description: {
			en: "Object types, links and metrics modelled from the tables connected to this workspace. It starts empty: nothing here is generated.",
		},
		entityTypes: [],
		eventTypes: [],
		relationTypes: [],
		valueTypes: [],
		attributes: [],
		constraints: [],
		interfaces: [],
		views: [],
		actionTypes: [],
		logicRules: [],
		roles,
	};
}

/** Publish an empty ontology into a space that has none active. */
export async function ensureSpaceOntology(spaceId: number, createdBy: string): Promise<void> {
	const active = await queryOne<{ id: string }>(
		"SELECT ontology_version_id::text AS id FROM platform.ontology_version WHERE space_id = $1 AND is_active",
		[spaceId],
	);
	if (active) return;
	const definition = await emptyDefinition();
	await query(
		`INSERT INTO platform.ontology_version
		   (space_id, version, ontology_id, label, description, definition, validation,
		    object_type_count, link_type_count, action_type_count, is_active, created_by)
		 VALUES ($1, '1.0.0', 'ws:Workspace', 'Workspace ontology', $2, $3::jsonb, $4::jsonb, 0, 0, 0, true, $5)
		 ON CONFLICT DO NOTHING`,
		[
			spaceId,
			(definition.description as { en: string }).en,
			JSON.stringify(definition),
			JSON.stringify({ valid: true, errors: [], warnings: [], note: "empty workspace" }),
			createdBy,
		],
	);
}

/** The default project resources are created in when none is named. */
export const WORKSPACE_PROJECT = "workspace";

/**
 * The caller's personal workspace, created on first use.
 *
 * Lazy rather than only at registration so that accounts which existed before
 * workspaces - and accounts an administrator creates from the command line -
 * get one the first time they sign in, without a backfill.
 */
export async function ensurePersonalSpace(principal: Pick<Principal, "username">): Promise<SpaceInfo> {
	const existing = await queryOne<SpaceRow>(
		`SELECT space_id, slug, name, description, environment, kind, owner_username
		   FROM platform.space WHERE kind = 'personal' AND owner_username = $1`,
		[principal.username],
	);
	let space: SpaceInfo;
	if (existing) {
		space = toInfo(existing);
	} else {
		const slug = await personalSlug(principal.username);
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			const inserted = await client.query<SpaceRow>(
				`INSERT INTO platform.space
				   (slug, name, description, environment, is_system, created_by, kind, owner_username)
				 VALUES ($1, $2, $3, 'sandbox', false, $4, 'personal', $4)
				 ON CONFLICT DO NOTHING
				 RETURNING space_id, slug, name, description, environment, kind, owner_username`,
				[
					slug,
					`${principal.username}'s workspace`,
					"Your private workspace: the tables you connect, the ontology modelled from them, and every metric, dashboard and report built on it. Nobody else can open it.",
					principal.username,
				],
			);
			let row = inserted.rows[0];
			if (!row) {
				// Another request created it between the SELECT and the INSERT.
				const again = await client.query<SpaceRow>(
					`SELECT space_id, slug, name, description, environment, kind, owner_username
					   FROM platform.space WHERE kind = 'personal' AND owner_username = $1`,
					[principal.username],
				);
				row = again.rows[0];
			}
			if (!row) throw new Error("Could not create a personal workspace.");
			await client.query(
				`INSERT INTO platform.project (space_id, slug, name, description, created_by)
				 VALUES ($1, $2, 'My workspace', 'Connections, datasets and outputs in this workspace.', $3)
				 ON CONFLICT (space_id, slug) DO NOTHING`,
				[row.space_id, WORKSPACE_PROJECT, principal.username],
			);
			await client.query("COMMIT");
			space = toInfo(row);
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
		invalidateSpaceCache();
	}
	await ensureSpaceOntology(space.id, principal.username);
	await reloadSpace(space.slug);
	return space;
}

/** Where a request with no ?space= goes: the caller's own workspace. */
export async function defaultSpaceFor(principal: Principal): Promise<SpaceInfo> {
	return ensurePersonalSpace(principal);
}

/**
 * Resolve and authorise the space for every /api request.
 *
 * Mounted after authentication and before the role check, which needs to
 * know whether the caller owns the space.
 */
export function spaceScope() {
	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		try {
			const principal = req.principal;
			if (!principal) {
				res.status(401).json({ error: "Authentication required." });
				return;
			}
			// A route that names its space in the path acts on THAT space, so the
			// path wins over ?space=. Otherwise the role check would run against
			// one space (say the caller's own workspace, where they are the
			// owner) while the route wrote to another.
			const inPath = /^\/spaces\/([^/]+)\/(projects|members)(\/|$)/.exec(req.path)?.[1];
			const requested = inPath
				? decodeURIComponent(inPath)
				: typeof req.query.space === "string"
					? req.query.space.trim()
					: "";
			const space = requested ? await spaceBySlug(requested) : await defaultSpaceFor(principal);
			const access = space ? await accessFor(principal, space) : null;
			if (!space || !access) {
				res.status(404).json({ error: `No space '${requested}'.` });
				return;
			}
			req.spaceAccess = access;
			// Routes written before workspaces read the space from the query
			// string and, without one, queried every space. Writing the resolved
			// slug back means they are all scoped without being rewritten.
			(req.query as Record<string, unknown>).space = space.slug;
			withSpace(space.slug, next);
		} catch (error) {
			next(error);
		}
	};
}

// ── ownership checks for routes addressed by id ─────────────────────────────

/**
 * The space a resource belongs to. Resource, sync and folder routes are
 * addressed by a global id, so the id alone would let a caller reach into a
 * workspace that is not theirs; every such route checks this first.
 */
export async function assertResourceInSpace(resourceId: number, spaceSlug: string): Promise<void> {
	const row = await queryOne<{ slug: string }>(
		`SELECT s.slug FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE r.resource_id = $1`,
		[resourceId],
	);
	if (!row || row.slug !== spaceSlug) throw new NotFound(`No resource ${resourceId} in this space.`);
}

export async function assertSyncInSpace(syncId: number, spaceSlug: string): Promise<void> {
	const row = await queryOne<{ slug: string }>(
		`SELECT s.slug FROM platform.connection_sync c
		   JOIN platform.resource r ON r.resource_id = c.resource_id
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE c.sync_id = $1`,
		[syncId],
	);
	if (!row || row.slug !== spaceSlug) throw new NotFound(`No sync ${syncId} in this space.`);
}

export async function assertFolderInSpace(folderId: number, spaceSlug: string): Promise<void> {
	const row = await queryOne<{ slug: string }>(
		`SELECT s.slug FROM platform.folder f
		   JOIN platform.project p ON p.project_id = f.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE f.folder_id = $1`,
		[folderId],
	);
	if (!row || row.slug !== spaceSlug) throw new NotFound(`No folder ${folderId} in this space.`);
}

// ── membership of shared spaces ─────────────────────────────────────────────

export async function listMembers(spaceSlug: string): Promise<Array<{ username: string; role: string; addedBy: string; addedAt: string }>> {
	const rows = await query<{ username: string; role: string; added_by: string; added_at: Date }>(
		`SELECT m.username, m.role, m.added_by, m.added_at
		   FROM platform.space_member m JOIN platform.space s ON s.space_id = m.space_id
		  WHERE s.slug = $1 ORDER BY m.username`,
		[spaceSlug],
	);
	return rows.map((row) => ({
		username: row.username,
		role: row.role,
		addedBy: row.added_by,
		addedAt: row.added_at.toISOString(),
	}));
}

export async function addMember(
	spaceSlug: string,
	username: string,
	role: string,
	addedBy: string,
): Promise<void> {
	const space = await spaceBySlug(spaceSlug);
	if (!space) throw new NotFound(`No space '${spaceSlug}'.`);
	if (space.kind === "personal") {
		throw new NotFound("A personal workspace cannot be shared. Share a dashboard or report instead.");
	}
	const user = await queryOne<{ username: string }>(
		"SELECT username FROM platform.app_user WHERE username = $1",
		[username],
	);
	if (!user) throw new NotFound(`No user '${username}'.`);
	await query(
		`INSERT INTO platform.space_member (space_id, username, role, added_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (space_id, username) DO UPDATE SET role = EXCLUDED.role`,
		[space.id, username, role === "editor" ? "editor" : "viewer", addedBy],
	);
}

export async function removeMember(spaceSlug: string, username: string): Promise<void> {
	await query(
		`DELETE FROM platform.space_member m USING platform.space s
		  WHERE s.space_id = m.space_id AND s.slug = $1 AND m.username = $2`,
		[spaceSlug, username],
	);
}
