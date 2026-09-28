/**
 * Eval suites: the regression contract for the things that compute.
 *
 * Two kinds share this page because a suite is a suite whatever it tests:
 * a FUNCTION suite asserts properties of what a metric's SQL returns, and an
 * ASSISTANT suite asserts properties of the turn the live agent produces
 * (tools used, caveats owed, bounds on rounds and cost). Both are evaluated
 * deterministically - no LLM judge - so a passing score means the same thing
 * twice.
 *
 * Case specs are written as JSON rather than a bespoke form: the assertions
 * are a developer-facing contract, and a textarea that validates server-side
 * beats a form that can only express half the shape.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Empty, ErrorBanner, Spinner } from "../components/common";

interface SuiteSummary {
	eval_suite_id: number;
	name: string;
	target_kind: "function" | "assistant";
	target_ref: string;
	description: string | null;
	created_by: string;
	case_count: number;
	run_count: number;
}

interface SuiteDetail extends SuiteSummary {
	cases: Array<{ eval_case_id: number; name: string; spec: Record<string, unknown>; ordinal: number }>;
}

interface CaseOutcome {
	case: string;
	ok: boolean;
	assertions?: Array<{ kind: string; ok: boolean; detail: string }>;
	evaluators?: Array<{ kind: string; ok: boolean; detail: string }>;
	error?: string;
	rounds?: number;
	latencyMs?: number;
}

interface SuiteRun {
	eval_run_id: number;
	started_by: string;
	status: string;
	passed: number;
	failed: number;
	total: number;
	detail: CaseOutcome[];
	started_at: string;
	total_tokens?: number | null;
}

const FUNCTION_TEMPLATE = `[
  {
    "name": "Order count is plausible",
    "assertions": [
      { "kind": "between", "min": 1, "max": 100000 },
      { "kind": "not_null" }
    ]
  }
]`;

const ASSISTANT_TEMPLATE = `[
  {
    "name": "Answers a volume question from the catalogue",
    "spec": {
      "prompt": "How many orders are unplanned, and how much weight is sitting in them?",
      "evaluators": [
        { "kind": "tool_used", "name": "execute_kpi" },
        { "kind": "reply_contains", "text": "order" },
        { "kind": "max_rounds", "value": 6 },
        { "kind": "max_tokens", "value": 4000 }
      ]
    }
  }
]`;

export function Evals() {
	const [suites, setSuites] = useState<SuiteSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [detail, setDetail] = useState<SuiteDetail | null>(null);
	const [runs, setRuns] = useState<SuiteRun[] | null>(null);
	const [creating, setCreating] = useState(false);

	const load = useCallback(() => {
		setSuites(null);
		Promise.all([
			api.get<SuiteSummary[]>("/api/evals/suites").catch(() => []),
			api.get<{ suites: SuiteSummary[] }>("/api/assistant/evals/suites").then((r) => r.suites),
		])
			.then(([fnSuites, assistantSuites]) =>
				setSuites(
					[...fnSuites, ...assistantSuites].sort((a, b) =>
						a.target_kind === b.target_kind
							? a.name.localeCompare(b.name)
							: a.target_kind === "function"
								? -1
								: 1,
					),
				),
			)
			.catch((exc: Error) => setError(exc.message));
	}, []);
	useEffect(load, [load]);

	useEffect(() => {
		if (!detail) {
			setRuns(null);
			return;
		}
		const path =
			detail.target_kind === "function"
				? `/api/evals/suites/${detail.eval_suite_id}/runs`
				: `/api/assistant/evals/suites/${detail.eval_suite_id}/runs`;
		api
			.get<{ runs: SuiteRun[] } | SuiteRun[]>(path)
			.then((payload) => setRuns(Array.isArray(payload) ? payload : payload.runs))
			.catch(() => setRuns([]));
	}, [detail]);

	async function runSuite(suite: SuiteSummary) {
		setError(null);
		const path =
			suite.target_kind === "function"
				? `/api/evals/suites/${suite.eval_suite_id}/run`
				: `/api/assistant/evals/suites/${suite.eval_suite_id}/run`;
		try {
			await api.post(path);
			// Opening the panel fetches the run history, which already includes
			// this run - one shape to render, wherever the run came from.
			setDetail({ ...suite, cases: [] });
		} catch (exc) {
			setError((exc as Error).message);
		}
	}

	async function removeSuite(suite: SuiteSummary) {
		setError(null);
		const path =
			suite.target_kind === "function"
				? `/api/evals/suites/${suite.eval_suite_id}`
				: `/api/assistant/evals/suites/${suite.eval_suite_id}`;
		try {
			await api.del(path);
			if (detail?.eval_suite_id === suite.eval_suite_id) setDetail(null);
			load();
		} catch (exc) {
			setError((exc as Error).message);
		}
	}

	if (error && !suites) return <ErrorBanner error={error} onRetry={load} />;
	if (!suites) return <Spinner label="Loading eval suites" />;

	return (
		<div className="col" style={{ gap: 12 }}>
			{error && <ErrorBanner error={error} onRetry={load} />}

			<div className="card">
				<div className="card-head">
					<h3>Eval suites</h3>
					<span className="sub">
						test cases with deterministic evaluators — a score means the same thing twice
					</span>
					<button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
						New suite
					</button>
				</div>
				{suites.length === 0 ? (
					<Empty>
						<p>
							<strong>No suites yet.</strong> Write the properties a function or an assistant
							answer must keep, and run them whenever the thing underneath changes.
						</p>
					</Empty>
				) : (
					<div className="col" style={{ gap: 6 }}>
						{suites.map((suite) => (
							<div key={`${suite.target_kind}-${suite.eval_suite_id}`} className="row" style={{ gap: 10, alignItems: "center", padding: "6px 0" }}>
								<span className={`chip ${suite.target_kind === "function" ? "" : "info"}`}>
									{suite.target_kind}
								</span>
								<strong>{suite.name}</strong>
								<span className="mono muted">{suite.target_ref}</span>
								<span className="muted">
									{suite.case_count} case{suite.case_count === 1 ? "" : "s"} · {suite.run_count} run
									{suite.run_count === 1 ? "" : "s"}
								</span>
								<div className="row" style={{ gap: 6, marginLeft: "auto" }}>
									<button className="btn sm" onClick={() => setDetail({ ...suite, cases: [] })}>
										Detail
									</button>
									<button className="btn sm primary" onClick={() => runSuite(suite)}>
										Run
									</button>
									<button className="btn sm danger" onClick={() => removeSuite(suite)}>
										Delete
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{detail && (
				<SuitePanel
					detail={detail}
					runs={runs}
					onClose={() => setDetail(null)}
				/>
			)}

			{creating && (
				<CreateDialog
					onClose={() => setCreating(false)}
					onCreated={() => {
						setCreating(false);
						load();
					}}
				/>
			)}
		</div>
	);
}

function SuitePanel({
	detail,
	runs,
	onClose,
}: {
	detail: SuiteDetail;
	runs: SuiteRun[] | null;
	onClose: () => void;
}) {
	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="rp" role="dialog" aria-label={detail.name}>
				<header className="rp-head">
					<div className="rp-heading">
						<div className="rp-kind">{detail.target_kind.toUpperCase()} EVAL SUITE</div>
						<h2 className="rp-title">{detail.name}</h2>
					</div>
					<button className="btn sm" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				<div className="rp-body col" style={{ gap: 12 }}>
					{detail.description && <p className="muted">{detail.description}</p>}
					{runs === null ? (
						<Spinner label="Loading runs" />
					) : runs.length === 0 ? (
						<p className="muted">It has never been run.</p>
					) : (
						runs.map((run) => (
							<div key={run.eval_run_id} className="card" style={{ padding: 12 }}>
								<div className="row" style={{ gap: 8 }}>
									<span className={`chip ${run.failed === 0 ? "good" : "bad"}`}>
										{run.passed}/{run.total} passed
									</span>
									<span className="muted">
										{new Date(run.started_at).toLocaleString("en-US")} · by {run.started_by}
									</span>
									{run.total_tokens ? (
										<span className="muted">{run.total_tokens.toLocaleString("en-US")} tokens</span>
									) : null}
								</div>
								<div className="col" style={{ gap: 6, marginTop: 8 }}>
									{(run.detail ?? []).map((outcome, index) => (
										<div key={index} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
											<span className={`chip ${outcome.ok ? "good" : "bad"}`}>
												{outcome.ok ? "pass" : "fail"}
											</span>
											<div className="col" style={{ gap: 2 }}>
												<strong>{outcome.case}</strong>
												{outcome.error && <span className="muted">{outcome.error}</span>}
												{(outcome.assertions ?? outcome.evaluators ?? []).map((assertion, i) => (
													<span key={i} className={assertion.ok ? "" : "muted"} style={{ fontSize: 12 }}>
														{assertion.ok ? "✓" : "✗"} {assertion.kind}: {assertion.detail}
													</span>
												))}
												{outcome.rounds !== undefined && (
													<span className="muted" style={{ fontSize: 12 }}>
														{outcome.rounds} rounds · {outcome.latencyMs} ms
													</span>
												)}
											</div>
										</div>
									))}
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}

function CreateDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => void;
}) {
	const [kind, setKind] = useState<"function" | "assistant">("function");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [targetRef, setTargetRef] = useState("");
	const [casesJson, setCasesJson] = useState(FUNCTION_TEMPLATE);
	const [functions, setFunctions] = useState<Array<{ apiName: string; name: string; status: string }>>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (kind !== "function") return;
		api
			.get<Array<{ apiName: string; name: string; status: string }>>("/api/functions")
			.then(setFunctions)
			.catch(() => setFunctions([]));
	}, [kind]);

	useEffect(() => {
		setCasesJson(kind === "function" ? FUNCTION_TEMPLATE : ASSISTANT_TEMPLATE);
	}, [kind]);

	async function create() {
		setBusy(true);
		setError(null);
		try {
			const cases = JSON.parse(casesJson);
			const path = kind === "function" ? "/api/evals/suites" : "/api/assistant/evals/suites";
			await api.post(path, { name: name.trim(), description: description.trim(), targetRef: kind === "function" ? targetRef : "assistant", cases });
			onCreated();
		} catch (exc) {
			// A malformed JSON blob is the caller's typo; the server's refusal is
			// the contract talking. Both land here as one message.
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="rp" role="dialog" aria-label="New eval suite" style={{ maxWidth: 640 }}>
				<header className="rp-head">
					<div className="rp-heading">
						<div className="rp-kind">EVAL SUITE</div>
						<h2 className="rp-title">New suite</h2>
					</div>
					<button className="btn sm" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				<div className="rp-body col" style={{ gap: 10 }}>
					<div className="row" style={{ gap: 10 }}>
						<label className="col" style={{ gap: 4, flex: 1 }}>
							<span className="muted">Name</span>
							<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Order metrics still hold" />
						</label>
						<label className="col" style={{ gap: 4 }}>
							<span className="muted">Tests</span>
							<select value={kind} onChange={(e) => setKind(e.target.value as "function" | "assistant")}>
								<option value="function">A metric function</option>
								<option value="assistant">The assistant</option>
							</select>
						</label>
					</div>
					{kind === "function" && (
						<label className="col" style={{ gap: 4 }}>
							<span className="muted">Function under test</span>
							<select value={targetRef} onChange={(e) => setTargetRef(e.target.value)}>
								<option value="">Choose a function…</option>
								{functions.map((fn) => (
									<option key={fn.apiName} value={fn.apiName}>
										{fn.name} ({fn.status})
									</option>
								))}
							</select>
						</label>
					)}
					<label className="col" style={{ gap: 4 }}>
						<span className="muted">Description</span>
						<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What must stay true" />
					</label>
					<label className="col" style={{ gap: 4 }}>
						<span className="muted">Cases (JSON — the template shows the shape each kind expects)</span>
						<textarea
							value={casesJson}
							onChange={(e) => setCasesJson(e.target.value)}
							rows={12}
							spellCheck={false}
							className="mono"
							style={{ fontSize: 12, fontFamily: "inherit" }}
						/>
					</label>
					{error && <ErrorBanner error={error} onRetry={create} />}
					<div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
						<button className="btn" onClick={onClose}>
							Cancel
						</button>
						<button className="btn primary" disabled={busy || !name.trim() || (kind === "function" && !targetRef)} onClick={create}>
							Create suite
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
