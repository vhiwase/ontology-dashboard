/**
 * One proposed change to the ontology, with the evidence to decide on it.
 *
 * Used in the approvals inbox, on the home page and inline in a conversation,
 * so a person can approve where they read about it. Each kind shows what was
 * MEASURED when it was drafted - how many rows a link resolves, the headline a
 * metric would show, sample rows of a combined dataset - because "approve"
 * should be a decision about evidence, not about a description.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import {
	type ProposalKind,
	type ProposalRecord,
	api,
	builtBoard,
	formatCell,
	formatValue,
} from "../api";
import { Icon, type IconName } from "./icons";

const KIND: Record<ProposalKind, { label: string; icon: IconName; tone: string }> = {
	link_type: { label: "Link", icon: "link", tone: "series-3" },
	combination: { label: "Dataset", icon: "table", tone: "series-1" },
	metric: { label: "Metric", icon: "sigma", tone: "series-7" },
	action_type: { label: "Action", icon: "zap", tone: "series-2" },
};

export function proposalKindLabel(kind: ProposalKind): string {
	return KIND[kind]?.label ?? kind;
}

export function ProposalCard({
	proposal: initial,
	onSettled,
	onDelete,
	compact = false,
}: {
	proposal: ProposalRecord;
	/** Called with every proposal the decision settled (dependencies included). */
	onSettled?: (settled: ProposalRecord[]) => void;
	/**
	 * Asks for the proposal to be deleted. Given only by the approvals inbox,
	 * which is where the record is kept; a card inside a conversation or on the
	 * home page offers the decision, not the removal of the record.
	 */
	onDelete?: (proposal: ProposalRecord) => void;
	compact?: boolean;
}) {
	const [proposal, setProposal] = useState(initial);
	const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showDetail, setShowDetail] = useState(!compact);
	const kind = KIND[proposal.kind] ?? { label: proposal.kind, icon: "box" as IconName, tone: "series-1" };
	const built = builtBoard(proposal);
	const buildError =
		proposal.result?.built && "error" in proposal.result.built ? String(proposal.result.built.error) : null;

	async function decide(action: "approve" | "reject") {
		setBusy(action);
		setError(null);
		try {
			if (action === "approve") {
				const settled = await api.post<ProposalRecord[]>(`/api/proposals/${proposal.id}/approve`, {});
				const self = settled.find((entry) => entry.id === proposal.id);
				if (self) setProposal(self);
				onSettled?.(settled);
			} else {
				const rejected = await api.post<ProposalRecord>(`/api/proposals/${proposal.id}/reject`, {});
				setProposal(rejected);
				onSettled?.([rejected]);
			}
		} catch (exc) {
			setError((exc as Error).message);
			// A failed apply is recorded on the proposal; show its new state.
			api
				.get<ProposalRecord>(`/api/proposals/${proposal.id}`)
				.then(setProposal)
				.catch(() => {});
		} finally {
			setBusy(null);
		}
	}

	const pending = proposal.status === "pending" || proposal.status === "failed";

	return (
		<article className={`proposal-card status-${proposal.status}`}>
			<div className="proposal-head">
				<span className="proposal-glyph" style={{ color: `var(--${kind.tone})` }} aria-hidden>
					<Icon name={kind.icon} size={18} />
				</span>
				<div className="proposal-title">
					<div className="row" style={{ gap: 6 }}>
						<span className="chip">{kind.label}</span>
						<StatusChip status={proposal.status} />
						{proposal.createdVia !== "user" && (
							<span className="chip accent">
								<Icon name="sparkles" size={11} /> drafted by the assistant
							</span>
						)}
					</div>
					<h4>{proposal.title}</h4>
				</div>
				{(pending || onDelete) && (
					<div className="proposal-actions">
						{pending && (
							<button className="btn primary" disabled={busy !== null} onClick={() => void decide("approve")}>
								{busy === "approve" ? <span className="spinner" aria-hidden /> : <Icon name="check" size={15} />}
								{busy === "approve" ? "Applying…" : proposal.status === "failed" ? "Retry" : "Approve"}
							</button>
						)}
						{proposal.status === "pending" && (
							<button className="btn ghost" disabled={busy !== null} onClick={() => void decide("reject")}>
								{busy === "reject" ? "Rejecting…" : "Reject"}
							</button>
						)}
						{onDelete && (
							<button
								className="icon-btn row-delete"
								disabled={busy !== null}
								onClick={() => onDelete(proposal)}
								title={`Delete the proposal ${proposal.title}`}
								aria-label={`Delete the proposal ${proposal.title}`}
							>
								<Icon name="trash" size={14} />
							</button>
						)}
					</div>
				)}
			</div>

			{proposal.summary && <p className="proposal-summary">{proposal.summary}</p>}

			{proposal.followUp && pending && (
				<p className="proposal-followup">
					<Icon name="sparkles" size={13} /> Approving it also builds the {proposal.followUp.build}{" "}
					<strong>{proposal.followUp.title}</strong>.
				</p>
			)}

			{proposal.dependsOn.length > 0 && pending && (
				<p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
					Applies {proposal.dependsOn.length === 1 ? "proposal" : "proposals"}{" "}
					{proposal.dependsOn.map((id) => `#${id}`).join(", ")} first.
				</p>
			)}

			{compact && (
				<button className="link-button" onClick={() => setShowDetail((value) => !value)}>
					{showDetail ? "Hide the evidence" : "Show the evidence"}
				</button>
			)}
			{showDetail && <Evidence proposal={proposal} />}

			{proposal.status === "applied" && (
				<div className="proposal-outcome">
					<span aria-hidden>
						<Icon name="checkCircle" size={16} />
					</span>
					<span>
						Applied{proposal.decidedBy ? ` by ${proposal.decidedBy}` : ""}.
						{proposal.kind === "combination" && proposal.result?.objectType
							? ` ${String(proposal.result.objectType)} is now part of your model.`
							: ""}
						{proposal.kind === "link_type" && " The link is in your model and can be followed and charted."}
						{proposal.kind === "metric" && " The metric can be charted and put on dashboards."}
						{proposal.kind === "action_type" && " The action is available on its objects."}
					</span>
					{built && (
						<Link className="btn sm primary" to={`/dashboards/${built.slug}`} style={{ marginLeft: "auto" }}>
							Open {built.kind} “{built.title}”
							<Icon name="arrowRight" size={13} />
						</Link>
					)}
				</div>
			)}
			{buildError && (
				<div className="banner warn" style={{ marginTop: 8 }}>
					The change was applied, but the board could not be built: {buildError}
				</div>
			)}
			{proposal.status === "failed" && proposal.error && (
				<div className="banner error" style={{ marginTop: 8 }}>
					Could not be applied: {proposal.error}
				</div>
			)}
			{proposal.status === "rejected" && (
				<p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
					Rejected{proposal.decidedBy ? ` by ${proposal.decidedBy}` : ""}. Nothing was changed.
				</p>
			)}
			{error && proposal.status !== "failed" && (
				<div className="banner error" style={{ marginTop: 8 }}>
					{error}
				</div>
			)}
		</article>
	);
}

