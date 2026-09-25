/**
 * Code repositories: where ingestion and functions are written down.
 *
 * Two kinds, and the page says which one it is looking at throughout, because
 * the two build into entirely different things. A transforms repository pulls
 * data through a connection and materialises tables from what lands; a
 * functions repository publishes definitions into the function catalogue as
 * PROPOSED, which is deliberately not the same as approving one.
 *
 * The build log is the centre of the page rather than a detail behind a tab: a
 * build touches several files and can half succeed, and "which file did what"
 * is the only useful summary of that.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	type BuildArtifact,
	type BuildRecord,
	type RepoDetail as RepoDetailPayload,
	type RepoKind,
	type RepoRecord,
	api,
} from "../api";
import { useSpace } from "../SpaceContext";
import { Empty, ErrorBanner, Spinner } from "../components/common";

const KIND_BLURB: Record<RepoKind, string> = {
	transforms:
		"Pulls data in through a connection and builds tables from what lands. " +
		"A *.sync.json file declares the pull; transforms/*.sql declares a table.",
	python:
		"Python transforms, for the work SQL reads badly: per-row logic, branching, " +
		"reshaping. Each one must write a dataset, or the build fails saying why.",
	functions:
		"Publishes named computations into the function catalogue. Building " +
		"publishes each file as proposed — approving one stays a separate act.",
};

/** A new file's starting content, so a blank editor is not the first thing. */
const STARTER: Record<RepoKind, (path: string) => string> = {
	python: () =>
		[
			"from transforms.api import transform, Input, Output",
			"",
			"",
			"@transform(",
			'    output=Output("repo_out.my_table"),',
			'    orders=Input("tms_views.v_order"),',
			")",
			"def compute(orders, output):",
			'    output.write([{"lane": order["lane"]} for order in orders])',
			"",
		].join("\n"),
	transforms: (path) =>
		path.endsWith(".sync.json")
			? JSON.stringify(
					{
						connection: "tms_ontology",
						name: "orders",
						source: { schema: "tms_views", table: "v_order" },
						mode: "snapshot",
						rowLimit: 50000,
					},
					null,
					2,
				)
			: "-- @output repo_out.my_table\nSELECT 1 AS example\n",
	functions: () =>
		[
			"-- name: My Metric",
			"-- description: what it computes",
			"-- returns: scalar",
			"SELECT count(*) AS value FROM tms_views.v_order",
			"",
		].join("\n"),
};

const STATUS_TONE: Record<BuildArtifact["status"], string> = {
	created: "good",
	updated: "good",
	unchanged: "",
	skipped: "warning",
	failed: "critical",
};

function when(value: string | null): string {
	if (!value) return "never";
	return new Date(value).toLocaleString();
}

// ── the list ────────────────────────────────────────────────────────────────

export function RepoList() {
	const [repos, setRepos] = useState<RepoRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const { spaceSlug } = useSpace();

	const load = useCallback(() => {
		setRepos(null);
		setError(null);
		api
			.get<RepoRecord[]>("/api/repos")
			.then(setRepos)
			.catch((exc: Error) => setError(exc.message));
	}, []);

	useEffect(load, [load, spaceSlug]);

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!repos) return <Spinner label="Loading repositories" />;

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3>Repositories</h3>
					<span className="sub">
						{repos.length} in this space — the code behind the data, kept with its history
					</span>
				</div>

				<div className="row" style={{ marginBottom: 10 }}>
					<button className="btn sm" onClick={() => setCreating(true)}>
						New repository
					</button>
				</div>

				{repos.length === 0 ? (
					<Empty>
						No repositories here yet. A transforms repository ingests through a connection
						and builds tables; a functions repository publishes computations.
					</Empty>
				) : (
					<div className="grid grid-2">
						{repos.map((repo) => (
							<Link key={repo.slug} to={`/repos/${repo.slug}`} className="card">
								<div className="card-head">
									<h3>{repo.name}</h3>
									<span className={`chip ${repo.kind === "functions" ? "" : "good"}`}>
										{repo.kind}
									</span>
								</div>
								<p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
									{repo.description ?? KIND_BLURB[repo.kind]}
								</p>
								<div className="row muted" style={{ fontSize: 11, gap: 14 }}>
									<span>{repo.fileCount} files</span>
									<span>{repo.commitCount} commits</span>
									<span>
										last build:{" "}
										{repo.lastBuild ? (
											<span className={repo.lastBuild.status === "success" ? "ok" : "error"}>
												{repo.lastBuild.status}
											</span>
										) : (
											"never"
										)}
									</span>
								</div>
							</Link>
						))}
					</div>
				)}
			</div>

			{creating && (
				<NewRepoDialog
					onClose={() => setCreating(false)}
					onCreated={() => {
						setCreating(false);
						load();
					}}
				/>
			)}
		</div>
	);
}

function NewRepoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [kind, setKind] = useState<RepoKind>("transforms");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await api.post<RepoRecord>("/api/repos", { name, description, kind });
			onCreated();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="card">
			<div className="card-head">
				<h3>New repository</h3>
			</div>
			<label className="field">
				<span>Name</span>
				<input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
			</label>
			<label className="field">
				<span>What it is for</span>
				<input
					value={description}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</label>
			<label className="field">
				<span>Kind</span>
				<select value={kind} onChange={(event) => setKind(event.target.value as RepoKind)}>
					<option value="python">Python — transforms with logic in them</option>
					<option value="transforms">Transforms — SQL, and syncs that ingest</option>
					<option value="functions">Functions — publish computations</option>
				</select>
				<span className="field-hint">{KIND_BLURB[kind]}</span>
			</label>
			{error && <div className="banner error">{error}</div>}
			<div className="row">
				<button className="btn primary sm" disabled={busy || !name.trim()} onClick={submit}>
					{busy ? "Creating…" : "Create"}
				</button>
				<button className="btn sm" onClick={onClose} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	);
}

// ── one repository ──────────────────────────────────────────────────────────

export function RepoDetail() {
	const { slug = "" } = useParams();
	const navigate = useNavigate();
	const { spaceSlug } = useSpace();

	const [detail, setDetail] = useState<RepoDetailPayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openPath, setOpenPath] = useState<string | null>(null);
	const [draft, setDraft] = useState<string>("");
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [lastBuild, setLastBuild] = useState<BuildRecord | null>(null);
	const [adding, setAdding] = useState(false);
	const [newPath, setNewPath] = useState("");

	const load = useCallback(() => {
		setError(null);
		api
			.get<RepoDetailPayload>(`/api/repos/${encodeURIComponent(slug)}`)
			.then((payload) => {
				setDetail(payload);
				setLastBuild(payload.builds[0] ?? null);
				setOpenPath((current) => current ?? payload.files[0]?.path ?? null);
			})
			.catch((exc: Error) => setError(exc.message));
	}, [slug]);

	useEffect(load, [load, spaceSlug]);

	// The editor follows the selected file, except while there are unsaved
	// edits in it — losing someone's typing to a background refresh would be
	// worse than showing a moment-old file.
	useEffect(() => {
		if (dirty) return;
		const file = detail?.files.find((item) => item.path === openPath);
		setDraft(file?.content ?? "");
	}, [detail, openPath, dirty]);

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!detail) return <Spinner label="Loading repository" />;

	const { repo, files, commits, builds, outputs } = detail;

	async function act<T>(label: string, run: () => Promise<T>, done: (result: T) => string) {
		setBusy(label);
		setNotice(null);
		setError(null);
		try {
			setNotice(done(await run()));
			load();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	const save = () =>
		act(
			"save",
			() =>
				api.put(`/api/repos/${encodeURIComponent(slug)}/files`, {
					path: openPath,
					content: draft,
				}),
			() => {
				setDirty(false);
				return `Saved ${openPath}. It is not built until you commit and build.`;
			},
		);

	const commit = () => {
		const message = window.prompt("What changed, and why?");
		if (!message) return;
		return act(
			"commit",
			() => api.post<{ sequence: number }>(`/api/repos/${encodeURIComponent(slug)}/commit`, { message }),
			(created) => `Committed as #${created.sequence}.`,
		);
	};

	const addFile = () => {
		const path = newPath.trim();
		if (!path) return;
		return act(
			"add",
			() =>
				api.put(`/api/repos/${encodeURIComponent(slug)}/files`, {
					path,
					// Starting content for the kind, so a new file shows the shape
					// a build expects rather than an empty editor.
					content: (STARTER[repo.kind] ?? (() => ""))(path),
				}),
			() => {
				setAdding(false);
				setNewPath("");
				setDirty(false);
				setOpenPath(path);
				return `Created ${path}. Commit it before building.`;
			},
		);
	};

	const removeFile = (path: string) => {
		if (!window.confirm(`Delete ${path}? The last commit still has it.`)) return;
		return act(
			"delete",
			() =>
				api.del(
					`/api/repos/${encodeURIComponent(slug)}/files?path=${encodeURIComponent(path)}`,
				),
			() => {
				if (openPath === path) {
					setOpenPath(null);
					setDraft("");
					setDirty(false);
				}
				return `Deleted ${path}. Commit to record it.`;
			},
		);
	};

	const build = () =>
		act(
			"build",
			() => api.post<BuildRecord>(`/api/repos/${encodeURIComponent(slug)}/build`),
			(result) => {
				setLastBuild(result);
				const acted = result.artifacts.filter((a) => a.kind !== "ignored").length;
				return result.status === "success"
					? `Build #${result.id} succeeded: ${acted} ${acted === 1 ? "file" : "files"} acted on.`
					: `Build #${result.id} failed. ${result.errorMessage ?? ""}`;
			},
		);

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3>{repo.name}</h3>
					<span className={`chip ${repo.kind === "functions" ? "" : "good"}`}>{repo.kind}</span>
					<span className="sub">
						{repo.defaultBranch} · {repo.fileCount} files · {repo.commitCount} commits · last
						commit {when(repo.lastCommitAt)}
					</span>
				</div>
				<p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
					{repo.description ?? KIND_BLURB[repo.kind]}
				</p>
				<div className="row">
					<button className="btn sm" onClick={() => navigate("/repos")}>
						All repositories
					</button>
					<button className="btn sm" disabled={busy !== null} onClick={commit}>
						{busy === "commit" ? "Committing…" : "Commit"}
					</button>
					<button className="btn primary sm" disabled={busy !== null} onClick={build}>
						{busy === "build" ? "Building…" : "Build"}
					</button>
					<span className="muted" style={{ fontSize: 11 }}>
						A build builds the last commit, not the editor — so a number it produces can be
						reproduced.
					</span>
				</div>
				{notice && <div className="banner">{notice}</div>}
			</div>

			<div className="grid" style={{ gridTemplateColumns: "minmax(200px, 260px) 1fr" }}>
				<div className="card">
					<div className="card-head">
						<h3>Files</h3>
						<button className="btn sm" onClick={() => setAdding((open) => !open)}>
							{adding ? "Cancel" : "New file"}
						</button>
					</div>

					{adding && (
						<div className="col" style={{ gap: 4, marginBottom: 8 }}>
							<input
								className="mono"
								value={newPath}
								autoFocus
								placeholder={
									repo.kind === "python"
										? "transforms/my_transform.py"
										: repo.kind === "functions"
											? "functions/my_metric.sql"
											: "transforms/my_table.sql"
								}
								onChange={(event) => setNewPath(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void addFile();
								}}
							/>
							<span className="muted" style={{ fontSize: 10.5 }}>
								{repo.kind === "python"
									? "Only transforms/*.py is built."
									: repo.kind === "functions"
										? "Only functions/* is published."
										: "transforms/*.sql is built; *.sync.json is run."}
							</span>
							<button className="btn sm primary" disabled={!newPath.trim()} onClick={addFile}>
								Create
							</button>
						</div>
					)}

					{files.length === 0 ? (
						<Empty>No files yet.</Empty>
					) : (
						<div className="col" style={{ gap: 2 }}>
							{files.map((file) => (
								<div key={file.path} className="row" style={{ gap: 2, flexWrap: "nowrap" }}>
									<button
										className={`btn sm${file.path === openPath ? " primary" : ""}`}
										style={{ justifyContent: "flex-start", textAlign: "left", flex: 1, minWidth: 0 }}
										onClick={() => {
											setDirty(false);
											setOpenPath(file.path);
										}}
									>
										<span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
											{file.path}
										</span>
									</button>
									<button
										className="btn sm"
										title={`Delete ${file.path}`}
										disabled={busy !== null}
										onClick={() => void removeFile(file.path)}
									>
										✕
									</button>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="card">
					<div className="card-head">
						<h3>{openPath ?? "No file open"}</h3>
						<span className="sub">
							{dirty ? "unsaved changes" : "saved"} · edited by{" "}
							{files.find((file) => file.path === openPath)?.updatedBy ?? "—"}
						</span>
					</div>
					<textarea
						className="mono"
						value={draft}
						spellCheck={false}
						rows={22}
						style={{ width: "100%", resize: "vertical", tabSize: 4 }}
						placeholder={openPath ? "" : "Open a file, or create one."}
						onKeyDown={(event) => {
							// Tab indents rather than leaving the editor, which is the
							// one thing that makes a textarea unusable for code.
							if (event.key === "Tab") {
								event.preventDefault();
								const area = event.currentTarget;
								const { selectionStart: from, selectionEnd: to } = area;
								const next = `${draft.slice(0, from)}    ${draft.slice(to)}`;
								setDraft(next);
								setDirty(true);
								requestAnimationFrame(() => area.setSelectionRange(from + 4, from + 4));
							}
							// Ctrl/Cmd+S saves, as it does in every editor.
							if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
								event.preventDefault();
								if (dirty && openPath) void save();
							}
						}}
						onChange={(event) => {
							setDraft(event.target.value);
							setDirty(true);
						}}
					/>
					<div className="row" style={{ marginTop: 8 }}>
						<button
							className="btn sm"
							disabled={!dirty || busy !== null || !openPath}
							onClick={save}
						>
							{busy === "save" ? "Saving…" : "Save"}
						</button>
						<span className="muted" style={{ fontSize: 10.5 }}>
							Ctrl+S saves · Tab indents · a build builds the last commit
						</span>
					</div>
				</div>
			</div>

			{lastBuild && <BuildLog build={lastBuild} />}

			<div className="grid grid-2">
				<div className="card">
					<div className="card-head">
						<h3>What it produced</h3>
						<span className="sub">read back from the platform, not from the build log</span>
					</div>
					{outputs.syncs.length === 0 &&
					outputs.datasets.length === 0 &&
					outputs.functions.length === 0 ? (
						<Empty>Nothing yet — build the repository.</Empty>
					) : (
						<table className="dense">
							<tbody>
								{outputs.syncs.map((sync) => (
									<tr key={`sync-${sync.name}`}>
										<td>sync</td>
										<td>{sync.name}</td>
										<td className="mono">{sync.relation}</td>
									</tr>
								))}
								{outputs.datasets.map((dataset) => (
									<tr key={`ds-${dataset.relation}`}>
										<td>dataset</td>
										<td>{dataset.name}</td>
										<td className="mono">
											{dataset.relation}
											{dataset.rows !== null ? ` · ${dataset.rows} rows` : ""}
										</td>
									</tr>
								))}
								{outputs.functions.map((fn) => (
									<tr key={`fn-${fn.apiName}`}>
										<td>function</td>
										<td>
											<Link to="/functions">{fn.name}</Link>
										</td>
										<td>
											<span className={`chip ${fn.status === "active" ? "good" : "warning"}`}>
												{fn.status}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				<div className="card">
					<div className="card-head">
						<h3>History</h3>
						<span className="sub">commits, newest first</span>
					</div>
					{commits.length === 0 ? (
						<Empty>Nothing committed yet.</Empty>
					) : (
						<table className="dense">
							<thead>
								<tr>
									<th>#</th>
									<th>Message</th>
									<th>Author</th>
									<th>When</th>
								</tr>
							</thead>
							<tbody>
								{commits.map((entry) => (
									<tr key={entry.id}>
										<td className="num">{entry.sequence}</td>
										<td>{entry.message}</td>
										<td>{entry.author}</td>
										<td>{when(entry.createdAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>

			{builds.length > 1 && (
				<div className="card">
					<div className="card-head">
						<h3>Earlier builds</h3>
					</div>
					<table className="dense">
						<thead>
							<tr>
								<th>#</th>
								<th>Commit</th>
								<th>Status</th>
								<th>Duration</th>
								<th>By</th>
								<th>When</th>
							</tr>
						</thead>
						<tbody>
							{builds.map((entry) => (
								<tr key={entry.id} onClick={() => setLastBuild(entry)}>
									<td className="num">{entry.id}</td>
									<td className="num">{entry.commitSequence ?? "—"}</td>
									<td className={entry.status === "success" ? "ok" : "error"}>{entry.status}</td>
									<td className="num">{entry.durationMs ?? "—"} ms</td>
									<td>{entry.triggeredBy}</td>
									<td>{when(entry.startedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function BuildLog({ build }: { build: BuildRecord }) {
	return (
		<div className="card">
			<div className="card-head">
				<h3>Build #{build.id}</h3>
				<span className={`chip ${build.status === "success" ? "good" : "critical"}`}>
					{build.status}
				</span>
				<span className="sub">
					commit {build.commitSequence ?? "—"} · {build.durationMs ?? "—"} ms · {build.triggeredBy}{" "}
					· {when(build.startedAt)}
				</span>
			</div>
			{build.errorMessage && <div className="banner error">{build.errorMessage}</div>}
			<table className="dense">
				<thead>
					<tr>
						<th>File</th>
						<th>Did</th>
						<th>Result</th>
						<th>Produced</th>
						<th>Rows</th>
					</tr>
				</thead>
				<tbody>
					{build.artifacts.map((artifact) => (
						<tr key={artifact.path}>
							<td className="mono">{artifact.path}</td>
							<td>{artifact.kind}</td>
							<td>
								<span className={`chip ${STATUS_TONE[artifact.status]}`}>{artifact.status}</span>{" "}
								<span className="muted">{artifact.message}</span>
							</td>
							<td className="mono">{artifact.produced ?? "—"}</td>
							<td className="num">{artifact.rows ?? "—"}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
