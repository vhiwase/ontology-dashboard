/**
 * A custom refresh schedule: how often, and when the first run is.
 *
 * The presets cover the usual cadences. This is for the rest - "every 3 days,
 * starting Tuesday at 02:00" - and it replaced a browser prompt that asked for
 * "45m, 3h, 3d" as text and could not say when anything would actually run.
 * The day is picked on a calendar, the time in a time field, and the runs that
 * follow are listed before anything is saved.
 *
 * The first run sets the rhythm: every run after it is a whole number of
 * intervals later, so a schedule set for 02:00 stays at 02:00.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import {
	type IntervalUnit,
	UNIT_SECONDS,
	UNIT_WORDS,
	combine,
	intervalProblem,
	intervalWords,
	monthGrid,
	sameDay,
	splitInterval,
	startOfDay,
	timeOf,
	upcomingRuns,
	weekStartsOn,
} from "./schedule";

const QUICK: Array<{ count: number; unit: IntervalUnit }> = [
	{ count: 30, unit: "m" },
	{ count: 4, unit: "h" },
	{ count: 1, unit: "d" },
	{ count: 3, unit: "d" },
	{ count: 1, unit: "w" },
];

function fullDate(date: Date): string {
	return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function runLabel(date: Date): string {
	return date.toLocaleString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * One month, as a grid of days.
 *
 * A real grid for the keyboard: one day takes the Tab stop and the arrow keys
 * move between days, Page Up and Page Down between months, as in any calendar.
 */
