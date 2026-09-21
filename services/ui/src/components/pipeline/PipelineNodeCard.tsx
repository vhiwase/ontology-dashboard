/**
 * The card drawn for every node on the canvas.
 *
 * One component for all fourteen kinds, driven by NODE_SPECS, so a new kind is
 * a data change rather than a new component — and so every card has the same
 * anatomy: accent rail, kind, name, configured metadata, status.
 *
 * Density is deliberate. These graphs run to dozens of nodes, and a card that
 * reads at a glance beats one that is comfortable to look at on its own.
 */

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { NODE_SPECS, type NodeKind, nodeSubtitle } from "./nodeTypes";

export interface PipelineNodeData extends Record<string, unknown> {
	kind: NodeKind;
	name: string;
	description: string | null;
	config: Record<string, unknown>;
	/** Worst validation severity attached to this node, if any. */
	issue: "error" | "warning" | null;
	issueCount: number;
	/** Outcome of the most recent run, when there has been one. */
	runStatus: "success" | "failed" | "skipped" | null;
	runRecords: number | null;
	collapsed: boolean;
}

function statusLabel(data: PipelineNodeData): { text: string; tone: string } {
	if (data.issue === "error") {
		return {
			text: data.issueCount > 1 ? `${data.issueCount} errors` : "Invalid",
			tone: "error",
		};
	}
	if (data.issue === "warning") {
		return {
			text: data.issueCount > 1 ? `${data.issueCount} warnings` : "Warning",
			tone: "warn",
		};
	}
	if (data.runStatus === "skipped") return { text: "Size unknown", tone: "warn" };
	if (data.runStatus === "success") return { text: "Ran", tone: "ok" };
	return { text: "Valid", tone: "ok" };
}

export function PipelineNodeCard({ data, selected }: NodeProps) {
	const node = data as PipelineNodeData;
	const spec = NODE_SPECS[node.kind];
	const status = statusLabel(node);
	const subtitle = nodeSubtitle(node.kind, node.config ?? {});

	// A data source has no upstream, so it is drawn without an input port
	// rather than with one that can never legally be connected.
	const hasInput = node.kind !== "dataSource";

	return (
		<div
			className={`pnode pnode-${spec.group} ${selected ? "is-selected" : ""} ${
				node.issue ? `has-${node.issue}` : ""
			}`}
			style={{ ["--node-accent" as string]: spec.accent }}
		>
			{hasInput && <Handle type="target" position={Position.Left} className="pnode-port" />}

			<div className="pnode-head">
				<span className="pnode-glyph" aria-hidden>
					{spec.glyph}
				</span>
				<span className="pnode-kind">{spec.label.toUpperCase()}</span>
				{node.issue && (
					<span className={`pnode-flag ${node.issue}`} aria-label={`${node.issue}s on this node`}>
						{node.issue === "error" ? "✕" : "⚠"}
					</span>
				)}
			</div>

			<div className="pnode-name" title={node.name}>
				{node.name}
			</div>

			{!node.collapsed && subtitle.length > 0 && (
				<div className="pnode-meta">
					{subtitle.map((line) => (
						<div className="pnode-meta-line mono" key={line} title={line}>
							{line}
						</div>
					))}
				</div>
			)}

			{!node.collapsed && node.runRecords !== null && (
				<div className="pnode-records mono">
					{node.runRecords.toLocaleString("en-US")} rows
				</div>
			)}

			<div className="pnode-foot">
				<span className={`pnode-status ${status.tone}`}>
					<span className="pnode-dot" aria-hidden />
					{status.text}
				</span>
			</div>

			<Handle type="source" position={Position.Right} className="pnode-port" />
		</div>
	);
}
