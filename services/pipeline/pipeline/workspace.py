"""Workspace mode: the platform without the TMS snapshot.

The pipeline was written for one source - the captured TMS payloads mounted at
PIPELINE_SOURCE_DIR - and refused to run without it. That made the snapshot a
hard dependency of the whole stack: no snapshot, no published ontology, so the
ontology service never became healthy and neither the assistant nor the UI
started. A clean clone of this repository could not be brought up at all,
because the snapshot is not part of it.

The platform has a second way to get data now: a person connects a PostgreSQL
database from the UI and models its tables into an ontology. That path needs
nothing from the TMS snapshot, only an ontology version to add object types
to. So when the snapshot is absent this module publishes an EMPTY ontology
into the space instead of failing, and the TMS-specific stages are skipped.

What it never does is generate data to fill the gap. The empty ontology has no
object types, no metrics and no dashboards; everything that appears in it later
comes from tables a person connected.

An existing active ontology is left alone. If the snapshot was mounted on an
earlier run and has since gone, the ontology published from it stays active -
replacing a populated ontology with an empty one because a volume was not
mounted this time would be data loss dressed up as a fallback.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg

from .actions import ROLES
from .db import query_one, space_id

log = logging.getLogger("pipeline.workspace")

WORKSPACE_ONTOLOGY_ID = "ws:Workspace"
WORKSPACE_VERSION = "1.0.0"


def empty_definition(label: str, description: str) -> dict[str, Any]:
    """A valid OntologyDefinition with nothing in it yet.

    Roles are carried over from the action layer because a user's
    ontology_role must resolve against the roles of the ontology in scope, and
    every role a user can hold is one of these.
    """
    return {
        "@context": {
            "ontograph": "https://ontograph.dev/schema#",
            "ws": "https://ontograph.dev/workspace#",
            "xsd": "http://www.w3.org/2001/XMLSchema#",
        },
        "@id": WORKSPACE_ONTOLOGY_ID,
        "@type": "Ontology",
        "version": WORKSPACE_VERSION,
        "label": {"en": label},
        "description": {"en": description},
        "entityTypes": [],
        "eventTypes": [],
        "relationTypes": [],
        "valueTypes": [],
        "attributes": [],
        "constraints": [],
        "interfaces": [],
        "views": [],
        "actionTypes": [],
        "logicRules": [],
        "roles": ROLES,
    }


def ensure_workspace_ontology(conn: psycopg.Connection, space_slug: str) -> dict[str, Any]:
    """Make sure the space has an active ontology, publishing an empty one if not.

    Returns what happened, for the generation run's stage log.
    """
    space = space_id(conn, space_slug)
    active = query_one(
        conn,
        """
        SELECT ontology_version_id, ontology_id, object_type_count
          FROM platform.ontology_version
         WHERE space_id = %s AND is_active
        """,
        (space,),
    )
    if active:
        log.info(
            "Space '%s' already has an active ontology (version %s, %s object types); "
            "leaving it as it is.",
            space_slug,
            active["ontology_version_id"],
            active["object_type_count"],
        )
        return {
            "published": False,
            "ontologyVersionId": int(active["ontology_version_id"]),
            "reason": "an ontology is already active in this space",
        }

    definition = empty_definition(
        "Workspace ontology",
        "Object types, links and metrics modelled from the tables connected to this "
        "workspace. It starts empty: nothing here is generated.",
    )
    row = query_one(
        conn,
        """
        INSERT INTO platform.ontology_version
            (space_id, version, ontology_id, label, description, definition, validation,
             object_type_count, link_type_count, action_type_count, is_active, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, 0, 0, 0, true, 'pipeline')
        RETURNING ontology_version_id
        """,
        (
            space,
            WORKSPACE_VERSION,
            WORKSPACE_ONTOLOGY_ID,
            definition["label"]["en"],
            definition["description"]["en"],
            json.dumps(definition),
            json.dumps({"valid": True, "errors": [], "warnings": [], "note": "empty workspace"}),
        ),
    )
    assert row is not None
    version_id = int(row["ontology_version_id"])
    log.info("Published an empty workspace ontology into '%s' (version %s).", space_slug, version_id)
    return {"published": True, "ontologyVersionId": version_id}
