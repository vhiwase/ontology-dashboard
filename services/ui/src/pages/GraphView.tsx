/** Ontology graph: object types as nodes, discovered link types as edges. */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type LinkTypeRow, type ObjectTypeSummary, api, isMissingOntology, round } from "../api";
import { useSpace } from "../SpaceContext";
import { GraphCanvas, type GraphLink, type GraphNode } from "../components/GraphCanvas";
import {
	DataTable,
	ErrorBanner,
	NoOntologyHere,
	Spinner,
} from "../components/common";

export function GraphView() {
	const [types, setTypes] = useState<ObjectTypeSummary[] | null>(null);
	const [links, setLinks] = useState<LinkTypeRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [onlyComplete, setOnlyComplete] = useState(false);
	const [exportFormat, setExportFormat] = useState("mermaid");
	const [exported, setExported] = useState<string | null>(null);
	const [missing, setMissing] = useState(false);
	const { spaceSlug, space } = useSpace();

	// The graph is the ontology drawn out, so it is per-space like the ontology.
	useEffect(() => {
		setTypes(null);
		setLinks(null);
		setSelected(null);
		setExported(null);
		setError(null);
		setMissing(false);
		Promise.all([
			api.get<ObjectTypeSummary[]>("/api/object-types"),
			api.get<LinkTypeRow[]>("/api/link-types"),
		])
			.then(([typeRows, linkRows]) => {
				setTypes(typeRows);
				setLinks(linkRows);
			})
			.catch((exc: Error) =>
				isMissingOntology(exc) ? setMissing(true) : setError(exc.message),
			);
	}, [spaceSlug]);

	const nodes = useMemo<GraphNode[]>(
		() =>
			// Deliberately not passing type.color: each object type has its own shade,
			// but the legend has one swatch per domain, so per-type shades would make
			// the legend a lie. Domain carries the colour; the label carries the type.
			(types ?? []).map((type) => ({
				id: type.apiName,
				label: type.label,
				group: type.group,
				weight: type.rowCount,
				meta: { rowCount: type.rowCount, description: type.description },
			})),
		[types],
	);

	const graphLinks = useMemo<GraphLink[]>(() => {
		const source = onlyComplete ? (links ?? []).filter((link) => link.isVerified) : links ?? [];
		return source
			.filter((link) => link.sourceApiName && link.targetApiName)
			.map((link) => ({
				source: link.sourceApiName!,
				target: link.targetApiName!,
				label: link.label,
				// Dashed means the join does not resolve every reference, so the arrow
				// is not the whole story.
				dashed: !link.isVerified,
			}));
	}, [links, onlyComplete]);

	const selectedType = types?.find((type) => type.apiName === selected) ?? null;
	const selectedLinks = (links ?? []).filter(
		(link) => link.sourceApiName === selected || link.targetApiName === selected,
	);

	const runExport = (format: string) => {
		setExported(null);
		setExportFormat(format);
		api
			.get<string>(`/api/ontology/export/${format}`)
			.then((text) => setExported(typeof text === "string" ? text : JSON.stringify(text, null, 2)))
			.catch((exc: Error) => setError(exc.message));
	};

	if (missing)
		return <NoOntologyHere what="object graph" spaceName={space?.name ?? spaceSlug} />;
	if (error) return <ErrorBanner error={error} />;
	if (!types || !links) return <Spinner label="Loading ontology graph" />;

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3>Ontology graph</h3>
					<span className="sub">
						{nodes.length} object types · {graphLinks.length} of {links.length} link types shown
					</span>
				</div>
				<div className="row" style={{ gap: 12, marginBottom: 10 }}>
					<label className="row" style={{ gap: 6 }}>
						<input
							type="checkbox"
							checked={onlyComplete}
							onChange={(event) => setOnlyComplete(event.target.checked)}
							style={{ width: "auto" }}
						/>
						<span className="secondary">Only links that resolve every reference</span>
					</label>
					<div style={{ flex: 1 }} />
					<span className="muted" style={{ fontSize: 11.5 }}>
						Dashed edge = partial join
					</span>
				</div>
				<GraphCanvas
					nodes={nodes}
					links={graphLinks}
					layout="force"
					height={540}
					selectedId={selected}
					onSelect={(node) => setSelected(node.id === selected ? null : node.id)}
				/>
			</div>

			{selectedType && (
				<div className="card">
					<div className="card-head">
						<h3>{selectedType.label}</h3>
						<span className="sub">{selectedType.rowCount.toLocaleString()} objects</span>
						<Link className="btn sm" to="/explorer" style={{ marginLeft: 10 }}>
							Explore
						</Link>
					</div>
					<p className="secondary" style={{ margin: "0 0 10px" }}>
						{selectedType.description}
					</p>
					<DataTable
						columns={[
							{ key: "apiName", label: "Link" },
							{ key: "sourceApiName", label: "From" },
							{ key: "targetApiName", label: "To" },
							{ key: "coverage", label: "Resolves", numeric: true },
							{ key: "discoveryMethod", label: "Discovered by" },
						]}
						rows={selectedLinks.map((link) => ({
							...link,
							coverage: `${round(link.matchRatio * 100, 1)}%`,
						}))}
						maxHeight={280}
					/>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>Export the ontology</h3>
					<span className="sub">generated by @ontograph/core from the published document</span>
				</div>
				<div className="row" style={{ gap: 6 }}>
					{["mermaid", "er", "dot", "owl", "shacl", "json-schema", "json"].map((format) => (
						<button
							key={format}
							className={`btn sm ${exportFormat === format && exported ? "primary" : ""}`}
							onClick={() => runExport(format)}
						>
							{format}
						</button>
					))}
					{exported && (
						<button
							className="btn sm"
							onClick={() => void navigator.clipboard?.writeText(exported)}
							style={{ marginLeft: "auto" }}
						>
							Copy
						</button>
					)}
				</div>
				{exported && (
					<pre
						className="mono"
						style={{ marginTop: 10, marginBottom: 0, maxHeight: 340, overflow: "auto" }}
					>
						{exported.slice(0, 20000)}
						{exported.length > 20000 ? "\n… truncated for display; use Copy for the whole thing." : ""}
					</pre>
				)}
			</div>
		</div>
	);
}
