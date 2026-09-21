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

export interface Principal {
	userId: number;
	username: string;
	/** Platform access tier: which routes are reachable. */
	role: Role;
	/** Ontology business role: which actions AccessController will permit. */
	ontologyRole: string;
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			principal?: Principal;
			requestId?: string;
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

// ── principal lookup ────────────────────────────────────────────────────────

interface CachedUser {
	role: Role;
	ontologyRole: string;
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
		token_version: number;
		is_active: boolean;
	}>(
		`SELECT role, ontology_role, token_version, is_active
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
			if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
				res.status(403).json({ error: `Requires the ${minimum} role.` });
				return;
			}
			req.principal = {
				userId: claims.uid,
				username: claims.sub,
				role: user.role,
				ontologyRole: user.ontologyRole,
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
	}>(
		`SELECT app_user_id, username, role, ontology_role, token_version,
		        password_hash, is_active
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

	// A pipeline defines how data becomes an ontology, so editing one is an
	// analyst act and deleting one is an admin act. Reading, validating and
	// the palette stay at viewer.
	{ method: "POST", pattern: /^\/pipelines$/, role: "analyst" },
	{ method: "POST", pattern: /^\/pipelines\/[^/]+\/run$/, role: "analyst" },
	{ method: "POST", pattern: /^\/pipelines\/[^/]+\/versions\/[^/]+\/restore$/, role: "analyst" },
	{ method: "DELETE", pattern: /^\/pipelines\/[^/]+$/, role: "admin" },
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
