/**
 * Functions: metrics that exist because someone approved them.
 *
 * The list leads with proposals, because a proposal is the only thing here
 * that is waiting on a person. An active function is finished work; a proposal
 * is a question addressed to whoever opens this page.
 */

import { useCallback, useEffect, useState } from "react";
import { type FunctionRecord, type FunctionRun, api, isMissingOntology } from "../api";
import { useSpace } from "../SpaceContext";
import { FunctionReview } from "../components/functions/FunctionReview";
import { DataTable, Empty, ErrorBanner, NoOntologyHere, Spinner } from "../components/common";

const STATUS_TONE: Record<string, string> = {
	proposed: "warn",
	active: "good",
	rejected: "bad",
	archived: "",
};

export function Functions() {
	const [functions, setFunctions] = useState<FunctionRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [missing, setMissing] = useState(false);
	const [open, setOpen] = useState<string | null>(null);
	const [selected, setSelected] = useState<FunctionRecord | null>(null);
	const [runs, setRuns] = useState<FunctionRun[] | null>(null);
	const { spaceSlug, space } = useSpace();

	const load = useCallback(() => {
		setFunctions(null);
		setError(null);
		setMissing(false);
		api
			.get<FunctionRecord[]>("/api/functions")
			.then(setFunctions)
			.catch((exc: Error) =>
				isMissingOntology(exc) ? setMissing(true) : setError(exc.message),
			);
	}, []);

	// Functions read the ontology's views, so they belong to a space like
	// everything else published.
	useEffect(load, [load, spaceSlug]);

	useEffect(() => {
		if (!selected) {
			setRuns(null);
			return;
		}
		setRuns(null);
		api
			.get<FunctionRun[]>(`/api/functions/${selected.apiName}/runs`)
			.then(setRuns)
			.catch(() => setRuns([]));
	}, [selected]);

	if (missing)
		return <NoOntologyHere what="functions" spaceName={space?.name ?? spaceSlug} />;
	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!functions) return <Spinner label="Loading functions" />;

	const proposals = functions.filter((f) => f.status === "proposed");

	return (
		<div className="col" style={{ gap: 12 }}>
			{proposals.length > 0 && (
				<div className="card">
					<div className="card-head">
						<h3>Waiting for approval</h3>
						<span className="sub">
							{proposals.length} proposed {proposals.length === 1 ? "metric" : "metrics"} — each
							computes nothing until approved
						</span>
					</div>
					<div className="col" style={{ gap: 6 }}>
						{proposals.map((fn) => (
							<button
								key={fn.apiName}
								className="fn-proposal-row"
								onClick={() => setOpen(fn.apiName)}
							>
								<span className="fn-proposal-name">{fn.name}</span>
								<span className="muted">{fn.description ?? "No description."}</span>
								<span className="chip warn">review</span>
							</button>
						))}
					</div>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>Functions</h3>
					<span className="sub">
						computations over the ontology, each approved by a person
					</span>
				</div>

				{functions.length === 0 ? (
					<Empty>
						No functions yet. Ask the assistant for a metric the KPI catalogue does not
						have and it will draft one for you to approve.
					</Empty>
				) : (
					<table className="dense">
						<thead>
							<tr>
								<th>Name</th>
								<th>API name</th>
								<th>Returns</th>
								<th>Language</th>
								<th>Status</th>
								<th>Proposed by</th>
								<th>Approved by</th>
							</tr>
						</thead>
						<tbody>
							{functions.map((fn) => (
								<tr
									key={fn.apiName}
									className={selected?.apiName === fn.apiName ? "active" : ""}
									onClick={() => setSelected(fn)}
								>
									<td>
										<button className="link-button" onClick={() => setOpen(fn.apiName)}>
											{fn.name}
										</button>
									</td>
									<td className="mono">{fn.apiName}</td>
									<td className="mono">{fn.returns}</td>
									<td className="mono">
										{fn.language}
										{!fn.isExecutable && (
											<span className="chip" title={fn.notExecutableReason ?? ""}>
												not run here
											</span>
										)}
									</td>
									<td>
										<span className={`chip ${STATUS_TONE[fn.status] ?? ""}`}>{fn.status}</span>
									</td>
									<td className="muted">{fn.proposedBy}</td>
									<td className="muted">{fn.approvedBy ?? "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{selected && (
				<div className="card">
					<div className="card-head">
						<h3>{selected.name} · execution history</h3>
						<span className="sub">every time this function produced a number</span>
					</div>
					{!runs ? (
						<Spinner label="Loading runs" />
					) : runs.length === 0 ? (
						<Empty>This function has not been run yet.</Empty>
					) : (
						<DataTable
							columns={[
								{ key: "id", label: "Run" },
								{ key: "version", label: "Version" },
								{ key: "status", label: "Status" },
								{ key: "rowCount", label: "Rows", numeric: true },
								{ key: "durationMs", label: "Duration (ms)", numeric: true },
								{ key: "triggeredBy", label: "By" },
								{ key: "startedAt", label: "Started" },
							]}
							rows={runs as unknown as Array<Record<string, unknown>>}
						/>
					)}
				</div>
			)}

			<FunctionReview
				apiName={open}
				onClose={() => {
					setOpen(null);
					load();
				}}
				onApproved={() => load()}
			/>
		</div>
	);
}
