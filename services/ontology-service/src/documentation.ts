/**
 * The documentation corpus the assistant can search and cite.
 *
 * There was nothing to cite before, which is why citations were missing rather
 * than merely unimplemented: a citation directive pointing at no document is
 * worse than plain prose. So the corpus is built from what the platform
 * already knows and can stand behind —
 *
 *   * every metric's definition, business question and coverage caveat;
 *   * every object type, with its properties, links and backing view;
 *   * every action, with its permissions and effects;
 *   * a small set of written pages for the things that are true of the
 *     platform rather than of any one object — simulated data, roles, spaces.
 *
 * It is generated from the live registry rather than stored, so it cannot go
 * stale against the ontology it describes. That is the whole point: a cited
 * caveat about simulated data has to be the caveat that is actually in force.
 */

import { currentSpace, getRegistry, hasOntology, NotFound } from "./registry";

export interface DocSection {
	title: string;
	body: string;
}

export interface Document {
	/** Stable address, e.g. "metric/on_time_pct". Used by :citation[…]{path=…}. */
	path: string;
	title: string;
	category: string;
	summary: string;
	sections: DocSection[];
}

export interface SearchHit {
	path: string;
	title: string;
	category: string;
	/** The section that matched, when the match was inside one. */
	sectionTitle: string | null;
	excerpt: string;
	score: number;
}

// ── written pages ───────────────────────────────────────────────────────────

/**
 * Pages about the platform itself.
 *
 * These are the claims the assistant is most often asked to justify, and the
 * ones most costly to get wrong. Writing them down means it can cite a stable
 * statement instead of paraphrasing the system prompt differently each time.
 */
const PLATFORM_PAGES: Document[] = [
	{
		path: "platform/simulated-data",
		title: "What this snapshot measures, and what it cannot",
		category: "Data quality",
		summary:
			"Everything on this platform is measured. What the snapshot does not carry is named here rather than filled in.",
		sections: [
			{
				title: "What is measured",
				body:
					"This platform runs on a captured planning snapshot of a real TMS. Orders, " +
					"shipments, transports, stops, the party master and the configuration behind " +
					"them are real, measured records taken from the source system. Counts, weights, " +
					"piece counts, planned rates and anything derived only from those are measured.",
			},
			{
				title: "What the snapshot does not carry",
				body:
					"It is a PLANNING snapshot: it records intent, not outcome. There are no " +
					"recorded arrivals (0 of 122 stops), no execution actuals (0 of 61 transports " +
					"have an actualStart or actualEnd), no leg distance (every captured leg reports " +
					"0 m) and no carrier assignment (0 of 90 orders carry a carrierId). Only 14 of " +
					"61 shipments carry a charge. On-time performance, dwell, transit time, cost " +
					"per kilometre, carrier scorecards and margin therefore cannot be computed from " +
					"it at all.",
			},
			{
				title: "What was done about that",
				body:
					"For a time the pipeline generated those figures into a separate tms_sim schema " +
					"so the catalogue had something to display, and 17 of 31 metrics rested on " +
					"invented numbers while looking authoritative. Migration 0018 removed the " +
					"generated columns, the three metric views composed wholly of them, and the " +
					"schema itself. The pipeline's second stage now reports the coverage gaps " +
					"instead of filling them, and PIPELINE_SIMULATE_EXECUTION=true refuses rather " +
					"than regenerating. Three read-only what-if actions went with it.",
			},
			{
				title: "Columns that are NULL rather than absent",
				body:
					"actual_start_at, total_distance_km and charge_per_kg are kept and read NULL. " +
					"They are genuine columns awaiting genuine data and will fill themselves the " +
					"day the TMS starts sending actuals. A column that could only ever have held an " +
					"invented value was removed instead, because leaving one in place is an " +
					"invitation to fill it in later.",
			},
			{
				title: "The lock that is still in place",
				body:
					"ALLOW_SIMULATED_DATA=false makes the platform refuse rather than caveat: any " +
					"metric, widget or action flagged dependsOnSimulation returns HTTP 409 with an " +
					"explanation instead of a number. Nothing carries that flag today, so it gates " +
					"nothing - which is the state it is meant to be in, and it stays so that a " +
					"generated figure cannot reappear quietly.",
			},
		],
	},
	{
		path: "platform/roles",
		title: "Roles and permissions",
		category: "Platform",
		summary: "The two separate role concepts and what each one decides.",
		sections: [
			{
				title: "Platform role",
				body:
					"viewer, analyst or admin. Decides which API routes a caller may reach at all. " +
					"viewer reads; analyst additionally creates dashboards, runs pipelines and " +
					"applies actions; admin additionally reads the audit trail, reloads the registry " +
					"and deletes. Anything under /api not listed as elevated requires at least viewer, " +
					"so a route added later is protected by default.",
			},
			{
				title: "Ontology role",
				body:
					"The business hat declared in the ontology — AdminRole, OperationsManagerRole, " +
					"DispatcherRole, FinanceRole or AnalystRole. Decides which ACTIONS may be " +
					"executed, and is what AccessController checks. A dispatcher and a finance user " +
					"are both analyst on the platform but may run different actions, which one column " +
					"could not express.",
			},
			{
				title: "Who the assistant acts as",
				body:
					"The assistant queries the ontology as the signed-in user, forwarding their token. " +
					"Its reads are bound by their permissions and any action it applies is recorded " +
					"against them in the audit trail, not against the assistant.",
			},
		],
	},
	{
		path: "platform/spaces",
		title: "Spaces and what is scoped to them",
		category: "Platform",
		summary: "One space per environment, and which things differ between them.",
		sections: [
			{
				title: "The spaces",
				body:
					"Sandbox, Development, Staging and Production exist from the start, one per " +
					"environment. Sandbox is where work begins; the others are where it is promoted to.",
			},
			{
				title: "What is per-space",
				body:
					"Pipelines, projects, folders, resources, dashboards and conversations. These are " +
					"things people make, and two environments should be able to hold different ones. " +
					"A slug is unique within its space, so the same pipeline or dashboard promoted to " +
					"production keeps its name.",
			},
			{
				title: "What is shared",
				body:
					"The ontology — object types, link types, action types and metrics. There is one " +
					"published ontology per database, generated wholesale by the pipeline. Switching " +
					"space does not change it.",
			},
		],
	},
	{
		path: "platform/actions",
		title: "How actions behave",
		category: "Platform",
		summary: "Why a mutating action is staged rather than executed.",
		sections: [
			{
				title: "Staged, not executed",
				body:
					"This platform reads a captured snapshot and has no write-back endpoint to the " +
					"source TMS. A mutating action validates its parameters, checks the caller's " +
					"ontology role and records an audit row with status 'staged'. Nothing is sent " +
					"anywhere. 'succeeded' is reserved for read-only actions, which really do run and " +
					"return a computed result.",
			},
			{
				title: "Audit",
				body:
					"Every apply writes to the action audit trail with the actor, their ontology role, " +
					"the parameters, the validation outcome and whether the assistant initiated it. " +
					"Identity comes from the verified token, never from the request body.",
			},
		],
	},
];

