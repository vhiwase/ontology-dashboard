/**
 * Deleting something, after being shown what goes with it.
 *
 * Every page that lists things deletes them through this one window. It asks
 * the server what the delete would take with it (see removal.ts there) and
 * shows the answer in three parts, because they are three different things to
 * agree to:
 *
 *   - what is part of it and goes with it;
 *   - what is built on it, which is deleted too - said on the button, with the
 *     count, so "Delete" never quietly means "delete seven things";
 *   - what stays and will not be the same.
 *
 * Nothing is deleted until the red button is pressed, and the keyboard starts
 * on the other one.
 */

import { useEffect, useState } from "react";
import { api, session } from "../api";
import { useSpace } from "../SpaceContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { Spinner } from "./common";
import { Icon, type IconName } from "./icons";

export type RemovableKind =
	| "connection"
	| "dataset"
	| "sync"
	| "schedule"
	| "objectType"
	| "linkType"
	| "actionType"
	| "metric"
	| "function"
	| "dashboard"
	| "proposal";

export interface RemovalItem {
	kind: string;
	name: string;
	note?: string;
}

export interface RemovalPlan {
	kind: RemovableKind;
	ref: string;
	name: string;
	removes: RemovalItem[];
	dependents: RemovalItem[];
	affects: RemovalItem[];
	refused: string | null;
}

/** What each kind is called in a sentence. */
const KIND_LABEL: Record<string, string> = {
	connection: "connection",
	dataset: "dataset",
	sync: "sync",
	schedule: "schedule",
	objectType: "object type",
	linkType: "link",
	actionType: "action",
	metric: "metric",
	function: "function",
	dashboard: "dashboard",
	proposal: "proposal",
	table: "table",
	view: "view",
};

const KIND_ICON: Record<string, IconName> = {
	connection: "database",
	dataset: "table",
	table: "table",
	view: "table",
	sync: "refresh",
	schedule: "clock",
	objectType: "box",
	linkType: "link",
	actionType: "zap",
	metric: "sigma",
	function: "fn",
	dashboard: "dashboard",
	proposal: "checkCircle",
};

export function kindLabel(kind: string): string {
	return KIND_LABEL[kind] ?? kind;
}

/**
 * Whether the person signed in may delete things in the space on screen: a
 * platform administrator anywhere, and anyone in their own workspace. The
 * server decides - this only keeps a button that would be refused off the page.
 */
export function useCanDelete(): boolean {
	const { isPersonal } = useSpace();
	return isPersonal || session.user()?.role === "admin";
}

/** "1 thing", "3 things". */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What to say once it is gone: "Deleted the dataset orders, and 3 things built on it." */
export function deletedNotice(plan: RemovalPlan, noun?: string): string {
	const built = plan.dependents.length;
	return `Deleted the ${noun ?? kindLabel(plan.kind)} ${plan.name}${built > 0 ? `, and ${count(built, "thing")} built on it` : ""}.`;
}

export function DeleteDialog({
	kind,
	target,
	label,
	noun,
	onClose,
	onDeleted,
}: {
	kind: RemovableKind;
	/** The id, api name or slug the server knows it by. */
	target: string | number;
	/** Shown until the server answers with the name it has on record. */
	label?: string;
	/** What to call it here, when the page has a better word ("report", "table"). */
	noun?: string;
	onClose: () => void;
	/** Called once it is gone, with what went. */
	onDeleted: (plan: RemovalPlan) => void;
}) {
	const [plan, setPlan] = useState<RemovalPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const what = noun ?? kindLabel(kind);
	const path = `/api/removal/${kind}/${encodeURIComponent(String(target))}`;

	useEffect(() => {
		let current = true;
		setPlan(null);
		setError(null);
		api
			.get<RemovalPlan>(path)
			.then((body) => {
				if (current) setPlan(body);
			})
			.catch((exc: Error) => {
				if (current) setError(exc.message);
			});
		return () => {
			current = false;
		};
	}, [path]);

	async function remove() {
		if (!plan) return;
		setBusy(true);
		setError(null);
		try {
			const done = await api.del<RemovalPlan>(`${path}${plan.dependents.length > 0 ? "?cascade=true" : ""}`);
			onDeleted(done ?? plan);
		} catch (exc) {
			// Still here, so the reason is shown where the decision was made.
			setError((exc as Error).message);
			setBusy(false);
		}
	}

	const name = plan?.name ?? label ?? "";
	const blocked = plan?.refused ?? null;
	const built = plan?.dependents.length ?? 0;

	return (
		<ConfirmDialog
			title={`Delete ${what}${name ? ` “${name}”` : ""}?`}
			icon="trash"
			cancelLabel={blocked || (!plan && error) ? "Close" : "Keep it"}
			busy={busy}
			onCancel={onClose}
			choices={
				plan && !blocked
					? [
							{
								label: busy
									? "Deleting…"
									: built > 0
										? `Delete it and ${count(built, "thing")} built on it`
										: `Delete this ${what}`,
								tone: "danger",
								onSelect: () => void remove(),
							},
						]
					: []
			}
		>
			{!plan && !error && <Spinner label="Checking what this would remove" />}
			{error && (
				<div className="banner error" role="alert">
					{error}
				</div>
			)}
			{plan && blocked && <p>{blocked}</p>}
			{plan && !blocked && (
				<>
					<RemovalList
						title="Deleted with it"
						items={plan.removes}
						tone="danger"
					/>
					<RemovalList
						title={`Built on it — deleted too (${plan.dependents.length})`}
						items={plan.dependents}
						tone="danger"
					/>
					<RemovalList title="Kept, but affected" items={plan.affects} tone="warn" />
					{plan.removes.length + plan.dependents.length + plan.affects.length === 0 && (
						<p>Nothing else is built on it or removed with it.</p>
					)}
					<p className="muted removal-foot">This cannot be undone.</p>
				</>
			)}
		</ConfirmDialog>
	);
}

function RemovalList({ title, items, tone }: { title: string; items: RemovalItem[]; tone: "danger" | "warn" }) {
	if (items.length === 0) return null;
	return (
		<section className={`removal-group ${tone}`}>
			<h3>{title}</h3>
			<ul>
				{items.map((item) => (
					<li key={`${item.kind}:${item.name}`}>
						<span className="removal-kind" aria-hidden>
							<Icon name={KIND_ICON[item.kind] ?? "box"} size={13} />
						</span>
						<span>
							{KIND_LABEL[item.kind] && <span className="removal-kind-label">{KIND_LABEL[item.kind]} </span>}
							<strong>{item.name}</strong>
							{item.note && <span className="removal-note"> — {item.note}</span>}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The button that opens it: the same on every page. */
export function DeleteButton({
	onClick,
	label = "Delete",
	title,
	iconOnly = false,
	disabled = false,
}: {
	onClick: () => void;
	label?: string;
	title?: string;
	/** In a dense row: the bin alone, named for screen readers by `title`. */
	iconOnly?: boolean;
	disabled?: boolean;
}) {
	if (iconOnly) {
		return (
			<button
				type="button"
				className="icon-btn row-delete"
				onClick={onClick}
				title={title ?? label}
				aria-label={title ?? label}
				disabled={disabled}
			>
				<Icon name="trash" size={14} />
			</button>
		);
	}
	return (
		<button type="button" className="btn sm ghost danger" onClick={onClick} title={title} disabled={disabled}>
			<Icon name="trash" size={13} />
			{label}
		</button>
	);
}
