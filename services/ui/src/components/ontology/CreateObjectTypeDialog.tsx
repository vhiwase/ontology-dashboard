/**
 * Creating an object type from a dataset.
 *
 * The dataset is profiled first - real distinct and null counts, samples, the
 * columns that could be a primary key - and the form starts from what that
 * profile suggests: every column kept, each with the role the data implies.
 * A person corrects rather than composes. The service checks the key is unique
 * and never null, and that a measure is numeric, before anything is stored.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, type DatasetProfile, api } from "../../api";
import { ErrorBanner, Spinner } from "../common";
import { Icon } from "../icons";

const ROLES = ["identity", "title", "measure", "dimension", "temporal", "geo", "flag", "attribute", "provenance"];
const AGGREGATIONS = ["", "sum", "avg", "min", "max", "count"];
const NUMERIC = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision"]);

interface ColumnChoice {
	include: boolean;
	role: string;
	aggregation: string;
}

export function CreateObjectTypeDialog({
	dataset,
	onClose,
	onCreated,
}: {
	/** The dataset's name or connection_raw.<table>. */
	dataset: string;
	onClose: () => void;
	onCreated: (apiName: string) => void;
}) {
	const navigate = useNavigate();
	const [profile, setProfile] = useState<DatasetProfile | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const [apiName, setApiName] = useState("");
	const [label, setLabel] = useState("");
	const [pluralLabel, setPluralLabel] = useState("");
	const [description, setDescription] = useState("");
	const [primaryKey, setPrimaryKey] = useState("");
	const [titleColumn, setTitleColumn] = useState("");
	const [choices, setChoices] = useState<Record<string, ColumnChoice>>({});

	useEffect(() => {
		api
			.get<DatasetProfile>(`/api/datasets/${encodeURIComponent(dataset)}/profile`)
			.then((loaded) => {
				setProfile(loaded);
				setApiName(loaded.suggestion.apiName);
				setLabel(loaded.suggestion.label);
				setPluralLabel(loaded.suggestion.pluralLabel);
				setDescription(`Created from ${loaded.dataset.source ?? loaded.dataset.relation}.`);
				setPrimaryKey(loaded.suggestion.primaryKey ?? "");
				setTitleColumn(loaded.suggestion.titleColumn ?? loaded.suggestion.primaryKey ?? "");
				setChoices(
					Object.fromEntries(
						loaded.columns.map((column) => [
							column.column,
							{
								include: true,
								role: column.suggested.semanticRole,
								aggregation: column.suggested.defaultAggregation ?? "",
							},
						]),
					),
				);
			})
			.catch((exc: Error) => setError(exc.message));
	}, [dataset]);

	const included = useMemo(
		() => (profile?.columns ?? []).filter((column) => choices[column.column]?.include),
		[profile, choices],
	);

	function choose(column: string, change: Partial<ColumnChoice>) {
		setChoices((current) => ({ ...current, [column]: { ...current[column]!, ...change } }));
	}

	async function submit() {
		if (!profile) return;
		setBusy(true);
		setError(null);
		try {
			const created = await api.post<{ apiName: string }>("/api/ontology/object-types", {
				dataset: profile.dataset.relation,
				apiName: apiName.trim(),
				label: label.trim(),
				pluralLabel: pluralLabel.trim(),
				description: description.trim(),
				primaryKey,
				titleColumn,
				properties: included.map((column) => {
					const choice = choices[column.column]!;
					return {
						column: column.column,
						semanticRole: column.column === primaryKey ? "identity" : choice.role,
						defaultAggregation: choice.role === "measure" ? choice.aggregation || null : null,
					};
				}),
			});
			onCreated(created.apiName);
		} catch (exc) {
			setError(exc instanceof ApiError ? exc.message : String(exc));
		} finally {
			setBusy(false);
		}
	}

	function askAssistant() {
		const name = profile?.dataset.name ?? dataset;
		const prompt =
			`Create an object type from the ${name} dataset, link it to the object types that ` +
			"already exist, and add the metrics and actions that would be useful for it.";
		navigate(`/assistant?prompt=${encodeURIComponent(prompt)}`);
	}

	if (!profile) {
		return (
			<div className="card">
				{error ? <ErrorBanner error={error} /> : <Spinner label="Profiling the dataset" />}
				<div className="row">
					<button className="btn sm" onClick={onClose}>
						Close
					</button>
				</div>
			</div>
		);
	}

	const empty = profile.columns.filter((column) => column.empty).length;

	return (
		<div className="card">
			<div className="card-head">
				<h3>Create an object type from {profile.dataset.name}</h3>
				<span className="sub">
					{profile.rowCount.toLocaleString()} rows · {profile.columns.length} columns
					{profile.sampled ? " · profiled on the first 200,000 rows" : ""}
				</span>
			</div>

			{profile.existingObjectTypes.length > 0 && (
				<div className="banner warn">
					This dataset is already modelled as {profile.existingObjectTypes.join(", ")}. A second type
					on it is allowed, but is rarely what is wanted.
				</div>
			)}

			<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
				<label className="field" style={{ flex: 1 }}>
					<span>API name</span>
					<input value={apiName} onChange={(event) => setApiName(event.target.value)} />
					<span className="field-hint">PascalCase singular, e.g. Order. Fixed once created.</span>
				</label>
				<label className="field" style={{ flex: 1 }}>
					<span>Label</span>
					<input value={label} onChange={(event) => setLabel(event.target.value)} />
				</label>
				<label className="field" style={{ flex: 1 }}>
					<span>Plural</span>
					<input value={pluralLabel} onChange={(event) => setPluralLabel(event.target.value)} />
				</label>
			</div>

			<label className="field">
				<span>Description</span>
				<input value={description} onChange={(event) => setDescription(event.target.value)} />
			</label>

			<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
				<label className="field" style={{ flex: 1 }}>
					<span>Primary key</span>
					<select value={primaryKey} onChange={(event) => setPrimaryKey(event.target.value)}>
						{profile.primaryKeyCandidates.length === 0 && <option value="">No unique column</option>}
						{profile.primaryKeyCandidates.map((column) => (
							<option key={column} value={column}>
								{column}
							</option>
						))}
					</select>
					<span className="field-hint">Only columns that are unique and never null in the data.</span>
				</label>
				<label className="field" style={{ flex: 1 }}>
					<span>Title</span>
					<select value={titleColumn} onChange={(event) => setTitleColumn(event.target.value)}>
						{profile.columns.map((column) => (
							<option key={column.column} value={column.column}>
								{column.column}
							</option>
						))}
					</select>
					<span className="field-hint">What a person recognises one object by.</span>
				</label>
			</div>

			<div className="row" style={{ margin: "4px 0 6px" }}>
				<strong style={{ fontSize: 12 }}>Properties</strong>
				<span className="muted" style={{ fontSize: 11 }}>
					{included.length} of {profile.columns.length} columns kept
					{empty > 0 ? ` · ${empty} empty in every row, flagged in red` : ""}
				</span>
			</div>
			<div className="ot-columns">
				<table className="dense">
					<thead>
						<tr>
							<th />
							<th>Column</th>
							<th>Type</th>
							<th>Distinct</th>
							<th>Nulls</th>
							<th>Role</th>
							<th>Aggregate</th>
							<th>Sample</th>
						</tr>
					</thead>
					<tbody>
						{profile.columns.map((column) => {
							const choice = choices[column.column];
							if (!choice) return null;
							const isKey = column.column === primaryKey;
							return (
								<tr key={column.column} className={choice.include ? undefined : "excluded"}>
									<td>
										<input
											type="checkbox"
											checked={choice.include || isKey}
											disabled={isKey}
											onChange={(event) => choose(column.column, { include: event.target.checked })}
											aria-label={`Keep ${column.column}`}
										/>
									</td>
									<td className="mono">
										{column.column}
										{column.empty && <div className="ot-empty">empty in every row</div>}
									</td>
									<td className="mono muted">{column.sqlType}</td>
									<td className="mono">{column.distinct.toLocaleString()}</td>
									<td className="mono">{column.nulls.toLocaleString()}</td>
									<td>
										<select
											value={isKey ? "identity" : choice.role}
											disabled={isKey}
											onChange={(event) => choose(column.column, { role: event.target.value })}
										>
											{ROLES.filter((role) => role !== "measure" || NUMERIC.has(column.sqlType)).map((role) => (
												<option key={role} value={role}>
													{role}
												</option>
											))}
										</select>
									</td>
									<td>
										{choice.role === "measure" && !isKey ? (
											<select
												value={choice.aggregation}
												onChange={(event) => choose(column.column, { aggregation: event.target.value })}
											>
												{AGGREGATIONS.map((aggregation) => (
													<option key={aggregation} value={aggregation}>
														{aggregation || "—"}
													</option>
												))}
											</select>
										) : (
											<span className="muted">—</span>
										)}
									</td>
									<td className="mono muted" title={column.samples.join(" · ")}>
										{column.samples[0] ?? ""}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{error && <ErrorBanner error={error} />}
			<div className="row" style={{ marginTop: 10 }}>
				<button className="btn primary sm" disabled={busy || !primaryKey || !apiName.trim()} onClick={submit}>
					{busy ? <span className="spinner" aria-hidden /> : <Icon name="plus" size={13} />}
					{busy ? "Creating…" : "Create object type"}
				</button>
				<button className="btn sm" onClick={askAssistant} disabled={busy}>
					<Icon name="sparkles" size={13} />
					Ask the AI-FDE to model it
				</button>
				<button className="btn sm" onClick={onClose} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	);
}
