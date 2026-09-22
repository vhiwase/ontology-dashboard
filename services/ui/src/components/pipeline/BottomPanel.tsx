/**
 * The collapsible bottom panel: validation, runs and logs.
 *
 * Clicking a validation issue focuses the node it belongs to, which is the
 * whole point of attaching nodeId to every issue on the server — an error list
 * that cannot take you to the problem is just a list.
 */

import { useState } from "react";
import { NODE_SPECS, type NodeKind } from "./nodeTypes";

export interface Issue {
	severity: "error" | "warning";
	nodeId: string | null;
	code: string;
	message: string;
}

export interface NodeResult {
	nodeId: string;
	name: string;
	kind: NodeKind;
	status: "success" | "failed" | "skipped";
	durationMs: number;
	records: number | null;
	message: string;
}

export interface Run {
	id: number;
	version: number;
	status: string;
	startedAt: string;
	durationMs: number | null;
	records: number;
	errors: number;
	warnings: number;
	nodeResults: NodeResult[];
	log: Array<{ at: string; level: string; message: string }>;
	isSimulated: boolean;
	triggeredBy: string;
}

type Tab = "validation" | "runs" | "nodes" | "logs";

const TAB_LABELS: Record<Tab, string> = {
	validation: "Validation",
	runs: "Runs",
	nodes: "Nodes",
	logs: "Logs",
};

interface Props {
	open: boolean;
	issues: Issue[];
	runs: Run[];
	activeRun: Run | null;
	onToggle: () => void;
	onFocusNode: (nodeId: string) => void;
	onSelectRun: (run: Run) => void;
}

