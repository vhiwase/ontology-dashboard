import { Link } from "react-router-dom";
import { Icon } from "../icons";

/** An empty ontology is the normal start: object types come from datasets. */
export function NoObjectTypesYet() {
	const build = encodeURIComponent(
		"Create object types from every synced dataset, link them, and add the metrics and actions " +
			"that are useful for running freight operations.",
	);
	return (
		<div className="empty-space">
			<div className="empty-space-mark" aria-hidden>
				<Icon name="box" size={24} />
			</div>
			<h3>No object types yet</h3>
			<p>
				Object types are created from datasets - the views a connection syncs. Open a dataset and
				choose <strong>Create object type</strong>, or let the AI-FDE model every dataset with its
				links, metrics and actions.
			</p>
			<div className="row" style={{ gap: 8, justifyContent: "center" }}>
				<Link className="btn" to="/browse/datasets">
					<Icon name="table" size={15} />
					Open datasets
				</Link>
				<Link className="btn primary" to={`/assistant?prompt=${build}`}>
					<Icon name="sparkles" size={15} />
					Build with the AI-FDE
				</Link>
			</div>
		</div>
	);
}
