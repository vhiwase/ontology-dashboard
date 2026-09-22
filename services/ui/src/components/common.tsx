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
/**
 * Renders an assistant reply.
 *
 * `onResource` makes the :resource[kind:ref] directives clickable. The chips
 * are emitted as buttons carrying data attributes and the click is handled by
 * delegation on the container, because the body is set through
 * dangerouslySetInnerHTML and React holds no handles on the nodes inside it.
 */
export function Markdown({
	text,
	onResource,
	onCitation,
}: {
	text: string;
	onResource?: (kind: string, ref: string) => void;
	onCitation?: (path: string, section: string) => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const html = renderMarkdown(text);

	// Mermaid is loaded on demand and only when a reply actually contains a
	// diagram. It is a large dependency and most answers are prose, so making
	// every chat page pay for it up front would be the wrong trade.
	useEffect(() => {
		const blocks = host.current?.querySelectorAll<HTMLElement>(".mermaid-block[data-mermaid]");
		if (!blocks || blocks.length === 0) return;

		let cancelled = false;
		void (async () => {
			try {
				const mermaid = (await import("mermaid")).default;
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: "dark",
					fontFamily: "inherit",
				});
				for (const [index, node] of blocks.entries()) {
					if (cancelled) return;
					const source = node.dataset.mermaid ?? "";
					try {
						const { svg } = await mermaid.render(
							`mmd-${Date.now().toString(36)}-${index}`,
							source,
						);
						if (!cancelled) node.innerHTML = svg;
					} catch (error) {
						// A model can emit invalid mermaid. Showing the source beats
						// showing nothing, and beats an exception taking the reply down.
						node.innerHTML = "";
						const pre = document.createElement("pre");
						pre.className = "mermaid-failed";
						pre.textContent = `Diagram could not be drawn.

${source}`;
						node.appendChild(pre);
						void error;
					}
				}
			} catch {
				/* mermaid unavailable; the placeholders stay empty */
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [html]);

	return (
		<div
			ref={host}
			className="md"
			onClick={(event) => {
				const element = event.target as HTMLElement;
				const resource = element.closest<HTMLElement>("[data-resource-ref]");
				if (resource && onResource) {
					event.preventDefault();
					onResource(resource.dataset.resourceKind ?? "", resource.dataset.resourceRef ?? "");
					return;
				}
				const citation = element.closest<HTMLElement>("[data-citation-path]");
				if (citation && onCitation) {
					event.preventDefault();
					onCitation(
						citation.dataset.citationPath ?? "",
						citation.dataset.citationSection ?? "",
					);
				}
			}}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes first
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/**
 * Glyphs for the resource kinds an answer can reference. Kept in step with
 * RESOURCE_SPECS so a chip in a reply and the same thing in the explorer read
 * alike.
 */
const RESOURCE_GLYPHS: Record<string, string> = {
	objectType: "◈",
	linkType: "↔",
	actionType: "⚡",
	kpi: "Σ",
	dataset: "▤",
	dashboard: "▦",
	pipeline: "⑄",
	connection: "⛁",
};

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Resource directives: :resource[kind:ref]
 *
 * Applied BEFORE escaping would mangle the brackets, and emits already-escaped
 * content, so the chip survives without opening a hole. An answer that names
 * an object type now links to it instead of just spelling it.
 */
function resourceDirectives(text: string): string {
	return text.replace(
		/:resource\[([a-zA-Z]+):([^\]]+)\]/g,
		(_whole, kind: string, ref: string) => {
			const glyph = RESOURCE_GLYPHS[kind] ?? "▫";
			const safeKind = escapeHtml(kind);
			const safeRef = escapeHtml(ref.trim());
			return (
				`<button type="button" class="res-chip" data-resource-kind="${safeKind}" ` +
				`data-resource-ref="${safeRef}" title="Open ${safeRef}">` +
				`<span aria-hidden="true">${glyph}</span>${safeRef}</button>`
			);
		},
	);
}

/**
 * Citation directives: :citation[Title]{path="..." section="..."}
 *
 * Rendered as a superscript marker rather than a chip, because a citation
 * annotates a claim while a resource chip IS the subject of one. Making them
 * look alike would blur that.
 */
function citationDirectives(text: string): string {
	return text.replace(
		/:citation\[([^\]]+)\]\{([^}]*)\}/g,
		(_whole, title: string, attrs: string) => {
			const path = /path="([^"]*)"/.exec(attrs)?.[1] ?? "";
			const section = /section="([^"]*)"/.exec(attrs)?.[1] ?? "";
			if (!path) return escapeHtml(title);
			const label = section ? `${title} · ${section}` : title;
			return (
				`<button type="button" class="cite" data-citation-path="${escapeHtml(path)}" ` +
				`data-citation-section="${escapeHtml(section)}" title="${escapeHtml(label)}">` +
				`<span aria-hidden="true">§</span>${escapeHtml(title)}</button>`
			);
		},
	);
}

function inline(text: string): string {
	// Directives are extracted to placeholders first so escapeHtml does not
	// destroy the markup they produce.
	const chips: string[] = [];
	const withPlaceholders = citationDirectives(resourceDirectives(text)).replace(
		/<button type="button" class="(?:res-chip|cite)"[\s\S]*?<\/button>/g,
		(chip) => {
			chips.push(chip);
			return `[[CHIP${chips.length - 1}]]`;
		},
	);

	const rendered = escapeHtml(withPlaceholders)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

	return rendered.replace(/\[\[CHIP(\d+)\]\]/g, (_m, i) => chips[Number(i)] ?? "");
}

export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";

		// Fenced code.
		if (line.trim().startsWith("```")) {
			const fence = line.trim().slice(3).trim();
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
				body.push(lines[index] ?? "");
				index += 1;
			}
			index += 1;
			// A mermaid fence is a diagram, not a code sample. It becomes a
			// placeholder that the Markdown component draws into after mount,
			// because mermaid needs a real DOM node to render against.
			if (fence.toLowerCase() === "mermaid") {
				out.push(
					`<div class="mermaid-block" data-mermaid="${escapeHtml(body.join("\n"))}"></div>`,
				);
			} else {
				out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
			}
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
			{/* Worded as a caveat, not as "simulated". Nothing on this platform is
			    generated any more, so a coverage note now means the source is thin
			    for that figure - saying "simulated" would be a false statement the
			    moment a real metric carried a note. */}
			<strong>Read these caveats before quoting a figure.</strong>{" "}
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

/**
 * What an ontology page shows in a space nothing has been published to.
 *
 * The ontology is produced by a pipeline, and pipelines belong to a space, so
 * the object types, links, actions, metrics and lineage in a space are the
 * ones its own pipeline published. A space nobody has published to has none —
 * and saying so is the honest answer. Borrowing the sandbox's, which is what
 * this page used to do, presented unreviewed work as though it were live in
 * an environment it had never been promoted to.
 */
export function NoOntologyHere({
	what,
	spaceName,
}: {
	what: string;
	spaceName: string;
}) {
	return (
		<div className="empty-space">
			<div className="empty-space-mark" aria-hidden>
				◈
			</div>
			<h3>
				No {what} in {spaceName}
			</h3>
			<p>
				No ontology has been published to this space yet. One arrives when a pipeline runs
				here, or when a version is promoted from another space.
			</p>
			<p className="empty-space-hint">
				The sandbox holds the ontology built so far — switch to it in the space selector
				above.
			</p>
		</div>
	);
}
