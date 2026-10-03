/**
 * The admin console: user accounts, their AI credit, platform settings, and
 * the record of what administrators changed.
 *
 * Every route that reaches this module needs the PLATFORM admin role. auth.ts
 * pins /admin/* to the platform role rather than to the role a person holds
 * in the space a request is scoped to: an analyst is the "admin" of their own
 * personal workspace, and that must never open these routes.
 *
 * Accounts are the same app_user rows pipeline.users manages from the command
 * line - the same scrypt hashes, the same token_version revocation - so the
 * CLI and this console can be used interchangeably.
 *
 * Settings are rows in platform.app_setting. A missing row means "not set by
 * an administrator", and the setting falls back to its environment variable
 * and then to its built-in default, so .env keeps working exactly as before
 * and clearing a setting in the console is the way back to it.
 */

import { clearUserCache, hashPassword, REGISTRATION_ROLE, type Role, SELF_REGISTRATION, validateRegistration } from "./auth";
import { pool, query, queryOne } from "./db";
import { ensurePersonalSpace, invalidateSpaceCache } from "./workspaces";

/** A refusal written for the person at the console. */
export class AdminError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// ── vocabulary ──────────────────────────────────────────────────────────────

/** Platform access tiers, as the app_user CHECK constraint allows them. */
export const ROLES: readonly Role[] = ["viewer", "analyst", "admin"];

/** Business hats, as the app_user CHECK constraint allows them. */
export const ONTOLOGY_ROLES = [
	"tms:AdminRole",
	"tms:OperationsManagerRole",
	"tms:DispatcherRole",
	"tms:FinanceRole",
	"tms:AnalystRole",
] as const;

/**
 * The business hat a platform tier gets when none is named - the same table
 * pipeline.users uses. Analyst reads everything and mutates nothing, so
 * defaulting never widens what someone may do.
 */
export const DEFAULT_ONTOLOGY_ROLE: Record<Role, string> = {
	viewer: "tms:AnalystRole",
	analyst: "tms:AnalystRole",
	admin: "tms:AdminRole",
};

export type CreditMode = "default" | "unlimited" | "custom";
const CREDIT_MODES: readonly CreditMode[] = ["default", "unlimited", "custom"];

/** A ceiling on what can be typed, so a slipped finger cannot mean "unlimited". */
const MAX_CREDIT_USD = 1_000_000;

// ── pure rules (unit-tested) ────────────────────────────────────────────────

/** The same password rules self-registration applies. */
export function passwordProblems(username: string, password: string): string[] {
	const problems: string[] = [];
	if (password.length < 12) problems.push("Password must be at least 12 characters.");
	if (password.length > 256) problems.push("Password must be 256 characters or fewer.");
	if (username && password.toLowerCase().includes(username.toLowerCase())) {
		problems.push("Password must not contain the username.");
	}
	if (password && new Set(password).size < 4) {
		problems.push("Password is too repetitive; use at least four different characters.");
	}
	return problems;
}

/** Read a credit choice from a request body. Appends to `errors` on a bad one. */
export function parseCredit(
	raw: { creditMode?: unknown; creditLimitUsd?: unknown },
	errors: string[],
): { mode: CreditMode; limitUsd: number | null } | undefined {
	if (raw.creditMode === undefined) return undefined;
	const mode = raw.creditMode as CreditMode;
	if (!CREDIT_MODES.includes(mode)) {
		errors.push("Credit must be 'default', 'unlimited' or 'custom'.");
		return undefined;
	}
	if (mode !== "custom") return { mode, limitUsd: null };
	const amount = typeof raw.creditLimitUsd === "string" ? Number(raw.creditLimitUsd) : raw.creditLimitUsd;
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > MAX_CREDIT_USD) {
		errors.push(`A custom credit must be an amount in USD between 0 and ${MAX_CREDIT_USD.toLocaleString("en-US")}.`);
		return undefined;
	}
	return { mode, limitUsd: Math.round(amount * 100) / 100 };
}

/** The monthly limit that applies to someone: null means no limit. */
export function effectiveCreditLimit(
	mode: CreditMode,
	limitUsd: number | null,
	defaultMonthlyUsd: number | null,
): number | null {
	if (mode === "unlimited") return null;
	if (mode === "custom") return limitUsd;
	return defaultMonthlyUsd;
}

export interface NewUser {
	username: string;
	password: string;
	displayName: string | null;
	email: string | null;
	role: Role;
	ontologyRole: string;
	creditMode: CreditMode;
	creditLimitUsd: number | null;
}

/**
 * Check an "add user" form. Every problem at once, like registration, so the
 * form can mark all of them in one pass.
 */
