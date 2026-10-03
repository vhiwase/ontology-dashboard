/**
 * Platform defaults: what applies to everyone unless their account says
 * otherwise.
 *
 * Each setting shows where its current value comes from. One an administrator
 * has not set falls back to the server's environment and then to the built-in
 * default, so .env keeps working as before - and "Use the default" is the way
 * back to it. Nothing is saved until Save changes is pressed, and a form with
 * one bad field changes nothing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { ErrorBanner, Refusal, Spinner } from "../common";
import { Icon, type IconName } from "../icons";
import { type AdminSetting, type SettingValue, dateTime } from "./types";

interface Rates {
	[provider: string]: { inputPerMillion: number; outputPerMillion: number; source: string };
}

interface ProviderOption {
	id: string;
	label: string;
	model: string;
	available: boolean;
}

const GROUPS: Array<{ id: AdminSetting["group"]; title: string; note: string; icon: IconName }> = [
	{
		id: "assistant",
		title: "Assistant",
		note: "What the AI-FDE starts with for everyone.",
		icon: "bot",
	},
	{
		id: "credit",
		title: "AI credit",
		note: "How much each person may spend on the hosted model in a calendar month.",
		icon: "wallet",
	},
	{
		id: "pricing",
		title: "Pricing",
		note: "The rates a turn is priced at. Check them against an invoice: list prices are not your contract.",
		icon: "dollar",
	},
	{
		id: "registration",
		title: "Sign-up",
		note: "Who can create an account from the sign-in page.",
		icon: "userPlus",
	},
];

/** The settings typed as an amount, where an empty box means "not set". */
const AMOUNTS = new Set(["pricing.azureInputPerMillion", "pricing.azureOutputPerMillion", "credit.defaultMonthlyUsd"]);

type Form = Record<string, string | boolean>;

function initialForm(settings: AdminSetting[]): Form {
	const form: Form = {};
	for (const setting of settings) {
		if (AMOUNTS.has(setting.key)) form[setting.key] = setting.adminValue === null ? "" : String(setting.adminValue);
		else if (typeof setting.value === "boolean") form[setting.key] = setting.value;
		else form[setting.key] = String(setting.value ?? "");
	}
	return form;
}

function sourceWords(source: string): string {
	if (source === "environment") return "the server's environment (.env)";
	if (source === "assistant service") return "the assistant service";
	return "the built-in default";
}

