/**
 * Editing an ontology that a pipeline regenerates.
 *
 * The thing to understand before changing anything here: this ontology is
 * GENERATED. A pipeline run introspects the views and publishes a new version;
 * nothing carries forward. An edit therefore does not simply update a row — it
 * is recorded as an intention keyed by RID, applied to the live version now
 * and replayed onto every version published afterwards.
 *
 * That is why the dialog says so. Someone correcting a label deserves to know
 * their correction survives the next pipeline run, because the obvious
 * assumption is that it will not.
 *
 * ── what is locked ─────────────────────────────────────────────────────────
 * The RID, the api name and the backing view. The first two are how every
 * dashboard, saved query and link refers to this type; the third is what the
 * type is derived FROM, so repointing it would not move any data, it would
 * just make the type describe something it is not.
 *
 * They are shown rather than hidden: the reader should see the handles they
 * are working with, and see that they are fixed. The server refuses to write
 * them regardless — a disabled input is a hint to a browser, not a rule.
 */

import { useCallback, useEffect, useState } from "react";
import { type ObjectTypeDetail, type PropertyMeta, api } from "../../api";
import { ErrorBanner } from "../common";

const OBJECT_KINDS = ["entity", "event", "role", "value"];

const SEMANTIC_ROLES = [
	"identity",
	"title",
	"measure",
	"dimension",
	"temporal",
	"geo",
	"flag",
	"attribute",
	"provenance",
];

const AGGREGATIONS = ["", "sum", "avg", "count", "min", "max"];

interface ObjectDraft {
	label: string;
	pluralLabel: string;
	description: string;
	group: string;
	icon: string;
	color: string;
	titleColumn: string;
	kind: string;
}