export function validateNewUser(body: unknown): { input: NewUser | null; errors: string[] } {
	const raw = (body ?? {}) as Record<string, unknown>;
	// Username, password, email and display name follow registration's rules
	// exactly: an account an administrator creates is held to the same bar.
	const base = validateRegistration(raw);
	const errors = [...base.errors];

	const role = (typeof raw.role === "string" ? raw.role : "analyst") as Role;
	if (!ROLES.includes(role)) errors.push("Role must be viewer, analyst or admin.");
	const ontologyRole = typeof raw.ontologyRole === "string" && raw.ontologyRole ? raw.ontologyRole : DEFAULT_ONTOLOGY_ROLE[role] ?? "tms:AnalystRole";
	if (!(ONTOLOGY_ROLES as readonly string[]).includes(ontologyRole)) {
		errors.push(`Business role must be one of ${ONTOLOGY_ROLES.join(", ")}.`);
	}
	const credit = parseCredit(raw, errors) ?? { mode: "default" as CreditMode, limitUsd: null };

	if (errors.length > 0 || !base.input) return { input: null, errors };
	return {
		input: {
			...base.input,
			role,
			ontologyRole,
			creditMode: credit.mode,
			creditLimitUsd: credit.limitUsd,
		},
		errors,
	};
}

export interface UserPatch {
	displayName?: string | null;
	email?: string | null;
	role?: Role;
	ontologyRole?: string;
	isActive?: boolean;
	creditMode?: CreditMode;
	creditLimitUsd?: number | null;
}

/** Check an edit. Only the fields present are changed. */
export function validateUserPatch(body: unknown): { patch: UserPatch | null; errors: string[] } {
	const raw = (body ?? {}) as Record<string, unknown>;
	const errors: string[] = [];
	const patch: UserPatch = {};

	if ("displayName" in raw) {
		const value = raw.displayName;
		if (value !== null && typeof value !== "string") errors.push("Display name must be text.");
		else patch.displayName = typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
	}
	if ("email" in raw) {
		const value = raw.email;
		if (value === null || (typeof value === "string" && !value.trim())) patch.email = null;
		else if (typeof value !== "string" || value.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
			errors.push("That email address does not look valid.");
		} else patch.email = value.trim();
	}
	if ("role" in raw) {
		if (!ROLES.includes(raw.role as Role)) errors.push("Role must be viewer, analyst or admin.");
		else patch.role = raw.role as Role;
	}
	if ("ontologyRole" in raw) {
		if (!(ONTOLOGY_ROLES as readonly string[]).includes(raw.ontologyRole as string)) {
			errors.push(`Business role must be one of ${ONTOLOGY_ROLES.join(", ")}.`);
		} else patch.ontologyRole = raw.ontologyRole as string;
	}
	if ("isActive" in raw) {
		if (typeof raw.isActive !== "boolean") errors.push("isActive must be true or false.");
		else patch.isActive = raw.isActive;
	}
	const credit = parseCredit(raw, errors);
	if (credit) {
		patch.creditMode = credit.mode;
		patch.creditLimitUsd = credit.limitUsd;
	}
	if (errors.length === 0 && Object.keys(patch).length === 0) errors.push("Nothing to change.");
	return { patch: errors.length ? null : patch, errors };
}

/**
 * What a deleted account's private data is re-labelled to.
 *
 * Personal workspaces, chat sessions and notes are found by USERNAME, so
 * leaving them under the old name would hand them to the next person who
 * registers it. The label contains a space and parentheses, which no username
 * may contain, so nobody can ever sign in as it - while the cost history and
 * the workspace stay attributable for the people who audit them.
 */
export function tombstone(username: string, id: number): string {
	return `${username} (deleted #${id})`;
}

/**
 * Why a change would lock administrators out, or null when it would not.
 *
 * Nobody may delete, disable or demote themselves - the console would vanish
 * mid-click - and the last active admin cannot be removed by anyone, or the
 * platform is left with nobody able to administer it.
 */
export function lockoutProblem(input: {
	actorId: number;
	targetId: number;
	targetIsActiveAdmin: boolean;
	activeAdmins: number;
	change: "delete" | "disable" | "demote";
}): string | null {
	const verb = { delete: "delete", disable: "disable", demote: "remove the admin role from" }[input.change];
	if (input.actorId === input.targetId) {
		return `You cannot ${verb} your own account. Ask another administrator to do it.`;
	}
	if (input.targetIsActiveAdmin && input.activeAdmins <= 1) {
		return `This is the only active administrator, so you cannot ${verb} it. Make someone else an admin first.`;
	}
	return null;
}

