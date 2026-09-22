/**
 * The review dialog for a proposed function.
 *
 * The assistant drafts a metric; this is where a person decides whether it
 * becomes real. So it has to show enough to decide on — the definition, what
 * it reads, what it returns — and it has to make the consequences of Approve
 * obvious, because after that the number appears on other people's dashboards.
 *
 * ── what is locked, and why ────────────────────────────────────────────────
 * The permanent id and the api name are shown but not editable. Everything
 * that will ever reference this function does so by one of them, so changing
 * one later would silently repoint or break every dashboard using it. They are
 * rendered as locked fields rather than hidden: the reviewer should see the
 * handle they are approving, and see that it is fixed.
 *
 * The lock is cosmetic here on purpose. `readOnly` is a hint to a browser, not
 * a rule — the server refuses to write either field, and that is where the
 * guarantee lives. This is the part that tells the user.
 */

import { useCallback, useEffect, useState } from "react";
import { type FunctionRecord, type FunctionResult, api, formatValue } from "../../api";
import { DataTable, ErrorBanner, Spinner } from "../common";

/** Fields the reviewer may change before approving. */
interface Draft {
	name: string;
	description: string;
	businessQuestion: string;
	definition: string;
	unit: string;
	valueFormat: string;
}

const VALUE_FORMATS = [
	"number",
	"integer",
	"currency",
	"percent",
	"duration_hours",
	"duration_days",
	"weight_kg",
	"distance_km",
];

