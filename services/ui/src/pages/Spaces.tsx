/**
 * The resource explorer: spaces, projects, folders and what is in them.
 *
 * A space per environment exists from the start, because the environment list
 * is fixed and a missing space is just a hole someone has to fill by hand.
 * Sandbox is where work begins; the others are where it is promoted to.
 *
 * Everything in the tree is a real resource pointing at something real — a
 * view, an object type, a pipeline, the live database connection — so opening
 * one shows what is actually there rather than a placeholder.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, session } from "../api";
import { ResourcePreview } from "../components/spaces/ResourcePreview";
import { WorkspacePanel } from "../components/spaces/WorkspacePanel";
import { RESOURCE_SPECS, type ResourceKind } from "../components/spaces/resourceKinds";
import { ErrorBanner, Spinner } from "../components/common";
import { useSpace } from "../SpaceContext";

interface Project {
	id: number;
	spaceSlug: string;
	slug: string;
	name: string;
	description: string | null;
	createdBy: string;
	updatedAt: string;
	resourceCount: number;
	folderCount: number;
}

interface Folder {
	id: number;
	parentId: number | null;
	name: string;
	path: string;
}

interface Resource {
	id: number;
	folderId: number | null;
	kind: ResourceKind;
	name: string;
	description: string | null;
	targetRef: string | null;
	/** The relation it is read from, e.g. tms_views.v_kpi_mode_mix. */
	backingView: string | null;
	properties: Record<string, unknown>;
	createdBy: string;
	updatedAt: string;
}

interface Tree {
	project: Project;
	folders: Folder[];
	resources: Resource[];
}

const ENV_TONE: Record<string, string> = {
	sandbox: "env-sandbox",
	development: "env-dev",
	staging: "env-staging",
	production: "env-prod",
};

