/**
 * Authentication and role-based authorisation.
 *
 * Tokens are HS256 JWTs signed with AUTH_JWT_SECRET, which the assistant
 * service verifies with the same secret, so a browser session works across
 * both APIs without either of them issuing its own credential.
 *
 * Both the JWT and the scrypt password check are built on node:crypto rather
 * than jsonwebtoken + bcrypt. The algorithms are the ones those libraries
 * would use, and keeping them here means no third-party code sits on the
 * authentication path.
 */

import {
	createHmac,
	randomBytes,
	randomUUID,
	type ScryptOptions,
	scrypt as scryptCb,
	timingSafeEqual,
} from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { query, queryOne } from "./db";

/**
 * scrypt as a promise, keeping the options argument.
 *
 * promisify() picks a single overload and drops the one that takes
 * ScryptOptions, so N, r and p could not be passed through it - and those are
 * exactly the parameters that have to match what wrote the hash.
 */
function scrypt(
	password: string,
	salt: Buffer,
	keylen: number,
	options: ScryptOptions,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCb(password, salt, keylen, options, (error, derived) => {
			if (error) reject(error);
			else resolve(derived);
		});
	});
}

export type Role = "viewer" | "analyst" | "admin";

/** Ascending privilege. requireRole("analyst") admits analyst and admin. */
const ROLE_RANK: Record<Role, number> = { viewer: 1, analyst: 2, admin: 3 };

export type SignupSource = "admin" | "bootstrap" | "self";

export interface Principal {
	userId: number;
	username: string;
	/** Platform access tier: which routes are reachable. */
	role: Role;
	/** Ontology business role: which actions AccessController will permit. */
	ontologyRole: string;
	/**
	 * How the account was created. A self-registered account only sees its own
	 * personal workspace, plus any shared space it has been added to.
	 */
	signupSource: SignupSource;
}

/**
 * The caller's standing in the space a request is scoped to, set by the space
 * middleware before any route runs.
 */
export interface SpaceAccess {
	slug: string;
	kind: "environment" | "personal";
	/** True in the caller's own personal workspace. */
	isOwner: boolean;
	/** Membership role in a shared space, where the caller has one. */
	memberRole: "viewer" | "editor" | null;
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			principal?: Principal;
			requestId?: string;
			spaceAccess?: SpaceAccess;
		}
	}
}

// ── configuration ───────────────────────────────────────────────────────────

/**
 * The signing secret. Read once at module load: a service that starts without
 * one is a service that would accept unsigned traffic, so it refuses to boot
 * instead. Docker reads it from a secret file when AUTH_JWT_SECRET_FILE is set.
 */
function readSecret(): string {
	const fromFile = process.env.AUTH_JWT_SECRET_FILE;
	if (fromFile) {
		// Imported lazily so the module still loads in tests that never sign.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const value = readFileSync(fromFile, "utf8").trim();
		if (value.length < 32) {
			throw new Error(
				`AUTH_JWT_SECRET_FILE (${fromFile}) must hold at least 32 characters.`,
			);
		}
		return value;
	}
	const value = process.env.AUTH_JWT_SECRET ?? "";
	if (value.length < 32) {
		throw new Error(
			"AUTH_JWT_SECRET must be set to at least 32 characters. Generate one with:\n" +
				"    openssl rand -base64 48",
		);
	}
	return value;
}

const SECRET = readSecret();
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL ?? 8 * 60 * 60);

// ── JWT ─────────────────────────────────────────────────────────────────────

interface Claims {
	sub: string;
	uid: number;
	role: Role;
	/** Mirrors app_user.token_version; a bump invalidates issued tokens. */
	tv: number;
	iat: number;
	exp: number;
}

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

function signature(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("base64url");
}

