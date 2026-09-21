import { AccessController, ActionValidator } from "@ontograph/core";
import type { ActionType, OntologyDefinition } from "@ontograph/core";
import { query, queryOne } from "./db";
import {
	BadRequest,
	getRegistry,
	NotFound,
	type ActionTypeMeta,
	quoteIdentifier,
	quoteQualified,
	resolveObjectType,
} from "./registry";

/**
 * Action execution.
 *
 * Four things happen before anything else, in this order, and any one of them can
 * stop the request:
 *
 *   1. Parameter validation, via ontograph's ActionValidator against the
 *      declared ActionType.
 *   2. Role check, via ontograph's AccessController against the ontology's
 *      declared roles.
 *   3. Approval policy: an action that requires approval and whose
 *      autoApproveConditions are not met is queued, not run.
 *   4. The read-only gate.
 *
 * THE READ-ONLY GATE is the important one. Read-only actions (the what-ifs and
 * recalculations) genuinely execute and return computed results. Mutating actions
 * cannot: this platform reads the TMS through a captured snapshot and has no
 * write-back endpoint. Rather than pretend, a mutating action is validated,
 * permission-checked, recorded in the audit trail with the exact payload that
 * would be sent to the TMS, and returned as `staged`. A dashboard that says a
 * shipment was held when nothing was held is worse than one that says the request
 * was staged.
 */

export interface ExecuteContext {
	actor: string;
	actorRole: string;
	initiatedByAi: boolean;
	chatSessionId: number | null;
}