function StatusChip({ status }: { status: ProposalRecord["status"] }) {
	const tone = status === "applied" ? "good" : status === "failed" ? "critical" : status === "rejected" ? "" : "warning";
	const label = status === "pending" ? "waiting for approval" : status;
	return (
		<span className={`chip ${tone}`}>
			<span className="dot" aria-hidden />
			{label}
		</span>
	);
}

/** What was measured when the proposal was drafted. */
function Evidence({ proposal }: { proposal: ProposalRecord }) {
	const preview = proposal.preview ?? {};
	if (preview.deferred) {
		return (
			<p className="muted proposal-evidence">
				Checked against the data once the proposals it depends on are applied.
			</p>
		);
	}

	if (proposal.kind === "link_type") {
		const ratio = Number(preview.matchRatio ?? 0);
		return (
			<div className="proposal-evidence">
				<div className="meter" aria-label={`${(ratio * 100).toFixed(1)}% of rows resolve`}>
					<div className="meter-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
				</div>
				<p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
					{Number(preview.matched ?? 0).toLocaleString("en-US")} of{" "}
					{Number(preview.candidates ?? 0).toLocaleString("en-US")} rows resolve ·{" "}
					{String(preview.cardinality ?? "").replace("_", "-").toLowerCase()}
				</p>
				{Boolean(preview.warning) && <p className="field-hint warn">{String(preview.warning)}</p>}
			</div>
		);
	}

	if (proposal.kind === "metric") {
		return (
			<div className="proposal-evidence">
				<span className="muted" style={{ fontSize: 12 }}>
					It would show today:
				</span>{" "}
				<strong className="num" style={{ fontSize: 18 }}>
					{formatValue(preview.total as number | null, String(preview.format ?? "number"), (preview.unit as string) ?? null)}
				</strong>
			</div>
		);
	}

	if (proposal.kind === "combination") {
		const columns = (preview.columns as string[]) ?? [];
		const sample = (preview.sample as Array<Record<string, unknown>>) ?? [];
		const shown = columns.slice(0, 9);
		return (
			<div className="proposal-evidence">
				<p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
					{Number(preview.rowCount ?? 0).toLocaleString("en-US")} rows · {columns.length} columns · a view over your
					synced tables (nothing in your database changes)
				</p>
				{sample.length > 0 && (
					<div className="table-wrap" style={{ maxHeight: 200, overflowY: "auto" }}>
						<table className="data compact">
							<thead>
								<tr>
									{shown.map((column) => (
										<th key={column}>{column}</th>
									))}
									{columns.length > shown.length && <th>+{columns.length - shown.length} more</th>}
								</tr>
							</thead>
							<tbody>
								{sample.map((row, index) => (
									<tr key={index}>
										{shown.map((column) => (
											<td key={column}>{formatCell(row[column])}</td>
										))}
										{columns.length > shown.length && <td />}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		);
	}

	if (proposal.kind === "action_type") {
		const parameters = (preview.parameters as Array<{ name: string; label: string; type: string }>) ?? [];
		return (
			<div className="proposal-evidence">
				<p className="muted" style={{ margin: "0 0 4px", fontSize: 12 }}>
					Runs on {String(preview.targetType ?? "")} with:
				</p>
				<div className="row" style={{ gap: 5 }}>
					{parameters.map((parameter) => (
						<span key={parameter.name} className="chip mono">
							{parameter.label} · {parameter.type}
						</span>
					))}
				</div>
			</div>
		);
	}
	return null;
}
