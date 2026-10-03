/**
 * The admin console.
 *
 * For the platform's administrators only: who has an account and what each
 * may do, what the assistant is costing and who is spending it, the monthly
 * credit each person gets, and the defaults everyone starts from. The same
 * admin sign-in opens it; there is no second password.
 *
 * Hiding this page from everyone else is a courtesy. The control is on the
 * server, which refuses every /api/admin request that is not a platform admin.
 *
 * Every figure here is read from the platform's own records - accounts, and
 * the cost stored on each assistant turn when it was answered.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, session } from "../api";
import { SettingsPanel } from "../components/admin/SettingsPanel";
import { UsersPanel } from "../components/admin/UsersPanel";
import {
	type AdminEvent,
	type AdminOverview,
	type UserList,
	dateTime,
	dayAndMonth,
	usd,
} from "../components/admin/types";
import { Chart } from "../components/Chart";
import { ErrorBanner, PageLoader, Spinner } from "../components/common";
import { Icon, type IconName } from "../components/icons";

type Tab = "overview" | "users" | "defaults" | "activity";

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
	{ id: "overview", label: "Overview", icon: "gauge" },
	{ id: "users", label: "Users", icon: "users" },
	{ id: "defaults", label: "Defaults", icon: "sliders" },
	{ id: "activity", label: "Activity", icon: "activity" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-03" as "3 Oct", without a timezone shifting the day. */
