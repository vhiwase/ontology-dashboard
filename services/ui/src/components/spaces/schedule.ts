/**
 * The arithmetic of a refresh schedule: an interval, a first run, and the runs
 * that follow from them. Kept apart from the dialog that edits one so it can
 * be tested without a browser.
 *
 * Everything here is in the viewer's own time zone, which is the zone they
 * are choosing a time in. The server is sent an absolute moment.
 */

export type IntervalUnit = "m" | "h" | "d" | "w";

export const UNIT_SECONDS: Record<IntervalUnit, number> = { m: 60, h: 3600, d: 86_400, w: 604_800 };

export const UNIT_WORDS: Record<IntervalUnit, [one: string, many: string]> = {
	m: ["minute", "minutes"],
	h: ["hour", "hours"],
	d: ["day", "days"],
	w: ["week", "weeks"],
};

/** The server's own limits: at least a minute, at most a year. */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 366 * 86_400;

/** 259200 -> 3 days; an interval that is no whole unit falls back to minutes. */
export function splitInterval(seconds: number | null | undefined): { count: number; unit: IntervalUnit } {
	if (!seconds || seconds <= 0) return { count: 1, unit: "d" };
	for (const unit of ["w", "d", "h", "m"] as const) {
		if (seconds % UNIT_SECONDS[unit] === 0) return { count: seconds / UNIT_SECONDS[unit], unit };
	}
	return { count: Math.max(1, Math.round(seconds / 60)), unit: "m" };
}

/** "3d" -> 259200; "manual" and anything unreadable -> null. */
export function secondsOf(every: string): number | null {
	const match = /^(\d+)([mhdw])$/.exec(every.trim());
	if (!match) return null;
	return Number(match[1]) * UNIT_SECONDS[match[2] as IntervalUnit];
}

/** "every 3 days", "every hour". */
export function intervalWords(count: number, unit: IntervalUnit): string {
	const [one, many] = UNIT_WORDS[unit];
	return count === 1 ? `every ${one}` : `every ${count} ${many}`;
}

/** Why an interval cannot be used, or null when it can. */
export function intervalProblem(count: number, unit: IntervalUnit): string | null {
	if (!Number.isInteger(count) || count < 1) return "Enter a whole number, 1 or more.";
	const seconds = count * UNIT_SECONDS[unit];
	if (seconds < MIN_INTERVAL_SECONDS) return "The shortest interval is one minute.";
	if (seconds > MAX_INTERVAL_SECONDS) return "The longest interval is a year.";
	return null;
}

/**
 * The next `count` runs of a schedule that starts at `start` and repeats every
 * `intervalSeconds`. A start already past is carried forward to the first
 * moment after `now` on the same rhythm - the same rule the server applies, so
 * what is previewed is what gets scheduled.
 */
export function upcomingRuns(start: Date, intervalSeconds: number, count: number, now: Date): Date[] {
	const step = intervalSeconds * 1000;
	let first = start.getTime();
	if (first <= now.getTime()) first += (Math.floor((now.getTime() - first) / step) + 1) * step;
	return Array.from({ length: count }, (_, index) => new Date(first + index * step));
}

/** The 42 days a month's calendar page shows: six weeks, starting on `weekStart` (0 = Sunday). */
export function monthGrid(year: number, month: number, weekStart: number): Date[] {
	const lead = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
	// Built from date parts rather than by adding 24 hours, so a day the clocks
	// change on is still one cell.
	return Array.from({ length: 42 }, (_, index) => new Date(year, month, 1 - lead + index));
}

export function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Midnight at the start of that day, local time. */
export function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A day and an "HH:MM" time as one moment, local time. Null when the time is not one. */
export function combine(day: Date, time: string): Date | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}

/** "02:00" for a moment, local time - what a time field holds. */
export function timeOf(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The day a week starts on where the viewer is: 0 for Sunday, 1 for Monday. */
export function weekStartsOn(): number {
	try {
		const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
			weekInfo?: { firstDay: number };
			getWeekInfo?: () => { firstDay: number };
		};
		const info = locale.getWeekInfo?.() ?? locale.weekInfo;
		// Intl counts Monday as 1 and Sunday as 7.
		if (info) return info.firstDay % 7;
	} catch {
		/* an old browser: Monday, as ISO has it */
	}
	return 1;
}
