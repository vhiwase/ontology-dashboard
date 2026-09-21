import { query, queryOne } from "./db";
import { executeKpi, resolveKpi, type KpiExecuteResult } from "./kpi";
import { BadRequest, getRegistry, NotFound } from "./registry";

/**
 * Dashboards.
 *
 * A dashboard is a list of widgets, and a widget names a KPI from the catalogue
 * plus how to slice it. It never carries SQL. That is what makes an
 * assistant-generated dashboard reviewable: the worst a bad generation can do is
 * pick the wrong metric, not run the wrong query.
 *
 * Validation on save is strict for the same reason. A widget naming a KPI that
 * does not exist, or a dimension the KPI does not support, is rejected at save
 * time with a message that says what IS allowed - so the assistant gets a usable
 * correction instead of a dashboard that renders as four error tiles.
 */

export type WidgetType = "stat" | "chart" | "table" | "note";
export type ChartKind = "bar" | "hbar" | "line" | "area" | "donut";

export interface Widget {
	type: WidgetType;
	kpi?: string;
	title?: string;
	dimension?: string | null;
	chart?: ChartKind;
	limit?: number;
	sort?: "value_desc" | "value_asc" | "dimension_asc" | "dimension_desc";
	filters?: Record<string, unknown>;
	width?: number;
	body?: string;
}

export interface DashboardRecord {
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

interface DashboardRow {
	dashboard_id: number;
	slug: string;
	title: string;
	description: string | null;
	layout: Widget[];
	filters: Record<string, unknown>;
	audience: string | null;
	is_ai_generated: boolean;
	source_prompt: string | null;
	created_by: string;
	created_at: Date;
	updated_at: Date;
	is_pinned: boolean;
}

function toRecord(row: DashboardRow): DashboardRecord {
	return {
		id: row.dashboard_id,
		slug: row.slug,
		title: row.title,
		description: row.description,
		layout: row.layout ?? [],
		filters: row.filters ?? {},
		audience: row.audience,
		isAiGenerated: row.is_ai_generated,
		sourcePrompt: row.source_prompt,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		isPinned: row.is_pinned,
	};
}

export async function listDashboards(): Promise<DashboardRecord[]> {
	const rows = await query<DashboardRow>(
		`SELECT * FROM platform.dashboard
		  ORDER BY is_pinned DESC, updated_at DESC`,
	);
	return rows.map(toRecord);
}

export async function getDashboard(slug: string): Promise<DashboardRecord> {
	const row = await queryOne<DashboardRow>(
		"SELECT * FROM platform.dashboard WHERE slug = $1",
		[slug],
	);
	if (!row) throw new NotFound(`No dashboard '${slug}'.`);
	return toRecord(row);
}

export interface ResolvedWidget extends Widget {
	index: number;
	data: KpiExecuteResult | null;
	error: string | null;
}

export interface ResolvedDashboard extends DashboardRecord {
	widgets: ResolvedWidget[];
	/** Union of the coverage caveats of every KPI on the board. */
	coverageNotes: string[];
	dependsOnSimulation: boolean;
}

/**
 * Run every widget's KPI.
 *
 * Widgets are resolved in parallel and a failure is captured per widget rather
 * than thrown: one broken tile should not blank a dashboard that is otherwise
 * fine, and the error belongs on the tile where someone can see which metric
 * broke.
 */
export async function resolveDashboard(slug: string): Promise<ResolvedDashboard> {
	const dashboard = await getDashboard(slug);

	const widgets = await Promise.all(
		dashboard.layout.map(async (widget, index): Promise<ResolvedWidget> => {
			if (widget.type === "note" || !widget.kpi) {
				return { ...widget, index, data: null, error: null };
			}
			try {
				const data = await executeKpi(widget.kpi, {
					dimension: widget.type === "stat" ? null : widget.dimension,
					filters: { ...dashboard.filters, ...(widget.filters ?? {}) },
					limit: widget.limit,
					sort: widget.sort,
					totalOnly: widget.type === "stat",
				});
				return { ...widget, index, data, error: null };
			} catch (error) {
				return { ...widget, index, data: null, error: (error as Error).message };
			}
		}),
	);

	const coverageNotes = [
		...new Set(
			widgets
				.map((w) => w.data?.coverageNote)
				.filter((note): note is string => Boolean(note)),
		),
	];

	return {
		...dashboard,
		widgets,
		coverageNotes,
		dependsOnSimulation: widgets.some((w) => w.data?.dependsOnSimulation),
	};
}

export interface SaveDashboardRequest {
	slug?: string;
	title: string;
	description?: string | null;
	layout: Widget[];
	filters?: Record<string, unknown>;
	audience?: string | null;
	isAiGenerated?: boolean;
	sourcePrompt?: string | null;
	createdBy?: string;
	isPinned?: boolean;
}

export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || `dashboard-${Date.now()}`;
}