// ── settings ────────────────────────────────────────────────────────────────

export type SettingValue = string | number | boolean | null;
type SettingSource = "admin" | "environment" | "built-in" | "assistant service";

interface SettingSpec {
	key: string;
	label: string;
	description: string;
	group: "assistant" | "pricing" | "credit" | "registration";
	/** What applies while no administrator has set it. */
	fallback(): { value: SettingValue; source: SettingSource };
	/** The stored form of an incoming value, or why it cannot be stored. */
	parse(raw: unknown): Parsed;
}

type Parsed = { value: SettingValue } | { error: string };

function amount(max: number) {
	return (raw: unknown): Parsed => {
		const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
			return { error: `Must be a number between 0 and ${max.toLocaleString("en-US")}.` };
		}
		return { value: Math.round(value * 10_000) / 10_000 };
	};
}

function oneOf(allowed: readonly string[]) {
	return (raw: unknown): Parsed =>
		typeof raw === "string" && allowed.includes(raw)
			? { value: raw }
			: { error: `Must be ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}.` };
}

export const SETTINGS: readonly SettingSpec[] = [
	{
		key: "assistant.defaultModel",
		label: "Default AI model",
		description:
			"Preselected in the assistant's model picker for everyone. A person can still choose another model for a conversation.",
		group: "assistant",
		fallback: () => ({ value: "auto", source: "built-in" }),
		parse: oneOf(["auto", "azure_openai", "builtin"]),
	},
	{
		key: "pricing.azureInputPerMillion",
		label: "Azure OpenAI input price",
		description:
			"USD per million prompt tokens. Applies to turns from now on; past turns keep the rate they were priced at.",
		group: "pricing",
		fallback: () => ({ value: null, source: "assistant service" }),
		parse: amount(1000),
	},
	{
		key: "pricing.azureOutputPerMillion",
		label: "Azure OpenAI output price",
		description:
			"USD per million completion tokens. Applies to turns from now on; past turns keep the rate they were priced at.",
		group: "pricing",
		fallback: () => ({ value: null, source: "assistant service" }),
		parse: amount(1000),
	},
	{
		key: "credit.defaultMonthlyUsd",
		label: "Default monthly AI credit",
		description:
			"What each person may spend on the hosted model in a calendar month, unless their account says otherwise. Not set means no limit.",
		group: "credit",
		fallback: () => ({ value: null, source: "built-in" }),
		parse: amount(MAX_CREDIT_USD),
	},
	{
		key: "registration.enabled",
		label: "Allow self-registration",
		description: "Whether anyone who can reach the sign-in page may create an account and a private workspace.",
		group: "registration",
		fallback: () => ({
			value: SELF_REGISTRATION,
			source: process.env.ALLOW_SELF_REGISTRATION ? "environment" : "built-in",
		}),
		parse: (raw) => (typeof raw === "boolean" ? { value: raw } : { error: "Must be true or false." }),
	},
	{
		key: "registration.defaultRole",
		label: "Role for new accounts",
		description: "The platform role a self-registered account starts with.",
		group: "registration",
		fallback: () => ({
			value: REGISTRATION_ROLE,
			source: process.env.REGISTRATION_DEFAULT_ROLE ? "environment" : "built-in",
		}),
		parse: oneOf(["viewer", "analyst"]),
	},
];

const SPEC_BY_KEY = new Map(SETTINGS.map((spec) => [spec.key, spec]));

/**
 * Check a settings update. A null value clears the setting (back to its
 * fallback); anything else must parse. All or nothing, so a form with one bad
 * field changes nothing rather than half of itself.
 */
export function validateSettings(body: unknown): { values: Map<string, SettingValue> | null; errors: string[] } {
	const raw = ((body ?? {}) as { values?: unknown }).values;
	const errors: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { values: null, errors: ["Send the settings to change as { values: { key: value } }."] };
	}
	const values = new Map<string, SettingValue>();
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const spec = SPEC_BY_KEY.get(key);
		if (!spec) {
			errors.push(`Unknown setting: ${key}.`);
			continue;
		}
		if (value === null) {
			values.set(key, null);
			continue;
		}
		const parsed = spec.parse(value);
		if ("error" in parsed) errors.push(`${spec.label}: ${parsed.error}`);
		else values.set(key, parsed.value);
	}
	if (errors.length === 0 && values.size === 0) errors.push("Nothing to change.");
	return { values: errors.length ? null : values, errors };
}

interface StoredSetting {
	key: string;
	value: SettingValue;
	updated_by: string;
	updated_at: string;
}

let settingsCache: { at: number; rows: Map<string, StoredSetting> } | null = null;
const SETTINGS_TTL_MS = 10_000;