function MonthCalendar({
	value,
	onChange,
	min,
	max,
	disabled,
}: {
	value: Date;
	onChange: (day: Date) => void;
	/** The first and last days that can be picked. */
	min: Date;
	max: Date;
	disabled?: boolean;
}) {
	const [view, setView] = useState(() => ({ year: value.getFullYear(), month: value.getMonth() }));
	// The day the keyboard is on; it follows the selection until moved.
	const [cursor, setCursor] = useState(value);
	const grid = useRef<HTMLTableElement>(null);
	const moved = useRef(false);
	const today = startOfDay(new Date());
	const weekStart = useMemo(weekStartsOn, []);
	const days = monthGrid(view.year, view.month, weekStart);
	const title = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	const weekdays = days.slice(0, 7).map((day) => ({
		short: day.toLocaleDateString(undefined, { weekday: "short" }),
		long: day.toLocaleDateString(undefined, { weekday: "long" }),
	}));

	const allowed = (day: Date) => day.getTime() >= min.getTime() && day.getTime() <= max.getTime();
	const firstOfView = new Date(view.year, view.month, 1);
	const canGoBack = firstOfView.getTime() > new Date(min.getFullYear(), min.getMonth(), 1).getTime();
	const canGoOn = firstOfView.getTime() < new Date(max.getFullYear(), max.getMonth(), 1).getTime();

	const shift = (months: number) => {
		const next = new Date(view.year, view.month + months, 1);
		setView({ year: next.getFullYear(), month: next.getMonth() });
	};

	// After the keyboard moves the cursor, the newly current day takes focus.
	useEffect(() => {
		if (!moved.current) return;
		moved.current = false;
		grid.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(cursor)}"]`)?.focus();
	}, [cursor]);

	const move = (to: Date) => {
		const clamped = to.getTime() < min.getTime() ? min : to.getTime() > max.getTime() ? max : to;
		moved.current = true;
		setCursor(clamped);
		setView({ year: clamped.getFullYear(), month: clamped.getMonth() });
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		const at = (deltaDays: number) => new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + deltaDays);
		const months = (delta: number) => new Date(cursor.getFullYear(), cursor.getMonth() + delta, cursor.getDate());
		const offset = (cursor.getDay() - weekStart + 7) % 7;
		const target =
			event.key === "ArrowLeft"
				? at(-1)
				: event.key === "ArrowRight"
					? at(1)
					: event.key === "ArrowUp"
						? at(-7)
						: event.key === "ArrowDown"
							? at(7)
							: event.key === "Home"
								? at(-offset)
								: event.key === "End"
									? at(6 - offset)
									: event.key === "PageUp"
										? months(-1)
										: event.key === "PageDown"
											? months(1)
											: null;
		if (!target) return;
		event.preventDefault();
		move(target);
	};

	// The Tab stop: the cursor's day when it is on this page, else the first
	// day of the page that can be picked.
	const tabStop = days.some((day) => sameDay(day, cursor) && allowed(day))
		? cursor
		: (days.find((day) => day.getMonth() === view.month && allowed(day)) ?? cursor);

	return (
		<div className={`cal ${disabled ? "is-off" : ""}`}>
			<div className="cal-head">
				<button
					type="button"
					className="icon-btn"
					onClick={() => shift(-1)}
					disabled={disabled || !canGoBack}
					aria-label="Previous month"
				>
					<Icon name="chevronLeft" size={16} />
				</button>
				<span className="cal-title" aria-live="polite">
					{title}
				</span>
				<button
					type="button"
					className="icon-btn"
					onClick={() => shift(1)}
					disabled={disabled || !canGoOn}
					aria-label="Next month"
				>
					<Icon name="chevronRight" size={16} />
				</button>
			</div>
			<table className="cal-grid" role="grid" aria-label={title} ref={grid} onKeyDown={onKeyDown}>
				<thead>
					<tr>
						{weekdays.map((weekday) => (
							<th key={weekday.long} scope="col" abbr={weekday.long}>
								{weekday.short.slice(0, 2)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{[0, 1, 2, 3, 4, 5].map((week) => (
						<tr key={week}>
							{days.slice(week * 7, week * 7 + 7).map((day) => {
								const selected = sameDay(day, value);
								const outside = day.getMonth() !== view.month;
								return (
									<td key={dayKey(day)} role="gridcell" aria-selected={selected}>
										<button
											type="button"
											data-day={dayKey(day)}
											className={`cal-day ${selected ? "selected" : ""} ${outside ? "outside" : ""} ${
												sameDay(day, today) ? "today" : ""
											}`}
											tabIndex={sameDay(day, tabStop) ? 0 : -1}
											disabled={disabled || !allowed(day)}
											aria-pressed={selected}
											aria-label={`${fullDate(day)}${sameDay(day, today) ? ", today" : ""}`}
											onClick={() => {
												setCursor(day);
												setView({ year: day.getFullYear(), month: day.getMonth() });
												onChange(day);
											}}
										>
											{day.getDate()}
										</button>
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function ScheduleDialog({
	subject,
	intervalSeconds,
	nextRunAt,
	onClose,
	onSave,
}: {
	/** What is being scheduled, as the heading names it. */
	subject?: string;
	/** The cadence it has now, to start from. */
	intervalSeconds: number | null;
	/** When it next runs, to start the calendar from. */
	nextRunAt?: string | null;
	onClose: () => void;
	/** `every` as the server reads it ("3d"); `startAt` an ISO moment, or null for "an interval from now". */
	onSave: (every: string, startAt: string | null) => void;
}) {
	// One "now" for the whole dialog, so the preview does not shift under the
	// cursor while a time is being chosen.
	const now = useMemo(() => new Date(), []);
	const initial = useMemo(() => {
		const next = nextRunAt ? new Date(nextRunAt) : null;
		if (next && next.getTime() > now.getTime()) return next;
		// The top of the next hour: a round time, and safely in the future.
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
	}, [nextRunAt, now]);
	const start = splitInterval(intervalSeconds);
	const [count, setCount] = useState(String(start.count));
	const [unit, setUnit] = useState<IntervalUnit>(start.unit);
	const [first, setFirst] = useState<"at" | "interval">("at");
	const [day, setDay] = useState(() => startOfDay(initial));
	const [time, setTime] = useState(() => timeOf(initial));
	const name = useId();

	const min = startOfDay(now);
	// The server takes a first run up to a year ahead.
	const max = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate() - 1);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const amount = Number(count);
	const problem = count.trim() === "" ? "Enter how often it should run." : intervalProblem(amount, unit);
	const seconds = problem ? null : amount * UNIT_SECONDS[unit];
	const chosen = combine(day, time);
	const timeProblem = first === "at" && !chosen ? "Choose a time." : null;
	const passed = first === "at" && chosen !== null && chosen.getTime() <= now.getTime();
	const runs =
		seconds === null || timeProblem
			? []
			: upcomingRuns(first === "at" && chosen ? chosen : new Date(now.getTime() + seconds * 1000), seconds, 4, now);
	// The zone by name and by its offset from UTC: the name alone is not
	// always the one a person would call it by.
	const offset = -now.getTimezoneOffset();
	const zone = `${Intl.DateTimeFormat().resolvedOptions().timeZone} (UTC${offset < 0 ? "-" : "+"}${Math.floor(Math.abs(offset) / 60)}:${String(Math.abs(offset) % 60).padStart(2, "0")})`;

	const save = () => {
		if (seconds === null || timeProblem) return;
		onSave(`${amount}${unit}`, first === "at" && chosen ? chosen.toISOString() : null);
	};

	return createPortal(
		<div
			className="modal-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="modal sched-modal" role="dialog" aria-modal="true" aria-labelledby={`${name}-title`}>
				<header className="modal-head">
					<span className="stage-icon" aria-hidden>
						<Icon name="calendar" size={15} />
					</span>
					<div>
						<h2 id={`${name}-title`}>Custom refresh schedule</h2>
						<p className="muted modal-sub">
							{subject ? `${subject}: how often it is copied again, and when the first run is.` : "How often it runs, and when the first run is."}
						</p>
					</div>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
						<Icon name="x" size={17} />
					</button>
				</header>

				<form
					className="modal-body"
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<div className="sched-layout">
						<div className="sched-side">
							<fieldset className="sched-block">
								<legend>Repeat every</legend>
								<div className="sched-every">
									<input
										type="number"
										min={1}
										step={1}
										inputMode="numeric"
										value={count}
										autoFocus
										aria-label="How many"
										aria-invalid={problem !== null}
										onChange={(event) => setCount(event.target.value)}
									/>
									<select value={unit} aria-label="Unit" onChange={(event) => setUnit(event.target.value as IntervalUnit)}>
										{(Object.keys(UNIT_WORDS) as IntervalUnit[]).map((option) => (
											<option key={option} value={option}>
												{UNIT_WORDS[option][amount === 1 ? 0 : 1]}
											</option>
										))}
									</select>
								</div>
								<div className="sched-quick">
									{QUICK.map((option) => {
										const on = amount === option.count && unit === option.unit;
										return (
											<button
												key={`${option.count}${option.unit}`}
												type="button"
												className={`clar-chip ${on ? "on" : ""}`}
												aria-pressed={on}
												onClick={() => {
													setCount(String(option.count));
													setUnit(option.unit);
												}}
											>
												{option.count} {UNIT_WORDS[option.unit][option.count === 1 ? 0 : 1]}
											</button>
										);
									})}
								</div>
								{problem && <p className="field-hint warn">{problem}</p>}
							</fieldset>

							<fieldset className="sched-block choice-list">
								<legend>First run</legend>
								<label className={`choice ${first === "at" ? "on" : ""}`}>
									<input type="radio" name={name} checked={first === "at"} onChange={() => setFirst("at")} />
									<span className="choice-text">
										<span className="choice-label">On a date and time</span>
										<span className="choice-detail">Pick the day on the calendar and set the time under it.</span>
									</span>
								</label>
								<label className={`choice ${first === "interval" ? "on" : ""}`}>
									<input type="radio" name={name} checked={first === "interval"} onChange={() => setFirst("interval")} />
									<span className="choice-text">
										<span className="choice-label">One interval from now</span>
										<span className="choice-detail">
											{seconds === null ? "Counted from the moment you save." : `The first run is ${intervalWords(amount, unit).replace("every ", "")} after you save.`}
										</span>
									</span>
								</label>
							</fieldset>
						</div>

						<div className="sched-when">
							<MonthCalendar value={day} onChange={setDay} min={min} max={max} disabled={first !== "at"} />
							<label className="field sched-time">
								<span>Time</span>
								<input
									type="time"
									value={time}
									disabled={first !== "at"}
									aria-invalid={timeProblem !== null}
									onChange={(event) => setTime(event.target.value)}
								/>
								<span className="field-hint">In your time zone, {zone}.</span>
							</label>
						</div>
					</div>

					<div className="sched-summary" aria-live="polite">
						{runs.length === 0 ? (
							<p className="muted">{problem ?? timeProblem}</p>
						) : (
							<>
								<p>
									<strong>Runs {intervalWords(amount, unit)}.</strong>{" "}
									{passed
										? "That time has already passed today, so the first run is the next one on the same rhythm."
										: first === "at"
											? "Every run after the first keeps to the same time."
											: "Counted from the moment you save."}
								</p>
								<ol className="sched-runs">
									{runs.map((run, index) => (
										<li key={run.getTime()}>
											<span className="sched-run-n">{index === 0 ? "First" : "Then"}</span>
											<span className="num">{runLabel(run)}</span>
										</li>
									))}
								</ol>
							</>
						)}
					</div>

					<footer className="modal-foot">
						<button type="button" className="btn ghost" onClick={onClose}>
							Cancel
						</button>
						<button type="submit" className="btn primary" disabled={seconds === null || timeProblem !== null}>
							<Icon name="check" size={15} />
							Save schedule
						</button>
					</footer>
				</form>
			</div>
		</div>,
		document.body,
	);
}
