/**
 * Confirming a pipeline delete, and choosing which of its outputs go with it.
 *
 * A pipeline's runs write real tables into pipeline_out. Deleting the pipeline
 * used to leave them behind: nothing referenced them any more, but they kept
 * appearing wherever the database was listed, and nothing said where they had
 * come from.
 *
 * So the delete now shows every table the pipeline produced - which node made
 * it, how many rows, how big, when it was last built - with a checkbox each.
 * Only the ticked ones are dropped. The server drops nothing it is not
 * explicitly sent, so this list IS the decision, not a courtesy on top of one.
 *
 * All outputs start ticked, because deleting a pipeline and keeping its
 * results is the unusual case. A table that something else still points at is
 * called out, since dropping it leaves that thing with nothing to read.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { ErrorBanner, Spinner } from "../common";

export interface PipelineOutput {
	table: string;
	nodeId: string | null;
	nodeName: string | null;
	nodeKind: string | null;
	rowCount: number | null;
	size: string | null;
	lastBuiltAt: string | null;
	referencedBy: string[];
}

interface DeleteResult {
	deleted: string;
	droppedOutputs: string[];
	keptOutputs: string[];
}

export function DeletePipelineDialog({
	slug,
	name,
	onClose,
	onDeleted,
}: {
	/** Null keeps the dialog closed. */
	slug: string | null;
	name: string;
	onClose: () => void;
	onDeleted: (result: DeleteResult) => void;
}) {
	const [outputs, setOutputs] = useState<PipelineOutput[] | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!slug) return;
		setOutputs(null);
		setError(null);
		api
			.get<PipelineOutput[]>(`/api/pipelines/${slug}/outputs`)
			.then((list) => {
				setOutputs(list);
				setChosen(new Set(list.map((output) => output.table)));
			})
			.catch((exc: Error) => setError(exc.message));
	}, [slug]);

	const close = useCallback(() => {
		if (!busy) onClose();
	}, [busy, onClose]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	if (!slug) return null;

	function toggle(table: string) {
		setChosen((current) => {
			const next = new Set(current);
			if (next.has(table)) next.delete(table);
			else next.add(table);
			return next;
		});
	}

	async function confirm() {
		if (!slug) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.del<DeleteResult>(`/api/pipelines/${slug}`, {
				outputs: [...chosen],
			});
			onDeleted(result);
		} catch (exc) {
			setError((exc as Error).message);
			setBusy(false);
		}
	}

	const all = outputs ?? [];
	const allChosen = all.length > 0 && chosen.size === all.length;
	const rowsDropped = all
		.filter((output) => chosen.has(output.table))
		.reduce((sum, output) => sum + (output.rowCount ?? 0), 0);

	return (
		<div
			className="rp-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="rp fn-window" role="alertdialog" aria-modal="true" aria-label="Delete pipeline">
				<header className="rp-head">
					<span className="rp-glyph dp-warn-glyph" aria-hidden>
						⚠
					</span>
					<div className="rp-heading">
						<div className="rp-kind">DELETE PIPELINE</div>
						<h3 className="rp-title">{name}</h3>
					</div>
					<button className="icon-button" onClick={close} aria-label="Close" disabled={busy}>
						×
					</button>
				</header>

				<div className="fn-body">
					<p className="dp-warning">
						This deletes the pipeline, its version history and its run records. It cannot be
						undone. Choose below which of the tables it produced are dropped with it — only
						the ticked ones are deleted.
					</p>

					{error && <ErrorBanner error={error} />}

					{!outputs && !error ? (
						<Spinner label="Finding the tables this pipeline produced" />
					) : all.length === 0 ? (
						<p className="muted" style={{ fontSize: 12, margin: 0 }}>
							This pipeline has not produced any tables, so only the pipeline itself is
							deleted.
						</p>
					) : (
						<section className="fn-section">
							<div className="dp-list-head">
								<label className="dp-check">
									<input
										type="checkbox"
										checked={allChosen}
										ref={(element) => {
											// The mixed state when some, not all, are ticked.
											if (element) element.indeterminate = chosen.size > 0 && !allChosen;
										}}
										onChange={() =>
											setChosen(allChosen ? new Set() : new Set(all.map((o) => o.table)))
										}
									/>
									<span>
										{chosen.size} of {all.length} output{all.length === 1 ? "" : "s"} selected
									</span>
								</label>
							</div>

							<ul className="dp-list">
								{all.map((output) => {
									const ticked = chosen.has(output.table);
									return (
										<li key={output.table} className={ticked ? "ticked" : ""}>
											<label className="dp-check">
												<input
													type="checkbox"
													checked={ticked}
													onChange={() => toggle(output.table)}
												/>
												<span className="dp-table mono">{output.table}</span>
											</label>
											<div className="dp-meta">
												<span>
													{output.nodeName
														? `from ${output.nodeName}`
														: "no run record - found by name"}
												</span>
												<span className="mono">
													{output.rowCount === null
														? "? rows"
														: `${output.rowCount.toLocaleString()} rows`}
												</span>
												{output.size && <span className="mono">{output.size}</span>}
												{output.lastBuiltAt && (
													<span>built {output.lastBuiltAt.slice(0, 16).replace("T", " ")}</span>
												)}
											</div>
											{output.referencedBy.length > 0 && (
												<p className="dp-ref">
													Still referenced by {output.referencedBy.join(", ")}. Dropping it leaves
													that with nothing to read.
												</p>
											)}
										</li>
									);
								})}
							</ul>
						</section>
					)}
				</div>

				<footer className="fn-foot">
					<div className="fn-foot-note">
						{all.length === 0
							? "The pipeline is deleted."
							: chosen.size === 0
								? "No tables will be dropped; they stay in pipeline_out."
								: `${chosen.size} table${chosen.size === 1 ? "" : "s"} and ${rowsDropped.toLocaleString()} rows will be dropped.`}
					</div>
					<div className="row" style={{ gap: 8 }}>
						<button className="ghost" onClick={close} disabled={busy}>
							Cancel
						</button>
						<button className="danger" onClick={confirm} disabled={busy || (!outputs && !error)}>
							{busy
								? "Deleting…"
								: chosen.size > 0
									? `Delete pipeline and ${chosen.size} output${chosen.size === 1 ? "" : "s"}`
									: "Delete pipeline only"}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
