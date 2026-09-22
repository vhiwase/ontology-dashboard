/**
 * The pipeline execution engine.
 *
 * Runs a compiled graph node by node in dependency order, materialising each
 * node's result as a real table in the pipeline_out schema. Every number it
 * reports — rows in, rows out, duration — comes from the database having done
 * the work, not from a ratio.
 *
 * ── why materialise rather than nest CTEs ───────────────────────────────────
 * A single statement of nested CTEs would run faster, but a failure in it
 * names the statement, not the node, and nothing intermediate can be
 * previewed. Materialising gives per-node row counts, per-node errors and a
 * previewable output for every step, which is what a pipeline builder is for.
 *
 * ── on safety ───────────────────────────────────────────────────────────────
 * Every node's SQL is materialised as `CREATE TABLE … AS SELECT * FROM (<sql>)`
 * — wrapped in a subquery, never spliced in at the top level. That is what
 * makes the compiler's "SELECT only" rule structurally enforced rather than
 * merely checked:
 *
 *   * a non-SELECT statement is a syntax error in that position, so an INSERT
 *     or DROP cannot run even if the text checks were bypassed;
 *   * Postgres rejects a data-modifying CTE anywhere but the top level, which
 *     closes `WITH x AS (DELETE … RETURNING *) SELECT * FROM x`.
 *
 * The table name is built from validated identifiers, and is the only part of
 * the statement this engine writes itself.
 */

import type { PoolClient } from "pg";
import { pool, query } from "./db";
import {
	type InputRelation,
	assertDistinctOutputs,
	columnsOf,
	compileNode,
	isExecutable,
	NotExecutable,
	outputTableName,
	whyNotExecutable,
} from "./compile";
import type { NodeKind, PipelineGraph, PipelineNode } from "./pipelines";
import { currentSpace, quoteIdentifier } from "./registry";

const OUTPUT_SCHEMA = "pipeline_out";

/** How long any single node may run before the engine gives up on it. */
const NODE_TIMEOUT_MS = 60_000;

export interface ExecutedNode {
	nodeId: string;
	name: string;
	kind: NodeKind;
	status: "success" | "failed" | "skipped";
	durationMs: number;
	rowsIn: number | null;
	rowsOut: number | null;
	outputTable: string | null;
	sqlText: string | null;
	message: string;
	error: string | null;
}

export interface ExecutionResult {
	status: "success" | "failed";
	nodes: ExecutedNode[];
	log: Array<{ at: string; level: string; message: string }>;
	rowsRead: number;
	rowsWritten: number;
	durationMs: number;
}

function note(
	log: ExecutionResult["log"],
	level: "info" | "warn" | "error",
	message: string,
): void {
	log.push({ at: new Date().toISOString(), level, message });
}

/**
 * Order the graph so every node runs after the nodes feeding it.
 *
 * Kahn's algorithm. A cycle leaves nodes unvisited, and those are reported as
 * skipped rather than silently dropped — a graph with a loop is a mistake
 * worth naming.
 */
function topological(graph: PipelineGraph): PipelineNode[] {
	const nodes = graph.nodes ?? [];
	const edges = graph.edges ?? [];
	const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
	const downstream = new Map<string, string[]>();

	for (const edge of edges) {
		if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
		indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
		downstream.set(edge.source, [...(downstream.get(edge.source) ?? []), edge.target]);
	}

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
	const ordered: PipelineNode[] = [];

	while (queue.length) {
		const node = queue.shift()!;
		ordered.push(node);
		for (const next of downstream.get(node.id) ?? []) {
			const remaining = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) queue.push(byId.get(next)!);
		}
	}
	return ordered;
}

/** Which nodes feed this one, in edge order so a join's sides stay stable. */
function inputsOf(graph: PipelineGraph, nodeId: string): string[] {
	return (graph.edges ?? []).filter((e) => e.target === nodeId).map((e) => e.source);
}

/**
 * Build one node's table.
 *
 * Two statements, deliberately: the CREATE runs on the writing client, and the
 * count runs afterwards. `CREATE TABLE AS` does report a row count, but going
 * back to the table means the number reported is the number a reader would
 * actually find.
 */