const VALID_CHARTS: ChartKind[] = ["bar", "hbar", "line", "area", "donut"];

/**
 * Validate a layout before it is stored.
 *
 * Returns every problem at once rather than the first, because the caller is
 * often an LLM and a single round trip listing all the corrections is worth far
 * more than five sequential ones.
 */
export function validateLayout(layout: unknown): { valid: boolean; errors: string[]; widgets: Widget[] } {
	const errors: string[] = [];
	if (!Array.isArray(layout)) {
		return { valid: false, errors: ["layout must be an array of widgets."], widgets: [] };
	}
	if (layout.length === 0) {
		return { valid: false, errors: ["layout is empty; a dashboard needs at least one widget."], widgets: [] };
	}
	if (layout.length > 24) {
		errors.push(`layout has ${layout.length} widgets; 24 is the maximum.`);
	}

	const registry = getRegistry();
	const widgets: Widget[] = [];

	layout.forEach((raw, index) => {
		const where = `layout[${index}]`;
		if (typeof raw !== "object" || raw === null) {
			errors.push(`${where} is not an object.`);
			return;
		}
		const widget = raw as Widget;
		const type = widget.type;
		if (!["stat", "chart", "table", "note"].includes(type as string)) {
			errors.push(`${where}.type must be stat, chart, table or note (got ${JSON.stringify(type)}).`);
			return;
		}

		if (type === "note") {
			if (!widget.body || !String(widget.body).trim()) {
				errors.push(`${where} is a note but has no body text.`);
			}
			widgets.push({
				type: "note",
				title: widget.title,
				body: widget.body,
				width: clampWidth(widget.width),
			});
			return;
		}

		if (!widget.kpi) {
			errors.push(`${where}.kpi is required for a ${type} widget.`);
			return;
		}
		const kpi = registry.kpiByApiName.get(widget.kpi);
		if (!kpi) {
			errors.push(
				`${where}.kpi '${widget.kpi}' is not in the catalogue. Available: ` +
					registry.kpis.map((k) => k.apiName).join(", "),
			);
			return;
		}

		let dimension = widget.dimension ?? undefined;
		if (type === "stat") {
			// A stat is a single number; carrying a dimension would be ignored, so it
			// is dropped rather than silently misleading whoever reads the layout.
			dimension = undefined;
		} else {
			if (dimension === undefined || dimension === null) {
				dimension = kpi.defaultDimension ?? undefined;
			}
			if (!dimension) {
				errors.push(
					`${where} is a ${type} of '${kpi.apiName}', which has no default dimension; ` +
						`set one of: ${kpi.dimensions.join(", ")}`,
				);
			} else if (!kpi.dimensions.includes(dimension)) {
				errors.push(
					`${where}.dimension '${dimension}' is not supported by '${kpi.apiName}'. ` +
						`Allowed: ${kpi.dimensions.join(", ")}`,
				);
			}
		}

		let chart = widget.chart;
		if (type === "chart") {
			if (!chart) chart = "bar";
			if (!VALID_CHARTS.includes(chart)) {
				errors.push(`${where}.chart '${chart}' is not one of ${VALID_CHARTS.join(", ")}.`);
			}
		} else {
			chart = undefined;
		}

		if (widget.filters !== undefined) {
			if (typeof widget.filters !== "object" || widget.filters === null || Array.isArray(widget.filters)) {
				errors.push(`${where}.filters must be an object of column -> value.`);
			} else {
				for (const column of Object.keys(widget.filters)) {
					// A filter column has to be a declared dimension; anything else would
					// be a free-form column reference, which is what the KPI layer exists
					// to prevent.
					if (!kpi.dimensions.includes(column)) {
						errors.push(
							`${where}.filters references '${column}', which is not a dimension of ` +
								`'${kpi.apiName}'. Allowed: ${kpi.dimensions.join(", ")}`,
						);
					}
				}
			}
		}

		widgets.push({
			type,
			kpi: kpi.apiName,
			title: widget.title,
			...(dimension ? { dimension } : {}),
			...(chart ? { chart } : {}),
			...(widget.limit ? { limit: Math.min(Math.max(1, Number(widget.limit)), 100) } : {}),
			...(widget.sort ? { sort: widget.sort } : {}),
			...(widget.filters ? { filters: widget.filters } : {}),
			width: clampWidth(widget.width),
		});
	});

	return { valid: errors.length === 0, errors, widgets };
}

