/**
 * A dropdown you can type into.
 *
 * For choosing one thing out of many - a record out of thousands, a field out
 * of dozens - where a plain select is a long scroll and a text box means
 * knowing an id by heart. Typing narrows the list; the list is either given
 * whole and filtered here, or asked of the server as the text changes.
 *
 * Built as an ARIA combobox: the text field keeps the keyboard, the arrow
 * keys move through the list, Enter chooses, Escape closes.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";

export interface SearchOption {
	value: string;
	label: string;
	/** A second line: the id behind a name, a field's type. */
	detail?: string;
}

export interface SearchPage {
	options: SearchOption[];
	/** How many match in all, when the server knows and it is more than shown. */
	total?: number;
}

/** Options whose label, value or detail contains every word typed. */
export function filterOptions(options: SearchOption[], term: string): SearchOption[] {
	const words = term.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return options;
	return options.filter((option) => {
		const text = `${option.label} ${option.value} ${option.detail ?? ""}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

export function SearchSelect({
	id,
	value,
	selected,
	onChange,
	options,
	search,
	placeholder = "Search…",
	emptyText = "Nothing matches.",
	disabled,
	invalid,
	ariaLabel,
}: {
	id?: string;
	/** The chosen value, or "" for none. */
	value: string;
	/** The chosen option, when it may not be in the list on screen. */
	selected?: SearchOption | null;
	onChange: (option: SearchOption | null) => void;
	/** The whole list, filtered here as the person types. */
	options?: SearchOption[];
	/** Or: ask for the options matching what was typed. */
	search?: (term: string) => Promise<SearchPage>;
	placeholder?: string;
	emptyText?: string;
	disabled?: boolean;
	invalid?: boolean;
	ariaLabel?: string;
}) {
	const listId = useId();
	const [open, setOpen] = useState(false);
	const [term, setTerm] = useState("");
	const [found, setFound] = useState<SearchPage | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);
	// The newest request made, so a slow answer to an earlier one is dropped.
	const latest = useRef(0);

	const chosen = useMemo(
		() => selected ?? options?.find((option) => option.value === value) ?? (value ? { value, label: value } : null),
		[selected, options, value],
	);

	// Asked of the server a moment after typing stops, not on every keystroke.
	useEffect(() => {
		if (!open || !search) return;
		const request = ++latest.current;
		setLoading(true);
		setError(null);
		const timer = setTimeout(
			() => {
				search(term.trim())
					.then((page) => {
						if (request !== latest.current) return;
						setFound(page);
						setActive(0);
					})
					.catch((exc: Error) => {
						if (request === latest.current) setError(exc.message);
					})
					.finally(() => {
						if (request === latest.current) setLoading(false);
					});
			},
			term ? 220 : 0,
		);
		return () => clearTimeout(timer);
	}, [open, term, search]);

	const shown = search ? (found?.options ?? []) : filterOptions(options ?? [], term);
	const total = search ? found?.total : undefined;

	// Keep the highlighted option in view as the arrow keys move it.
	useEffect(() => {
		if (!open) return;
		list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active, open]);

	const close = () => {
		setOpen(false);
		setTerm("");
	};

	const choose = (option: SearchOption) => {
		onChange(option);
		close();
	};

	return (
		<div className={`ss ${open ? "open" : ""} ${invalid ? "invalid" : ""}`}>
			<div className="ss-box">
				<span className="ss-icon" aria-hidden>
					<Icon name="search" size={14} />
				</span>
				<input
					ref={input}
					id={id}
					type="text"
					role="combobox"
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
					aria-label={ariaLabel}
					aria-invalid={invalid || undefined}
					autoComplete="off"
					spellCheck={false}
					disabled={disabled}
					// Closed, it shows the choice; open, what is being typed.
					value={open ? term : (chosen?.label ?? "")}
					placeholder={open && chosen ? chosen.label : placeholder}
					onFocus={() => setOpen(true)}
					onClick={() => setOpen(true)}
					onChange={(event) => {
						setTerm(event.target.value);
						setActive(0);
						setOpen(true);
					}}
					onBlur={close}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							if (!open) setOpen(true);
							else setActive((current) => Math.min(current + 1, Math.max(shown.length - 1, 0)));
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setActive((current) => Math.max(current - 1, 0));
						} else if (event.key === "Enter") {
							if (open && shown[active]) {
								event.preventDefault();
								choose(shown[active]);
							}
						} else if (event.key === "Escape") {
							if (open) {
								// Only this list closes, not the window it may be in.
								event.stopPropagation();
								close();
							}
						}
					}}
				/>
				{chosen && !disabled && (
					<button
						type="button"
						className="ss-clear"
						aria-label="Clear the choice"
						title="Clear"
						// Before the field loses focus, or the click never lands.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							onChange(null);
							setTerm("");
							input.current?.focus();
						}}
					>
						<Icon name="x" size={13} />
					</button>
				)}
			</div>
			{chosen?.detail && !open && <span className="ss-chosen-detail mono">{chosen.detail}</span>}

			{open && (
				// A press anywhere in the list - its scrollbar included - must not
				// take focus from the field, or the list would close under it.
				<div className="ss-pop" onMouseDown={(event) => event.preventDefault()}>
					<ul className="ss-list" role="listbox" id={listId} ref={list}>
						{shown.map((option, index) => (
							<li
								key={option.value}
								id={`${listId}-${index}`}
								data-index={index}
								role="option"
								aria-selected={option.value === value}
								className={`ss-option ${index === active ? "active" : ""} ${option.value === value ? "chosen" : ""}`}
								// Chosen on mouse-down: by mouse-up the field has blurred
								// and the list is gone.
								onMouseDown={(event) => {
									event.preventDefault();
									choose(option);
								}}
								onMouseEnter={() => setActive(index)}
							>
								<span className="ss-option-text">
									<span className="ss-label">{option.label}</span>
									{option.detail && <span className="ss-detail mono">{option.detail}</span>}
								</span>
								{option.value === value && <Icon name="check" size={14} />}
							</li>
						))}
					</ul>
					{error ? (
						<p className="ss-note error">{error}</p>
					) : loading && shown.length === 0 ? (
						<p className="ss-note">Searching…</p>
					) : shown.length === 0 ? (
						<p className="ss-note">{emptyText}</p>
					) : total !== undefined && total > shown.length ? (
						<p className="ss-note">
							Showing {shown.length} of {total.toLocaleString("en-US")}. Type to narrow it down.
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}
