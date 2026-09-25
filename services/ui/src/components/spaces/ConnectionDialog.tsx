/**
 * Registering a connection.
 *
 * Lives in its own component because it is reached from two places that had no
 * business each owning a copy: the project explorer, and the Connections page
 * — which until now had no way to create one at all, so the only route to a
 * new connection was to know it was buried three clicks into /spaces.
 *
 * Two connectors, and the form changes with the choice rather than showing
 * every field of both. What does not change: the credential is never typed in
 * here. What is stored is the NAME of an environment variable or the PATH of a
 * Docker secret, and the dialog says so, because a field that looks like a
 * password field invites someone to paste one.
 */

import { useEffect, useState } from "react";
import { ApiError, type ConnectorKind, api } from "../../api";

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
	const [connector, setConnector] = useState<ConnectorKind>("postgresql");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	// PostgreSQL. Defaulted to this platform's own database, which is the one
	// someone is most likely to point at first and the one that is certain to
	// answer — so the first test anyone runs succeeds for a real reason.
	const [host, setHost] = useState("postgres");
	const [port, setPort] = useState(5432);
	const [database, setDatabase] = useState("tms_ontology");
	const [username, setUsername] = useState("ontology");
	const [sslMode, setSslMode] = useState<"prefer" | "require" | "disable">("prefer");

	// REST.
	const [baseUrl, setBaseUrl] = useState("");
	const [authScheme, setAuthScheme] = useState<"none" | "bearer" | "header" | "basic">("none");
	const [headerName, setHeaderName] = useState("X-API-Key");
	const [healthPath, setHealthPath] = useState("");

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

	// The default secret follows the connector: the Docker secret is the right
	// answer for the platform's own database and meaningless for an API.
	useEffect(() => {
		setSecretRef(connector === "rest" ? "" : "/run/secrets/postgres_password");
		setTestResult(null);
	}, [connector]);

	const spec = () =>
		connector === "rest"
			? {
					name,
					description,
					engine: "rest" as const,
					baseUrl,
					authScheme,
					headerName: authScheme === "header" ? headerName : undefined,
					healthPath: healthPath || undefined,
					username: authScheme === "basic" ? username : undefined,
					secretRef: secretRef || null,
					folderId,
				}
			: {
					name,
					description,
					engine: "postgresql" as const,
					host,
					port: Number(port) || 5432,
					database,
					username,
					sslMode,
					secretRef: secretRef || null,
					folderId,
				};

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
					? `Connection “${name}” created and reachable.`
					: `Connection “${name}” created, but the test failed: ${created.test.detail}`,
			);
		} catch (exc) {
			setProblem(exc instanceof ApiError ? exc.message : "That did not work.");
		} finally {
			setBusy(false);
		}
	}

	const ready =
		name.trim().length > 0 &&
		(connector === "rest" ? baseUrl.trim().length > 0 : host.trim() && database.trim() && username.trim());

	return (
		<div className="card">
			<div className="card-head">
				<h3>New connection</h3>
				<span className="sub">a source this platform can read, and sync from</span>
			</div>

			<label className="field">
				<span>Connector</span>
				<select
					value={connector}
					onChange={(event) => setConnector(event.target.value as ConnectorKind)}
				>
					<option value="postgresql">PostgreSQL — a database</option>
					<option value="rest">REST API — an HTTP endpoint returning JSON</option>
				</select>
				<span className="field-hint">
					{connector === "rest"
						? "Syncs name a path on the source. Every payload this platform was built from came from one of these."
						: "Syncs name a schema and a table, and the source's catalogue is listed for you."}
				</span>
			</label>

			<label className="field">
				<span>Name</span>
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder={connector === "rest" ? "TMS API" : "Warehouse"}
					autoFocus
				/>
				<span className="field-hint">
					The landing table of every sync is named after this, so pick something short.
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

			{connector === "postgresql" ? (
				<>
					<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
						<label className="field" style={{ flex: 2 }}>
							<span>Host</span>
							<input value={host} onChange={(event) => setHost(event.target.value)} />
						</label>
						<label className="field" style={{ flex: 1 }}>
							<span>Port</span>
							<input
								type="number"
								value={port}
								onChange={(event) => setPort(Number(event.target.value))}
							/>
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
							onChange={(event) =>
								setSslMode(event.target.value as "prefer" | "require" | "disable")
							}
						>
							<option value="prefer">prefer</option>
							<option value="require">require</option>
							<option value="disable">disable</option>
						</select>
					</label>
				</>
			) : (
				<>
					<label className="field">
						<span>Base URL</span>
						<input
							value={baseUrl}
							placeholder="https://api.example.com/v1"
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
						<span className="field-hint">
							Scheme, host and any common prefix. A sync adds a path to it, and cannot
							point anywhere else.
						</span>
					</label>

					<label className="field">
						<span>Authentication</span>
						<select
							value={authScheme}
							onChange={(event) =>
								setAuthScheme(event.target.value as "none" | "bearer" | "header" | "basic")
							}
						>
							<option value="none">None — a public or network-restricted endpoint</option>
							<option value="bearer">Bearer token — Authorization: Bearer …</option>
							<option value="header">API key in a header</option>
							<option value="basic">Basic — username and password</option>
						</select>
					</label>

					{authScheme === "header" && (
						<label className="field">
							<span>Header name</span>
							<input value={headerName} onChange={(event) => setHeaderName(event.target.value)} />
						</label>
					)}

					{authScheme === "basic" && (
						<label className="field">
							<span>Username</span>
							<input value={username} onChange={(event) => setUsername(event.target.value)} />
						</label>
					)}

					<label className="field">
						<span>Path to test against</span>
						<input
							value={healthPath}
							placeholder="/health — leave empty to test the base URL"
							onChange={(event) => setHealthPath(event.target.value)}
						/>
						<span className="field-hint">
							Many APIs answer 404 on their root, which is healthy. Name a path that
							exists to be sure.
						</span>
					</label>
				</>
			)}

			{(connector === "postgresql" || authScheme !== "none") && (
				<label className="field">
					<span>Credential reference</span>
					<input
						value={secretRef}
						placeholder={connector === "rest" ? "TMS_API_TOKEN" : "/run/secrets/postgres_password"}
						onChange={(event) => setSecretRef(event.target.value)}
					/>
					<span className="field-hint">
						<strong>Not the credential itself.</strong> Either the NAME of an environment
						variable on the ontology service, or the PATH of a Docker secret under
						/run/secrets. It is read at the moment of use and never stored here, so it
						cannot leak through the workspace or a backup.
					</span>
				</label>
			)}

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
