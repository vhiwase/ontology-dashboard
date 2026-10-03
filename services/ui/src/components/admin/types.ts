/**
 * What the admin console reads from /api/admin, and how it words money and
 * dates. Mirrors services/ontology-service/src/admin.ts.
 */

export type Role = "viewer" | "analyst" | "admin";
export type CreditMode = "default" | "unlimited" | "custom";

export const ROLE_LABELS: Record<Role, { label: string; can: string }> = {
	viewer: { label: "Viewer", can: "Reads dashboards and data. Cannot use the assistant or change anything." },
	analyst: { label: "Analyst", can: "Reads everything, uses the assistant, and builds in their own workspace." },
	admin: { label: "Admin", can: "Everything, in every space - including this console." },
};

/** Business hats, as the server allows them. */
export const ONTOLOGY_ROLES: Array<{ id: string; label: string }> = [
	{ id: "tms:AnalystRole", label: "Analyst" },
	{ id: "tms:DispatcherRole", label: "Dispatcher" },
	{ id: "tms:FinanceRole", label: "Finance" },
	{ id: "tms:OperationsManagerRole", label: "Operations manager" },
	{ id: "tms:AdminRole", label: "Administrator" },
];

/** The business hat a platform role gets when none is chosen. */
export const DEFAULT_ONTOLOGY_ROLE: Record<Role, string> = {
	viewer: "tms:AnalystRole",
	analyst: "tms:AnalystRole",
	admin: "tms:AdminRole",
};

export interface AdminUser {
	id: number;
	username: string;
	displayName: string | null;
	email: string | null;
	role: Role;
	ontologyRole: string;
	isActive: boolean;
	/** "self" for a registered account, "admin" for one created here or by the CLI. */
	signupSource: string;
	createdAt: string;
	lastLoginAt: string | null;
	credit: {
		mode: CreditMode;
		/** The account's own amount, when mode is "custom". */
		limitUsd: number | null;
		/** What actually applies this month. Null means no limit. */
		effectiveLimitUsd: number | null;
		spentThisMonthUsd: number;
		remainingUsd: number | null;
		exhausted: boolean;
	};
	usage30d: { costUsd: number; tokens: number; turns: number };
	sessions: number;
	lastChatAt: string | null;
}

export interface UserList {
	users: AdminUser[];
	defaultMonthlyCreditUsd: number | null;
	period: { start: string; resetsAt: string };
}

export interface AdminOverview {
	users: {
		total: number;
		active: number;
		disabled: number;
		admins: number;
		analysts: number;
		viewers: number;
		selfRegistered: number;
	};
	spend: { todayUsd: number; monthUsd: number; last30Usd: number; unpricedTurns30: number };
	activity: { turns30: number; tokens30: number; activeUsers30: number; sessions30: number };
	daily: Array<{ day: string; costUsd: number; turns: number }>;
	topSpenders: Array<{ username: string; monthUsd: number; turns30: number }>;
	period: { start: string; resetsAt: string };
	defaultMonthlyCreditUsd: number | null;
}

export type SettingValue = string | number | boolean | null;

export interface AdminSetting {
	key: string;
	label: string;
	description: string;
	group: "assistant" | "pricing" | "credit" | "registration";
	/** What applies now. */
	value: SettingValue;
	/** What an administrator set, or null when nobody has. */
	adminValue: SettingValue;
	source: string;
	/** What applies when the administrator's value is cleared. */
	fallback: SettingValue;
	fallbackSource: string;
	updatedBy: string | null;
	updatedAt: string | null;
}

export interface AdminEvent {
	id: number;
	actor: string;
	action: string;
	target: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

/** Sub-cent costs are normal for a single turn, so the precision follows the size. */
export function usd(value: number): string {
	if (value === 0) return "$0.00";
	if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function day(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function dayAndMonth(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

export function dateTime(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** "3 h ago" for something recent, the date for anything older. */
export function ago(iso: string | null): string {
	if (!iso) return "Never";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
	return day(iso);
}

/** How someone's monthly credit reads in one line. */
export function creditLine(user: AdminUser): string {
	const { credit } = user;
	if (credit.effectiveLimitUsd === null) return credit.mode === "unlimited" ? "No limit" : "No limit (no default set)";
	return `${usd(credit.spentThisMonthUsd)} of ${usd(credit.effectiveLimitUsd)}`;
}

/** A password an administrator can hand over: 20 characters, no look-alikes. */
export function generatePassword(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	const bytes = new Uint32Array(20);
	crypto.getRandomValues(bytes);
	let out = "";
	// 2^32 is not a multiple of the alphabet's length; the bias that leaves is
	// far below anything that matters for a password of this length.
	for (const value of bytes) out += alphabet[value % alphabet.length];
	return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}
