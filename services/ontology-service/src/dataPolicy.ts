/**
 * Whether simulated data may be served.
 *
 * The pipeline synthesises execution data into tms_sim when
 * PIPELINE_SIMULATE_EXECUTION is on, which is what makes the service and cost
 * KPIs answerable from a snapshot that has no execution history. That is right
 * for a demonstration and wrong for production, where a plausible invented
 * number is worse than no number.
 *
 * Every KPI already carries dependsOnSimulation, and the action layer already
 * captions its cost figures as simulated. What was missing was a way to say
 * "not here": a caption is a convention, and conventions get quoted out of
 * context into a slide.
 *
 * ALLOW_SIMULATED_DATA=false turns that convention into a refusal. The
 * affected KPIs, dashboards widgets and actions return 409 rather than a
 * number, and say why.
 */

export const ALLOW_SIMULATED_DATA =
	(process.env.ALLOW_SIMULATED_DATA ?? "true").trim().toLowerCase() !== "false";

/** Raised when simulated output is requested in a deployment that forbids it. */
export class SimulatedDataRefused extends Error {
	readonly status = 409;

	constructor(subject: string) {
		super(
			`${subject} is derived from simulated execution data (tms_sim), and this ` +
				`deployment runs with ALLOW_SIMULATED_DATA=false. Ingest real execution ` +
				`data, or set ALLOW_SIMULATED_DATA=true if simulated figures are acceptable here.`,
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
			? "Simulated execution data (tms_sim) may be served. KPIs built on it are flagged dependsOnSimulation and captioned."
			: "Simulated execution data is refused: KPIs, widgets and actions that depend on tms_sim return 409.",
	};
}
