/**
 * Cost analysis for the assistant.
 *
 * Tokens were metered for the rate limiter but never priced, so "what is this
 * costing us" had no answer. This is that answer, with the rates alongside it
 * so the numbers can be checked rather than taken on trust.
 *
 * Turns made before pricing existed, or by a provider with no configured rate,
 * are counted as UNPRICED rather than as zero — a gap that flatters the total
 * is worse than a gap that is visible.
 */

import { useCallback, useEffect, useState } from "react";
import { api, session } from "../api";
import { ErrorBanner, Spinner } from "../components/common";
import { useSpace } from "../SpaceContext";

interface Totals {
	total_cost: number;
	total_tokens: number;
	prompt_tokens: number;
	completion_tokens: number;
	turns: number;
	unpriced_turns: number;
}

interface ModelRow {
	provider: string;
	model: string;
	turns: number;
	tokens: number;
	cost: number;
}

interface DayRow {
	day: string;
	turns: number;
	tokens: number;
	cost: number;
}

interface UserRow {
	username: string;
	turns: number;
	tokens: number;
	cost: number;
}

interface Rates {
	[provider: string]: {
		inputPerMillion: number;
		outputPerMillion: number;
		source: string;
	};
}

interface Summary {
	windowDays: number;
	scope: string;
	totals: Totals;
	byModel: ModelRow[];
	byDay: DayRow[];
	byUser: UserRow[];
	rates: Rates;
}

