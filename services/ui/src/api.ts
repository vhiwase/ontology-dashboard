/**
 * API client.
 *
 * Everything goes through /api on the same origin: nginx proxies /api/assistant
 * to the AI-FDE service and the rest to the ontology service, and the Vite dev
 * server does the same. So there is no base URL to configure and no CORS to
 * arrange, in either environment.
 */

export interface ApiErrorShape {
	error: string;
	/** Present on a 500; quote it when reporting a fault so the log can be found. */
	requestId?: string;
}

/** Thrown when a request was deliberately cancelled, so callers can stay quiet. */
export function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

/**
 * True when the server is saying this space has no published ontology.
 *
 * A 409 rather than a 404: the endpoint exists and the request was well formed,
 * it is the state of the space that makes it unanswerable. Pages render an
 * empty state for it instead of an error, because an empty environment is
 * normal and a red banner would suggest something is broken.
 */
export function isMissingOntology(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly requestId?: string,
	) {
		super(message);
	}
}

// ── session ─────────────────────────────────────────────────────────────────

export interface SessionUser {
	username: string;
	role: "viewer" | "analyst" | "admin";
	ontologyRole: string;
}

const TOKEN_KEY = "tms.auth.token";
const USER_KEY = "tms.auth.user";
const EXPIRY_KEY = "tms.auth.expires";

/**
 * The signed-in session, held in localStorage.
 *
 * Every read is wrapped: storage throws in a private window and can come back
 * empty after a clear, and neither case should stop the app rendering - it
 * just means nobody is signed in.
 */
export const session = {
	token(): string | null {
		try {
			const expires = window.localStorage.getItem(EXPIRY_KEY);
			// Drop a token the server would reject anyway, so the UI shows the
			// login form rather than a wall of 401s.
			if (expires && Date.parse(expires) <= Date.now()) {
				session.clear();
				return null;
			}
			return window.localStorage.getItem(TOKEN_KEY);
		} catch {
			return null;
		}
	},
	user(): SessionUser | null {
		try {
			const raw = window.localStorage.getItem(USER_KEY);
			return raw ? (JSON.parse(raw) as SessionUser) : null;
		} catch {
			return null;
		}
	},
	set(token: string, user: SessionUser, expiresAt: string): void {
		try {
			window.localStorage.setItem(TOKEN_KEY, token);
			window.localStorage.setItem(USER_KEY, JSON.stringify(user));
			window.localStorage.setItem(EXPIRY_KEY, expiresAt);
		} catch {
			/* a session that cannot be persisted still works for this tab */
		}
	},
	clear(): void {
		try {
			window.localStorage.removeItem(TOKEN_KEY);
			window.localStorage.removeItem(USER_KEY);
			window.localStorage.removeItem(EXPIRY_KEY);
		} catch {
			/* nothing to clear */
		}
	},
};

// ── the active space ────────────────────────────────────────────────────────

/**
 * The space every request is made in.
 *
 * The ontology belongs to a space, so a request that does not name one gets
 * the sandbox's — which is how object types, links, actions and lineage came
 * to look identical in every space. Holding it here rather than passing it
 * from each page means a call added later is scoped by default: the same
 * reasoning as AsyncLocalStorage on the server, and the mirror image of it.
 *
 * SpaceProvider owns the value; this is only where the client reads it.
 */
let activeSpace = "sandbox";

export function setActiveSpace(slug: string): void {
	activeSpace = slug || "sandbox";
}

/**
 * Add ?space= to a relative path, unless the caller already set one.
 *
 * Auth is deliberately exempt: logging in has no space, and it happens before
 * one is known.
 */
function withSpace(path: string): string {
	if (path.startsWith("/api/auth/")) return path;
	const [base, query = ""] = path.split("?");
	const params = new URLSearchParams(query);
	if (!params.has("space")) params.set("space", activeSpace);
	return `${base}?${params.toString()}`;
}

/** Notified when the server rejects our token, so the app can show the login. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
	onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const token = session.token();
	const response = await fetch(withSpace(path), {
		...init,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(init?.headers ?? {}),
		},
	});
	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		let requestId: string | undefined;
		try {
			const body = (await response.json()) as ApiErrorShape & { detail?: string };
			message = body.error ?? body.detail ?? message;
			requestId = body.requestId;
		} catch {
			/* keep the status line */
		}
		// 401 means this token is finished - expired, revoked, or the user was
		// deactivated. Drop it and let the app re-authenticate, rather than
		// leaving every subsequent call to fail the same way.
		if (response.status === 401) {
			session.clear();
			onUnauthorized();
		}
		throw new ApiError(message, response.status, requestId);
	}
	if (response.status === 204) return undefined as T;
	const text = await response.text();
	if (!text) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		// Export endpoints return turtle, mermaid and dot as plain text.
		return text as unknown as T;
	}
}

