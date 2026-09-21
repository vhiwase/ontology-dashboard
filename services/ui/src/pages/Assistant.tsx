/**
 * The AI-FDE conversation.
 *
 * Two things here are not cosmetic:
 *
 * TOOL CALLS ARE VISIBLE. Every answer shows which ontology queries produced it,
 * and each one expands to its arguments and result. A business user who cannot
 * see where a number came from has no way to trust it, and an engineer debugging a
 * bad answer needs to see which call went wrong.
 *
 * ARTEFACTS RENDER AS ARTEFACTS. When the assistant runs a KPI it returns the
 * series, so the UI draws the chart rather than leaving the user to read numbers
 * out of a paragraph. When it builds a dashboard, the reply carries a link to it.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
	type AssistantHealth,
	type ChatArtifact,
	type ChatResponse,
	type ChatToolCall,
	api,
	formatValue,
} from "../api";
import { Chart, type ChartKind } from "../components/Chart";
import { DataTable, ErrorBanner, Markdown, Spinner, useScrollToBottom } from "../components/common";

interface Turn {
	role: "user" | "assistant";
	content: string;
	toolCalls?: ChatToolCall[];
	artifacts?: ChatArtifact[];
	meta?: {
		rounds: number;
		latencyMs: number;
		model: string;
		stoppedBecause: string;
		failoverReason?: string | null;
	};
}

interface Starter {
	label: string;
	prompt: string;
}

export function Assistant() {
	const [turns, setTurns] = useState<Turn[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [sessionId, setSessionId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [health, setHealth] = useState<AssistantHealth | null>(null);
	const [starters, setStarters] = useState<Starter[]>([]);
	const scrollRef = useScrollToBottom(turns.length + (busy ? 1 : 0));
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		api
			.get<AssistantHealth>("/api/assistant/health")
			.then(setHealth)
			.catch(() => setHealth(null));
		api
			.get<{ starters: Starter[] }>("/api/assistant/starters")
			.then((body) => setStarters(body.starters))
			.catch(() => setStarters([]));
	}, []);

	const send = async (message: string) => {
		const trimmed = message.trim();
		if (!trimmed || busy) return;
		setError(null);
		setInput("");
		setTurns((current) => [...current, { role: "user", content: trimmed }]);
		setBusy(true);

		try {
			const response = await api.post<ChatResponse>("/api/assistant/chat", {
				message: trimmed,
				sessionId,
			});
			setSessionId(response.sessionId);
			setTurns((current) => [
				...current,
				{
					role: "assistant",
					content: response.reply,
					toolCalls: response.toolCalls,
					artifacts: response.artifacts,
					meta: {
						rounds: response.rounds,
						latencyMs: response.latencyMs,
						model: response.model,
						stoppedBecause: response.stoppedBecause,
						failoverReason: response.failoverReason,
					},
				},
			]);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
			textareaRef.current?.focus();
		}
	};

	const llmDown = health && !health.llm.reachable;
	const modelMissing = health?.llm.reachable && health.llm.modelPresent === false;
	// The primary can be in cooldown while the fallback answers fine. That is a
	// working state, not an error, so it gets a note rather than a red banner.
	const onFallback = Boolean(
		health?.llm.breakerOpen ||
			(health?.configuredProvider && health.configuredProvider !== "auto" &&
				health.provider !== health.configuredProvider),
	);

	return (
		<div className="chat">
			<div className="chat-scroll" ref={scrollRef}>
				{(llmDown || modelMissing) && (
					<div className="banner error" style={{ marginBottom: 12 }}>
						<strong>The language model is not ready.</strong>{" "}
						{llmDown ? (
							<>
								{health?.provider === "ollama"
									? "Ollama is not reachable. "
									: "The configured provider is not reachable. "}
								{health?.llm.detail}
							</>
						) : (
							<>
								Ollama is up but the model <code>{health?.model}</code> has not been pulled
								yet. Run{" "}
								<code>docker compose exec ollama ollama pull {health?.model}</code> and
								reload. Everything else in this workbench works without it.
							</>
						)}
					</div>
				)}

				{onFallback && !llmDown && (
					<div className="banner" style={{ marginBottom: 12 }}>
						<strong>Running on the fallback model.</strong>{" "}
						{health?.llm.lastFailoverReason ?? health?.providerReason}{" "}
						Answers are unaffected; only which model produces them has changed.
					</div>
				)}

				{turns.length === 0 && (
					<div className="card" style={{ marginBottom: 12 }}>
						<div className="card-head">
							<h3>AI-FDE</h3>
							<span className="sub" title={health?.providerReason ?? undefined}>
								{health ? `${health.provider} · ${health.model}` : "checking model…"}
							</span>
						</div>
						{health?.providerReason && (
							<p className="muted" style={{ margin: "0 0 10px", fontSize: 11.5 }}>
								{health.providerReason}
							</p>
						)}
						<p className="secondary" style={{ margin: "0 0 12px", maxWidth: 780 }}>
							I know this TMS ontology: {" "}
							<Link to="/ontology">object types</Link>, their links, the{" "}
							<Link to="/dashboards">KPI catalogue</Link> and the action layer. Ask me a
							question about the freight book, or tell me what dashboard you need and I
							will build it. I will tell you which figures are measured and which rest on
							simulated execution data.
						</p>
						<div className="starters">
							{starters.map((starter) => (
								<button key={starter.label} className="starter" onClick={() => void send(starter.prompt)}>
									{starter.label}
								</button>
							))}
						</div>
					</div>
				)}

				{turns.map((turn, index) => (
					<TurnView key={index} turn={turn} />
				))}

				{busy && (
					<div className="msg assistant">
						<div className="avatar">AI</div>
						<div className="body">
							<Spinner label="Querying the ontology…" />
						</div>
					</div>
				)}

				{error && (
					<div style={{ marginTop: 10 }}>
						<ErrorBanner error={error} />
					</div>
				)}
			</div>

			<div className="composer">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void send(input);
					}}
				>
					<textarea
						ref={textareaRef}
						value={input}
						placeholder="Ask about orders, carriers, lanes, margin — or ask for a dashboard."
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							// Enter sends; Shift+Enter is a newline. Standard for a chat box, and
							// the hint below says so.
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void send(input);
							}
						}}
						rows={2}
					/>
					<button className="btn primary" type="submit" disabled={busy || !input.trim()}>
						{busy ? "Working…" : "Send"}
					</button>
				</form>
				<div className="row muted" style={{ fontSize: 11, marginTop: 6, gap: 10 }}>
					<span>Enter to send · Shift+Enter for a new line</span>
					{sessionId && <span>session {sessionId}</span>}
					{turns.length > 0 && (
						<button
							className="btn sm"
							style={{ marginLeft: "auto" }}
							onClick={() => {
								setTurns([]);
								setSessionId(null);
							}}
						>
							New conversation
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function TurnView({ turn }: { turn: Turn }) {
	const [showTools, setShowTools] = useState(false);

	if (turn.role === "user") {
		return (
			<div className="msg">
				<div className="avatar">You</div>
				<div className="body">
					<p style={{ margin: 0 }}>{turn.content}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="msg assistant">
			<div className="avatar">AI</div>
			<div className="body">
				<Markdown text={turn.content} />

				{turn.artifacts && turn.artifacts.length > 0 && (
					<div className="col" style={{ gap: 10, marginTop: 10 }}>
						{turn.artifacts.map((artifact, index) => (
							<ArtifactView key={index} artifact={artifact} />
						))}
					</div>
				)}

				{turn.toolCalls && turn.toolCalls.length > 0 && (
					<>
						<div className="tool-strip">
							{turn.toolCalls.map((call, index) => (
								<span key={index} className={`tool-pill ${call.ok ? "" : "failed"}`}>
									{call.ok ? "✓" : "✕"} {call.name} <span className="num">{call.durationMs}ms</span>
								</span>
							))}
							<button
								className="tool-pill"
								style={{ cursor: "pointer" }}
								onClick={() => setShowTools((current) => !current)}
							>
								{showTools ? "hide detail" : "show detail"}
							</button>
						</div>

						{showTools && (
							<div className="col" style={{ gap: 7, marginTop: 6 }}>
								{turn.toolCalls.map((call, index) => (
									<details key={index} open={!call.ok}>
										<summary className="mono" style={{ cursor: "pointer", fontSize: 11.5 }}>
											{call.name}
										</summary>
										<pre className="mono" style={{ marginTop: 5, whiteSpace: "pre-wrap", fontSize: 11 }}>
											{JSON.stringify(call.arguments, null, 2)}
											{"\n→ "}
											{call.preview}
										</pre>
									</details>
								))}
							</div>
						)}
					</>
				)}

				{turn.meta && (
					<div className="muted" style={{ fontSize: 11, marginTop: 7 }}>
						{turn.meta.rounds} round{turn.meta.rounds === 1 ? "" : "s"} ·{" "}
						{(turn.meta.latencyMs / 1000).toFixed(1)}s · {turn.meta.model}
						{turn.meta.stoppedBecause !== "answered" && ` · ${turn.meta.stoppedBecause}`}
						{turn.meta.failoverReason && " · answered by the fallback model"}
					</div>
				)}
			</div>
		</div>
	);
}

function ArtifactView({ artifact }: { artifact: ChatArtifact }) {
	if (artifact.kind === "dashboard") {
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="row" style={{ gap: 8 }}>
					<strong>{String(artifact.title)}</strong>
					<span className="chip">{String(artifact.widgets)} widgets</span>
					<Link className="btn sm primary" to={`/dashboards/${String(artifact.slug)}`} style={{ marginLeft: "auto" }}>
						Open dashboard
					</Link>
				</div>
			</div>
		);
	}

	if (artifact.kind === "chart") {
		const series = (artifact.series as Array<{ label: string; value: number | null }>) ?? [];
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>{String(artifact.title ?? artifact.kpi)}</h3>
					{artifact.total !== null && artifact.total !== undefined && (
						<span className="sub num">
							total{" "}
							{formatValue(
								artifact.total as number,
								String(artifact.format ?? "number"),
								artifact.unit as string | null,
							)}
						</span>
					)}
				</div>
				<Chart
					kind={(artifact.chart as ChartKind) ?? "hbar"}
					points={series}
					format={String(artifact.format ?? "number")}
					unit={artifact.unit as string | null}
				/>
				{Boolean(artifact.caveat) && (
					<p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
						{String(artifact.caveat)}
					</p>
				)}
			</div>
		);
	}

	if (artifact.kind === "table") {
		const rows = (artifact.rows as Array<Record<string, unknown>>) ?? [];
		if (rows.length === 0) return null;
		const columns = Object.keys(rows[0] ?? {})
			.filter((key) => !key.endsWith("__display") && !key.startsWith("_"))
			.slice(0, 7);
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>{String(artifact.title)}</h3>
					{artifact.rowsTotal !== undefined && (
						<span className="sub">
							{rows.length} of {String(artifact.rowsTotal)} rows
						</span>
					)}
				</div>
				<DataTable columns={columns.map((key) => ({ key, label: key }))} rows={rows} maxHeight={280} />
			</div>
		);
	}

	if (artifact.kind === "action") {
		const result = (artifact.result as Record<string, unknown>) ?? {};
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>{String(artifact.action)}</h3>
					<span className="chip">{String(artifact.status)}</span>
				</div>
				<DataTable
					columns={[
						{ key: "field", label: "Field" },
						{ key: "value", label: "Value" },
					]}
					rows={Object.entries(result)
						.filter(([key]) => key !== "note")
						.map(([key, value]) => ({ field: key, value }))}
					maxHeight={260}
				/>
				{Boolean(result.note) && (
					<p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
						{String(result.note)}
					</p>
				)}
			</div>
		);
	}

	if (artifact.kind === "lineage") {
		const byLayer = (artifact.upstreamByLayer as Record<string, string[]>) ?? {};
		return (
			<div className="card" style={{ background: "var(--surface-2)" }}>
				<div className="card-head">
					<h3>Lineage for {String(artifact.subject)}</h3>
					<Link className="btn sm" to="/lineage" style={{ marginLeft: "auto" }}>
						Open lineage graph
					</Link>
				</div>
				<dl className="kv">
					{Object.entries(byLayer).map(([layer, labels]) => (
						<div key={layer} style={{ display: "contents" }}>
							<dt>{layer}</dt>
							<dd className="secondary">{labels.join(", ")}</dd>
						</div>
					))}
				</dl>
			</div>
		);
	}

	return null;
}