async function materialise(
	client: PoolClient,
	table: string,
	sql: string,
	params: unknown[],
): Promise<number> {
	const qualified = `${quoteIdentifier(OUTPUT_SCHEMA)}.${quoteIdentifier(table)}`;

	// Replaced, not appended to: a node's output is the result of the latest
	// run, and a stale table left behind would be read by downstream nodes on
	// the next partial run.
	await client.query(`DROP TABLE IF EXISTS ${qualified}`);
	// The subquery wrapper is load-bearing, not cosmetic - see the note on
	// safety at the top of this file.
	await client.query(
		`CREATE TABLE ${qualified} AS SELECT * FROM (${sql}) AS _node`,
		params as never[],
	);

	const counted = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qualified}`);
	return Number(counted.rows[0]?.n ?? 0);
}

/**
 * Run a pipeline for real.
 *
 * Never throws for a node-level problem: a failed node fails its own row,
 * marks everything downstream of it skipped, and the run finishes with a
 * status of "failed". A half-run pipeline you can inspect is more useful than
 * an exception.
 */
export async function executeGraph(
	graph: PipelineGraph,
	pipelineSlug: string,
): Promise<ExecutionResult> {
	const started = Date.now();
	const log: ExecutionResult["log"] = [];
	const executed: ExecutedNode[] = [];

	assertDistinctOutputs(graph, pipelineSlug);

	const ordered = topological(graph);
	const all = graph.nodes ?? [];
	if (ordered.length < all.length) {
		note(
			log,
			"warn",
			`${all.length - ordered.length} node(s) are in a cycle and cannot run in any order.`,
		);
	}

	note(log, "info", `Run started: ${ordered.length} node(s) in dependency order.`);

	// What each node produced, for the nodes downstream of it.
	const produced = new Map<string, InputRelation>();
	const failed = new Set<string>();
	let rowsRead = 0;
	let rowsWritten = 0;

	const client = await pool.connect();
	try {
		await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(OUTPUT_SCHEMA)}`);
		await client.query(`SET LOCAL statement_timeout = ${NODE_TIMEOUT_MS}`);

		for (const node of ordered) {
			const nodeStarted = Date.now();
			const sourceIds = inputsOf(graph, node.id);

			// A node whose input failed cannot run: recording it as skipped with
			// the reason is more useful than a second, derived failure.
			const blockedBy = sourceIds.find((id) => failed.has(id));
			if (blockedBy) {
				failed.add(node.id);
				executed.push({
					nodeId: node.id,
					name: node.name,
					kind: node.kind,
					status: "skipped",
					durationMs: 0,
					rowsIn: null,
					rowsOut: null,
					outputTable: null,
					sqlText: null,
					message: `Skipped: an upstream node failed.`,
					error: null,
				});
				note(log, "warn", `${node.name}: skipped because ${blockedBy} failed.`);
				continue;
			}

			if (!isExecutable(node.kind)) {
				executed.push({
					nodeId: node.id,
					name: node.name,
					kind: node.kind,
					status: "skipped",
					durationMs: 0,
					rowsIn: null,
					rowsOut: null,
					outputTable: null,
					sqlText: null,
					message: whyNotExecutable(node.kind),
					error: null,
				});
				note(log, "info", `${node.name}: ${whyNotExecutable(node.kind)}`);
				continue;
			}

			// Only the inputs that actually produced a relation. A source node
			// upstream of nothing contributes none, which is correct.
			const inputs = sourceIds
				.map((id) => produced.get(id))
				.filter((relation): relation is InputRelation => relation !== undefined);
			const rowsIn = inputs.length
				? inputs.reduce((sum, input) => sum + (input.rowCount ?? 0), 0)
				: null;

			let sqlText: string | null = null;
			try {
				const compiled = compileNode(node, inputs);
				sqlText = compiled.sql;

				const table = outputTableName(pipelineSlug, node.id);
				const rowsOut = await materialise(client, table, compiled.sql, compiled.params);

				// Read back rather than trusting the compiler's prediction: a
				// SELECT * source and a raw SQL node both emit columns it cannot know.
				const columns = await columnsOf(OUTPUT_SCHEMA, table);

				produced.set(node.id, {
					relation: `${quoteIdentifier(OUTPUT_SCHEMA)}.${quoteIdentifier(table)}`,
					columns,
					nodeId: node.id,
					name: node.name,
					rowCount: rowsOut,
				});

				rowsRead += rowsIn ?? 0;
				rowsWritten += rowsOut;

				const durationMs = Date.now() - nodeStarted;
				executed.push({
					nodeId: node.id,
					name: node.name,
					kind: node.kind,
					status: "success",
					durationMs,
					rowsIn,
					rowsOut,
					outputTable: `${OUTPUT_SCHEMA}.${table}`,
					sqlText,
					message: `${rowsOut.toLocaleString("en-US")} rows in ${durationMs}ms.`,
					error: null,
				});
				note(
					log,
					"info",
					`${node.name}: ${rowsOut.toLocaleString("en-US")} rows in ${durationMs}ms.`,
				);
			} catch (error) {
				failed.add(node.id);
				const message = (error as Error).message;
				const durationMs = Date.now() - nodeStarted;

				executed.push({
					nodeId: node.id,
					name: node.name,
					kind: node.kind,
					status: "failed",
					durationMs,
					rowsIn,
					rowsOut: null,
					outputTable: null,
					sqlText,
					// A NotExecutable is the engine explaining itself and is written
					// for the person building the graph. Anything else is the
					// database talking, which is usually precise enough to keep.
					message:
						error instanceof NotExecutable
							? message
							: `This node's SQL failed: ${message}`,
					error: message,
				});
				note(log, "error", `${node.name}: ${message}`);
			}
		}
	} finally {
		client.release();
	}

	const anyFailed = executed.some((n) => n.status === "failed");
	const durationMs = Date.now() - started;
	note(
		log,
		anyFailed ? "error" : "info",
		anyFailed
			? `Run finished with ${executed.filter((n) => n.status === "failed").length} failed node(s) in ${durationMs}ms.`
			: `Run finished in ${durationMs}ms. ${rowsWritten.toLocaleString("en-US")} rows written.`,
	);

	return {
		status: anyFailed ? "failed" : "success",
		nodes: executed,
		log,
		rowsRead,
		rowsWritten,
		durationMs,
	};
}