export function FunctionReview({
	apiName,
	onClose,
	onApproved,
}: {
	apiName: string | null;
	onClose: () => void;
	onApproved?: (fn: FunctionRecord) => void;
}) {
	const [fn, setFn] = useState<FunctionRecord | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [preview, setPreview] = useState<FunctionResult | null>(null);

	useEffect(() => {
		if (!apiName) return;
		setFn(null);
		setDraft(null);
		setError(null);
		setPreview(null);
		api
			.get<FunctionRecord>(`/api/functions/${apiName}`)
			.then((record) => {
				setFn(record);
				setDraft({
					name: record.name,
					description: record.description ?? "",
					businessQuestion: record.businessQuestion ?? "",
					definition: record.definition,
					unit: record.unit ?? "",
					valueFormat: record.valueFormat,
				});
			})
			.catch((exc: Error) => setError(exc.message));
	}, [apiName]);

	const close = useCallback(() => onClose(), [onClose]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	if (!apiName) return null;

	const edited =
		fn !== null &&
		draft !== null &&
		(draft.name !== fn.name ||
			draft.description !== (fn.description ?? "") ||
			draft.businessQuestion !== (fn.businessQuestion ?? "") ||
			draft.definition !== fn.definition ||
			draft.unit !== (fn.unit ?? "") ||
			draft.valueFormat !== fn.valueFormat);

	async function saveEdits(): Promise<FunctionRecord | null> {
		if (!fn || !draft || !edited) return fn;
		const updated = await api.patch<FunctionRecord>(`/api/functions/${fn.apiName}`, draft);
		setFn(updated);
		return updated;
	}

	async function runPreview() {
		if (!fn) return;
		setBusy("preview");
		setError(null);
		try {
			await saveEdits();
			// preview=true lets a proposal run so the reviewer can see the number
			// before approving. It still cannot back a dashboard.
			const result = await api.post<FunctionResult>(
				`/api/functions/${fn.apiName}/run?preview=true`,
			);
			setPreview(result);
			if (result.status === "failed") setError(result.error ?? "The function failed to run.");
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function approve() {
		if (!fn) return;
		setBusy("approve");
		setError(null);
		try {
			await saveEdits();
			const approved = await api.post<FunctionRecord>(`/api/functions/${fn.apiName}/approve`);
			setFn(approved);
			onApproved?.(approved);
			close();
		} catch (exc) {
			setError((exc as Error).message);
			setBusy(null);
		}
	}

	async function decide(action: "reject" | "archive") {
		if (!fn) return;
		setBusy(action);
		try {
			await api.post<FunctionRecord>(`/api/functions/${fn.apiName}/${action}`);
			close();
		} catch (exc) {
			setError((exc as Error).message);
			setBusy(null);
		}
	}

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="rp fn-window" role="dialog" aria-modal="true" aria-label="Review function">
				<header className="rp-head">
					<span className="rp-glyph" aria-hidden>
						ƒ
					</span>
					<div className="rp-heading">
						<div className="rp-kind">
							FUNCTION · {fn ? fn.status.toUpperCase() : "LOADING"}
						</div>
						<h3 className="rp-title">{fn?.name ?? "Loading…"}</h3>
					</div>
					<button className="icon-button" onClick={close} aria-label="Close">
						×
					</button>
				</header>

				{!fn || !draft ? (
					error ? (
						<ErrorBanner error={error} />
					) : (
						<Spinner label="Loading function" />
					)
				) : (
					<div className="fn-body">
						{fn.status === "proposed" && (
							<p className="fn-lede">
								The assistant drafted this because no published metric answered the
								question. It computes nothing and no dashboard can use it until you
								approve it.
							</p>
						)}

						{error && <ErrorBanner error={error} />}

						{/* ── identity: shown, never editable ───────────────────── */}
						<section className="fn-section">
							<h4>Identity</h4>
							<p className="fn-hint">
								Fixed when the function was created. Everything that uses this
								function refers to it by these, so they cannot be changed.
							</p>
							<div className="fn-grid">
								<label className="fn-field locked">
									<span>
										Function ID <em>locked</em>
									</span>
									<input value={fn.rid} readOnly disabled />
								</label>
								<label className="fn-field locked">
									<span>
										API name <em>locked</em>
									</span>
									<input value={fn.apiName} readOnly disabled />
								</label>
								<label className="fn-field locked">
									<span>
										Language <em>locked</em>
									</span>
									<input value={fn.language} readOnly disabled />
								</label>
								<label className="fn-field locked">
									<span>
										Returns <em>locked</em>
									</span>
									<input value={fn.returns} readOnly disabled />
								</label>
							</div>
						</section>

						{/* ── the editable description ──────────────────────────── */}
						<section className="fn-section">
							<h4>Description</h4>
							<div className="fn-grid">
								<label className="fn-field wide">
									<span>Name</span>
									<input
										value={draft.name}
										onChange={(e) => setDraft({ ...draft, name: e.target.value })}
									/>
								</label>
								<label className="fn-field wide">
									<span>What it measures</span>
									<textarea
										rows={2}
										value={draft.description}
										onChange={(e) => setDraft({ ...draft, description: e.target.value })}
									/>
								</label>
								<label className="fn-field wide">
									<span>Business question it answers</span>
									<input
										value={draft.businessQuestion}
										onChange={(e) =>
											setDraft({ ...draft, businessQuestion: e.target.value })
										}
									/>
								</label>
								<label className="fn-field">
									<span>Unit</span>
									<input
										value={draft.unit}
										placeholder="km, hours, USD…"
										onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
									/>
								</label>
								<label className="fn-field">
									<span>Format</span>
									<select
										value={draft.valueFormat}
										onChange={(e) => setDraft({ ...draft, valueFormat: e.target.value })}
									>
										{VALUE_FORMATS.map((format) => (
											<option key={format} value={format}>
												{format}
											</option>
										))}
									</select>
								</label>
							</div>
						</section>

						{/* ── the definition, which is the thing being approved ─── */}
						<section className="fn-section">
							<h4>Definition</h4>
							<p className="fn-hint">
								A single read-only SELECT. It is re-checked against the published
								ontology when you approve.
							</p>
							<textarea
								className="fn-sql mono"
								rows={7}
								spellCheck={false}
								value={draft.definition}
								onChange={(e) => setDraft({ ...draft, definition: e.target.value })}
							/>
						</section>

						<section className="fn-section">
							<h4>Reads</h4>
							<div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
								{fn.readsViews.length === 0 ? (
									<span className="muted">No view detected.</span>
								) : (
									fn.readsViews.map((view) => (
										<span className="chip mono" key={view}>
											{view}
										</span>
									))
								)}
							</div>
							{fn.proposedFrom && (
								<p className="fn-hint" style={{ marginTop: 8 }}>
									Proposed by <strong>{fn.proposedBy}</strong> from: “{fn.proposedFrom}”
								</p>
							)}
						</section>

						{/* ── what it actually returns ──────────────────────────── */}
						{preview && preview.status === "success" && (
							<section className="fn-section">
								<h4>
									Result <span className="muted">· {preview.rowCount} rows · {preview.durationMs}ms</span>
								</h4>
								{preview.returns === "scalar" ? (
									/* Formatted per the function's own declaration. Postgres returns
									   an aggregate as a full-precision numeric string, and showing
									   1562.5906557377049180 km invites the reader to believe the
									   metric is that precise. */
									<div className="fn-scalar mono">
										{formatValue(
											preview.value === null || preview.value === undefined
												? null
												: Number(preview.value),
											draft.valueFormat,
											draft.unit || null,
										)}
									</div>
								) : (
									<DataTable
										// Columns come from the result itself: a function returns
										// whatever its SELECT projects, which is not known here.
										columns={Object.keys(preview.rows[0] ?? {}).map((key) => ({
											key,
											label: key,
											numeric: typeof preview.rows[0]?.[key] === "number",
										}))}
										rows={preview.rows.slice(0, 10)}
									/>
								)}
							</section>
						)}
					</div>
				)}

				{fn && (
					<footer className="fn-foot">
						<div className="fn-foot-note">
							{fn.status === "proposed" ? (
								<>
									Approving makes this usable in dashboards.
									{edited && <strong> Your edits are saved first.</strong>}
								</>
							) : (
								<>
									{fn.status === "active" && fn.approvedBy
										? `Approved by ${fn.approvedBy}.`
										: `This function is ${fn.status}.`}
								</>
							)}
						</div>
						<div className="row" style={{ gap: 8 }}>
							<button className="ghost" onClick={runPreview} disabled={busy !== null}>
								{busy === "preview" ? "Running…" : "Test run"}
							</button>
							{fn.status === "proposed" && (
								<>
									<button
										className="ghost danger"
										onClick={() => decide("reject")}
										disabled={busy !== null}
									>
										Reject
									</button>
									<button className="primary" onClick={approve} disabled={busy !== null}>
										{busy === "approve" ? "Approving…" : "Approve & create"}
									</button>
								</>
							)}
							{fn.status === "active" && (
								<button
									className="ghost danger"
									onClick={() => decide("archive")}
									disabled={busy !== null}
								>
									Archive
								</button>
							)}
						</div>
					</footer>
				)}
			</div>
		</div>
	);
}
