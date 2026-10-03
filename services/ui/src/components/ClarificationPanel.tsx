/**
 * Answering the assistant's question.
 *
 * When the assistant needs the person to choose - which tables to sync, which
 * datasets to model, whether to go ahead - it asks through a clarification
 * with concrete options. This is where they are answered: one choice or
 * several, a note if they want to add one, then Submit. The answer goes back
 * as the person's next message, so it is part of the transcript like anything
 * typed.
 *
 * It opens above the message box rather than over the page. The reply the
 * question is about stays readable behind it, and nothing else on the page is
 * blocked: the person can still scroll back, open History, or type a
 * different answer instead.
 *
 * Native radio and checkbox inputs underneath, so the choices work from the
 * keyboard and read correctly to a screen reader; the cards are their labels.
 */

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons";

export interface ClarificationOption {
	label: string;
	detail?: string;
}

export interface Clarification {
	question: string;
	options: ClarificationOption[];
	multiple: boolean;
	allowFreeText: boolean;
}

/**
 * A name that may wrap after its separators. Choices are often identifiers -
 * business_entity_relationship - and left alone a narrow card breaks one in
 * the middle of a word.
 */
export function Breakable({ text }: { text: string }) {
	return (
		<>
			{text.split(/([_./-])/).map((part, index) => (
				// Odd parts are the separators the split kept.
				<Fragment key={index}>
					{part}
					{index % 2 === 1 && <wbr />}
				</Fragment>
			))}
		</>
	);
}

/** Read a clarification artifact defensively: it arrives as loose JSON. */
export function asClarification(artifact: Record<string, unknown> | undefined): Clarification | null {
	if (!artifact || artifact.kind !== "clarification") return null;
	const seen = new Set<string>();
	const options: ClarificationOption[] = [];
	for (const raw of Array.isArray(artifact.options) ? artifact.options : []) {
		const entry = (typeof raw === "string" ? { label: raw } : (raw ?? {})) as { label?: unknown; detail?: unknown };
		const label = typeof entry.label === "string" ? entry.label.trim() : "";
		// Two options with one label would be one choice drawn twice.
		if (!label || seen.has(label)) continue;
		seen.add(label);
		const detail = typeof entry.detail === "string" ? entry.detail.trim() : "";
		options.push(detail ? { label, detail } : { label });
	}
	return {
		question: typeof artifact.question === "string" ? artifact.question : "",
		options,
		multiple: artifact.multiple === true && options.length > 1,
		allowFreeText: artifact.allowFreeText !== false,
	};
}

/**
 * The reply's own text, to show above its question.
 *
 * A question asked through the tool ends the text it came with, and the card
 * under it asks it - so the question is taken off the end rather than shown
 * twice. A question the server read off a reply written in prose leaves that
 * reply exactly as it was written.
 */
export function replyProse(content: string, clarification: Clarification | null, inferred: boolean): string {
	if (!clarification || inferred || !clarification.question.trim()) return content;
	const text = content.trim();
	const question = clarification.question.trim();
	if (text === question) return "";
	return text.endsWith(question) ? text.slice(0, -question.length).trim() : text;
}

/** The message an answer is sent as: the choices, then any note under them. */
export function composeAnswer(chosen: string[], note: string): string {
	const picked = chosen.join(", ");
	const typed = note.trim();
	if (picked && typed) return `${picked}\n\n${typed}`;
	return picked || typed;
}

/** The choices an answer was sent with, read back from the message. */
export function chosenIn(answer: string, options: ClarificationOption[]): string[] {
	const picked = answer.split("\n\n")[0] ?? "";
	// A label may itself contain a comma, so match whole labels rather than
	// splitting the message apart.
	return options
		.map((option) => option.label)
		.filter((label) => picked === label || `, ${picked}, `.includes(`, ${label}, `));
}

/** Add or remove one choice, keeping the options' own order. */
export function toggleChoice(clarification: Clarification, chosen: string[], label: string): string[] {
	if (!clarification.multiple) return chosen.includes(label) ? [] : [label];
	const next = chosen.includes(label) ? chosen.filter((entry) => entry !== label) : [...chosen, label];
	return clarification.options.map((option) => option.label).filter((entry) => next.includes(entry));
}

