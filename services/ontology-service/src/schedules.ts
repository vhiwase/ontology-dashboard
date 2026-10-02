/**
 * Schedules: how often a sync runs.
 *
 * A schedule names one sync and an interval - every 20 minutes, every 2
 * hours, every day, every 8 days - and the ontology service fires it when due.
 * One schedule per sync: two cadences on one landing table would each rebuild
 * it under the other.
 *
 * The scheduler lives here because this service is the always-running process
 * that owns the sync path. runSync is the same function the Run button calls,
 * so a scheduled run is the same work as a manual one and lands in the same run
 * history. The scheduler adds only the trigger, never a second way to execute.
 *
 * Two properties the implementation is built around:
 *
 *  - THE CLAIM IS THE FIRE. next_run_at is moved forward inside the same
 *    UPDATE that records the firing, so two ticks can never double-run one
 *    schedule, and a schedule disabled between SELECT and UPDATE is not run.
 *  - A FAILED SCHEDULE IS A RECORD, NOT AN EXCEPTION. The loop never throws;
 *    a failing sync writes a failed schedule_run and updates the schedule's
 *    last_status/last_error, and the cadence continues.
 */

import { query, queryOne } from "./db";
import { BadRequest, currentSpace, NotFound, withSpace } from "./registry";
import { getSync, runSync } from "./connections";

/** A sub-minute schedule is a misconfiguration, not a cadence. */
const MIN_INTERVAL_SECONDS = 60;
/** A year. Anything longer is not a schedule anyone is waiting on. */
const MAX_INTERVAL_SECONDS = 366 * 24 * 3600;

export interface ScheduleRecord {
	scheduleId: number;
	spaceId: number;
	spaceSlug?: string;
	name: string;
	kind: "sync";
	targetRef: string;
	intervalSeconds: number;
	/** The interval as a person would say it: "every 2 hours". */
	every: string;
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
		scheduleId: Number(row.schedule_id),
		spaceId: Number(row.space_id),
		spaceSlug: row.space_slug,
		name: row.name,
		kind: "sync",
		targetRef: row.target_ref,
		intervalSeconds: row.interval_seconds,
		every: describeInterval(row.interval_seconds),
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

// ── intervals ───────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
	s: 1,
	sec: 1,
	second: 1,
	m: 60,
	min: 60,
	minute: 60,
	h: 3600,
	hr: 3600,
	hour: 3600,
	d: 86_400,
	day: 86_400,
	w: 604_800,
	wk: 604_800,
	week: 604_800,
};

/**
 * An interval, in seconds, from what a person or the assistant would write:
 * 1200, "20m", "20 min", "2h", "2 hours", "1d", "8 days", "1w".
 *
 * Exported for the tests: this is the whole validation surface of a cadence.
 */
export function parseIntervalSeconds(raw: unknown): number {
	let seconds: number;
	if (typeof raw === "number") {
		seconds = raw;
	} else {
		const text = String(raw ?? "").trim().toLowerCase().replace(/^every\s+/, "");
		const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text);
		const unit = match ? UNITS[match[2]!.replace(/s$/, "") || "s"] : undefined;
		if (!match || unit === undefined) {
			throw new BadRequest(
				`'${String(raw)}' is not an interval. Write it as a number and a unit: 20m, 2h, 1d, 8d.`,
			);
		}
		seconds = Number(match[1]) * unit;
	}
	if (!Number.isFinite(seconds)) {
		throw new BadRequest("An interval must be a number of seconds.");
	}
	seconds = Math.round(seconds);
	if (seconds < MIN_INTERVAL_SECONDS) {
		throw new BadRequest(`An interval must be at least ${MIN_INTERVAL_SECONDS} seconds (1m).`);
	}
	if (seconds > MAX_INTERVAL_SECONDS) {
		throw new BadRequest("An interval must be at most a year.");
	}
	return seconds;
}

/** 7200 -> "every 2 hours"; 691200 -> "every 8 days". */
export function describeInterval(seconds: number): string {
	const units: Array<[number, string]> = [
		[604_800, "week"],
		[86_400, "day"],
		[3600, "hour"],
		[60, "minute"],
	];
	for (const [size, name] of units) {
		if (seconds % size === 0) {
			const count = seconds / size;
			return count === 1 ? `every ${name}` : `every ${count} ${name}s`;
		}
	}
	return `every ${seconds} seconds`;
}

// ── reads ───────────────────────────────────────────────────────────────────

