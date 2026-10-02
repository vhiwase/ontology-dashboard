/**
 * The full-data window: every row of a resource, paged, searchable and
 * sortable, at nearly the size of the viewport.
 *
 * The inline preview on a resource page shows its first rows; this is where
 * someone actually reads the data. Paging, the search and the sort all run on
 * the server (resourceData.ts), so a large relation is never pulled into the
 * browser whole — the grid only ever holds one page.
 *
 * This file was missing from the repository: the project's .gitignore had a
 * bare `data/` rule meant for a local data directory, and it silently excluded
 * src/components/data/ as well, so ResourceBrowser imported a component that
 * only existed on the machine it was written on. The styles it uses (.dg-*)
 * were committed in theme.css and are what this is built against.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { ErrorBanner, Spinner, useDebounced } from "../common";

export interface DataColumn {
	name: string;
	type: string;
}

export interface DataPage {
	/** What the rows were read from, shown to the reader as-is. */
	source: string;
	sourceKind: "view" | "join" | "audit" | "catalog" | "output" | "layout";
	columns: DataColumn[];
	rows: Array<Record<string, unknown>>;
	total: number;
	offset: number;
	limit: number;
	/** Why the page looks the way it does, when that is not obvious. */
	note: string | null;
}

const PAGE_SIZES = [50, 100, 250, 500];

const NUMERIC_TYPES = /int|numeric|decimal|double|real|float|money|bigint|smallint/i;

/** A cell as text: null is shown as such, structures as JSON. */
export function cellText(value: unknown): { text: string; isNull: boolean } {
	if (value === null || value === undefined) return { text: "null", isNull: true };
	if (typeof value === "object") return { text: JSON.stringify(value), isNull: false };
	return { text: String(value), isNull: false };
}

