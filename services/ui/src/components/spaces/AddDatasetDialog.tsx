/**
 * Adding a dataset, from the Datasets page.
 *
 * A dataset is a view copied through a connection, so adding one is choosing
 * the connection and the view: the same sync the Connections page sets up.
 * It used to be reachable only from there, which left the page called
 * "Datasets" with no way to add one.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BrowseResource } from "../../ResourceContext";
import { Icon } from "../icons";
import { NewSync } from "./SyncPanel";

export function AddDatasetDialog({
	connections,
	onClose,
	onDone,
}: {
	/** The connections in this space. */
	connections: BrowseResource[];
	onClose: () => void;
	/** The sync exists; `datasetResourceId` is its dataset when it was copied at once. */
	onDone: (message: string, datasetResourceId: number | null) => void;
}) {
	const [connectionId, setConnectionId] = useState<number | null>(connections[0]?.id ?? null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="card" role="dialog" aria-modal="true" aria-label="Add a dataset">
			<div className="card-head">
				<span className="stage-icon" aria-hidden>
					<Icon name="table" size={15} />
				</span>
				<h3>Add a dataset</h3>
				<span className="sub">a view copied through a connection, as it is</span>
				<button className="icon-btn" onClick={onClose} aria-label="Close">
					<Icon name="x" size={17} />
				</button>
			</div>

			{connections.length === 0 ? (
				<>
					<p className="secondary" style={{ margin: "0 0 12px" }}>
						There is no connection in this space yet. A dataset is copied from a database through one, so
						create the connection first; its views can then be added here.
					</p>
					<div className="row">
						<Link className="btn primary sm" to="/browse/connections">
							<Icon name="database" size={13} />
							Go to connections
						</Link>
					</div>
				</>
			) : (
				<>
					<label className="field">
						<span>Connection</span>
						<select value={connectionId ?? ""} onChange={(event) => setConnectionId(Number(event.target.value))}>
							{connections.map((connection) => (
								<option key={connection.id} value={connection.id}>
									{connection.name}
								</option>
							))}
						</select>
						<span className="field-hint">The database the view is read from.</span>
					</label>
					{connectionId !== null && (
						<NewSync resourceId={connectionId} bare submitLabel="Add dataset" onCancel={onClose} onDone={onDone} />
					)}
				</>
			)}
		</div>
	);
}
