/**
 * The documentation corpus the assistant can search and cite.
 *
 * There was nothing to cite before, which is why citations were missing rather
 * than merely unimplemented: a citation directive pointing at no document is
 * worse than plain prose. So the corpus is built from what the platform
 * already knows and can stand behind —
 *
 *   * every metric's definition, business question and coverage caveat;
 *   * every object type, with its properties, links and dataset;
 *   * every action, with its permissions and effects;
 *   * a small set of written pages for the things that are true of the
 *     platform rather than of any one object - the data flow, authoring,
 *     data quality, roles, spaces, actions and schedules.
 *
 * It is generated from the live registry rather than stored, so it cannot go
 * stale against the ontology it describes. That is the whole point: a cited
 * caveat about the data has to be the caveat that is actually in force.
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
		path: "platform/data-flow",
		title: "How data becomes an ontology",
		category: "Platform",
		summary:
			"PostgreSQL connection, scheduled sync, dataset as it is, then object types with links, actions, metrics and functions.",
		sections: [
			{
				title: "The flow",
				body:
					"A PostgreSQL CONNECTION names a host and the secret that holds its password. A " +
					"SYNC copies one view or table from it into a DATASET here (connection_raw.<table>) " +
					"exactly as it is: same columns, same rows, types mapped through a fixed table. A " +
					"SCHEDULE decides how often a sync runs - every 20 minutes, 2 hours, 1 day, 8 " +
					"days. OBJECT TYPES are then created from datasets, one per dataset, with a " +
					"property per column; LINKS, ACTIONS and METRICS are defined on object types, and " +
					"FUNCTIONS compute over datasets.",
			},
			{
				title: "Snapshots, not appends",
				body:
					"Every sync rebuilds its dataset from the source, so a dataset is what the source " +
					"holds now and never keeps rows the source has deleted. A run reads at most its row " +
					"limit (50,000 by default) and says truncated when it stopped there. Columns whose " +
					"type has no local equivalent land as text and are listed on the dataset.",
			},
			{
				title: "What a sync refreshes",
				body:
					"After each run the object types built on that dataset get their new object counts. " +
					"If the source dropped a column an object type's property uses, the run names that " +
					"property rather than hiding it: the type still describes the old shape until the " +
					"property is removed or the source restores the column.",
			},
		],
	},
	{
		path: "platform/building-the-ontology",
		title: "Creating object types, links, actions, metrics and functions",
		category: "Platform",
		summary: "What each authoring step checks against the data before anything is stored.",
		sections: [
			{
				title: "Object types",
				body:
					"Created from a dataset. Profiling it first gives real distinct and null counts, " +
					"sample values, the columns that could be a primary key, and a suggested role per " +
					"column. The primary key must be unique and never null in the data as it stands, or " +
					"the type is refused with the counts. A measure must be numeric: a key, a code, a " +
					"year or a coordinate is a number that identifies rather than measures.",
			},
			{
				title: "Links",
				body:
					"Drawn between a property of one object type and the key of another. The share of " +
					"values that really resolve is measured and stored as the match ratio, and a link " +
					"where no value matches is refused. Suggested links are columns named like another " +
					"type's key, measured the same way.",
			},
			{
				title: "Actions",
				body:
					"Declared on an object type, with typed parameters and the roles allowed to run it. " +
					"The target's key is always the first parameter. Running one validates, checks the " +
					"runner's role and records the request in the audit trail as staged.",
			},
			{
				title: "Metrics",
				body:
					"An aggregation over one object type: count, count_distinct, sum, avg, min, max, or " +
					"ratio (sum over sum, never an average of per-row ratios), sliceable by the dimensions " +
					"named. A new metric is computed once before it is kept; one that does not compute is " +
					"refused with the database's message.",
			},
			{
				title: "Functions",
				body:
					"A single SELECT over datasets for what a metric cannot express. Proposed first, " +
					"computing nothing, until an admin approves it. It may read only synced datasets - " +
					"checked against the query planner, not the text - and runs read-only with a time " +
					"limit.",
			},
			{
				title: "Who may do it",
				body:
					"Creating needs the analyst platform role, deleting needs admin. The AI-FDE builds " +
					"with the signed-in user's token, so it can do exactly what that user can.",
			},
		],
	},
	{
		path: "platform/data-quality",
		title: "What the TMS data measures, and what it cannot",
		category: "Data quality",
		summary:
			"Only measured data is shown. What the source does not carry is named rather than filled in.",
		sections: [
			{
				title: "The source",
				body:
					"The tms_views schema this platform's own database connection reads is a captured " +
					"PLANNING snapshot of a real TMS: orders, shipments, transports, stops, the party " +
					"master and the configuration behind them are real records. Counts, weights, piece " +
					"counts, planned rates and anything derived only from those are measured.",
			},
			{
				title: "What it does not carry",
				body:
					"It records intent, not outcome: no recorded arrivals (0 of 122 stops), no execution " +
					"actuals (0 of 61 transports), no leg distance (every leg reports 0 m) and no carrier " +
					"assignment (0 of 90 orders). Only 14 of 61 shipments carry a charge. On-time " +
					"performance, dwell, transit time, cost per kilometre, carrier scorecards and margin " +
					"cannot be computed from it, and no metric should claim to.",
			},
			{
				title: "The rule",
				body:
					"Nothing is simulated, estimated or filled in. A figure that cannot be computed from " +
					"real data is reported as not measured. Changing data needs explicit approval and goes " +
					"into a new copy, never the original. ALLOW_SIMULATED_DATA=false refuses anything " +
					"flagged as resting on generated data with an HTTP 409.",
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
					"viewer reads; analyst additionally creates connections, syncs, schedules, object " +
					"types, links, actions, metrics, function proposals and dashboards, and applies " +
					"actions; admin additionally approves functions, reads the audit trail and deletes. " +
					"Anything under /api not listed as elevated requires at least viewer.",
			},
			{
				title: "Ontology role",
				body:
					"The business hat - AdminRole, OperationsManagerRole, DispatcherRole, FinanceRole or " +
					"AnalystRole. Decides which ACTIONS may be executed: an action names the roles allowed " +
					"to run it, the admin may run all of them, and AnalystRole may run none.",
			},
			{
				title: "Who the assistant acts as",
				body:
					"The assistant calls the platform as the signed-in user, forwarding their token. Its " +
					"reads and writes are bound by their permissions and recorded against them.",
			},
		],
	},
	{
		path: "platform/spaces",
		title: "Spaces and what is scoped to them",
		category: "Platform",
		summary: "One space per environment, each with its own connections, datasets and ontology.",
		sections: [
			{
				title: "The spaces",
				body:
					"Sandbox, Development, Staging and Production exist from the start, one per " +
					"environment. The sandbox comes with the platform's own database registered as a " +
					"connection.",
			},
			{
				title: "What is per-space",
				body:
					"Everything people make: connections, syncs, schedules, datasets, the ontology " +
					"(object types, links, actions, metrics), functions, dashboards and conversations. " +
					"Every space starts with an empty ontology.",
			},
		],
	},
	{
		path: "platform/actions",
		title: "How actions behave",
		category: "Platform",
		summary: "Why an action is staged rather than written back.",
		sections: [
			{
				title: "Staged, not executed",
				body:
					"A dataset is a copy of the source, and this platform has no write-back to it. An " +
					"action validates its parameters, checks the caller's ontology role and records an " +
					"audit row with status staged, carrying the exact request that would be sent. " +
					"Nothing is changed anywhere.",
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
	{
		path: "platform/schedules",
		title: "Schedules: how often a sync runs",
		category: "Platform",
		summary: "One cadence per sync - every 20 minutes, 2 hours, a day, 8 days - and what a run records.",
		sections: [
			{
				title: "What a schedule is",
				body:
					"An interval on one sync, written as 20m, 2h, 1d, 8d or 1w, at least a minute and at " +
					"most a year. The ontology service's background loop runs each sync when due. Setting " +
					"a sync back to manual removes its schedule.",
			},
			{
				title: "A scheduled run is a normal run",
				body:
					"The scheduler calls the same sync the Run button does, so a scheduled run lands in " +
					"the same run history. Run now fires at once without moving the next scheduled run.",
			},
			{
				title: "Failure keeps the cadence",
				body:
					"A failing sync writes a failed schedule run with the error and updates the " +
					"schedule's last status, and the cadence continues, so a broken source is visible " +
					"rather than a silent gap.",
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
				title: "Flagged as generated",
				body:
					"This metric is flagged as resting on generated data. It is refused outright " +
					"when ALLOW_SIMULATED_DATA=false. See the data quality page.",
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
				`Primary key ${type.primaryKeyColumn}. Created from the dataset ${type.sourceView}.` +
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
				: "Staged rather than executed. Parameters and permissions are checked and an " +
					"audit row is written; nothing is written back to the source.",
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
 * In a space with nothing authored yet the platform pages still stand - how
 * data gets in, how an ontology is built, how roles work - so the assistant
 * can still answer "where do I start", which is the question worth asking.
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
