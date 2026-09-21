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

/** Notified when the server rejects our token, so the app can show the login. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
	onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const token = session.token();
	const response = await fetch(path, {
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
	post: <T>(path: string, body?: unknown) =>
		request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
	del: <T>(path: string) => request<T>(path, { method: "DELETE" }),

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

export interface ChatArtifact {
	kind: "chart" | "dashboard" | "table" | "action" | "lineage";
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