export function SettingsPanel({ onChanged }: { onChanged: () => void }) {
	const [settings, setSettings] = useState<AdminSetting[] | null>(null);
	const [form, setForm] = useState<Form>({});
	// Selects and switches that were sent back to their default.
	const [cleared, setCleared] = useState<Set<string>>(new Set());
	const [rates, setRates] = useState<Rates | null>(null);
	const [models, setModels] = useState<ProviderOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	const adopt = useCallback((next: AdminSetting[]) => {
		setSettings(next);
		setForm(initialForm(next));
		setCleared(new Set());
	}, []);

	const loadRates = useCallback(() => {
		// Only to show what the assistant is charging right now; the page works
		// without it.
		api
			.get<{ rates: Rates }>("/api/assistant/costs?days=1")
			.then((body) => setRates(body.rates))
			.catch(() => setRates(null));
	}, []);

	useEffect(() => {
		api
			.get<{ settings: AdminSetting[] }>("/api/admin/settings")
			.then((body) => adopt(body.settings))
			.catch((exc: Error) => setError(exc.message));
		api
			.get<{ providers: ProviderOption[] }>("/api/assistant/providers")
			.then((body) => setModels(body.providers))
			.catch(() => setModels([]));
		loadRates();
	}, [adopt, loadRates]);

	/** What Save would send: only the settings that differ from what is stored. */
	const pending = useMemo(() => {
		const values: Record<string, SettingValue> = {};
		// By setting, so a value that cannot be saved is marked where it was typed.
		const problems: Record<string, string> = {};
		for (const setting of settings ?? []) {
			const typed = form[setting.key];
			if (AMOUNTS.has(setting.key)) {
				const text = String(typed ?? "").trim();
				if (text === "") {
					if (setting.adminValue !== null) values[setting.key] = null;
					continue;
				}
				const amount = Number(text);
				if (!Number.isFinite(amount) || amount < 0) problems[setting.key] = "Enter an amount, 0 or more.";
				else if (amount !== setting.adminValue) values[setting.key] = amount;
			} else if (cleared.has(setting.key)) {
				if (setting.adminValue !== null) values[setting.key] = null;
			} else if (typed !== undefined && typed !== setting.value) {
				values[setting.key] = typed;
			}
		}
		return { values, problems, count: Object.keys(values).length, blocked: Object.keys(problems).length > 0 };
	}, [settings, form, cleared]);

	async function save() {
		if (pending.blocked) return;
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			const body = await api.put<{ settings: AdminSetting[] }>("/api/admin/settings", { values: pending.values });
			adopt(body.settings);
			setSaved(true);
			loadRates();
			onChanged();
		} catch (exc) {
			setError((exc as Error).message);
		} finally {
			setSaving(false);
		}
	}

	if (!settings) {
		return error ? <ErrorBanner error={error} /> : <Spinner label="Loading the defaults" />;
	}

	const set = (key: string, value: string | boolean) => {
		setSaved(false);
		setForm((current) => ({ ...current, [key]: value }));
		setCleared((current) => {
			if (!current.has(key)) return current;
			const next = new Set(current);
			next.delete(key);
			return next;
		});
	};

	const backToDefault = (setting: AdminSetting) => {
		setSaved(false);
		setForm((current) => ({
			...current,
			[setting.key]: AMOUNTS.has(setting.key)
				? ""
				: typeof setting.fallback === "boolean"
					? setting.fallback
					: String(setting.fallback ?? ""),
		}));
		if (!AMOUNTS.has(setting.key)) setCleared((current) => new Set(current).add(setting.key));
	};

	const azure = rates?.azure_openai ?? null;

	/** What applies while this setting is not set here, in words. */
	const fallbackWords = (setting: AdminSetting): string => {
		if (setting.key === "pricing.azureInputPerMillion" || setting.key === "pricing.azureOutputPerMillion") {
			// The assistant reports the rate in force. While this half is set
			// here, that is this value rather than what it would fall back to.
			if (!azure || setting.adminValue !== null) return "the assistant service's own rate";
			const rate = setting.key === "pricing.azureInputPerMillion" ? azure.inputPerMillion : azure.outputPerMillion;
			// The two halves fall back separately, so the other being set here
			// says nothing about where this one comes from.
			return azure.source === "set by an administrator" ? `$${rate.toFixed(2)}` : `$${rate.toFixed(2)}, ${azure.source}`;
		}
		if (setting.key === "credit.defaultMonthlyUsd") return "no limit";
		if (typeof setting.fallback === "boolean") return setting.fallback ? "allowed" : "not allowed";
		if (setting.key === "assistant.defaultModel") return "Automatic";
		return String(setting.fallback ?? "nothing");
	};

	const control = (setting: AdminSetting) => {
		const value = form[setting.key];
		if (AMOUNTS.has(setting.key)) {
			const perMonth = setting.key === "credit.defaultMonthlyUsd";
			return (
				<span className="money-input">
					<span aria-hidden>$</span>
					<input
						id={`setting-${setting.key}`}
						type="number"
						min={0}
						step={perMonth ? "1" : "0.01"}
						inputMode="decimal"
						aria-invalid={setting.key in pending.problems || undefined}
						value={String(value ?? "")}
						placeholder={perMonth ? "No limit" : "Not set"}
						onChange={(event) => set(setting.key, event.target.value)}
					/>
					<span className="muted">{perMonth ? "per person, per month" : "per million tokens"}</span>
				</span>
			);
		}
		if (typeof setting.value === "boolean") {
			const on = value === true;
			return (
				<label className="switch">
					<input
						id={`setting-${setting.key}`}
						type="checkbox"
						role="switch"
						checked={on}
						onChange={(event) => set(setting.key, event.target.checked)}
					/>
					<span className="switch-track" aria-hidden>
						<span className="switch-thumb" />
					</span>
					<span>{on ? "Allowed" : "Not allowed"}</span>
				</label>
			);
		}
		if (setting.key === "assistant.defaultModel") {
			return (
				<select id={`setting-${setting.key}`} value={String(value ?? "auto")} onChange={(event) => set(setting.key, event.target.value)}>
					<option value="auto">Automatic - the best one available</option>
					{(models.length > 0
						? models
						: [
								{ id: "azure_openai", label: "Azure OpenAI", model: "", available: true },
								{ id: "builtin", label: "Built-in planner", model: "", available: true },
							]
					).map((option) => (
						<option key={option.id} value={option.id}>
							{option.label}
							{/* The hosted model's name says which one; the planner has none to name. */}
							{option.model && option.id !== "builtin" ? ` - ${option.model}` : ""}
							{option.available ? "" : " - unavailable right now"}
						</option>
					))}
				</select>
			);
		}
		return (
			<select id={`setting-${setting.key}`} value={String(value ?? "")} onChange={(event) => set(setting.key, event.target.value)}>
				<option value="viewer">Viewer - reads only</option>
				<option value="analyst">Analyst - reads, and uses the assistant</option>
			</select>
		);
	};

	return (
		<div className="col" style={{ gap: 14 }}>
			{error && <Refusal message={error} />}

			{GROUPS.map((group) => {
				const rows = settings.filter((setting) => setting.group === group.id);
				if (rows.length === 0) return null;
				return (
					<section className="card settings-group" key={group.id}>
						<div className="card-head">
							<span className="stage-icon" aria-hidden>
								<Icon name={group.icon} size={15} />
							</span>
							<div>
								<h3>{group.title}</h3>
								<p className="muted settings-group-note">{group.note}</p>
							</div>
						</div>
						{rows.map((setting) => {
							const changed = setting.key in pending.values;
							const setHere = setting.adminValue !== null && !cleared.has(setting.key);
							const amountEmpty = AMOUNTS.has(setting.key) && String(form[setting.key] ?? "").trim() === "";
							return (
								<div className={`setting-row ${changed ? "changed" : ""}`} key={setting.key}>
									<div className="setting-text">
										<label htmlFor={`setting-${setting.key}`} className="setting-label">
											{setting.label}
											{changed && <span className="chip warn">Not saved</span>}
										</label>
										<p className="muted">{setting.description}</p>
										<p className="setting-source">
											{setHere && !amountEmpty ? (
												<>
													Set here
													{setting.updatedBy ? ` by ${setting.updatedBy}` : ""}
													{setting.updatedAt ? ` on ${dateTime(setting.updatedAt)}` : ""}.{" "}
													<button type="button" className="link-button" onClick={() => backToDefault(setting)}>
														Use the default instead ({fallbackWords(setting)})
													</button>
												</>
											) : (
												<>
													Not set here: {fallbackWords(setting)}, from {sourceWords(setting.fallbackSource)}.
												</>
											)}
										</p>
									</div>
									<div className="setting-control">
										{control(setting)}
										{pending.problems[setting.key] && (
											<p className="field-hint warn" role="alert">
												{pending.problems[setting.key]}
											</p>
										)}
									</div>
								</div>
							);
						})}
					</section>
				);
			})}

			<div className={`save-bar ${pending.count > 0 ? "dirty" : ""}`}>
				<span className={saved && pending.count === 0 && !pending.blocked ? "save-bar-ok" : "muted"} role="status">
					{pending.blocked
						? "One value cannot be saved as it is. Correct it, or discard the changes."
						: pending.count > 0
							? `${pending.count} change${pending.count === 1 ? "" : "s"} not saved yet.`
							: saved
								? "Saved. It applies within a few seconds, with no restart."
								: "Everything is saved."}
				</span>
				<button
					className="btn ghost"
					disabled={(pending.count === 0 && !pending.blocked) || saving}
					onClick={() => {
						setError(null);
						setForm(initialForm(settings));
						setCleared(new Set());
					}}
				>
					Discard
				</button>
				<button className="btn primary" disabled={pending.count === 0 || pending.blocked || saving} onClick={() => void save()}>
					{saving ? <span className="spinner" aria-hidden /> : <Icon name="check" size={15} />}
					{saving ? "Saving…" : "Save changes"}
				</button>
			</div>
		</div>
	);
}