export const api = {
	get: <T>(path: string) => request<T>(path),
	post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
		request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}), signal }),
	patch: <T>(path: string, body?: unknown) =>
		request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
	/** Saving a repository file: the path identifies it, so writing one is a PUT. */
	put: <T>(path: string, body?: unknown) =>
		request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
	/** A body is optional: deleting a pipeline sends the outputs chosen to drop. */
	del: <T>(path: string, body?: unknown) =>
		request<T>(
			path,
			body === undefined ? { method: "DELETE" } : { method: "DELETE", body: JSON.stringify(body) },
		),

	async login(username: string, password: string): Promise<SessionUser> {
		const result = await request<{
			token: string;
			expiresAt: string;
			user: SessionUser;
		}>("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username, password }),
		});
		session.set(result.token, result.user, result.expiresAt);
		return result.user;
	},

	logout(): void {
		// The token is stateless, so signing out is a local act. Revoking one
		// before it expires is an admin operation: pipeline.users revoke.
		session.clear();
	},
};

// ── types mirrored from the services ───────────────────────────────────────

export interface ObjectTypeSummary {
	apiName: string;
	rid: string;
	label: string;
	pluralLabel: string | null;
	description: string | null;
	kind: string;
	group: string | null;
	icon: string | null;
	color: string | null;
	rowCount: number;
	propertyCount: number;
	measureCount: number;
	linkCount: number;
	sourceView: string;
	titleProperty: string | null;
	primaryKeyProperty: string | null;
}

export interface PropertyMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	datatype: string;
	sqlColumn: string;
	sqlType: string | null;
	isIdentity: boolean;
	isTitle: boolean;
	isNullable: boolean;
	isForeignKey: boolean;
	semanticRole: string;
	defaultAggregation: string | null;
	unit: string | null;
	displayOrder: number;
}

export interface LinkSummary {
	apiName: string;
	label: string;
	description: string | null;
	direction: "forward" | "inverse";
	targetObjectType: string;
	cardinality: string;
	matchRatio: number;
	isVerified: boolean;
	discoveryMethod: string;
	sourceProperty: string | null;
}

export interface ActionSummary {
	apiName: string;
	label: string;
	description: string | null;
	isReadOnly: boolean;
	requiresApproval: boolean;
	allowedRoles: string[];
	parameters: Array<Record<string, unknown>>;
}

export interface ObjectTypeDetail extends ObjectTypeSummary {
	properties: PropertyMeta[];
	links: LinkSummary[];
	actions: ActionSummary[];
	kpis: Array<{ apiName: string; label: string; category: string }>;
}

export interface LinkTypeRow {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	sourceObjectType: string;
	targetObjectType: string;
	sourceApiName: string | null;
	targetApiName: string | null;
	sourceColumn: string;
	targetColumn: string;
	cardinality: string;
	inverseApiName: string | null;
	inverseLabel: string | null;
	discoveryMethod: string;
	matchRatio: number;
	matchedRows: number;
	candidateRows: number;
	isVerified: boolean;
}

export interface SearchResult {
	objectType: string;
	label: string;
	totalCount: number;
	returned: number;
	limit: number;
	offset: number;
	properties: Array<{
		apiName: string;
		label: string;
		datatype: string;
		semanticRole: string;
		unit: string | null;
	}>;
	data: Array<Record<string, unknown>>;
	sql: string;
}

export interface KpiMeta {
	rid: string;
	apiName: string;
	label: string;
	description: string | null;
	businessQuestion: string | null;
	category: string;
	sourceView: string;
	measureColumn: string | null;
	aggregation: string;
	dimensions: string[];
	defaultDimension: string | null;
	timeColumn: string | null;
	unit: string | null;
	valueFormat: string;
	higherIsBetter: boolean | null;
	targetValue: number | null;
	warningThreshold: number | null;
	criticalThreshold: number | null;
	relatedObjectTypes: string[];
	dependsOnSimulation: boolean;
	coverageNote: string | null;
	displayOrder: number;
}

