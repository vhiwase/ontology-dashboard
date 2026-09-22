/**
 * Dashboard history: provenance, search, renaming and local backup.
 *
 * A dashboard the assistant built is the end of a conversation, and until now
 * that conversation was unreachable from the board it produced. This view
 * carries the link both ways, and adds the two operations that turn a
 * generated board into something someone owns: giving it a name of their own,
 * and keeping a copy that survives a `docker compose down -v`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, session } from "../api";
import { Empty, ErrorBanner, Spinner } from "../components/common";
import { useSpace } from "../SpaceContext";

interface RenameEntry {
	previousTitle: string;
	newTitle: string;
	renamedBy: string;
	renamedAt: string;
}

interface HistorySession {
	id: number;
	title: string | null;
	userId: string;
	messageCount: number;
	createdAt: string;
	available: boolean;
}

interface HistoryEntry {
	id: number;
	slug: string;
	title: string;
	description: string | null;
	layout: unknown[];
	isAiGenerated: boolean;
	sourcePrompt: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	isPinned: boolean;
	chatSessionId: number | null;
	session: HistorySession | null;
	renames: RenameEntry[];
}

interface ImportOutcome {
	imported: string[];
	skipped: Array<{ slug: string; reason: string }>;
}

type Origin = "all" | "ai" | "seeded" | "renamed";

function when(iso: string): string {
	if (!iso) return "—";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "—";
	const minutes = Math.round((Date.now() - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return new Date(then).toISOString().slice(0, 10);
}

export function DashboardHistory() {
	const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [origin, setOrigin] = useState<Origin>("all");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [draftTitle, setDraftTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const { spaceSlug } = useSpace();
	const role = session.user()?.role ?? "viewer";
	// Renaming and importing are writes; a viewer sees the history but cannot
	// change it, so the controls are hidden rather than shown and then rejected.
	const canWrite = role === "analyst" || role === "admin";

	const load = useCallback(() => {
		setError(null);
		api
			.get<HistoryEntry[]>(`/api/dashboards/history?space=${spaceSlug}`)
			.then(setEntries)
			.catch((exc: Error) => setError(exc.message));
	}, [spaceSlug]);

	useEffect(load, [load]);

	const filtered = useMemo(() => {
		if (!entries) return [];
		const needle = query.trim().toLowerCase();
		return entries.filter((entry) => {
			if (origin === "ai" && !entry.isAiGenerated) return false;
			if (origin === "seeded" && entry.createdBy !== "pipeline") return false;
			if (origin === "renamed" && entry.renames.length === 0) return false;
			if (!needle) return true;
			// Searches the prompt and the old names too: people look for a board
			// by what they asked for, or by what it used to be called.
			const haystack = [
				entry.title,
				entry.slug,
				entry.description ?? "",
				entry.sourcePrompt ?? "",
				entry.createdBy,
				...entry.renames.flatMap((r) => [r.previousTitle, r.newTitle]),
			]
				.join(" ")
				.toLowerCase();
			return haystack.includes(needle);
		});
	}, [entries, query, origin]);

	async function rename(slug: string) {
		const title = draftTitle.trim();
		if (!title) return;
		setBusy(true);
		setNotice(null);
		try {
			const updated = await api.post<{ slug: string; title: string }>(
				`/api/dashboards/${slug}/rename?space=${spaceSlug}`,
				{ title },
			);
			setRenaming(null);
			setNotice(`Renamed to “${updated.title}”. Its address is now /dashboards/${updated.slug}`);
			load();
		} catch (caught) {
			setNotice(caught instanceof ApiError ? caught.message : "Rename failed.");
		} finally {
			setBusy(false);
		}
	}

	async function exportAll() {
		setBusy(true);
		setNotice(null);
		try {
			const backup = await api.get<unknown>(`/api/dashboards/export?space=${spaceSlug}`);
			// Saved by the browser to wherever downloads go, so the copy lives on
			// the user's machine and survives the database being rebuilt.
			const blob = new Blob([JSON.stringify(backup, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `tms-dashboards-${new Date().toISOString().slice(0, 10)}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
			setNotice("Saved a backup to your downloads folder.");
		} catch (caught) {
			setNotice(caught instanceof ApiError ? caught.message : "Export failed.");
		} finally {
			setBusy(false);
		}
	}

	async function importFile(file: File, overwrite: boolean) {
		setBusy(true);
		setNotice(null);
		setOutcome(null);
		try {
			const backup = JSON.parse(await file.text());
			const result = await api.post<ImportOutcome>(
				`/api/dashboards/import?space=${spaceSlug}`,
				{ backup, overwrite },
			);
			setOutcome(result);
			setNotice(
				`Restored ${result.imported.length}, skipped ${result.skipped.length}.`,
			);
			load();
		} catch (caught) {
			setNotice(
				caught instanceof ApiError
					? caught.message
					: "That file could not be read as a dashboard backup.",
			);
		} finally {
			setBusy(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	}

	if (error) return <ErrorBanner error={error} onRetry={load} />;
	if (!entries) return <Spinner label="Loading dashboard history" />;

	return (
		<div className="col" style={{ gap: 14 }}>
			<div className="card">
				<div className="card-head">
					<h3>Dashboard history</h3>
					<span className="sub">
						{filtered.length === entries.length
							? `${entries.length} dashboards`
							: `${filtered.length} of ${entries.length}`}
					</span>
				</div>

				<div className="history-controls">
					<input
						className="search-input"
						type="search"
						value={query}
						placeholder="Search by name, description, prompt or previous name…"
						onChange={(event) => setQuery(event.target.value)}
						aria-label="Search dashboards"
					/>
					<div className="row" style={{ gap: 4 }}>
						{(["all", "ai", "seeded", "renamed"] as Origin[]).map((key) => (
							<button
								key={key}
								className={`btn sm ${origin === key ? "primary" : ""}`}
								onClick={() => setOrigin(key)}
							>
								{key === "all"
									? "All"
									: key === "ai"
										? "AI built"
										: key === "seeded"
											? "Starter"
											: "Renamed"}
							</button>
						))}
					</div>
					<div className="row" style={{ gap: 6, marginLeft: "auto" }}>
						<button className="btn sm" onClick={exportAll} disabled={busy}>
							Back up to file
						</button>
						{canWrite && (
							<>
								<button
									className="btn sm"
									onClick={() => fileRef.current?.click()}
									disabled={busy}
								>
									Restore…
								</button>
								<input
									ref={fileRef}
									type="file"
									accept="application/json,.json"
									style={{ display: "none" }}
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (!file) return;
										// Overwriting replaces boards that already exist, so it is
										// asked for rather than assumed.
										const overwrite = window.confirm(
											`Restore from ${file.name}?\n\n` +
												"OK — replace dashboards that already exist.\n" +
												"Cancel — keep existing ones and add only what is missing.",
										);
										void importFile(file, overwrite);
									}}
								/>
							</>
						)}
					</div>
				</div>

				{notice && (
					<div className="banner" style={{ marginTop: 10 }}>
						{notice}
					</div>
				)}

				{outcome && outcome.skipped.length > 0 && (
					<div className="banner warn" style={{ marginTop: 8 }}>
						<strong>Not restored:</strong>
						<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
							{outcome.skipped.map((item) => (
								<li key={item.slug}>
									<span className="mono">{item.slug}</span> — {item.reason}
								</li>
							))}
						</ul>
					</div>
				)}
			</div>

			{filtered.length === 0 ? (
				<Empty>
					{query
						? `No dashboard matches “${query}”.`
						: "No dashboards in this category yet."}
				</Empty>
			) : (
				<div className="col" style={{ gap: 8 }}>
					{filtered.map((entry) => (
						<div className="card history-row" key={entry.slug}>
							<div className="history-main">
								<div className="row" style={{ gap: 6, alignItems: "baseline" }}>
									{renaming === entry.slug ? (
										<form
											className="row"
											style={{ gap: 6 }}
											onSubmit={(event) => {
												event.preventDefault();
												void rename(entry.slug);
											}}
										>
											<input
												className="search-input"
												style={{ width: 280 }}
												value={draftTitle}
												autoFocus
												maxLength={120}
												onChange={(event) => setDraftTitle(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Escape") setRenaming(null);
												}}
												aria-label="New dashboard name"
											/>
											<button className="btn sm primary" type="submit" disabled={busy}>
												Save
											</button>
											<button
												className="btn sm"
												type="button"
												onClick={() => setRenaming(null)}
											>
												Cancel
											</button>
										</form>
									) : (
										<>
											<Link to={`/dashboards/${entry.slug}`} style={{ fontWeight: 500 }}>
												{entry.title}
											</Link>
											{entry.isPinned && <span className="chip">pinned</span>}
											{entry.isAiGenerated && <span className="chip">AI built</span>}
											{entry.createdBy === "pipeline" && (
												<span className="chip">starter</span>
											)}
											{canWrite && (
												<button
													className="btn sm"
													onClick={() => {
														setRenaming(entry.slug);
														setDraftTitle(entry.title);
														setNotice(null);
													}}
												>
													Rename
												</button>
											)}
										</>
									)}
								</div>

								<div className="muted history-meta">
									<span className="mono">/{entry.slug}</span>
									<span>{entry.layout.length} widgets</span>
									<span>by {entry.createdBy}</span>
									<span>updated {when(entry.updatedAt)}</span>
								</div>

								{entry.sourcePrompt && (
									<p className="history-prompt">“{entry.sourcePrompt}”</p>
								)}
							</div>

							<div className="history-side">
								{entry.session ? (
									entry.session.available ? (
										<Link to="/assistant" className="history-session">
											<span className="chip">session {entry.session.id}</span>
											<span className="muted">
												{entry.session.messageCount} messages · {entry.session.userId}
											</span>
										</Link>
									) : (
										// The board outlived its conversation, which the retention
										// policy is entitled to remove. Say that rather than
										// implying it never had one.
										<span className="muted" title="Removed by the chat retention policy">
											session {entry.session.id} · purged
										</span>
									)
								) : (
									<span className="muted">no conversation</span>
								)}

								{entry.renames.length > 0 && (
									<details className="history-renames">
										<summary>
											{entry.renames.length} rename
											{entry.renames.length === 1 ? "" : "s"}
										</summary>
										<ul>
											{entry.renames.map((r) => (
												<li key={`${r.renamedAt}-${r.newTitle}`}>
													<span className="muted">{r.previousTitle}</span> → {r.newTitle}
													<span className="muted"> · {r.renamedBy}, {when(r.renamedAt)}</span>
												</li>
											))}
										</ul>
									</details>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
