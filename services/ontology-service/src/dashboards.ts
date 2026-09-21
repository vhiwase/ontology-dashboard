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
	/** The conversation that produced it, for an AI-built dashboard. */
	chatSessionId: number | null;
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
	chat_session_id: number | null;
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
		chatSessionId: row.chat_session_id ?? null,
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
	chatSessionId?: number | null;
}

export function slugify(title: string): string {
	const slug = title
		// Decompose accented characters into base letter + combining mark, then
		// drop the marks, so "Kraków" becomes "krakow" rather than "krak-w".
		// Without this, every non-ASCII letter became a separator and a title in
		// French, Polish or German slugged into something unreadable - which
		// matters now that the slug is the URL of a user-named dashboard.
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		// A few letters have no decomposition and need naming outright.
		.replace(/ß/gi, "ss")
		.replace(/[øØ]/g, "o")
		.replace(/[æÆ]/g, "ae")
		.replace(/[đĐ]/g, "d")
		.replace(/[łŁ]/g, "l")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		// The slice can leave a trailing separator behind.
		.replace(/-+$/g, "");
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
		    source_prompt, created_by, is_pinned, chat_session_id, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
		 ON CONFLICT (slug) DO UPDATE SET
		   title = EXCLUDED.title,
		   description = EXCLUDED.description,
		   layout = EXCLUDED.layout,
		   filters = EXCLUDED.filters,
		   audience = EXCLUDED.audience,
		   is_ai_generated = EXCLUDED.is_ai_generated,
		   source_prompt = EXCLUDED.source_prompt,
		   is_pinned = EXCLUDED.is_pinned,
		   -- COALESCE, so re-saving a dashboard from the UI does not wipe the
		   -- conversation it originally came from.
		   chat_session_id = COALESCE(EXCLUDED.chat_session_id, platform.dashboard.chat_session_id),
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
			request.chatSessionId ?? null,
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
// ── history, rename and backup ─────────────────────────────────────────────

export interface DashboardHistoryEntry extends DashboardRecord {
	/** The conversation that produced it, when there was one and it still exists. */
	session: {
		id: number;
		title: string | null;
		userId: string;
		messageCount: number;
		createdAt: string;
		/** False once the retention purge has removed the conversation. */
		available: boolean;
	} | null;
	renames: Array<{
		previousTitle: string;
		newTitle: string;
		renamedBy: string;
		renamedAt: string;
	}>;
}

/**
 * Every dashboard with its provenance: the conversation that built it and the
 * renames it has been through.
 *
 * A dashboard outlives the chat that produced it - retention purges
 * conversations and the foreign key is ON DELETE SET NULL - so `session` is
 * null for a dashboard whose conversation has aged out, and the view reports
 * that rather than implying it never had one.
 */
export async function dashboardHistory(): Promise<DashboardHistoryEntry[]> {
	const rows = await query<
		DashboardRow & {
			session_title: string | null;
			session_user: string | null;
			session_messages: number | null;
			session_created: Date | null;
		}
	>(
		`SELECT d.*,
		        s.title          AS session_title,
		        s.user_id        AS session_user,
		        s.message_count  AS session_messages,
		        s.created_at     AS session_created
		   FROM platform.dashboard d
		   LEFT JOIN platform.chat_session s
		          ON s.chat_session_id = d.chat_session_id
		  ORDER BY d.updated_at DESC`,
	);

	const renames = await query<{
		dashboard_id: number;
		previous_title: string;
		new_title: string;
		renamed_by: string;
		renamed_at: Date;
	}>(
		`SELECT dashboard_id, previous_title, new_title, renamed_by, renamed_at
		   FROM platform.dashboard_rename ORDER BY renamed_at DESC`,
	);

	const renamesById = new Map<number, DashboardHistoryEntry["renames"]>();
	for (const row of renames) {
		const list = renamesById.get(row.dashboard_id) ?? [];
		list.push({
			previousTitle: row.previous_title,
			newTitle: row.new_title,
			renamedBy: row.renamed_by,
			renamedAt: row.renamed_at.toISOString(),
		});
		renamesById.set(row.dashboard_id, list);
	}

	return rows.map((row) => ({
		...toRecord(row),
		session:
			row.chat_session_id === null
				? null
				: {
						id: row.chat_session_id,
						title: row.session_title,
						userId: row.session_user ?? "unknown",
						messageCount: row.session_messages ?? 0,
						createdAt: row.session_created?.toISOString() ?? "",
						// The join missed, so the conversation has been purged.
						available: row.session_user !== null,
					},
		renames: renamesById.get(row.dashboard_id) ?? [],
	}));
}

/**
 * Give a dashboard a new name.
 *
 * The slug is regenerated from the new title, because a dashboard called
 * "Q3 Margin" living at /dashboards/untitled-4 is a worse outcome than a
 * changed URL. The old name and slug are recorded, so a stale link can still
 * be explained.
 */
export async function renameDashboard(
	slug: string,
	newTitle: string,
	renamedBy: string,
): Promise<DashboardRecord> {
	const title = String(newTitle ?? "").trim();
	if (!title) throw new BadRequest("A dashboard needs a title.");
	if (title.length > 120) throw new BadRequest("Title must be 120 characters or fewer.");

	const existing = await queryOne<DashboardRow>(
		"SELECT * FROM platform.dashboard WHERE slug = $1",
		[slug],
	);
	if (!existing) throw new NotFound(`No dashboard '${slug}'.`);

	const newSlug = slugify(title);
	if (newSlug !== existing.slug) {
		const clash = await queryOne<{ slug: string }>(
			"SELECT slug FROM platform.dashboard WHERE slug = $1",
			[newSlug],
		);
		if (clash) {
			throw new BadRequest(
				`Another dashboard already uses the name '${title}'. Pick a different one.`,
			);
		}
	}

	const updated = await queryOne<DashboardRow>(
		`UPDATE platform.dashboard
		    SET title = $1, slug = $2, updated_at = now()
		  WHERE dashboard_id = $3
		RETURNING *`,
		[title, newSlug, existing.dashboard_id],
	);
	if (!updated) throw new NotFound(`No dashboard '${slug}'.`);

	// Only recorded when something actually changed, so re-saving the same
	// title does not fill the history with no-ops.
	if (existing.title !== title || existing.slug !== newSlug) {
		await query(
			`INSERT INTO platform.dashboard_rename
			   (dashboard_id, previous_title, new_title, previous_slug, new_slug, renamed_by)
			 VALUES ($1,$2,$3,$4,$5,$6)`,
			[existing.dashboard_id, existing.title, title, existing.slug, newSlug, renamedBy],
		);
	}

	return toRecord(updated);
}

/** The shape written by an export and accepted by an import. */
export interface DashboardBackup {
	kind: "tms-ontology-dashboards";
	version: 1;
	exportedAt: string;
	exportedBy: string;
	dashboards: DashboardRecord[];
}

export async function exportDashboards(
	exportedBy: string,
	slugs?: string[],
): Promise<DashboardBackup> {
	const all = await listDashboards();
	const selected =
		slugs && slugs.length > 0 ? all.filter((d) => slugs.includes(d.slug)) : all;
	return {
		kind: "tms-ontology-dashboards",
		version: 1,
		exportedAt: new Date().toISOString(),
		exportedBy,
		dashboards: selected,
	};
}

export interface ImportOutcome {
	imported: string[];
	skipped: Array<{ slug: string; reason: string }>;
}

/**
 * Restore dashboards from an export.
 *
 * Each one is validated against the CURRENT ontology before being written: a
 * backup taken before the KPI catalogue changed can name metrics that no
 * longer exist, and importing those would put a permanently broken widget on
 * someone's screen. Such a dashboard is skipped with its reason, and the rest
 * still land.
 *
 * `overwrite` decides what happens to a slug that is already present.
 */
export async function importDashboards(
	backup: unknown,
	importedBy: string,
	overwrite: boolean,
): Promise<ImportOutcome> {
	const parsed = backup as Partial<DashboardBackup>;
	if (!parsed || parsed.kind !== "tms-ontology-dashboards") {
		throw new BadRequest(
			"That is not a dashboard export. Expected a file whose kind is 'tms-ontology-dashboards'.",
		);
	}
	if (!Array.isArray(parsed.dashboards)) {
		throw new BadRequest("The export contains no dashboards array.");
	}

	const existing = new Set((await listDashboards()).map((d) => d.slug));
	const outcome: ImportOutcome = { imported: [], skipped: [] };

	for (const candidate of parsed.dashboards) {
		const slug = String(candidate?.slug ?? "").trim();
		const title = String(candidate?.title ?? "").trim();
		if (!slug || !title) {
			outcome.skipped.push({ slug: slug || "(unnamed)", reason: "Missing slug or title." });
			continue;
		}
		if (existing.has(slug) && !overwrite) {
			outcome.skipped.push({
				slug,
				reason: "Already exists. Re-import with overwrite to replace.",
			});
			continue;
		}

		const validation = validateLayout(candidate.layout ?? []);
		if (!validation.valid) {
			outcome.skipped.push({
				slug,
				reason: `Does not fit the current ontology: ${validation.errors[0]}`,
			});
			continue;
		}

		await saveDashboard({
			slug,
			title,
			description: candidate.description ?? null,
			layout: validation.widgets,
			filters: candidate.filters ?? {},
			audience: candidate.audience ?? null,
			isAiGenerated: candidate.isAiGenerated ?? false,
			sourcePrompt: candidate.sourcePrompt ?? null,
			createdBy: candidate.createdBy ?? importedBy,
			isPinned: candidate.isPinned ?? false,
			chatSessionId: null,
		});
		outcome.imported.push(slug);
	}

	return outcome;
}

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
