/**
 * The add-node command menu.
 *
 * Searchable and keyboard-first, because adding nodes is the single most
 * repeated action in the builder and reaching for a palette every time is the
 * thing that makes these tools tiring to use.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { GROUP_LABEL, MENU_GROUPS, type NodeKind, type NodeKindSpec } from "./nodeTypes";

interface Props {
	open: boolean;
	onPick: (kind: NodeKind) => void;
	onClose: () => void;
}

export function CommandMenu({ open, onPick, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// A flat list drives keyboard navigation; the render still groups it.
	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const flat: Array<{ group: string; spec: NodeKindSpec }> = [];
		for (const { group, kinds } of MENU_GROUPS) {
			for (const spec of kinds) {
				if (
					!needle ||
					spec.label.toLowerCase().includes(needle) ||
					spec.kind.toLowerCase().includes(needle) ||
					spec.description.toLowerCase().includes(needle) ||
					GROUP_LABEL[group].toLowerCase().includes(needle)
				) {
					flat.push({ group: GROUP_LABEL[group], spec });
				}
			}
		}
		return flat;
	}, [query]);

	useEffect(() => {
		if (open) {
			setQuery("");
			setCursor(0);
			// Focus after paint, or the input is not in the document yet.
			const id = window.setTimeout(() => inputRef.current?.focus(), 0);
			return () => window.clearTimeout(id);
		}
	}, [open]);

	useEffect(() => {
		setCursor(0);
	}, []);

	if (!open) return null;

	const grouped: Array<{ group: string; items: NodeKindSpec[] }> = [];
	for (const match of matches) {
		const last = grouped[grouped.length - 1];
		if (last && last.group === match.group) last.items.push(match.spec);
		else grouped.push({ group: match.group, items: [match.spec] });
	}

	return (
		<div
			className="cmd-backdrop"
			onMouseDown={(event) => {
				// Only a click on the backdrop itself closes; a click inside must not.
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="cmd" role="dialog" aria-label="Add node">
				<input
					ref={inputRef}
					className="cmd-input"
					value={query}
					placeholder="Add a node…  (type to search)"
					onChange={(event) => {
						setQuery(event.target.value);
						setCursor(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							onClose();
						} else if (event.key === "ArrowDown") {
							event.preventDefault();
							setCursor((c) => Math.min(c + 1, matches.length - 1));
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setCursor((c) => Math.max(c - 1, 0));
						} else if (event.key === "Enter") {
							event.preventDefault();
							const picked = matches[cursor];
							if (picked) onPick(picked.spec.kind);
						}
					}}
				/>

				<div className="cmd-list">
					{matches.length === 0 && <div className="cmd-empty">No node type matches “{query}”.</div>}
					{grouped.map((section) => (
						<div key={section.group}>
							<div className="cmd-group">{section.group}</div>
							{section.items.map((spec) => {
								const index = matches.findIndex((m) => m.spec.kind === spec.kind);
								return (
									<button
										key={spec.kind}
										className={`cmd-item ${index === cursor ? "active" : ""}`}
										onMouseEnter={() => setCursor(index)}
										onClick={() => onPick(spec.kind)}
									>
										<span className="cmd-glyph" style={{ color: spec.accent }} aria-hidden>
											{spec.glyph}
										</span>
										<span className="cmd-label">{spec.label}</span>
										<span className="cmd-desc muted">{spec.description}</span>
									</button>
								);
							})}
						</div>
					))}
				</div>

				<div className="cmd-foot muted">
					<span>↑↓ to move</span>
					<span>↵ to add</span>
					<span>esc to close</span>
				</div>
			</div>
		</div>
	);
}
