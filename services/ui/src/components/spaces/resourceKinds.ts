/**
 * How each resource kind is presented.
 *
 * Shared by the tree, the resource list and the preview window, so an object
 * type carries the same glyph and colour wherever it appears. The accents are
 * grouped by stage: data (connections, datasets), ontology (types, links,
 * actions), computation (metrics) and output (dashboards).
 */

export type ResourceKind =
	| "connection"
	| "dataset"
	| "objectType"
	| "linkType"
	| "actionType"
	| "kpi"
	| "dashboard";

export interface ResourceSpec {
	kind: ResourceKind;
	glyph: string;
	label: string;
	plural: string;
	accent: string;
	/** Where "Open in workbench" goes, given the target reference. */
	route?: (targetRef: string) => string;
}

export const RESOURCE_SPECS: Record<ResourceKind, ResourceSpec> = {
	connection: {
		kind: "connection",
		glyph: "⛁",
		label: "Connection",
		plural: "Connections",
		accent: "var(--node-data)",
	},
	dataset: {
		kind: "dataset",
		glyph: "▤",
		label: "Dataset",
		plural: "Datasets",
		accent: "var(--node-data)",
	},
	objectType: {
		kind: "objectType",
		glyph: "◈",
		label: "Object Type",
		plural: "Object Types",
		accent: "var(--node-ontology)",
		route: (ref) => `/ontology?type=${encodeURIComponent(ref)}`,
	},
	linkType: {
		kind: "linkType",
		glyph: "↔",
		label: "Link Type",
		plural: "Links",
		accent: "var(--node-ontology)",
		route: () => "/graph",
	},
	actionType: {
		kind: "actionType",
		glyph: "⚡",
		label: "Action Type",
		// "Action Types", not "Actions": these are the DEFINITIONS in the
		// ontology. "Actions" is the page where one is executed, and naming both
		// the same made it unclear which a link led to.
		plural: "Action Types",
		accent: "var(--node-ontology)",
		route: () => "/actions",
	},
	kpi: {
		kind: "kpi",
		glyph: "Σ",
		label: "Metric",
		plural: "Metrics",
		accent: "var(--node-transform)",
	},
	dashboard: {
		kind: "dashboard",
		glyph: "▦",
		label: "Dashboard",
		plural: "Dashboards",
		accent: "var(--node-output)",
		route: (ref) => `/dashboards/${ref}`,
	},
};

export const RESOURCE_KIND_LIST = Object.values(RESOURCE_SPECS);

/**
 * The resource kinds as navigation entries, in the order data flows through
 * the platform: it arrives through a connection, lands as a dataset, is
 * modelled as ontology, is measured by metrics and leaves as an output.
 *
 * The slug is the URL segment under /browse. Metrics and Outputs are named for
 * what a reader looks for, not for the internal kind (kpi, dashboard).
 */
export const BROWSE_KINDS: Array<{ slug: string; kind: ResourceKind; label: string }> = [
	{ slug: "connections", kind: "connection", label: "Connections" },
	{ slug: "datasets", kind: "dataset", label: "Datasets" },
	{ slug: "object-types", kind: "objectType", label: "Object Types" },
	{ slug: "links", kind: "linkType", label: "Links" },
	{ slug: "action-types", kind: "actionType", label: "Action Types" },
	{ slug: "metrics", kind: "kpi", label: "Metrics" },
	{ slug: "outputs", kind: "dashboard", label: "Outputs" },
];
