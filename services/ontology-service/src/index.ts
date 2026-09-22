import {
	DotExporter,
	ErDiagramExporter,
	JsonSchemaExporter,
	MermaidExporter,
	OntologyValidator,
	OWLExporter,
	SHACLExporter,
	SHACLShapeGenerator,
} from "@ontograph/core";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { executeAction, listAudit, resolveAction, validateParameters } from "./actions";
import { apiAuthorization, login, me, requestId } from "./auth";
import { describePolicy } from "./dataPolicy";
import {
	dashboardHistory,
	deleteDashboard,
	exportDashboards,
	getDashboard,
	importDashboards,
	kpiCatalogueForPrompt,
	listDashboards,
	renameDashboard,
	resolveDashboard,
	saveDashboard,
	validateLayout,
} from "./dashboards";
import { pool, query, waitForOntology } from "./db";
import { clearColumnCache, dimensionValues, executeKpi, resolveKpi } from "./kpi";
import { corpus, getDocument, searchDocumentation } from "./documentation";
import { columnLineage, fetchGraph, trace, traceKpi, traceObjectType } from "./lineage";
import {
	deletePipeline,
	getPipeline,
	listPipelines,
	listRuns,
	listVersions,
	ontologyPalette,
	restoreVersion,
	acceptPipeline,
	proposePipeline,
	runPipeline,
	savePipeline,
	validateGraph,
} from "./pipelines";
import { datasetVersions, nodeRunsFor, previewOutput } from "./execute";
import {
	createLinkType,
	deleteOntologyObject,
	editOntologyObject,
	type EditKind,
	listEdits,
	undoEdit,
} from "./builder";
import {
	approveFunction,
	functionRuns,
	getFunction,
	listFunctions,
	proposeFunction,
	runFunction,
	setFunctionStatus,
	updateFunction,
	validateDefinition,
} from "./functions";
import {
	aggregateObjects,
	getObject,
	globalSearch,
	searchObjects,
	traverseLink,
} from "./objectSet";
import {
	BadRequest,
	currentSpace,
	getRegistry,
	hasOntology,
	loadRegistry,
	NotFound,
	resolveObjectType,
	spacesWithOntology,
	withSpace,
} from "./registry";
import {
	createConnection,
	createFolder,
	createProject,
	createResource,
	databaseInfo,
	deleteFolder,
	deleteProject,
	deleteResource,
	listProjects,
	listSpaces,
	lookupResource,
	previewResource,
	projectTree,
	publishedViews,
	registerDataset,
	renameResource,
	retestConnection,
	testConnection,
	seedSandbox,
} from "./spaces";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

// Express is behind nginx; without this req.ip is the proxy's address, which
// would make the per-username login throttle log one source for everyone.
app.set("trust proxy", true);

// nginx serves the SPA and proxies both APIs, so the browser only ever calls
// its own origin and needs no CORS at all. CORS_ALLOWED_ORIGINS exists for the
// case of a separately hosted front end; left unset, cross-origin calls are
// simply refused rather than allowed from anywhere.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

if (allowedOrigins.length > 0) {
	app.use(cors({ origin: allowedOrigins, credentials: true }));
	console.log(`[boot] CORS restricted to: ${allowedOrigins.join(", ")}`);
} else {
	console.log("[boot] CORS disabled (same-origin only).");
}

app.use(requestId);

/**
 * One structured line per request.
 *
 * Logging here was console.log prose with no request id, so a 500 could not be
 * tied to the call that caused it and nothing could be correlated with the
 * assistant. The id comes from X-Request-ID when the caller supplied one, so a
 * chat turn and the ontology queries it triggered share a value.
 *
 * /health is skipped: the compose healthcheck hits it every ten seconds.
 */
app.use((req, res, next) => {
	if (req.path === "/health") return next();
	const started = process.hrtime.bigint();
	res.on("finish", () => {
		const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
		console.log(
			JSON.stringify({
				level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
				requestId: req.requestId,
				method: req.method,
				path: req.originalUrl,
				status: res.statusCode,
				durationMs: Math.round(durationMs),
				user: req.principal?.username ?? null,
				role: req.principal?.role ?? null,
			}),
		);
	});
	next();
});

app.use(express.json({ limit: "2mb" }));

/** Wrap an async handler so a rejected promise reaches the error middleware. */
function handle(
	fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
	return (req, res, next) => {
		fn(req, res).catch(next);
	};
}

// ── health and metadata ─────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
	// Reports ok only once the registry is loaded, which is what the compose
	// healthcheck depends on before starting the assistant and the UI.
	try {
		const registry = getRegistry();
		res.json({
			status: "ok",
			ontologyVersion: registry.version,
			ontologyVersionId: registry.ontologyVersionId,
			objectTypes: registry.objectTypes.length,
			linkTypes: registry.linkTypes.length,
			kpis: registry.kpis.length,
			loadedAt: registry.loadedAt,
		});
	} catch {
		res.status(503).json({ status: "starting", detail: "Registry not loaded yet." });
	}
});

