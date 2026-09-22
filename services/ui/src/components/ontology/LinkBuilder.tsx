/**
 * Drawing a link by hand (§9), and the journal of everything edited.
 *
 * The pipeline discovers links by probing the data for value overlap, so the
 * ones it finds are real by construction. A link drawn here is an assertion
 * instead — someone saying "these two columns refer to the same thing" — and
 * an assertion can be wrong.
 *
 * So the server MEASURES it before accepting: it runs the join and reports how
 * many source rows actually resolve. A link at 12% is not a mistake to hide,
 * it is the most useful thing the author can learn, and they learn it here
 * rather than from a half-empty table three screens later.
 */

import { useCallback, useEffect, useState } from "react";
import { type ObjectTypeSummary, type ObjectTypeDetail, api } from "../../api";
import { ErrorBanner, Spinner } from "../common";

const CARDINALITIES = ["MANY_TO_ONE", "ONE_TO_MANY", "ONE_TO_ONE", "MANY_TO_MANY"];

export function LinkBuilder({
	open,
	types,
	onClose,
	onCreated,
}: {
	open: boolean;
	types: ObjectTypeSummary[];
	onClose: () => void;
	onCreated: () => void;
}) {
	const [apiName, setApiName] = useState("");
	const [label, setLabel] = useState("");
	const [sourceType, setSourceType] = useState("");
	const [targetType, setTargetType] = useState("");
	const [sourceProperty, setSourceProperty] = useState("");
	const [targetProperty, setTargetProperty] = useState("");
	const [cardinality, setCardinality] = useState("MANY_TO_ONE");
	const [sourceDetail, setSourceDetail] = useState<ObjectTypeDetail | null>(null);
	const [targetDetail, setTargetDetail] = useState<ObjectTypeDetail | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<{ matched: number; candidates: number; ratio: number } | null>(
		null,
	);

	const close = useCallback(() => onClose(), [onClose]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	// Each side's properties are fetched so the key pickers offer real columns
	// rather than free text. A typo here would otherwise become a failed join.
	useEffect(() => {
		if (!sourceType) return setSourceDetail(null);
		api
			.get<ObjectTypeDetail>(`/api/object-types/${sourceType}`)
			.then(setSourceDetail)
			.catch(() => setSourceDetail(null));
	}, [sourceType]);

	useEffect(() => {
		if (!targetType) return setTargetDetail(null);
		api
			.get<ObjectTypeDetail>(`/api/object-types/${targetType}`)
			.then(setTargetDetail)
			.catch(() => setTargetDetail(null));
	}, [targetType]);

	if (!open) return null;

	async function create() {
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const created = await api.post<{
				matched: number;
				candidates: number;
				matchRatio: number;
			}>("/api/ontology/link-types", {
				apiName,
				label: label || apiName,
				sourceObjectType: sourceType,
				targetObjectType: targetType,
				sourceProperty,
				targetProperty,
				cardinality,
			});
			setResult({
				matched: created.matched,
				candidates: created.candidates,
				ratio: created.matchRatio,
			});
			onCreated();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const ready = apiName && sourceType && targetType && sourceProperty && targetProperty;

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="rp fn-window" role="dialog" aria-modal="true" aria-label="Draw a link">
				<header className="rp-head">
					<span className="rp-glyph" aria-hidden>
						↔
					</span>
					<div className="rp-heading">
						<div className="rp-kind">LINK TYPE</div>
						<h3 className="rp-title">Draw a link</h3>
					</div>
					<button className="icon-button" onClick={close} aria-label="Close">
						×
					</button>
				</header>

				<div className="fn-body">
					<p className="fn-lede">
						The pipeline finds links by probing the data. This one is your assertion that
						two columns refer to the same thing — so the join is{" "}
						<strong>measured before it is accepted</strong>, and you are told what share
						of rows actually resolve.
					</p>

					{error && <ErrorBanner error={error} />}

					<section className="fn-section">
						<h4>Identity</h4>
						<div className="fn-grid">
							<label className="fn-field">
								<span>API name</span>
								<input
									value={apiName}
									placeholder="orderPlacedByAccount"
									onChange={(e) => setApiName(e.target.value)}
								/>
							</label>
							<label className="fn-field">
								<span>Label</span>
								<input
									value={label}
									placeholder="Placed by account"
									onChange={(e) => setLabel(e.target.value)}
								/>
							</label>
						</div>
						<p className="fn-hint">
							camelCase, starting lowercase. It is fixed once created, like every other
							api name.
						</p>
					</section>

					<section className="fn-section">
						<h4>From</h4>
						<div className="fn-grid">
							<label className="fn-field">
								<span>Object type</span>
								<select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
									<option value="">— pick one —</option>
									{types.map((type) => (
										<option key={type.apiName} value={type.apiName}>
											{type.apiName}
										</option>
									))}
								</select>
							</label>
							<label className="fn-field">
								<span>Key property</span>
								<select
									value={sourceProperty}
									onChange={(e) => setSourceProperty(e.target.value)}
									disabled={!sourceDetail}
								>
									<option value="">— pick one —</option>
									{(sourceDetail?.properties ?? []).map((prop) => (
										<option key={prop.rid} value={prop.apiName}>
											{prop.apiName} ({prop.sqlColumn})
										</option>
									))}
								</select>
							</label>
						</div>
					</section>

					<section className="fn-section">
						<h4>To</h4>
						<div className="fn-grid">
							<label className="fn-field">
								<span>Object type</span>
								<select value={targetType} onChange={(e) => setTargetType(e.target.value)}>
									<option value="">— pick one —</option>
									{types.map((type) => (
										<option key={type.apiName} value={type.apiName}>
											{type.apiName}
										</option>
									))}
								</select>
							</label>
							<label className="fn-field">
								<span>Key property</span>
								<select
									value={targetProperty}
									onChange={(e) => setTargetProperty(e.target.value)}
									disabled={!targetDetail}
								>
									<option value="">— pick one —</option>
									{(targetDetail?.properties ?? []).map((prop) => (
										<option key={prop.rid} value={prop.apiName}>
											{prop.apiName} ({prop.sqlColumn})
										</option>
									))}
								</select>
							</label>
							<label className="fn-field">
								<span>Cardinality</span>
								<select value={cardinality} onChange={(e) => setCardinality(e.target.value)}>
									{CARDINALITIES.map((item) => (
										<option key={item} value={item}>
											{item}
										</option>
									))}
								</select>
							</label>
						</div>
					</section>

					{busy && <Spinner label="Measuring the join" />}

					{result && (
						<section className="fn-section">
							<h4>Measured</h4>
							{/* The number that decides whether this link is any good. A
							    partial join is reported plainly rather than rounded up. */}
							<div className="fn-scalar mono">
								{Math.round(result.ratio * 100)}%
							</div>
							<p className="fn-hint">
								{result.matched.toLocaleString()} of {result.candidates.toLocaleString()}{" "}
								non-null source values resolved to a row on the other side.
								{result.ratio < 0.5 && (
									<>
										{" "}
										<strong>
											Fewer than half resolve — check the key columns are really the same
											identifier.
										</strong>
									</>
								)}
							</p>
						</section>
					)}
				</div>

				<footer className="fn-foot">
					<div className="fn-foot-note">
						Replayed onto every future publish, so the pipeline will not overwrite it.
					</div>
					<div className="row" style={{ gap: 8 }}>
						<button className="ghost" onClick={close} disabled={busy}>
							{result ? "Done" : "Cancel"}
						</button>
						{!result && (
							<button className="primary" onClick={create} disabled={busy || !ready}>
								{busy ? "Measuring…" : "Create link"}
							</button>
						)}
					</div>
				</footer>
			</div>
		</div>
	);
}

export interface OntologyEdit {
	id: number;
	targetKind: string;
	targetRid: string;
	operation: string;
	payload: Record<string, unknown>;
	previous: Record<string, unknown>;
	isActive: boolean;
	createdBy: string;
	createdAt: string;
}

/**
 * Everything that has been changed, and a way back.
 *
 * Shown because the edits are replayed: a label nobody remembers changing will
 * keep re-appearing on every publish, and the only way to understand why is to
 * be able to see the journal that is doing it.
 */
export function EditJournal({
	edits,
	onUndo,
	busyId,
}: {
	edits: OntologyEdit[];
	onUndo: (edit: OntologyEdit) => void;
	busyId: number | null;
}) {
	if (edits.length === 0) {
		return (
			<p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
				Nothing has been edited in this space. Changes made here are replayed onto every
				ontology the pipeline publishes afterwards.
			</p>
		);
	}

	return (
		<ul className="ont-journal">
			{edits.map((edit) => (
				<li key={edit.id} className={edit.isActive ? "" : "withdrawn"}>
					<span className="chip mono">{edit.operation}</span>
					<span className="mono ont-journal-rid">{edit.targetRid}</span>
					<span className="muted ont-journal-what">
						{Object.keys(edit.payload).join(", ") || edit.targetKind}
					</span>
					<span className="muted">{edit.createdBy}</span>
					{edit.isActive ? (
						<button
							className="btn sm ghost"
							onClick={() => onUndo(edit)}
							disabled={busyId === edit.id}
							title="Revert this change, now and on every future publish"
						>
							{busyId === edit.id ? "…" : "Undo"}
						</button>
					) : (
						<span className="muted">withdrawn</span>
					)}
				</li>
			))}
		</ul>
	);
}