function shortDay(iso: string): string {
	const [, month, date] = iso.split("-");
	return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ""}`;
}

export function Admin() {
	const [params, setParams] = useSearchParams();
	const requested = params.get("tab") as Tab | null;
	const tab: Tab = TABS.some((entry) => entry.id === requested) ? (requested as Tab) : "overview";
	const [overview, setOverview] = useState<AdminOverview | null>(null);
	const [users, setUsers] = useState<UserList | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Bumped by every change, so the activity log is read again when opened.
	const [revision, setRevision] = useState(0);
	const me = session.user()?.username ?? "";

	// Resolves once what was read is on the page (or the failure is), so a form
	// that has just saved can wait for the account as the server stored it.
	const load = useCallback((): Promise<void> => {
		setError(null);
		return Promise.all([api.get<AdminOverview>("/api/admin/overview"), api.get<UserList>("/api/admin/users")])
			.then(([nextOverview, nextUsers]) => {
				setOverview(nextOverview);
				setUsers(nextUsers);
			})
			.catch((exc: Error) => setError(exc.message));
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const changed = useCallback((): Promise<void> => {
		setRevision((current) => current + 1);
		return load();
	}, [load]);

	const go = (next: Tab) => setParams(next === "overview" ? {} : { tab: next }, { replace: true });

	return (
		<div className="col admin" style={{ gap: 16 }}>
			<div className="page-head">
				<div>
					<h1>Admin console</h1>
					<p className="page-lede">
						Accounts, AI credit and the defaults everyone starts from. Only platform administrators can open this.
					</p>
				</div>
				<button className="btn" onClick={() => void changed()} title="Read everything again">
					<Icon name="refresh" size={14} />
					Refresh
				</button>
			</div>

			<div className="tabs" role="tablist" aria-label="Admin console sections">
				{TABS.map((entry) => (
					<button
						key={entry.id}
						role="tab"
						aria-selected={tab === entry.id}
						className={tab === entry.id ? "active" : ""}
						onClick={() => go(entry.id)}
					>
						<Icon name={entry.icon} size={14} />
						{entry.label}
						{entry.id === "users" && users && <span className="tab-count">{users.users.length}</span>}
					</button>
				))}
			</div>

			{error && <ErrorBanner error={error} onRetry={load} />}

			{tab === "overview" &&
				(overview && users ? (
					<Overview overview={overview} users={users} onOpen={go} />
				) : (
					!error && <PageLoader label="Loading the console" />
				))}

			{tab === "users" &&
				(users ? <UsersPanel data={users} me={me} onChanged={changed} /> : !error && <PageLoader label="Loading accounts" />)}

			{tab === "defaults" && <SettingsPanel onChanged={changed} />}

			{tab === "activity" && <Activity revision={revision} />}
		</div>
	);
}

function Overview({
	overview,
	users,
	onOpen,
}: {
	overview: AdminOverview;
	users: UserList;
	onOpen: (tab: Tab) => void;
}) {
	const usedUp = users.users.filter((user) => user.credit.exhausted);
	const nearly = users.users.filter(
		(user) =>
			!user.credit.exhausted &&
			user.credit.effectiveLimitUsd !== null &&
			user.credit.effectiveLimitUsd > 0 &&
			user.credit.spentThisMonthUsd / user.credit.effectiveLimitUsd >= 0.8,
	);
	const neverSignedIn = users.users.filter((user) => user.isActive && !user.lastLoginAt);
	const spenders = overview.topSpenders.filter((row) => row.monthUsd > 0 || row.turns30 > 0);
	const peak = Math.max(...spenders.map((row) => row.monthUsd), 0);
	const quiet = overview.daily.every((row) => row.costUsd === 0);

	const attention: Array<{ tone: string; text: string; action?: { label: string; tab: Tab } }> = [];
	if (usedUp.length > 0) {
		attention.push({
			tone: "critical",
			text: `${usedUp.length} ${usedUp.length === 1 ? "person has" : "people have"} used up this month's AI credit: ${usedUp
				.slice(0, 4)
				.map((user) => user.username)
				.join(", ")}${usedUp.length > 4 ? "…" : ""}. The assistant refuses their questions until ${dayAndMonth(overview.period.resetsAt)} or until the limit is raised.`,
			action: { label: "Review limits", tab: "users" },
		});
	}
	if (nearly.length > 0) {
		attention.push({
			tone: "warn",
			text: `${nearly.length} ${nearly.length === 1 ? "person is" : "people are"} past 80% of this month's credit: ${nearly
				.slice(0, 4)
				.map((user) => user.username)
				.join(", ")}${nearly.length > 4 ? "…" : ""}.`,
			action: { label: "Review limits", tab: "users" },
		});
	}
	if (overview.defaultMonthlyCreditUsd === null) {
		attention.push({
			tone: "",
			text: "No default monthly credit is set, so an account without its own limit can spend without one.",
			action: { label: "Set a default", tab: "defaults" },
		});
	}
	if (overview.spend.unpricedTurns30 > 0) {
		attention.push({
			tone: "warn",
			text: `${overview.spend.unpricedTurns30} turn${overview.spend.unpricedTurns30 === 1 ? "" : "s"} in the last 30 days used tokens but could not be priced, so the spend below is a floor rather than a complete total.`,
		});
	}
	if (neverSignedIn.length > 0) {
		attention.push({
			tone: "",
			text: `${neverSignedIn.length} active account${neverSignedIn.length === 1 ? " has" : "s have"} never signed in.`,
			action: { label: "See accounts", tab: "users" },
		});
	}

	return (
		<div className="col" style={{ gap: 14 }}>
			<div className="cost-tiles">
				<div className="cost-tile">
					<span className="stage-icon" aria-hidden>
						<Icon name="users" size={15} />
					</span>
					<div className="cost-value num">{overview.users.total.toLocaleString("en-US")}</div>
					<div className="cost-label">
						Accounts · {overview.users.active} active
						{overview.users.disabled > 0 ? ` · ${overview.users.disabled} disabled` : ""}
					</div>
				</div>
				<div className="cost-tile">
					<span className="stage-icon" aria-hidden>
						<Icon name="wallet" size={15} />
					</span>
					<div className="cost-value num">{usd(overview.spend.monthUsd)}</div>
					<div className="cost-label">AI spend since {dayAndMonth(overview.period.start)}</div>
				</div>
				<div className="cost-tile">
					<span className="stage-icon" aria-hidden>
						<Icon name="dollar" size={15} />
					</span>
					<div className="cost-value num">{usd(overview.spend.todayUsd)}</div>
					<div className="cost-label">AI spend today</div>
				</div>
				<div className="cost-tile">
					<span className="stage-icon" aria-hidden>
						<Icon name="message" size={15} />
					</span>
					<div className="cost-value num">{overview.activity.turns30.toLocaleString("en-US")}</div>
					<div className="cost-label">
						Questions answered in 30 days · {overview.activity.activeUsers30}{" "}
						{overview.activity.activeUsers30 === 1 ? "person" : "people"}
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<h3>Needs attention</h3>
				</div>
				{attention.length === 0 ? (
					<p className="muted admin-clear">
						<Icon name="checkCircle" size={15} /> Nothing does. Everyone is inside their credit.
					</p>
				) : (
					<ul className="attention-list">
						{attention.map((item) => (
							<li key={item.text} className={`attention-item ${item.tone}`}>
								<span className="attention-mark" aria-hidden>
									<Icon name={item.tone ? "alertTriangle" : "info"} size={14} />
								</span>
								<span className="attention-text">{item.text}</span>
								{item.action && (
									<button className="btn sm" onClick={() => onOpen(item.action!.tab)}>
										{item.action.label}
										<Icon name="arrowRight" size={13} />
									</button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="admin-two">
				<div className="card">
					<div className="card-head">
						<h3>AI spend per day</h3>
						<span className="sub">last 30 days · {usd(overview.spend.last30Usd)} in total</span>
					</div>
					{quiet ? (
						<div className="empty">
							<span className="empty-icon" aria-hidden>
								<Icon name="barChart" size={18} />
							</span>
							<p>Nothing was spent on the assistant in the last 30 days.</p>
						</div>
					) : (
						<Chart
							kind="bar"
							format="currency"
							height={220}
							points={overview.daily.map((row) => ({ label: row.day, value: row.costUsd }))}
							formatLabel={shortDay}
						/>
					)}
				</div>

				<div className="card">
					<div className="card-head">
						<h3>Who is spending</h3>
						<span className="sub">since {dayAndMonth(overview.period.start)}</span>
					</div>
					{spenders.length === 0 ? (
						<p className="muted">Nobody has used the assistant yet.</p>
					) : (
						<ul className="spender-list">
							{spenders.map((row) => (
								<li key={row.username}>
									<div className="spender-top">
										<span className="spender-name">{row.username}</span>
										<span className="num">{usd(row.monthUsd)}</span>
									</div>
									<span className="credit-track" aria-hidden>
										<span style={{ width: `${peak > 0 ? Math.max(2, Math.round((row.monthUsd / peak) * 100)) : 0}%` }} />
									</span>
									<span className="spender-sub">
										{row.turns30.toLocaleString("en-US")} question{row.turns30 === 1 ? "" : "s"} in 30 days
									</span>
								</li>
							))}
						</ul>
					)}
					<div className="admin-card-foot">
						<button className="link-button" onClick={() => onOpen("users")}>
							See every account
						</button>
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<h3>Accounts by role</h3>
					<span className="sub">
						{overview.users.selfRegistered} registered themselves · {overview.users.total - overview.users.selfRegistered}{" "}
						added by an administrator
					</span>
				</div>
				<div className="role-strip">
					{(
						[
							["Admins", overview.users.admins, "Everything, in every space"],
							["Analysts", overview.users.analysts, "Read, and use the assistant"],
							["Viewers", overview.users.viewers, "Read only"],
						] as const
					).map(([label, count, can]) => (
						<div className="role-tile" key={label}>
							<span className="role-count num">{count}</span>
							<span className="role-label">{label}</span>
							<span className="muted">{can}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

// ── activity ────────────────────────────────────────────────────────────────

const SETTING_LABELS: Record<string, string> = {
	"assistant.defaultModel": "the default AI model",
	"pricing.azureInputPerMillion": "the Azure OpenAI input price",
	"pricing.azureOutputPerMillion": "the Azure OpenAI output price",
	"credit.defaultMonthlyUsd": "the default monthly AI credit",
	"registration.enabled": "self-registration",
	"registration.defaultRole": "the role for new accounts",
};

const FIELD_LABELS: Record<string, string> = {
	displayName: "display name",
	email: "email",
	role: "role",
	ontologyRole: "business role",
	isActive: "status",
	creditMode: "credit",
	creditLimitUsd: "credit limit",
};

function shown(value: unknown): string {
	if (value === null || value === undefined || value === "") return "not set";
	if (value === true) return "on";
	if (value === false) return "off";
	return String(value);
}

/** One recorded change, as a sentence and the detail under it. */
function describe(event: AdminEvent): { icon: IconName; text: string; detail: string | null } {
	const target = event.target ?? "";
	const detail = event.detail ?? {};
	switch (event.action) {
		case "user.created":
			return { icon: "userPlus", text: `added ${target}`, detail: detail.role ? `as ${String(detail.role)}` : null };
		case "user.deleted":
			return {
				icon: "trash",
				text: `deleted ${target}`,
				detail: detail.keptAs ? `their data is kept as “${String(detail.keptAs)}”` : null,
			};
		case "user.password_reset":
			return { icon: "key", text: `set a new password for ${target}`, detail: "every session they had was signed out" };
		case "user.signed_out":
			return { icon: "logOut", text: `signed ${target} out everywhere`, detail: null };
		case "user.updated": {
			const changes = Object.entries(detail as Record<string, { from?: unknown; to?: unknown }>).map(([field, change]) =>
				field === "isActive"
					? change?.to === true
						? "enabled the account"
						: "disabled the account"
					: `${FIELD_LABELS[field] ?? field}: ${shown(change?.from)} → ${shown(change?.to)}`,
			);
			return { icon: "pencil", text: `changed ${target}`, detail: changes.join(" · ") || null };
		}
		case "setting.changed":
			return {
				icon: "sliders",
				text: `changed ${SETTING_LABELS[target] ?? target}`,
				detail: `${shown(detail.from)} → ${detail.to === null ? "the default" : shown(detail.to)}`,
			};
		default:
			return { icon: "activity", text: `${event.action} ${target}`.trim(), detail: null };
	}
}

function Activity({ revision }: { revision: number }) {
	const [events, setEvents] = useState<AdminEvent[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the trigger
	useEffect(() => {
		setError(null);
		api
			.get<{ events: AdminEvent[] }>("/api/admin/events?limit=100")
			.then((body) => setEvents(body.events))
			.catch((exc: Error) => setError(exc.message));
	}, [revision]);

	if (error) return <ErrorBanner error={error} />;
	if (!events) return <Spinner label="Loading the activity log" />;

	return (
		<div className="card">
			<div className="card-head">
				<h3>What administrators changed</h3>
				<span className="sub">latest {events.length}, newest first</span>
			</div>
			{events.length === 0 ? (
				<div className="empty">
					<span className="empty-icon" aria-hidden>
						<Icon name="activity" size={18} />
					</span>
					<p>Nothing has been changed from this console yet. Every change made here is recorded.</p>
				</div>
			) : (
				<ol className="event-list">
					{events.map((event) => {
						const words = describe(event);
						return (
							<li key={event.id} className="event">
								<span className="stage-icon" aria-hidden>
									<Icon name={words.icon} size={14} />
								</span>
								<div className="event-text">
									<span>
										<strong>{event.actor}</strong> {words.text}
									</span>
									{words.detail && <span className="muted">{words.detail}</span>}
								</div>
								<time className="muted event-time" dateTime={event.createdAt}>
									{dateTime(event.createdAt)}
								</time>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
