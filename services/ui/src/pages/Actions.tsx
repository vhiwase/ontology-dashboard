/**
 * Actions: the ontology's verb layer, with a form per action and the audit trail.
 *
 * The role selector is prominent and defaults to Analyst, because the role is
 * what decides whether an action runs at all - and an analyst can read everything
 * and change nothing. Switching to Operations Manager to stage a hold is a
 * deliberate act, which is the point.
 *
 * A mutating action returns `staged`: validated, permission-checked and recorded,
 * but not sent, because this platform reads the TMS through a captured snapshot
 * and has no write-back endpoint. The response says so rather than implying the
 * change landed.
 */

import { useEffect, useMemo, useState } from "react";
import { type ActionSummary, api, formatCell, isMissingOntology } from "../api";
import { useSpace } from "../SpaceContext";
import {
	DataTable,
	Empty,
	ErrorBanner,
	NoOntologyHere,
	Spinner,
} from "../components/common";

interface ActionOutcome {
	action: string;
	label: string;
	status: "succeeded" | "staged" | "failed" | "rejected" | "pending_approval";
	isReadOnly: boolean;
	message: string;
	validation: { valid: boolean; errors: Array<{ field: string; message: string }> };
	result: Record<string, unknown>;
	auditId: number | null;
	durationMs: number;
}

interface Role {
	"@id": string;
	label: { en?: string };
	description?: { en?: string };
}

const STATUS_CHIP: Record<string, string> = {
	succeeded: "good",
	staged: "warning",
	pending_approval: "warning",
	failed: "critical",
	rejected: "critical",
};

