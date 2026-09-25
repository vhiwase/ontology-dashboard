/**
 * Code repositories: where ingestion and functions are written down.
 *
 * Before this there was nowhere to keep work. A pipeline was a canvas, a
 * function was one definition pasted into a dialog, and neither had a file, a
 * history, or a way to publish several related changes as one reviewed act.
 *
 * The model is Foundry's, in the three flavours this platform needs:
 *
 *   transforms  SQL, and the syncs that bring data in.
 *               `*.sync.json` declares a pull through a connection; building
 *               the repository creates the sync and runs it, so the data
 *               arrives. `transforms/*.sql` declares a table built from what
 *               landed. Building produces datasets.
 *
 *   python      `transforms/*.py`, for the work SQL reads badly: per-row
 *               logic, branching, reshaping. These RUN — see
 *               pythonTransforms.ts — and each one must write a dataset or
 *               fail the build saying why.
 *
 *   functions   files that define a named computation. Building publishes each
 *               into the function catalogue.
 *
 * ── what a build does and does not run ──────────────────────────────────────
 * A SQL transform goes through the same compiler a pipeline node does — one
 * SELECT, no stacked statements, no writes — and is materialised by
 * `CREATE TABLE … AS SELECT * FROM (<sql>)`, which makes "SELECT only"
 * structural rather than merely checked.
 *
 * A PYTHON transform is different in kind: it is code, and it executes in a
 * subprocess with an empty environment, a time limit and no database handle.
 * pythonTransforms.ts documents exactly what that does and does not protect
 * against. A Python or TypeScript file under `functions/` is still only
 * published as a definition and reported as not executable — the function
 * catalogue runs SQL, and a function is something a dashboard calls, which is
 * a different contract from a transform that runs once at build time.
 *
 * ── publishing is not approving ─────────────────────────────────────────────
 * A functions build publishes as `proposed`. Approval stays a separate,
 * admin-level, human act, and a build will not edit a function that is already
 * active — it reports that file as skipped and says what to do instead. A
 * repository is a place to write a definition down, not a way around the
 * review that lets it produce numbers on someone else's dashboard.
 */

import { query, queryOne } from "./db";
import { compileNode, type InputRelation } from "./compile";
import {
	createSync,
	getSync,
	listSyncs,
	runSync,
	type SyncRequest,
} from "./connections";
import {
	deriveNames,
	getFunction,
	proposeFunction,
	updateFunction,
	type FunctionRecord,
} from "./functions";
import {
	runPythonTransform,
	TransformFailed,
	type TransformResult,
} from "./pythonTransforms";
import { BadRequest, currentSpace, NotFound, quoteIdentifier } from "./registry";
import type { PipelineNode } from "./pipelines";

/** Where a built transform materialises. Never tms_views: that is the contract. */
export const BUILD_SCHEMA = "repo_out";

/**
 * What a repository builds into.
 *
 *   transforms  SQL. One SELECT per file, compiled and materialised.
 *   python      code. Runs, and must write a dataset or fail saying why.
 *   functions   definitions published into the function catalogue.
 */
export type RepoKind = "transforms" | "python" | "functions";

// ── records ─────────────────────────────────────────────────────────────────