export interface KpiResult {
	kpi: string;
	label: string;
	unit: string | null;
	valueFormat: string;
	higherIsBetter: boolean | null;
	target: number | null;
	warningThreshold: number | null;
	criticalThreshold: number | null;
	businessQuestion: string | null;
	description: string | null;
	total: number | null;
	dimension: string | null;
	dimensionLabel: string | null;
	series: Array<{ label: string; value: number | null }>;
	rowCount: number;
	dependsOnSimulation: boolean;
	coverageNote: string | null;
	sql: string;
	appliedFilters: Record<string, unknown>;
}

export interface Widget {
	type: "stat" | "chart" | "table" | "note";
	kpi?: string;
	title?: string;
	dimension?: string | null;
	chart?: "bar" | "hbar" | "line" | "area" | "donut";
	limit?: number;
	sort?: string;
	filters?: Record<string, unknown>;
	width?: number;
	body?: string;
}

export interface DashboardSummary {
	id: number;
	slug: string;
	title: string;
	description: string | null;
	layout: Widget[];
	filters: Record<string, unknown>;
	audience: string | null;
	isAiGenerated: boolean;
	sourcePrompt: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	isPinned: boolean;
}

export interface ResolvedDashboard extends DashboardSummary {
	widgets: Array<Widget & { index: number; data: KpiResult | null; error: string | null }>;
	coverageNotes: string[];
	dependsOnSimulation: boolean;
}

export interface PlatformStats {
	ontology: {
		id: string;
		version: string;
		label: string | null;
		description: string | null;
		createdAt: string;
		validation: Record<string, unknown>;
	};
	counts: {
		objectTypes: number;
		objects: number;
		properties: number;
		linkTypes: number;
		completeLinks: number;
		actionTypes: number;
		readOnlyActions: number;
		kpis: number;
		simulatedKpis: number;
	};
	groups: Array<{ group: string; types: number; objects: number }>;
	dataCoverage: Array<{
		metric_area: string;
		object_type: string;
		total_rows: number;
		rows_from_source: number;
		rows_simulated: number;
		source_coverage_pct: string | null;
		note: string;
	}>;
	exceptions: Array<{
		exception_type: string;
		object_type: string;
		severity: string;
		item_count: number;
		description: string;
	}>;
	generationRuns: Array<Record<string, unknown>>;
}

export interface LineageNode {
	id: string;
	nodeType: "dataSource" | "transformation" | "object" | "usage";
	label: string;
	description: string | null;
	objectId: string | null;
	layer: string | null;
	payload: Record<string, unknown>;
	tags: string[];
	depth?: number;
}

export interface LineageEdge {
	id: string;
	source: string;
	target: string;
	relationType: "flowsTo" | "derivedFrom" | "usedBy";
	weight: number | null;
	payload: Record<string, unknown>;
}

export interface LineageGraph {
	nodes: LineageNode[];
	edges: LineageEdge[];
	layers: Array<{ layer: string; count: number }>;
}

export interface ChatToolCall {
	name: string;
	arguments: Record<string, unknown>;
	ok: boolean;
	durationMs: number;
	preview: string;
}

/** Mirrors the server's ResourceKind union, so grouping stays exhaustive. */
export type ResourceKind =
	| "dataset"
	| "objectType"
	| "actionType"
	| "linkType"
	| "pipeline"
	| "dashboard"
	| "connection"
	| "codeRepo"
	| "kpi";

// ── connections: what comes through one ─────────────────────────────────────

/** One relation on the far side of a connection, as its catalogue reports it. */
export interface RemoteRelation {
	schema: string;
	name: string;
	kind: string;
	estimatedRows: number | null;
	size: string | null;
}

export type ConnectorKind = "postgresql" | "rest";

export interface ConnectionCatalog {
	connection: string;
	isPlatformDatabase: boolean;
	connector: ConnectorKind;
	relations: RemoteRelation[];
	/** Why the list looks the way it does — a REST source has no catalogue. */
	note: string | null;
}

export interface SyncRun {
	id: number;
	syncId: number;
	status: "running" | "success" | "failed";
	mode: "snapshot" | "incremental";
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	rowsRead: number | null;
	rowsWritten: number | null;
	rowsBefore: number | null;
	rowsAfter: number | null;
	cursorFrom: string | null;
	cursorTo: string | null;
	/** True when the read stopped at the row limit, so this is a prefix. */
	truncated: boolean;
	errorMessage: string | null;
	triggeredBy: string;
}

