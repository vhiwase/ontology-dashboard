/**
 * A question that needs an answer before something is done.
 *
 * In the application's own window rather than the browser's confirm(). That
 * one names its buttons OK and Cancel whatever is being asked, so a question
 * with two real answers had to explain which button meant which - and had no
 * way to say "neither". Here each choice is a button that says what it does,
 * the one that cannot be undone looks like it, and Cancel is always there.
 *
 * The keyboard starts on Cancel: Enter on a dialog that just appeared should
 * never be the destructive answer.
 */

import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";

export interface ConfirmChoice {
	label: string;
	onSelect: () => void;
	/** `danger` for what cannot be undone; `primary` for the usual answer. */
	tone?: "primary" | "danger" | "plain";
}

export function ConfirmDialog({
	title,
	icon = "alertTriangle",
	children,
	choices,
	cancelLabel = "Cancel",
	busy = false,
	onCancel,
}: {
	title: string;
	icon?: IconName;
	/** What will happen, in a sentence or two. */
	children: ReactNode;
	choices: ConfirmChoice[];
	cancelLabel?: string;
	/** While the chosen action runs: the buttons wait rather than fire twice. */
	busy?: boolean;
	onCancel: () => void;
}) {
	const id = useId();
	const cancel = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		cancel.current?.focus();
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel, busy]);

	return createPortal(
		<div
			className="modal-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
		>
			<div
				className="modal confirm-modal"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				aria-describedby={`${id}-body`}
			>
				<header className="modal-head">
					<span className={`confirm-mark ${choices.some((choice) => choice.tone === "danger") ? "danger" : ""}`} aria-hidden>
						<Icon name={icon} size={17} />
					</span>
					<div>
						<h2 id={`${id}-title`}>{title}</h2>
					</div>
				</header>
				<div className="modal-body">
					<div className="confirm-body" id={`${id}-body`}>
						{children}
					</div>
					<footer className="modal-foot">
						<button ref={cancel} type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
							{cancelLabel}
						</button>
						{choices.map((choice) => (
							<button
								key={choice.label}
								type="button"
								className={`btn ${choice.tone === "danger" ? "danger" : choice.tone === "plain" ? "" : "primary"}`}
								disabled={busy}
								onClick={choice.onSelect}
							>
								{choice.label}
							</button>
						))}
					</footer>
				</div>
			</div>
		</div>,
		document.body,
	);
}
