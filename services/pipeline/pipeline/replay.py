"""Re-apply user edits after the ontology is republished.

The pipeline generates the ontology from the views: every run writes a new
ontology_version and shreds it into object_type, link_type and action_type.
Nothing carries forward between versions.

That is fine for anything the pipeline derives, and fatal for anything a
person did by hand. A label someone corrected, a link they drew because the
naming convention did not reveal it, an action they defined - all of it would
be silently absent from the next version, with no error and no trace.

platform.ontology_edit records those changes as intentions keyed by RID, which
is stable across versions. This replays them onto the version just published,
in the order they were made, so the last edit to a field wins.

Replay is deliberately forgiving: an edit that no longer applies - a property
that was dropped, an object type the views no longer produce - is logged and
skipped rather than failing the run. The alternative is a pipeline that cannot
publish because of an edit made months ago to something that is gone.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg

from .config import CONFIG
from .db import execute, query, space_id

log = logging.getLogger("pipeline.replay")

# Which table each edit kind lands in, and the column holding its RID.
TARGETS: dict[str, tuple[str, str]] = {
    "objectType": ("platform.object_type", "object_type_rid"),
    "property": ("platform.object_property", "object_property_rid"),
    "linkType": ("platform.link_type", "link_type_rid"),
    "actionType": ("platform.action_type", "action_type_rid"),
}

# The same allow-list the service enforces. Duplicated deliberately: replay
# runs from stored JSON that the service wrote, but a column name reaching SQL
# should be checked where it is used, not assumed safe because of where it came
# from.
COLUMNS: dict[str, dict[str, str]] = {
    "objectType": {
        "label": "label",
        "pluralLabel": "plural_label",
        "description": "description",
        "icon": "icon",
        "color": "color",
        "group": "group_name",
        "titleColumn": "title_column",
        "displayOrder": "display_order",
        "kind": "kind",
    },
    "property": {
        "label": "label",
        "description": "description",
        "semanticRole": "semantic_role",
        "defaultAggregation": "default_aggregation",
        "unit": "unit",
        "displayOrder": "display_order",
    },
    "linkType": {
        "label": "label",
        "description": "description",
        "cardinality": "cardinality",
        "inverseLabel": "inverse_label",
        "isVerified": "is_verified",
    },
    "actionType": {
        "label": "label",
        "description": "description",
        "parameters": "parameters",
        "requiresApproval": "requires_approval",
        "approverRoles": "approver_roles",
        "allowedRoles": "allowed_roles",
        "isReadOnly": "is_read_only",
        "tags": "tags",
    },
}


def _apply_update(
    conn: psycopg.Connection,
    kind: str,
    rid: str,
    payload: dict[str, Any],
    version_id: int,
) -> bool:
    table, rid_column = TARGETS[kind]
    allowed = COLUMNS[kind]

    assignments: list[str] = []
    values: list[Any] = []
    for key, value in payload.items():
        column = allowed.get(key)
        if column is None:
            log.warning("Skipping unknown field %r on %s %s.", key, kind, rid)
            continue
        assignments.append(f"{column} = %s")
        values.append(json.dumps(value) if isinstance(value, (dict, list)) else value)

    if not assignments:
        return False

    changed = execute(
        conn,
        f"UPDATE {table} SET {', '.join(assignments)} "
        f"WHERE {rid_column} = %s AND ontology_version_id = %s",
        (*values, rid, version_id),
    )
    return changed > 0


def _apply_link_create(
    conn: psycopg.Connection, rid: str, payload: dict[str, Any], version_id: int
) -> bool:
    """Re-create a hand-drawn link.

    The pipeline will never discover this link - that is precisely why someone
    drew it - so replay has to insert it outright. Both ends are re-resolved
    against the NEW version, because an object type may have been renamed or
    dropped since the link was drawn.
    """
    source = query(
        conn,
        "SELECT object_type_rid FROM platform.object_type "
        "WHERE api_name = %s AND ontology_version_id = %s",
        (payload.get("sourceObjectType"), version_id),
    )
    target = query(
        conn,
        "SELECT object_type_rid FROM platform.object_type "
        "WHERE api_name = %s AND ontology_version_id = %s",
        (payload.get("targetObjectType"), version_id),
    )
    if not source or not target:
        log.warning(
            "Link %s references %s -> %s, which this version does not have. Skipped.",
            rid,
            payload.get("sourceObjectType"),
            payload.get("targetObjectType"),
        )
        return False

    execute(
        conn,
        """
        INSERT INTO platform.link_type
            (link_type_rid, ontology_version_id, api_name, label, description,
             source_object_type, target_object_type, source_column, target_column,
             cardinality, inverse_label, discovery_method, is_verified, is_user_defined)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'manual',false,true)
        ON CONFLICT (ontology_version_id, link_type_rid) DO NOTHING
        """,
        (
            rid,
            version_id,
            payload.get("apiName"),
            payload.get("label") or payload.get("apiName"),
            payload.get("description"),
            source[0]["object_type_rid"],
            target[0]["object_type_rid"],
            payload.get("sourceProperty"),
            payload.get("targetProperty"),
            payload.get("cardinality") or "MANY_TO_ONE",
            payload.get("inverseLabel"),
        ),
    )
    return True


def replay_edits(conn: psycopg.Connection, version_id: int) -> dict[str, int]:
    """Apply this space's journal to the version just published."""
    space = space_id(conn, CONFIG.space)

    edits = query(
        conn,
        """
        SELECT ontology_edit_id, target_kind, target_rid, operation, payload
          FROM platform.ontology_edit
         WHERE space_id = %s AND is_active
         ORDER BY created_at
        """,
        (space,),
    )

    if not edits:
        return {"applied": 0, "skipped": 0}

    applied = 0
    skipped = 0
    for edit in edits:
        kind = edit["target_kind"]
        rid = edit["target_rid"]
        payload = edit["payload"] or {}

        if kind not in TARGETS:
            skipped += 1
            continue

        try:
            if edit["operation"] == "create" and kind == "linkType":
                ok = _apply_link_create(conn, rid, payload, version_id)
            elif edit["operation"] == "update":
                ok = _apply_update(conn, kind, rid, payload, version_id)
            else:
                # A create for a kind replay cannot rebuild yet. Counted as
                # skipped and named, rather than dropped silently.
                log.warning("No replay rule for %s %s on %s.", edit["operation"], kind, rid)
                ok = False
        except psycopg.Error as exc:
            # One bad edit must not stop a publish; the rest still apply.
            log.warning("Edit %s on %s failed: %s", edit["ontology_edit_id"], rid, exc)
            ok = False

        if ok:
            applied += 1
        else:
            skipped += 1

    log.info(
        "Replayed %d user edit(s) onto version %d (%d no longer applied).",
        applied,
        version_id,
        skipped,
    )
    return {"applied": applied, "skipped": skipped}
