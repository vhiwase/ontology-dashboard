/**
 * Follow-ups: what a proposal was for.
 *
 * "Build me a sales dashboard" on data with no sales dataset becomes a
 * proposal for the dataset, carrying the request as its follow-up. When the
 * proposal is approved the board is built here, from the type the proposal
 * just created - so approving is the last thing the person has to do, rather
 * than the first of two.
 *
 * Kept out of proposals.ts because it needs the board planner, which itself
 * reads proposals.ts.
 */

import { saveDashboard } from "./dashboards";
import { planBoard } from "./feasibility";
import { recordFollowUp, type ProposalRecord } from "./proposals";
import { getRegistry } from "./registry";

export interface BuiltBoard {
	kind: "dashboard" | "report";
	slug: string;
	title: string;
	widgets: number;
}

/** The type a settled proposal produced, when it produced one. */
function producedType(proposal: ProposalRecord): string | null {
	const result = proposal.result ?? {};
	if (typeof result.objectType === "string") return result.objectType;
	if (typeof proposal.payload.objectType === "string") return proposal.payload.objectType;
	return null;
}

/**
 * Run the follow-ups of every applied proposal in `settled`, in order.
 *
 * A follow-up that fails does not undo the approval - the dataset is still
 * there and still useful - so its error is recorded on the proposal instead
 * of being thrown.
 */
export async function runFollowUps(settled: ProposalRecord[], username: string, spaceSlug: string): Promise<ProposalRecord[]> {
	const out: ProposalRecord[] = [];
	for (const proposal of settled) {
		const followUp = proposal.followUp;
		if (proposal.status !== "applied" || !followUp) {
			out.push(proposal);
			continue;
		}
		try {
			const apiName = producedType(proposal);
			const subject = apiName ? getRegistry().objectTypeByApiName.get(apiName) : undefined;
			if (!subject) throw new Error("the approved change did not produce a type to build on");
			const { layout } = await planBoard(subject, { measure: followUp.measure });
			if (layout.length === 0) throw new Error(`${subject.label} has no metrics to lay out yet`);
			const saved = await saveDashboard({
				title: followUp.title,
				description:
					followUp.build === "report"
						? `A report on ${(subject.pluralLabel ?? subject.label).toLowerCase()}, built when "${proposal.title}" was approved.`
						: `Built when "${proposal.title}" was approved: headline figures, the timeline and the main breakdowns.`,
				layout,
				kind: followUp.build,
				isAiGenerated: proposal.createdVia !== "user",
				sourcePrompt: followUp.sourcePrompt,
				createdBy: username,
				chatSessionId: proposal.chatSessionId,
				spaceSlug,
			});
			const built: BuiltBoard = { kind: followUp.build, slug: saved.slug, title: saved.title, widgets: saved.layout.length };
			out.push(await recordFollowUp(proposal.id, built as unknown as Record<string, unknown>));
		} catch (error) {
			out.push(await recordFollowUp(proposal.id, { error: (error as Error).message }));
		}
	}
	return out;
}
