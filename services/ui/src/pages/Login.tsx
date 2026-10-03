import { type FormEvent, useEffect, useState } from "react";
import { ApiError, type AuthConfig, type SessionUser, api } from "../api";
import { BrandMark, Icon } from "../components/icons";

/**
 * Sign-in and registration.
 *
 * Shown instead of the workbench whenever there is no usable token, either
 * because nobody has signed in yet or because the server rejected the one we
 * held. There is no "continue without signing in": every API route except the
 * health probe requires a token, so an anonymous shell would render nothing
 * but errors.
 *
 * Registration is offered only when the server says it is open
 * (ALLOW_SELF_REGISTRATION). A new account gets its own private workspace and
 * is signed straight in, so the first thing a new user sees is where to
 * connect their data - not a second login form.
 */
export function Login({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
	const [mode, setMode] = useState<"signin" | "register">("signin");
	const [config, setConfig] = useState<AuthConfig | null>(null);

	useEffect(() => {
		api
			.get<AuthConfig>("/api/auth/config")
			.then(setConfig)
			.catch(() => setConfig({ selfRegistration: false, registrationRole: "analyst" }));
	}, []);

	return (
		<div className="auth-shell">
			<section className="auth-pitch" aria-label="About this product">
				<div className="auth-brand">
					<span className="brand-mark" aria-hidden>
						<BrandMark size={22} />
					</span>
					<span>Ontology Dashboard</span>
				</div>
				<h1>Reports and dashboards on your own data, built by asking.</h1>
				<p className="auth-lede">
					Connect a PostgreSQL database. Your tables become a business model of customers,
					orders, products - whatever they hold - with the links between them. Then ask for
					what you need in plain words.
				</p>
				<ul className="auth-points">
					<li>
						<strong>Honest by design.</strong> Every figure is computed from your tables. When the
						data cannot answer a question, you are told what is missing instead of shown a guess.
					</li>
					<li>
						<strong>Nothing changes without you.</strong> New links, combined datasets and metrics
						are proposed first and built only when you approve them.
					</li>
					<li>
						<strong>Private by default.</strong> Each account has its own workspace: its own
						connections, model, dashboards and conversations.
					</li>
				</ul>
			</section>

			<section className="auth-panel">
				<div className="auth-card">
					{config?.selfRegistration && (
						<div className="auth-tabs" role="tablist">
							<button
								role="tab"
								aria-selected={mode === "signin"}
								className={mode === "signin" ? "active" : ""}
								onClick={() => setMode("signin")}
							>
								Sign in
							</button>
							<button
								role="tab"
								aria-selected={mode === "register"}
								className={mode === "register" ? "active" : ""}
								onClick={() => setMode("register")}
							>
								Create account
							</button>
						</div>
					)}
					{mode === "signin" ? (
						<SignInForm onSignedIn={onSignedIn} />
					) : (
						<RegisterForm onSignedIn={onSignedIn} />
					)}
					{config && !config.selfRegistration && (
						<p className="auth-foot">Accounts on this server are created by an administrator.</p>
					)}
				</div>
			</section>
		</div>
	);
}

function SignInForm({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			onSignedIn(await api.login(username, password));
		} catch (caught) {
			// 429 carries the lockout message from the server, which says how long
			// to wait; anything else gets a generic line so this form never
			// reveals whether the username exists.
			setError(
				caught instanceof ApiError && caught.status === 429
					? caught.message
					: "Sign-in failed. Check the username and password.",
			);
			setPassword("");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="auth-form" onSubmit={submit}>
			<h2>Welcome back</h2>
			<label className="login-field">
				<span>Username</span>
				<input
					value={username}
					onChange={(event) => setUsername(event.target.value)}
					autoComplete="username"
					autoFocus
					required
				/>
			</label>
			<label className="login-field">
				<span>Password</span>
				<input
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="current-password"
					required
				/>
			</label>
			{/* role="alert" so a screen reader announces the failure rather than
			    leaving the form looking like it simply did nothing. */}
			{error && (
				<div className="login-error" role="alert">
					{error}
				</div>
			)}
			<button className="btn primary lg" type="submit" disabled={busy || !username || !password}>
				{busy ? (
					<>
						<span className="spinner" aria-hidden />
						Signing in…
					</>
				) : (
					<>
						Sign in
						<Icon name="arrowRight" size={16} />
					</>
				)}
			</button>
		</form>
	);
}

/** The same rules the server applies, checked as the person types. */
function passwordProblems(username: string, password: string): string[] {
	const problems: string[] = [];
	if (password.length < 12) problems.push("at least 12 characters");
	if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push("must not contain the username");
	if (password && new Set(password).size < 4) problems.push("at least four different characters");
	return problems;
}

function RegisterForm({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
	const [displayName, setDisplayName] = useState("");
	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);

	const problems = passwordProblems(username, password);
	const mismatch = confirm.length > 0 && confirm !== password;
	const ready = username.trim().length >= 3 && problems.length === 0 && !mismatch && confirm.length > 0;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (busy || !ready) return;
		setBusy(true);
		setErrors([]);
		try {
			onSignedIn(
				await api.register({
					username: username.trim(),
					password,
					...(email.trim() ? { email: email.trim() } : {}),
					...(displayName.trim() ? { displayName: displayName.trim() } : {}),
				}),
			);
		} catch (caught) {
			// The server lists every problem at once; show them all.
			const message = caught instanceof Error ? caught.message : "Registration failed.";
			setErrors(message.split(/(?<=\.)\s+(?=[A-Z'])/).filter(Boolean));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="auth-form" onSubmit={submit}>
			<h2>Create your workspace</h2>
			<p className="auth-sub">Free, private, and ready in a few seconds.</p>
			<label className="login-field">
				<span>Your name</span>
				<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" autoFocus />
			</label>
			<label className="login-field">
				<span>Username</span>
				<input
					value={username}
					onChange={(event) => setUsername(event.target.value.toLowerCase())}
					autoComplete="username"
					pattern="[a-z0-9][a-z0-9._\-]{2,31}"
					title="3 to 32 characters: letters, digits, dots, dashes or underscores"
					required
				/>
			</label>
			<label className="login-field">
				<span>Work email (optional)</span>
				<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
			</label>
			<label className="login-field">
				<span>Password</span>
				<input
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="new-password"
					required
				/>
				{password && problems.length > 0 && <em className="field-hint warn">Needs {problems.join(", ")}.</em>}
				{password && problems.length === 0 && <em className="field-hint good">Strong enough.</em>}
			</label>
			<label className="login-field">
				<span>Confirm password</span>
				<input
					type="password"
					value={confirm}
					onChange={(event) => setConfirm(event.target.value)}
					autoComplete="new-password"
					required
				/>
				{mismatch && <em className="field-hint warn">The passwords do not match.</em>}
			</label>
			{errors.length > 0 && (
				<div className="login-error" role="alert">
					{errors.map((line) => (
						<div key={line}>{line}</div>
					))}
				</div>
			)}
			<button className="btn primary lg" type="submit" disabled={busy || !ready}>
				{busy ? (
					<>
						<span className="spinner" aria-hidden />
						Creating your workspace…
					</>
				) : (
					<>
						Create account
						<Icon name="arrowRight" size={16} />
					</>
				)}
			</button>
		</form>
	);
}
