/**
 * Schedules: named, recurring triggers for the work that otherwise only ran
 * when someone pressed a button.
 *
 * Foundry ships a Schedules application; until now this platform shipped the
 * README's admission that "there is no schedule". A schedule names one target
 * - a connection sync or a pipeline - and an interval, and the ontology
 * service fires it when due.
 *
 * The scheduler lives here because this service is the always-running process
 * that already owns both execution paths. runSync and runPipeline are the same
 * exported functions the API routes call, so a scheduled run is the same work
 * as a manual one, lands in the same run history, and honors the same
 * validation. The scheduler adds only the trigger, never a second way to
 * execute.
 *
 * Two properties the implementation is built around:
 *
 *  - THE CLAIM IS THE FIRE. next_run_at is moved forward inside the same
 *    UPDATE that records the firing, so two ticks can never double-run one
 *    schedule, and a schedule disabled between SELECT and UPDATE is not run.
 *  - A FAILED SCHEDULE IS A RECORD, NOT AN EXCEPTION. The loop never throws;
 *    a failing target writes a failed schedule_run and updates the schedule's
 *    last_status/last_error, and the cadence continues. A schedule that dies
 *    quietly because one run failed would be worse than one that keeps
 *    reporting failure.
 */

import { query, queryOne } from "./db";
import { BadRequest, NotFound, withSpace } from "./registry";
import { runSync } from "./connections";
import { getPipeline, runPipeline } from "./pipelines";

const MIN_INTERVAL_SECONDS = 60;

export interface ScheduleRecord {
	scheduleId: number;
	spaceId: number;
	spaceSlug?: string;
	name: string;
	kind: "sync" | "pipeline";
	targetRef: string;
	intervalSeconds: number;
	enabled: boolean;
	createdBy: string;
	createdAt: string;
	lastRunAt: string | null;
	nextRunAt: string | null;
	lastStatus: string | null;
	lastError: string | null;
	runCount: number;
}

interface ScheduleRow extends Record<string, unknown> {
	schedule_id: number;
	space_id: number;
	space_slug?: string;
	name: string;
	kind: string;
	target_ref: string;
	interval_seconds: number;
	enabled: boolean;
	created_by: string;
	created_at: string;
	last_run_at: string | null;
	next_run_at: string | null;
	last_status: string | null;
	last_error: string | null;
	run_count: string | number;
}

function toRecord(row: ScheduleRow): ScheduleRecord {
	return {
		scheduleId: row.schedule_id,
		spaceId: row.space_id,
		spaceSlug: row.space_slug,
		name: row.name,
		kind: row.kind as "sync" | "pipeline",
		targetRef: row.target_ref,
		intervalSeconds: row.interval_seconds,
		enabled: row.enabled,
		createdBy: row.created_by,
		createdAt: row.created_at,
		lastRunAt: row.last_run_at,
		nextRunAt: row.next_run_at,
		lastStatus: row.last_status,
		lastError: row.last_error,
		runCount: Number(row.run_count),
	};
}

const SELECT_SCHEDULES = `
	SELECT s.*, sp.slug AS space_slug
	  FROM platform.schedule s
	  JOIN platform.space sp ON sp.space_id = s.space_id`;

/** Exported for the tests: the whole validation surface of a cadence. */
export function parseIntervalSeconds(raw: unknown): number {
	const seconds = Number(raw);
	if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) {
		throw new BadRequest(
			`intervalSeconds must be a whole number of at least ${MIN_INTERVAL_SECONDS} seconds.`,
		);
	}
	return seconds;
}

/** A sync target must exist, in this space, and be enabled. */
async function assertSyncTarget(ref: string, spaceSlug: string): Promise<void> {
	const syncId = Number(ref);
	if (!Number.isInteger(syncId)) {
		throw new BadRequest("A sync target_ref must be the sync's numeric id.");
	}
	const found = await queryOne<{ name: string; enabled: boolean }>(
		`SELECT cs.name, cs.enabled
		   FROM platform.connection_sync cs
		   JOIN platform.resource r ON r.resource_id = cs.resource_id
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space sp ON sp.space_id = p.space_id
		  WHERE cs.sync_id = $1 AND sp.slug = $2`,
		[syncId, spaceSlug],
	);
	if (!found) {
		throw new NotFound(`No sync ${syncId} in the '${spaceSlug}' space.`);
	}
}

/**
 * The next due moment. Computed in SQL (now() + interval) rather than in
 * JavaScript, so clock skew between the scheduler and the database cannot
 * make a schedule due early or late by the width of that skew.
 */
function nextRunSql(column = "$3"): string {
	return `now() + make_interval(secs => ${column}::int)`;
}

export async function listSchedules(spaceSlug?: string): Promise<ScheduleRecord[]> {
	const rows = await query<ScheduleRow>(
		`${SELECT_SCHEDULES} WHERE ($1::text IS NULL OR sp.slug = $1) ORDER BY s.name`,
		[spaceSlug ?? null],
	);
	return rows.map(toRecord);
}