export function BottomPanel({
	open,
	issues,
	runs,
	activeRun,
	onToggle,
	onFocusNode,
	onSelectRun,
}: Props) {
	const [tab, setTab] = useState<Tab>("validation");

	const errors = issues.filter((i) => i.severity === "error");
	const warnings = issues.filter((i) => i.severity === "warning");

	return (
		<section className={`bottom ${open ? "open" : ""}`}>
			<header className="bottom-head">
				<button className="bottom-toggle" onClick={onToggle} aria-expanded={open}>
					{open ? "▾" : "▴"}
				</button>

				<div className="bottom-tabs">
					{(["validation", "runs", "nodes", "logs"] as Tab[]).map((id) => (
						<button
							key={id}
							className={`bottom-tab ${tab === id && open ? "active" : ""}`}
							onClick={() => {
								setTab(id);
								if (!open) onToggle();
							}}
						>
							{TAB_LABELS[id]}
							{id === "validation" && errors.length > 0 && (
								<span className="tab-badge error">{errors.length}</span>
							)}
							{id === "validation" && errors.length === 0 && warnings.length > 0 && (
								<span className="tab-badge warn">{warnings.length}</span>
							)}
							{id === "runs" && runs.length > 0 && (
								<span className="tab-badge">{runs.length}</span>
							)}
							{id === "nodes" &&
								(activeRun?.nodeResults.filter((n) => n.status === "failed").length ?? 0) >
									0 && (
									<span className="tab-badge error">
										{activeRun?.nodeResults.filter((n) => n.status === "failed").length}
									</span>
								)}
						</button>
					))}
				</div>

				{activeRun && (
					<div className="bottom-summary mono">
						<span>run #{activeRun.id}</span>
						<span className={activeRun.status === "success" ? "ok" : "error"}>
							{activeRun.status.toUpperCase()}
						</span>
						<span>{activeRun.durationMs ?? 0}ms</span>
						<span>{activeRun.records.toLocaleString("en-US")} records</span>
						{activeRun.isSimulated ? (
							<span
								className="chip"
								title="An older run, recorded before the execution engine existed: it exercised the graph's shape and estimated row counts."
							>
								estimated
							</span>
						) : (
							<span className="chip good" title="Every node ran SQL against the warehouse.">
								executed
							</span>
						)}
					</div>
				)}
			</header>

			{open && (
				<div className="bottom-body">
					{tab === "validation" && (
						<>
							{issues.length === 0 ? (
								<p className="muted">No problems. The pipeline is valid.</p>
							) : (
								<ul className="issue-list">
									{[...errors, ...warnings].map((issue, index) => (
										<li key={`${issue.code}-${index}`} className={issue.severity}>
											<span className="issue-code mono">{issue.code}</span>
											{issue.nodeId ? (
												<button
													className="link-button"
													onClick={() => onFocusNode(issue.nodeId as string)}
												>
													{issue.message}
												</button>
											) : (
												<span>{issue.message}</span>
											)}
										</li>
									))}
								</ul>
							)}
						</>
					)}

					{tab === "runs" && (
						<>
							{runs.length === 0 ? (
								<p className="muted">This pipeline has not been run yet.</p>
							) : (
								<table className="dense">
									<thead>
										<tr>
											<th>Run</th>
											<th>Version</th>
											<th>Status</th>
											<th>Duration</th>
											<th>Records</th>
											<th>Warnings</th>
											<th>By</th>
											<th>Started</th>
										</tr>
									</thead>
									<tbody>
										{runs.map((run) => (
											<tr
												key={run.id}
												className={activeRun?.id === run.id ? "active" : ""}
												onClick={() => onSelectRun(run)}
											>
												<td className="mono">#{run.id}</td>
												<td className="mono">v{run.version}</td>
												<td className={run.status === "success" ? "ok" : "error"}>
													{run.status}
												</td>
												<td className="mono">{run.durationMs ?? 0}ms</td>
												<td className="mono">{run.records.toLocaleString("en-US")}</td>
												<td className="mono">{run.warnings}</td>
												<td>{run.triggeredBy}</td>
												<td className="mono">{run.startedAt.slice(0, 19).replace("T", " ")}</td>
											</tr>
										))}
									</tbody>
								</table>
							)}

							{activeRun && activeRun.nodeResults.length > 0 && (
								<>
									<h4>Nodes in run #{activeRun.id}</h4>
									<table className="dense">
										<thead>
											<tr>
												<th>Node</th>
												<th>Kind</th>
												<th>Status</th>
												<th>Records</th>
												<th>Duration</th>
											</tr>
										</thead>
										<tbody>
											{activeRun.nodeResults.map((result) => (
												<tr
													key={result.nodeId}
													onClick={() => onFocusNode(result.nodeId)}
													title={result.message}
												>
													<td>{result.name}</td>
													<td className="muted">{NODE_SPECS[result.kind]?.label ?? result.kind}</td>
													<td className={result.status === "success" ? "ok" : "warn"}>
														{result.status}
													</td>
													<td className="mono">
														{result.records === null
															? "unknown"
															: result.records.toLocaleString("en-US")}
													</td>
													<td className="mono">{result.durationMs}ms</td>
												</tr>
											))}
										</tbody>
									</table>
								</>
							)}
						</>
					)}

					{tab === "nodes" && (
						<>
							{!activeRun || activeRun.nodeResults.length === 0 ? (
								<p className="muted">Run the pipeline to see what each node produced.</p>
							) : (
								<table className="dense">
									<thead>
										<tr>
											<th>Node</th>
											<th>Kind</th>
											<th>Status</th>
											<th className="num">Rows out</th>
											<th className="num">Duration</th>
											<th>Detail</th>
										</tr>
									</thead>
									<tbody>
										{activeRun.nodeResults.map((node) => (
											<tr key={node.nodeId}>
												<td>
													<button
														className="link-button"
														onClick={() => onFocusNode(node.nodeId)}
													>
														{node.name}
													</button>
												</td>
												<td className="mono">{node.kind}</td>
												<td>
													<span
														className={
															node.status === "success"
																? "chip good"
																: node.status === "failed"
																	? "chip bad"
																	: "chip"
														}
													>
														{node.status}
													</span>
												</td>
												{/* A dash, not a zero: a skipped node produced no
												    rows, which is not the same as producing none. */}
												<td className="num mono">
													{node.records === null
														? "—"
														: node.records.toLocaleString("en-US")}
												</td>
												<td className="num mono">{node.durationMs}ms</td>
												<td className="muted">{node.message}</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</>
					)}

					{tab === "logs" && (
						<>
							{!activeRun || activeRun.log.length === 0 ? (
								<p className="muted">No log for this run.</p>
							) : (
								<pre className="run-log">
									{activeRun.log
										.map(
											(line) =>
												`${line.at.slice(11, 19)}  ${line.level.toUpperCase().padEnd(5)}  ${line.message}`,
										)
										.join("\n")}
								</pre>
							)}
						</>
					)}
				</div>
			)}
		</section>
	);
}
