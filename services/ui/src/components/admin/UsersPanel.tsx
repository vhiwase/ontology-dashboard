/**
 * Accounts: who can sign in, what each may do, and what each may spend.
 *
 * One table to find someone, one window to manage them. Everything that takes
 * access away - disabling, signing out, deleting - says what it will do before
 * it does it, and deleting asks for the username to be typed, because it is the
 * one thing here that cannot be undone.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../../api";
import { Refusal } from "../common";
import { Icon } from "../icons";
import {
	type AdminUser,
	type CreditMode,
	DEFAULT_ONTOLOGY_ROLE,
	ONTOLOGY_ROLES,
	ROLE_LABELS,
	type Role,
	type UserList,
	ago,
	creditLine,
	dateTime,
	dayAndMonth,
	generatePassword,
	usd,
} from "./types";

const ROLES: Role[] = ["viewer", "analyst", "admin"];

function initials(user: { username: string; displayName: string | null }): string {
	const words = (user.displayName || user.username).trim().split(/[\s._-]+/).filter(Boolean);
	const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
	return letters.toUpperCase();
}

/** How much of this month's credit is used, as a bar with the figures beside it. */
export function CreditMeter({ user }: { user: AdminUser }) {
	const { credit } = user;
	const limit = credit.effectiveLimitUsd;
	const share = limit === null ? 0 : limit > 0 ? Math.min(1, credit.spentThisMonthUsd / limit) : 1;
	const tone = limit === null ? "" : credit.exhausted ? "out" : share >= 0.8 ? "low" : "";
	return (
		<div className={`credit-cell ${tone}`}>
			<div className="credit-cell-top">
				<span className="num">{limit === null ? usd(credit.spentThisMonthUsd) : creditLine(user)}</span>
				{credit.exhausted && <span className="chip critical">Used up</span>}
			</div>
			{limit === null ? (
				<span className="credit-cell-sub">{credit.mode === "unlimited" ? "No limit" : "No limit · no default set"}</span>
			) : (
				<>
					<span
						className="credit-track"
						role="img"
						aria-label={`${Math.round(share * 100)}% of the monthly credit used`}
					>
						<span style={{ width: `${Math.round(share * 100)}%` }} />
					</span>
					{/* The share is said in words too, so the bar's colour is never
					    the only thing carrying "nearly out". */}
					<span className="credit-cell-sub">
						{Math.round(share * 100)}% used · {credit.mode === "custom" ? "own limit" : "platform default"}
					</span>
				</>
			)}
		</div>
	);
}