// ── authentication ──────────────────────────────────────────────────────────
//
//  ORDER MATTERS, and the order is the security boundary.
//
//  /health is registered above this point and stays anonymous, because the
//  compose healthcheck has no credential to present.
//
//  /api/auth/login is registered before the guard, so it is reachable without a
//  token - it is what issues one.
//
//  app.use("/api", apiAuthorization()) then covers every route registered
//  after it. Anything added below this line is authenticated by default and
//  requires at least the viewer role; see ELEVATED in auth.ts for the routes
//  that demand more. A new route is protected by forgetting about it, not
//  exposed by forgetting about it.

app.post("/api/auth/login", handle(login));

app.use("/api", apiAuthorization());

// ── the space in scope for this request ─────────────────────────────────────
//  The ontology belongs to a space (0012): its object types, links, actions,
//  metrics and lineage are published by a pipeline that ran in one particular
//  space. Everything below reads it through getRegistry(), which resolves it
//  from this context rather than from a parameter — thirty-odd call sites deep
//  in the SQL builders would otherwise each need a space threaded through them
//  for no purpose but to carry it.
//
//  Entering the context here rather than per route means a route added later
//  is space-scoped by default, the same reasoning as the auth guard above.
app.use("/api", (req, _res, next) => {
	const requested = typeof req.query.space === "string" ? req.query.space.trim() : "";
	withSpace(requested || "sandbox", next);
});

app.get("/api/auth/me", me);

app.post(
	"/api/registry/reload",
	handle(async (_req, res) => {
		clearColumnCache();
		await loadRegistry();
		// Reload rebuilds EVERY space's registry, so the answer names the spaces
		// rather than a single version id: after 0012 there is no such thing as
		// "the" active ontology, only one per space.
		const spaces = spacesWithOntology();
		const registry = hasOntology(currentSpace()) ? getRegistry() : null;
		res.json({
			reloaded: true,
			spaces,
			space: currentSpace(),
			ontologyVersionId: registry?.ontologyVersionId ?? null,
			objectTypes: registry?.objectTypes.length ?? 0,
		});
	}),
);

app.get(
	"/api/stats",
	handle(async (_req, res) => {
		const registry = getRegistry();
		const [coverage, exceptions, runs] = await Promise.all([
			query("SELECT * FROM tms_views.v_kpi_data_coverage ORDER BY source_coverage_pct DESC"),
			query("SELECT * FROM tms_views.v_kpi_exception_summary ORDER BY item_count DESC"),
			query(
				`SELECT generation_run_id, started_at, finished_at, status, views_scanned,
				        object_types, link_types, kpis, lineage_nodes
				   FROM platform.generation_run ORDER BY generation_run_id DESC LIMIT 5`,
			),
		]);
		const totalObjects = registry.objectTypes.reduce((sum, t) => sum + t.rowCount, 0);
		res.json({
			dataPolicy: describePolicy(),
			ontology: {
				id: registry.ontologyId,
				version: registry.version,
				label: registry.label,
				description: registry.description,
				createdAt: registry.createdAt,
				validation: registry.validation,
			},
			counts: {
				objectTypes: registry.objectTypes.length,
				objects: totalObjects,
				properties: registry.objectTypes.reduce((sum, t) => sum + t.properties.length, 0),
				linkTypes: registry.linkTypes.length,
				completeLinks: registry.linkTypes.filter((l) => l.isVerified).length,
				actionTypes: registry.actionTypes.length,
				readOnlyActions: registry.actionTypes.filter((a) => a.isReadOnly).length,
				kpis: registry.kpis.length,
				simulatedKpis: registry.kpis.filter((k) => k.dependsOnSimulation).length,
			},
			groups: Object.entries(
				registry.objectTypes.reduce<Record<string, { types: number; objects: number }>>(
					(acc, type) => {
						const key = type.group ?? "Other";
						const bucket = acc[key] ?? { types: 0, objects: 0 };
						bucket.types += 1;
						bucket.objects += type.rowCount;
						acc[key] = bucket;
						return acc;
					},
					{},
				),
			).map(([group, value]) => ({ group, ...value })),
			dataCoverage: coverage,
			exceptions,
			generationRuns: runs,
		});
	}),
);

// ── ontology ────────────────────────────────────────────────────────────────

app.get(
	"/api/ontology",
	handle(async (_req, res) => {
		const registry = getRegistry();
		res.json({
			ontologyVersionId: registry.ontologyVersionId,
			version: registry.version,
			createdAt: registry.createdAt,
			definition: registry.definition,
		});
	}),
);

app.get(
	"/api/ontology/versions",
	handle(async (_req, res) => {
		res.json(
			await query(
				`SELECT ontology_version_id, version, ontology_id, label, is_active,
				        object_type_count, link_type_count, action_type_count, created_at, created_by
				   FROM platform.ontology_version ORDER BY ontology_version_id DESC`,
			),
		);
	}),
);