export function Spaces() {
	const navigate = useNavigate();
	const { spaces, spaceSlug, setSpaceSlug, loading: spacesLoading } = useSpace();
	const [projects, setProjects] = useState<Project[]>([]);
	// Which space `projects` was loaded for. Checking the project list alone was
	// not enough: on a space change it still holds the PREVIOUS space's projects
	// until the fetch resolves, so a slug from the old space looked valid and the
	// tree was requested for a project that does not exist in the new one.
	const [projectsSpace, setProjectsSpace] = useState<string | null>(null);
	const [projectSlug, setProjectSlug] = useState<string | null>(null);
	const [tree, setTree] = useState<Tree | null>(null);
	const [folderId, setFolderId] = useState<number | null>(null);
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const [query, setQuery] = useState("");
	const [previewId, setPreviewId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<
		"project" | "folder" | "dataset" | "connection" | null
	>(null);

	const role = session.user()?.role ?? "viewer";
	const canWrite = role === "analyst" || role === "admin";
	// By kind or by folder. Kind is the default because it answers the question
	// people actually arrive with - "which object types are there", "what is
	// this metric read from" - whereas folders answer where it was filed.
	const [browse, setBrowse] = useState<"kind" | "folders">("kind");
	const [deletingId, setDeletingId] = useState<number | null>(null);

	const loadProjects = useCallback(
		async (slug: string) => {
			try {
				const list = await api.get<Project[]>(`/api/spaces/${slug}/projects`);
				setProjects(list);
				setProjectsSpace(slug);
				setProjectSlug(list[0]?.slug ?? null);
				if (list.length === 0) setTree(null);
			} catch (exc) {
				setError(exc instanceof ApiError ? exc.message : String(exc));
			}
		},
		[],
	);

	useEffect(() => {
		// Clear the previous space's selection FIRST. Without this, changing
		// space left projectSlug pointing at a project from the old one, and the
		// tree effect fired for it before loadProjects could resolve — asking
		// for /spaces/production/projects/tms-platform/tree and getting a 404.
		setProjectSlug(null);
		setProjectsSpace(null);
		setTree(null);
		setFolderId(null);
		void loadProjects(spaceSlug);
	}, [spaceSlug, loadProjects]);

	const loadTree = useCallback(async () => {
		if (!projectSlug) return;
		// Only once the project list is known to belong to THIS space.
		if (projectsSpace !== spaceSlug) return;
		if (!projects.some((project) => project.slug === projectSlug)) return;
		try {
			const next = await api.get<Tree>(
				`/api/spaces/${spaceSlug}/projects/${projectSlug}/tree`,
			);
			setTree(next);
			// Top-level folders open by default: a tree that starts fully collapsed
			// makes the user click before seeing anything at all.
			setExpanded(new Set(next.folders.filter((f) => f.parentId === null).map((f) => f.id)));
		} catch (exc) {
			setError(exc instanceof ApiError ? exc.message : String(exc));
		}
	}, [spaceSlug, projectSlug, projects, projectsSpace]);

	useEffect(() => {
		void loadTree();
	}, [loadTree]);

	async function seedSandbox() {
		setBusy(true);
		setNotice(null);
		try {
			await api.post("/api/spaces/sandbox/seed");
			await loadProjects("sandbox");
			setNotice("Sandbox filled from the published ontology.");
		} catch (exc) {
			setNotice(exc instanceof ApiError ? exc.message : "Could not fill the sandbox.");
		} finally {
			setBusy(false);
		}
	}

	const childFolders = useCallback(
		(parentId: number | null) => (tree?.folders ?? []).filter((f) => f.parentId === parentId),
		[tree],
	);

	const visibleResources = useMemo(() => {
		if (!tree) return [];
		const needle = query.trim().toLowerCase();
		return tree.resources.filter((resource) => {
			// A search looks through the whole project. Without one, the folder
			// decides what is shown - but only while browsing BY FOLDER. In the
			// by-kind panel there is no selected folder, so filtering by one left
			// the list showing a single row beside a panel listing 136.
			if (!needle && browse === "folders" && resource.folderId !== folderId) return false;
			if (!needle) return true;
			return [
				resource.name,
				resource.description ?? "",
				resource.targetRef ?? "",
				resource.backingView ?? "",
				resource.kind,
			]
				.join(" ")
				.toLowerCase()
				.includes(needle);
		});
	}, [tree, folderId, query, browse]);

	const currentFolder = tree?.folders.find((f) => f.id === folderId) ?? null;

	function renderFolder(folder: Folder, depth: number) {
		const children = childFolders(folder.id);
		const isOpen = expanded.has(folder.id);
		const count = tree?.resources.filter((r) => r.folderId === folder.id).length ?? 0;
		return (
			<div key={folder.id}>
				<button
					className={`tree-row ${folderId === folder.id ? "active" : ""}`}
					style={{ paddingLeft: 8 + depth * 14 }}
					onClick={() => {
						setFolderId(folder.id);
						setQuery("");
						setExpanded((current) => {
							const next = new Set(current);
							if (next.has(folder.id)) next.delete(folder.id);
							else next.add(folder.id);
							return next;
						});
					}}
				>
					<span className="tree-caret" aria-hidden>
						{children.length > 0 ? (isOpen ? "▾" : "▸") : "·"}
					</span>
					<span className="tree-glyph" aria-hidden>
						{isOpen ? "▼" : "▶"}
					</span>
					<span className="tree-name">{folder.name}</span>
					{count > 0 && <span className="tree-count">{count}</span>}
				</button>
				{isOpen && children.map((child) => renderFolder(child, depth + 1))}
			</div>
		);
	}

	if (error) return <ErrorBanner error={error} />;
	if (spacesLoading) return <Spinner label="Loading spaces" />;

	const space = spaces.find((s) => s.slug === spaceSlug);

	return (
		<div className="col" style={{ gap: 12 }}>
			{/* ── spaces ───────────────────────────────────────────────────── */}
			<div className="card">
				<div className="card-head">
					<h3>Spaces</h3>
					<span className="sub">one per environment</span>
				</div>
				<div className="space-row">
					{spaces.map((item) => (
						<button
							key={item.slug}
							className={`space-card ${ENV_TONE[item.environment] ?? ""} ${
								item.slug === spaceSlug ? "active" : ""
							}`}
							onClick={() => {
								setSpaceSlug(item.slug);
								setFolderId(null);
								setQuery("");
							}}
						>
							<div className="space-name">{item.name}</div>
							<div className="space-env mono">{item.environment}</div>
							<div className="muted">
								{item.projectCount} project{item.projectCount === 1 ? "" : "s"}
							</div>
						</button>
					))}
				</div>
				{space?.description && <p className="muted rp-note">{space.description}</p>}
			</div>

			{notice && <div className="banner">{notice}</div>}

			{/* ── projects ─────────────────────────────────────────────────── */}
			<div className="card">
				<div className="card-head">
					<h3>{space?.name} projects</h3>
					<span className="sub">{projects.length}</span>
					{canWrite && (
						<>
							<button
								className="btn sm"
								style={{ marginLeft: 10 }}
								onClick={() => setDialog("project")}
							>
								New project
							</button>
							{spaceSlug === "sandbox" && projects.length === 0 && (
								<button className="btn sm primary" onClick={seedSandbox} disabled={busy}>
									Fill from the ontology
								</button>
							)}
						</>
					)}
				</div>

				{projects.length === 0 ? (
					<p className="muted">
						No projects in this space yet.
						{spaceSlug === "sandbox"
							? " Fill it from the published ontology, or create one."
							: " Create one, or promote a project from the sandbox."}
					</p>
				) : (
					<div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
						{projects.map((project) => (
							<button
								key={project.slug}
								className={`btn sm ${project.slug === projectSlug ? "primary" : ""}`}
								onClick={() => {
									setProjectSlug(project.slug);
									setFolderId(null);
									setQuery("");
								}}
							>
								{project.name}
								<span className="muted"> · {project.resourceCount}</span>
							</button>
						))}
					</div>
				)}
			</div>

			{/* ── the tree ─────────────────────────────────────────────────── */}
			{tree && (
				<div className="explorer">
					{browse === "kind" ? (
						<div className="wsp-shell">
							<div className="explorer-tree-head">
								<span>{tree.project.name}</span>
								<span className="wsp-toggle">
									<button className="active" onClick={() => setBrowse("kind")}>
										Kind
									</button>
									<button onClick={() => setBrowse("folders")}>Folders</button>
								</span>
							</div>
							<WorkspacePanel
								resources={tree.resources}
								selectedId={previewId}
								onSelect={(resource) => setPreviewId(resource.id)}
								busyId={deletingId}
								onDelete={async (resource) => {
									setDeletingId(resource.id);
									try {
										await api.del(`/api/resources/${resource.id}`);
										// Close the preview if it was showing what just went.
										setPreviewId((current) =>
											current === resource.id ? null : current,
										);
										await loadTree();
									} catch (exc) {
										setError(exc instanceof ApiError ? exc.message : String(exc));
									} finally {
										setDeletingId(null);
									}
								}}
							/>
						</div>
					) : (
					<aside className="explorer-tree">
						<div className="explorer-tree-head">
							<span>{tree.project.name}</span>
							<span className="wsp-toggle">
								<button onClick={() => setBrowse("kind")}>Kind</button>
								<button className="active" onClick={() => setBrowse("folders")}>
									Folders
								</button>
							</span>
							{canWrite && (
								<button
									className="btn sm"
									onClick={() => setDialog("folder")}
									title="New folder"
								>
									+
								</button>
							)}
						</div>
						<button
							className={`tree-row ${folderId === null ? "active" : ""}`}
							onClick={() => {
								setFolderId(null);
								setQuery("");
							}}
						>
							<span className="tree-caret" aria-hidden>
								·
							</span>
							<span className="tree-glyph" aria-hidden>
								▣
							</span>
							<span className="tree-name">Project root</span>
						</button>
						{childFolders(null).map((folder) => renderFolder(folder, 1))}
					</aside>
					)}

					<section className="explorer-main">
						<div className="explorer-bar">
							<span className="explorer-path mono">
								{tree.project.name}
								{currentFolder ? currentFolder.path : ""}
							</span>
							<input
								className="search-input"
								type="search"
								value={query}
								placeholder="Search this project…"
								onChange={(event) => setQuery(event.target.value)}
								aria-label="Search resources"
							/>
							{canWrite && (
								<>
									<button className="btn sm" onClick={() => setDialog("connection")}>
										New connection
									</button>
									<button className="btn sm" onClick={() => setDialog("dataset")}>
										Register dataset
									</button>
								</>
							)}
						</div>

						{visibleResources.length === 0 ? (
							<p className="muted" style={{ padding: 12 }}>
								{query
									? `Nothing in this project matches “${query}”.`
									: "This folder is empty."}
							</p>
						) : (
							<div className="explorer-scroll">
							<table className="dense explorer-table">
								<thead>
									<tr>
										<th>Name</th>
										<th>Type</th>
										<th>Points at</th>
										<th>Updated</th>
									</tr>
								</thead>
								<tbody>
									{visibleResources.map((resource) => {
										const spec = RESOURCE_SPECS[resource.kind];
										return (
											<tr key={resource.id} onClick={() => setPreviewId(resource.id)}>
												<td>
													<span className="tree-glyph" style={{ color: spec.accent }} aria-hidden>
														{spec.glyph}
													</span>{" "}
													{resource.name}
												</td>
												<td className="muted">{spec.label}</td>
												<td className="mono muted">{resource.targetRef ?? "—"}</td>
												<td className="mono muted">{resource.updatedAt.slice(0, 10)}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
							</div>
						)}
					</section>
				</div>
			)}

			<ResourcePreview
				resourceId={previewId}
				onClose={() => setPreviewId(null)}
				onOpenTarget={(kind, targetRef) => {
					const route = RESOURCE_SPECS[kind].route?.(targetRef);
					if (route) {
						setPreviewId(null);
						navigate(route);
					}
				}}
			/>

			{dialog && (
				<CreateDialog
					kind={dialog}
					spaceSlug={spaceSlug}
					projectSlug={projectSlug}
					folderId={folderId}
					onClose={() => setDialog(null)}
					onDone={async (message) => {
						setDialog(null);
						setNotice(message);
						await loadProjects(spaceSlug);
						await loadTree();
					}}
				/>
			)}
		</div>
	);
}

/** New project, new folder, or register a dataset — one small modal for each. */
function CreateDialog({
	kind,
	spaceSlug,
	projectSlug,
	folderId,
	onClose,
	onDone,
}: {
	kind: "project" | "folder" | "dataset" | "connection";
	spaceSlug: string;
	projectSlug: string | null;
	folderId: number | null;
	onClose: () => void;
	onDone: (message: string) => void;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [view, setView] = useState("");
	const [views, setViews] = useState<Array<{ view: string; usedBy: string[] }>>([]);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	// Connection fields. Defaulted to this platform's own database, which is
	// the one someone is most likely to be pointing at first.
	const [host, setHost] = useState("postgres");
	const [port, setPort] = useState(5432);
	const [database, setDatabase] = useState("tms_ontology");
	const [username, setUsername] = useState("ontology");
	const [secretRef, setSecretRef] = useState("/run/secrets/postgres_password");
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		latencyMs: number;
		detail: string;
		serverVersion?: string | null;
	} | null>(null);

	const connectionSpec = () => ({
		name,
		description,
		engine: "postgresql" as const,
		host,
		port: Number(port) || 5432,
		database,
		username,
		secretRef: secretRef || null,
		folderId,
	});

	async function testConnection() {
		setBusy(true);
		setProblem(null);
		try {
			setTestResult(await api.post("/api/spaces/connections/test", connectionSpec()));
		} catch (exc) {
			setProblem(exc instanceof ApiError ? exc.message : "The test could not be run.");
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		if (kind !== "dataset") return;
		api
			.get<Array<{ view: string; usedBy: string[] }>>("/api/spaces/views")
			.then((list) => {
				setViews(list);
				setView(list[0]?.view ?? "");
			})
			.catch(() => setViews([]));
	}, [kind]);

	async function submit() {
		setBusy(true);
		setProblem(null);
		try {
			if (kind === "project") {
				await api.post(`/api/spaces/${spaceSlug}/projects`, { name, description });
				onDone(`Project “${name}” created.`);
			} else if (kind === "folder") {
				await api.post(`/api/spaces/${spaceSlug}/projects/${projectSlug}/folders`, {
					name,
					parentId: folderId,
				});
				onDone(`Folder “${name}” created.`);
			} else if (kind === "connection") {
				const created = await api.post<{ test: { ok: boolean; detail: string } }>(
					`/api/spaces/${spaceSlug}/projects/${projectSlug}/connections`,
					connectionSpec(),
				);
				onDone(
					created.test.ok
						? `Connection “${name}” created and reachable.`
						: `Connection “${name}” created, but the test failed: ${created.test.detail}`,
				);
			} else {
				await api.post(`/api/spaces/${spaceSlug}/projects/${projectSlug}/datasets`, {
					name,
					description,
					sourceView: view,
					folderId,
				});
				onDone(`Dataset “${name}” registered on ${view}.`);
			}
		} catch (exc) {
			setProblem(exc instanceof ApiError ? exc.message : "That did not work.");
		} finally {
			setBusy(false);
		}
	}

	const title =
		kind === "project"
			? "New project"
			: kind === "folder"
				? "New folder"
				: kind === "connection"
					? "New connection"
					: "Register a dataset";

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="rp rp-small" role="dialog" aria-label={title}>
				<header className="rp-head">
					<div className="rp-heading">
						<h2 className="rp-title">{title}</h2>
					</div>
					<button className="btn sm" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>

				<div className="rp-body">
					<label className="field">
						<span>Name</span>
						<input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
					</label>

					{kind === "dataset" && (
						<label className="field">
							<span>Backing view</span>
							<select value={view} onChange={(event) => setView(event.target.value)}>
								{views.map((entry) => (
									<option key={entry.view} value={entry.view}>
										{entry.view} — used by {entry.usedBy.slice(0, 2).join(", ")}
									</option>
								))}
							</select>
							<em className="field-hint">
								Only views the published ontology exposes. A dataset on anything else would
								point at nothing.
							</em>
						</label>
					)}

					{kind === "connection" && (
						<>
							<div className="row" style={{ gap: 8 }}>
								<label className="field" style={{ flex: "2 1 0" }}>
									<span>Host</span>
									<input value={host} onChange={(e) => setHost(e.target.value)} />
								</label>
								<label className="field" style={{ flex: "1 1 0" }}>
									<span>Port</span>
									<input
										type="number"
										value={port}
										onChange={(e) => setPort(Number(e.target.value))}
									/>
								</label>
							</div>
							<div className="row" style={{ gap: 8 }}>
								<label className="field" style={{ flex: "1 1 0" }}>
									<span>Database</span>
									<input value={database} onChange={(e) => setDatabase(e.target.value)} />
								</label>
								<label className="field" style={{ flex: "1 1 0" }}>
									<span>Username</span>
									<input value={username} onChange={(e) => setUsername(e.target.value)} />
								</label>
							</div>
							<label className="field">
								<span>Password reference</span>
								<input
									value={secretRef}
									onChange={(e) => setSecretRef(e.target.value)}
									placeholder="/run/secrets/postgres_password"
								/>
								<em className="field-hint">
									The NAME of a Docker secret file or environment variable — never the password
									itself. A password stored here would be readable by anyone who can read the
									workspace and would appear in every backup.
								</em>
							</label>

							{testResult && (
								<div className={`banner ${testResult.ok ? "" : "error"}`}>
									{testResult.ok ? (
										<>
											Connected in {testResult.latencyMs}ms
											{testResult.serverVersion ? ` — ${testResult.serverVersion}` : ""}
										</>
									) : (
										<>Failed: {testResult.detail}</>
									)}
								</div>
							)}
						</>
					)}

					{kind !== "folder" && (
						<label className="field">
							<span>Description</span>
							<textarea
								rows={3}
								value={description}
								onChange={(event) => setDescription(event.target.value)}
							/>
						</label>
					)}

					{problem && <div className="banner error">{problem}</div>}

					<div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
						{kind === "connection" && (
							<button
								className="btn sm"
								onClick={testConnection}
								disabled={busy || !host || !database || !username}
								style={{ marginRight: "auto" }}
							>
								Test connection
							</button>
						)}
						<button className="btn sm" onClick={onClose}>
							Cancel
						</button>
						<button
							className="btn sm primary"
							onClick={submit}
							disabled={busy || !name.trim() || (kind === "dataset" && !view)}
						>
							{busy ? "Working…" : "Create"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