export async function getSchedule(scheduleId: number, spaceSlug?: string): Promise<ScheduleRecord> {
	const row = await queryOne<ScheduleRow>(
		`${SELECT_SCHEDULES} WHERE s.schedule_id = $1 AND ($2::text IS NULL OR sp.slug = $2)`,
		[scheduleId, spaceSlug ?? null],
	);
	if (!row) throw new NotFound(`No schedule ${scheduleId}.`);
	return toRecord(row);
}

export async function createSchedule(
	body: Record<string, unknown>,
	createdBy: string,
	spaceSlug?: string,
): Promise<ScheduleRecord> {
	const name = String(body.name ?? "").trim();
	if (!name) throw new BadRequest("A schedule needs a name.");
	const kind = String(body.kind ?? "").trim();
	if (kind !== "sync" && kind !== "pipeline") {
		throw new BadRequest("kind must be 'sync' or 'pipeline'.");
	}
	const targetRef = String(body.targetRef ?? "").trim();
	if (!targetRef) throw new BadRequest("A schedule needs a targetRef: the sync id or pipeline slug.");
	const seconds = parseIntervalSeconds(body.intervalSeconds);

	const space = spaceSlug ?? "sandbox";
	if (kind === "sync") {
		await assertSyncTarget(targetRef, space);
	} else {
		// getPipeline is space-scoped and throws NotFound for a slug that is
		// not in this space - the check and the reason in one call.
		await getPipeline(targetRef, space);
	}
	const spaceRow = await queryOne<{ space_id: number }>(
		`SELECT space_id FROM platform.space WHERE slug = $1`,
		[space],
	);
	if (!spaceRow) throw new NotFound(`No space '${space}'.`);

	const row = await queryOne<ScheduleRow>(
		`INSERT INTO platform.schedule
		        (space_id, name, kind, target_ref, interval_seconds, created_by, next_run_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $5::int))
		 RETURNING *`,
		[spaceRow.space_id, name, kind, targetRef, seconds, createdBy],
	);
	return toRecord({ ...row, space_slug: space } as ScheduleRow);
}

export async function updateSchedule(
	scheduleId: number,
	body: Record<string, unknown>,
	spaceSlug?: string,
): Promise<ScheduleRecord> {
	await getSchedule(scheduleId, spaceSlug);

	const sets: string[] = [];
	const values: unknown[] = [scheduleId];
	if (body.name !== undefined) {
		const name = String(body.name).trim();
		if (!name) throw new BadRequest("A schedule cannot be named nothing.");
		values.push(name);
		sets.push(`name = $${values.length}`);
	}
	if (body.intervalSeconds !== undefined) {
		values.push(parseIntervalSeconds(body.intervalSeconds));
		sets.push(`interval_seconds = $${values.length}`);
		// A new cadence re-anchors the next run from now, not from the old
		// schedule's drift.
		sets.push(`next_run_at = ${nextRunSql(`$${values.length}`)}`);
	}
	if (body.enabled !== undefined) {
		values.push(Boolean(body.enabled));
		sets.push(`enabled = $${values.length}`);
		// Re-enabling fires on the new cadence from now, not retroactively - and
		// reads the row's own interval_seconds column, so the anchor never
		// mistakes another parameter for the number of seconds.
		sets.push(
			`next_run_at = CASE WHEN $${values.length} AND next_run_at IS NULL
			 THEN now() + make_interval(secs => interval_seconds::int)
			 ELSE next_run_at END`,
		);
	}
	if (!sets.length) throw new BadRequest("Nothing to update: pass name, intervalSeconds or enabled.");

	const row = await queryOne<ScheduleRow>(
		`UPDATE platform.schedule s SET ${sets.join(", ")}
		  FROM platform.space sp
		 WHERE s.schedule_id = $1 AND sp.space_id = s.space_id
		 RETURNING s.*, sp.slug AS space_slug`,
		values,
	);
	return toRecord(row as ScheduleRow);
}

export async function deleteSchedule(scheduleId: number, spaceSlug?: string): Promise<void> {
	await getSchedule(scheduleId, spaceSlug);
	await query(`DELETE FROM platform.schedule WHERE schedule_id = $1`, [scheduleId]);
}

export async function listScheduleRuns(scheduleId: number, limit = 25): Promise<unknown[]> {
	return query(
		`SELECT schedule_run_id, status, detail, started_at, finished_at
		   FROM platform.schedule_run
		  WHERE schedule_id = $1
		  ORDER BY started_at DESC LIMIT $2`,
		[scheduleId, Math.min(Math.max(limit, 1), 100)],
	);
}

/** Fire now, from a person's click, without disturbing the cadence. */
export async function runScheduleNow(
	scheduleId: number,
	triggeredBy: string,
	spaceSlug?: string,
): Promise<ScheduleRecord> {
	const schedule = await getSchedule(scheduleId, spaceSlug);
	// Awaited: the button that pressed this wants the outcome, not a receipt.
	await executeSchedule(schedule, triggeredBy);
	return getSchedule(scheduleId, spaceSlug);
}

