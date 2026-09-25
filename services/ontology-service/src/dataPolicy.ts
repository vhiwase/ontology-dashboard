/**
 * Whether generated data may be served.
 *
 * The pipeline once synthesised execution data into tms_sim, which is what made
 * the service and cost KPIs answerable from a snapshot that has no execution
 * history. That was right for a demonstration and wrong everywhere else, where
 * a plausible invented number is worse than no number. Migration 0018 removed
 * the schema, the metrics that rested on it and the three what-if actions that
 * computed against it.
 *
 * So this gate currently gates nothing: no KPI, widget or action carries
 * dependsOnSimulation. It stays anyway, and that is the point — the check is
 * the one place a deployment decides whether it will serve an invented figure
 * at all, and removing it would mean the next one arrives unannounced.
 *
 * ALLOW_SIMULATED_DATA=false turns a caption into a refusal: anything flagged
 * returns 409 rather than a number, and says why. A caption is a convention,
 * and conventions get quoted out of context into a slide.
 */

export const ALLOW_SIMULATED_DATA =
	(process.env.ALLOW_SIMULATED_DATA ?? "true").trim().toLowerCase() !== "false";

/** Raised when simulated output is requested in a deployment that forbids it. */
export class SimulatedDataRefused extends Error {
	readonly status = 409;

	constructor(subject: string) {
		super(
			`${subject} is derived from generated execution data, and this deployment ` +
				`runs with ALLOW_SIMULATED_DATA=false. Ingest real execution data, or set ` +
				`ALLOW_SIMULATED_DATA=true if generated figures are acceptable here.`,
		);
	}
}

/** Throw unless simulated output is permitted. */
export function assertSimulationAllowed(subject: string, dependsOnSimulation: boolean): void {
	if (dependsOnSimulation && !ALLOW_SIMULATED_DATA) {
		throw new SimulatedDataRefused(subject);
	}
}

export function describePolicy(): { allowSimulatedData: boolean; note: string } {
	return {
		allowSimulatedData: ALLOW_SIMULATED_DATA,
		note: ALLOW_SIMULATED_DATA
			? "Generated execution data may be served where something is flagged dependsOnSimulation. Nothing is, today."
			: "Generated execution data is refused: anything flagged dependsOnSimulation returns 409. Nothing is flagged today, so nothing is refused.",
	};
}
