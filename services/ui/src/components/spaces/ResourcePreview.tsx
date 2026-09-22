/**
 * The resource preview window.
 *
 * Opening a dataset, an object type, a link, an action, a pipeline or a
 * dashboard shows the same anatomy every time — header, tabs, body — so the
 * shape of the answer does not change with the kind of thing being asked
 * about. Only the tabs that have content for a kind are shown: a link type has
 * no rows to preview, and an empty "Preview" tab is worse than no tab.
 *
 * It is a modal rather than a page because previewing is an interruption: you
 * are somewhere, you want to know what this is, and you want to go back.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatCell } from "../../api";
import { RESOURCE_SPECS, type ResourceKind } from "./resourceKinds";

export interface ResourceSummary {
	id: number;
	kind: ResourceKind;
	name: string;
	description: string | null;
	targetRef: string | null;
	properties: Record<string, unknown>;
	createdBy: string;
	updatedAt: string;
}

interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
}

interface Preview {
	resource: ResourceSummary;
	resolved: boolean;
	detail: Record<string, unknown>;
	schema: ColumnInfo[];
	sample: Array<Record<string, unknown>>;
	rowCount: number | null;
	lineage: { upstream: LineageEntry[]; downstream: LineageEntry[] };
}

interface LineageEntry {
	kind: string;
	name: string;
	/** How it relates — "backed by", "materialised as", "acts on". */
	relation: string;
	detail?: string | null;
}

type Tab = "overview" | "schema" | "preview" | "lineage";

function humanise(key: string): string {
	return key
		.replace(/([A-Z])/g, " $1")
		.replace(/^./, (c) => c.toUpperCase())
		.trim();
}

function renderValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (Array.isArray(value)) {
		if (value.length === 0) return "—";
		return value
			.map((item) =>
				typeof item === "object" && item !== null
					? String((item as Record<string, unknown>).apiName ?? JSON.stringify(item))
					: String(item),
			)
			.join(", ");
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		// Small, known shapes get a sentence; anything else falls back to JSON.
		if ("current" in record && "max" in record) {
			return `${record.current} of ${record.max}`;
		}
		return JSON.stringify(value);
	}
	if (typeof value === "number") return value.toLocaleString("en-US");
	return String(value);
}