export function ClarificationPanel({
	clarification,
	chosen,
	onChange,
	onSubmit,
	onDismiss,
	autoFocus = false,
}: {
	clarification: Clarification;
	/** The selected labels. Held by the page, so the transcript can show them too. */
	chosen: string[];
	onChange: (chosen: string[]) => void;
	onSubmit: (answer: string) => void;
	/** "Answer later": hides the panel; the question stays in the transcript. */
	onDismiss: () => void;
	/** Move the keyboard to the first choice when the panel appears. */
	autoFocus?: boolean;
}) {
	const { question, options, multiple, allowFreeText } = clarification;
	const [note, setNote] = useState("");
	const name = useId();
	const firstOption = useRef<HTMLInputElement>(null);
	const answer = composeAnswer(chosen, note);
	const all = options.map((option) => option.label);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the panel appears
	useEffect(() => {
		if (autoFocus) firstOption.current?.focus({ preventScroll: true });
	}, []);

	const submit = () => {
		if (answer) onSubmit(answer);
	};

	return (
		<section
			className="clar-sheet"
			aria-labelledby={`${name}-question`}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onDismiss();
				}
			}}
		>
			<header className="clar-sheet-head">
				<span className="clar-mark" aria-hidden>
					<Icon name="message" size={16} />
				</span>
				<div className="clar-sheet-heading">
					<p className="clar-kicker">The assistant needs your answer</p>
					<h2 id={`${name}-question`}>{question || "Choose how to continue"}</h2>
				</div>
				<button className="icon-btn" onClick={onDismiss} aria-label="Answer later" title="Answer later">
					<Icon name="x" size={16} />
				</button>
			</header>

			<form
				className="clar-sheet-form"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
				onKeyDown={(event) => {
					// Enter on a choice submits, as it does from the note: browsers
					// only do that by themselves for text fields.
					const target = event.target as HTMLElement;
					if (event.key === "Enter" && target instanceof HTMLInputElement && target.type !== "text") {
						event.preventDefault();
						submit();
					}
				}}
			>
				<fieldset className="clar-options">
					{/* The row is a span inside the legend: a legend itself does not
					    lay out as a flex container in every browser. */}
					<legend className="clar-legend">
						<span className="clar-legend-row">
							<span>{multiple ? "Choose one or more" : "Choose one"}</span>
							{multiple && (
								<span className="clar-legend-tools">
									<span className="muted" aria-live="polite">
										{chosen.length} of {options.length} selected
									</span>
									<button
										type="button"
										className="link-button"
										onClick={() => onChange(chosen.length === all.length ? [] : all)}
									>
										{chosen.length === all.length ? "Clear" : "Select all"}
									</button>
								</span>
							)}
						</span>
					</legend>
					<div className="clar-grid">
						{options.map((option, index) => {
							const on = chosen.includes(option.label);
							return (
								<label key={option.label} className={`clar-option ${on ? "on" : ""}`}>
									<input
										ref={index === 0 ? firstOption : undefined}
										type={multiple ? "checkbox" : "radio"}
										name={name}
										checked={on}
										onChange={() => onChange(multiple ? toggleChoice(clarification, chosen, option.label) : [option.label])}
									/>
									<span className={`clar-check ${multiple ? "box" : "round"}`} aria-hidden>
										{on && <Icon name="check" size={12} strokeWidth={3} />}
									</span>
									<span className="clar-text">
										<span className="clar-label">
										<Breakable text={option.label} />
									</span>
										{option.detail && <span className="clar-detail">{option.detail}</span>}
									</span>
								</label>
							);
						})}
					</div>
				</fieldset>

				<div className="clar-sheet-foot">
					{allowFreeText ? (
						<input
							type="text"
							className="clar-note"
							value={note}
							placeholder="Add a note (optional)"
							aria-label="Add a note to your answer (optional)"
							onChange={(event) => setNote(event.target.value)}
						/>
					) : (
						<span className="clar-note-gap" />
					)}
					<button type="button" className="btn ghost" onClick={onDismiss}>
						Answer later
					</button>
					<button type="submit" className="btn primary" disabled={!answer}>
						Submit answer
						<Icon name="arrowRight" size={15} />
					</button>
				</div>
			</form>
		</section>
	);
}
