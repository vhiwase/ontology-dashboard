/**
 * Tests for the admin console's rules: who may reach it, what an account form
 * accepts, how credit resolves, what a deleted account's data is re-labelled
 * to, the lock-out guard and settings validation.
 *
 * All pure: nothing here touches the database.
 */

import { describe, expect, it, vi } from "vitest";

// auth.ts reads its signing secret when it is imported.
vi.hoisted(() => {
	process.env.AUTH_JWT_SECRET ??= "test-secret-at-least-thirty-two-characters-long";
});
import {
	effectiveCreditLimit,
	lockoutProblem,
	parseCredit,
	passwordProblems,
	tombstone,
	validateNewUser,
	validateSettings,
	validateUserPatch,
} from "./admin";
import { authorizeRoute, requiredRoleFor, type Principal, type SpaceAccess } from "./auth";

// ── who may reach the console ───────────────────────────────────────────────

function principal(role: Principal["role"], signupSource: Principal["signupSource"] = "admin"): Principal {
	return { userId: 7, username: "maria", role, ontologyRole: "tms:AnalystRole", signupSource };
}

/** Run the real route guard against a fake request, and report what it did. */
function guard(method: string, path: string, who: Principal, access?: SpaceAccess) {
	const result = { status: 200, passed: false, body: null as unknown };
	const res = {
		status(code: number) {
			result.status = code;
			return this;
		},
		json(body: unknown) {
			result.body = body;
			return this;
		},
	};
	authorizeRoute()({ method, path, principal: who, spaceAccess: access } as never, res as never, () => {
		result.passed = true;
	});
	return result;
}

const OWN_WORKSPACE: SpaceAccess = { slug: "u-maria", kind: "personal", isOwner: true, memberRole: null };

describe("the admin console's route policy", () => {
	it("needs the admin role for every verb", () => {
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
			expect(requiredRoleFor(method, "/admin/users")).toBe("admin");
			expect(requiredRoleFor(method, "/admin")).toBe("admin");
		}
		expect(requiredRoleFor("DELETE", "/admin/users/12")).toBe("admin");
	});

	it("is refused to an analyst even in the workspace they own", () => {
		// Owning a personal workspace makes its owner "admin" of it. That must
		// never extend to everyone's accounts.
		for (const [method, path] of [
			["GET", "/admin/users"],
			["POST", "/admin/users"],
			["PATCH", "/admin/users/1"],
			["DELETE", "/admin/users/1"],
			["PUT", "/admin/settings"],
		]) {
			const outcome = guard(method!, path!, principal("analyst", "self"), OWN_WORKSPACE);
			expect(outcome.passed, `${method} ${path}`).toBe(false);
			expect(outcome.status).toBe(403);
		}
	});

	it("is refused to an analyst and a viewer in a shared space", () => {
		const shared: SpaceAccess = { slug: "sandbox", kind: "environment", isOwner: false, memberRole: "editor" };
		expect(guard("GET", "/admin/overview", principal("analyst"), shared).passed).toBe(false);
		expect(guard("GET", "/admin/overview", principal("viewer"), shared).passed).toBe(false);
	});

	it("admits a platform admin", () => {
		expect(guard("GET", "/admin/users", principal("admin"), OWN_WORKSPACE).passed).toBe(true);
		expect(guard("DELETE", "/admin/users/3", principal("admin")).passed).toBe(true);
	});

	it("leaves routes that merely start with 'admin' alone", () => {
		expect(requiredRoleFor("GET", "/administrators")).toBe("viewer");
	});
});

// ── accounts ────────────────────────────────────────────────────────────────

const GOOD = {
	username: "Jo.Dispatch",
	password: "a-long-passphrase-42",
	displayName: "  Jo  ",
	email: "jo@example.com",
	role: "analyst",
};

describe("validateNewUser", () => {
	it("accepts a complete form and normalises it", () => {
		const { input, errors } = validateNewUser(GOOD);
		expect(errors).toEqual([]);
		expect(input).toMatchObject({
			username: "jo.dispatch",
			displayName: "Jo",
			role: "analyst",
			ontologyRole: "tms:AnalystRole",
			creditMode: "default",
			creditLimitUsd: null,
		});
	});

	it("gives an admin the admin business role unless another is named", () => {
		expect(validateNewUser({ ...GOOD, role: "admin" }).input?.ontologyRole).toBe("tms:AdminRole");
		expect(validateNewUser({ ...GOOD, role: "admin", ontologyRole: "tms:FinanceRole" }).input?.ontologyRole).toBe(
			"tms:FinanceRole",
		);
	});

	it("reports every problem at once", () => {
		const { input, errors } = validateNewUser({ username: "x", password: "short", role: "owner", ontologyRole: "tms:Nope" });
		expect(input).toBeNull();
		expect(errors.join(" ")).toMatch(/Username must be/);
		expect(errors.join(" ")).toMatch(/at least 12 characters/);
		expect(errors.join(" ")).toMatch(/Role must be/);
		expect(errors.join(" ")).toMatch(/Business role/);
	});

	it("holds names that appear in audit records reserved", () => {
		expect(validateNewUser({ ...GOOD, username: "pipeline" }).errors.join(" ")).toMatch(/reserved/);
	});

	it("takes a custom credit, rounded to the cent", () => {
		const { input } = validateNewUser({ ...GOOD, creditMode: "custom", creditLimitUsd: 12.345 });
		expect(input).toMatchObject({ creditMode: "custom", creditLimitUsd: 12.35 });
	});
});

