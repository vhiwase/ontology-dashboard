/**
 * Actions: the ontology's verb layer, with a form per action and the audit trail.
 *
 * AN ACTION RUNS AS WHOEVER IS SIGNED IN. The server takes the actor and the
 * business role from the verified token and ignores anything the request says
 * about either, so this page does not offer a role to "act as": the selector
 * that used to sit at the top changed nothing, and implied it did. What the
 * form shows instead is who the run will be recorded as, and which roles the
 * action allows.
 *
 * THE FORM KNOWS THE DATA. An action is declared on an object type and takes
 * that object's key as its first parameter, so the key is chosen from the
 * object type's own records - searched by name, not typed as an id - and a
 * parameter that names a field is chosen from the object type's fields.
 * Everything else is typed, in a control that fits its declared type.
 *
 * A mutating action returns `staged`: validated, permission-checked and recorded,
 * but not sent, because this platform reads the TMS through a captured snapshot
 * and has no write-back endpoint. The response says so rather than implying the
 * change landed.
 *
 * AN ACTION CAN BE DELETED HERE. That removes the definition; the audit trail
 * below keeps every run that was already recorded under its name.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type ActionSummary,
	type ObjectTypeDetail,
	type ObjectTypeSummary,
	type SearchResult,
	api,
	formatCell,
	isMissingOntology,
	session,
} from "../api";
import { useSpace } from "../SpaceContext";
import {
	DataTable,
	Empty,
	ErrorBanner,
	NoOntologyHere,
	PageLoader,
	Spinner,
} from "../components/common";
import { DeleteButton, DeleteDialog, deletedNotice, useCanDelete } from "../components/DeleteDialog";
import { Icon } from "../components/icons";
import { type SearchOption, type SearchPage, SearchSelect } from "../components/SearchSelect";

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

interface Parameter {
	name: string;
	label: string;
	type: string;
	required: boolean;
	description: string;
	options: string[] | null;
	defaultValue: unknown;
}

/** How a parameter is filled in. */
type Control =
	| { kind: "object"; type: ObjectTypeSummary }
	| { kind: "field" }
	| { kind: "enum"; options: string[] }
	| { kind: "boolean" }
	| { kind: "number" }
	| { kind: "date" }
	| { kind: "datetime" }
	| { kind: "text" };

const STATUS_CHIP: Record<string, string> = {
	succeeded: "good",
	staged: "warning",
	pending_approval: "warning",
	failed: "critical",
	rejected: "critical",
};

/** Parameter names that mean "one of the object's fields". */
const FIELD_NAMES = new Set([
	"field",
	"fieldname",
	"fieldtoupdate",
	"property",
	"propertyname",
	"attribute",
	"attributename",
	"column",
	"columnname",
]);

/** How many records a search lists at a time. */
const PICKER_PAGE = 25;

/**
 * The control a parameter gets.
 *
 * `<objectType>Key` is the convention every declared action follows for the
 * object it acts on (and the one the server resolves the target by), so it is
 * what makes a parameter a record picker.
 */
function controlFor(parameter: Parameter, types: ObjectTypeSummary[], hasTarget: boolean): Control {
	if (parameter.options) return { kind: "enum", options: parameter.options };
	if (parameter.name.endsWith("Key")) {
		const named = parameter.name.slice(0, -3).toLowerCase();
		const type = types.find((entry) => entry.apiName.toLowerCase() === named);
		if (type) return { kind: "object", type };
	}
	if (parameter.type === "boolean") return { kind: "boolean" };
	if (["decimal", "float", "integer"].includes(parameter.type)) return { kind: "number" };
	if (parameter.type === "date") return { kind: "date" };
	if (parameter.type === "datetime") return { kind: "datetime" };
	if (hasTarget && FIELD_NAMES.has(parameter.name.toLowerCase())) return { kind: "field" };
	return { kind: "text" };
}