export interface SyncRecord {
	id: number;
	resourceId: number;
	connectionName: string;
	name: string;
	description: string | null;
	sourceSchema: string;
	sourceTable: string;
	/** REST only: the path on the source, and where its records sit. */
	sourcePath: string | null;
	recordsPath: string | null;
	mode: "snapshot" | "incremental";
	cursorColumn: string | null;
	lastCursorValue: string | null;
	targetTable: string;
	targetRelation: string;
	rowLimit: number;
	datasetResourceId: number | null;
	enabled: boolean;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	lastRun: SyncRun | null;
}

export interface SyncOutcome {
	run: SyncRun;
	sync: SyncRecord;
	/** Columns with no local type equivalent, which landed as text. */
	widenedColumns: string[];
	datasetResourceId: number | null;
}

// ── code repositories ───────────────────────────────────────────────────────

export type RepoKind = "transforms" | "python" | "functions";

export interface BuildArtifact {
	path: string;
	kind: "sync" | "transform" | "function" | "ignored";
	status: "created" | "updated" | "unchanged" | "skipped" | "failed";
	message: string;
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

export interface RepoFile {
	id: number;
	repoId: number;
	path: string;
	content: string;
	language: string;
	updatedBy: string;
	updatedAt: string;
}

export interface RepoCommit {
	id: number;
	repoId: number;
	sequence: number;
	message: string;
	author: string;
	createdAt: string;
	fileCount: number;
}

/** Everything the repository page needs, in one request. */
export interface RepoDetail {
	repo: RepoRecord;
	files: RepoFile[];
	commits: RepoCommit[];
	builds: BuildRecord[];
	outputs: {
		datasets: Array<{ name: string; relation: string; rows: number | null }>;
		functions: Array<{ apiName: string; name: string; status: string }>;
		syncs: Array<{ name: string; connection: string; relation: string }>;
	};
}

export interface ResourceRecord {
	id: number;
	projectId: number;
	folderId: number | null;
	kind: ResourceKind;
	name: string;
	description: string | null;
	targetRef: string | null;
	/** The relation this is read from, e.g. tms_views.v_kpi_mode_mix. */
	backingView: string | null;
	properties: Record<string, unknown>;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface ChatArtifact {
	kind:
		| "chart"
		| "dashboard"
		| "table"
		| "action"
		| "lineage"
		| "clarification"
		/** A metric the assistant drafted, awaiting a person's approval. */
		| "functionProposal"
		/** A pipeline graph the assistant drafted, awaiting acceptance (§18). */
		| "pipelineProposal";
	[key: string]: unknown;
}

export interface ChatResponse {
	sessionId: number;
	reply: string;
	toolCalls: ChatToolCall[];
	artifacts: ChatArtifact[];
	rounds: number;
	latencyMs: number;
	stoppedBecause: string;
	usage: Record<string, unknown>;
	provider: string;
	model: string;
	failoverReason?: string | null;
	/** What the turn cost. `priced` is false when the provider has no rate. */
	cost?: {
		usd: number;
		priced: boolean;
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		rateInputPerM: number;
		rateOutputPerM: number;
	} | null;
}

export interface ProviderHealth {
	provider?: string;
	reachable: boolean;
	model?: string;
	modelPresent?: boolean;
	detail?: string;
	availableModels?: string[];
}

export interface AssistantHealth {
	status: string;
	/** The provider actually serving requests, which may be the fallback. */
	provider: string;
	configuredProvider?: string;
	model: string;
	/** Why this provider was chosen — GPU detection, explicit setting, or failover. */
	providerReason?: string | null;
	llm: ProviderHealth & {
		activeProvider?: string;
		breakerOpen?: boolean;
		lastFailoverReason?: string | null;
		primary?: ProviderHealth;
		fallback?: ProviderHealth;
	};
	ontologyService: { url: string; reachable: boolean; detail: string | null };
	maxToolRounds: number;
}

// ── formatting ─────────────────────────────────────────────────────────────

/**
 * Format a metric value for display.
 *
 * Driven by the KPI's declared value_format rather than by guessing from the
 * number, so 68.85245901639344 renders as 68.9% and a currency total gets a
 * thousands separator and no spurious decimals.
 */
export function formatValue(
	value: number | null | undefined,
	format: string,
	unit?: string | null,
): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";