/** Record each node's outcome, so failures are queryable and not just displayed. */
export async function recordNodeRuns(runId: number, nodes: ExecutedNode[]): Promise<void> {
	for (const node of nodes) {
		await query(
			`INSERT INTO platform.pipeline_node_run
			   (pipeline_run_id, node_id, node_name, node_kind, status, finished_at,
			    duration_ms, rows_in, rows_out, output_table, sql_text, error_message)
			 VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10,$11)`,
			[
				runId,
				node.nodeId,
				node.name,
				node.kind,
				node.status,
				node.durationMs,
				node.rowsIn,
				node.rowsOut,
				node.outputTable,
				node.sqlText,
				node.error,
			],
		);
	}
}

/**
 * Version each table the run built.
 *
 * Versions are per output table, so "this dataset had 183,921 rows yesterday
 * and 12 today" becomes a question with an answer rather than a surprise
 * somebody notices in a dashboard.
 */
export async function recordDatasetVersions(
	runId: number,
	nodes: ExecutedNode[],
	builtBy: string,
): Promise<void> {
	const space = currentSpace();
	for (const node of nodes) {
		if (node.status !== "success" || !node.outputTable) continue;

		const [schema, table] = node.outputTable.split(".");
		const columns = await columnsOf(schema!, table!);

		await query(
			`INSERT INTO platform.dataset_version
			   (space_id, qualified_name, version, row_count, column_count, columns,
			    built_by_run, built_by)
			 SELECT s.space_id, $2,
			        coalesce((SELECT max(version) FROM platform.dataset_version v
			                   WHERE v.space_id = s.space_id AND v.qualified_name = $2), 0) + 1,
			        $3, $4, $5, $6, $7
			   FROM platform.space s WHERE s.slug = $1`,
			[
				space,
				node.outputTable,
				node.rowsOut ?? 0,
				columns.length,
				JSON.stringify(columns),
				runId,
				builtBy,
			],
		);
	}
}

