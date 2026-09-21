/**
 * Object explorer: query object sets, open one object, walk its links.
 *
 * Filters are built from the type's own properties, with the operator list
 * narrowed by datatype, so it is not possible to compose a filter the service
 * will reject. The SQL that produced the rows is shown on request - the point of
 * an ontology layer is not to hide the query, it is to make it derivable.
 */

import { useEffect, useMemo, useState } from "react";
import {
	type LinkSummary,
	type ObjectTypeDetail,
	type ObjectTypeSummary,
	type PropertyMeta,
	type SearchResult,
	api,
	formatCell,
	round,
} from "../api";
import { DataTable, Empty, ErrorBanner, Spinner, useDebounced } from "../components/common";

interface FilterRow {
	id: number;
	property: string;
	op: string;
	value: string;
}

const OPS_BY_TYPE: Record<string, string[]> = {
	string: ["eq", "ne", "contains", "startsWith", "endsWith", "isNull", "isNotNull", "in"],
	integer: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
	decimal: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
	float: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
	boolean: ["eq", "ne", "isNull", "isNotNull"],
	datetime: ["gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
	date: ["eq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
};

const OP_LABELS: Record<string, string> = {
	eq: "is",
	ne: "is not",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	in: "is one of",
	notIn: "is not one of",
	contains: "contains",
	startsWith: "starts with",
	endsWith: "ends with",
	isNull: "is empty",
	isNotNull: "is not empty",
	between: "between",
};

export function ObjectExplorer() {
	const [types, setTypes] = useState<ObjectTypeSummary[] | null>(null);
	const [typeName, setTypeName] = useState<string>("Order");
	const [detail, setDetail] = useState<ObjectTypeDetail | null>(null);
	const [filters, setFilters] = useState<FilterRow[]>([]);
	const [search, setSearch] = useState("");
	const [sortProperty, setSortProperty] = useState<string>("");
	const [sortDescending, setSortDescending] = useState(true);
	const [page, setPage] = useState(0);
	const [result, setResult] = useState<SearchResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [showSql, setShowSql] = useState(false);

	const pageSize = 25;
	const debouncedSearch = useDebounced(search, 350);

	useEffect(() => {
		api
			.get<ObjectTypeSummary[]>("/api/object-types")
			.then(setTypes)
			.catch((exc: Error) => setError(exc.message));
	}, []);

	useEffect(() => {
		setDetail(null);
		setFilters([]);
		setSortProperty("");
		setPage(0);
		setOpenKey(null);
		api
			.get<ObjectTypeDetail>(`/api/object-types/${typeName}`)
			.then(setDetail)
			.catch((exc: Error) => setError(exc.message));
	}, [typeName]);

	// Columns default to the identity, title and the first handful of interesting
	// properties: showing all 68 columns of Order by default is unreadable.
	const displayColumns = useMemo(() => {
		if (!detail) return [];
		const priority = (property: PropertyMeta) => {
			if (property.isIdentity) return 0;
			if (property.isTitle) return 1;
			if (property.semanticRole === "dimension" && property.datatype === "string") return 2;
			if (property.semanticRole === "measure") return 3;
			if (property.semanticRole === "temporal") return 4;
			if (property.semanticRole === "flag") return 5;
			return 6;
		};
		return [...detail.properties]
			.sort((a, b) => priority(a) - priority(b) || a.displayOrder - b.displayOrder)
			.slice(0, 11);
	}, [detail]);

	useEffect(() => {
		if (!detail) return;
		setBusy(true);
		setError(null);

		const where = filters
			.filter((row) => row.property)
			.map((row) => {
				const property = detail.properties.find((p) => p.apiName === row.property);
				let value: unknown = row.value;
				if (row.op === "isNull" || row.op === "isNotNull") value = undefined;
				else if (property?.datatype === "boolean") value = row.value === "true";
				else if (
					["integer", "decimal", "float"].includes(property?.datatype ?? "") &&
					row.value !== ""
				) {
					value = Number(row.value);
				} else if (row.op === "in" || row.op === "notIn") {
					value = row.value.split(",").map((part) => part.trim()).filter(Boolean);
				} else if (row.op === "between") {
					value = row.value.split(",").map((part) => part.trim());
				}
				return { property: row.property, op: row.op, ...(value === undefined ? {} : { value }) };
			});

		api
			.post<SearchResult>(`/api/objects/${typeName}/search`, {
				where,
				search: debouncedSearch || undefined,
				orderBy: sortProperty
					? [{ property: sortProperty, direction: sortDescending ? "desc" : "asc" }]
					: [],
				select: displayColumns.map((property) => property.apiName),
				limit: pageSize,
				offset: page * pageSize,
				includeLinkTitles: true,
			})
			.then(setResult)
			.catch((exc: Error) => setError(exc.message))
			.finally(() => setBusy(false));
	}, [detail, typeName, filters, debouncedSearch, sortProperty, sortDescending, page, displayColumns]);

	if (!types) return <Spinner label="Loading object types" />;

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="row" style={{ gap: 10 }}>
					<label className="row" style={{ gap: 6 }}>
						<span className="muted">Object type</span>
						<select value={typeName} onChange={(event) => setTypeName(event.target.value)}>
							{types.map((type) => (
								<option key={type.apiName} value={type.apiName}>
									{type.label} ({type.rowCount.toLocaleString()})
								</option>
							))}
						</select>
					</label>

					<input
						placeholder="Search names and identifiers"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(0);
						}}
						style={{ minWidth: 240 }}
					/>

					{detail && (
						<label className="row" style={{ gap: 6 }}>
							<span className="muted">Sort</span>
							<select
								value={sortProperty}
								onChange={(event) => {
									setSortProperty(event.target.value);
									setPage(0);
								}}
							>
								<option value="">default</option>
								{detail.properties.map((property) => (
									<option key={property.apiName} value={property.apiName}>
										{property.label}
									</option>
								))}
							</select>
							<button
								className="btn sm"
								onClick={() => setSortDescending((current) => !current)}
								title="Toggle direction"
							>
								{sortDescending ? "desc" : "asc"}
							</button>
						</label>
					)}

					<div className="spacer" style={{ flex: 1 }} />
					{busy && <Spinner />}
					<button
						className="btn sm"
						onClick={() =>
							setFilters((current) => [
								...current,
								{
									id: Date.now(),
									property: detail?.properties[0]?.apiName ?? "",
									op: "eq",
									value: "",
								},
							])
						}
					>
						+ Filter
					</button>
				</div>

				{filters.length > 0 && detail && (
					<div className="col" style={{ gap: 6, marginTop: 10 }}>
						{filters.map((row) => {
							const property = detail.properties.find((p) => p.apiName === row.property);
							const ops = OPS_BY_TYPE[property?.datatype ?? "string"] ?? OPS_BY_TYPE.string!;
							const needsValue = row.op !== "isNull" && row.op !== "isNotNull";
							return (
								<div className="row" key={row.id} style={{ gap: 6 }}>
									<select
										value={row.property}
										onChange={(event) =>
											setFilters((current) =>
												current.map((entry) =>
													entry.id === row.id
														? { ...entry, property: event.target.value, value: "" }
														: entry,
												),
											)
										}
									>
										{detail.properties.map((candidate) => (
											<option key={candidate.apiName} value={candidate.apiName}>
												{candidate.label}
											</option>
										))}
									</select>
									<select
										value={row.op}
										onChange={(event) =>
											setFilters((current) =>
												current.map((entry) =>
													entry.id === row.id ? { ...entry, op: event.target.value } : entry,
												),
											)
										}
									>
										{ops.map((op) => (
											<option key={op} value={op}>
												{OP_LABELS[op] ?? op}
											</option>
										))}
									</select>
									{needsValue &&
										(property?.datatype === "boolean" ? (
											<select
												value={row.value || "true"}
												onChange={(event) =>
													setFilters((current) =>
														current.map((entry) =>
															entry.id === row.id ? { ...entry, value: event.target.value } : entry,
														),
													)
												}
											>
												<option value="true">Yes</option>
												<option value="false">No</option>
											</select>
										) : (
											<input
												value={row.value}
												placeholder={row.op === "between" ? "from, to" : "value"}
												onChange={(event) =>
													setFilters((current) =>
														current.map((entry) =>
															entry.id === row.id ? { ...entry, value: event.target.value } : entry,
														),
													)
												}
											/>
										))}
									<button
										className="btn sm"
										onClick={() => setFilters((current) => current.filter((entry) => entry.id !== row.id))}
									>
										Remove
									</button>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{error && <ErrorBanner error={error} />}

			{result && (
				<div className="card">
					<div className="card-head">
						<h3>
							{result.label} · {result.totalCount.toLocaleString()} matching
						</h3>
						<span className="sub">
							showing {result.offset + 1}–{Math.min(result.offset + result.returned, result.totalCount)}
						</span>
					</div>

					<DataTable
						columns={result.properties.map((property) => ({
							key: property.apiName,
							label: property.label,
							numeric: ["integer", "decimal", "float"].includes(property.datatype),
						}))}
						rows={result.data}
						onRowClick={(row) => {
							const identity = detail?.properties.find((p) => p.isIdentity);
							if (identity) setOpenKey(String(row[identity.apiName]));
						}}
						maxHeight={430}
					/>

					<div className="row" style={{ marginTop: 10, gap: 8 }}>
						<button className="btn sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
							Previous
						</button>
						<button
							className="btn sm"
							disabled={result.offset + result.returned >= result.totalCount}
							onClick={() => setPage((p) => p + 1)}
						>
							Next
						</button>
						<span className="muted" style={{ fontSize: 12 }}>
							page {page + 1}
						</span>
						<div style={{ flex: 1 }} />
						<button className="btn sm" onClick={() => setShowSql((current) => !current)}>
							{showSql ? "Hide" : "Show"} SQL
						</button>
					</div>

					{showSql && (
						<pre className="mono" style={{ marginTop: 10, marginBottom: 0, whiteSpace: "pre-wrap" }}>
							{result.sql}
						</pre>
					)}
				</div>
			)}

			{openKey && detail && (
				<ObjectDetail
					type={detail}
					objectKey={openKey}
					onClose={() => setOpenKey(null)}
					onNavigate={(nextType, nextKey) => {
						setTypeName(nextType);
						setOpenKey(nextKey);
					}}
				/>
			)}
		</div>
	);
}

function ObjectDetail({
	type,
	objectKey,
	onClose,
	onNavigate,
}: {
	type: ObjectTypeDetail;
	objectKey: string;
	onClose: () => void;
	onNavigate: (objectType: string, key: string) => void;
}) {
	const [object, setObject] = useState<Record<string, unknown> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openLink, setOpenLink] = useState<LinkSummary | null>(null);
	const [linked, setLinked] = useState<{
		label: string;
		targetObjectType: string;
		totalCount: number;
		data: Array<Record<string, unknown>>;
		matchRatio: number;
	} | null>(null);

	useEffect(() => {
		setObject(null);
		setOpenLink(null);
		setLinked(null);
		api
			.get<Record<string, unknown>>(`/api/objects/${type.apiName}/${encodeURIComponent(objectKey)}`)
			.then(setObject)
			.catch((exc: Error) => setError(exc.message));
	}, [type.apiName, objectKey]);

	useEffect(() => {
		if (!openLink) return;
		setLinked(null);
		api
			.get<{
				label: string;
				targetObjectType: string;
				totalCount: number;
				data: Array<Record<string, unknown>>;
				matchRatio: number;
			}>(`/api/objects/${type.apiName}/${encodeURIComponent(objectKey)}/links/${openLink.apiName}`)
			.then(setLinked)
			.catch((exc: Error) => setError(exc.message));
	}, [openLink, type.apiName, objectKey]);

	const title = object
		? String(object[type.titleProperty ?? ""] ?? objectKey)
		: objectKey;

	return (
		<div className="card">
			<div className="card-head">
				<h3>
					{type.label} · {title}
				</h3>
				<button className="btn sm" onClick={onClose} style={{ marginLeft: "auto" }}>
					Close
				</button>
			</div>

			{error && <ErrorBanner error={error} />}
			{!object ? (
				<Spinner label="Loading object" />
			) : (
				<div className="grid grid-2" style={{ gap: 14 }}>
					<div>
						<h4 style={{ margin: "0 0 7px", fontSize: 12, color: "var(--ink-muted)" }}>PROPERTIES</h4>
						<div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
							<table className="data">
								<tbody>
									{type.properties
										.filter((property) => {
											const value = object[property.apiName];
											return value !== null && value !== undefined && value !== "";
										})
										.map((property) => (
											<tr key={property.apiName}>
												<td className="muted" style={{ width: "45%" }}>
													{property.label}
												</td>
												<td>
													{formatCell(object[property.apiName])}
													{property.unit ? ` ${property.unit}` : ""}
													{object[`${property.apiName}__display`] ? (
														<span className="muted"> · {String(object[`${property.apiName}__display`])}</span>
													) : null}
												</td>
											</tr>
										))}
								</tbody>
							</table>
						</div>
					</div>

					<div>
						<h4 style={{ margin: "0 0 7px", fontSize: 12, color: "var(--ink-muted)" }}>LINKS</h4>
						<div className="col" style={{ gap: 4, maxHeight: 340, overflowY: "auto" }}>
							{type.links.map((link) => (
								<button
									key={`${link.apiName}-${link.direction}`}
									className={`rail-link ${openLink?.apiName === link.apiName ? "active" : ""}`}
									style={{ width: "100%", textAlign: "left" }}
									onClick={() => setOpenLink(link)}
								>
									<span>{link.label}</span>
									<span className="count">
										{link.targetObjectType}
										{!link.isVerified && ` · ${round(link.matchRatio * 100, 0)}%`}
									</span>
								</button>
							))}
							{type.links.length === 0 && <Empty>No links.</Empty>}
						</div>
					</div>
				</div>
			)}

			{openLink && (
				<div style={{ marginTop: 14 }}>
					<div className="card-head">
						<h3>
							{openLink.label} → {openLink.targetObjectType}
						</h3>
						{linked && <span className="sub">{linked.totalCount.toLocaleString()} linked objects</span>}
					</div>
					{!linked ? (
						<Spinner label="Traversing link" />
					) : linked.data.length === 0 ? (
						<Empty>Nothing linked through {openLink.label}.</Empty>
					) : (
						<>
							{linked.matchRatio < 0.999 && (
								<div className="banner" style={{ marginBottom: 9 }}>
									This link resolves {round(linked.matchRatio * 100, 1)}% of references, so
									some related objects are not reachable through it.
								</div>
							)}
							<DataTable
								columns={Object.keys(linked.data[0] ?? {})
									.filter((key) => !key.endsWith("__display"))
									.slice(0, 8)
									.map((key) => ({ key, label: key }))}
								rows={linked.data}
								onRowClick={(row) => {
									const keyField = Object.keys(row).find((key) => key.endsWith("Key"));
									if (keyField) onNavigate(linked.targetObjectType, String(row[keyField]));
								}}
								maxHeight={300}
							/>
						</>
					)}
				</div>
			)}
		</div>
	);
}
