/**
 * The right-hand inspector for the selected node.
 *
 * Configuration is generated from NODE_SPECS rather than hand-written per
 * kind, and the selects that reference the ontology are populated from the
 * live palette — so choosing an object type means choosing one that exists,
 * and a stale name cannot be typed in by hand.
 */

import { useState } from "react";
import { NODE_SPECS, type ConfigField, type NodeKind } from "./nodeTypes";

export interface PaletteEntry {
	apiName: string;
	label: string;
	[key: string]: unknown;
}

export interface Palette {
	objectTypes: PaletteEntry[];
	linkTypes: PaletteEntry[];
	actionTypes: PaletteEntry[];
	kpis: PaletteEntry[];
}

export interface InspectorNode {
	id: string;
	kind: NodeKind;
	name: string;
	description: string | null;
	config: Record<string, unknown>;
}

export interface NodeIssue {
	severity: "error" | "warning";
	nodeId: string | null;
	code: string;
	message: string;
}

interface Props {
	node: InspectorNode | null;
	palette: Palette | null;
	issues: NodeIssue[];
	upstream: InspectorNode[];
	downstream: InspectorNode[];
	runRecords: number | null;
	readOnly: boolean;
	onChange: (patch: Partial<InspectorNode>) => void;
	onSelect: (nodeId: string) => void;
	onClose: () => void;
	/** Register this node's output as a dataset resource, where it has one. */
	onCreateDataset?: (node: InspectorNode) => void;
	/** Open the workspace preview window for what this node points at. */
	onPreviewResource?: (node: InspectorNode) => void;
}

type Tab = "overview" | "configuration" | "dependencies" | "validation";

const TABS: Array<{ id: Tab; label: string }> = [
	{ id: "overview", label: "Overview" },
	{ id: "configuration", label: "Configuration" },
	{ id: "dependencies", label: "Dependencies" },
	{ id: "validation", label: "Validation" },
];

function optionsFor(field: ConfigField, palette: Palette | null): PaletteEntry[] {
	if (!field.source || !palette) {
		return (field.options ?? []).map((value) => ({ apiName: value, label: value }));
	}
	return palette[field.source] ?? [];
}