/** Spreadsheet-style column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
	let n = index + 1;
	let label = "";
	while (n > 0) {
		const remainder = (n - 1) % 26;
		label = String.fromCharCode(65 + remainder) + label;
		n = Math.floor((n - 1) / 26);
	}
	return label;
}

interface Selection {
	row: number;
	column: string;
	columnIndex: number;
}

export function DataGrid({
	resourceId,
	title,
	onClose,
	endpoint,
}: {
	/** The resource to read. Null keeps the window closed. */
	resourceId: number | null;
	title: string;
	onClose: () => void;
	/**
	 * Read from a different endpoint with the same contract, for relations
	 * that are not workspace resources. Defaults to the resource data route.
	 */
	endpoint?: string;
}) {
	const open = resourceId !== null || Boolean(endpoint);
	const base = endpoint ?? (resourceId !== null ? `/api/resources/${resourceId}/data` : null);

	const [page, setPage] = useState<DataPage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [offset, setOffset] = useState(0);
	const [limit, setLimit] = useState(100);
	const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
	const [search, setSearch] = useState("");
	const [selection, setSelection] = useState<Selection | null>(null);
	const debouncedSearch = useDebounced(search, 300);

	// A different resource starts from the top with no sort or search carried over.
	useEffect(() => {
		setOffset(0);
		setSort(null);
		setSearch("");
		setSelection(null);
		setPage(null);
	}, [base]);

	// A new search or sort has a different first page.
	useEffect(() => {
		setOffset(0);
	}, [debouncedSearch, sort, limit]);

	const load = useCallback(() => {
		if (!base) return;
		const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
		if (sort) {
			params.set("sort", sort.column);
			params.set("dir", sort.dir);
		}
		if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
		const separator = base.includes("?") ? "&" : "?";
		setLoading(true);
		setError(null);
		api
			.get<DataPage>(`${base}${separator}${params.toString()}`)
			.then((next) => {
				setPage(next);
				setSelection(null);
			})
			.catch((exc: Error) => setError(exc.message))
			.finally(() => setLoading(false));
	}, [base, offset, limit, sort, debouncedSearch]);

	useEffect(() => {
		if (open) load();
	}, [open, load]);

	// Escape closes, the way every other window here does.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	const numericColumns = useMemo(
		() => new Set((page?.columns ?? []).filter((c) => NUMERIC_TYPES.test(c.type)).map((c) => c.name)),
		[page],
	);

	if (!open) return null;

	const toggleSort = (column: string) => {
		setSort((current) =>
			current?.column !== column
				? { column, dir: "asc" }
				: current.dir === "asc"
					? { column, dir: "desc" }
					: null,
		);
	};

	const total = page?.total ?? 0;
	const first = total === 0 ? 0 : offset + 1;
	const last = Math.min(offset + limit, total);
	const selectedValue =
		selection && page ? cellText(page.rows[selection.row]?.[selection.column]) : null;

	return (
		<div className="rb-dialog-backdrop" role="dialog" aria-modal="true" aria-label={`Data: ${title}`}>
			<div className="dg-window">
				<div className="dg-head">
					<div className="dg-heading">
						<div className="rp-kind">DATA</div>
						<h3 className="dg-title">{title}</h3>
						{page && <div className="dg-source mono">{page.source}</div>}
					</div>
					{page && (
						<div className="dg-dims">
							{total.toLocaleString()} rows × {page.columns.length} columns
						</div>
					)}
					<button className="btn sm" onClick={onClose} aria-label="Close">
						Close
					</button>
				</div>

				<div className="dg-toolbar">
					<input
						className="dg-search"
						type="search"
						value={search}
						placeholder="Search every text column…"
						onChange={(event) => setSearch(event.target.value)}
						aria-label="Search rows"
					/>
					<label className="dg-pagesize">
						<span className="muted">Rows per page</span>
						<select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
							{PAGE_SIZES.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</label>
					{loading && <span className="muted" style={{ fontSize: 11.5 }}>loading…</span>}
				</div>

				{page?.note && <p className="dg-note">{page.note}</p>}

				<div className="dg-cellbar" aria-live="polite">
					<span className="dg-cellref mono">
						{selection ? `${columnLetter(selection.columnIndex)}${offset + selection.row + 1}` : "—"}
					</span>
					<span className={`dg-cellvalue ${selectedValue?.isNull ? "muted" : ""}`}>
						{selectedValue ? selectedValue.text : "Select a cell to see its full value."}
					</span>
				</div>

				<div className="dg-scroll">
					{error ? (
						<div style={{ padding: 13 }}>
							<ErrorBanner error={error} onRetry={load} />
						</div>
					) : !page ? (
						<Spinner label="Reading rows" />
					) : page.rows.length === 0 ? (
						<p className="muted" style={{ padding: 13, fontSize: 12 }}>
							{debouncedSearch.trim() ? `No row matches “${debouncedSearch.trim()}”.` : "There are no rows."}
						</p>
					) : (
						<table className="dg-table">
							<thead>
								<tr>
									<th className="dg-rownum" aria-label="Row" />
									{page.columns.map((column) => (
										<th
											key={column.name}
											onClick={() => toggleSort(column.name)}
											aria-sort={
												sort?.column === column.name
													? sort.dir === "asc"
														? "ascending"
														: "descending"
													: "none"
											}
											title={`Sort by ${column.name}`}
										>
											<div className="dg-colname">
												{column.name}
												{sort?.column === column.name && (
													<span className="dg-sort">{sort.dir === "asc" ? "▲" : "▼"}</span>
												)}
											</div>
											<div className="dg-coltype">{column.type}</div>
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{page.rows.map((row, rowIndex) => (
									<tr key={rowIndex}>
										<td className="dg-rownum mono">{offset + rowIndex + 1}</td>
										{page.columns.map((column, columnIndex) => {
											const { text, isNull } = cellText(row[column.name]);
											const selected =
												selection?.row === rowIndex && selection.column === column.name;
											const classes = [
												isNull ? "dg-null" : "",
												numericColumns.has(column.name) && !isNull ? "num" : "",
												selected ? "dg-selected" : "",
											]
												.filter(Boolean)
												.join(" ");
											return (
												<td
													key={column.name}
													className={classes}
													title={text}
													onClick={() => setSelection({ row: rowIndex, column: column.name, columnIndex })}
												>
													{text}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				<div className="dg-foot">
					<span className="muted">
						{total === 0 ? "No rows" : `Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
					</span>
					<div className="row" style={{ gap: 6 }}>
						<button className="btn sm" disabled={offset === 0 || loading} onClick={() => setOffset(0)}>
							First
						</button>
						<button
							className="btn sm"
							disabled={offset === 0 || loading}
							onClick={() => setOffset(Math.max(0, offset - limit))}
						>
							Previous
						</button>
						<button
							className="btn sm"
							disabled={offset + limit >= total || loading}
							onClick={() => setOffset(offset + limit)}
						>
							Next
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