async function storedSettings(): Promise<Map<string, StoredSetting>> {
	if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.rows;
	const rows = await query<StoredSetting>(
		"SELECT key, value, updated_by, updated_at FROM platform.app_setting",
	);
	settingsCache = { at: Date.now(), rows: new Map(rows.map((row) => [row.key, row])) };
	return settingsCache.rows;
}

/** One setting's effective value: the administrator's, else its fallback. */
export async function settingValue(key: string): Promise<SettingValue> {
	const spec = SPEC_BY_KEY.get(key);
	if (!spec) throw new Error(`Unknown setting ${key}`);
	const stored = (await storedSettings()).get(key);
	return stored ? stored.value : spec.fallback().value;
}

/** Whether registration is open and the role it grants, as configured now. */
export async function registrationPolicy(): Promise<{ enabled: boolean; role: Role }> {
	try {
		const [enabled, role] = await Promise.all([
			settingValue("registration.enabled"),
			settingValue("registration.defaultRole"),
		]);
		return { enabled: enabled === true, role: role === "viewer" ? "viewer" : "analyst" };
	} catch {
		// Before migration 0035 there is no settings table; the environment
		// is then the whole answer, exactly as it was.
		return { enabled: SELF_REGISTRATION, role: REGISTRATION_ROLE };
	}
}

export async function getSettings(): Promise<{
	settings: Array<{
		key: string;
		label: string;
		description: string;
		group: string;
		value: SettingValue;
		adminValue: SettingValue;
		source: SettingSource;
		fallback: SettingValue;
		fallbackSource: SettingSource;
		updatedBy: string | null;
		updatedAt: string | null;
	}>;
}> {
	const stored = await storedSettings();
	return {
		settings: SETTINGS.map((spec) => {
			const row = stored.get(spec.key);
			const fallback = spec.fallback();
			return {
				key: spec.key,
				label: spec.label,
				description: spec.description,
				group: spec.group,
				value: row ? row.value : fallback.value,
				adminValue: row ? row.value : null,
				source: row ? "admin" : fallback.source,
				fallback: fallback.value,
				fallbackSource: fallback.source,
				updatedBy: row?.updated_by ?? null,
				updatedAt: row?.updated_at ?? null,
			};
		}),
	};
}

