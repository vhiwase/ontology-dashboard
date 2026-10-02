import { Link } from "react-router-dom";

/** An empty ontology is the normal start: object types come from datasets. */
export function NoObjectTypesYet() {
	const build = encodeURIComponent(
		"Create object types from every synced dataset, link them, and add the metrics and actions " +
			"that are useful for running freight operations.",
	);
	return (
		<div className="empty-space">
			<div className="empty-space-mark" aria-hidden>
				◇
			</div>
			<h3>No object types yet</h3>
			<p>
				Object types are created from datasets - the views a connection syncs. Open a dataset and
				choose <strong>Create object type</strong>, or let the AI-FDE model every dataset with its
				links, metrics and actions.
			</p>
			<div className="row" style={{ gap: 8, justifyContent: "center" }}>
				<Link className="btn" to="/browse/datasets">
					Open datasets
				</Link>
				<Link className="btn primary" to={`/assistant?prompt=${build}`}>
					Build with the AI-FDE
				</Link>
			</div>
		</div>
	);
}