export interface ActionOutcome {
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

function actionDocument(meta: ActionTypeMeta): ActionType {
	const definition = getRegistry().definition;
	const found = (definition.actionTypes ?? []).find((a) => a["@id"] === meta.rid);
	if (!found) {
		throw new NotFound(`Action ${meta.rid} is registered but missing from the ontology document.`);
	}
	return found;
}

export function resolveAction(apiName: string): ActionTypeMeta {
	const registry = getRegistry();
	const exact = registry.actionTypeByApiName.get(apiName);
	if (exact) return exact;
	const lowered = apiName.toLowerCase();
	const found = registry.actionTypes.find((a) => a.apiName.toLowerCase() === lowered);
	if (found) return found;
	throw new NotFound(
		`Unknown action '${apiName}'. Available: ${registry.actionTypes.map((a) => a.apiName).join(", ")}`,
	);
}

export function validateParameters(
	meta: ActionTypeMeta,
	parameters: Record<string, unknown>,
): { valid: boolean; errors: Array<{ field: string; message: string }> } {
	const validator = new ActionValidator();
	const result = validator.validate(actionDocument(meta), parameters);
	const errors = (result.errors ?? []).map((e) => ({
		field: String(e.field ?? ""),
		message: String(e.message ?? "invalid"),
	}));

	// ActionValidator does not read the enum we carry in a custom validation rule,
	// so that check happens here. Without it an action would accept
	// holdReason: "banana" and the audit trail would record nonsense.
	for (const parameter of meta.parameters) {
		const name = String(parameter.name ?? "");
		const value = parameters[name];
		if (value === undefined || value === null) continue;
		const rules = (parameter.validation ?? []) as Array<Record<string, any>>;
		for (const rule of rules) {
			const allowed = rule?.value?.enum;
			if (Array.isArray(allowed) && !allowed.includes(value)) {
				errors.push({
					field: name,
					message: `'${String(value)}' is not allowed. Expected one of: ${allowed.join(", ")}`,
				});
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

function checkRole(
	meta: ActionTypeMeta,
	role: string,
	actor: string,
): { allowed: boolean; reason: string } {
	const definition: OntologyDefinition = getRegistry().definition;
	const roles = definition.roles ?? [];
	if (roles.length === 0) {
		return { allowed: true, reason: "No roles declared in the ontology." };
	}
	const known = roles.some((r) => r["@id"] === role);
	if (!known) {
		return {
			allowed: false,
			reason: `Role '${role}' is not declared. Declared roles: ${roles.map((r) => r["@id"]).join(", ")}`,
		};
	}

	// defaultPolicy must be "deny": AccessController allows unmatched requests by
	// default, which would mean any action nobody wrote a rule for is executable by
	// anyone. For an action layer the safe reading of "no rule" is "no".
	const controller = new AccessController({ defaultPolicy: "deny" });
	controller.registerRoles(roles);
	const check = controller.check(actor, [role], "execute", "actionType", meta.rid);
	if (check.allowed) {
		return {
			allowed: true,
			reason: check.matchedRule
				? `Permitted by ${check.matchedRule}.`
				: (check.reason ?? "Permitted by role rules."),
		};
	}

	// AccessController is authoritative. The allowed_roles list on the registry row
	// is the same information denormalised, so it only ever explains the refusal.
	return {
		allowed: false,
		reason:
			check.reason ??
			`Role '${role}' may not execute ${meta.apiName}. Permitted roles: ${
				meta.allowedRoles.join(", ") || "none"
			}`,
	};
}

/**
 * Evaluate the action's autoApproveConditions.
 *
 * The conditions are simple "<param> <op> <number>" comparisons, which is all the
 * declared policies use. Anything more complex is treated as NOT auto-approved -
 * failing closed is the only safe reading of an approval rule this code cannot
 * fully parse.
 */
function isAutoApproved(meta: ActionTypeMeta, parameters: Record<string, unknown>): boolean {
	const document = actionDocument(meta);
	const conditions = document.approvalPolicy?.autoApproveConditions ?? [];
	if (conditions.length === 0) return false;

	return conditions.every((condition) => {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<|>|==|!=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
			condition,
		);
		if (!match) {
			console.warn(`[actions] cannot parse auto-approve condition '${condition}'; treating as not met.`);
			return false;
		}
		const [, name, operator, literal] = match;
		const raw = parameters[name!];
		if (raw === undefined || raw === null) return false;
		const value = Number(raw);
		const threshold = Number(literal);
		if (Number.isNaN(value)) return false;
		switch (operator) {
			case "<": return value < threshold;
			case "<=": return value <= threshold;
			case ">": return value > threshold;
			case ">=": return value >= threshold;
			case "==": return value === threshold;
			case "!=": return value !== threshold;
			default: return false;
		}
	});
}

// ── read-only action implementations ────────────────────────────────────────

/**
 * Reprice a slice of the book and report the effect on cost, revenue and margin.
 * Computes against the real rows; writes nothing.
 */
async function simulateRateChange(parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
	const scope = String(parameters.scope);
	const scopeValue = String(parameters.scopeValue);
	const pctChange = Number(parameters.ratePctChange);

	const scopeColumn: Record<string, { transport: string; shipment: string }> = {
		lane: { transport: "lane", shipment: "lane" },
		carrier: { transport: "carrier_name", shipment: "" },
		account: { transport: "account_name", shipment: "account_name" },
		mode: { transport: "transportation_mode", shipment: "transportation_mode" },
	};
	const mapping = scopeColumn[scope];
	if (!mapping) {
		throw new BadRequest(`Unsupported scope '${scope}'. Use lane, carrier, account or mode.`);
	}

	const costRow = await queryOne<{ n: string; cost: string | null; km: string | null }>(
		`SELECT count(*)::bigint AS n, sum(total_cost) AS cost, sum(total_distance_km) AS km
		   FROM tms_views.v_transport
		  WHERE ${quoteIdentifier(mapping.transport)}::text = $1`,
		[scopeValue],
	);

	// Carrier is not a column on the shipment view, so revenue for a carrier scope
	// comes through the transports that carrier ran.
	const revenueRow = mapping.shipment
		? await queryOne<{ n: string; revenue: string | null }>(
				`SELECT count(*)::bigint AS n, sum(total_charge) AS revenue
				   FROM tms_views.v_shipment
				  WHERE ${quoteIdentifier(mapping.shipment)}::text = $1`,
				[scopeValue],
			)
		: await queryOne<{ n: string; revenue: string | null }>(
				`SELECT count(*)::bigint AS n, sum(s.total_charge) AS revenue
				   FROM tms_views.v_shipment s
				   JOIN tms_views.v_transport t ON t.order_key = s.order_key
				  WHERE t.carrier_name::text = $1`,
				[scopeValue],
			);

	const currentCost = Number(costRow?.cost ?? 0);
	const revenue = Number(revenueRow?.revenue ?? 0);
	const newCost = currentCost * (1 + pctChange / 100);
	const currentMargin = revenue - currentCost;
	const newMargin = revenue - newCost;

	return {
		effect: "computed",
		scope,
		scopeValue,
		ratePctChange: pctChange,
		transportsMatched: Number(costRow?.n ?? 0),
		shipmentsMatched: Number(revenueRow?.n ?? 0),
		totalKm: round2(Number(costRow?.km ?? 0)),
		currentCost: round2(currentCost),
		projectedCost: round2(newCost),
		costDelta: round2(newCost - currentCost),
		revenue: round2(revenue),
		currentMargin: round2(currentMargin),
		projectedMargin: round2(newMargin),
		marginDelta: round2(newMargin - currentMargin),
		currentMarginPct: revenue ? round2((currentMargin / revenue) * 100) : null,
		projectedMarginPct: revenue ? round2((newMargin / revenue) * 100) : null,
		note:
			"Cost figures rest on the simulated execution data in tms_sim; the snapshot " +
			"carries no transport cost. Treat the deltas as directional.",
	};
}

/** Project on-time percentage if volume shifted between two carriers. */
async function projectOnTimeImpact(parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
	const fromKey = String(parameters.fromCarrierKey);
	const toKey = String(parameters.toCarrierKey);
	const share = Number(parameters.sharePctToMove ?? 50) / 100;

	const rows = await query<{
		carrier_key: string;
		carrier_name: string;
		load_count: string;
		measured_count: string;
		on_time_count: string;
	}>(
		`SELECT carrier_key::text AS carrier_key, carrier_name,
		        load_count::text, measured_count::text, on_time_count::text
		   FROM tms_views.v_kpi_carrier_scorecard
		  WHERE carrier_key::text = ANY($1)`,
		[[fromKey, toKey]],
	);

	const from = rows.find((r) => r.carrier_key === fromKey);
	const to = rows.find((r) => r.carrier_key === toKey);
	if (!from || !to) {
		const missing = !from ? fromKey : toKey;
		throw new BadRequest(
			`Carrier ${missing} has no loads in the scorecard, so there is nothing to project from.`,
		);
	}

	const rate = (row: typeof from) =>
		Number(row.measured_count) > 0 ? Number(row.on_time_count) / Number(row.measured_count) : null;
	const fromRate = rate(from);
	const toRate = rate(to);
	if (fromRate === null || toRate === null) {
		throw new BadRequest("One of the carriers has no measured arrivals, so no projection is possible.");
	}

	const fromLoads = Number(from.load_count);
	const toLoads = Number(to.load_count);
	const moved = Math.round(fromLoads * share);

	const currentOnTime = fromRate * fromLoads + toRate * toLoads;
	const projectedOnTime = fromRate * (fromLoads - moved) + toRate * (toLoads + moved);
	const totalLoads = fromLoads + toLoads;

	return {
		effect: "computed",
		fromCarrier: from.carrier_name,
		toCarrier: to.carrier_name,
		loadsMoved: moved,
		fromCarrierOnTimePct: round2(fromRate * 100),
		toCarrierOnTimePct: round2(toRate * 100),
		combinedCurrentOnTimePct: totalLoads ? round2((currentOnTime / totalLoads) * 100) : null,
		combinedProjectedOnTimePct: totalLoads ? round2((projectedOnTime / totalLoads) * 100) : null,
		deltaPoints: totalLoads ? round2(((projectedOnTime - currentOnTime) / totalLoads) * 100) : null,
		note:
			"Assumes each carrier keeps its observed on-time rate on the moved volume. " +
			"Those rates come from the simulated execution data in tms_sim.",
	};
}

/** Recompute a transport's cost at a given rate and report the difference. */
async function recalculateTransportCost(parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
	const transportKey = String(parameters.transportKey);
	const row = await queryOne<{
		transport_number: string;
		transportation_mode: string | null;
		total_distance_km: string | null;
		total_cost: string | null;
		linehaul_cost: string | null;
		fuel_cost: string | null;
		accessorial_cost: string | null;
		carrier_name: string | null;
	}>(
		`SELECT transport_number, transportation_mode, total_distance_km::text,
		        total_cost::text, linehaul_cost::text, fuel_cost::text,
		        accessorial_cost::text, carrier_name
		   FROM tms_views.v_transport WHERE transport_key::text = $1`,
		[transportKey],
	);
	if (!row) throw new NotFound(`No transport with key ${transportKey}.`);

	// The same per-mode rates the pipeline's simulation uses, so a recalculation at
	// the default rate reproduces the stored figure rather than contradicting it.
	const defaultRates: Record<string, number> = {
		"Less Than Truckload": 2.35,
		Truckload: 1.55,
		Rail: 0.85,
		Air: 4.8,
		Ocean: 0.4,
		Intermodal: 1.1,
	};
	const mode = row.transportation_mode ?? "Truckload";
	const ratePerKm = parameters.ratePerKm !== undefined && parameters.ratePerKm !== null
		? Number(parameters.ratePerKm)
		: (defaultRates[mode] ?? 1.55);

	const km = Number(row.total_distance_km ?? 0);
	if (!km) {
		throw new BadRequest(
			`Transport ${row.transport_number} has no distance recorded, so cost per km cannot be recomputed.`,
		);
	}
	const currentCost = Number(row.total_cost ?? 0);
	const recomputedLinehaul = km * ratePerKm;
	const fuel = Number(row.fuel_cost ?? 0);
	const accessorial = Number(row.accessorial_cost ?? 0);
	const recomputedTotal = recomputedLinehaul + fuel + accessorial;

	return {
		effect: "computed",
		transportNumber: row.transport_number,
		carrier: row.carrier_name,
		transportationMode: mode,
		distanceKm: round2(km),
		ratePerKmApplied: ratePerKm,
		currentLinehaul: round2(Number(row.linehaul_cost ?? 0)),
		recomputedLinehaul: round2(recomputedLinehaul),
		fuel: round2(fuel),
		accessorial: round2(accessorial),
		currentTotalCost: round2(currentCost),
		recomputedTotalCost: round2(recomputedTotal),
		delta: round2(recomputedTotal - currentCost),
		note: "Reported only. Nothing was written.",
	};
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

const READ_ONLY_IMPLEMENTATIONS: Record<
	string,
	(parameters: Record<string, unknown>) => Promise<Record<string, unknown>>
> = {
	SimulateRateChange: simulateRateChange,
	ProjectOnTimeImpact: projectOnTimeImpact,
	RecalculateTransportCost: recalculateTransportCost,
};

// ── the mutating path: stage, never pretend ─────────────────────────────────

async function stageMutation(
	meta: ActionTypeMeta,
	parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	// Resolve the target so a staged request names the object a human recognises
	// rather than just a UUID.
	let target: Record<string, unknown> | null = null;
	const keyParameter = Object.keys(parameters).find((k) => k.endsWith("Key"));
	if (keyParameter) {
		const guessedType = keyParameter.replace(/Key$/, "");
		try {
			const type = resolveObjectType(guessedType);
			const row = await queryOne<Record<string, unknown>>(
				`SELECT ${quoteIdentifier(type.primaryKeyColumn)}::text AS key,
				        ${quoteIdentifier(type.titleColumn ?? type.primaryKeyColumn)}::text AS title
				   FROM ${quoteQualified(type.sourceView)}
				  WHERE ${quoteIdentifier(type.primaryKeyColumn)}::text = $1`,
				[String(parameters[keyParameter])],
			);
			if (row) target = { objectType: type.apiName, key: row.key, title: row.title };
			else {
				throw new NotFound(
					`${type.apiName} '${String(parameters[keyParameter])}' does not exist, so the action has no target.`,
				);
			}
		} catch (error) {
			if (error instanceof NotFound && /does not exist/.test(error.message)) throw error;
			// The parameter name did not map to an object type; that is fine, the
			// staged payload still carries the raw key.
		}
	}

	return {
		effect: "staged",
		target,
		payloadForTms: {
			action: meta.apiName,
			actionRid: meta.rid,
			parameters,
		},
		note:
			"Parameters and permissions were checked and the request was recorded in " +
			"platform.action_audit. Nothing was sent: this platform reads the TMS " +
			"through the captured snapshot in TMS_MCP/api_responses and has no " +
			"write-back endpoint. Wiring one means POSTing the payload above to the " +
			"corresponding TMS endpoint.",
	};
}

// ── orchestration ──────────────────────────────────────────────────────────

export async function executeAction(
	apiName: string,
	parameters: Record<string, unknown>,
	context: ExecuteContext,
): Promise<ActionOutcome> {
	const started = Date.now();
	const meta = resolveAction(apiName);

	const record = async (
		status: ActionOutcome["status"],
		message: string,
		validation: ActionOutcome["validation"],
		result: Record<string, unknown>,
		errorMessage: string | null = null,
	): Promise<ActionOutcome> => {
		const durationMs = Date.now() - started;
		let auditId: number | null = null;
		if (meta.auditLevel !== "none") {
			const row = await queryOne<{ action_audit_id: number }>(
				`INSERT INTO platform.action_audit
				   (action_type_rid, api_name, object_type_rid, object_key, parameters, status,
				    validation, result, error_message, actor, actor_role, initiated_by_ai,
				    chat_session_id, duration_ms)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
				 RETURNING action_audit_id`,
				[
					meta.rid,
					meta.apiName,
					meta.targetObjectTypes[0] ?? null,
					firstKeyValue(parameters),
					JSON.stringify(meta.auditLevel === "full" ? parameters : {}),
					status,
					JSON.stringify(validation),
					JSON.stringify(meta.auditLevel === "full" ? result : {}),
					errorMessage,
					context.actor,
					context.actorRole,
					context.initiatedByAi,
					context.chatSessionId,
					durationMs,
				],
			);
			auditId = row?.action_audit_id ?? null;
		}
		return {
			action: meta.apiName,
			label: meta.label,
			status,
			isReadOnly: meta.isReadOnly,
			message,
			validation,
			result,
			auditId,
			durationMs,
		};
	};

	// 1. parameters
	const validation = validateParameters(meta, parameters);
	if (!validation.valid) {
		return record(
			"failed",
			`${meta.label} was not run: ${validation.errors.length} parameter problem(s).`,
			validation,
			{},
			validation.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
		);
	}

	// 2. role
	const roleCheck = checkRole(meta, context.actorRole, context.actor);
	if (!roleCheck.allowed) {
		return record("rejected", roleCheck.reason, validation, {}, roleCheck.reason);
	}

	// 3. approval
	if (meta.requiresApproval && !isAutoApproved(meta, parameters)) {
		return record(
			"pending_approval",
			`${meta.label} needs approval from ${meta.approverRoles.join(" or ") || "an approver"} ` +
				"before it can run. The request has been queued.",
			validation,
			{
				effect: "queued_for_approval",
				approvers: meta.approverRoles,
				parameters,
			},
		);
	}

	// 4. read-only gate
	try {
		if (meta.isReadOnly) {
			const implementation = READ_ONLY_IMPLEMENTATIONS[meta.apiName];
			if (!implementation) {
				return record(
					"failed",
					`${meta.label} is declared read-only but has no implementation in this service.`,
					validation,
					{},
					"missing implementation",
				);
			}
			const result = await implementation(parameters);
			return record("succeeded", `${meta.label} completed.`, validation, result);
		}

		const result = await stageMutation(meta, parameters);
		return record(
			"staged",
			`${meta.label} was validated and recorded, but not sent: this platform has no ` +
				"write-back endpoint to the TMS.",
			validation,
			result,
		);
	} catch (error) {
		const message = (error as Error).message;
		return record("failed", `${meta.label} failed: ${message}`, validation, {}, message);
	}
}

function firstKeyValue(parameters: Record<string, unknown>): string | null {
	const key = Object.keys(parameters).find((k) => k.endsWith("Key"));
	return key ? String(parameters[key]) : null;
}

export async function listAudit(limit = 100): Promise<Array<Record<string, unknown>>> {
	return query(
		`SELECT action_audit_id, api_name, object_key, status, actor, actor_role,
		        initiated_by_ai, duration_ms, error_message, created_at, parameters, result
		   FROM platform.action_audit
		  ORDER BY created_at DESC LIMIT $1`,
		[Math.min(Math.max(1, limit), 500)],
	);
}