function clampWidth(width: unknown): number {
	const value = Number(width ?? 2);
	if (!Number.isFinite(value)) return 2;
	return Math.min(4, Math.max(1, Math.round(value)));
}

export async function saveDashboard(request: SaveDashboardRequest): Promise<DashboardRecord> {
	if (!request.title || !String(request.title).trim()) {
		throw new BadRequest("A dashboard needs a title.");
	}
	const validation = validateLayout(request.layout);
	if (!validation.valid) {
		throw new BadRequest(
			`This layout cannot be saved:\n- ${validation.errors.join("\n- ")}`,
		);
	}

	const slug = request.slug?.trim() || slugify(request.title);

	const row = await queryOne<DashboardRow>(
		`INSERT INTO platform.dashboard
		   (slug, title, description, layout, filters, audience, is_ai_generated,
		    source_prompt, created_by, is_pinned, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
		 ON CONFLICT (slug) DO UPDATE SET
		   title = EXCLUDED.title,
		   description = EXCLUDED.description,
		   layout = EXCLUDED.layout,
		   filters = EXCLUDED.filters,
		   audience = EXCLUDED.audience,
		   is_ai_generated = EXCLUDED.is_ai_generated,
		   source_prompt = EXCLUDED.source_prompt,
		   is_pinned = EXCLUDED.is_pinned,
		   updated_at = now()
		 RETURNING *`,
		[
			slug,
			request.title.trim(),
			request.description ?? null,
			JSON.stringify(validation.widgets),
			JSON.stringify(request.filters ?? {}),
			request.audience ?? null,
			request.isAiGenerated ?? false,
			request.sourcePrompt ?? null,
			request.createdBy ?? "user",
			request.isPinned ?? false,
		],
	);
	if (!row) throw new Error("Dashboard save returned no row.");
	return toRecord(row);
}

export async function deleteDashboard(slug: string): Promise<void> {
	const result = await query<{ slug: string }>(
		"DELETE FROM platform.dashboard WHERE slug = $1 RETURNING slug",
		[slug],
	);
	if (result.length === 0) throw new NotFound(`No dashboard '${slug}'.`);
}

/**
 * The KPI catalogue in the compact form the assistant is given.
 *
 * Trimmed on purpose: the full catalogue rows carry thresholds and provenance
 * prose that would cost a lot of context for no gain when the model is only
 * choosing which metric to chart.
 */
export function kpiCatalogueForPrompt(): Array<Record<string, unknown>> {
	return getRegistry().kpis.map((kpi) => ({
		apiName: kpi.apiName,
		label: kpi.label,
		question: kpi.businessQuestion,
		category: kpi.category,
		unit: kpi.unit,
		format: kpi.valueFormat,
		dimensions: kpi.dimensions,
		defaultDimension: kpi.defaultDimension,
		simulated: kpi.dependsOnSimulation,
	}));
}

export { resolveKpi };