// ── generated pages ─────────────────────────────────────────────────────────

function metricDocs(): Document[] {
	return getRegistry().kpis.map((kpi) => {
		const sections: DocSection[] = [];
		if (kpi.businessQuestion) {
			sections.push({ title: "Business question", body: kpi.businessQuestion });
		}
		if (kpi.description) {
			sections.push({ title: "Definition", body: kpi.description });
		}
		sections.push({
			title: "How it is computed",
			body:
				`${kpi.aggregation} over ${kpi.sourceView}` +
				(kpi.measureColumn ? ` (${kpi.measureColumn})` : "") +
				(kpi.dimensions?.length ? `. Can be grouped by: ${kpi.dimensions.join(", ")}.` : ".") +
				(kpi.unit ? ` Unit: ${kpi.unit}.` : ""),
		});
		if (kpi.coverageNote) {
			sections.push({ title: "Data quality caveat", body: kpi.coverageNote });
		}
		if (kpi.dependsOnSimulation) {
			sections.push({
				title: "Simulated",
				body:
					"This metric depends on the seeded execution simulation. It is refused outright " +
					"when ALLOW_SIMULATED_DATA=false. See the simulated execution data page.",
			});
		}
		return {
			path: `metric/${kpi.apiName}`,
			title: kpi.label,
			category: `Metric · ${kpi.category}`,
			summary: kpi.description ?? kpi.businessQuestion ?? kpi.label,
			sections,
		};
	});
}