app.get(
	"/api/ontology/validate",
	handle(async (_req, res) => {
		// Runs ontograph's own validators against the published document, which is
		// the authoritative check. The pipeline runs equivalent reference checks
		// before publishing, so this endpoint normally confirms rather than finds.
		const definition = getRegistry().definition;
		const structural = new OntologyValidator().validate(definition);

		// SHACL shape generation doubles as a check: a shape set that cannot be
		// produced means the attribute datatypes do not map cleanly to XSD.
		let shaclShapeCount: number | null = null;
		let shaclError: string | null = null;
		try {
			shaclShapeCount = new SHACLShapeGenerator().generate(definition).shapes.length;
		} catch (error) {
			shaclError = (error as Error).message;
		}

		res.json({
			valid: structural.valid,
			errors: structural.errors,
			warnings: structural.warnings,
			orphans: structural.orphans,
			cycles: structural.cycles,
			missingAttributes: structural.missingAttributes,
			missingRelations: structural.missingRelations,
			shaclShapeCount,
			shaclError,
		});
	}),
);

app.get(
	"/api/ontology/export/:format",
	handle(async (req, res) => {
		const definition = getRegistry().definition;
		const format = String(req.params.format).toLowerCase();

		// Every exporter takes the ontology in its constructor and renders with
		// export(); there is no per-call ontology argument.
		switch (format) {
			case "json":
				res.type("application/json").send(JSON.stringify(definition, null, 2));
				return;
			case "mermaid":
				res.type("text/plain").send(new MermaidExporter(definition).export());
				return;
			case "er":
				res.type("text/plain").send(new ErDiagramExporter(definition).export());
				return;
			case "dot":
				res.type("text/plain").send(new DotExporter(definition).export());
				return;
			case "owl":
				res.type("text/turtle").send(new OWLExporter(definition).export());
				return;
			case "shacl":
				res.type("text/turtle").send(new SHACLExporter(definition).export());
				return;
			case "shacl-json":
				res
					.type("application/json")
					.send(JSON.stringify(new SHACLShapeGenerator().generate(definition), null, 2));
				return;
			case "json-schema":
				res
					.type("application/json")
					.send(JSON.stringify(new JsonSchemaExporter(definition).export(), null, 2));
				return;
			default:
				throw new BadRequest(
					`Unknown export format '${format}'. Supported: json, mermaid, er, dot, owl, ` +
						"shacl, shacl-json, json-schema.",
				);
		}
	}),
);

// ── object types ────────────────────────────────────────────────────────────

app.get(
	"/api/object-types",
	handle(async (_req, res) => {
		const registry = getRegistry();
		res.json(
			registry.objectTypes.map((type) => ({
				apiName: type.apiName,
				rid: type.rid,
				label: type.label,
				pluralLabel: type.pluralLabel,
				description: type.description,
				kind: type.kind,
				group: type.group,
				icon: type.icon,
				color: type.color,
				rowCount: type.rowCount,
				propertyCount: type.properties.length,
				measureCount: type.properties.filter((p) => p.semanticRole === "measure").length,
				linkCount:
					(registry.linksBySourceRid.get(type.rid) ?? []).length +
					(registry.linksByTargetRid.get(type.rid) ?? []).length,
				sourceView: type.sourceView,
				titleProperty: type.properties.find((p) => p.isTitle)?.apiName ?? null,
				primaryKeyProperty: type.properties.find((p) => p.isIdentity)?.apiName ?? null,
			})),
		);
	}),
);

app.get(
	"/api/object-types/:apiName",
	handle(async (req, res) => {
		const registry = getRegistry();
		const type = resolveObjectType(String(req.params.apiName));
		const forward = registry.linksBySourceRid.get(type.rid) ?? [];
		const inverse = registry.linksByTargetRid.get(type.rid) ?? [];

		res.json({
			apiName: type.apiName,
			rid: type.rid,
			label: type.label,
			pluralLabel: type.pluralLabel,
			description: type.description,
			kind: type.kind,
			group: type.group,
			icon: type.icon,
			color: type.color,
			rowCount: type.rowCount,
			sourceView: type.sourceView,
			properties: type.properties,
			links: [
				...forward.map((link) => ({
					apiName: link.apiName,
					label: link.label,
					description: link.description,
					direction: "forward" as const,
					targetObjectType: registry.objectTypeByRid.get(link.targetObjectType)?.apiName ?? link.targetObjectType,
					cardinality: link.cardinality,
					matchRatio: link.matchRatio,
					isVerified: link.isVerified,
					discoveryMethod: link.discoveryMethod,
					sourceProperty: type.propertyBySqlColumn.get(link.sourceColumn)?.apiName ?? link.sourceColumn,
				})),
				...inverse.map((link) => ({
					apiName: link.inverseApiName ?? link.apiName,
					label: link.inverseLabel ?? link.label,
					description: link.description,
					direction: "inverse" as const,
					targetObjectType: registry.objectTypeByRid.get(link.sourceObjectType)?.apiName ?? link.sourceObjectType,
					cardinality: "ONE_TO_MANY",
					matchRatio: link.matchRatio,
					isVerified: link.isVerified,
					discoveryMethod: link.discoveryMethod,
					sourceProperty: null,
				})),
			],
			actions: registry.actionTypes
				.filter((action) => action.targetObjectTypes.includes(type.rid))
				.map((action) => ({
					apiName: action.apiName,
					label: action.label,
					description: action.description,
					isReadOnly: action.isReadOnly,
					requiresApproval: action.requiresApproval,
					allowedRoles: action.allowedRoles,
					parameters: action.parameters,
				})),
			kpis: registry.kpis
				.filter((kpi) => kpi.relatedObjectTypes.includes(type.rid))
				.map((kpi) => ({ apiName: kpi.apiName, label: kpi.label, category: kpi.category })),
		});
	}),
);