export async function updateSettings(body: unknown, actor: string): ReturnType<typeof getSettings> {
	const { values, errors } = validateSettings(body);
	if (!values) throw new AdminError(errors.join(" "), 400);
	const before = await storedSettings();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		for (const [key, value] of values) {
			if (value === null) {
				await client.query("DELETE FROM platform.app_setting WHERE key = $1", [key]);
			} else {
				await client.query(
					`INSERT INTO platform.app_setting (key, value, updated_by, updated_at)
					 VALUES ($1, $2::jsonb, $3, now())
					 ON CONFLICT (key) DO UPDATE
					   SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
					[key, JSON.stringify(value), actor],
				);
			}
			await client.query(
				`INSERT INTO platform.admin_event (actor, action, target, detail)
				 VALUES ($1, 'setting.changed', $2, $3::jsonb)`,
				[actor, key, JSON.stringify({ from: before.get(key)?.value ?? null, to: value })],
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
	settingsCache = null;
	return getSettings();
}

// ── users ───────────────────────────────────────────────────────────────────

interface UserRow {
	app_user_id: number;
	username: string;
	display_name: string | null;
	email: string | null;
	role: Role;
	ontology_role: string;
	is_active: boolean;
	signup_source: string;
	created_at: string;
	last_login_at: string | null;
	credit_mode: CreditMode;
	credit_limit_usd: string | null;
	month_usd: string;
	last30_usd: string;
	tokens30: string;
	turns30: string;
	sessions: string;
	last_chat_at: string | null;
}

const USER_SELECT = `
	WITH spend AS (
	  SELECT s.user_id,
	         COALESCE(sum(m.cost_usd) FILTER (WHERE m.created_at >= date_trunc('month', now())), 0) AS month_usd,
	         COALESCE(sum(m.cost_usd) FILTER (WHERE m.created_at >= now() - interval '30 days'), 0) AS last30_usd,
	         COALESCE(sum(m.total_tokens) FILTER (WHERE m.created_at >= now() - interval '30 days'), 0) AS tokens30,
	         count(*) FILTER (WHERE m.created_at >= now() - interval '30 days') AS turns30,
	         max(m.created_at) AS last_chat_at
	    FROM platform.chat_message m
	    JOIN platform.chat_session s USING (chat_session_id)
	   WHERE m.role = 'assistant'
	   GROUP BY s.user_id
	), sessions AS (
	  -- The conversations a person still has. One they deleted is kept as a row
	  -- for what it cost (0036) and is counted in the spend above, not here.
	  SELECT user_id, count(*) AS sessions FROM platform.chat_session WHERE deleted_at IS NULL GROUP BY user_id
	)
	SELECT u.app_user_id, u.username, u.display_name, u.email, u.role, u.ontology_role,
	       u.is_active, u.signup_source, u.created_at, u.last_login_at,
	       u.credit_mode, u.credit_limit_usd::text,
	       COALESCE(sp.month_usd, 0)::text  AS month_usd,
	       COALESCE(sp.last30_usd, 0)::text AS last30_usd,
	       COALESCE(sp.tokens30, 0)::text   AS tokens30,
	       COALESCE(sp.turns30, 0)::text    AS turns30,
	       COALESCE(se.sessions, 0)::text   AS sessions,
	       sp.last_chat_at
	  FROM platform.app_user u
	  LEFT JOIN spend sp ON sp.user_id = u.username
	  LEFT JOIN sessions se ON se.user_id = u.username`;

function shape(row: UserRow, defaultMonthlyUsd: number | null) {
	const limit = row.credit_limit_usd === null ? null : Number(row.credit_limit_usd);
	const effective = effectiveCreditLimit(row.credit_mode, limit, defaultMonthlyUsd);
	const spent = Number(row.month_usd);
	return {
		// BIGINT arrives as a string; ids are numbers everywhere else.
		id: Number(row.app_user_id),
		username: row.username,
		displayName: row.display_name,
		email: row.email,
		role: row.role,
		ontologyRole: row.ontology_role,
		isActive: row.is_active,
		signupSource: row.signup_source,
		createdAt: row.created_at,
		lastLoginAt: row.last_login_at,
		credit: {
			mode: row.credit_mode,
			limitUsd: limit,
			effectiveLimitUsd: effective,
			spentThisMonthUsd: spent,
			remainingUsd: effective === null ? null : Math.max(0, Math.round((effective - spent) * 1e6) / 1e6),
			exhausted: effective !== null && spent >= effective,
		},
		usage30d: {
			costUsd: Number(row.last30_usd),
			tokens: Number(row.tokens30),
			turns: Number(row.turns30),
		},
		sessions: Number(row.sessions),
		lastChatAt: row.last_chat_at,
	};
}

export type AdminUser = ReturnType<typeof shape>;

async function defaultMonthlyCredit(): Promise<number | null> {
	const value = await settingValue("credit.defaultMonthlyUsd");
	return typeof value === "number" ? value : null;
}

/** The calendar month credit is counted over, as the database sees "now". */
async function creditPeriod(): Promise<{ start: string; resetsAt: string }> {
	const row = await queryOne<{ start: string; resets_at: string }>(
		`SELECT date_trunc('month', now()) AS start,
		        date_trunc('month', now()) + interval '1 month' AS resets_at`,
	);
	return { start: row!.start, resetsAt: row!.resets_at };
}

export async function listUsers(): Promise<{
	users: AdminUser[];
	defaultMonthlyCreditUsd: number | null;
	period: { start: string; resetsAt: string };
}> {
	const [rows, defaultMonthly, period] = await Promise.all([
		query<UserRow>(`${USER_SELECT} ORDER BY u.username`),
		defaultMonthlyCredit(),
		creditPeriod(),
	]);
	return { users: rows.map((row) => shape(row, defaultMonthly)), defaultMonthlyCreditUsd: defaultMonthly, period };
}

async function userById(id: number): Promise<AdminUser> {
	if (!Number.isInteger(id) || id <= 0) throw new AdminError("No such user.", 404);
	const row = await queryOne<UserRow>(`${USER_SELECT} WHERE u.app_user_id = $1`, [id]);
	if (!row) throw new AdminError("No such user.", 404);
	return shape(row, await defaultMonthlyCredit());
}

async function activeAdminCount(): Promise<number> {
	const row = await queryOne<{ n: string }>(
		"SELECT count(*)::text AS n FROM platform.app_user WHERE role = 'admin' AND is_active",
	);
	return Number(row?.n ?? 0);
}

async function recordEvent(actor: string, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
	await query(
		`INSERT INTO platform.admin_event (actor, action, target, detail) VALUES ($1, $2, $3, $4::jsonb)`,
		[actor, action, target, JSON.stringify(detail)],
	);
}

/** Who is acting, as the route handlers pass it. */
export interface Actor {
	userId: number;
	username: string;
}

export async function createUser(body: unknown, actor: Actor): Promise<AdminUser> {
	const { input, errors } = validateNewUser(body);
	if (!input) throw new AdminError(errors.join(" "), 400);
	const hash = await hashPassword(input.password);
	let created: { app_user_id: number } | null;
	try {
		created = await queryOne<{ app_user_id: number }>(
			`INSERT INTO platform.app_user
			   (username, display_name, email, password_hash, role, ontology_role,
			    signup_source, credit_mode, credit_limit_usd)
			 VALUES ($1, $2, $3, $4, $5, $6, 'admin', $7, $8)
			 ON CONFLICT (username) DO NOTHING
			 RETURNING app_user_id`,
			[
				input.username,
				input.displayName ?? input.username,
				input.email,
				hash,
				input.role,
				input.ontologyRole,
				input.creditMode,
				input.creditLimitUsd,
			],
		);
	} catch (error) {
		// The email index is the other unique constraint an insert can hit.
		if ((error as { code?: string }).code === "23505") {
			throw new AdminError("That email address is already used by another account.", 409);
		}
		throw error;
	}
	if (!created) throw new AdminError(`The username '${input.username}' is already taken.`, 409);
	// The same private workspace registration gives, so the account is ready
	// the first time its owner signs in.
	await ensurePersonalSpace({ username: input.username });
	await recordEvent(actor.username, "user.created", input.username, {
		role: input.role,
		ontologyRole: input.ontologyRole,
		credit: { mode: input.creditMode, limitUsd: input.creditLimitUsd },
	});
	return userById(Number(created.app_user_id));
}

export async function updateUser(id: number, body: unknown, actor: Actor): Promise<AdminUser> {
	const { patch, errors } = validateUserPatch(body);
	if (!patch) throw new AdminError(errors.join(" "), 400);
	const current = await userById(id);
	const targetIsActiveAdmin = current.role === "admin" && current.isActive;

	const demoting = patch.role !== undefined && patch.role !== "admin" && current.role === "admin";
	const disabling = patch.isActive === false && current.isActive;
	for (const [change, happening] of [["demote", demoting], ["disable", disabling]] as const) {
		if (!happening) continue;
		const problem = lockoutProblem({
			actorId: actor.userId,
			targetId: id,
			targetIsActiveAdmin,
			activeAdmins: await activeAdminCount(),
			change,
		});
		if (problem) throw new AdminError(problem, 409);
	}

	const sets: string[] = [];
	const params: unknown[] = [];
	const set = (column: string, value: unknown) => {
		params.push(value);
		sets.push(`${column} = $${params.length}`);
	};
	if (patch.displayName !== undefined) set("display_name", patch.displayName);
	if (patch.email !== undefined) set("email", patch.email);
	if (patch.role !== undefined) set("role", patch.role);
	if (patch.ontologyRole !== undefined) set("ontology_role", patch.ontologyRole);
	if (patch.isActive !== undefined) set("is_active", patch.isActive);
	if (patch.creditMode !== undefined) {
		set("credit_mode", patch.creditMode);
		set("credit_limit_usd", patch.creditLimitUsd ?? null);
	}
	// Disabling also revokes: access stops now, not when the token expires.
	if (disabling) sets.push("token_version = token_version + 1");

	params.push(id);
	try {
		await query(`UPDATE platform.app_user SET ${sets.join(", ")} WHERE app_user_id = $${params.length}`, params);
	} catch (error) {
		if ((error as { code?: string }).code === "23505") {
			throw new AdminError("That email address is already used by another account.", 409);
		}
		throw error;
	}
	// The change applies to this process's next request rather than after the
	// cache TTL; the assistant service picks it up within its own.
	clearUserCache();

	// What actually changed, in the patch's own vocabulary, for the record.
	const before: Record<string, unknown> = {
		displayName: current.displayName,
		email: current.email,
		role: current.role,
		ontologyRole: current.ontologyRole,
		isActive: current.isActive,
		creditMode: current.credit.mode,
		creditLimitUsd: current.credit.limitUsd,
	};
	const changed = Object.fromEntries(
		Object.entries(patch)
			.filter(([key, value]) => before[key] !== (value ?? null))
			.map(([key, value]) => [key, { from: before[key] ?? null, to: value ?? null }]),
	);
	await recordEvent(actor.username, "user.updated", current.username, changed);
	return userById(id);
}

export async function resetPassword(id: number, body: unknown, actor: Actor): Promise<AdminUser> {
	const current = await userById(id);
	const password = typeof (body as { password?: unknown })?.password === "string" ? (body as { password: string }).password : "";
	const problems = passwordProblems(current.username, password);
	if (problems.length) throw new AdminError(problems.join(" "), 400);
	// A new password ends every session the old one opened.
	await query(
		`UPDATE platform.app_user
		    SET password_hash = $1, token_version = token_version + 1
		  WHERE app_user_id = $2`,
		[await hashPassword(password), id],
	);
	clearUserCache();
	await recordEvent(actor.username, "user.password_reset", current.username);
	return userById(id);
}

/** Sign someone out everywhere: every token issued to them stops working. */
export async function revokeSessions(id: number, actor: Actor): Promise<AdminUser> {
	const current = await userById(id);
	await query("UPDATE platform.app_user SET token_version = token_version + 1 WHERE app_user_id = $1", [id]);
	clearUserCache();
	await recordEvent(actor.username, "user.signed_out", current.username);
	return userById(id);
}

/**
 * Remove an account.
 *
 * The account row goes; what it owned stays, re-labelled to a name nobody can
 * sign in as (see tombstone): the personal workspace, chat sessions (with
 * their cost records, which a spend report must keep) and notes. Shared-space
 * memberships are removed, since they only grant access.
 *
 * Kept is not the same as kept running. With nobody left to answer for the
 * workspace, the platform stops acting for it: its scheduled refreshes are
 * switched off, and the database passwords it stored are removed - so nothing
 * goes on dialling a deleted person's database with a password they left
 * here. What had already been synced stays where it is.
 */
export async function deleteUser(
	id: number,
	actor: Actor,
): Promise<{ deleted: string; keptAs: string; schedulesStopped: number; passwordsRemoved: number }> {
	const current = await userById(id);
	const problem = lockoutProblem({
		actorId: actor.userId,
		targetId: id,
		targetIsActiveAdmin: current.role === "admin" && current.isActive,
		activeAdmins: await activeAdminCount(),
		change: "delete",
	});
	if (problem) throw new AdminError(problem, 409);

	const keptAs = tombstone(current.username, id);
	const owned = "SELECT space_id FROM platform.space WHERE kind = 'personal' AND owner_username = $1";
	let schedulesStopped = 0;
	let passwordsRemoved = 0;
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const stopped = await client.query(
			`UPDATE platform.schedule SET enabled = false WHERE enabled AND space_id IN (${owned})`,
			[current.username],
		);
		const forgotten = await client.query(`DELETE FROM platform.credential WHERE space_id IN (${owned})`, [
			current.username,
		]);
		schedulesStopped = stopped.rowCount ?? 0;
		passwordsRemoved = forgotten.rowCount ?? 0;
		await client.query(
			`UPDATE platform.space
			    SET owner_username = $2, name = name || ' (deleted account)'
			  WHERE kind = 'personal' AND owner_username = $1`,
			[current.username, keptAs],
		);
		await client.query("DELETE FROM platform.space_member WHERE username = $1", [current.username]);
		await client.query("UPDATE platform.chat_session SET user_id = $2 WHERE user_id = $1", [current.username, keptAs]);
		await client.query("UPDATE platform.notepad_document SET user_id = $2 WHERE user_id = $1", [current.username, keptAs]);
		await client.query("DELETE FROM platform.app_user WHERE app_user_id = $1", [id]);
		await client.query(
			`INSERT INTO platform.admin_event (actor, action, target, detail) VALUES ($1, 'user.deleted', $2, $3::jsonb)`,
			[
				actor.username,
				current.username,
				JSON.stringify({ keptAs, role: current.role, schedulesStopped, passwordsRemoved }),
			],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
	clearUserCache();
	invalidateSpaceCache();
	return { deleted: current.username, keptAs, schedulesStopped, passwordsRemoved };
}

// ── overview and activity ───────────────────────────────────────────────────

export async function adminOverview(): Promise<{
	users: { total: number; active: number; disabled: number; admins: number; analysts: number; viewers: number; selfRegistered: number };
	spend: { todayUsd: number; monthUsd: number; last30Usd: number; unpricedTurns30: number };
	activity: { turns30: number; tokens30: number; activeUsers30: number; sessions30: number };
	daily: Array<{ day: string; costUsd: number; turns: number }>;
	topSpenders: Array<{ username: string; monthUsd: number; turns30: number }>;
	period: { start: string; resetsAt: string };
	defaultMonthlyCreditUsd: number | null;
}> {
	const [users, spend, daily, top, period, defaultMonthly] = await Promise.all([
		queryOne<Record<string, string>>(
			`SELECT count(*)::text AS total,
			        count(*) FILTER (WHERE is_active)::text AS active,
			        count(*) FILTER (WHERE NOT is_active)::text AS disabled,
			        count(*) FILTER (WHERE role = 'admin')::text AS admins,
			        count(*) FILTER (WHERE role = 'analyst')::text AS analysts,
			        count(*) FILTER (WHERE role = 'viewer')::text AS viewers,
			        count(*) FILTER (WHERE signup_source = 'self')::text AS self_registered
			   FROM platform.app_user`,
		),
		queryOne<Record<string, string>>(
			`SELECT COALESCE(sum(m.cost_usd) FILTER (WHERE m.created_at >= date_trunc('day', now())), 0)::text AS today,
			        COALESCE(sum(m.cost_usd) FILTER (WHERE m.created_at >= date_trunc('month', now())), 0)::text AS month,
			        COALESCE(sum(m.cost_usd) FILTER (WHERE m.created_at >= now() - interval '30 days'), 0)::text AS last30,
			        count(*) FILTER (WHERE m.created_at >= now() - interval '30 days' AND m.cost_usd IS NULL
			                         AND COALESCE(m.total_tokens, 0) > 0)::text AS unpriced30,
			        count(*) FILTER (WHERE m.created_at >= now() - interval '30 days')::text AS turns30,
			        COALESCE(sum(m.total_tokens) FILTER (WHERE m.created_at >= now() - interval '30 days'), 0)::text AS tokens30,
			        count(DISTINCT s.user_id) FILTER (WHERE m.created_at >= now() - interval '30 days')::text AS users30,
			        count(DISTINCT s.chat_session_id) FILTER (WHERE m.created_at >= now() - interval '30 days')::text AS sessions30
			   FROM platform.chat_message m
			   JOIN platform.chat_session s USING (chat_session_id)
			  WHERE m.role = 'assistant'`,
		),
		query<{ day: string; cost: string; turns: string }>(
			`SELECT d::date::text AS day,
			        COALESCE(sum(m.cost_usd), 0)::text AS cost,
			        count(m.chat_message_id)::text AS turns
			   FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS d
			   LEFT JOIN platform.chat_message m
			     ON m.role = 'assistant' AND m.created_at >= d AND m.created_at < d + interval '1 day'
			  GROUP BY d ORDER BY d`,
		),
		query<{ username: string; month: string; turns30: string }>(
			`SELECT s.user_id AS username,
			        COALESCE(sum(m.cost_usd) FILTER (WHERE m.created_at >= date_trunc('month', now())), 0)::text AS month,
			        count(*) FILTER (WHERE m.created_at >= now() - interval '30 days')::text AS turns30
			   FROM platform.chat_message m
			   JOIN platform.chat_session s USING (chat_session_id)
			  WHERE m.role = 'assistant'
			  GROUP BY s.user_id
			  ORDER BY 2 DESC, 3 DESC
			  LIMIT 5`,
		),
		creditPeriod(),
		defaultMonthlyCredit(),
	]);
	const n = (value: string | undefined) => Number(value ?? 0);
	return {
		users: {
			total: n(users?.total),
			active: n(users?.active),
			disabled: n(users?.disabled),
			admins: n(users?.admins),
			analysts: n(users?.analysts),
			viewers: n(users?.viewers),
			selfRegistered: n(users?.self_registered),
		},
		spend: {
			todayUsd: n(spend?.today),
			monthUsd: n(spend?.month),
			last30Usd: n(spend?.last30),
			unpricedTurns30: n(spend?.unpriced30),
		},
		activity: {
			turns30: n(spend?.turns30),
			tokens30: n(spend?.tokens30),
			activeUsers30: n(spend?.users30),
			sessions30: n(spend?.sessions30),
		},
		daily: daily.map((row) => ({ day: row.day, costUsd: Number(row.cost), turns: Number(row.turns) })),
		topSpenders: top.map((row) => ({ username: row.username, monthUsd: Number(row.month), turns30: Number(row.turns30) })),
		period,
		defaultMonthlyCreditUsd: defaultMonthly,
	};
}

export async function listEvents(limit = 50): Promise<
	Array<{ id: number; actor: string; action: string; target: string | null; detail: Record<string, unknown>; createdAt: string }>
> {
	const rows = await query<{
		admin_event_id: string;
		actor: string;
		action: string;
		target: string | null;
		detail: Record<string, unknown>;
		created_at: string;
	}>(
		`SELECT admin_event_id, actor, action, target, detail, created_at
		   FROM platform.admin_event ORDER BY created_at DESC, admin_event_id DESC LIMIT $1`,
		[Math.min(Math.max(limit, 1), 200)],
	);
	return rows.map((row) => ({
		id: Number(row.admin_event_id),
		actor: row.actor,
		action: row.action,
		target: row.target,
		detail: row.detail ?? {},
		createdAt: row.created_at,
	}));
}