/** Rows from a node's materialised output, for the preview panel. */
export async function previewOutput(
	qualifiedName: string,
	limit = 50,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; total: number }> {
	const [schema, table] = qualifiedName.split(".");
	if (schema !== OUTPUT_SCHEMA || !table) {
		// Only this engine's own outputs are previewable here. Anything else is
		// a warehouse relation and goes through the resource preview, which
		// checks it against the registry.
		throw new NotExecutable(qualifiedName, `'${qualifiedName}' is not a pipeline output.`);
	}

	const columns = await columnsOf(schema, table);
	if (columns.length === 0) {
		throw new NotExecutable(qualifiedName, `'${qualifiedName}' has not been built yet.`);
	}

	const safe = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
	const capped = Math.min(Math.max(1, limit), 500);
	const rows = await query(`SELECT * FROM ${safe} LIMIT ${capped}`);
	const counted = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${safe}`);

	return { columns, rows, total: Number(counted[0]?.n ?? 0) };
}

/** Every node's outcome for one run, newest run detail for the console. */
export async function nodeRunsFor(runId: number): Promise<Array<Record<string, unknown>>> {
	if (!Number.isFinite(runId)) throw new NotExecutable("run", "A numeric run id is required.");
	const rows = await query<{
		node_id: string;
		node_name: string;
		node_kind: string;
		status: string;
		duration_ms: number | null;
		rows_in: string | null;
		rows_out: string | null;
		output_table: string | null;
		sql_text: string | null;
		error_message: string | null;
	}>(
		`SELECT node_id, node_name, node_kind, status, duration_ms, rows_in, rows_out,
		        output_table, sql_text, error_message
		   FROM platform.pipeline_node_run
		  WHERE pipeline_run_id = $1
		  ORDER BY pipeline_node_run_id`,
		[runId],
	);

	return rows.map((row) => ({
		nodeId: row.node_id,
		name: row.node_name,
		kind: row.node_kind,
		status: row.status,
		durationMs: row.duration_ms,
		rowsIn: row.rows_in === null ? null : Number(row.rows_in),
		rowsOut: row.rows_out === null ? null : Number(row.rows_out),
		outputTable: row.output_table,
		sql: row.sql_text,
		error: row.error_message,
	}));
}

/**
 * The build history of one materialised dataset.
 *
 * Scoped to the requesting space, like everything else that reads published
 * work: a dataset built by a sandbox pipeline is not production's.
 */
export async function datasetVersions(
	qualifiedName: string,
): Promise<Array<Record<string, unknown>>> {
	const rows = await query<{
		version: number;
		row_count: string;
		column_count: number;
		columns: string[];
		built_at: Date;
		built_by: string;
		built_by_run: number | null;
	}>(
		`SELECT v.version, v.row_count, v.column_count, v.columns, v.built_at,
		        v.built_by, v.built_by_run
		   FROM platform.dataset_version v
		   JOIN platform.space s ON s.space_id = v.space_id
		  WHERE s.slug = $1 AND v.qualified_name = $2
		  ORDER BY v.version DESC
		  LIMIT 50`,
		[currentSpace(), qualifiedName],
	);

	return rows.map((row, index) => ({
		version: row.version,
		rowCount: Number(row.row_count),
		columnCount: row.column_count,
		columns: row.columns,
		builtAt: row.built_at.toISOString(),
		builtBy: row.built_by,
		builtByRun: row.built_by_run,
		// The change from the version before it, which is the reason to keep
		// versions at all: a dataset that quietly lost 90% of its rows shows here.
		rowDelta:
			index + 1 < rows.length ? Number(row.row_count) - Number(rows[index + 1]!.row_count) : null,
	}));
}
