/** Small shared pieces: stat tiles, tables, markdown, loading and error states. */

import { useEffect, useRef, useState } from "react";
import { type KpiResult, formatCell, formatValue, statusFor } from "../api";

export function Spinner({ label }: { label?: string }) {
	return (
		<span className="row muted" style={{ gap: 7 }}>
			<span className="spinner" aria-hidden />
			{label ?? "Loading"}
		</span>
	);
}

export function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
	return (
		<div className="banner error">
			<strong>Something went wrong.</strong> {error}
			{onRetry && (
				<>
					{" "}
					<button className="btn sm" onClick={onRetry} style={{ marginLeft: 6 }}>
						Retry
					</button>
				</>
			)}
		</div>
	);
}

export function Empty({ children }: { children: React.ReactNode }) {
	return <div className="empty">{children}</div>;
}

/**
 * A single headline number.
 *
 * The status band is shown as a coloured chip WITH a word ("below target"), never
 * as colour alone, and the simulated caveat is always visible rather than hidden
 * behind a tooltip.
 */
export function StatTile({ result, title }: { result: KpiResult; title?: string }) {
	const status = statusFor(result.total, result);
	return (
		<div className="card stat">
			<div className="label">{title ?? result.label}</div>
			<div className="value">{formatValue(result.total, result.valueFormat, result.unit)}</div>
			<div className="foot row" style={{ gap: 6 }}>
				{status && (
					<span className={`chip ${status}`}>
						<span className="dot" aria-hidden />
						{status === "good" ? "on target" : status === "warning" ? "below target" : "critical"}
					</span>
				)}
				{result.target !== null && (
					<span>
						target {formatValue(result.target, result.valueFormat, result.unit)}
					</span>
				)}
				{result.dependsOnSimulation && (
					<span className="chip" title={result.coverageNote ?? undefined}>
						simulated
					</span>
				)}
			</div>
		</div>
	);
}

export interface Column {
	key: string;
	label: string;
	numeric?: boolean;
}

export function DataTable({
	columns,
	rows,
	onRowClick,
	emptyMessage = "Nothing to show.",
	maxHeight,
}: {
	columns: Column[];
	rows: Array<Record<string, unknown>>;
	onRowClick?: (row: Record<string, unknown>) => void;
	emptyMessage?: string;
	maxHeight?: number;
}) {
	if (rows.length === 0) return <Empty>{emptyMessage}</Empty>;
	return (
		<div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
			<table className="data">
				<thead>
					<tr>
						{columns.map((column) => (
							<th key={column.key} style={column.numeric ? { textAlign: "right" } : undefined}>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, index) => (
						<tr
							key={index}
							className={onRowClick ? "clickable" : undefined}
							onClick={onRowClick ? () => onRowClick(row) : undefined}
						>
							{columns.map((column) => (
								<td key={column.key} className={column.numeric ? "n" : undefined}>
									{formatCell(row[column.key])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/**
 * Minimal markdown for assistant replies.
 *
 * Deliberately not a library: the model emits headings, bold, inline code, fenced
 * code, lists and the occasional table, and hand-rendering that set avoids
 * shipping a parser plus a sanitiser for six constructs. Text is escaped first,
 * so nothing the model writes can inject markup.
 */
export function Markdown({ text }: { text: string }) {
	return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function inline(text: string): string {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";

		// Fenced code.
		if (line.trim().startsWith("```")) {
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
				body.push(lines[index] ?? "");
				index += 1;
			}
			index += 1;
			out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
			continue;
		}

		// Table: a header row followed by a separator row of dashes.
		if (line.includes("|") && (lines[index + 1] ?? "").match(/^\s*\|?[\s:|-]+\|[\s:|-]*$/)) {
			const header = splitRow(line);
			index += 2;
			const body: string[][] = [];
			while (index < lines.length && (lines[index] ?? "").includes("|")) {
				body.push(splitRow(lines[index] ?? ""));
				index += 1;
			}
			out.push(
				`<table><thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>` +
					`<tbody>${body
						.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
						.join("")}</tbody></table>`,
			);
			continue;
		}

		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			const level = Math.min(heading[1]!.length + 1, 4);
			out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
			index += 1;
			continue;
		}

		// Lists: consume the whole run so items stay in one <ul>/<ol>.
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? "")) {
				items.push(inline((lines[index] ?? "").replace(/^\s*[-*+]\s+/, "")));
				index += 1;
			}
			out.push(`<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`);
			continue;
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items: string[] = [];
			while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] ?? "")) {
				items.push(inline((lines[index] ?? "").replace(/^\s*\d+[.)]\s+/, "")));
				index += 1;
			}
			out.push(`<ol>${items.map((item) => `<li>${item}</li>`).join("")}</ol>`);
			continue;
		}

		if (!line.trim()) {
			index += 1;
			continue;
		}

		// Paragraph: join consecutive non-blank, non-special lines.
		const paragraph: string[] = [];
		while (
			index < lines.length &&
			(lines[index] ?? "").trim() &&
			!/^(#{1,4})\s/.test(lines[index] ?? "") &&
			!/^\s*[-*+]\s+/.test(lines[index] ?? "") &&
			!/^\s*\d+[.)]\s+/.test(lines[index] ?? "") &&
			!(lines[index] ?? "").trim().startsWith("```")
		) {
			paragraph.push(lines[index] ?? "");
			index += 1;
		}
		out.push(`<p>${inline(paragraph.join(" "))}</p>`);
	}

	return out.join("");
}

function splitRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.trim());
}

/** Debounce a rapidly-changing value, for search-as-you-type. */
export function useDebounced<T>(value: T, delay = 300): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

/** Scroll an element into view whenever a dependency changes. */
export function useScrollToBottom(dependency: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [dependency]);
	return ref;
}

export function CoverageBanner({ notes }: { notes: string[] }) {
	if (notes.length === 0) return null;
	return (
		<div className="banner">
			<strong>Some figures here are simulated, not measured.</strong>{" "}
			{notes.length === 1 ? notes[0] : `${notes.length} metrics on this board carry caveats:`}
			{notes.length > 1 && (
				<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
					{notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			)}
		</div>
	);
}