/** A sync target must exist, in this space. */
async function assertSyncTarget(ref: string, spaceSlug: string): Promise<{ name: string }> {
	const syncId = Number(ref);
	if (!Number.isInteger(syncId)) {
		throw new BadRequest("A schedule's target must be a sync's numeric id.");
	}
	const found = await queryOne<{ name: string }>(
		`SELECT cs.name
		   FROM platform.connection_sync cs
		   JOIN platform.resource r ON r.resource_id = cs.resource_id
		   JOIN platform.project p ON p.project_id = r.project_id
		   JOIN platform.space sp ON sp.space_id = p.space_id
		  WHERE cs.sync_id = $1 AND sp.slug = $2`,
		[syncId, spaceSlug],
	);
	if (!found) throw new NotFound(`No sync ${syncId} in the '${spaceSlug}' space.`);
	return found;
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

// ── writes ──────────────────────────────────────────────────────────────────

/**
 * Create a schedule for a sync. `every` ("2h") or `intervalSeconds` (7200).
 * A sync that already has one is refused: change that one instead.
 */
export async function createSchedule(
	body: Record<string, unknown>,
	createdBy: string,
	spaceSlug = currentSpace(),
): Promise<ScheduleRecord> {
	const targetRef = String(body.targetRef ?? body.syncId ?? "").trim();
	if (!targetRef) throw new BadRequest("A schedule needs the id of the sync it runs.");
	const target = await assertSyncTarget(targetRef, spaceSlug);
	const seconds = parseIntervalSeconds(body.every ?? body.intervalSeconds);
	const name = String(body.name ?? "").trim() || `${target.name} ${describeInterval(seconds)}`;

	const existing = await queryOne<{ schedule_id: number }>(
		`SELECT s.schedule_id FROM platform.schedule s
		   JOIN platform.space sp ON sp.space_id = s.space_id
		  WHERE sp.slug = $1 AND s.target_ref = $2`,
		[spaceSlug, targetRef],
	);
	if (existing) {
		throw new BadRequest(
			`Sync ${targetRef} already runs on schedule ${existing.schedule_id}. Change its interval instead.`,
		);
	}

	const row = await queryOne<ScheduleRow>(
		`INSERT INTO platform.schedule
		        (space_id, name, kind, target_ref, interval_seconds, created_by, next_run_at)
		 SELECT sp.space_id, $2, 'sync', $3, $4, $5, now() + make_interval(secs => $4::int)
		   FROM platform.space sp WHERE sp.slug = $1
		 RETURNING *`,
		[spaceSlug, name, targetRef, seconds, createdBy],
	);
	if (!row) throw new NotFound(`No space '${spaceSlug}'.`);
	return toRecord({ ...row, space_slug: spaceSlug } as ScheduleRow);
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
	if (body.every !== undefined || body.intervalSeconds !== undefined) {
		values.push(parseIntervalSeconds(body.every ?? body.intervalSeconds));
		sets.push(`interval_seconds = $${values.length}`);
		// A new cadence re-anchors the next run from now, not from the old
		// schedule's drift.
		sets.push(`next_run_at = ${nextRunSql(`$${values.length}`)}`);
	}
	if (body.enabled !== undefined) {
		values.push(Boolean(body.enabled));
		sets.push(`enabled = $${values.length}`);
		// Re-enabling fires on the cadence from now, not retroactively.
		sets.push(
			`next_run_at = CASE WHEN $${values.length} AND next_run_at IS NULL
			 THEN now() + make_interval(secs => interval_seconds::int)
			 ELSE next_run_at END`,
		);
	}
	if (!sets.length) throw new BadRequest("Nothing to update: pass name, every or enabled.");

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

/**
 * Set how often a sync runs, in one call: `every` creates or changes its
 * schedule, and "manual" (or null) removes it. What the sync panel and the
 * assistant use, so neither has to know whether a schedule exists yet.
 */
export async function setSyncSchedule(
	syncId: number,
	every: unknown,
	actor: string,
	spaceSlug = currentSpace(),
): Promise<ScheduleRecord | null> {
	const sync = await getSync(syncId);
	await assertSyncTarget(String(syncId), spaceSlug);

	const manual = every === null || every === undefined || /^(manual|off|none|never)$/i.test(String(every).trim());
	if (manual) {
		if (sync.schedule) await deleteSchedule(sync.schedule.id, spaceSlug);
		return null;
	}
	if (sync.schedule) {
		return updateSchedule(sync.schedule.id, { every, enabled: true }, spaceSlug);
	}
	return createSchedule({ targetRef: String(syncId), every }, actor, spaceSlug);
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
		// Run inside the schedule's own space, so the registry it refreshes is
		// the one that space's object types live in.
		const detail = await withSpace(space, async () => {
			const outcome = await runSync(Number(schedule.targetRef), triggeredBy);
			return {
				syncRunId: outcome.run.id,
				status: outcome.run.status,
				rowsRead: outcome.run.rowsRead,
				rowsWritten: outcome.run.rowsWritten,
				truncated: outcome.run.truncated,
				widenedColumns: outcome.widenedColumns,
				brokenProperties: outcome.brokenProperties,
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
			// The catch inside executeSchedule handles sync failures; this guards
			// the recording itself failing (database gone, say).
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

	// Schedules re-enabled after an outage have no next_run_at; anchor them
	// from now rather than firing immediately.
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