	switch (format) {
		case "percent":
			return `${round(value, 1)}%`;
		case "currency":
			return formatCurrency(value);
		case "integer":
			return Math.round(value).toLocaleString("en-US");
		case "weight_kg":
			return `${compact(value)} kg`;
		case "distance_km":
			return `${compact(value)} km`;
		case "duration_hours":
			return `${round(value, 1)} h`;
		case "duration_days":
			return `${round(value, 1)} d`;
		default: {
			const suffix = unit ? ` ${unit}` : "";
			return `${round(value, Math.abs(value) < 10 ? 2 : 1).toLocaleString("en-US")}${suffix}`;
		}
	}
}

function formatCurrency(value: number): string {
	const absolute = Math.abs(value);
	// Unit rates need cents; totals in the millions do not. Switching on the
	// magnitude keeps "$1.2M" and "$1.55/km" both readable.
	if (absolute >= 1_000_000) return `$${round(value / 1_000_000, 2)}M`;
	if (absolute >= 10_000) return `$${Math.round(value).toLocaleString("en-US")}`;
	if (absolute >= 1) return `$${round(value, 2).toLocaleString("en-US")}`;
	return `$${round(value, 4)}`;
}

function compact(value: number): string {
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000) return `${round(value / 1_000_000, 2)}M`;
	if (absolute >= 10_000) return `${round(value / 1_000, 1)}k`;
	return round(value, absolute < 10 ? 2 : 0).toLocaleString("en-US");
}

export function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

export function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "number") {
		return Number.isInteger(value)
			? value.toLocaleString("en-US")
			: round(value, 2).toLocaleString("en-US");
	}
	const text = String(value);
	// Collapse an ISO timestamp to a readable date-time; leave everything else.
	const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(text);
	if (iso) return `${iso[1]} ${iso[2]}`;
	if (/^\d+\.\d+$/.test(text)) return round(Number(text), 2).toLocaleString("en-US");
	return text;
}

/** Truncate a long label for an axis without hiding which one it is. */
export function shortLabel(label: string, max = 28): string {
	if (label.length <= max) return label;
	return `${label.slice(0, max - 1)}…`;
}

/**
 * Status band for a KPI value against its thresholds.
 *
 * Returns a status name, never a colour: the caller pairs it with a label so
 * meaning is never carried by hue alone.
 */
export function statusFor(
	value: number | null,
	kpi: { target: number | null; warningThreshold: number | null; criticalThreshold: number | null; higherIsBetter: boolean | null },
): "good" | "warning" | "critical" | null {
	if (value === null || kpi.higherIsBetter === null) return null;
	const { target, warningThreshold, criticalThreshold, higherIsBetter } = kpi;
	if (higherIsBetter) {
		if (criticalThreshold !== null && value < criticalThreshold) return "critical";
		if (warningThreshold !== null && value < warningThreshold) return "warning";
		if (target !== null && value >= target) return "good";
		return null;
	}
	if (criticalThreshold !== null && value > criticalThreshold) return "critical";
	if (warningThreshold !== null && value > warningThreshold) return "warning";
	if (target !== null && value <= target) return "good";
	return null;
}


// ── functions ───────────────────────────────────────────────────────────────

export interface FunctionParameter {
	name: string;
	type: string;
	description?: string | null;
	required?: boolean;
}

export interface FunctionRecord {
	id: number;
	/** Permanent. Never editable — dashboards reference the function by it. */
	rid: string;
	/** Permanent, for the same reason. */
	apiName: string;
	name: string;
	description: string | null;
	businessQuestion: string | null;
	language: "sql" | "python" | "typescript";
	definition: string;
	returns: "scalar" | "table";
	returnType: string | null;
	unit: string | null;
	valueFormat: string;
	parameters: FunctionParameter[];
	readsViews: string[];
	readsObjectTypes: string[];
	status: "proposed" | "active" | "rejected" | "archived";
	proposedBy: string;
	proposedFrom: string | null;
	approvedBy: string | null;
	approvedAt: string | null;
	version: number;
	createdAt: string;
	createdBy: string;
	updatedAt: string;
	spaceSlug: string;
	isExecutable: boolean;
	notExecutableReason: string | null;
}

export interface FunctionResult {
	apiName: string;
	status: "success" | "failed";
	returns: "scalar" | "table";
	value: unknown;
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	durationMs: number;
	sql: string | null;
	error: string | null;
	runId: number | null;
}

export interface FunctionRun {
	id: number;
	version: number;
	status: string;
	startedAt: string;
	durationMs: number | null;
	rowCount: number | null;
	result: unknown;
	error: string | null;
	triggeredBy: string;
}
