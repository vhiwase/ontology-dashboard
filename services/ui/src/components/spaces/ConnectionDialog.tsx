/**
 * Registering a PostgreSQL connection.
 *
 * Lives in its own component because it is reached from two places that had no
 * business each owning a copy: the project explorer, and the Connections page.
 *
 * What is never typed in here: the password. What is stored is the NAME of an
 * environment variable or the PATH of a Docker secret, and the dialog says so,
 * because a field that looks like a password field invites someone to paste one.
 */

import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";

interface ConnectionTest {
	ok: boolean;
	latencyMs: number;
	detail: string;
	serverVersion?: string | null;
}

interface ProjectOption {
	slug: string;
	name: string;
}

export function ConnectionDialog({
	spaceSlug,
	projectSlug,
	folderId = null,
	onClose,
	onDone,
}: {
	spaceSlug: string;
	/** Fixed when opened inside a project; chosen in the dialog when not. */
	projectSlug: string | null;
	folderId?: number | null;
	onClose: () => void;
	onDone: (message: string) => void;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	// Defaulted to this platform's own database, which is the one someone is
	// most likely to point at first and the one certain to answer - so the
	// first test anyone runs succeeds for a real reason.
	const [host, setHost] = useState("postgres");
	const [port, setPort] = useState(5432);
	const [database, setDatabase] = useState("tms_ontology");
	const [username, setUsername] = useState("ontology");
	const [sslMode, setSslMode] = useState<"prefer" | "require" | "disable">("prefer");
	const [secretRef, setSecretRef] = useState("/run/secrets/postgres_password");

	const [projects, setProjects] = useState<ProjectOption[]>([]);
	const [project, setProject] = useState(projectSlug ?? "");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<ConnectionTest | null>(null);

	// A connection belongs to a project, so one has to be chosen when the dialog
	// was not opened from inside one.
	useEffect(() => {
		if (projectSlug) return;
		api
			.get<ProjectOption[]>(`/api/spaces/${spaceSlug}/projects`)
			.then((list) => {
				setProjects(list);
				setProject((current) => current || list[0]?.slug || "");
			})
			.catch(() => setProjects([]));
	}, [spaceSlug, projectSlug]);

	const spec = () => ({
		name,
		description,
		host,
		port: Number(port) || 5432,
		database,
		username,
		sslMode,
		secretRef: secretRef || null,
		folderId,
	});

	async function test() {
		setBusy(true);
		setProblem(null);
		try {
			setTestResult(await api.post<ConnectionTest>("/api/spaces/connections/test", spec()));
		} catch (exc) {
			setProblem(exc instanceof ApiError ? exc.message : "The test could not be run.");
		} finally {
			setBusy(false);
		}
	}

	async function submit() {
		if (!project) {
			setProblem("Choose a project for this connection to live in.");
			return;
		}
		setBusy(true);
		setProblem(null);
		try {
			const created = await api.post<{ test: ConnectionTest }>(
				`/api/spaces/${spaceSlug}/projects/${project}/connections`,
				spec(),
			);
			onDone(
				created.test.ok
					? `Connection “${name}” created and reachable. Open it to sync a view.`
					: `Connection “${name}” created, but the test failed: ${created.test.detail}`,
			);
		} catch (exc) {
			setProblem(exc instanceof ApiError ? exc.message : "That did not work.");
		} finally {
			setBusy(false);
		}
	}

	const ready = name.trim().length > 0 && host.trim() && database.trim() && username.trim();

	return (
		<div className="card">
			<div className="card-head">
				<h3>New PostgreSQL connection</h3>
				<span className="sub">a database whose views this platform can sync</span>
			</div>

			<label className="field">
				<span>Name</span>
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="TMS database"
					autoFocus
				/>
				<span className="field-hint">
					Every dataset a sync lands is named after this, so pick something short.
				</span>
			</label>

			<label className="field">
				<span>Description</span>
				<input value={description} onChange={(event) => setDescription(event.target.value)} />
			</label>

			{!projectSlug && (
				<label className="field">
					<span>Project</span>
					<select value={project} onChange={(event) => setProject(event.target.value)}>
						{projects.length === 0 && <option value="">No projects in this space</option>}
						{projects.map((option) => (
							<option key={option.slug} value={option.slug}>
								{option.name}
							</option>
						))}
					</select>
				</label>
			)}

			<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
				<label className="field" style={{ flex: 2 }}>
					<span>Host</span>
					<input value={host} onChange={(event) => setHost(event.target.value)} />
				</label>
				<label className="field" style={{ flex: 1 }}>
					<span>Port</span>
					<input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} />
				</label>
			</div>
			<label className="field">
				<span>Database</span>
				<input value={database} onChange={(event) => setDatabase(event.target.value)} />
			</label>
			<label className="field">
				<span>Username</span>
				<input value={username} onChange={(event) => setUsername(event.target.value)} />
			</label>
			<label className="field">
				<span>SSL</span>
				<select
					value={sslMode}
					onChange={(event) => setSslMode(event.target.value as "prefer" | "require" | "disable")}
				>
					<option value="prefer">prefer</option>
					<option value="require">require</option>
					<option value="disable">disable</option>
				</select>
			</label>

			<label className="field">
				<span>Credential reference</span>
				<input
					value={secretRef}
					placeholder="/run/secrets/postgres_password"
					onChange={(event) => setSecretRef(event.target.value)}
				/>
				<span className="field-hint">
					<strong>Not the password itself.</strong> Either the NAME of an environment variable on
					the ontology service, or the PATH of a Docker secret under /run/secrets. It is read at
					the moment of use and never stored here, so it cannot leak through the workspace or a
					backup.
				</span>
			</label>

			{problem && <div className="banner error">{problem}</div>}
			{testResult && (
				<div className={`banner ${testResult.ok ? "" : "error"}`}>
					{testResult.ok
						? `Reached it in ${testResult.latencyMs} ms${
								testResult.serverVersion ? ` — ${testResult.serverVersion}` : ""
							}`
						: `Failed: ${testResult.detail}`}
				</div>
			)}

			<div className="row">
				<button className="btn primary sm" disabled={busy || !ready} onClick={submit}>
					{busy ? "Working…" : "Create"}
				</button>
				<button className="btn sm" disabled={busy || !ready} onClick={test}>
					Test connection
				</button>
				<button className="btn sm" onClick={onClose} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	);
}
