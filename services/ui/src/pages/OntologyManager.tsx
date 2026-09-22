/**
 * Ontology manager: browse and inspect the generated model.
 *
 * The properties table shows the semantic role of every column, because that is
 * the thing the generator decided and the thing everything downstream depends on.
 * The links table shows the match ratio and how each link was discovered, so a
 * partial join is visibly partial rather than looking like a clean arrow.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type LinkTypeRow,
	type ObjectTypeDetail,
	type ObjectTypeSummary,
	api,
	isMissingOntology,
	round,
} from "../api";
import { useSpace } from "../SpaceContext";
import { ObjectTypeEditor } from "../components/ontology/OntologyEditor";
import {
	EditJournal,
	LinkBuilder,
	type OntologyEdit,
} from "../components/ontology/LinkBuilder";
import {
	DataTable,
	Empty,
	ErrorBanner,
	NoOntologyHere,
	Spinner,
} from "../components/common";

type Tab = "properties" | "links" | "actions" | "raw";

export function OntologyManager() {
	const [types, setTypes] = useState<ObjectTypeSummary[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [detail, setDetail] = useState<ObjectTypeDetail | null>(null);
	const [allLinks, setAllLinks] = useState<LinkTypeRow[] | null>(null);
	const [tab, setTab] = useState<Tab>("properties");
	const [filter, setFilter] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [missing, setMissing] = useState(false);
	const { spaceSlug, space } = useSpace();
	const [editing, setEditing] = useState(false);
	const [drawingLink, setDrawingLink] = useState(false);
	const [edits, setEdits] = useState<OntologyEdit[]>([]);
	const [undoing, setUndoing] = useState<number | null>(null);

	/**
	 * Reload after an edit.
	 *
	 * The registry is rebuilt server-side by the edit itself, so this refetches
	 * rather than patching local state - a label change can alter grouping and
	 * ordering, and reconciling that by hand would drift.
	 */
	const reloadAfterEdit = useCallback(async () => {
		const [typeRows, linkRows, journal] = await Promise.all([
			api.get<ObjectTypeSummary[]>("/api/object-types"),
			api.get<LinkTypeRow[]>("/api/link-types"),
			api.get<OntologyEdit[]>("/api/ontology/edits"),
		]);
		setTypes(typeRows);
		setAllLinks(linkRows);
		setEdits(journal);
		if (selected) {
			setDetail(await api.get<ObjectTypeDetail>(`/api/object-types/${selected}`));
		}
	}, [selected]);

	// Keyed on the space: the ontology belongs to one, so switching has to
	// reload rather than leave the previous space's types on screen. The
	// selection is cleared too, because an api name from the old space would
	// not resolve in the new one.
	useEffect(() => {
		setTypes(null);
		setAllLinks(null);
		setSelected(null);
		setDetail(null);
		setError(null);
		setMissing(false);
		Promise.all([
			api.get<ObjectTypeSummary[]>("/api/object-types"),
			api.get<LinkTypeRow[]>("/api/link-types"),
			// Tolerated separately: the journal is context, and failing to load
			// it should not hide the ontology itself.
			api.get<OntologyEdit[]>("/api/ontology/edits").catch(() => [] as OntologyEdit[]),
		])
			.then(([typeRows, linkRows, journal]) => {
				setTypes(typeRows);
				setAllLinks(linkRows);
				setEdits(journal);
				setSelected((current) => current ?? typeRows[0]?.apiName ?? null);
			})
			.catch((exc: Error) =>
				isMissingOntology(exc) ? setMissing(true) : setError(exc.message),
			);
	}, [spaceSlug]);

	useEffect(() => {
		if (!selected) return;
		setDetail(null);
		api
			.get<ObjectTypeDetail>(`/api/object-types/${selected}`)
			.then(setDetail)
			.catch((exc: Error) => setError(exc.message));
	}, [selected]);

	const grouped = useMemo(() => {
		if (!types) return [];
		const needle = filter.trim().toLowerCase();
		const matching = needle
			? types.filter(
					(type) =>
						type.apiName.toLowerCase().includes(needle) ||
						type.label.toLowerCase().includes(needle) ||
						(type.group ?? "").toLowerCase().includes(needle),
				)
			: types;
		const buckets = new Map<string, ObjectTypeSummary[]>();
		for (const type of matching) {
			const key = type.group ?? "Other";
			const bucket = buckets.get(key);
			if (bucket) bucket.push(type);
			else buckets.set(key, [type]);
		}
		return [...buckets.entries()];
	}, [types, filter]);

	if (missing)
		return <NoOntologyHere what="object types" spaceName={space?.name ?? spaceSlug} />;
	if (error) return <ErrorBanner error={error} />;
	if (!types) return <Spinner label="Loading ontology" />;

	return (
		<div className="split">
			<div className="card" style={{ padding: 10 }}>
				<input
					placeholder="Filter object types"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					style={{ width: "100%", marginBottom: 8 }}
				/>
				<div className="scroll-list">
					{grouped.length === 0 && <Empty>No object type matches that.</Empty>}
					{grouped.map(([group, groupTypes]) => (
						<div key={group}>
							<div className="rail-section">{group}</div>
							{groupTypes.map((type) => (
								<button
									key={type.apiName}
									className={`rail-link ${type.apiName === selected ? "active" : ""}`}
									style={{ width: "100%", textAlign: "left" }}
									onClick={() => setSelected(type.apiName)}
								>
									<span
										className="glyph"
										style={{
											color: type.color ?? "var(--ink-muted)",
											fontSize: 15,
											lineHeight: 1,
										}}
										aria-hidden
									>
										●
									</span>
									<span>{type.label}</span>
									<span className="count">{type.rowCount.toLocaleString()}</span>
								</button>
							))}
						</div>
					))}
				</div>
			</div>

			<div className="col" style={{ minWidth: 0 }}>
				{!detail ? (
					<Spinner label="Loading object type" />
				) : (
					<>
						<div className="card">
							<div className="card-head">
								<h3 style={{ fontSize: 15 }}>{detail.label}</h3>
								<span className="chip mono">{detail.rid}</span>
								<span className="sub">{detail.rowCount.toLocaleString()} objects</span>
								<button
									className="btn sm"
									style={{ marginLeft: "auto" }}
									onClick={() => setEditing(true)}
								>
									Edit
								</button>
							</div>
							<p className="secondary" style={{ margin: "0 0 10px" }}>
								{detail.description}
							</p>
							<dl className="kv">
								<dt>Backed by</dt>
								<dd className="mono">{detail.sourceView}</dd>
								<dt>Primary key</dt>
								<dd className="mono">{detail.primaryKeyProperty ?? "—"}</dd>
								<dt>Title</dt>
								<dd className="mono">{detail.titleProperty ?? "—"}</dd>
								<dt>Kind</dt>
								<dd>{detail.kind}</dd>
							</dl>
						</div>

						<div className="row" style={{ gap: 4 }}>
							{(["properties", "links", "actions", "raw"] as Tab[]).map((name) => (
								<button
									key={name}
									className={`btn sm ${tab === name ? "primary" : ""}`}
									onClick={() => setTab(name)}
								>
									{name === "raw"
										? "JSON"
										: `${name[0]!.toUpperCase()}${name.slice(1)} (${
												name === "properties"
													? detail.properties.length
													: name === "links"
														? detail.links.length
														: detail.actions.length
											})`}
								</button>
							))}
						</div>

						{tab === "properties" && (
							<div className="card">
								<DataTable
									columns={[
										{ key: "apiName", label: "Property" },
										{ key: "label", label: "Label" },
										{ key: "semanticRole", label: "Role" },
										{ key: "datatype", label: "Type" },
										{ key: "unit", label: "Unit" },
										{ key: "defaultAggregation", label: "Aggregate" },
										{ key: "sqlColumn", label: "SQL column" },
									]}
									rows={detail.properties as unknown as Array<Record<string, unknown>>}
									maxHeight={520}
								/>
							</div>
						)}

						{tab === "links" && (
							<div className="card">
								<DataTable
									columns={[
										{ key: "apiName", label: "Link" },
										{ key: "label", label: "Label" },
										{ key: "direction", label: "Direction" },
										{ key: "targetObjectType", label: "To" },
										{ key: "coverage", label: "Resolves", numeric: true },
										{ key: "discoveryMethod", label: "Discovered by" },
									]}
									rows={detail.links.map((link) => ({
										...link,
										coverage: `${round(link.matchRatio * 100, 1)}%`,
									}))}
									maxHeight={520}
								/>
								{detail.links.some((link) => !link.isVerified) && (
									<p className="muted" style={{ fontSize: 11.5, marginBottom: 0, marginTop: 9 }}>
										A link below 100% does not resolve every reference. Traversing it
										will miss the rows whose key has no match.
									</p>
								)}
							</div>
						)}

						{tab === "actions" && (
							<div className="card">
								{detail.actions.length === 0 ? (
									<Empty>No actions are declared against this object type.</Empty>
								) : (
									<div className="col" style={{ gap: 10 }}>
										{detail.actions.map((action) => (
											<div
												key={action.apiName}
												style={{
													border: "1px solid var(--border)",
													borderRadius: "var(--radius)",
													padding: "10px 12px",
												}}
											>
												<div className="row" style={{ gap: 7 }}>
													<strong>{action.label}</strong>
													<span className={`chip ${action.isReadOnly ? "good" : "warning"}`}>
														<span className="dot" aria-hidden />
														{action.isReadOnly ? "read-only" : "mutating"}
													</span>
													{action.requiresApproval && <span className="chip">needs approval</span>}
												</div>
												<p className="secondary" style={{ margin: "6px 0", fontSize: 12.5 }}>
													{action.description}
												</p>
												<div className="mono muted" style={{ fontSize: 11.5 }}>
													{action.parameters
														.map(
															(parameter) =>
																`${String(parameter.name)}${parameter.required ? "" : "?"}: ${String(
																	parameter.type,
																)}`,
														)
														.join(", ")}
												</div>
												<div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
													Allowed roles: {action.allowedRoles.join(", ") || "none"}
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{tab === "raw" && (
							<div className="card">
								<pre className="mono" style={{ margin: 0, maxHeight: 520, overflow: "auto" }}>
									{JSON.stringify(detail, null, 2)}
								</pre>
							</div>
						)}
					</>
				)}

				{allLinks && (
					<div className="card">
						<div className="card-head">
							<h3>Every link type</h3>
							<button
								className="btn sm"
								style={{ marginLeft: "auto" }}
								onClick={() => setDrawingLink(true)}
							>
								+ Draw a link
							</button>
							<span className="sub">
								{allLinks.filter((link) => link.isVerified).length} of {allLinks.length} resolve
								every reference
							</span>
						</div>
						<DataTable
							columns={[
								{ key: "apiName", label: "Link" },
								{ key: "sourceApiName", label: "From" },
								{ key: "targetApiName", label: "To" },
								{ key: "coverage", label: "Resolves", numeric: true },
								{ key: "matchedRows", label: "Matched", numeric: true },
								{ key: "candidateRows", label: "Candidates", numeric: true },
								{ key: "discoveryMethod", label: "Discovered by" },
							]}
							rows={allLinks.map((link) => ({
								...link,
								coverage: `${round(link.matchRatio * 100, 1)}%`,
							}))}
							maxHeight={380}
						/>
					</div>
				)}
			</div>
			<div className="card">
				<div className="card-head">
					<h3>Edit journal</h3>
					<span className="sub">
						replayed onto every ontology the pipeline publishes afterwards
					</span>
				</div>
				<EditJournal
					edits={edits}
					busyId={undoing}
					onUndo={async (edit) => {
						setUndoing(edit.id);
						try {
							await api.post(`/api/ontology/edits/${edit.id}/undo`);
							await reloadAfterEdit();
						} catch (exc) {
							setError((exc as Error).message);
						} finally {
							setUndoing(null);
						}
					}}
				/>
			</div>

			<ObjectTypeEditor
				detail={editing ? detail : null}
				onClose={() => setEditing(false)}
				onSaved={() => void reloadAfterEdit()}
			/>

			<LinkBuilder
				open={drawingLink}
				types={types ?? []}
				onClose={() => setDrawingLink(false)}
				onCreated={() => void reloadAfterEdit()}
			/>
		</div>
	);
}