export interface RepoRecord {
	id: number;
	spaceSlug: string;
	slug: string;
	name: string;
	description: string | null;
	kind: RepoKind;
	defaultBranch: string;
	fileCount: number;
	commitCount: number;
	lastCommitAt: string | null;
	lastBuild: BuildRecord | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface FileRecord {
	id: number;
	repoId: number;
	path: string;
	content: string;
	language: string;
	updatedBy: string;
	updatedAt: string;
}

export interface CommitRecord {
	id: number;
	repoId: number;
	sequence: number;
	message: string;
	author: string;
	createdAt: string;
	fileCount: number;
}

/** One line of a build log: what the build did with one file. */
export interface BuildArtifact {
	path: string;
	kind: "sync" | "transform" | "function" | "ignored";
	status: "created" | "updated" | "unchanged" | "skipped" | "failed";
	message: string;
	/** What it produced: a dataset relation, or a function's api name. */
	produced: string | null;
	rows: number | null;
	durationMs: number;
}

export interface BuildRecord {
	id: number;
	repoId: number;
	commitId: number | null;
	commitSequence: number | null;
	status: "running" | "success" | "failed";
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	artifacts: BuildArtifact[];
	errorMessage: string | null;
	triggeredBy: string;
}

type RepoRow = {
	repo_id: number;
	space_slug: string;
	slug: string;
	name: string;
	description: string | null;
	kind: RepoKind;
	default_branch: string;
	created_by: string;
	created_at: Date;
	updated_at: Date;
	file_count: string;
	commit_count: string;
	last_commit_at: Date | null;
};

type BuildRow = {
	build_id: number;
	repo_id: number;
	commit_id: number | null;
	commit_sequence: number | null;
	status: BuildRecord["status"];
	started_at: Date;
	finished_at: Date | null;
	duration_ms: number | null;
	artifacts: BuildArtifact[];
	error_message: string | null;
	triggered_by: string;
};

const REPO_SELECT = `
	SELECT r.*, s.slug AS space_slug,
	       (SELECT count(*) FROM platform.code_file f WHERE f.repo_id = r.repo_id)::text
	         AS file_count,
	       (SELECT count(*) FROM platform.code_commit c WHERE c.repo_id = r.repo_id)::text
	         AS commit_count,
	       (SELECT max(c.created_at) FROM platform.code_commit c WHERE c.repo_id = r.repo_id)
	         AS last_commit_at
	  FROM platform.code_repo r
	  JOIN platform.space s ON s.space_id = r.space_id`;

const BUILD_SELECT = `
	SELECT b.*, c.sequence AS commit_sequence
	  FROM platform.code_build b
	  LEFT JOIN platform.code_commit c ON c.commit_id = b.commit_id`;

function toBuild(row: BuildRow): BuildRecord {
	return {
		// BIGINT reaches here as a string; coerced once so an id is an id
		// everywhere downstream.
		id: Number(row.build_id),
		repoId: Number(row.repo_id),
		commitId: row.commit_id === null ? null : Number(row.commit_id),
		commitSequence: row.commit_sequence,
		status: row.status,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		durationMs: row.duration_ms,
		artifacts: row.artifacts ?? [],
		errorMessage: row.error_message,
		triggeredBy: row.triggered_by,
	};
}

async function lastBuildOf(repoId: number): Promise<BuildRecord | null> {
	const row = await queryOne<BuildRow>(
		`${BUILD_SELECT} WHERE b.repo_id = $1 ORDER BY b.started_at DESC, b.build_id DESC LIMIT 1`,
		[repoId],
	);
	return row ? toBuild(row) : null;
}

async function toRepo(row: RepoRow): Promise<RepoRecord> {
	return {
		id: Number(row.repo_id),
		spaceSlug: row.space_slug,
		slug: row.slug,
		name: row.name,
		description: row.description,
		kind: row.kind,
		defaultBranch: row.default_branch,
		fileCount: Number(row.file_count),
		commitCount: Number(row.commit_count),
		lastCommitAt: row.last_commit_at?.toISOString() ?? null,
		lastBuild: await lastBuildOf(row.repo_id),
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function listRepos(spaceSlug?: string): Promise<RepoRecord[]> {
	const rows = await query<RepoRow>(
		`${REPO_SELECT} WHERE s.slug = $1 ORDER BY r.kind, r.name`,
		[spaceSlug ?? currentSpace()],
	);
	return Promise.all(rows.map(toRepo));
}

/** The repository, or null. Used where "not there" is an ordinary answer. */
export async function findRepo(spaceSlug: string, slug: string): Promise<RepoRecord | null> {
	const row = await queryOne<RepoRow>(`${REPO_SELECT} WHERE s.slug = $1 AND r.slug = $2`, [
		spaceSlug,
		slug,
	]);
	return row ? toRepo(row) : null;
}

export async function getRepo(slug: string, spaceSlug?: string): Promise<RepoRecord> {
	const repo = await findRepo(spaceSlug ?? currentSpace(), slug);
	if (!repo) {
		throw new NotFound(`No repository '${slug}' in the '${spaceSlug ?? currentSpace()}' space.`);
	}
	return repo;
}

export async function listFiles(repoId: number): Promise<FileRecord[]> {
	const rows = await query<{
		file_id: number;
		repo_id: number;
		path: string;
		content: string;
		language: string;
		updated_by: string;
		updated_at: Date;
	}>("SELECT * FROM platform.code_file WHERE repo_id = $1 ORDER BY path", [repoId]);
	return rows.map((row) => ({
		id: Number(row.file_id),
		repoId: Number(row.repo_id),
		path: row.path,
		content: row.content,
		language: row.language,
		updatedBy: row.updated_by,
		updatedAt: row.updated_at.toISOString(),
	}));
}

export async function listCommits(repoId: number, limit = 50): Promise<CommitRecord[]> {
	const rows = await query<{
		commit_id: number;
		repo_id: number;
		sequence: number;
		message: string;
		author: string;
		created_at: Date;
		file_count: number;
	}>(
		`SELECT commit_id, repo_id, sequence, message, author, created_at, file_count
		   FROM platform.code_commit WHERE repo_id = $1
		  ORDER BY sequence DESC LIMIT $2`,
		[repoId, Math.min(Math.max(1, limit), 200)],
	);
	return rows.map((row) => ({
		id: Number(row.commit_id),
		repoId: Number(row.repo_id),
		sequence: row.sequence,
		message: row.message,
		author: row.author,
		createdAt: row.created_at.toISOString(),
		fileCount: row.file_count,
	}));
}

export async function listBuilds(repoId: number, limit = 25): Promise<BuildRecord[]> {
	const rows = await query<BuildRow>(
		`${BUILD_SELECT} WHERE b.repo_id = $1 ORDER BY b.started_at DESC, b.build_id DESC LIMIT $2`,
		[repoId, Math.min(Math.max(1, limit), 100)],
	);
	return rows.map(toBuild);
}

// ── paths and languages ─────────────────────────────────────────────────────

/**
 * A repository path, checked before it is stored.
 *
 * A path decides what a file MEANS here — `functions/x.sql` is published and
 * `README.md` is not — so it is not free text. `..` and absolute paths are
 * refused even though nothing here touches a filesystem: the day something
 * does, this check will already be in place.
 */
export function assertRepoPath(path: string): string {
	const trimmed = String(path ?? "").trim().replace(/\\/g, "/");
	if (!trimmed) throw new BadRequest("A file needs a path.");
	if (trimmed.length > 255) throw new BadRequest("A path is at most 255 characters.");
	if (trimmed.startsWith("/")) throw new BadRequest("A path is relative to the repository root.");
	if (trimmed.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new BadRequest(`'${trimmed}' is not a valid path.`);
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
		throw new BadRequest(
			"A path may hold letters, digits, '.', '_', '-' and '/' only.",
		);
	}
	return trimmed;
}

export function languageForPath(path: string): string {
	if (path.endsWith(".sql")) return "sql";
	if (path.endsWith(".py")) return "python";
	if (path.endsWith(".ts")) return "typescript";
	if (path.endsWith(".json")) return "json";
	if (path.endsWith(".md")) return "markdown";
	throw new BadRequest(
		`'${path}' has no extension this repository understands. ` +
			"Use .sql, .py, .ts, .json or .md.",
	);
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface CreateRepoRequest {
	name: string;
	description?: string | null;
	kind: RepoKind;
}

function slugify(value: string): string {
	const slug = value
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	if (!slug) throw new BadRequest("A repository needs a name with a letter or a digit in it.");
	return slug;
}

export async function createRepo(
	request: CreateRepoRequest,
	createdBy: string,
	spaceSlug?: string,
): Promise<RepoRecord> {
	const space = spaceSlug ?? currentSpace();
	const name = String(request.name ?? "").trim();
	if (!name) throw new BadRequest("A repository needs a name.");
	if (!["transforms", "python", "functions"].includes(request.kind)) {
		throw new BadRequest(
			`'${request.kind}' is not a repository kind. Use 'python' for transforms with ` +
				"logic in them, 'transforms' for SQL and syncs, or 'functions' to publish " +
				"computations.",
		);
	}

	const slug = slugify(name);
	const clash = await findRepo(space, slug);
	if (clash) throw new BadRequest(`This space already has a repository called '${name}'.`);

	const row = await queryOne<{ repo_id: number }>(
		`INSERT INTO platform.code_repo (space_id, slug, name, description, kind, created_by)
		 SELECT s.space_id, $2, $3, $4, $5, $6 FROM platform.space s WHERE s.slug = $1
		 RETURNING repo_id`,
		[space, slug, name, request.description ?? null, request.kind, createdBy],
	);
	if (!row) throw new BadRequest(`No space '${space}' to create the repository in.`);

	return getRepo(slug, space);
}

export async function deleteRepo(repoId: number): Promise<void> {
	const row = await queryOne<{ slug: string }>(
		"DELETE FROM platform.code_repo WHERE repo_id = $1 RETURNING slug",
		[repoId],
	);
	if (!row) throw new NotFound(`No repository ${repoId}.`);
	// The resource that pointed at it goes too, or the workspace keeps a card
	// that opens nothing. Tables the repository built are left alone: something
	// may be reading them, and dropping data is not what deleting code means.
	await query("DELETE FROM platform.resource WHERE kind = 'codeRepo' AND target_ref = $1", [
		row.slug,
	]);
}

export async function putFile(
	repoId: number,
	path: string,
	content: string,
	author: string,
): Promise<FileRecord> {
	const clean = assertRepoPath(path);
	const language = languageForPath(clean);
	const body = String(content ?? "");
	if (body.length > 200_000) {
		throw new BadRequest("A file here is at most 200,000 characters.");
	}

	const row = await queryOne<{ file_id: number }>(
		`INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
		 VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (repo_id, path) DO UPDATE
		    SET content = EXCLUDED.content, language = EXCLUDED.language,
		        updated_by = EXCLUDED.updated_by, updated_at = now()
		 RETURNING file_id`,
		[repoId, clean, body, language, author],
	);
	if (!row) throw new BadRequest("The file could not be saved.");

	await query("UPDATE platform.code_repo SET updated_at = now() WHERE repo_id = $1", [repoId]);
	const files = await listFiles(repoId);
	return files.find((file) => file.path === clean)!;
}

export async function deleteFile(repoId: number, path: string): Promise<void> {
	const row = await queryOne<{ file_id: number }>(
		"DELETE FROM platform.code_file WHERE repo_id = $1 AND path = $2 RETURNING file_id",
		[repoId, assertRepoPath(path)],
	);
	if (!row) throw new NotFound(`No file '${path}' in this repository.`);
}

/**
 * Snapshot the tree.
 *
 * The whole tree rather than a diff: these are a handful of small text files,
 * and a snapshot means a build can be reproduced from its commit alone instead
 * of by replaying everything before it.
 */
export async function commitRepo(
	repoId: number,
	message: string,
	author: string,
): Promise<CommitRecord> {
	const text = String(message ?? "").trim();
	if (!text) throw new BadRequest("A commit needs a message saying what changed and why.");

	const files = await listFiles(repoId);
	if (files.length === 0) throw new BadRequest("There is nothing to commit: the repository is empty.");

	const head = await queryOne<{ sequence: number; files: Record<string, string> }>(
		"SELECT sequence, files FROM platform.code_commit WHERE repo_id = $1 ORDER BY sequence DESC LIMIT 1",
		[repoId],
	);

	const tree: Record<string, string> = {};
	for (const file of files) tree[file.path] = file.content;

	if (head && JSON.stringify(head.files ?? {}) === JSON.stringify(tree)) {
		throw new BadRequest("Nothing has changed since the last commit.");
	}

	const row = await queryOne<{
		commit_id: number;
		repo_id: number;
		sequence: number;
		message: string;
		author: string;
		created_at: Date;
		file_count: number;
	}>(
		`INSERT INTO platform.code_commit (repo_id, sequence, message, author, files, file_count)
		 VALUES ($1,$2,$3,$4,$5::jsonb,$6)
		 RETURNING commit_id, repo_id, sequence, message, author, created_at, file_count`,
		[repoId, (head?.sequence ?? 0) + 1, text, author, JSON.stringify(tree), files.length],
	);
	if (!row) throw new BadRequest("The commit could not be recorded.");

	await query("UPDATE platform.code_repo SET updated_at = now() WHERE repo_id = $1", [repoId]);
	return {
		id: Number(row.commit_id),
		repoId: Number(row.repo_id),
		sequence: row.sequence,
		message: row.message,
		author: row.author,
		createdAt: row.created_at.toISOString(),
		fileCount: row.file_count,
	};
}

// ── parsing what a file declares ────────────────────────────────────────────

/**
 * The `key: value` header at the top of a file.
 *
 * Comment syntax varies with the language, so all three leading forms are
 * accepted and the first line that is not a comment ends the header. A
 * decorator would be closer to Foundry, but a decorator is code, and nothing
 * here executes code.
 */
export function parseHeader(content: string): {
	header: Record<string, string>;
	body: string;
} {
	const lines = String(content ?? "").split(/\r?\n/);
	const header: Record<string, string> = {};
	let index = 0;

	for (; index < lines.length; index += 1) {
		const line = lines[index]!;
		// A blank line between comment lines is part of the header, not the end
		// of it: a header with a paragraph break in it is still a header.
		if (line.trim() === "") continue;

		// Two forms, because a transform reads better as `-- @output x` and a
		// function reads better as `-- name: x`. The colon is required in the
		// second, or every line of prose with a word before a space would be
		// read as a declaration.
		const match =
			/^\s*(?:--|#|\/\/)\s*@([A-Za-z][A-Za-z0-9_]*)\s*:?\s+(.*)$/.exec(line) ??
			/^\s*(?:--|#|\/\/)\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			// A comment that is not a declaration is prose, and prose ends nothing.
			if (/^\s*(--|#|\/\/)/.test(line)) continue;
			break;
		}
		const key = match[1]!.toLowerCase();
		// First wins: a later line mentioning the same word in prose must not
		// silently replace the declaration above it.
		if (!(key in header)) header[key] = match[2]!.trim();
	}

	return { header, body: lines.slice(index).join("\n").trim() };
}

export interface TransformDeclaration {
	output: string;
	outputTable: string;
	sql: string;
}

/**
 * What a `transforms/*.sql` file declares.
 *
 * The output must be in repo_out. A transform that could write anywhere would
 * be able to replace a view the ontology is generated from, which is the one
 * thing on this platform that has to stay the contract.
 */
export function parseTransform(content: string, path: string): TransformDeclaration {
	const { header, body } = parseHeader(content);
	const output = header.output ?? "";
	if (!output) {
		throw new BadRequest(
			`${path} does not say where it writes. Add a header line: -- @output ${BUILD_SCHEMA}.<table>`,
		);
	}
	const [schema, table, ...rest] = output.split(".");
	if (rest.length > 0 || !schema || !table) {
		throw new BadRequest(`'${output}' in ${path} is not a schema-qualified table name.`);
	}
	if (schema !== BUILD_SCHEMA) {
		throw new BadRequest(
			`${path} writes to '${output}'. A transform may only write into ${BUILD_SCHEMA}: ` +
				"the view layer is the contract the ontology is generated from and is not " +
				"a build's to overwrite.",
		);
	}
	if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
		throw new BadRequest(
			`'${table}' in ${path} is not a plain lower-case identifier, so it cannot be a table name.`,
		);
	}
	if (!body) throw new BadRequest(`${path} has a header but no SELECT under it.`);

	return { output: `${schema}.${table}`, outputTable: table, sql: body };
}

export interface FunctionDeclaration {
	name: string;
	description: string | null;
	businessQuestion: string | null;
	returns: "scalar" | "table";
	returnType: string | null;
	unit: string | null;
	valueFormat: string;
	language: "sql" | "python" | "typescript";
	definition: string;
}

/** What a `functions/*` file declares. `name` is the only required field. */
export function parseFunctionFile(content: string, path: string): FunctionDeclaration {
	const { header, body } = parseHeader(content);

	const name = header.name ?? "";
	if (!name) {
		throw new BadRequest(
			`${path} has no name. Add a header line: -- name: Average Weight Per Piece`,
		);
	}
	if (!body) throw new BadRequest(`${path} has a header but no definition under it.`);

	const returns = (header.returns ?? "scalar").toLowerCase();
	if (returns !== "scalar" && returns !== "table") {
		throw new BadRequest(`'${returns}' in ${path} is not a return shape. Use 'scalar' or 'table'.`);
	}

	const language = languageForPath(path);
	if (language !== "sql" && language !== "python" && language !== "typescript") {
		throw new BadRequest(`${path} is a ${language} file, which is not a function definition.`);
	}

	return {
		name,
		description: header.description ?? null,
		businessQuestion: header.businessquestion ?? null,
		returns,
		returnType: header.returntype ?? null,
		unit: header.unit ?? null,
		valueFormat: header.valueformat ?? "number",
		language,
		definition: body,
	};
}

/** What a `*.sync.json` file declares, checked as JSON before it is trusted. */
export function parseSyncFile(content: string, path: string): SyncRequest & { connection: string } {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(content) as Record<string, unknown>;
	} catch (error) {
		throw new BadRequest(`${path} is not valid JSON: ${(error as Error).message}`);
	}

	const connection = String(parsed.connection ?? "").trim();
	if (!connection) {
		throw new BadRequest(`${path} does not name a connection to pull through.`);
	}
	const source = (parsed.source ?? {}) as Record<string, unknown>;

	return {
		connection,
		name: String(parsed.name ?? "").trim(),
		description: parsed.description ? String(parsed.description) : null,
		sourceSchema: String(source.schema ?? ""),
		sourceTable: String(source.table ?? ""),
		mode: (parsed.mode as SyncRequest["mode"]) ?? "snapshot",
		cursorColumn: parsed.cursorColumn ? String(parsed.cursorColumn) : null,
		rowLimit: parsed.rowLimit === undefined ? undefined : Number(parsed.rowLimit),
	};
}

// ── building ────────────────────────────────────────────────────────────────

/** The connection resource a `.sync.json` names, looked up within the space. */
async function connectionByName(spaceSlug: string, name: string): Promise<number> {
	const row = await queryOne<{ resource_id: number }>(
		`SELECT r.resource_id
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND r.kind = 'connection' AND r.name = $2
		  ORDER BY r.resource_id LIMIT 1`,
		[spaceSlug, name],
	);
	if (!row) {
		throw new BadRequest(
			`No connection called '${name}' in the '${spaceSlug}' space. ` +
				"Register it under a project's Connections folder first.",
		);
	}
	return row.resource_id;
}

/**
 * Materialise one transform.
 *
 * `CREATE TABLE … AS SELECT * FROM (<sql>)` — the compiled statement is wrapped
 * in a subquery and never spliced in at the top level, so a non-SELECT is a
 * syntax error in that position rather than something the text checks have to
 * catch, and a data-modifying CTE is rejected by PostgreSQL itself.
 */
async function materialiseTransform(
	declaration: TransformDeclaration,
): Promise<number> {
	const compiled = compileNode(
		{
			id: "transform",
			kind: "sql",
			name: declaration.output,
			position: { x: 0, y: 0 },
			config: { sql: declaration.sql },
		} as PipelineNode,
		[] as InputRelation[],
	);

	const target = `${quoteIdentifier(BUILD_SCHEMA)}.${quoteIdentifier(declaration.outputTable)}`;
	await query(`DROP TABLE IF EXISTS ${target}`);
	await query(`CREATE TABLE ${target} AS SELECT * FROM (${compiled.sql}) AS _t`, compiled.params);

	const counted = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM ${target}`);
	return Number(counted?.n ?? 0);
}

/** Register (or refresh) the dataset a built transform produced. */
async function ensureTransformDataset(
	repo: RepoRecord,
	declaration: { output: string; outputTable: string; sql: string },
	rows: number,
	path: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	const project = await queryOne<{ project_id: number; folder_id: number | null }>(
		`SELECT p.project_id,
		        (SELECT f.folder_id FROM platform.folder f
		          WHERE f.project_id = p.project_id AND f.path = '/Datasets') AS folder_id
		   FROM platform.project p
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 ORDER BY p.project_id LIMIT 1`,
		[repo.spaceSlug],
	);
	// A space with no project yet has nowhere to put a dataset resource. The
	// table is still built; it simply has no card until the space is seeded.
	if (!project) return;

	const properties = {
		sourceView: declaration.output,
		backing: "transform" as const,
		repo: repo.slug,
		repoKind: repo.kind,
		repoPath: path,
		rowCount: rows,
		builtAt: new Date().toISOString(),
		...extra,
	};

	const existing = await queryOne<{ resource_id: number }>(
		`SELECT resource_id FROM platform.resource
		  WHERE project_id = $1 AND kind = 'dataset' AND target_ref = $2`,
		[project.project_id, declaration.output],
	);

	if (existing) {
		await query(
			"UPDATE platform.resource SET properties = $2::jsonb, updated_at = now() WHERE resource_id = $1",
			[existing.resource_id, JSON.stringify(properties)],
		);
		return;
	}

	await query(
		`INSERT INTO platform.resource
		   (project_id, folder_id, kind, name, description, target_ref, properties, created_by)
		 VALUES ($1,$2,'dataset',$3,$4,$5,$6::jsonb,'system')
		 ON CONFLICT DO NOTHING`,
		[
			project.project_id,
			project.folder_id,
			declaration.outputTable,
			`Built by ${repo.slug}/${path}.`,
			declaration.output,
			JSON.stringify(properties),
		],
	);
}

/** Publish one function file, or say why it was left alone. */
async function publishFunction(
	declaration: FunctionDeclaration,
	path: string,
	author: string,
): Promise<{ status: BuildArtifact["status"]; message: string; apiName: string }> {
	const { apiName } = deriveNames(declaration.name);

	let existing: FunctionRecord | null = null;
	try {
		existing = await getFunction(apiName);
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
	}

	if (!existing) {
		const created = await proposeFunction(
			{
				name: declaration.name,
				description: declaration.description ?? undefined,
				businessQuestion: declaration.businessQuestion ?? undefined,
				language: declaration.language,
				definition: declaration.definition,
				returns: declaration.returns,
				returnType: declaration.returnType ?? undefined,
				unit: declaration.unit ?? undefined,
				valueFormat: declaration.valueFormat,
				proposedFrom: `repository file ${path}`,
			},
			author,
		);
		return {
			status: "created",
			apiName: created.apiName,
			message:
				`Published as '${created.apiName}', proposed. ` +
				"Approve it on the Functions page to let anything compute from it." +
				(created.isExecutable ? "" : ` ${created.notExecutableReason}`),
		};
	}

	const unchanged =
		existing.definition.trim() === declaration.definition.trim() &&
		existing.name === declaration.name &&
		(existing.description ?? null) === declaration.description &&
		existing.returns === declaration.returns &&
		(existing.unit ?? null) === declaration.unit;

	if (unchanged) {
		return { status: "unchanged", apiName, message: `'${apiName}' is already published as written.` };
	}

	if (existing.status === "active") {
		// Deliberately not overwritten. An active function is what a dashboard
		// already renders, and a build is not a review.
		return {
			status: "skipped",
			apiName,
			message:
				`'${apiName}' is active and a build does not replace a live definition. ` +
				"Archive it on the Functions page, or give this file a different name to " +
				"publish alongside it.",
		};
	}

	const updated = await updateFunction(
		apiName,
		{
			name: declaration.name,
			description: declaration.description ?? undefined,
			businessQuestion: declaration.businessQuestion ?? undefined,
			definition: declaration.definition,
			returns: declaration.returns,
			returnType: declaration.returnType ?? undefined,
			unit: declaration.unit ?? undefined,
			valueFormat: declaration.valueFormat,
		},
		author,
	);
	return {
		status: "updated",
		apiName,
		message: `'${apiName}' updated to version ${updated.version}, still ${updated.status}.`,
	};
}

/**
 * Build a repository: turn its committed files into things the platform uses.
 *
 * Builds the HEAD commit, not the working tree. A build of uncommitted edits
 * would produce a number nobody could reproduce, and reproducing a number is
 * most of what a repository is for.
 *
 * One artifact per file, so a build that half worked says exactly which half.
 * A file that fails does not stop the ones after it — the run reports failed
 * and the log names every file — because a broken transform should not hide
 * three working ones.
 */
export async function buildRepo(repoId: number, triggeredBy: string): Promise<BuildRecord> {
	const row = await queryOne<RepoRow>(`${REPO_SELECT} WHERE r.repo_id = $1`, [repoId]);
	if (!row) throw new NotFound(`No repository ${repoId}.`);
	const repo = await toRepo(row);

	const head = await queryOne<{ commit_id: number; sequence: number; files: Record<string, string> }>(
		"SELECT commit_id, sequence, files FROM platform.code_commit WHERE repo_id = $1 ORDER BY sequence DESC LIMIT 1",
		[repoId],
	);
	if (!head) {
		throw new BadRequest(
			"There is nothing to build: this repository has no commit yet. Commit the files first.",
		);
	}

	const started = Date.now();
	const build = await queryOne<{ build_id: number }>(
		`INSERT INTO platform.code_build (repo_id, commit_id, status, triggered_by)
		 VALUES ($1,$2,'running',$3) RETURNING build_id`,
		[repoId, head.commit_id, triggeredBy],
	);
	if (!build) throw new BadRequest("The build could not be recorded.");

	const artifacts: BuildArtifact[] = [];
	const files = Object.entries(head.files ?? {}).sort(([a], [b]) => a.localeCompare(b));

	// Syncs before transforms: a transform reads what a sync landed, so running
	// them the other way round would build yesterday's table from today's code.
	const order = (path: string): number => (path.endsWith(".sync.json") ? 0 : 1);
	files.sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));

	for (const [path, content] of files) {
		const fileStarted = Date.now();
		const record = (
			kind: BuildArtifact["kind"],
			status: BuildArtifact["status"],
			message: string,
			produced: string | null = null,
			rows: number | null = null,
		): void => {
			artifacts.push({
				path,
				kind,
				status,
				message,
				produced,
				rows,
				durationMs: Date.now() - fileStarted,
			});
		};

		try {
			if (path.endsWith(".sync.json")) {
				if (repo.kind !== "transforms") {
					record(
						"ignored",
						"skipped",
						`A ${repo.kind} repository does not run syncs. Declare them in a transforms repository.`,
					);
					continue;
				}
				const declared = parseSyncFile(content, path);
				const resourceId = await connectionByName(repo.spaceSlug, declared.connection);
				const sync = await createSync(resourceId, declared, triggeredBy);
				const outcome = await runSync(sync.id, triggeredBy);
				record(
					"sync",
					"updated",
					`Pulled ${outcome.run.rowsWritten ?? 0} rows from ${declared.sourceSchema}.${declared.sourceTable} ` +
						`through '${declared.connection}'` +
						(outcome.run.truncated
							? `, stopped at the ${sync.rowLimit}-row limit — the table is a prefix of the source.`
							: ".") +
						(outcome.widenedColumns.length > 0
							? ` Columns landed as text because they have no local equivalent: ${outcome.widenedColumns.join(", ")}.`
							: ""),
					sync.targetRelation,
					outcome.run.rowsAfter,
				);
				continue;
			}

			if (path.startsWith("transforms/") && path.endsWith(".py")) {
				if (repo.kind !== "python") {
					record(
						"ignored",
						"skipped",
						`A ${repo.kind} repository does not run Python. Create a python repository for it.`,
					);
					continue;
				}
				// The rule that makes a python repository coherent: it must
				// produce a dataset. Declaring no Output, or declaring one and
				// never writing to it, is a FAILED file with the reason on it -
				// not a green build that produced nothing.
				const result: TransformResult = await runPythonTransform(content, path);
				await ensureTransformDataset(
					repo,
					{ output: result.output, outputTable: result.outputTable, sql: "" },
					result.rowsWritten,
					path,
					{ language: "python", columns: result.columns, rowsRead: result.rowsRead },
				);
				record(
					"transform",
					"updated",
					`Ran ${path} and wrote ${result.rowsWritten} rows to ${result.output}` +
						` (${result.columns.length} columns, ${result.rowsRead} rows read).` +
						(result.log ? ` Output: ${result.log.slice(0, 400)}` : ""),
					result.output,
					result.rowsWritten,
				);
				continue;
			}

			if (path.startsWith("transforms/") && path.endsWith(".sql")) {
				if (repo.kind !== "transforms") {
					record(
						"ignored",
						"skipped",
						`A ${repo.kind} repository does not build SQL transforms.`,
					);
					continue;
				}
				const declaration = parseTransform(content, path);
				const rows = await materialiseTransform(declaration);
				await ensureTransformDataset(repo, declaration, rows, path);
				record("transform", "updated", `Built ${declaration.output} with ${rows} rows.`, declaration.output, rows);
				continue;
			}

			if (path.startsWith("functions/")) {
				if (repo.kind !== "functions") {
					record(
						"ignored",
						"skipped",
						`A ${repo.kind} repository does not publish functions.`,
					);
					continue;
				}
				const declaration = parseFunctionFile(content, path);
				const result = await publishFunction(declaration, path, triggeredBy);
				record("function", result.status, result.message, result.apiName);
				continue;
			}

			if (repo.kind === "python" && path.endsWith(".py")) {
				record(
					"ignored",
					"skipped",
					"Only transforms/*.py is built. Move it there, or keep it here as a module " +
						"the build does not run by itself.",
				);
				continue;
			}
			record("ignored", "unchanged", "Not a file a build acts on.");
		} catch (error) {
			const failure = error as Error;
			const detail = failure instanceof TransformFailed ? failure.detail : null;
			record(
				// A failed transform is still a transform: calling it "ignored"
				// buried the one line of the log anyone reads.
				path.endsWith(".py") || path.endsWith(".sql") ? "transform" : "ignored",
				"failed",
				detail ? `${failure.message}\n${detail}` : failure.message,
			);
		}
	}

	const failed = artifacts.filter((artifact) => artifact.status === "failed");
	const finished = await queryOne<BuildRow>(
		// The target is aliased so the correlated subquery can say which
		// commit_id it means. Unqualified, `c.commit_id = commit_id` resolves
		// both sides to the subquery's own column and matches every commit.
		`UPDATE platform.code_build AS b
		    SET status = $2, finished_at = now(), duration_ms = $3,
		        artifacts = $4::jsonb, error_message = $5
		  WHERE b.build_id = $1
		 RETURNING b.*,
		           (SELECT c.sequence FROM platform.code_commit c
		             WHERE c.commit_id = b.commit_id) AS commit_sequence`,
		[
			build.build_id,
			failed.length === 0 ? "success" : "failed",
			Date.now() - started,
			JSON.stringify(artifacts),
			failed.length === 0
				? null
				: `${failed.length} of ${artifacts.length} files failed: ${failed
						.map((artifact) => artifact.path)
						.join(", ")}.`,
		],
	);
	if (!finished) throw new BadRequest("The build result could not be recorded.");
	return toBuild(finished);
}

/**
 * Everything a repository produced, for the resource preview and for lineage.
 *
 * Read back from the platform rather than from the build log: what a
 * repository produces is whatever exists now, not whatever the last build
 * claimed.
 */
export async function repoOutputs(repo: RepoRecord): Promise<{
	datasets: Array<{ name: string; relation: string; rows: number | null }>;
	functions: Array<{ apiName: string; name: string; status: string }>;
	syncs: Array<{ name: string; connection: string; relation: string }>;
}> {
	if (repo.kind === "functions") {
		const rows = await query<{ api_name: string; name: string; status: string }>(
			`SELECT f.api_name, f.name, f.status
			   FROM platform.function f
			   JOIN platform.space s ON s.space_id = f.space_id
			  WHERE s.slug = $1 AND f.proposed_from LIKE $2
			  ORDER BY f.name`,
			[repo.spaceSlug, "repository file %"],
		);
		return {
			datasets: [],
			functions: rows.map((row) => ({ apiName: row.api_name, name: row.name, status: row.status })),
			syncs: [],
		};
	}

	const datasets = await query<{ name: string; target_ref: string; properties: Record<string, unknown> }>(
		`SELECT r.name, r.target_ref, r.properties
		   FROM platform.resource r
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space s ON s.space_id = p.space_id
		  WHERE s.slug = $1 AND r.kind = 'dataset' AND r.properties->>'repo' = $2
		  ORDER BY r.name`,
		[repo.spaceSlug, repo.slug],
	);

	// The syncs this repository declares, resolved through the connections they
	// name rather than stored on the repo: the file is the source of truth.
	const head = await queryOne<{ files: Record<string, string> }>(
		"SELECT files FROM platform.code_commit WHERE repo_id = $1 ORDER BY sequence DESC LIMIT 1",
		[repo.id],
	);
	const syncs: Array<{ name: string; connection: string; relation: string }> = [];
	for (const [path, content] of Object.entries(head?.files ?? {})) {
		if (!path.endsWith(".sync.json")) continue;
		try {
			const declared = parseSyncFile(content, path);
			const resourceId = await connectionByName(repo.spaceSlug, declared.connection);
			const found = (await listSyncs(resourceId)).find((sync) => sync.name === declared.name);
			if (found) {
				syncs.push({
					name: found.name,
					connection: declared.connection,
					relation: found.targetRelation,
				});
			}
		} catch {
			// A file that no longer resolves is reported by the next build, with
			// the reason. A listing is not the place to raise it.
		}
	}

	return {
		datasets: datasets.map((row) => ({
			name: row.name,
			relation: row.target_ref,
			rows: typeof row.properties?.rowCount === "number" ? row.properties.rowCount : null,
		})),
		functions: [],
		syncs,
	};
}

/** Re-exported so a route can read one sync without importing two modules. */
export { getSync };