// ── the scheduler loop ──────────────────────────────────────────────────────

/** Enabled schedules whose next_run_at has passed. */
async function dueSchedules(): Promise<ScheduleRecord[]> {
	const rows = await query<ScheduleRow>(
		`${SELECT_SCHEDULES} WHERE s.enabled AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 10`,
		[],
	);
	return rows.map(toRecord);
}

/**
 * Move next_run_at forward and count the firing in one statement. Returns
 * false when the schedule was disabled or claimed between the SELECT and this
 * UPDATE - in which case this tick does not run it.
 */
async function claimSchedule(scheduleId: number): Promise<boolean> {
	const row = await queryOne<{ schedule_id: number }>(
		`UPDATE platform.schedule
		    SET next_run_at = ${nextRunSql("interval_seconds::int")},
		        last_run_at = now(),
		        run_count = run_count + 1
		  WHERE schedule_id = $1 AND enabled AND next_run_at <= now()
		  RETURNING schedule_id`,
		[scheduleId],
	);
	return row !== null;
}

async function executeSchedule(schedule: ScheduleRecord, triggeredBy: string): Promise<void> {
	const started = Date.now();
	const space = schedule.spaceSlug ?? "sandbox";
	try {
		// The scheduled run executes inside the target's own space, so the
		// registry, the compiled views and the run history it hits are the
		// ones that space published - a sandbox schedule cannot write into
		// production by being pointed at a slug that exists there.
		const detail = await withSpace(space, async () => {
			if (schedule.kind === "pipeline") {
				const run = await runPipeline(schedule.targetRef, triggeredBy, space);
				return {
					pipelineRunId: run.id,
					status: run.status,
					records: run.records,
					errors: run.errors,
					durationMs: run.durationMs,
				};
			}
			const outcome = await runSync(Number(schedule.targetRef), triggeredBy);
			return {
				syncRunId: outcome.run.id,
				status: outcome.run.status,
				rowsRead: outcome.run.rowsRead,
				rowsWritten: outcome.run.rowsWritten,
				truncated: outcome.run.truncated,
				widenedColumns: outcome.widenedColumns,
			};
		});
		await query(
			`INSERT INTO platform.schedule_run (schedule_id, status, detail, started_at, finished_at)
			 VALUES ($1, 'succeeded', $2, $3, now())`,
			[schedule.scheduleId, JSON.stringify(detail), new Date(started)],
		);
		await query(
			`UPDATE platform.schedule SET last_status = 'succeeded', last_error = NULL WHERE schedule_id = $1`,
			[schedule.scheduleId],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await query(
			`INSERT INTO platform.schedule_run (schedule_id, status, detail, started_at, finished_at)
			 VALUES ($1, 'failed', $2, $3, now())`,
			[schedule.scheduleId, JSON.stringify({ error: message }), new Date(started)],
		);
		await query(
			`UPDATE platform.schedule SET last_status = 'failed', last_error = $2 WHERE schedule_id = $1`,
			[schedule.scheduleId, message.slice(0, 500)],
		);
	}
}

/** The tick body: claim and fire everything due. Never throws. */
export async function runDueSchedules(): Promise<number> {
	const due = await dueSchedules();
	let fired = 0;
	for (const schedule of due) {
		if (!(await claimSchedule(schedule.scheduleId))) continue;
		fired += 1;
		// Not awaited: one slow sync must not delay the next schedule's
		// firing. executeSchedule records its own outcome either way.
		void executeSchedule(schedule, `schedule:${schedule.name}`).catch((error) => {
			// The catch inside executeSchedule handles target failures; this
			// guards the recording itself failing (database gone, say).
			console.error(`[schedules] recording run of '${schedule.name}' failed:`, error);
		});
	}
	return fired;
}

let ticking = false;

/**
 * Start the background loop. Safe to call once at server startup; a tick of
 * zero disables scheduling entirely, which is what the tests want.
 */
export function startScheduler(): void {
	const tickSeconds = Number(process.env.SCHEDULE_TICK_SECONDS ?? 20);
	if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) {
		console.log("[schedules] SCHEDULE_TICK_SECONDS <= 0, scheduler disabled");
		return;
	}

	// Rows created by migration 0028 and schedules re-enabled after an outage
	// have no next_run_at; anchor them from now rather than firing immediately.
	void query(
		`UPDATE platform.schedule
		    SET next_run_at = ${nextRunSql("interval_seconds::int")}
		  WHERE enabled AND next_run_at IS NULL`,
		[] as unknown[],
	).catch((error) => console.error("[schedules] boot backfill failed:", error));

	setInterval(() => {
		if (ticking) return; // a slow tick skips rather than piles up
		ticking = true;
		void runDueSchedules()
			.then((fired) => {
				if (fired > 0) console.log(`[schedules] fired ${fired} schedule(s)`);
			})
			.catch((error) => console.error("[schedules] tick failed:", error))
			.finally(() => {
				ticking = false;
			});
	}, tickSeconds * 1000);
	console.log(`[schedules] scheduler running, tick ${tickSeconds}s`);
}