app.get(
	"/api/link-types",
	handle(async (_req, res) => {
		const registry = getRegistry();
		res.json(
			registry.linkTypes.map((link) => ({
				...link,
				sourceApiName: registry.objectTypeByRid.get(link.sourceObjectType)?.apiName ?? null,
				targetApiName: registry.objectTypeByRid.get(link.targetObjectType)?.apiName ?? null,
			})),
		);
	}),
);

app.get(
	"/api/action-types",
	handle(async (_req, res) => {
		res.json(getRegistry().actionTypes);
	}),
);

app.get(
	"/api/roles",
	handle(async (_req, res) => {
		res.json(getRegistry().definition.roles ?? []);
	}),
);

// ── objects ─────────────────────────────────────────────────────────────────

app.post(
	"/api/objects/:apiName/search",
	handle(async (req, res) => {
		res.json(await searchObjects(String(req.params.apiName), req.body ?? {}));
	}),
);

app.post(
	"/api/objects/:apiName/aggregate",
	handle(async (req, res) => {
		res.json(await aggregateObjects(String(req.params.apiName), req.body ?? {}));
	}),
);

app.get(
	"/api/objects/:apiName/:key",
	handle(async (req, res) => {
		const object = await getObject(String(req.params.apiName), String(req.params.key));
		if (!object) throw new NotFound(`No ${req.params.apiName} with key ${req.params.key}.`);
		res.json(object);
	}),
);

app.get(
	"/api/objects/:apiName/:key/links/:linkApiName",
	handle(async (req, res) => {
		res.json(
			await traverseLink(
				String(req.params.apiName),
				String(req.params.key),
				String(req.params.linkApiName),
				Number(req.query.limit ?? 100),
			),
		);
	}),
);

app.get(
	"/api/search",
	handle(async (req, res) => {
		const term = String(req.query.q ?? "");
		res.json(await globalSearch(term, Number(req.query.limit ?? 5)));
	}),
);

// ── KPIs ────────────────────────────────────────────────────────────────────

app.get(
	"/api/kpis",
	handle(async (_req, res) => {
		res.json(getRegistry().kpis);
	}),
);

app.get(
	"/api/kpis/catalogue",
	handle(async (_req, res) => {
		res.json(kpiCatalogueForPrompt());
	}),
);

app.get(
	"/api/kpis/:apiName",
	handle(async (req, res) => {
		res.json(resolveKpi(String(req.params.apiName)));
	}),
);

app.post(
	"/api/kpis/:apiName/execute",
	handle(async (req, res) => {
		res.json(await executeKpi(String(req.params.apiName), req.body ?? {}));
	}),
);

app.get(
	"/api/kpis/:apiName/dimensions/:dimension",
	handle(async (req, res) => {
		res.json(
			await dimensionValues(String(req.params.apiName), String(req.params.dimension)),
		);
	}),
);

// ── dashboards ──────────────────────────────────────────────────────────────

app.get(
	"/api/dashboards",
	handle(async (req, res) => res.json(await listDashboards(req.query.space ? String(req.query.space) : undefined))),
);

// Provenance for every dashboard: which conversation built it, and how it has
// been renamed since. Registered before /api/dashboards/:slug so "history" is
// not read as a slug.
app.get(
	"/api/dashboards/history",
	handle(async (req, res) => res.json(await dashboardHistory(req.query.space ? String(req.query.space) : undefined))),
);