/** Sub-cent costs are normal here, so the unit follows the magnitude. */
function usd(value: number): string {
	if (value === 0) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(6)}`;
	if (value < 1) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

export function CostAnalysis() {
	const [days, setDays] = useState(30);
	const [summary, setSummary] = useState<Summary | null>(null);
	const [error, setError] = useState<string | null>(null);

	const { spaceSlug } = useSpace();
	const role = session.user()?.role ?? "viewer";

	const load = useCallback(() => {
		setError(null);
		api
			.get<Summary>(`/api/assistant/costs?days=${days}&space=${spaceSlug}`)
			.then(setSummary)
			.catch((exc: Error) => setError(exc.message));
	}, [days, spaceSlug]);

	useEffect(load, [load]);

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!summary) return <Spinner label="Loading cost analysis" />;

	const { totals } = summary;
	const peak = Math.max(1, ...summary.byDay.map((row) => row.cost));
	const avgPerTurn = totals.turns > 0 ? totals.total_cost / totals.turns : 0;

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3>Assistant cost</h3>
					<span className="sub">
						{summary.scope === "everyone" ? "all users" : `your usage (${summary.scope})`}
					</span>
					<div className="row" style={{ gap: 4, marginLeft: 10 }}>
						{[7, 30, 90].map((window) => (
							<button
								key={window}
								className={`btn sm ${days === window ? "primary" : ""}`}
								onClick={() => setDays(window)}
							>
								{window}d
							</button>
						))}
					</div>
				</div>

				<div className="cost-tiles">
					<div className="cost-tile">
						<div className="cost-value">{usd(totals.total_cost)}</div>
						<div className="cost-label">Total spend</div>
					</div>
					<div className="cost-tile">
						<div className="cost-value">{totals.total_tokens.toLocaleString("en-US")}</div>
						<div className="cost-label">Tokens</div>
					</div>
					<div className="cost-tile">
						<div className="cost-value">{totals.turns.toLocaleString("en-US")}</div>
						<div className="cost-label">Turns</div>
					</div>
					<div className="cost-tile">
						<div className="cost-value">{usd(avgPerTurn)}</div>
						<div className="cost-label">Average per turn</div>
					</div>
				</div>

				{totals.unpriced_turns > 0 && (
					<div className="banner warn" style={{ marginTop: 10 }}>
						<strong>{totals.unpriced_turns}</strong> of {totals.turns} turns are{" "}
						<strong>unpriced</strong> — they ran before a rate was recorded against them, so
						their model is known but the price that applied is not. Pricing them at today's
						rate would be a guess, so their tokens count towards the totals above and their
						cost does not: the spend figure is a floor, not a complete total.
					</div>
				)}
			</div>

			<div className="card">
				<div className="card-head">
					<h3>By model</h3>
				</div>
				<table className="dense">
					<thead>
						<tr>
							<th>Provider</th>
							<th>Model</th>
							<th>Turns</th>
							<th>Tokens</th>
							<th>Cost</th>
							<th>Per turn</th>
						</tr>
					</thead>
					<tbody>
						{summary.byModel.map((row) => (
							<tr key={`${row.provider}-${row.model}`}>
								<td>{row.provider}</td>
								<td className="mono">{row.model}</td>
								<td className="mono">{row.turns.toLocaleString("en-US")}</td>
								<td className="mono">{row.tokens.toLocaleString("en-US")}</td>
								<td className="mono">{usd(row.cost)}</td>
								<td className="mono muted">
									{row.turns > 0 ? usd(row.cost / row.turns) : "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div className="card">
				<div className="card-head">
					<h3>Daily</h3>
					<span className="sub">
						{summary.byDay.length} day{summary.byDay.length === 1 ? "" : "s"} with activity
					</span>
				</div>
				{summary.byDay.length === 0 ? (
					<p className="muted">No assistant activity in this window.</p>
				) : (
					<div className="cost-bars">
						{summary.byDay.map((row) => (
							<div className="cost-bar-row" key={row.day}>
								<span className="cost-bar-day mono">{row.day.slice(5)}</span>
								<div className="cost-bar-track">
									{/* Width is proportional to the peak day, and the value is
									    printed beside it, so the bar never has to be read
									    precisely to get the number. */}
									<div
										className="cost-bar-fill"
										style={{ width: `${Math.max(2, (row.cost / peak) * 100)}%` }}
									/>
								</div>
								<span className="cost-bar-value mono">{usd(row.cost)}</span>
								<span className="cost-bar-meta muted">
									{row.turns} turns · {row.tokens.toLocaleString("en-US")} tokens
								</span>
							</div>
						))}
					</div>
				)}
			</div>

			{role === "admin" && summary.byUser.length > 0 && (
				<div className="card">
					<div className="card-head">
						<h3>By user</h3>
						<span className="sub">admin view</span>
					</div>
					<table className="dense">
						<thead>
							<tr>
								<th>User</th>
								<th>Turns</th>
								<th>Tokens</th>
								<th>Cost</th>
							</tr>
						</thead>
						<tbody>
							{summary.byUser.map((row) => (
								<tr key={row.username}>
									<td>{row.username}</td>
									<td className="mono">{row.turns.toLocaleString("en-US")}</td>
									<td className="mono">{row.tokens.toLocaleString("en-US")}</td>
									<td className="mono">{usd(row.cost)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<h3>Rates</h3>
					<span className="sub">USD per million tokens</span>
				</div>
				<table className="dense">
					<thead>
						<tr>
							<th>Provider</th>
							<th>Input</th>
							<th>Output</th>
							<th>Source</th>
						</tr>
					</thead>
					<tbody>
						{Object.entries(summary.rates).map(([provider, rate]) => (
							<tr key={provider}>
								<td>{provider}</td>
								<td className="mono">${rate.inputPerMillion.toFixed(2)}</td>
								<td className="mono">${rate.outputPerMillion.toFixed(2)}</td>
								<td className="muted">{rate.source}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="muted rp-note" style={{ marginTop: 8 }}>
					Rates marked <em>list price (verify)</em> are defaults, not your contract. Azure
					pricing varies by region and commitment, and an enterprise agreement usually does not
					pay list. Set <span className="mono">COST_AZURE_INPUT_PER_M</span> and{" "}
					<span className="mono">COST_AZURE_OUTPUT_PER_M</span> in <span className="mono">.env</span>{" "}
					and check them against an invoice before anyone makes a decision on these numbers.
				</p>
			</div>
		</div>
	);
}