export function UsersPanel({
	data,
	me,
	onChanged,
}: {
	data: UserList;
	/** The signed-in administrator's username. */
	me: string;
	/** Something was changed: re-read the lists. Resolves once they are read. */
	onChanged: () => void | Promise<void>;
}) {
	const [term, setTerm] = useState("");
	const [role, setRole] = useState<Role | "all">("all");
	const [adding, setAdding] = useState(false);
	const [managing, setManaging] = useState<number | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const shown = useMemo(() => {
		const needle = term.trim().toLowerCase();
		return data.users.filter(
			(user) =>
				(role === "all" || user.role === role) &&
				(!needle ||
					user.username.includes(needle) ||
					(user.displayName ?? "").toLowerCase().includes(needle) ||
					(user.email ?? "").toLowerCase().includes(needle)),
		);
	}, [data.users, term, role]);

	// The account being managed is read from the list each time, so the window
	// shows the saved state after every change rather than a stale copy.
	const managed = data.users.find((user) => user.id === managing) ?? null;
	const counts = useMemo(() => {
		const out: Record<string, number> = { all: data.users.length, viewer: 0, analyst: 0, admin: 0 };
		for (const user of data.users) out[user.role] = (out[user.role] ?? 0) + 1;
		return out;
	}, [data.users]);

	return (
		<div className="col" style={{ gap: 14 }}>
			<div className="card">
				<div className="card-head admin-toolbar">
					<input
						type="search"
						className="search-input"
						placeholder="Find by name, username or email…"
						value={term}
						onChange={(event) => setTerm(event.target.value)}
						aria-label="Find a user"
					/>
					<div className="segmented" role="radiogroup" aria-label="Role">
						{(["all", ...ROLES] as const).map((option) => (
							<button
								key={option}
								role="radio"
								aria-checked={role === option}
								className={role === option ? "active" : ""}
								onClick={() => setRole(option)}
							>
								{option === "all" ? "Everyone" : `${ROLE_LABELS[option].label}s`}
								<span className="tab-count">{counts[option] ?? 0}</span>
							</button>
						))}
					</div>
					<button className="btn primary" onClick={() => setAdding(true)}>
						<Icon name="userPlus" size={15} />
						Add user
					</button>
				</div>

				{notice && (
					<div className="banner admin-notice" role="status">
						<span>{notice}</span>
						<button className="link-button" onClick={() => setNotice(null)}>
							Dismiss
						</button>
					</div>
				)}

				{shown.length === 0 ? (
					<div className="empty">
						<span className="empty-icon" aria-hidden>
							<Icon name="users" size={18} />
						</span>
						<p>
							{data.users.length === 0
								? "No accounts yet."
								: "Nobody matches that. Clear the search or choose another role."}
						</p>
					</div>
				) : (
					<div className="table-wrap">
						<table className="dense admin-users">
							<thead>
								<tr>
									<th>User</th>
									<th>Role</th>
									<th>Status</th>
									<th>AI credit this month</th>
									<th>Last 30 days</th>
									<th>Last sign-in</th>
									<th aria-label="Manage" />
								</tr>
							</thead>
							<tbody>
								{shown.map((user) => (
									<tr key={user.id} className={user.isActive ? "" : "is-disabled"}>
										<td>
											<div className="admin-user">
												<span className="avatar-circle" aria-hidden>
													{initials(user)}
												</span>
												<div className="admin-user-text">
													<span className="admin-user-name">
														{user.displayName || user.username}
														{user.username === me && <span className="chip accent">You</span>}
													</span>
													<span className="admin-user-sub">
														@{user.username}
														{user.email ? ` · ${user.email}` : ""}
													</span>
												</div>
											</div>
										</td>
										<td>
											<span className={`chip ${user.role === "admin" ? "accent" : ""}`}>{ROLE_LABELS[user.role].label}</span>
										</td>
										<td>
											{user.isActive ? (
												<span className="chip good">
													<span className="dot" />
													Active
												</span>
											) : (
												<span className="chip">
													<span className="dot" />
													Disabled
												</span>
											)}
										</td>
										<td>
											<CreditMeter user={user} />
										</td>
										<td>
											<span className="num">{usd(user.usage30d.costUsd)}</span>
											<span className="admin-user-sub">
												{user.usage30d.turns.toLocaleString("en-US")} turn{user.usage30d.turns === 1 ? "" : "s"} ·{" "}
												{user.usage30d.tokens.toLocaleString("en-US")} tokens
											</span>
										</td>
										<td title={user.lastLoginAt ? dateTime(user.lastLoginAt) : undefined}>{ago(user.lastLoginAt)}</td>
										<td className="admin-row-action">
											<button className="btn sm" onClick={() => setManaging(user.id)}>
												<Icon name="pencil" size={13} />
												Manage
												<span className="sr-only"> {user.username}</span>
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<p className="muted admin-foot">
					Credit is counted over the calendar month: since {dayAndMonth(data.period.start)}, renewing on{" "}
					{dayAndMonth(data.period.resetsAt)}.{" "}
					{data.defaultMonthlyCreditUsd === null
						? "No platform default is set, so an account without its own limit has none."
						: `The platform default is ${usd(data.defaultMonthlyCreditUsd)} a month.`}
				</p>
			</div>

			{adding && (
				<AddUserDialog
					defaultMonthly={data.defaultMonthlyCreditUsd}
					onClose={() => setAdding(false)}
					onCreated={() => onChanged()}
				/>
			)}

			{managed && (
				<ManageUserDialog
					user={managed}
					isSelf={managed.username === me}
					defaultMonthly={data.defaultMonthlyCreditUsd}
					period={data.period}
					onClose={() => setManaging(null)}
					onChanged={onChanged}
					onDeleted={(message) => {
						setManaging(null);
						setNotice(message);
						onChanged();
					}}
				/>
			)}
		</div>
	);
}

// ── credit ──────────────────────────────────────────────────────────────────

interface CreditChoice {
	mode: CreditMode;
	/** As typed, so an unfinished number is not rewritten under the cursor. */
	amount: string;
}

function CreditFields({
	value,
	onChange,
	defaultMonthly,
}: {
	value: CreditChoice;
	onChange: (value: CreditChoice) => void;
	defaultMonthly: number | null;
}) {
	const name = useId();
	const options: Array<{ mode: CreditMode; label: string; detail: string }> = [
		{
			mode: "default",
			label: "Platform default",
			detail:
				defaultMonthly === null
					? "No default is set, so this means no limit until one is."
					: `${usd(defaultMonthly)} a month, and it follows the default if that changes.`,
		},
		{ mode: "custom", label: "Own limit", detail: "A monthly amount for this account only." },
		{ mode: "unlimited", label: "No limit", detail: "Never refused for spend. The cost is still recorded." },
	];
	return (
		<fieldset className="choice-list">
			<legend className="sr-only">Monthly AI credit</legend>
			{options.map((option) => (
				<label key={option.mode} className={`choice ${value.mode === option.mode ? "on" : ""}`}>
					<input
						type="radio"
						name={name}
						checked={value.mode === option.mode}
						onChange={() => onChange({ ...value, mode: option.mode })}
					/>
					<span className="choice-text">
						<span className="choice-label">{option.label}</span>
						<span className="choice-detail">{option.detail}</span>
					</span>
					{option.mode === "custom" && value.mode === "custom" && (
						<span className="money-input">
							<span aria-hidden>$</span>
							<input
								type="number"
								min={0}
								step="0.01"
								inputMode="decimal"
								value={value.amount}
								placeholder="0.00"
								aria-label="Monthly limit in US dollars"
								onChange={(event) => onChange({ mode: "custom", amount: event.target.value })}
							/>
							<span className="muted">per month</span>
						</span>
					)}
				</label>
			))}
		</fieldset>
	);
}

/** The credit part of a request body, or why it cannot be sent. */
function creditBody(choice: CreditChoice): { body: Record<string, unknown> } | { error: string } {
	if (choice.mode !== "custom") return { body: { creditMode: choice.mode } };
	const amount = Number(choice.amount);
	if (choice.amount.trim() === "" || !Number.isFinite(amount) || amount < 0) {
		return { error: "Enter the monthly limit as an amount in dollars, 0 or more." };
	}
	return { body: { creditMode: "custom", creditLimitUsd: amount } };
}

// ── adding ──────────────────────────────────────────────────────────────────

function PasswordField({
	value,
	onChange,
	label,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
}) {
	const [shown, setShown] = useState(false);
	const id = useId();
	return (
		<div className="field">
			<span>
				<label htmlFor={id}>{label}</label>
			</span>
			<div className="password-row">
				<input
					id={id}
					type={shown ? "text" : "password"}
					value={value}
					autoComplete="new-password"
					spellCheck={false}
					onChange={(event) => onChange(event.target.value)}
				/>
				<button type="button" className="btn" onClick={() => setShown((current) => !current)}>
					<Icon name="eye" size={14} />
					{shown ? "Hide" : "Show"}
				</button>
				<button
					type="button"
					className="btn"
					onClick={() => {
						onChange(generatePassword());
						setShown(true);
					}}
				>
					<Icon name="key" size={14} />
					Generate
				</button>
			</div>
			<span className="field-hint">At least 12 characters, and not containing the username.</span>
		</div>
	);
}

function AddUserDialog({
	defaultMonthly,
	onClose,
	onCreated,
}: {
	defaultMonthly: number | null;
	onClose: () => void;
	onCreated: () => void;
}) {
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<Role>("analyst");
	// Follows the platform role until someone picks one by hand.
	const [ontologyRole, setOntologyRole] = useState<string | null>(null);
	const [credit, setCredit] = useState<CreditChoice>({ mode: "default", amount: "" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	async function submit() {
		const creditPart = creditBody(credit);
		if ("error" in creditPart) {
			setError(creditPart.error);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const user = await api.post<AdminUser>("/api/admin/users", {
				username,
				password,
				displayName,
				email,
				role,
				ontologyRole: ontologyRole ?? DEFAULT_ONTOLOGY_ROLE[role],
				...creditPart.body,
			});
			setCreated({ username: user.username, password });
			onCreated();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="modal admin-modal" role="dialog" aria-modal="true" aria-label="Add a user">
				<header className="modal-head">
					<span className="stage-icon" aria-hidden>
						<Icon name="userPlus" size={15} />
					</span>
					<div>
						<h2>{created ? "Account created" : "Add a user"}</h2>
						<p className="muted modal-sub">
							{created
								? "Hand these over yourself: the password is not shown again and is never emailed."
								: "They get their own private workspace, ready the first time they sign in."}
						</p>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">
						<Icon name="x" size={17} />
					</button>
				</header>

				{created ? (
					<div className="modal-body">
						<dl className="kv handover">
							<dt>Username</dt>
							<dd className="mono">{created.username}</dd>
							<dt>Password</dt>
							<dd className="mono">{created.password}</dd>
						</dl>
						<footer className="modal-foot">
							<button
								className="btn"
								onClick={() => {
									void navigator.clipboard
										?.writeText(`Username: ${created.username}\nPassword: ${created.password}`)
										.then(() => setCopied(true))
										.catch(() => setCopied(false));
								}}
							>
								<Icon name={copied ? "check" : "copy"} size={14} />
								{copied ? "Copied" : "Copy both"}
							</button>
							<button className="btn primary" onClick={onClose}>
								Done
							</button>
						</footer>
					</div>
				) : (
					<form
						className="modal-body"
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						{error && <Refusal message={error} />}
						<div className="form-grid">
							<label className="field">
								<span>Username</span>
								<input
									value={username}
									autoFocus
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setUsername(event.target.value.toLowerCase())}
								/>
								<span className="field-hint">3 to 32 characters: letters, digits, dots, dashes, underscores.</span>
							</label>
							<label className="field">
								<span>Display name (optional)</span>
								<input value={displayName} autoComplete="off" onChange={(event) => setDisplayName(event.target.value)} />
							</label>
							<label className="field span-2">
								<span>Email (optional)</span>
								<input type="email" value={email} autoComplete="off" onChange={(event) => setEmail(event.target.value)} />
							</label>
							<div className="span-2">
								<PasswordField value={password} onChange={setPassword} label="Password" />
							</div>
							<label className="field">
								<span>Platform role</span>
								<select value={role} onChange={(event) => setRole(event.target.value as Role)}>
									{ROLES.map((option) => (
										<option key={option} value={option}>
											{ROLE_LABELS[option].label}
										</option>
									))}
								</select>
								<span className="field-hint">{ROLE_LABELS[role].can}</span>
							</label>
							<label className="field">
								<span>Business role</span>
								<select
									value={ontologyRole ?? DEFAULT_ONTOLOGY_ROLE[role]}
									onChange={(event) => setOntologyRole(event.target.value)}
								>
									{ONTOLOGY_ROLES.map((option) => (
										<option key={option.id} value={option.id}>
											{option.label}
										</option>
									))}
								</select>
								<span className="field-hint">Decides which actions they may run.</span>
							</label>
						</div>

						<div>
							<p className="section-label">Monthly AI credit</p>
							<CreditFields value={credit} onChange={setCredit} defaultMonthly={defaultMonthly} />
						</div>

						<footer className="modal-foot">
							<button type="button" className="btn ghost" onClick={onClose}>
								Cancel
							</button>
							<button type="submit" className="btn primary" disabled={busy || !username.trim() || !password}>
								{busy ? <span className="spinner" aria-hidden /> : <Icon name="userPlus" size={15} />}
								{busy ? "Creating…" : "Create user"}
							</button>
						</footer>
					</form>
				)}
			</div>
		</div>
	);
}

// ── managing ────────────────────────────────────────────────────────────────

function ManageUserDialog({
	user,
	isSelf,
	defaultMonthly,
	period,
	onClose,
	onChanged,
	onDeleted,
}: {
	user: AdminUser;
	isSelf: boolean;
	defaultMonthly: number | null;
	period: { start: string; resetsAt: string };
	onClose: () => void;
	onChanged: () => void | Promise<void>;
	onDeleted: (message: string) => void;
}) {
	const [displayName, setDisplayName] = useState(user.displayName ?? "");
	const [email, setEmail] = useState(user.email ?? "");
	const [role, setRole] = useState<Role>(user.role);
	const [ontologyRole, setOntologyRole] = useState(user.ontologyRole);
	const [credit, setCredit] = useState<CreditChoice>({
		mode: user.credit.mode,
		amount: user.credit.limitUsd === null ? "" : String(user.credit.limitUsd),
	});
	const [password, setPassword] = useState("");
	const [confirmName, setConfirmName] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// When the saved account changes, the form follows it - so what was just
	// saved reads back as the server stored it (a trimmed name, a rounded
	// amount) rather than staying "unsaved".
	useEffect(() => {
		setDisplayName(user.displayName ?? "");
		setEmail(user.email ?? "");
		setRole(user.role);
		setOntologyRole(user.ontologyRole);
		setCredit({ mode: user.credit.mode, amount: user.credit.limitUsd === null ? "" : String(user.credit.limitUsd) });
	}, [user.displayName, user.email, user.role, user.ontologyRole, user.credit.mode, user.credit.limitUsd]);

	// Only what differs from the saved account is sent, so the record of the
	// change says what was actually changed.
	const changes: Record<string, unknown> = {};
	if (displayName.trim() !== (user.displayName ?? "")) changes.displayName = displayName.trim() || null;
	if (email.trim() !== (user.email ?? "")) changes.email = email.trim() || null;
	if (role !== user.role) changes.role = role;
	if (ontologyRole !== user.ontologyRole) changes.ontologyRole = ontologyRole;
	const creditChanged =
		credit.mode !== user.credit.mode ||
		(credit.mode === "custom" && Number(credit.amount) !== user.credit.limitUsd);
	const dirty = Object.keys(changes).length > 0 || creditChanged;

	/** Run one change and say how it went. Resolves to whether it worked. */
	async function run(what: string, work: () => Promise<unknown>, message: string): Promise<boolean> {
		setBusy(what);
		setError(null);
		setDone(null);
		try {
			await work();
			// The form settles on the account as the server stored it. Until
			// that has been read back it still differs from the one it was
			// given, and "Saved." would sit beside a Save button still lit.
			await onChanged();
			setDone(message);
			return true;
		} catch (exc) {
			setError((exc as Error).message);
			return false;
		} finally {
			setBusy(null);
		}
	}

	function save() {
		let body = changes;
		if (creditChanged) {
			const creditPart = creditBody(credit);
			if ("error" in creditPart) {
				setError(creditPart.error);
				return;
			}
			body = { ...body, ...creditPart.body };
		}
		void run("save", () => api.patch(`/api/admin/users/${user.id}`, body), "Saved.");
	}

	async function remove() {
		setBusy("delete");
		setError(null);
		try {
			const result = await api.del<{
				deleted: string;
				keptAs: string;
				schedulesStopped?: number;
				passwordsRemoved?: number;
			}>(`/api/admin/users/${user.id}`);
			const stopped = result.schedulesStopped ?? 0;
			const removed = result.passwordsRemoved ?? 0;
			// Only what actually happened: most accounts have neither.
			const also = [
				stopped > 0 ? `${stopped} scheduled refresh${stopped === 1 ? " was" : "es were"} switched off` : "",
				removed > 0 ? `${removed} stored database password${removed === 1 ? " was" : "s were"} removed` : "",
			].filter(Boolean);
			onDeleted(
				`${result.deleted} was deleted. Their workspace, conversations and notes are kept as “${result.keptAs}”, which nobody can sign in as.` +
					(also.length ? ` In that workspace, ${also.join(" and ")}.` : ""),
			);
		} catch (exc) {
			setError((exc as Error).message);
			setBusy(null);
		}
	}

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="rp admin-manage" role="dialog" aria-modal="true" aria-label={`Manage ${user.username}`}>
				<header className="rp-head">
					<span className="avatar-circle lg" aria-hidden>
						{initials(user)}
					</span>
					<div className="rp-heading">
						<div className="rp-kind">
							{ROLE_LABELS[user.role].label} · {user.isActive ? "active" : "disabled"}
							{isSelf ? " · you" : ""}
						</div>
						<h2 className="rp-title">{user.displayName || user.username}</h2>
					</div>
					<span className="rp-rows mono">@{user.username}</span>
					<button className="icon-btn" onClick={onClose} aria-label="Close">
						<Icon name="x" size={17} />
					</button>
				</header>

				<div className="rp-body admin-manage-body">
					{error && <Refusal message={error} />}
					{done && (
						<div className="banner admin-notice" role="status">
							<span>{done}</span>
						</div>
					)}

					<dl className="admin-facts">
						<div>
							<dt>This month</dt>
							<dd>{creditLine(user)}</dd>
						</div>
						<div>
							<dt>Last 30 days</dt>
							<dd>
								{usd(user.usage30d.costUsd)} · {user.usage30d.turns.toLocaleString("en-US")} turns
							</dd>
						</div>
						<div>
							<dt>Conversations</dt>
							<dd>{user.sessions.toLocaleString("en-US")}</dd>
						</div>
						<div>
							<dt>Last sign-in</dt>
							<dd>{user.lastLoginAt ? dateTime(user.lastLoginAt) : "Never"}</dd>
						</div>
						<div>
							<dt>Created</dt>
							<dd>
								{dateTime(user.createdAt)} · {user.signupSource === "self" ? "registered themselves" : "by an administrator"}
							</dd>
						</div>
					</dl>

					<section className="admin-section">
						<h3>Account</h3>
						<div className="form-grid">
							<label className="field">
								<span>Display name</span>
								<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
							</label>
							<label className="field">
								<span>Email</span>
								<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
							</label>
							<label className="field">
								<span>Platform role</span>
								<select value={role} disabled={isSelf} onChange={(event) => setRole(event.target.value as Role)}>
									{ROLES.map((option) => (
										<option key={option} value={option}>
											{ROLE_LABELS[option].label}
										</option>
									))}
								</select>
								<span className="field-hint">
									{isSelf ? "You cannot change your own role. Ask another administrator." : ROLE_LABELS[role].can}
								</span>
							</label>
							<label className="field">
								<span>Business role</span>
								<select value={ontologyRole} onChange={(event) => setOntologyRole(event.target.value)}>
									{ONTOLOGY_ROLES.map((option) => (
										<option key={option.id} value={option.id}>
											{option.label}
										</option>
									))}
								</select>
								<span className="field-hint">Decides which actions they may run.</span>
							</label>
						</div>
					</section>

					<section className="admin-section">
						<h3>Monthly AI credit</h3>
						<p className="muted admin-section-note">
							Counted since {dayAndMonth(period.start)}; renews on {dayAndMonth(period.resetsAt)}. Once it is used up, the
							assistant refuses new questions until then or until the limit is raised.
						</p>
						<CreditFields value={credit} onChange={setCredit} defaultMonthly={defaultMonthly} />
					</section>

					<div className="admin-save">
						<span className="muted">{dirty ? "Unsaved changes." : "No changes to save."}</span>
						<button className="btn primary" disabled={!dirty || busy !== null} onClick={save}>
							{busy === "save" ? <span className="spinner" aria-hidden /> : <Icon name="check" size={15} />}
							{busy === "save" ? "Saving…" : "Save changes"}
						</button>
					</div>

					<section className="admin-section">
						<h3>Access</h3>
						<div className="admin-action">
							<div>
								<strong>Set a new password</strong>
								<p className="muted">
									{isSelf
										? "Replaces your password and signs you out everywhere, this window included."
										: "Replaces the current one and signs them out everywhere."}
								</p>
							</div>
						</div>
						<PasswordField value={password} onChange={setPassword} label="New password" />
						<div className="admin-action-buttons">
							<button
								className="btn"
								disabled={!password || busy !== null}
								onClick={() =>
									void run(
										"password",
										() => api.post(`/api/admin/users/${user.id}/password`, { password }),
										"Password changed. Every session they had open is signed out.",
									).then((worked) => {
										if (worked) setPassword("");
									})
								}
							>
								{busy === "password" ? <span className="spinner" aria-hidden /> : <Icon name="key" size={14} />}
								Set password
							</button>
						</div>

						<div className="admin-action">
							<div>
								<strong>Sign out everywhere</strong>
								<p className="muted">
									{isSelf
										? "Ends every session you have open, this window included. You can sign in again straight away."
										: "Ends every session they have open. They can sign in again straight away."}
								</p>
							</div>
							<button
								className="btn"
								disabled={busy !== null}
								onClick={() =>
									void run(
										"revoke",
										() => api.post(`/api/admin/users/${user.id}/revoke`),
										"Signed out everywhere.",
									)
								}
							>
								{busy === "revoke" ? <span className="spinner" aria-hidden /> : <Icon name="logOut" size={14} />}
								Sign out
							</button>
						</div>

						<div className="admin-action">
							<div>
								<strong>{user.isActive ? "Disable the account" : "Enable the account"}</strong>
								<p className="muted">
									{isSelf
										? "You cannot disable your own account."
										: user.isActive
											? "They can no longer sign in, and are signed out now. Nothing is deleted; enable it again at any time."
											: "They can sign in again with the password they had."}
								</p>
							</div>
							<button
								className="btn"
								disabled={isSelf || busy !== null}
								onClick={() =>
									void run(
										"active",
										() => api.patch(`/api/admin/users/${user.id}`, { isActive: !user.isActive }),
										user.isActive ? "Account disabled." : "Account enabled.",
									)
								}
							>
								{busy === "active" ? (
									<span className="spinner" aria-hidden />
								) : (
									<Icon name={user.isActive ? "ban" : "checkCircle"} size={14} />
								)}
								{user.isActive ? "Disable" : "Enable"}
							</button>
						</div>
					</section>

					<section className="admin-section danger-zone">
						<h3>Delete the account</h3>
						{isSelf ? (
							<p className="muted">You cannot delete your own account. Ask another administrator.</p>
						) : (
							<>
								<p className="muted">
									This cannot be undone. The account is removed and the username becomes free. Their private workspace,
									conversations and notes are kept under a label nobody can sign in as, so the cost history stays
									complete; its scheduled refreshes are switched off and the database passwords it stored are
									removed. To take access away without losing anything, disable the account instead.
								</p>
								<label className="field">
									<span>
										Type <strong className="mono">{user.username}</strong> to confirm
									</span>
									<input
										value={confirmName}
										autoComplete="off"
										spellCheck={false}
										onChange={(event) => setConfirmName(event.target.value)}
									/>
								</label>
								<div className="admin-action-buttons">
									<button
										className="btn danger"
										disabled={confirmName.trim() !== user.username || busy !== null}
										onClick={() => void remove()}
									>
										{busy === "delete" ? <span className="spinner" aria-hidden /> : <Icon name="trash" size={14} />}
										{busy === "delete" ? "Deleting…" : "Delete this account"}
									</button>
								</div>
							</>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}