function objectTypeDocs(): Document[] {
	const registry = getRegistry();
	return registry.objectTypes.map((type) => {
		const links = registry.linkTypes.filter(
			(link) => link.sourceObjectType === type.rid || link.targetObjectType === type.rid,
		);
		const actions = registry.actionTypes.filter((action) =>
			action.targetObjectTypes.includes(type.rid),
		);
		const measures = type.properties.filter((p) => p.semanticRole === "measure");

		const sections: DocSection[] = [];
		if (type.description) sections.push({ title: "Description", body: type.description });
		sections.push({
			title: "Shape",
			body:
				`${type.rowCount.toLocaleString("en-US")} objects, ${type.properties.length} properties. ` +
				`Primary key ${type.primaryKeyColumn}. Backed by ${type.sourceView}.` +
				(measures.length
					? ` Summable measures: ${measures.map((m) => m.apiName).join(", ")}.`
					: " No summable measures; this type is dimensional."),
		});
		if (links.length) {
			sections.push({
				title: "Links",
				body: links
					.map((link) => `${link.apiName} (${link.cardinality})`)
					.join(", "),
			});
		}
		if (actions.length) {
			sections.push({
				title: "Actions",
				body: actions
					.map((a) => `${a.apiName}${a.isReadOnly ? " (read-only)" : " (staged write)"}`)
					.join(", "),
			});
		}
		return {
			path: `object-type/${type.apiName}`,
			title: type.label,
			category: `Object type · ${type.group ?? "Other"}`,
			summary: type.description ?? `${type.label} object type.`,
			sections,
		};
	});
}

function actionDocs(): Document[] {
	const registry = getRegistry();
	return registry.actionTypes.map((action) => {
		const targets = registry.objectTypes
			.filter((type) => action.targetObjectTypes.includes(type.rid))
			.map((type) => type.apiName);
		const sections: DocSection[] = [];
		if (action.description) sections.push({ title: "Description", body: action.description });
		sections.push({
			title: "Behaviour",
			body: action.isReadOnly
				? "Read-only. Runs and returns a computed result; changes nothing."
				: "Mutating, and therefore staged rather than executed. Parameters and permissions " +
					"are checked and an audit row is written; nothing is sent to the source TMS.",
		});
		if (targets.length) sections.push({ title: "Acts on", body: targets.join(", ") });
		if (action.allowedRoles?.length) {
			sections.push({ title: "Permitted roles", body: action.allowedRoles.join(", ") });
		}
		return {
			path: `action/${action.apiName}`,
			title: action.label,
			category: "Action",
			summary: action.description ?? action.label,
			sections,
		};
	});
}

/**
 * The whole corpus, rebuilt per call so it tracks the live registry.
 *
 * In a space with no published ontology the platform pages still stand — what
 * a space is, which data is simulated, how roles work — so documentation
 * degrades to those rather than failing. The assistant can then still answer
 * "why is this space empty", which is the one question worth asking there.
 */
export function corpus(): Document[] {
	if (!hasOntology(currentSpace())) return [...PLATFORM_PAGES];
	return [...PLATFORM_PAGES, ...metricDocs(), ...objectTypeDocs(), ...actionDocs()];
}

export function getDocument(path: string): Document {
	const found = corpus().find((doc) => doc.path === path);
	if (!found) throw new NotFound(`No document '${path}'.`);
	return found;
}

// ── search ──────────────────────────────────────────────────────────────────

function tokenise(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((word) => word.length > 2);
}

/**
 * Rank documents against a query.
 *
 * Deliberately simple term overlap rather than anything clever: the corpus is
 * a few hundred short documents, the queries are a handful of words, and a
 * scoring function whose behaviour is obvious is worth more here than one that
 * is marginally better and impossible to explain when it surfaces the wrong
 * caveat.
 *
 * A title hit outweighs a body hit, because asking about "on time" should find
 * the on-time metric before it finds every page that mentions punctuality.
 */
export function searchDocumentation(query: string, limit = 6): SearchHit[] {
	const terms = [...new Set(tokenise(query))];
	if (terms.length === 0) return [];

	const hits: SearchHit[] = [];

	for (const doc of corpus()) {
		const titleWords = new Set(tokenise(`${doc.title} ${doc.path} ${doc.category}`));
		const summaryWords = new Set(tokenise(doc.summary));

		let score = 0;
		for (const term of terms) {
			if (titleWords.has(term)) score += 6;
			if (summaryWords.has(term)) score += 2;
		}

		// The best-matching section, so a citation can point at the part that
		// actually answers rather than at the top of a long page.
		let bestSection: DocSection | null = null;
		let bestSectionScore = 0;
		for (const section of doc.sections) {
			const words = new Set(tokenise(`${section.title} ${section.body}`));
			let sectionScore = 0;
			for (const term of terms) {
				if (words.has(term)) sectionScore += 1;
			}
			if (sectionScore > bestSectionScore) {
				bestSectionScore = sectionScore;
				bestSection = section;
			}
		}
		score += bestSectionScore;

		if (score === 0) continue;

		const source = bestSection ? bestSection.body : doc.summary;
		hits.push({
			path: doc.path,
			title: doc.title,
			category: doc.category,
			sectionTitle: bestSection?.title ?? null,
			excerpt: source.length > 320 ? `${source.slice(0, 317)}…` : source,
			score,
		});
	}

	return hits
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, Math.min(Math.max(1, limit), 20));
}