export function Actions() {
	const [actions, setActions] = useState<ActionSummary[] | null>(null);
	const [roles, setRoles] = useState<Role[]>([]);
	const [types, setTypes] = useState<ObjectTypeSummary[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	// What each picker chose, with its name, so an id is never shown bare.
	const [picked, setPicked] = useState<Record<string, SearchOption>>({});
	// Set by the first attempt to run, so "required" is not shouted at an
	// untouched form.
	const [attempted, setAttempted] = useState(false);
	const [target, setTarget] = useState<ObjectTypeDetail | null>(null);
	const [record, setRecord] = useState<Record<string, unknown> | null>(null);
	const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [audit, setAudit] = useState<Array<Record<string, unknown>> | null>(null);
	const [missing, setMissing] = useState(false);
	// The action whose deletion is being confirmed.
	const [removing, setRemoving] = useState<ActionSummary | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const canDelete = useCanDelete();
	const { spaceSlug, space, isPersonal, reload } = useSpace();
	const me = session.user();

	const loadAudit = useCallback(() => {
		api
			.get<Array<Record<string, unknown>>>("/api/actions/audit?limit=60")
			.then(setAudit)
			.catch(() => setAudit([]));
	}, []);

	// Action types are part of the ontology, so they belong to a space and are
	// reloaded when it changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the space is the trigger
	useEffect(() => {
		setActions(null);
		setSelected(null);
		setError(null);
		setMissing(false);
		Promise.all([
			api.get<ActionSummary[]>("/api/action-types"),
			api.get<Role[]>("/api/roles"),
			api.get<ObjectTypeSummary[]>("/api/object-types"),
		])
			.then(([actionRows, roleRows, typeRows]) => {
				setActions(actionRows);
				setRoles(roleRows);
				setTypes(typeRows);
				// A read-only action first when there is one, because it is the one
				// a visitor can actually run; otherwise the first action, rather
				// than opening the page with nothing selected.
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
	// The object type the action is declared on.
	const targetSummary = useMemo(
		() => types.find((entry) => entry.rid === action?.targetObjectTypes?.[0]) ?? null,
		[types, action],
	);

	useEffect(() => {
		setValues({});
		setPicked({});
		setAttempted(false);
		setOutcome(null);
		setError(null);
	}, [selected]);

	// The target's fields, for a parameter that names one.
	useEffect(() => {
		setTarget(null);
		if (!targetSummary) return;
		let current = true;
		api
			.get<ObjectTypeDetail>(`/api/object-types/${encodeURIComponent(targetSummary.apiName)}`)
			.then((detail) => {
				if (current) setTarget(detail);
			})
			.catch(() => {
				if (current) setTarget(null);
			});
		return () => {
			current = false;
		};
	}, [targetSummary]);

	const parameters = useMemo<Parameter[]>(
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

	const controls = useMemo(
		() => new Map(parameters.map((parameter) => [parameter.name, controlFor(parameter, types, targetSummary !== null)])),
		[parameters, types, targetSummary],
	);

	// The record the action is about to act on, so the form can show what a
	// field holds now. It is the target type's own key parameter.
	const targetKeyName = parameters.find((parameter) => {
		const control = controls.get(parameter.name);
		return control?.kind === "object" && control.type.apiName === targetSummary?.apiName;
	})?.name;
	const targetKey = targetKeyName ? (values[targetKeyName] ?? "") : "";

	useEffect(() => {
		setRecord(null);
		if (!targetSummary || !targetKey) return;
		let current = true;
		api
			.get<Record<string, unknown>>(
				`/api/objects/${encodeURIComponent(targetSummary.apiName)}/${encodeURIComponent(targetKey)}`,
			)
			.then((row) => {
				if (current) setRecord(row);
			})
			.catch(() => {
				if (current) setRecord(null);
			});
		return () => {
			current = false;
		};
	}, [targetSummary, targetKey]);

	const setValue = (name: string, value: string) => {
		setValues((current) => ({ ...current, [name]: value }));
		setOutcome(null);
	};

	const pick = (name: string, option: SearchOption | null) => {
		setPicked((current) => {
			const next = { ...current };
			if (option) next[name] = option;
			else delete next[name];
			return next;
		});
		setValue(name, option?.value ?? "");
	};

	const missingRequired = parameters.filter((parameter) => parameter.required && !(values[parameter.name] ?? "").trim());

	const run = async () => {
		if (!action) return;
		setAttempted(true);
		if (missingRequired.length > 0) return;
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
			else if (parameter.type === "datetime") payload[parameter.name] = new Date(raw).toISOString();
			else payload[parameter.name] = raw;
		}

		try {
			// Sent as the signed-in person, in the space on screen. A refusal for
			// the role (403) or for the parameters (422) carries a full outcome,
			// so those are read rather than thrown: the refusal is the answer.
			const response = await api.postReading<ActionOutcome>(
				`/api/actions/${encodeURIComponent(action.apiName)}/apply`,
				{ parameters: payload, initiatedByAi: false },
				[403, 422],
			);
			if (response && typeof response.status === "string") setOutcome(response);
			else setError("The server answered without an outcome. Nothing was recorded.");
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
	if (!actions) return <PageLoader label="Loading actions" />;

	const roleLabel = (id: string) => roles.find((entry) => entry["@id"] === id)?.label.en ?? id.replace(/^[a-z]+:/, "");
	const mayRun = !action || !me || action.allowedRoles.length === 0 || action.allowedRoles.includes(me.ontologyRole);

	return (
		<div className="col" style={{ gap: 12 }}>
			{notice && (
				<p className="rb-notice" role="status">
					{notice}
				</p>
			)}
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
					{isPersonal ? (
						<p className="muted" style={{ fontSize: 11.5, margin: "10px 4px 2px" }}>
							{actions.length === 0
								? "No actions yet. Ask the assistant for one - “let managers reassign an order to another employee” - and approve it. "
								: ""}
							Your tables are synced copies, so a run is validated, permission-checked and recorded with its exact
							payload, then staged rather than written back to your database.
						</p>
					) : (
						!actions.some((entry) => entry.isReadOnly) && (
							<p className="muted" style={{ fontSize: 11, margin: "10px 4px 2px" }}>
								Every action here is staged: validated, permission-checked and recorded,
								but not written back, because an object's data is a synced copy of its
								source. Actions are declared on an object type, from its page or by the
								AI-FDE.
							</p>
						)
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
									{targetSummary && <span className="sub">acts on {targetSummary.label}</span>}
									{canDelete && (
										<span style={{ marginLeft: "auto" }}>
											<DeleteButton title={`Delete the action ${action.label}`} onClick={() => setRemoving(action)} />
										</span>
									)}
								</div>
								<p className="secondary" style={{ margin: "0 0 14px" }}>
									{action.description}
								</p>

								<form
									className="action-form"
									onSubmit={(event) => {
										event.preventDefault();
										void run();
									}}
								>
									{parameters.map((parameter) => (
										<ParameterField
											key={parameter.name}
											parameter={parameter}
											control={controls.get(parameter.name) ?? { kind: "text" }}
											value={values[parameter.name] ?? ""}
											picked={picked[parameter.name] ?? null}
											target={target}
											record={record}
											invalid={attempted && parameter.required && !(values[parameter.name] ?? "").trim()}
											onValue={(value) => setValue(parameter.name, value)}
											onPick={(option) => pick(parameter.name, option)}
										/>
									))}

									{attempted && missingRequired.length > 0 && (
										<p className="field-hint warn" role="alert">
											Fill in {missingRequired.map((parameter) => parameter.label).join(", ")} first.
										</p>
									)}

									<div className="action-run">
										<button className="btn primary" type="submit" disabled={busy}>
											{busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={14} />}
											{busy ? "Running…" : action.isReadOnly ? "Run" : "Validate and stage"}
										</button>
										<span className="muted action-run-as">
											{me ? (
												<>
													Runs as <strong>{me.username}</strong> ({roleLabel(me.ontologyRole)}).
												</>
											) : null}{" "}
											Allowed: {action.allowedRoles.map(roleLabel).join(", ") || "nobody"}.
										</span>
									</div>
									{!mayRun && me && (
										<p className="field-hint warn">
											Your business role, {roleLabel(me.ontologyRole)}, is not one this action allows, so a run will be
											refused and recorded as refused. An administrator can change your role in the admin console.
										</p>
									)}
								</form>
							</div>

							{error && <ErrorBanner error={error} />}

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

									{(outcome.validation?.errors ?? []).length > 0 && (
										<div className="banner error" style={{ marginBottom: 10 }}>
											<strong>Parameter problems:</strong>
											<ul style={{ margin: "5px 0 0", paddingLeft: 18 }}>
												{outcome.validation.errors.map((problem) => (
													<li key={`${problem.field}-${problem.message}`}>
														{parameters.find((parameter) => parameter.name === problem.field)?.label ?? problem.field}:{" "}
														{problem.message}
													</li>
												))}
											</ul>
										</div>
									)}

									{Object.keys(outcome.result ?? {}).length > 0 && (
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

									{typeof outcome.result?.note === "string" && (
										<p className="muted" style={{ fontSize: 11.5, marginTop: 9, marginBottom: 0 }}>
											{outcome.result.note}
										</p>
									)}

									{Boolean(outcome.result?.payloadForTms) && (
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
						<Icon name="refresh" size={13} />
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
							{ key: "actor", label: "By" },
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

			{removing && (
				<DeleteDialog
					kind="actionType"
					target={removing.apiName}
					label={removing.label}
					onClose={() => setRemoving(null)}
					onDeleted={(plan) => {
						const left = actions.filter((entry) => entry.apiName !== removing.apiName);
						setRemoving(null);
						setNotice(deletedNotice({ ...plan, name: removing.label }));
						setActions(left);
						// Whatever is next in the list, rather than an empty form.
						setSelected(left.find((entry) => entry.isReadOnly)?.apiName ?? left[0]?.apiName ?? null);
						// The counts in the navigation and on the object type's page.
						reload();
					}}
				/>
			)}
		</div>
	);
}

/** One parameter of an action, in the control that fits it. */
function ParameterField({
	parameter,
	control,
	value,
	picked,
	target,
	record,
	invalid,
	onValue,
	onPick,
}: {
	parameter: Parameter;
	control: Control;
	value: string;
	/** What a picker chose, with its name. */
	picked: SearchOption | null;
	/** The object type the action is declared on, with its fields. */
	target: ObjectTypeDetail | null;
	/** The record chosen to act on, once one is. */
	record: Record<string, unknown> | null;
	invalid: boolean;
	onValue: (value: string) => void;
	onPick: (option: SearchOption | null) => void;
}) {
	const id = `action-parameter-${parameter.name}`;
	const objectType = control.kind === "object" ? control.type : null;

	// Records of the object type, searched by what is typed. Asked of the
	// server each time: an object type can hold far more than a list should.
	const searchRecords = useCallback(
		async (term: string): Promise<SearchPage> => {
			if (!objectType) return { options: [] };
			const keyProperty = objectType.primaryKeyProperty;
			const titleProperty = objectType.titleProperty;
			const result = await api.post<SearchResult>(`/api/objects/${encodeURIComponent(objectType.apiName)}/search`, {
				search: term,
				limit: PICKER_PAGE,
				// The key and the title come back whatever is selected; asking
				// for one of them keeps the rest of the row off the wire.
				...(keyProperty ? { select: [keyProperty] } : {}),
			});
			return {
				total: result.totalCount,
				options: result.data
					.map((row): SearchOption | null => {
						const key = keyProperty ? row[keyProperty] : undefined;
						if (key === null || key === undefined) return null;
						const title = titleProperty ? row[titleProperty] : null;
						const named = title !== null && title !== undefined && String(title) !== String(key);
						return named
							? { value: String(key), label: String(title), detail: String(key) }
							: { value: String(key), label: String(key) };
					})
					.filter((option): option is SearchOption => option !== null),
			};
		},
		[objectType],
	);

	// The object type's fields, as they are named in the source.
	const fieldOptions = useMemo<SearchOption[]>(
		() =>
			(target?.properties ?? []).map((property) => ({
				value: property.sqlColumn,
				label: property.label,
				detail: `${property.sqlColumn} · ${property.datatype}${property.isIdentity ? " · key" : ""}`,
			})),
		[target],
	);
	const chosenField =
		control.kind === "field" ? (target?.properties.find((property) => property.sqlColumn === value) ?? null) : null;

	const set = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onValue(event.target.value);
	const placeholder = parameter.defaultValue !== undefined ? `default ${String(parameter.defaultValue)}` : undefined;

	return (
		<div className="field action-field">
			<span>
				<label htmlFor={id}>{parameter.label}</label>
				{parameter.required && (
					<span className="action-required" title="Required">
						{" "}
						*<span className="sr-only"> required</span>
					</span>
				)}
			</span>

			{control.kind === "object" ? (
				<SearchSelect
					id={id}
					value={value}
					selected={picked}
					onChange={onPick}
					search={searchRecords}
					invalid={invalid}
					placeholder={`Search ${control.type.pluralLabel ?? control.type.label} by name or id…`}
					emptyText={`No ${control.type.label} matches that.`}
				/>
			) : control.kind === "field" ? (
				<SearchSelect
					id={id}
					value={value}
					selected={picked}
					onChange={onPick}
					options={fieldOptions}
					invalid={invalid}
					disabled={!target}
					placeholder={target ? `Search the ${target.label} fields…` : "Loading the fields…"}
					emptyText="No field matches that."
				/>
			) : control.kind === "enum" ? (
				<select id={id} value={value} aria-invalid={invalid || undefined} onChange={set}>
					<option value="">—</option>
					{control.options.map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			) : control.kind === "boolean" ? (
				<select id={id} value={value} aria-invalid={invalid || undefined} onChange={set}>
					<option value="">—</option>
					<option value="true">Yes</option>
					<option value="false">No</option>
				</select>
			) : (
				<input
					id={id}
					type={
						control.kind === "number"
							? "number"
							: control.kind === "date"
								? "date"
								: control.kind === "datetime"
									? "datetime-local"
									: "text"
					}
					step={control.kind === "number" && parameter.type === "integer" ? 1 : control.kind === "number" ? "any" : undefined}
					value={value}
					placeholder={placeholder}
					aria-invalid={invalid || undefined}
					onChange={set}
				/>
			)}

			{/* What the chosen field holds on the chosen record, so the new value
			    is typed next to the one it replaces. */}
			{chosenField && record && (
				<span className="field-hint">
					Current value: <strong className="action-current">{formatCell(record[chosenField.apiName])}</strong>
				</span>
			)}
			{parameter.description && <span className="field-hint">{parameter.description}</span>}
		</div>
	);
}
