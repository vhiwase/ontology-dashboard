import { type FormEvent, useState } from "react";
import { ApiError, type SessionUser, api } from "../api";

/**
 * Sign-in screen.
 *
 * Shown instead of the workbench whenever there is no usable token, either
 * because nobody has signed in yet or because the server rejected the one we
 * held. There is no "continue without signing in": every API route except the
 * health probe requires a token, so an anonymous shell would render nothing
 * but errors.
 */
export function Login({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
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
		<div className="login-shell">
			<form className="login-card" onSubmit={submit}>
				<h1>TMS Ontology Workbench</h1>
				<p className="login-sub">Sign in to continue.</p>

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

				<button className="btn primary" type="submit" disabled={busy || !username || !password}>
					{busy ? "Signing in…" : "Sign in"}
				</button>
			</form>
		</div>
	);
}
