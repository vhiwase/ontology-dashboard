/**
 * Connect a PostgreSQL database and turn its tables into a model, in one flow.
 *
 *   1. Where it is      host, database, credentials - tested before anything is saved
 *   2. What to bring    the tables the connection's user can read, with their sizes
 *   3. Bring them in    each table is synced, its keys are read, and the lot is
 *                       modelled: object types, the links between them, metrics
 *
 * The password goes to the workspace's encrypted vault; the connection keeps
 * only a reference to it. Nothing is ever written to the source database.
 */

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type RemoteRelation, api } from "../api";
import { useSpace } from "../SpaceContext";

interface ConnectionTest {
	ok: boolean;
	latencyMs: number;
	detail: string;
	serverVersion?: string | null;
}

interface ImportOutcome {
	connection: string;
	tables: Array<{ source: string; status: string; rows: number; truncated: boolean; error?: string | null }>;
	model: {
		objectTypes: Array<{ apiName: string; label: string; rowCount: number; properties: number }>;
		links: Array<{ apiName: string; label?: string; source?: string; target?: string; matchRatio?: number }>;
		metrics: Array<{ apiName: string; label: string }>;
		warnings: string[];
	} | null;
}

type Step = "details" | "tables" | "importing" | "done";

export function ConnectWizard({
	onClose,
	onImported,
	existing,
}: {
	onClose: () => void;
	/** Called once tables are imported, so the caller can refresh. */
	onImported?: () => void;
	/** Import more tables through a connection that already exists. */
	existing?: { id: number; name: string } | null;
}) {
	const { spaceSlug, reload } = useSpace();
	const navigate = useNavigate();
	const [step, setStep] = useState<Step>(existing ? "tables" : "details");
	const [form, setForm] = useState({
		name: "My database",
		host: "",
		port: "5432",
		database: "",
		username: "",
		password: "",
		sslMode: "prefer",
	});
	const [test, setTest] = useState<ConnectionTest | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [connection, setConnection] = useState<{ id: number; name: string } | null>(existing ?? null);
	const [relations, setRelations] = useState<RemoteRelation[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

	const spec = () => ({
		engine: "postgresql",
		name: form.name.trim() || "My database",
		host: form.host.trim(),
		port: Number(form.port) || 5432,
		database: form.database.trim(),
		username: form.username.trim(),
		password: form.password,
		sslMode: form.sslMode,
	});

	const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
		setForm((current) => ({ ...current, [key]: event.target.value }));
		setTest(null);
	};

	async function runTest() {
		setBusy(true);
		setError(null);
		try {
			setTest(await api.post<ConnectionTest>("/api/spaces/connections/test", spec()));
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function connect(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const projects = await api.get<Array<{ slug: string }>>(`/api/spaces/${spaceSlug}/projects`);
			const project = projects[0]?.slug ?? "workspace";
			const created = await api.post<{ resource: { id: number; name: string }; test: ConnectionTest }>(
				`/api/spaces/${spaceSlug}/projects/${project}/connections`,
				spec(),
			);
			setTest(created.test);
			if (!created.test.ok) {
				setError(`Saved, but the database did not answer: ${created.test.detail}`);
			}
			setConnection({ id: created.resource.id, name: created.resource.name });
			setStep("tables");
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	// The tables this connection's user can read, asked of the source itself.
	useEffect(() => {
		if (step !== "tables" || !connection) return;
		setRelations(null);
		api
			.get<{ relations: RemoteRelation[]; note: string | null }>(`/api/resources/${connection.id}/catalog`)
			.then((catalog) => {
				setRelations(catalog.relations);
				// Base tables preselected; views are offered but left to the person.
				setSelected(
					new Set(
						catalog.relations
							.filter((relation) => relation.kind === "table" || relation.kind === "r")
							.map((relation) => `${relation.schema}.${relation.name}`),
					),
				);
			})
			.catch((exc: Error) => setError(exc.message));
	}, [step, connection]);

	const visible = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return (relations ?? []).filter((relation) =>
			needle ? `${relation.schema}.${relation.name}`.toLowerCase().includes(needle) : true,
		);
	}, [relations, filter]);

	async function importTables() {
		if (!connection) return;
		setStep("importing");
		setError(null);
		try {
			const tables = [...selected].map((key) => {
				const [schema, ...rest] = key.split(".");
				return { schema, table: rest.join(".") };
			});
			const result = await api.post<ImportOutcome>(`/api/resources/${connection.id}/import`, { tables });
			setOutcome(result);
			setStep("done");
			reload();
			onImported?.();
		} catch (exc) {
			setError((exc as Error).message);
			setStep("tables");
		}
	}

	async function autoDashboard() {
		setBusy(true);
		try {
			const board = await api.post<{ slug: string }>("/api/workspace/auto-dashboard", { kind: "dashboard" });
			onClose();
			navigate(`/dashboards/${board.slug}`);
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const toggle = (key: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && step !== "importing") onClose();
			}}
		>
			<div className="modal wizard" role="dialog" aria-label="Connect a database">
				<header className="modal-head">
					<div>
						<h2>{existing ? `Import more from ${existing.name}` : "Connect your database"}</h2>
						<ol className="stepper" aria-label="Progress">
							{(["details", "tables", "done"] as const).map((item, index) => {
								const order = { details: 0, tables: 1, importing: 2, done: 2 }[step];
								return (
									<li key={item} className={index < order ? "done" : index === order ? "current" : ""}>
										<span className="step-dot">{index < order ? "✓" : index + 1}</span>
										{item === "details" ? "Connect" : item === "tables" ? "Choose tables" : "Model"}
									</li>
								);
							})}
						</ol>
					</div>
					<button className="btn sm ghost" onClick={onClose} aria-label="Close" disabled={step === "importing"}>
						✕
					</button>
				</header>

				{step === "details" && (
					<form className="modal-body" onSubmit={connect}>
						<p className="muted" style={{ marginTop: 0 }}>
							Read-only access is all that is needed: tables are copied into your workspace and nothing is
							ever written back. The password is kept in your workspace's encrypted vault.
						</p>
						<div className="form-grid">
							<label className="field span-2">
								<span>Name</span>
								<input value={form.name} onChange={set("name")} required />
							</label>
							<label className="field">
								<span>Host</span>
								<input value={form.host} onChange={set("host")} placeholder="db.example.com" required />
							</label>
							<label className="field">
								<span>Port</span>
								<input value={form.port} onChange={set("port")} inputMode="numeric" required />
							</label>
							<label className="field">
								<span>Database</span>
								<input value={form.database} onChange={set("database")} placeholder="sales" required />
							</label>
							<label className="field">
								<span>SSL</span>
								<select value={form.sslMode} onChange={set("sslMode")}>
									<option value="prefer">Prefer</option>
									<option value="require">Require</option>
									<option value="disable">Disable</option>
								</select>
							</label>
							<label className="field">
								<span>Username</span>
								<input value={form.username} onChange={set("username")} autoComplete="off" required />
							</label>
							<label className="field">
								<span>Password</span>
								<input
									type="password"
									value={form.password}
									onChange={set("password")}
									autoComplete="new-password"
								/>
							</label>
						</div>
						{test && (
							<div className={`test-result ${test.ok ? "ok" : "fail"}`} role="status">
								{test.ok ? "✓ Connected" : "✕ Could not connect"} · {test.ok ? test.serverVersion : test.detail}
								{test.ok ? ` · ${test.latencyMs} ms` : ""}
							</div>
						)}
						{error && <div className="banner error">{error}</div>}
						<footer className="modal-foot">
							<button type="button" className="btn" disabled={busy || !form.host || !form.database} onClick={() => void runTest()}>
								{busy ? "Testing…" : "Test connection"}
							</button>
							<button type="submit" className="btn primary" disabled={busy || !form.host || !form.database || !form.username}>
								Save and choose tables
							</button>
						</footer>
					</form>
				)}

				{step === "tables" && (
					<div className="modal-body">
						{!relations && !error && (
							<p className="row muted">
								<span className="spinner" aria-hidden /> Reading the tables {connection?.name} can see…
							</p>
						)}
						{relations && relations.length === 0 && (
							<div className="banner">
								This user cannot read any tables in that database. Grant it SELECT on the tables you want to
								report on, then try again.
							</div>
						)}
						{relations && relations.length > 0 && (
							<>
								<div className="row" style={{ marginBottom: 8 }}>
									<input
										className="search-input"
										placeholder="Filter tables…"
										value={filter}
										onChange={(event) => setFilter(event.target.value)}
									/>
									<button className="btn sm" onClick={() => setSelected(new Set(visible.map((r) => `${r.schema}.${r.name}`)))}>
										Select all
									</button>
									<button className="btn sm" onClick={() => setSelected(new Set())}>
										None
									</button>
									<span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
										{selected.size} of {relations.length} selected
									</span>
								</div>
								<div className="table-picker">
									{visible.map((relation) => {
										const key = `${relation.schema}.${relation.name}`;
										return (
											<label key={key} className={`table-pick ${selected.has(key) ? "on" : ""}`}>
												<input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
												<span className="table-pick-name">
													{relation.name}
													<span className="muted"> · {relation.schema}</span>
												</span>
												<span className="muted num">
													{relation.estimatedRows !== null && relation.estimatedRows >= 0
														? `~${relation.estimatedRows.toLocaleString("en-US")} rows`
														: relation.kind}
												</span>
											</label>
										);
									})}
								</div>
							</>
						)}
						{error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
						<footer className="modal-foot">
							<span className="muted" style={{ fontSize: 12, marginRight: "auto" }}>
								Keys and foreign keys are read from the database, so related tables become linked types.
							</span>
							<button className="btn primary" disabled={selected.size === 0} onClick={() => void importTables()}>
								Import {selected.size} {selected.size === 1 ? "table" : "tables"}
							</button>
						</footer>
					</div>
				)}

				{step === "importing" && (
					<div className="modal-body importing">
						<span className="spinner lg" aria-hidden />
						<h3>Bringing your data in</h3>
						<p className="muted">
							Copying {selected.size} tables, reading their keys, and modelling customers, orders, products -
							whatever they hold - with the links between them. Usually a few seconds.
						</p>
					</div>
				)}

				{step === "done" && outcome && (
					<div className="modal-body">
						<div className="done-hero">
							<span className="done-mark" aria-hidden>
								✓
							</span>
							<div>
								<h3>Your data is ready</h3>
								<p className="muted" style={{ margin: 0 }}>
									{outcome.tables.filter((t) => t.status === "synced").length} tables imported ·{" "}
									{outcome.model?.objectTypes.length ?? 0} object types · {outcome.model?.links.length ?? 0} links ·{" "}
									{outcome.model?.metrics.length ?? 0} metrics
								</p>
							</div>
						</div>
						<div className="import-types">
							{(outcome.model?.objectTypes ?? []).map((type) => (
								<span key={type.apiName} className="chip">
									{type.label} <span className="muted num">{type.rowCount.toLocaleString("en-US")}</span>
								</span>
							))}
						</div>
						{outcome.tables.some((t) => t.status !== "synced") && (
							<div className="banner" style={{ marginTop: 10 }}>
								{outcome.tables
									.filter((t) => t.status !== "synced")
									.map((t) => `${t.source}: ${t.error ?? t.status}`)
									.join(" · ")}
							</div>
						)}
						{(outcome.model?.warnings.length ?? 0) > 0 && (
							<details style={{ marginTop: 10 }}>
								<summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
									{outcome.model?.warnings.length} notes from modelling
								</summary>
								<ul className="muted" style={{ fontSize: 12 }}>
									{outcome.model?.warnings.map((warning) => (
										<li key={warning}>{warning}</li>
									))}
								</ul>
							</details>
						)}
						{error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
						<footer className="modal-foot">
							<button className="btn" onClick={onClose}>
								Done
							</button>
							<button className="btn" disabled={busy} onClick={() => void autoDashboard()}>
								Build a dashboard for me
							</button>
							<button
								className="btn primary"
								onClick={() => {
									onClose();
									navigate(`/assistant?q=${encodeURIComponent("What charts, KPIs and dashboards can I build from my data?")}`);
								}}
							>
								See what I can build
							</button>
						</footer>
					</div>
				)}
			</div>
		</div>
	);
}