describe("validateUserPatch", () => {
	it("changes only what is sent", () => {
		expect(validateUserPatch({ role: "viewer" }).patch).toEqual({ role: "viewer" });
		expect(validateUserPatch({ email: "" }).patch).toEqual({ email: null });
		expect(validateUserPatch({ displayName: "  " }).patch).toEqual({ displayName: null });
	});

	it("refuses an empty or malformed edit", () => {
		expect(validateUserPatch({}).errors).toEqual(["Nothing to change."]);
		expect(validateUserPatch({ email: "not-an-email" }).patch).toBeNull();
		expect(validateUserPatch({ isActive: "yes" }).patch).toBeNull();
		expect(validateUserPatch({ role: "root" }).patch).toBeNull();
	});

	it("clears the amount when credit stops being custom", () => {
		expect(validateUserPatch({ creditMode: "unlimited", creditLimitUsd: 9 }).patch).toEqual({
			creditMode: "unlimited",
			creditLimitUsd: null,
		});
	});
});

describe("passwordProblems", () => {
	it("applies registration's rules", () => {
		expect(passwordProblems("jo", "a-long-passphrase-42")).toEqual([]);
		expect(passwordProblems("jo", "short")).toHaveLength(1);
		expect(passwordProblems("maria", "MARIA-is-my-password")[0]).toMatch(/must not contain the username/);
		expect(passwordProblems("jo", "aaaaaaaaaaaaaaaa").join(" ")).toMatch(/repetitive/);
	});
});

// ── credit ──────────────────────────────────────────────────────────────────

describe("credit", () => {
	it("resolves a person's limit from their mode and the platform default", () => {
		expect(effectiveCreditLimit("default", null, 25)).toBe(25);
		expect(effectiveCreditLimit("default", null, null)).toBeNull();
		expect(effectiveCreditLimit("unlimited", null, 25)).toBeNull();
		expect(effectiveCreditLimit("custom", 5, 25)).toBe(5);
		// Zero is a limit - "no AI spend" - not the absence of one.
		expect(effectiveCreditLimit("custom", 0, null)).toBe(0);
	});

	it("refuses a negative, absurd or missing custom amount", () => {
		for (const creditLimitUsd of [-1, 2_000_000, undefined, "abc", Number.NaN]) {
			const errors: string[] = [];
			expect(parseCredit({ creditMode: "custom", creditLimitUsd }, errors)).toBeUndefined();
			expect(errors).toHaveLength(1);
		}
	});

	it("reads an amount typed as text", () => {
		expect(parseCredit({ creditMode: "custom", creditLimitUsd: "7.5" }, [])).toEqual({ mode: "custom", limitUsd: 7.5 });
	});
});

// ── deleting and locking out ────────────────────────────────────────────────

describe("tombstone", () => {
	it("is a name nobody can register or sign in as", () => {
		const label = tombstone("bob", 12);
		expect(label).toBe("bob (deleted #12)");
		expect(validateNewUser({ ...GOOD, username: label }).errors.join(" ")).toMatch(/Username must be/);
	});
});

describe("lockoutProblem", () => {
	const base = { actorId: 1, targetId: 2, targetIsActiveAdmin: false, activeAdmins: 2 };

	it("stops anyone removing their own access", () => {
		expect(lockoutProblem({ ...base, targetId: 1, change: "delete" })).toMatch(/your own account/);
		expect(lockoutProblem({ ...base, targetId: 1, change: "demote" })).toMatch(/your own account/);
	});

	it("keeps at least one active administrator", () => {
		expect(lockoutProblem({ ...base, targetIsActiveAdmin: true, activeAdmins: 1, change: "disable" })).toMatch(
			/only active administrator/,
		);
		expect(lockoutProblem({ ...base, targetIsActiveAdmin: true, activeAdmins: 2, change: "disable" })).toBeNull();
	});

	it("lets another account be removed", () => {
		expect(lockoutProblem({ ...base, change: "delete" })).toBeNull();
	});
});

// ── settings ────────────────────────────────────────────────────────────────

describe("validateSettings", () => {
	it("accepts known settings, and null as 'back to the default'", () => {
		const { values, errors } = validateSettings({
			values: {
				"assistant.defaultModel": "builtin",
				"pricing.azureInputPerMillion": "2.5",
				"credit.defaultMonthlyUsd": 10,
				"registration.enabled": false,
				"registration.defaultRole": null,
			},
		});
		expect(errors).toEqual([]);
		expect(Object.fromEntries(values!)).toEqual({
			"assistant.defaultModel": "builtin",
			"pricing.azureInputPerMillion": 2.5,
			"credit.defaultMonthlyUsd": 10,
			"registration.enabled": false,
			"registration.defaultRole": null,
		});
	});

	it("changes nothing when any value is wrong", () => {
		const { values, errors } = validateSettings({
			values: { "assistant.defaultModel": "gpt-9", "registration.enabled": "yes", "credit.defaultMonthlyUsd": -5 },
		});
		expect(values).toBeNull();
		expect(errors).toHaveLength(3);
	});

	it("names an unknown key and refuses a malformed body", () => {
		expect(validateSettings({ values: { "theme.colour": "red" } }).errors).toEqual(["Unknown setting: theme.colour."]);
		expect(validateSettings({}).values).toBeNull();
		expect(validateSettings({ values: {} }).errors).toEqual(["Nothing to change."]);
	});
});