export function ObjectTypeEditor({
	detail,
	onClose,
	onSaved,
}: {
	detail: ObjectTypeDetail | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [draft, setDraft] = useState<ObjectDraft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** The property being edited, if any. Null means the type itself. */
	const [property, setProperty] = useState<PropertyMeta | null>(null);

	useEffect(() => {
		if (!detail) return;
		setError(null);
		setProperty(null);
		setDraft({
			label: detail.label ?? "",
			pluralLabel: detail.pluralLabel ?? "",
			description: detail.description ?? "",
			group: detail.group ?? "",
			icon: detail.icon ?? "",
			color: detail.color ?? "",
			titleColumn: detail.titleProperty ?? "",
			kind: detail.kind ?? "entity",
		});
	}, [detail]);

	const close = useCallback(() => onClose(), [onClose]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	if (!detail || !draft) return null;

	async function save() {
		if (!detail || !draft) return;
		setBusy(true);
		setError(null);
		try {
			// Only what changed. Sending every field would record an edit
			// against values nobody touched, and the journal is replayed on
			// every publish - so a no-op edit is not free, it is a standing
			// instruction to keep re-applying a value.
			const fields: Record<string, unknown> = {};
			if (draft.label !== (detail.label ?? "")) fields.label = draft.label;
			if (draft.pluralLabel !== (detail.pluralLabel ?? ""))
				fields.pluralLabel = draft.pluralLabel || null;
			if (draft.description !== (detail.description ?? ""))
				fields.description = draft.description || null;
			if (draft.group !== (detail.group ?? "")) fields.group = draft.group || null;
			if (draft.icon !== (detail.icon ?? "")) fields.icon = draft.icon || null;
			if (draft.color !== (detail.color ?? "")) fields.color = draft.color || null;
			if (draft.titleColumn !== (detail.titleProperty ?? ""))
				fields.titleColumn = draft.titleColumn || null;
			if (draft.kind !== detail.kind) fields.kind = draft.kind;

			if (Object.keys(fields).length === 0) {
				close();
				return;
			}

			await api.patch(`/api/ontology/objectType/${encodeURIComponent(detail.rid)}`, {
				fields,
			});
			onSaved();
			close();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function saveProperty(changed: Record<string, unknown>) {
		if (!property) return;
		setBusy(true);
		setError(null);
		try {
			await api.patch(`/api/ontology/property/${encodeURIComponent(property.rid)}`, {
				fields: changed,
			});
			onSaved();
			setProperty(null);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="rp fn-window" role="dialog" aria-modal="true" aria-label="Edit object type">
				<header className="rp-head">
					<span className="rp-glyph" aria-hidden>
						◈
					</span>
					<div className="rp-heading">
						<div className="rp-kind">OBJECT TYPE</div>
						<h3 className="rp-title">{detail.label}</h3>
					</div>
					<button className="icon-button" onClick={close} aria-label="Close">
						×
					</button>
				</header>

				<div className="fn-body">
					<p className="fn-lede">
						This ontology is generated by a pipeline. Your change is applied now
						<strong> and replayed onto every version published afterwards</strong>, so it
						survives the next pipeline run rather than being overwritten by it.
					</p>

					{error && <ErrorBanner error={error} />}

					{property ? (
						<PropertyForm
							property={property}
							busy={busy}
							onCancel={() => setProperty(null)}
							onSave={saveProperty}
						/>
					) : (
						<>
							<section className="fn-section">
								<h4>Identity</h4>
								<p className="fn-hint">
									Fixed. Dashboards, links and the assistant all refer to this type by
									these, and the view is what it is derived from.
								</p>
								<div className="fn-grid">
									<label className="fn-field locked">
										<span>
											RID <em>locked</em>
										</span>
										<input value={detail.rid} readOnly disabled />
									</label>
									<label className="fn-field locked">
										<span>
											API name <em>locked</em>
										</span>
										<input value={detail.apiName} readOnly disabled />
									</label>
									<label className="fn-field locked wide">
										<span>
											Backed by <em>locked</em>
										</span>
										<input value={detail.sourceView} readOnly disabled />
									</label>
								</div>
							</section>

							<section className="fn-section">
								<h4>Presentation</h4>
								<div className="fn-grid">
									<label className="fn-field">
										<span>Label</span>
										<input
											value={draft.label}
											onChange={(e) => setDraft({ ...draft, label: e.target.value })}
										/>
									</label>
									<label className="fn-field">
										<span>Plural label</span>
										<input
											value={draft.pluralLabel}
											onChange={(e) => setDraft({ ...draft, pluralLabel: e.target.value })}
										/>
									</label>
									<label className="fn-field wide">
										<span>Description</span>
										<textarea
											rows={2}
											value={draft.description}
											onChange={(e) => setDraft({ ...draft, description: e.target.value })}
										/>
									</label>
									<label className="fn-field">
										<span>Group</span>
										<input
											value={draft.group}
											placeholder="Demand, Execution, Party…"
											onChange={(e) => setDraft({ ...draft, group: e.target.value })}
										/>
									</label>
									<label className="fn-field">
										<span>Kind</span>
										<select
											value={draft.kind}
											onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
										>
											{OBJECT_KINDS.map((kind) => (
												<option key={kind} value={kind}>
													{kind}
												</option>
											))}
										</select>
									</label>
									<label className="fn-field">
										<span>Title column</span>
										<select
											value={draft.titleColumn}
											onChange={(e) => setDraft({ ...draft, titleColumn: e.target.value })}
										>
											<option value="">— none —</option>
											{detail.properties.map((prop) => (
												<option key={prop.sqlColumn} value={prop.sqlColumn}>
													{prop.apiName}
												</option>
											))}
										</select>
									</label>
									<label className="fn-field">
										<span>Icon</span>
										<input
											value={draft.icon}
											onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
										/>
									</label>
								</div>
							</section>

							<section className="fn-section">
								<h4>Properties</h4>
								<p className="fn-hint">
									Click one to change its label, role or unit. The api name and SQL column
									are fixed for the same reason the type's are.
								</p>
								<div className="scroll-list" style={{ maxHeight: 220 }}>
									{detail.properties.map((prop) => (
										<button
											key={prop.rid}
											className="ont-prop-row"
											onClick={() => setProperty(prop)}
										>
											<span className="mono">{prop.apiName}</span>
											<span className="muted">{prop.label}</span>
											<span className="chip">{prop.semanticRole}</span>
										</button>
									))}
								</div>
							</section>
						</>
					)}
				</div>

				{!property && (
					<footer className="fn-foot">
						<div className="fn-foot-note">
							Recorded in the edit journal, and undoable from there.
						</div>
						<div className="row" style={{ gap: 8 }}>
							<button className="ghost" onClick={close} disabled={busy}>
								Cancel
							</button>
							<button className="primary" onClick={save} disabled={busy}>
								{busy ? "Saving…" : "Save changes"}
							</button>
						</div>
					</footer>
				)}
			</div>
		</div>
	);
}

/** The per-property form, which edits meaning rather than presentation. */
function PropertyForm({
	property,
	busy,
	onCancel,
	onSave,
}: {
	property: PropertyMeta;
	busy: boolean;
	onCancel: () => void;
	onSave: (fields: Record<string, unknown>) => void;
}) {
	const [label, setLabel] = useState(property.label ?? "");
	const [description, setDescription] = useState(property.description ?? "");
	const [role, setRole] = useState(property.semanticRole ?? "attribute");
	const [unit, setUnit] = useState(property.unit ?? "");
	const [aggregation, setAggregation] = useState(property.defaultAggregation ?? "");

	return (
		<section className="fn-section">
			<h4>Property · {property.apiName}</h4>
			<p className="fn-hint">
				The semantic role decides what the assistant may do with this column: only a
				measure can be summed, only a dimension can group a chart.
			</p>

			<div className="fn-grid">
				<label className="fn-field locked">
					<span>
						API name <em>locked</em>
					</span>
					<input value={property.apiName} readOnly disabled />
				</label>
				<label className="fn-field locked">
					<span>
						SQL column <em>locked</em>
					</span>
					<input value={property.sqlColumn} readOnly disabled />
				</label>
				<label className="fn-field">
					<span>Label</span>
					<input value={label} onChange={(e) => setLabel(e.target.value)} />
				</label>
				<label className="fn-field">
					<span>Semantic role</span>
					<select value={role} onChange={(e) => setRole(e.target.value)}>
						{SEMANTIC_ROLES.map((item) => (
							<option key={item} value={item}>
								{item}
							</option>
						))}
					</select>
				</label>
				<label className="fn-field">
					<span>Unit</span>
					<input value={unit} onChange={(e) => setUnit(e.target.value)} />
				</label>
				<label className="fn-field">
					<span>Default aggregation</span>
					<select value={aggregation} onChange={(e) => setAggregation(e.target.value)}>
						{AGGREGATIONS.map((item) => (
							<option key={item || "none"} value={item}>
								{item || "— none —"}
							</option>
						))}
					</select>
				</label>
				<label className="fn-field wide">
					<span>Description</span>
					<textarea
						rows={2}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</label>
			</div>

			<div className="row" style={{ gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
				<button className="ghost" onClick={onCancel} disabled={busy}>
					Back
				</button>
				<button
					className="primary"
					disabled={busy}
					onClick={() =>
						onSave({
							label,
							description: description || null,
							semanticRole: role,
							unit: unit || null,
							defaultAggregation: aggregation || null,
						})
					}
				>
					{busy ? "Saving…" : "Save property"}
				</button>
			</div>
		</section>
	);
}
