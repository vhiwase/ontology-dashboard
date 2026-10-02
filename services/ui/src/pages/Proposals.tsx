/**
 * Approvals: every change waiting on a decision, and every decision made.
 *
 * The assistant (and the feasibility check behind it) can draft a link, a
 * combined dataset, a metric or an action, but cannot apply one. This page is
 * where a person does - with the evidence for each beside the buttons.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type ProposalRecord, type ProposalStatus, api } from "../api";
import { ProposalCard } from "../components/ProposalCard";
import { ErrorBanner, Spinner } from "../components/common";
import { useSpace } from "../SpaceContext";

const TABS: Array<{ id: ProposalStatus | "all"; label: string }> = [
	{ id: "pending", label: "Waiting" },
	{ id: "applied", label: "Applied" },
	{ id: "failed", label: "Failed" },
	{ id: "rejected", label: "Rejected" },
	{ id: "all", label: "All" },
];

export function Proposals() {
	const { spaceSlug, reload } = useSpace();
	const [proposals, setProposals] = useState<ProposalRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<ProposalStatus | "all">("pending");

	const load = () => {
		setError(null);
		api
			.get<ProposalRecord[]>("/api/proposals")
			.then(setProposals)
			.catch((exc: Error) => setError(exc.message));
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload per space
	useEffect(load, [spaceSlug]);

	const counts = useMemo(() => {
		const out: Record<string, number> = { all: proposals?.length ?? 0 };
		for (const proposal of proposals ?? []) out[proposal.status] = (out[proposal.status] ?? 0) + 1;
		return out;
	}, [proposals]);

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!proposals) return <Spinner label="Loading approvals" />;

	const visible = tab === "all" ? proposals : proposals.filter((proposal) => proposal.status === tab);

	return (
		<div className="page">
			<header className="page-head">
				<div>
					<h1>Approvals</h1>
					<p className="page-lede">
						Links, combined datasets, metrics and actions proposed for your model. Nothing is applied
						until you approve it, and each shows what was measured when it was drafted.
					</p>
				</div>
				<Link className="btn" to="/assistant">
					Ask for something new
				</Link>
			</header>

			<div className="tabs" role="tablist">
				{TABS.map((item) => (
					<button
						key={item.id}
						role="tab"
						aria-selected={tab === item.id}
						className={tab === item.id ? "active" : ""}
						onClick={() => setTab(item.id)}
					>
						{item.label}
						{(counts[item.id] ?? 0) > 0 && <span className="tab-count">{counts[item.id]}</span>}
					</button>
				))}
			</div>

			{visible.length === 0 ? (
				<div className="empty-state">
					<div className="empty-state-mark" aria-hidden>
						✓
					</div>
					<h3>{tab === "pending" ? "Nothing is waiting for you" : "Nothing here yet"}</h3>
					<p>
						Ask the assistant for a chart or a dashboard your data cannot answer yet - "revenue by customer
						country", "build me a sales dashboard" - and the change it needs appears here for approval.
					</p>
				</div>
			) : (
				<div className="col" style={{ gap: 12 }}>
					{visible.map((proposal) => (
						<ProposalCard
							key={`${proposal.id}-${proposal.status}`}
							proposal={proposal}
							onSettled={(settled) => {
								// Dependencies settle too; fold every one back into the list.
								setProposals((current) =>
									(current ?? []).map((item) => settled.find((entry) => entry.id === item.id) ?? item),
								);
								// The model changed: badges and counts elsewhere re-read.
								reload();
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}