// A backup the user keeps locally. The browser saves the response as a file,
// so this never depends on the server retaining anything.
app.get(
	"/api/dashboards/export",
	handle(async (req, res) => {
		const slugs = String(req.query.slugs ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		res.json(await exportDashboards(req.principal?.username ?? "unknown", slugs, req.query.space ? String(req.query.space) : undefined));
	}),
);

app.post(
	"/api/dashboards/import",
	handle(async (req, res) => {
		const body = req.body ?? {};
		res.json(
			await importDashboards(
				body.backup ?? body,
				req.principal?.username ?? "unknown",
				Boolean(body.overwrite),
				req.query.space ? String(req.query.space) : undefined,
			),
		);
	}),
);

app.post(
	"/api/dashboards/:slug/rename",
	handle(async (req, res) => {
		res.json(
			await renameDashboard(
				String(req.params.slug),
				String((req.body ?? {}).title ?? ""),
				req.principal?.username ?? "unknown",
				req.query.space ? String(req.query.space) : undefined,
			),
		);
	}),
);

app.get(
	"/api/dashboards/:slug",
	handle(async (req, res) => {
		const resolved = String(req.query.resolve ?? "true") !== "false";
		const slug = String(req.params.slug);
		const space = req.query.space ? String(req.query.space) : undefined;
		res.json(resolved ? await resolveDashboard(slug, space) : await getDashboard(slug, space));
	}),
);

app.post(
	"/api/dashboards",
	handle(async (req, res) => {
		const body = req.body ?? {};
		res.status(201).json(
			await saveDashboard({
				...body,
				// The active space wins unless the body names one explicitly, so a
				// board saved while viewing Staging lands in Staging.
				spaceSlug: body.spaceSlug ?? (req.query.space ? String(req.query.space) : undefined),
			}),
		);
	}),
);

app.post(
	"/api/dashboards/validate",
	handle(async (req, res) => {
		res.json(validateLayout((req.body ?? {}).layout));
	}),
);

app.delete(
	"/api/dashboards/:slug",
	handle(async (req, res) => {
		await deleteDashboard(String(req.params.slug), req.query.space ? String(req.query.space) : undefined);
		res.status(204).end();
	}),
);

// ── lineage ─────────────────────────────────────────────────────────────────

app.get(
	"/api/lineage/graph",
	handle(async (req, res) => {
		const layers = req.query.layers
			? String(req.query.layers).split(",").map((s) => s.trim()).filter(Boolean)
			: undefined;
		res.json(await fetchGraph(layers));
	}),
);

app.get(
	"/api/lineage/trace",
	handle(async (req, res) => {
		const nodeId = String(req.query.nodeId ?? "");
		if (!nodeId) throw new BadRequest("nodeId is required.");
		res.json(
			await trace(nodeId, {
				direction: (req.query.direction as "upstream" | "downstream" | "both") ?? "both",
				maxDepth: req.query.depth ? Number(req.query.depth) : undefined,
			}),
		);
	}),
);

app.get(
	"/api/lineage/object-type/:apiName",
	handle(async (req, res) => {
		const type = resolveObjectType(String(req.params.apiName));
		res.json({
			trace: await traceObjectType(type.apiName),
			columns: await columnLineage(type.sourceView),
		});
	}),
);

app.get(
	"/api/lineage/kpi/:apiName",
	handle(async (req, res) => {
		const kpi = resolveKpi(String(req.params.apiName));
		res.json({
			trace: await traceKpi(kpi.apiName),
			columns: await columnLineage(kpi.sourceView),
		});
	}),
);

// ── actions ─────────────────────────────────────────────────────────────────

app.post(
	"/api/actions/:apiName/validate",
	handle(async (req, res) => {
		const meta = resolveAction(String(req.params.apiName));
		res.json({
			action: meta.apiName,
			isReadOnly: meta.isReadOnly,
			requiresApproval: meta.requiresApproval,
			...validateParameters(meta, (req.body ?? {}).parameters ?? {}),
		});
	}),
);

app.post(
	"/api/actions/:apiName/apply",
	handle(async (req, res) => {
		const body = req.body ?? {};
		// Identity comes from the verified token, never from the body. It used to
		// be read from body.actor / body.actorRole, which meant a caller could
		// name any actor and claim any ontology role - including one whose rules
		// permit actions their own role forbids - and the audit row would record
		// whatever they chose. The body can still say what it likes; nothing here
		// reads it.
		const principal = req.principal;
		if (!principal) throw new Error("apply route reached without a principal");

		const outcome = await executeAction(String(req.params.apiName), body.parameters ?? {}, {
			actor: principal.username,
			actorRole: principal.ontologyRole,
			// Whether the assistant drove this is a property of how the request
			// arrived, so it stays caller-supplied; it grants nothing.
			initiatedByAi: Boolean(body.initiatedByAi),
			chatSessionId: body.chatSessionId ? Number(body.chatSessionId) : null,
		});
		const status =
			outcome.status === "failed" ? 422 : outcome.status === "rejected" ? 403 : 200;
		res.status(status).json(outcome);
	}),
);

app.get(
	"/api/actions/audit",
	handle(async (req, res) => {
		res.json(await listAudit(Number(req.query.limit ?? 100)));
	}),
);


// ── pipeline builder ────────────────────────────────────────────────────────

// The real object types, links, actions and KPIs, offered as palette entries
// so a node is configured against something that exists.
app.get(
	"/api/pipelines/palette",
	handle(async (_req, res) => res.json(ontologyPalette())),
);

app.get(
	"/api/pipelines",
	handle(async (req, res) => {
		const space = req.query.space ? String(req.query.space) : undefined;
		res.json(await listPipelines(space));
	}),
);

// Validate a graph without saving it, which is what the canvas calls as the
// user edits.
app.post(
	"/api/pipelines/validate",
	handle(async (req, res) => {
		res.json(validateGraph((req.body ?? {}).graph ?? { nodes: [], edges: [] }));
	}),
);

app.post(
	"/api/pipelines",
	handle(async (req, res) => {
		res.json(await savePipeline(req.body ?? {}, req.principal?.username ?? "unknown"));
	}),
);

app.get(
	"/api/pipelines/:slug",
	handle(async (req, res) =>
		res.json(
			await getPipeline(
				String(req.params.slug),
				req.query.space ? String(req.query.space) : undefined,
			),
		),
	),
);

app.delete(
	"/api/pipelines/:slug",
	handle(async (req, res) => {
		await deletePipeline(
			String(req.params.slug),
			req.query.space ? String(req.query.space) : undefined,
		);
		res.status(204).end();
	}),
);

app.get(
	"/api/pipelines/:slug/versions",
	handle(async (req, res) =>
		res.json(
			await listVersions(
				String(req.params.slug),
				req.query.space ? String(req.query.space) : undefined,
			),
		),
	),
);

app.post(
	"/api/pipelines/:slug/versions/:version/restore",
	handle(async (req, res) => {
		res.json(
			await restoreVersion(
				String(req.params.slug),
				Number(req.params.version),
				req.principal?.username ?? "unknown",
				req.query.space ? String(req.query.space) : undefined,
			),
		);
	}),
);

app.post(
	"/api/pipelines/:slug/run",
	handle(async (req, res) => {
		res.json(
			await runPipeline(
				String(req.params.slug),
				req.principal?.username ?? "unknown",
				req.query.space ? String(req.query.space) : undefined,
			),
		);
	}),
);

app.get(
	"/api/pipelines/:slug/runs",
	handle(async (req, res) => {
		res.json(
			await listRuns(
				String(req.params.slug),
				Number(req.query.limit ?? 20),
				req.query.space ? String(req.query.space) : undefined,
			),
		);
	}),
);

// ── what a run actually produced ────────────────────────────────────────────
//  The estimator had nothing to show beyond a row count, so these are new:
//  each node's rows, timing, materialised table and the SQL it ran.

/** Record a pipeline the assistant drafted (§18). It is inert until accepted. */
app.post(
	"/api/pipelines/propose",
	handle(async (req, res) => {
		res
			.status(201)
			.json(await proposePipeline(req.body, req.principal?.username ?? "unknown"));
	}),
);

/** The Accept in Accept / Edit / Reject. */
app.post(
	"/api/pipelines/:slug/accept",
	handle(async (req, res) => {
		res.json(
			await acceptPipeline(String(req.params.slug), req.principal?.username ?? "unknown"),
		);
	}),
);

app.get(
	"/api/pipelines/runs/:runId/nodes",
	handle(async (req, res) => {
		res.json(await nodeRunsFor(Number(req.params.runId)));
	}),
);

/**
 * Preview a node's materialised output.
 *
 * Restricted to the pipeline_out schema by previewOutput itself: a caller
 * cannot use this to read an arbitrary table, and a warehouse relation goes
 * through the resource preview, which checks it against the registry.
 */
app.get(
	"/api/pipelines/outputs/:qualified/preview",
	handle(async (req, res) => {
		res.json(
			await previewOutput(String(req.params.qualified), Number(req.query.limit ?? 50)),
		);
	}),
);

/** How a materialised dataset's shape has changed run over run. */
app.get(
	"/api/datasets/:qualified/versions",
	handle(async (req, res) => {
		res.json(await datasetVersions(String(req.params.qualified)));
	}),
);

// ── the ontology builder (§7-10) ────────────────────────────────────────────
//  Editing an ontology that a pipeline regenerates. Every change is applied to
//  the live version AND journalled, so the next publish replays it rather than
//  silently discarding it — see builder.ts.

const EDIT_KINDS = ["objectType", "property", "linkType", "actionType"] as const;

function editKind(raw: string): EditKind {
	if (!(EDIT_KINDS as readonly string[]).includes(raw)) {
		throw new BadRequest(
			`'${raw}' is not an editable kind. Use one of: ${EDIT_KINDS.join(", ")}.`,
		);
	}
	return raw as EditKind;
}

app.patch(
	"/api/ontology/:kind/:rid",
	handle(async (req, res) => {
		const body = req.body as { fields?: Record<string, unknown>; note?: string };
		res.json(
			await editOntologyObject(
				editKind(String(req.params.kind)),
				String(req.params.rid),
				body.fields ?? {},
				req.principal?.username ?? "unknown",
				body.note,
			),
		);
	}),
);

/** Draw a link by hand (§9). The match ratio is measured, not assumed. */
app.post(
	"/api/ontology/link-types",
	handle(async (req, res) => {
		res.status(201).json(await createLinkType(req.body, req.principal?.username ?? "unknown"));
	}),
);

app.delete(
	"/api/ontology/:kind/:rid",
	handle(async (req, res) => {
		const kind = editKind(String(req.params.kind));
		if (kind !== "linkType" && kind !== "actionType") {
			throw new BadRequest("Only link types and action types can be deleted.");
		}
		await deleteOntologyObject(kind, String(req.params.rid), req.principal?.username ?? "unknown");
		res.status(204).end();
	}),
);

/** Every change made to this space's ontology, newest first. */
app.get(
	"/api/ontology/edits",
	handle(async (req, res) => res.json(await listEdits(Number(req.query.limit ?? 50)))),
);

app.post(
	"/api/ontology/edits/:id/undo",
	handle(async (req, res) => {
		await undoEdit(Number(req.params.id), req.principal?.username ?? "unknown");
		res.status(204).end();
	}),
);

// ── functions ───────────────────────────────────────────────────────────────
//  A function is drafted (by a person or by the assistant), reviewed, and only
//  then approved into something that can produce numbers. The split is the
//  feature: see functions.ts.

app.get(
	"/api/functions",
	handle(async (req, res) => {
		res.json(await listFunctions(req.query.status ? String(req.query.status) : undefined));
	}),
);

app.get(
	"/api/functions/:apiName",
	handle(async (req, res) => res.json(await getFunction(String(req.params.apiName)))),
);

app.get(
	"/api/functions/:apiName/runs",
	handle(async (req, res) => {
		res.json(await functionRuns(String(req.params.apiName), Number(req.query.limit ?? 25)));
	}),
);

/**
 * Check a definition without saving it.
 *
 * What the proposal dialog calls as the user edits, so a definition that will
 * not run is caught while they are still looking at it rather than on submit.
 */
app.post(
	"/api/functions/validate",
	handle(async (req, res) => {
		const body = req.body as { definition?: string; language?: string };
		res.json(
			await validateDefinition(String(body.definition ?? ""), String(body.language ?? "sql")),
		);
	}),
);

app.post(
	"/api/functions",
	handle(async (req, res) => {
		res
			.status(201)
			.json(await proposeFunction(req.body, req.principal?.username ?? "unknown"));
	}),
);

app.patch(
	"/api/functions/:apiName",
	handle(async (req, res) => {
		res.json(
			await updateFunction(
				String(req.params.apiName),
				req.body,
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

/** The submit button in the proposal dialog. */
app.post(
	"/api/functions/:apiName/approve",
	handle(async (req, res) => {
		res.json(
			await approveFunction(String(req.params.apiName), req.principal?.username ?? "unknown"),
		);
	}),
);

app.post(
	"/api/functions/:apiName/reject",
	handle(async (req, res) => {
		res.json(
			await setFunctionStatus(
				String(req.params.apiName),
				"rejected",
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

app.post(
	"/api/functions/:apiName/archive",
	handle(async (req, res) => {
		res.json(
			await setFunctionStatus(
				String(req.params.apiName),
				"archived",
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

app.post(
	"/api/functions/:apiName/run",
	handle(async (req, res) => {
		// A proposal may be trialled from the dialog before approval, so the
		// reviewer can see the number it produces. It still cannot be used by a
		// dashboard until it is active.
		res.json(
			await runFunction(
				String(req.params.apiName),
				req.principal?.username ?? "unknown",
				req.query.preview === "true",
			),
		);
	}),
);


// ── spaces, projects, folders, resources ────────────────────────────────────

app.get("/api/spaces", handle(async (_req, res) => res.json(await listSpaces())));

// The database this platform is actually running against, read live.
app.get("/api/spaces/database", handle(async (_req, res) => res.json(await databaseInfo())));

// The views a dataset may be registered on, offered by the register dialog.
app.get("/api/spaces/views", handle(async (_req, res) => res.json(publishedViews())));

// Fills the sandbox on first use. Idempotent, so the UI can call it whenever
// the sandbox is empty rather than needing a separate setup step.
app.post(
	"/api/spaces/sandbox/seed",
	handle(async (req, res) => res.json(await seedSandbox(req.principal?.username ?? "unknown"))),
);

app.get(
	"/api/spaces/:space/projects",
	handle(async (req, res) => res.json(await listProjects(String(req.params.space)))),
);

app.post(
	"/api/spaces/:space/projects",
	handle(async (req, res) => {
		const body = req.body ?? {};
		res.json(
			await createProject(
				String(req.params.space),
				String(body.name ?? ""),
				body.description ?? null,
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

app.delete(
	"/api/spaces/:space/projects/:project",
	handle(async (req, res) => {
		await deleteProject(String(req.params.space), String(req.params.project));
		res.status(204).end();
	}),
);

app.get(
	"/api/spaces/:space/projects/:project/tree",
	handle(async (req, res) =>
		res.json(await projectTree(String(req.params.space), String(req.params.project))),
	),
);

app.post(
	"/api/spaces/:space/projects/:project/folders",
	handle(async (req, res) => {
		const body = req.body ?? {};
		res.json(
			await createFolder(
				String(req.params.space),
				String(req.params.project),
				String(body.name ?? ""),
				body.parentId === undefined || body.parentId === null ? null : Number(body.parentId),
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

app.post(
	"/api/spaces/:space/projects/:project/resources",
	handle(async (req, res) => {
		res.json(
			await createResource(
				String(req.params.space),
				String(req.params.project),
				req.body ?? {},
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

// Turn a view - typically one a pipeline node produced - into a dataset
// resource anyone can open, share and build on.
app.post(
	"/api/spaces/:space/projects/:project/datasets",
	handle(async (req, res) => {
		res.json(
			await registerDataset(
				String(req.params.space),
				String(req.params.project),
				req.body ?? {},
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

// Try a connection WITHOUT storing it, so a wrong host or an unreadable secret
// is found before anything is written.
app.post(
	"/api/spaces/connections/test",
	handle(async (req, res) => res.json(await testConnection(req.body ?? {}))),
);

app.post(
	"/api/spaces/:space/projects/:project/connections",
	handle(async (req, res) => {
		res.json(
			await createConnection(
				String(req.params.space),
				String(req.params.project),
				req.body ?? {},
				req.principal?.username ?? "unknown",
			),
		);
	}),
);

app.post(
	"/api/resources/:id/test",
	handle(async (req, res) => res.json(await retestConnection(Number(req.params.id)))),
);

// What the preview window shows: schema, sample rows, lineage and the
// kind-specific detail.
app.get(
	"/api/resources/lookup",
	handle(async (req, res) => {
		res.json(
			await lookupResource(
				String(req.query.kind ?? ""),
				String(req.query.ref ?? ""),
				req.query.space ? String(req.query.space) : undefined,
			),
		);
	}),
);

app.get(
	"/api/resources/:id/preview",
	handle(async (req, res) => res.json(await previewResource(Number(req.params.id)))),
);

app.post(
	"/api/resources/:id/rename",
	handle(async (req, res) =>
		res.json(await renameResource(Number(req.params.id), String((req.body ?? {}).name ?? ""))),
	),
);

app.delete(
	"/api/resources/:id",
	handle(async (req, res) => {
		await deleteResource(Number(req.params.id));
		res.status(204).end();
	}),
);

app.delete(
	"/api/folders/:id",
	handle(async (req, res) => {
		await deleteFolder(Number(req.params.id));
		res.status(204).end();
	}),
);

// ── documentation ───────────────────────────────────────────────────────────
//
//  The corpus the assistant searches and cites. Generated from the live
//  registry rather than stored, so a cited caveat is the caveat in force.

app.get(
	"/api/docs/search",
	handle(async (req, res) => {
		res.json(
			searchDocumentation(String(req.query.q ?? ""), Number(req.query.limit ?? 6)),
		);
	}),
);

app.get(
	"/api/docs",
	handle(async (_req, res) => {
		res.json(
			corpus().map((doc) => ({
				path: doc.path,
				title: doc.title,
				category: doc.category,
				summary: doc.summary,
			})),
		);
	}),
);

// The path carries slashes ("metric/on_time_pct"), so it is taken from the
// wildcard rather than a single parameter.
app.get(
	"/api/docs/page/*",
	handle(async (req, res) => {
		const path = String(req.params[0] ?? "");
		res.json(getDocument(path));
	}),
);

// ── errors ──────────────────────────────────────────────────────────────────

app.use((_req, res) => {
	res.status(404).json({ error: "No such endpoint." });
});

app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
	const status = (error as BadRequest | NotFound & { status?: number }).status ?? 500;

	// A 4xx was raised deliberately by this code and its message is written for
	// the caller ("No such object type: Foo"), so it is safe to return.
	//
	// A 5xx is an unhandled exception. Its message and class name describe our
	// internals - SQL text, connection strings, library internals - so the
	// client gets the request id instead and the detail stays in the log, where
	// the two are joined by that same id.
	if (status >= 500) {
		console.error(
			JSON.stringify({
				level: "error",
				requestId: req.requestId,
				method: req.method,
				path: req.originalUrl,
				user: req.principal?.username ?? null,
				error: error.message,
				type: error.constructor.name,
				stack: error.stack,
			}),
		);
		res.status(500).json({
			error: "Internal server error.",
			requestId: req.requestId,
		});
		return;
	}

	res.status(status).json({ error: error.message, requestId: req.requestId });
});

// ── startup ─────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
	console.log("[boot] TMS ontology service starting.");
	await waitForOntology();
	await loadRegistry();

	// Report the validation state at boot: if the published ontology has a
	// structural problem, the log says so before anyone hits an endpoint.
	const validation = new OntologyValidator().validate(getRegistry().definition);
	if (validation.valid) {
		console.log(
			`[boot] ontology validates (${validation.warnings.length} warning(s)).`,
		);
	} else {
		console.warn(
			`[boot] ontology has ${validation.errors.length} validation error(s). ` +
				`First: ${validation.errors[0]}`,
		);
	}

	const server = app.listen(PORT, "0.0.0.0", () => {
		console.log(`[boot] listening on :${PORT}`);
	});

	const shutdown = async (signal: string) => {
		console.log(`[shutdown] ${signal} received.`);
		server.close();
		await pool.end();
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

void start().catch((error) => {
	console.error("[boot] failed:", error);
	process.exit(1);
});