export function signToken(
	user: { app_user_id: number; username: string; role: Role; token_version: number },
): { token: string; expiresAt: string } {
	const now = Math.floor(Date.now() / 1000);
	const claims: Claims = {
		sub: user.username,
		uid: user.app_user_id,
		role: user.role,
		tv: user.token_version,
		iat: now,
		exp: now + TOKEN_TTL_SECONDS,
	};
	const body = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
		JSON.stringify(claims),
	)}`;
	return {
		token: `${body}.${signature(body)}`,
		expiresAt: new Date(claims.exp * 1000).toISOString(),
	};
}

/** Verify signature and expiry. Returns null on anything malformed. */
export function verifyToken(token: string): Claims | null {
	const [headerSegment, payloadSegment, suppliedSignature] = token.split(".");
	if (!headerSegment || !payloadSegment || !suppliedSignature) return null;
	const body = `${headerSegment}.${payloadSegment}`;

	const expected = Buffer.from(signature(body));
	const supplied = Buffer.from(suppliedSignature);
	// Compare in constant time, and only when the lengths already match:
	// timingSafeEqual throws on a length mismatch rather than returning false.
	if (expected.length !== supplied.length) return null;
	if (!timingSafeEqual(expected, supplied)) return null;

	try {
		const claims = JSON.parse(
			Buffer.from(payloadSegment, "base64url").toString("utf8"),
		) as Claims;
		if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
			return null;
		}
		if (!(claims.role in ROLE_RANK)) return null;
		return claims;
	} catch {
		return null;
	}
}

// ── passwords ───────────────────────────────────────────────────────────────

/**
 * Verify a scrypt hash in the form written by pipeline.users:
 *     scrypt$N$r$p$<salt base64>$<key base64>
 */
export async function verifyPassword(
	password: string,
	encoded: string,
): Promise<boolean> {
	const [scheme, n, r, p, saltB64, hashB64] = encoded.split("$");
	if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;
	try {
		const expected = Buffer.from(hashB64, "base64");
		const derived = await scrypt(
			password,
			Buffer.from(saltB64, "base64"),
			expected.length,
			{ N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 },
		);
		return derived.length === expected.length && timingSafeEqual(derived, expected);
	} catch {
		return false;
	}
}

/** Same parameters pipeline.users writes, so either service can verify the other's hash. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/** Hash a password in the portable scrypt$N$r$p$salt$key form. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: 64 * 1024 * 1024,
	});
	return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), derived.toString("base64")].join("$");
}

// ── principal lookup ────────────────────────────────────────────────────────

interface CachedUser {
	role: Role;
	ontologyRole: string;
	signupSource: SignupSource;
	tokenVersion: number;
	isActive: boolean;
	cachedAt: number;
}

/**
 * Short-lived cache of the mutable half of a user record.
 *
 * The signature check is stateless, but role changes and revocations are not:
 * both live in app_user, and re-reading that table on every request would put
 * a query in front of every route. Thirty seconds bounds how long a revoked
 * token keeps working while keeping the steady-state cost at zero.
 */
const userCache = new Map<number, CachedUser>();
const USER_CACHE_TTL_MS = Number(process.env.AUTH_USER_CACHE_TTL_MS ?? 30_000);

export function clearUserCache(): void {
	userCache.clear();
}

async function currentUser(uid: number): Promise<CachedUser | null> {
	const hit = userCache.get(uid);
	if (hit && Date.now() - hit.cachedAt < USER_CACHE_TTL_MS) return hit;

	const row = await queryOne<{
		role: Role;
		ontology_role: string;
		signup_source: SignupSource | null;
		token_version: number;
		is_active: boolean;
	}>(
		`SELECT role, ontology_role, signup_source, token_version, is_active
		   FROM platform.app_user WHERE app_user_id = $1`,
		[uid],
	);
	if (!row) {
		userCache.delete(uid);
		return null;
	}
	const fresh: CachedUser = {
		role: row.role,
		ontologyRole: row.ontology_role,
		signupSource: row.signup_source ?? "admin",
		tokenVersion: row.token_version,
		isActive: row.is_active,
		cachedAt: Date.now(),
	};
	userCache.set(uid, fresh);
	return fresh;
}

// ── middleware ──────────────────────────────────────────────────────────────

/** Attach a request id to every request so a 500 can be traced to a log line. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
	const incoming = req.header("x-request-id");
	req.requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
	res.setHeader("x-request-id", req.requestId);
	next();
}

/**
 * Require a valid token carrying at least `minimum` privilege.
 *
 * Failures answer 401 for "no usable credential" and 403 for "credential is
 * fine but the role is not enough", with no detail about which user exists.
 */
export function requireRole(minimum: Role) {
	const check = authenticate();
	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		await check(req, res, (error?: unknown) => {
			if (error) return next(error);
			if (ROLE_RANK[req.principal!.role] < ROLE_RANK[minimum]) {
				res.status(403).json({ error: `Requires the ${minimum} role.` });
				return;
			}
			next();
		});
	};
}

/**
 * Verify the bearer token and attach the principal, without a role check.
 *
 * Split from the role check because the role a request needs can now depend
 * on the space it is scoped to - an analyst owns their personal workspace -
 * and the space is resolved after the caller is known.
 */
export function authenticate() {
	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		const header = req.header("authorization") ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
		if (!token) {
			res.status(401).json({ error: "Authentication required." });
			return;
		}

		const claims = verifyToken(token);
		if (!claims) {
			res.status(401).json({ error: "Invalid or expired token." });
			return;
		}

		try {
			const user = await currentUser(claims.uid);
			if (!user || !user.isActive || user.tokenVersion !== claims.tv) {
				res.status(401).json({ error: "Invalid or expired token." });
				return;
			}
			// The database is authoritative on role, not the token: a demotion
			// takes effect within the cache TTL rather than at token expiry.
			req.principal = {
				userId: claims.uid,
				username: claims.sub,
				role: user.role,
				ontologyRole: user.ontologyRole,
				signupSource: user.signupSource,
			};
			next();
		} catch (error) {
			next(error);
		}
	};
}

// ── login ───────────────────────────────────────────────────────────────────

const LOGIN_WINDOW_MINUTES = Number(process.env.AUTH_LOGIN_WINDOW_MINUTES ?? 15);
const LOGIN_MAX_FAILURES = Number(process.env.AUTH_LOGIN_MAX_FAILURES ?? 10);

async function recordAttempt(
	username: string,
	ip: string | undefined,
	succeeded: boolean,
): Promise<void> {
	await query(
		`INSERT INTO platform.auth_attempt (username, source_ip, succeeded)
		 VALUES ($1, $2, $3)`,
		[username, ip ?? null, succeeded],
	);
}

async function tooManyFailures(username: string): Promise<boolean> {
	const row = await queryOne<{ n: string }>(
		`SELECT count(*)::text AS n
		   FROM platform.auth_attempt
		  WHERE username = $1
		    AND NOT succeeded
		    AND created_at > now() - make_interval(mins => $2)`,
		[username, LOGIN_WINDOW_MINUTES],
	);
	return Number(row?.n ?? 0) >= LOGIN_MAX_FAILURES;
}

export async function login(req: Request, res: Response): Promise<void> {
	const { username, password } = (req.body ?? {}) as {
		username?: unknown;
		password?: unknown;
	};
	if (typeof username !== "string" || typeof password !== "string" || !username) {
		res.status(400).json({ error: "username and password are required." });
		return;
	}

	// Throttle per username. The attempt table is the shared store, so this
	// holds across replicas, unlike an in-process counter.
	if (await tooManyFailures(username)) {
		res.status(429).json({
			error: `Too many failed attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`,
		});
		return;
	}

	const user = await queryOne<{
		app_user_id: number;
		username: string;
		role: Role;
		ontology_role: string;
		token_version: number;
		password_hash: string;
		is_active: boolean;
		signup_source: SignupSource | null;
		display_name: string | null;
	}>(
		`SELECT app_user_id, username, role, ontology_role, token_version,
		        password_hash, is_active, signup_source, display_name
		   FROM platform.app_user WHERE username = $1`,
		[username],
	);

	// Verify against a dummy hash when the user is missing so a request for an
	// unknown username costs the same as one for a real account.
	const hash =
		user?.password_hash ??
		"scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
	const ok = await verifyPassword(password, hash);

	if (!user || !user.is_active || !ok) {
		await recordAttempt(username, req.ip, false);
		res.status(401).json({ error: "Invalid credentials." });
		return;
	}

	await recordAttempt(username, req.ip, true);
	await query(
		"UPDATE platform.app_user SET last_login_at = now() WHERE app_user_id = $1",
		[user.app_user_id],
	);

	const { token, expiresAt } = signToken(user);
	res.json({
		token,
		expiresAt,
		user: {
			username: user.username,
			role: user.role,
			ontologyRole: user.ontology_role,
			signupSource: user.signup_source ?? "admin",
			displayName: user.display_name,
		},
	});
}

/** Who the caller is, for the UI to render and to confirm a token still works. */
export function me(req: Request, res: Response): void {
	res.json(req.principal);
}

// ── route policy ────────────────────────────────────────────────────────────

/**
 * Routes that need more than read access. Everything else under /api requires
 * the viewer role, so a route added later is protected by default rather than
 * open by default: the failure mode of forgetting to list it here is that it
 * demands a login, not that it is anonymous.
 *
 * Paths are matched relative to the /api mount point.
 */
const ELEVATED: ReadonlyArray<{ method: string; pattern: RegExp; role: Role }> = [
	// Rebuilds in-process state for every caller.
	{ method: "POST", pattern: /^\/registry\/reload$/, role: "admin" },
	// Destructive, and dashboards are shared objects.
	{ method: "DELETE", pattern: /^\/dashboards\/[^/]+$/, role: "admin" },
	// The audit trail records who did what; reading it is a privileged act.
	{ method: "GET", pattern: /^\/actions\/audit$/, role: "admin" },

	{ method: "POST", pattern: /^\/dashboards$/, role: "analyst" },
	{ method: "POST", pattern: /^\/dashboards\/validate$/, role: "analyst" },
	// Renaming and importing change what everyone sees, so they sit with the
	// other dashboard writes. Export and history are reads and stay at viewer:
	// letting anyone take their own backup is the point of the feature.
	{ method: "POST", pattern: /^\/dashboards\/import$/, role: "analyst" },
	{ method: "POST", pattern: /^\/dashboards\/[^/]+\/rename$/, role: "analyst" },
	// Mutating actions are staged rather than executed, but they still write an
	// audit row and stand in for a real TMS write.
	{ method: "POST", pattern: /^\/actions\/[^/]+\/apply$/, role: "analyst" },
	{ method: "POST", pattern: /^\/actions\/[^/]+\/validate$/, role: "analyst" },

	// Authoring the ontology. Creating an object type from a dataset, drawing
	// a link, declaring an action or a metric, or editing a label changes what
	// everyone sees and what every dashboard resolves against, so it is an
	// analyst act - and the assistant, running with the user's token, is
	// bound by the same rule. Removing part of the ontology is an admin one.
	{ method: "PATCH", pattern: /^\/ontology\/[^/]+\/.+$/, role: "analyst" },
	{ method: "POST", pattern: /^\/ontology\/object-types$/, role: "analyst" },
	{ method: "POST", pattern: /^\/ontology\/link-types$/, role: "analyst" },
	{ method: "POST", pattern: /^\/ontology\/action-types$/, role: "analyst" },
	{ method: "POST", pattern: /^\/ontology\/metrics$/, role: "analyst" },
	{ method: "POST", pattern: /^\/ontology\/edits\/[^/]+\/undo$/, role: "analyst" },
	{ method: "DELETE", pattern: /^\/ontology\/[^/]+\/.+$/, role: "admin" },

	// Functions. Proposing is an analyst act: a proposal computes nothing and
	// is inert until approved, so drafting one is cheap to allow and cheap to
	// reject. APPROVING is the act that makes a definition produce numbers on
	// other people's dashboards, so it sits at admin — the whole point of the
	// proposed/active split is that the two are not the same person's click.
	{ method: "POST", pattern: /^\/functions$/, role: "analyst" },
	{ method: "PATCH", pattern: /^\/functions\/[^/]+$/, role: "analyst" },
	{ method: "POST", pattern: /^\/functions\/[^/]+\/run$/, role: "analyst" },
	{ method: "POST", pattern: /^\/functions\/[^/]+\/approve$/, role: "admin" },
	{ method: "POST", pattern: /^\/functions\/[^/]+\/reject$/, role: "admin" },
	{ method: "POST", pattern: /^\/functions\/[^/]+\/archive$/, role: "admin" },

	// Schedules run syncs on a cadence, so defining or triggering one is an
	// analyst act; deleting one is admin, like the other destructive verbs.
	{ method: "POST", pattern: /^\/schedules$/, role: "analyst" },
	{ method: "PATCH", pattern: /^\/schedules\/[^/]+$/, role: "analyst" },
	{ method: "POST", pattern: /^\/schedules\/[^/]+\/run$/, role: "analyst" },
	{ method: "DELETE", pattern: /^\/schedules\/[^/]+$/, role: "admin" },
	{ method: "POST", pattern: /^\/syncs\/[^/]+\/schedule$/, role: "analyst" },

	// Creating projects, folders and resources is authoring work.
	// Reading the tree and previewing a resource stay at viewer, so anyone can
	// look at what exists without being able to reshape it.
	{ method: "POST", pattern: /^\/spaces\/sandbox\/seed$/, role: "analyst" },
	{ method: "POST", pattern: /^\/spaces\/[^/]+\/projects$/, role: "analyst" },
	{ method: "POST", pattern: /^\/spaces\/[^/]+\/projects\/[^/]+\/folders$/, role: "analyst" },
	{ method: "POST", pattern: /^\/spaces\/[^/]+\/projects\/[^/]+\/resources$/, role: "analyst" },
	{ method: "POST", pattern: /^\/resources\/[^/]+\/rename$/, role: "analyst" },
	// Testing a connection reaches out to a host of the caller's choosing and
	// reads a credential the service can see, so it is not a viewer action.
	{ method: "POST", pattern: /^\/spaces\/connections\/test$/, role: "analyst" },
	{ method: "POST", pattern: /^\/spaces\/[^/]+\/projects\/[^/]+\/connections$/, role: "analyst" },
	{ method: "POST", pattern: /^\/resources\/[^/]+\/test$/, role: "analyst" },

	// Reading a source's catalogue dials another host with a credential this
	// service can see, so it sits with testing rather than with the reads.
	// Listing the syncs already defined is local metadata and stays at viewer.
	{ method: "GET", pattern: /^\/resources\/[^/]+\/catalog$/, role: "analyst" },
	// Defining a sync, and running one, write into connection_raw and are what
	// brings outside data onto this platform.
	{ method: "POST", pattern: /^\/resources\/[^/]+\/syncs$/, role: "analyst" },
	{ method: "POST", pattern: /^\/syncs\/[^/]+\/run$/, role: "analyst" },
	// Deleting one takes away the thing that rebuilds a dataset other people
	// are reading.
	{ method: "DELETE", pattern: /^\/syncs\/[^/]+$/, role: "admin" },

	// Importing tables and modelling them write into connection_raw and into
	// the space's ontology. Removing a modelled type takes its metrics with it,
	// which is an admin act in a shared space - and, through ownership, every
	// person's act in their own workspace.
	{ method: "POST", pattern: /^\/resources\/[^/]+\/import$/, role: "analyst" },
	{ method: "POST", pattern: /^\/resources\/[^/]+\/model$/, role: "analyst" },
	{ method: "DELETE", pattern: /^\/object-types\/[^/]+$/, role: "admin" },

	// Proposals. Drafting one changes nothing, so it is an analyst act;
	// APPROVING applies it to the ontology, which is the act that matters.
	// In a personal workspace the owner approves their own.
	{ method: "POST", pattern: /^\/proposals$/, role: "analyst" },
	{ method: "POST", pattern: /^\/proposals\/[^/]+\/(approve|reject)$/, role: "admin" },
	// Writing a dashboard or a report from the assistant's plan.
	{ method: "POST", pattern: /^\/dashboards\/[^/]+\/widgets$/, role: "analyst" },
	{ method: "POST", pattern: /^\/workspace\/auto-dashboard$/, role: "analyst" },

	// Deleting removes something other people may be building on.
	{ method: "DELETE", pattern: /^\/spaces\/[^/]+\/projects\/[^/]+$/, role: "admin" },
	{ method: "DELETE", pattern: /^\/resources\/[^/]+$/, role: "admin" },
	{ method: "DELETE", pattern: /^\/folders\/[^/]+$/, role: "admin" },
];

/** The role a request needs, from the table above or viewer as the floor. */
export function requiredRoleFor(method: string, path: string): Role {
	for (const rule of ELEVATED) {
		if (rule.method === method && rule.pattern.test(path)) return rule.role;
	}
	return "viewer";
}

/** Single guard for the whole /api surface. Mount it before the routes. */
export function apiAuthorization() {
	return (req: Request, res: Response, next: NextFunction): void => {
		void requireRole(requiredRoleFor(req.method, req.path))(req, res, next);
	};
}

// ── space-aware authorisation ───────────────────────────────────────────────
//
//  The role table above was written for one shared team. Two things change
//  once anyone can register:
//
//   * a person owns their personal workspace, and owning it means being able
//     to delete their own dashboard or approve their own proposal - acts the
//     table reserves for admins because, in a shared space, they affect
//     everyone;
//   * a self-registered account sees a shared space only as a member, and its
//     platform role there is capped by that membership.
//
//  Some routes still mean "administer the platform" wherever they are called
//  from, and stay at the platform role.

const PLATFORM_ADMIN_ONLY: ReadonlyArray<{ method: string; pattern: RegExp }> = [
	{ method: "POST", pattern: /^\/registry\/reload$/ },
	{ method: "POST", pattern: /^\/functions\/[^/]+\/(approve|reject|archive)$/ },
	{ method: "POST", pattern: /^\/spaces\/[^/]+\/members$/ },
	{ method: "DELETE", pattern: /^\/spaces\/[^/]+\/members\/[^/]+$/ },
];

/** The role the caller effectively holds in the space the request is scoped to. */
export function effectiveRole(principal: Principal, access: SpaceAccess | undefined): Role {
	if (principal.role === "admin") return "admin";
	if (access?.kind === "personal" && access.isOwner) return "admin";
	if (access?.kind === "environment" && principal.signupSource === "self") {
		// Membership caps a self-registered account in a shared space: an editor
		// works as an analyst at most, anyone else only reads.
		if (access.memberRole === "editor") {
			return ROLE_RANK[principal.role] >= ROLE_RANK.analyst ? "analyst" : principal.role;
		}
		return "viewer";
	}
	return principal.role;
}

/**
 * Features that cannot be offered inside a personal workspace.
 *
 * Each of these runs SQL the caller wrote, or reads a relation the caller
 * names, and the synced tables of every workspace live in one schema. In a
 * shared space that is the trust the team already extends to an analyst; in a
 * personal workspace it would let one account read another's synced tables.
 * Metrics, links and combined datasets are still available there - they are
 * compiled from the ontology, never written as SQL by the caller.
 */
const PERSONAL_SPACE_REFUSED: ReadonlyArray<{ method: string; pattern: RegExp; feature: string }> = [
	{ method: "POST", pattern: /^\/functions(\/.*)?$/, feature: "SQL functions" },
	{ method: "PATCH", pattern: /^\/functions\/.+$/, feature: "SQL functions" },
	{ method: "POST", pattern: /^\/spaces\/sandbox\/seed$/, feature: "Seeding the sandbox from the TMS ontology" },
	{ method: "GET", pattern: /^\/spaces\/database$/, feature: "The platform database's own details" },
];

/** Why a request is refused in the caller's personal workspace, or null. */
export function personalSpaceRefusal(
	method: string,
	path: string,
	principal: Principal,
	access: SpaceAccess | undefined,
): string | null {
	if (principal.role === "admin" || access?.kind !== "personal") return null;
	for (const rule of PERSONAL_SPACE_REFUSED) {
		if (rule.method === method && rule.pattern.test(path)) {
			return (
				`${rule.feature}, which is not available in a personal workspace: every ` +
				"workspace's tables share one database, so it could read data that is not yours. " +
				"Ask for a metric, a link or a combined dataset instead - those are compiled from " +
				"your ontology - or ask an administrator to add you to a shared space."
			);
		}
	}
	return null;
}

/**
 * The role check, run after authentication and space resolution.
 *
 * Uses the caller's effective role in the space in scope, except for the
 * platform-wide routes, which always need the platform role.
 */
export function authorizeRoute() {
	return (req: Request, res: Response, next: NextFunction): void => {
		const principal = req.principal;
		if (!principal) {
			res.status(401).json({ error: "Authentication required." });
			return;
		}
		const refusal = personalSpaceRefusal(req.method, req.path, principal, req.spaceAccess);
		if (refusal) {
			res.status(403).json({ error: refusal });
			return;
		}
		const required = requiredRoleFor(req.method, req.path);
		const platformWide = PLATFORM_ADMIN_ONLY.some(
			(rule) => rule.method === req.method && rule.pattern.test(req.path),
		);
		const held = platformWide ? principal.role : effectiveRole(principal, req.spaceAccess);
		if (ROLE_RANK[held] < ROLE_RANK[platformWide ? "admin" : required]) {
			res.status(403).json({ error: `Requires the ${platformWide ? "admin" : required} role.` });
			return;
		}
		next();
	};
}

// ── registration ────────────────────────────────────────────────────────────

/** Whether anyone may create an account, or only an administrator can. */
export const SELF_REGISTRATION =
	(process.env.ALLOW_SELF_REGISTRATION ?? "true").trim().toLowerCase() !== "false";

/** The platform role a self-registered account starts with. */
export const REGISTRATION_ROLE: Role =
	(process.env.REGISTRATION_DEFAULT_ROLE ?? "analyst").trim().toLowerCase() === "viewer"
		? "viewer"
		: "analyst";

const REGISTRATIONS_PER_HOUR = Number(process.env.REGISTRATION_MAX_PER_HOUR ?? 5);

const RESERVED_USERNAMES = new Set([
	"admin", "administrator", "root", "system", "pipeline", "assistant", "ai-fde", "planner",
	"support", "sandbox", "staging", "production", "development", "anonymous", "unknown", "user",
]);

export interface RegistrationInput {
	username: string;
	password: string;
	email: string | null;
	displayName: string | null;
}

/**
 * Check a registration form. Returns every problem at once, so the form can
 * mark all of them instead of making someone submit five times.
 */
export function validateRegistration(body: unknown): { input: RegistrationInput | null; errors: string[] } {
	const raw = (body ?? {}) as Record<string, unknown>;
	const errors: string[] = [];
	const username = typeof raw.username === "string" ? raw.username.trim().toLowerCase() : "";
	const password = typeof raw.password === "string" ? raw.password : "";
	const email = typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : null;
	const displayName =
		typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim().slice(0, 80) : null;

	if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
		errors.push(
			"Username must be 3 to 32 characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.",
		);
	} else if (RESERVED_USERNAMES.has(username)) {
		errors.push(`'${username}' is reserved. Choose another username.`);
	}
	if (password.length < 12) errors.push("Password must be at least 12 characters.");
	if (password.length > 256) errors.push("Password must be 256 characters or fewer.");
	if (username && password.toLowerCase().includes(username)) {
		errors.push("Password must not contain the username.");
	}
	if (password && new Set(password).size < 4) {
		errors.push("Password is too repetitive; use at least four different characters.");
	}
	if (email !== null && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
		errors.push("That email address does not look valid.");
	}
	return { input: errors.length ? null : { username, password, email, displayName }, errors };
}

/** Whether this address has registered too many accounts in the last hour. */
export async function tooManyRegistrations(ip: string | undefined): Promise<boolean> {
	const row = await queryOne<{ n: string }>(
		`SELECT count(*)::text AS n FROM platform.auth_attempt
		  WHERE username = $1 AND succeeded AND created_at > now() - interval '1 hour'`,
		[`register:${ip ?? "unknown"}`],
	);
	return Number(row?.n ?? 0) >= REGISTRATIONS_PER_HOUR;
}

export async function recordRegistration(ip: string | undefined): Promise<void> {
	await recordAttempt(`register:${ip ?? "unknown"}`, ip, true);
}

/** Insert a self-registered account, or null when the name or email is taken. */
export async function createSelfRegisteredUser(input: RegistrationInput): Promise<{
	app_user_id: number;
	username: string;
	role: Role;
	ontology_role: string;
	token_version: number;
} | null> {
	const hash = await hashPassword(input.password);
	try {
		return await queryOne(
			`INSERT INTO platform.app_user
			   (username, display_name, email, password_hash, role, ontology_role, signup_source)
			 VALUES ($1, $2, $3, $4, $5, 'tms:AnalystRole', 'self')
			 ON CONFLICT (username) DO NOTHING
			 RETURNING app_user_id, username, role, ontology_role, token_version`,
			[input.username, input.displayName, input.email, hash, REGISTRATION_ROLE],
		);
	} catch (error) {
		// The email index is the other unique constraint an insert can hit.
		if ((error as { code?: string }).code === "23505") return null;
		throw error;
	}
}