export function NodeInspector({
	node,
	palette,
	issues,
	upstream,
	downstream,
	runRecords,
	readOnly,
	onChange,
	onSelect,
	onClose,
	onCreateDataset,
	onPreviewResource,
}: Props) {
	const [tab, setTab] = useState<Tab>("overview");

	if (!node) {
		return (
			<aside className="inspector">
				<div className="inspector-empty">
					<p>No node selected.</p>
					<p className="muted">
						Click a node to inspect it, or press <kbd>N</kbd> to add one.
					</p>
				</div>
			</aside>
		);
	}

	const spec = NODE_SPECS[node.kind];
	const mine = issues.filter((issue) => issue.nodeId === node.id);
	const errors = mine.filter((i) => i.severity === "error");

	function setConfig(key: string, value: unknown) {
		onChange({ config: { ...node!.config, [key]: value } });
	}

	return (
		<aside className="inspector">
			<div className="inspector-head">
				<div className="row" style={{ gap: 6, minWidth: 0 }}>
					<span className="pnode-glyph" aria-hidden>
						{spec.glyph}
					</span>
					<div style={{ minWidth: 0 }}>
						<div className="inspector-kind">{spec.label.toUpperCase()}</div>
						<div className="inspector-title" title={node.name}>
							{node.name}
						</div>
					</div>
				</div>
				<button className="btn sm" onClick={onClose} aria-label="Close inspector">
					✕
				</button>
			</div>

			<div className="inspector-tabs">
				{TABS.map((entry) => (
					<button
						key={entry.id}
						className={`inspector-tab ${tab === entry.id ? "active" : ""}`}
						onClick={() => setTab(entry.id)}
					>
						{entry.label}
						{entry.id === "validation" && mine.length > 0 && (
							<span className={`tab-badge ${errors.length ? "error" : "warn"}`}>
								{mine.length}
							</span>
						)}
					</button>
				))}
			</div>

			<div className="inspector-body">
				{tab === "overview" && (
					<>
						<p className="muted" style={{ marginTop: 0 }}>
							{spec.description}
						</p>
						<dl className="kv">
							<dt>Node id</dt>
							<dd className="mono">{node.id}</dd>
							<dt>Group</dt>
							<dd>{spec.group}</dd>
							<dt>Upstream</dt>
							<dd>{upstream.length}</dd>
							<dt>Downstream</dt>
							<dd>{downstream.length}</dd>
							<dt>Last run</dt>
							<dd>
								{runRecords === null ? (
									<span className="muted">not known</span>
								) : (
									`${runRecords.toLocaleString("en-US")} rows`
								)}
							</dd>
						</dl>

						<label className="field">
							<span>Name</span>
							<input
								value={node.name}
								disabled={readOnly}
								onChange={(event) => onChange({ name: event.target.value })}
							/>
						</label>
						<label className="field">
							<span>Description</span>
							<textarea
								rows={3}
								value={node.description ?? ""}
								disabled={readOnly}
								placeholder="What this step is for. Undocumented nodes raise a warning."
								onChange={(event) => onChange({ description: event.target.value })}
							/>
						</label>

						{/* The ontology kinds are the ones registered as resources, so
						    they are the ones with a preview window to open. */}
						{onPreviewResource &&
							["objectType", "linkType", "actionType"].includes(node.kind) && (
								<button
									className="btn sm"
									style={{ width: "100%", justifyContent: "center", marginBottom: 8 }}
									onClick={() => onPreviewResource(node)}
								>
									Open preview window
								</button>
							)}

						{/* Only an Object Type node has a published view behind it, so it
						    is the only kind whose output can become a real dataset. */}
						{onCreateDataset && !readOnly && node.kind === "objectType" && (
							<button
								className="btn sm primary"
								style={{ width: "100%", justifyContent: "center" }}
								onClick={() => onCreateDataset(node)}
								disabled={!node.config?.objectType}
								title={
									node.config?.objectType
										? "Register this node's output as a dataset in the workspace"
										: "Choose an object type first"
								}
							>
								Create dataset from this node
							</button>
						)}
					</>
				)}

				{tab === "configuration" && (
					<>
						{spec.fields.length === 0 && <p className="muted">Nothing to configure.</p>}
						{spec.fields.map((field) => {
							const value = node.config?.[field.key];
							const options = optionsFor(field, palette);
							return (
								<label className="field" key={field.key}>
									<span>{field.label}</span>

									{field.kind === "textarea" && (
										<textarea
											rows={6}
											className="mono"
											disabled={readOnly}
											value={String(value ?? "")}
											placeholder={field.placeholder}
											onChange={(event) => setConfig(field.key, event.target.value)}
										/>
									)}

									{field.kind === "text" && (
										<input
											disabled={readOnly}
											value={String(value ?? "")}
											placeholder={field.placeholder}
											onChange={(event) => setConfig(field.key, event.target.value)}
										/>
									)}

									{field.kind === "number" && (
										<input
											type="number"
											disabled={readOnly}
											value={value === undefined || value === null ? "" : String(value)}
											placeholder={field.placeholder}
											onChange={(event) =>
												setConfig(
													field.key,
													event.target.value === "" ? undefined : Number(event.target.value),
												)
											}
										/>
									)}

									{field.kind === "select" && (
										<select
											disabled={readOnly}
											value={String(value ?? "")}
											onChange={(event) => setConfig(field.key, event.target.value)}
										>
											<option value="">— not set —</option>
											{options.map((option) => (
												<option key={option.apiName} value={option.apiName}>
													{option.label === option.apiName
														? option.apiName
														: `${option.label} (${option.apiName})`}
												</option>
											))}
										</select>
									)}

									{field.kind === "multiselect" && (
										<div className="multiselect">
											{options.map((option) => {
												const current = Array.isArray(value) ? (value as string[]) : [];
												const checked = current.includes(option.apiName);
												return (
													<label className="multiselect-row" key={option.apiName}>
														<input
															type="checkbox"
															disabled={readOnly}
															checked={checked}
															onChange={() =>
																setConfig(
																	field.key,
																	checked
																		? current.filter((item) => item !== option.apiName)
																		: [...current, option.apiName],
																)
															}
														/>
														<span>{option.label}</span>
														<span className="mono muted">{option.apiName}</span>
													</label>
												);
											})}
										</div>
									)}

									{field.hint && <em className="field-hint">{field.hint}</em>}
								</label>
							);
						})}
					</>
				)}

				{tab === "dependencies" && (
					<>
						<h4>Upstream</h4>
						{upstream.length === 0 ? (
							<p className="muted">Nothing feeds this node.</p>
						) : (
							<ul className="dep-list">
								{upstream.map((item) => (
									<li key={item.id}>
										<button className="link-button" onClick={() => onSelect(item.id)}>
											{NODE_SPECS[item.kind].glyph} {item.name}
										</button>
									</li>
								))}
							</ul>
						)}

						<h4>Downstream</h4>
						{downstream.length === 0 ? (
							<p className="muted">Nothing depends on this node.</p>
						) : (
							<ul className="dep-list">
								{downstream.map((item) => (
									<li key={item.id}>
										<button className="link-button" onClick={() => onSelect(item.id)}>
											{NODE_SPECS[item.kind].glyph} {item.name}
										</button>
									</li>
								))}
							</ul>
						)}
					</>
				)}

				{tab === "validation" && (
					<>
						{mine.length === 0 ? (
							<p className="muted">No problems on this node.</p>
						) : (
							<ul className="issue-list">
								{mine.map((issue) => (
									<li key={`${issue.code}-${issue.message}`} className={issue.severity}>
										<span className="issue-code mono">{issue.code}</span>
										{issue.message}
									</li>
								))}
							</ul>
						)}
					</>
				)}
			</div>
		</aside>
	);
}