export function ResourcePreview({
	resourceId,
	onClose,
	onOpenTarget,
}: {
	resourceId: number | null;
	onClose: () => void;
	/** Navigate to the thing this resource points at, where there is a page for it. */
	onOpenTarget?: (kind: ResourceKind, targetRef: string) => void;
}) {
	const [preview, setPreview] = useState<Preview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("overview");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		latencyMs: number;
		detail: string;
		serverVersion?: string | null;
	} | null>(null);

	useEffect(() => {
		if (resourceId === null) return;
		setPreview(null);
		setError(null);
		setTab("overview");
		setTestResult(null);
		api
			.get<Preview>(`/api/resources/${resourceId}/preview`)
			.then(setPreview)
			.catch((exc: Error) => setError(exc.message));
	}, [resourceId]);

	const close = useCallback(() => onClose(), [onClose]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	// Only tabs with something in them. A link type has no rows and no columns,
	// so it gets Overview and Lineage and nothing else.
	const tabs = useMemo<Tab[]>(() => {
		if (!preview) return ["overview"];
		const list: Tab[] = ["overview"];
		if (preview.schema.length > 0) list.push("schema");
		if (preview.sample.length > 0) list.push("preview");
		if (preview.lineage.upstream.length + preview.lineage.downstream.length > 0) {
			list.push("lineage");
		}
		return list;
	}, [preview]);

	if (resourceId === null) return null;

	const spec = preview ? RESOURCE_SPECS[preview.resource.kind] : null;

	const schemaRows = (preview?.detail.schemas ?? []) as Array<{
		schema: string;
		tables: number;
		views: number;
		rows: number;
		unanalysed: number;
	}>;

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="rp" role="dialog" aria-label="Resource preview">
				<header className="rp-head">
					<span className="rp-glyph" style={{ color: spec?.accent }} aria-hidden>
						{spec?.glyph ?? "▫"}
					</span>
					<div className="rp-heading">
						<div className="rp-kind">{spec?.label.toUpperCase() ?? "RESOURCE"}</div>
						<h2 className="rp-title">{preview?.resource.name ?? "Loading…"}</h2>
					</div>
					{preview && !preview.resolved && (
						<span
							className="chip rp-stale"
							title="This resource points at something the ontology no longer publishes. Re-run the pipeline, or delete it."
						>
							unresolved
						</span>
					)}
					{preview?.rowCount !== null && preview?.rowCount !== undefined && (
						<span className="rp-rows mono">{preview.rowCount.toLocaleString("en-US")} rows</span>
					)}
					<button className="btn sm" onClick={close} aria-label="Close preview">
						✕
					</button>
				</header>

				{preview && preview.resource.description && (
					<p className="rp-description">{preview.resource.description}</p>
				)}

				<nav className="rp-tabs">
					{tabs.map((id) => (
						<button
							key={id}
							className={`rp-tab ${tab === id ? "active" : ""}`}
							onClick={() => setTab(id)}
						>
							{id === "overview"
								? "Overview"
								: id === "schema"
									? `Schema${preview ? ` (${preview.schema.length})` : ""}`
									: id === "preview"
										? "Preview"
										: "Lineage"}
						</button>
					))}
				</nav>

				<div className="rp-body">
					{error && <div className="banner error">{error}</div>}
					{!preview && !error && <p className="muted">Loading…</p>}

					{preview && !preview.resolved && (
						<div className="banner warn" style={{ marginBottom: 12 }}>
							<strong>{preview.resource.targetRef}</strong> is no longer in the published
							ontology, so there is nothing to show. The pipeline regenerates the ontology
							on each run, and a resource can outlive what it pointed at.
						</div>
					)}

					{preview && tab === "overview" && (
						<>
							{/* A connection's schema breakdown is a table, not a field:
							    rendered through renderValue it came out as a wall of raw
							    JSON, which is exactly the thing this window exists to
							    avoid. */}
							{schemaRows.length > 0 && (
								<>
									<table className="dense" style={{ marginBottom: 12 }}>
										<thead>
											<tr>
												<th>Schema</th>
												<th>Tables</th>
												<th>Views</th>
												<th>Rows (est.)</th>
											</tr>
										</thead>
										<tbody>
											{schemaRows.map((row) => (
												<tr key={row.schema}>
													<td className="mono">{row.schema}</td>
													<td className="mono">{row.tables}</td>
													<td className="mono">{row.views}</td>
													<td className="mono">
														{row.rows.toLocaleString("en-US")}
														{row.unanalysed > 0 && (
															<span
																className="muted"
																title={`${row.unanalysed} table(s) have never been analysed, so they contribute nothing to this estimate.`}
															>
																{" "}
																+{row.unanalysed}?
															</span>
														)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
									<p className="muted rp-note">
										Row counts are planner estimates, not exact counts.
									</p>
								</>
							)}

							<dl className="rp-kv">
								{Object.entries(preview.detail)
									.filter(([key]) => key !== "schemas")
									.map(([key, value]) => (
									<div className="rp-kv-row" key={key}>
										<dt>{humanise(key)}</dt>
										<dd className={typeof value === "number" ? "mono" : undefined}>
											{renderValue(value)}
										</dd>
									</div>
								))}
								<div className="rp-kv-row">
									<dt>Created by</dt>
									<dd>{preview.resource.createdBy}</dd>
								</div>
								<div className="rp-kv-row">
									<dt>Updated</dt>
									<dd className="mono">{preview.resource.updatedAt.slice(0, 19).replace("T", " ")}</dd>
								</div>
							</dl>

							{/* A connection that has not been tested is a guess: the
							    failure modes — wrong host, wrong credential, no route —
							    are indistinguishable until something tries. */}
							{preview.resource.kind === "connection" && (
								<div style={{ marginBottom: 10 }}>
									<button
										className="btn sm"
										disabled={testing}
										onClick={async () => {
											setTesting(true);
											setTestResult(null);
											try {
												setTestResult(await api.post(`/api/resources/${resourceId}/test`));
											} catch {
												setTestResult({
													ok: false,
													latencyMs: 0,
													detail: "The test could not be run.",
												});
											} finally {
												setTesting(false);
											}
										}}
									>
										{testing ? "Testing…" : "Test connection"}
									</button>
									{testResult && (
										<div
											className={`banner ${testResult.ok ? "" : "error"}`}
											style={{ marginTop: 8 }}
										>
											{testResult.ok
												? `Connected in ${testResult.latencyMs}ms${
														testResult.serverVersion ? ` — ${testResult.serverVersion}` : ""
													}`
												: `Failed: ${testResult.detail}`}
										</div>
									)}
								</div>
							)}

							{onOpenTarget && preview.resource.targetRef && (
								<button
									className="btn sm primary"
									onClick={() =>
										onOpenTarget(preview.resource.kind, preview.resource.targetRef as string)
									}
								>
									Open in workbench
								</button>
							)}
						</>
					)}

					{preview && tab === "schema" && (
						<table className="dense">
							<thead>
								<tr>
									<th>Column</th>
									<th>Type</th>
									<th>Nullable</th>
								</tr>
							</thead>
							<tbody>
								{preview.schema.map((column) => (
									<tr key={column.name}>
										<td className="mono">{column.name}</td>
										<td className="muted">{column.type}</td>
										<td>{column.nullable ? "yes" : "no"}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}

					{preview && tab === "preview" && (
						<>
							<p className="muted rp-note">
								{preview.sample.length} of{" "}
								{preview.rowCount?.toLocaleString("en-US") ?? "?"} rows, read live.
							</p>
							<div className="rp-scroll">
								<table className="dense">
									<thead>
										<tr>
											{Object.keys(preview.sample[0] ?? {})
												.slice(0, 12)
												.map((column) => (
													<th key={column}>{column}</th>
												))}
										</tr>
									</thead>
									<tbody>
										{preview.sample.map((row, index) => (
											// Sample rows have no stable key of their own; the index is
											// the identity here and the list never reorders.
											// biome-ignore lint/suspicious/noArrayIndexKey: see above
											<tr key={index}>
												{Object.keys(preview.sample[0] ?? {})
													.slice(0, 12)
													.map((column) => (
														<td key={column} className="mono">
															{formatCell(row[column])}
														</td>
													))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					)}

					{preview && tab === "lineage" && (
						<div className="lin">
							{/* Read top to bottom: what feeds this, this, then what depends
							    on it. Each entry names the RELATION, because "upstream" on
							    its own does not say whether something is read from, built
							    from or merely referenced. */}
							<div className="lin-side">
								<h4>Upstream</h4>
								{preview.lineage.upstream.length === 0 ? (
									<p className="muted">Nothing feeds this.</p>
								) : (
									preview.lineage.upstream.map((entry) => (
										<div className="lin-node" key={`${entry.kind}-${entry.name}`}>
											<span className="lin-rel">{entry.relation}</span>
											<span className="lin-name mono">{entry.name}</span>
											{entry.detail && <span className="lin-detail muted">{entry.detail}</span>}
										</div>
									))
								)}
							</div>

							<div className="lin-arrow" aria-hidden>
								↓
							</div>

							<div className="lin-self">
								<span className="rp-glyph" style={{ color: spec?.accent }} aria-hidden>
									{spec?.glyph}
								</span>
								<span className="lin-name">{preview.resource.name}</span>
								{preview.rowCount !== null && (
									<span className="lin-detail muted">
										{preview.rowCount.toLocaleString("en-US")} rows
									</span>
								)}
							</div>

							<div className="lin-arrow" aria-hidden>
								↓
							</div>

							<div className="lin-side">
								<h4>Downstream ({preview.lineage.downstream.length})</h4>
								{preview.lineage.downstream.length === 0 ? (
									<p className="muted">Nothing depends on this.</p>
								) : (
									preview.lineage.downstream.map((entry) => (
										<div className="lin-node" key={`${entry.kind}-${entry.name}`}>
											<span className="lin-rel">{entry.relation}</span>
											<span className="lin-name mono">{entry.name}</span>
											{entry.detail && <span className="lin-detail muted">{entry.detail}</span>}
										</div>
									))
								)}
							</div>
						</div>
					)}

				</div>
			</div>
		</div>
	);
}