export function Actions() {
	const [actions, setActions] = useState<ActionSummary[] | null>(null);
	const [roles, setRoles] = useState<Role[]>([]);
	const [role, setRole] = useState("tms:AnalystRole");
	const [selected, setSelected] = useState<string | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [audit, setAudit] = useState<Array<Record<string, unknown>> | null>(null);
	const [missing, setMissing] = useState(false);
	const { spaceSlug, space } = useSpace();

	const loadAudit = () => {
		api
			.get<Array<Record<string, unknown>>>("/api/actions/audit?limit=60")
			.then(setAudit)
			.catch(() => setAudit([]));
	};

	// Action types are part of the ontology, so they belong to a space and are
	// reloaded when it changes.
	useEffect(() => {
		setActions(null);
		setSelected(null);
		setError(null);
		setMissing(false);
		Promise.all([
			api.get<ActionSummary[]>("/api/action-types"),
			api.get<Role[]>("/api/roles"),
		])
			.then(([actionRows, roleRows]) => {
				setActions(actionRows);
				setRoles(roleRows);
				// A read-only action first when there is one, because it is the one
				// a visitor can actually run. There are none today — all three
				// were withdrawn with the generated execution data they computed
				// from — so this falls back to the first action rather than
				// opening the page with nothing selected.
				setSelected(
					(current) =>
						current ?? actionRows.find((a) => a.isReadOnly)?.apiName ?? actionRows[0]?.apiName ?? null,
				);
			})
			.catch((exc: Error) =>
				isMissingOntology(exc) ? setMissing(true) : setError(exc.message),
			);
		loadAudit();
	}, [spaceSlug]);

	const action = actions?.find((entry) => entry.apiName === selected) ?? null;

	useEffect(() => {
		setValues({});
		setOutcome(null);
	}, [selected]);

	const parameters = useMemo(
		() =>
			(action?.parameters ?? []).map((parameter) => {
				const rules = (parameter.validation ?? []) as Array<Record<string, any>>;
				const enumRule = rules.find((rule) => Array.isArray(rule?.value?.enum));
				return {
					name: String(parameter.name),
					label: String((parameter.label as { en?: string })?.en ?? parameter.name),
					type: String(parameter.type),
					required: Boolean(parameter.required),
					description: String((parameter.description as { en?: string })?.en ?? ""),
					options: (enumRule?.value?.enum ?? null) as string[] | null,
					defaultValue: parameter.defaultValue,
				};
			}),
		[action],
	);

	const run = async () => {
		if (!action) return;
		setBusy(true);
		setOutcome(null);
		setError(null);

		// Coerce each value to the declared parameter type before sending, so the
		// service validates real types rather than everything as strings.
		const payload: Record<string, unknown> = {};
		for (const parameter of parameters) {
			const raw = values[parameter.name];
			if (raw === undefined || raw === "") continue;
			if (["decimal", "float", "integer"].includes(parameter.type)) payload[parameter.name] = Number(raw);
			else if (parameter.type === "boolean") payload[parameter.name] = raw === "true";
			else payload[parameter.name] = raw;
		}

		try {
			const response = await fetch(`/api/actions/${action.apiName}/apply`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parameters: payload,
					actor: "ui-user",
					actorRole: role,
					initiatedByAi: false,
				}),
			});
			// 403 and 422 carry a full outcome body, so they are read rather than
			// thrown: the refusal is the useful answer here.
			setOutcome((await response.json()) as ActionOutcome);
			loadAudit();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	};

	if (missing)
		return <NoOntologyHere what="action types" spaceName={space?.name ?? spaceSlug} />;
	if (error && !actions) return <ErrorBanner error={error} />;
	if (!actions) return <Spinner label="Loading actions" />;

	return (
		<div className="col" style={{ gap: 12 }}>
			<div className="card">
				<div className="card-head">
					<h3>Acting as</h3>
					<span className="sub">the role decides what may run</span>
				</div>
				<div className="row" style={{ gap: 10 }}>
					<select value={role} onChange={(event) => setRole(event.target.value)}>
						{roles.map((entry) => (
							<option key={entry["@id"]} value={entry["@id"]}>
								{entry.label.en ?? entry["@id"]}
							</option>
						))}
					</select>
					<span className="secondary" style={{ fontSize: 12.5 }}>
						{roles.find((entry) => entry["@id"] === role)?.description?.en}
					</span>
				</div>
			</div>

			<div className="split">
				<div className="card" style={{ padding: 10 }}>
					{/* The read-only group appears only when there is something in
					    it. An empty heading reads as a fault; the note below the
					    list says where they went. */}
					{actions.some((entry) => entry.isReadOnly) && (
						<>
							<div className="rail-section">Read-only · safe to run</div>
							{actions
								.filter((entry) => entry.isReadOnly)
								.map((entry) => (
									<button
										key={entry.apiName}
										className={`rail-link ${entry.apiName === selected ? "active" : ""}`}
										style={{ width: "100%", textAlign: "left" }}
										onClick={() => setSelected(entry.apiName)}
									>
										<span>{entry.label}</span>
									</button>
								))}
						</>
					)}
					<div className="rail-section">Mutating · staged only</div>
					{actions
						.filter((entry) => !entry.isReadOnly)
						.map((entry) => (
							<button
								key={entry.apiName}
								className={`rail-link ${entry.apiName === selected ? "active" : ""}`}
								style={{ width: "100%", textAlign: "left" }}
								onClick={() => setSelected(entry.apiName)}
							>
								<span>{entry.label}</span>
								{entry.requiresApproval && <span className="count">approval</span>}
							</button>
						))}
					{!actions.some((entry) => entry.isReadOnly) && (
						<p className="muted" style={{ fontSize: 11, margin: "10px 4px 2px" }}>
							Every action here is staged rather than run. The three read-only ones —
							a rate what-if, an on-time projection, a cost recalculation — computed
							from generated execution data and were withdrawn with it.
						</p>
					)}
				</div>

				<div className="col">
					{!action ? (
						<Empty>Pick an action.</Empty>
					) : (
						<>
							<div className="card">
								<div className="card-head">
									<h3>{action.label}</h3>
									<span className={`chip ${action.isReadOnly ? "good" : "warning"}`}>
										<span className="dot" aria-hidden />
										{action.isReadOnly ? "read-only" : "mutating"}
									</span>
									{action.requiresApproval && <span className="chip">needs approval</span>}
								</div>
								<p className="secondary" style={{ margin: "0 0 12px" }}>
									{action.description}
								</p>

								<div className="col" style={{ gap: 9 }}>
									{parameters.map((parameter) => (
										<label key={parameter.name} className="col" style={{ gap: 3 }}>
											<span style={{ fontSize: 12.5 }}>
												{parameter.label}
												{parameter.required && <span style={{ color: "var(--status-critical)" }}> *</span>}
												<span className="muted mono" style={{ marginLeft: 6 }}>
													{parameter.type}
												</span>
											</span>
											{parameter.options ? (
												<select
													value={values[parameter.name] ?? ""}
													onChange={(event) =>
														setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
													}
												>
													<option value="">—</option>
													{parameter.options.map((option) => (
														<option key={option} value={option}>
															{option}
														</option>
													))}
												</select>
											) : parameter.type === "boolean" ? (
												<select
													value={values[parameter.name] ?? ""}
													onChange={(event) =>
														setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
													}
												>
													<option value="">—</option>
													<option value="true">Yes</option>
													<option value="false">No</option>
												</select>
											) : (
												<input
													value={values[parameter.name] ?? ""}
													placeholder={
														parameter.defaultValue !== undefined
															? `default ${String(parameter.defaultValue)}`
															: undefined
													}
													onChange={(event) =>
														setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
													}
												/>
											)}
											{parameter.description && (
												<span className="muted" style={{ fontSize: 11.5 }}>
													{parameter.description}
												</span>
											)}
										</label>
									))}
								</div>

								<div className="row" style={{ marginTop: 12, gap: 8 }}>
									<button className="btn primary" onClick={() => void run()} disabled={busy}>
										{busy ? "Running…" : action.isReadOnly ? "Run" : "Validate and stage"}
									</button>
									<span className="muted" style={{ fontSize: 11.5 }}>
										Allowed roles: {action.allowedRoles.join(", ") || "none"}
									</span>
								</div>
							</div>

							{outcome && (
								<div className="card">
									<div className="card-head">
										<h3>Outcome</h3>
										<span className={`chip ${STATUS_CHIP[outcome.status] ?? ""}`}>
											<span className="dot" aria-hidden />
											{outcome.status.replace("_", " ")}
										</span>
										<span className="sub">{outcome.durationMs}ms</span>
									</div>
									<p className="secondary" style={{ margin: "0 0 10px" }}>
										{outcome.message}
									</p>

									{outcome.validation.errors.length > 0 && (
										<div className="banner error" style={{ marginBottom: 10 }}>
											<strong>Parameter problems:</strong>
											<ul style={{ margin: "5px 0 0", paddingLeft: 18 }}>
												{outcome.validation.errors.map((problem) => (
													<li key={problem.field}>
														{problem.field}: {problem.message}
													</li>
												))}
											</ul>
										</div>
									)}

									{Object.keys(outcome.result).length > 0 && (
										<DataTable
											columns={[
												{ key: "field", label: "Field" },
												{ key: "value", label: "Value" },
											]}
											rows={Object.entries(outcome.result)
												.filter(([key]) => !["note", "payloadForTms"].includes(key))
												.map(([key, value]) => ({
													field: key,
													value:
														typeof value === "object" && value !== null
															? JSON.stringify(value)
															: formatCell(value),
												}))}
											maxHeight={300}
										/>
									)}

									{typeof outcome.result.note === "string" && (
										<p className="muted" style={{ fontSize: 11.5, marginTop: 9, marginBottom: 0 }}>
											{outcome.result.note}
										</p>
									)}

									{Boolean(outcome.result.payloadForTms) && (
										<details style={{ marginTop: 9 }}>
											<summary className="mono" style={{ cursor: "pointer", fontSize: 11.5 }}>
												Payload that would be sent to the TMS
											</summary>
											<pre className="mono" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
												{JSON.stringify(outcome.result.payloadForTms, null, 2)}
											</pre>
										</details>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<h3>Audit trail</h3>
					<span className="sub">every attempt, including the refusals</span>
					<button className="btn sm" onClick={loadAudit} style={{ marginLeft: 10 }}>
						Refresh
					</button>
				</div>
				{!audit ? (
					<Spinner />
				) : audit.length === 0 ? (
					<Empty>No actions have been attempted yet.</Empty>
				) : (
					<DataTable
						columns={[
							{ key: "action_audit_id", label: "#", numeric: true },
							{ key: "api_name", label: "Action" },
							{ key: "status", label: "Status" },
							{ key: "actor_role", label: "Role" },
							{ key: "initiated_by_ai", label: "By AI" },
							{ key: "duration_ms", label: "ms", numeric: true },
							{ key: "error_message", label: "Error" },
							{ key: "created_at", label: "When" },
						]}
						rows={audit}
						maxHeight={340}
					/>
				)}
			</div>
		</div>
	);
}
