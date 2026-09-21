"""Stage 3b - discover link types between object views.

Three signals are combined, in this order:

1. NAMING CONVENTION. A column ending in _key that is not the view's own key is a
   reference. Its target is the object view whose own key column is a suffix of
   that column name: origin_location_key -> v_location (location_key),
   parent_business_entity_key -> v_business_entity, account_key -> v_account.

2. PARTY FALLBACK. The TMS keeps one party master and projects it into role
   views (Location, Carrier, BillTo, ...). A reference named for one role
   frequently resolves to a party holding a different role - the existing
   analysis in TMS_MCP/api_responses/_relationship_analysis.json found order
   origins split 65 Location / 25 BillTo. So every reference that resolves to a
   role projection is ALSO probed against the party master, which catches the
   remainder.

3. VALUE OVERLAP. Every candidate from (1) and (2) is then probed against the
   real data: what share of non-null source values actually resolve to a target
   row, and are those values unique. A candidate below
   PIPELINE_LINK_MIN_MATCH_RATIO is dropped; the rest are recorded WITH their
   match ratio, because a 72% join is a real modelling fact and hiding it behind
   a clean arrow is how a lossy join gets mistaken for a complete one.

References with no candidate target at all (service level, shipment type,
payment term, NMFC) are not silently dropped either - they are returned as
unresolved references, because "this ontology has a dangling reference to a
config object the snapshot never fetched" is information a data modeller wants.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import psycopg

from .config import CONFIG
from .db import query
from .introspect import ViewInfo, camel_case, humanize, pascal_case, pluralize

log = logging.getLogger("pipeline.relationships")

# Role views that are projections of the single party master, v_business_entity.
# Declared rather than inferred: these are the views 04_views.sql defines with an
# explicit `WHERE is_<role>` filter over v_business_entity.
PARTY_MASTER_VIEW = "v_business_entity"
PARTY_PROJECTIONS = {
    "v_location", "v_carrier", "v_customer", "v_supplier",
    "v_bill_to", "v_broker", "v_agent",
}

# Views whose references express the declared party hierarchy rather than a
# transactional reference; tagged so the UI can group them separately.
DECLARED_HIERARCHY_VIEWS = {"v_entity_relationship"}


@dataclass
class LinkCandidate:
    source_view: ViewInfo
    target_view: ViewInfo
    source_column: str
    target_column: str
    # True when the target's own name appears in the referencing column, i.e.
    # the column says what it points at. False for the party fallback.
    is_named_target: bool
    discovery_method: str
    matched_rows: int = 0
    candidate_rows: int = 0
    distinct_source_values: int = 0
    match_ratio: float = 0.0
    is_source_unique: bool = False

    @property
    def fk_prefix(self) -> str:
        """origin_location_key -> origin_location; account_key -> account."""
        return self.source_column[:-4] if self.source_column.endswith("_key") else self.source_column

    @property
    def role_prefix(self) -> str:
        """The part of the column that qualifies the role: origin_location -> origin.

        Empty when the column is just the target name (account_key).
        """
        prefix = self.fk_prefix
        target_base = self.target_view.base_name
        if prefix == target_base:
            return ""
        if prefix.endswith("_" + target_base):
            return prefix[: -(len(target_base) + 1)]
        return prefix

    @property
    def cardinality(self) -> str:
        """Always MANY_TO_ONE for a foreign-key reference.

        Deliberately not inferred from the data. This snapshot happens to carry
        exactly one shipment per order, so a uniqueness check would declare
        Shipment -> Order a one-to-one and the UI would stop offering to expand
        an order into several shipments - which the TMS plainly supports. What
        the data shows is recorded in is_source_unique and stated in the link's
        description instead of being promoted to a structural claim.
        """
        return "MANY_TO_ONE"


@dataclass
class UnresolvedReference:
    source_view: str
    source_column: str
    reason: str
    distinct_values: int = 0


@dataclass
class DiscoveryResult:
    links: list[LinkCandidate] = field(default_factory=list)
    unresolved: list[UnresolvedReference] = field(default_factory=list)


def _candidate_targets(
    source: ViewInfo, column: str, objects: list[ViewInfo]
) -> list[tuple[ViewInfo, bool]]:
    """Object views this column could point at, with whether the name says so."""
    named: list[tuple[ViewInfo, bool]] = []
    for target in objects:
        if not target.key_column:
            continue
        if target.view_name == source.view_name and column != target.key_column:
            # A self-reference is legitimate (entity relationship parent/child),
            # so it is allowed through; only the identity column itself is not a
            # reference.
            pass
        key = target.key_column
        if column == key or column.endswith("_" + key):
            named.append((target, True))

    # Party fallback: if any named target is a role projection, the party master
    # is a candidate too, because the reference may resolve to a party holding a
    # different role.
    if named and any(t.view_name in PARTY_PROJECTIONS for t, _ in named):
        master = next((v for v in objects if v.view_name == PARTY_MASTER_VIEW), None)
        if master and all(t.view_name != PARTY_MASTER_VIEW for t, _ in named):
            named.append((master, False))

    return named


def _probe(
    conn: psycopg.Connection, candidate: LinkCandidate
) -> LinkCandidate:
    """Measure how well the reference actually resolves against the data."""
    source = candidate.source_view.qualified
    target = candidate.target_view.qualified
    statement = f"""
        SELECT count(*)                                          AS candidate_rows,
               count(t."{candidate.target_column}")              AS matched_rows,
               count(DISTINCT s."{candidate.source_column}")     AS distinct_source_values
        FROM {source} s
        LEFT JOIN {target} t
               ON t."{candidate.target_column}" = s."{candidate.source_column}"
        WHERE s."{candidate.source_column}" IS NOT NULL
    """
    try:
        row = query(conn, statement)[0]
    except psycopg.Error as exc:
        # Almost always a type mismatch: a text key probed against a uuid key.
        # That is a real "these do not join" answer, not a crash.
        conn.rollback()
        log.debug(
            "Probe %s.%s -> %s.%s failed (%s); treating as no match.",
            candidate.source_view.view_name, candidate.source_column,
            candidate.target_view.view_name, candidate.target_column,
            str(exc).splitlines()[0],
        )
        return candidate

    candidate.candidate_rows = int(row["candidate_rows"] or 0)
    candidate.matched_rows = int(row["matched_rows"] or 0)
    candidate.distinct_source_values = int(row["distinct_source_values"] or 0)
    if candidate.candidate_rows:
        candidate.match_ratio = candidate.matched_rows / candidate.candidate_rows
        candidate.is_source_unique = (
            candidate.distinct_source_values == candidate.candidate_rows
        )
    return candidate


def discover_links(conn: psycopg.Connection, views: list[ViewInfo]) -> DiscoveryResult:
    objects = [v for v in views if not v.is_metric and v.key_column]
    result = DiscoveryResult()

    for source in objects:
        for prop in source.foreign_keys:
            candidates = _candidate_targets(source, prop.name, objects)
            if not candidates:
                distinct = _distinct_count(conn, source, prop.name)
                result.unresolved.append(
                    UnresolvedReference(
                        source_view=source.view_name,
                        source_column=prop.name,
                        reason=(
                            "No object view exposes a matching key column. The "
                            "snapshot never fetched this configuration object, so "
                            "the reference has nothing to point at."
                        ),
                        distinct_values=distinct,
                    )
                )
                continue

            probed: list[LinkCandidate] = []
            for target, is_named in candidates:
                method = (
                    "declared_hierarchy"
                    if source.view_name in DECLARED_HIERARCHY_VIEWS
                    else ("naming_convention" if is_named else "value_overlap")
                )
                candidate = LinkCandidate(
                    source_view=source,
                    target_view=target,
                    source_column=prop.name,
                    target_column=target.key_column,  # type: ignore[arg-type]
                    is_named_target=is_named,
                    discovery_method=method,
                )
                probed.append(_probe(conn, candidate))

            kept = [c for c in probed if c.match_ratio >= CONFIG.link_min_match_ratio]
            if not kept:
                best = max(probed, key=lambda c: c.match_ratio, default=None)
                result.unresolved.append(
                    UnresolvedReference(
                        source_view=source.view_name,
                        source_column=prop.name,
                        reason=(
                            f"Best candidate {best.target_view.view_name} resolved only "
                            f"{best.match_ratio:.1%} of {best.candidate_rows} values, "
                            f"below the {CONFIG.link_min_match_ratio:.0%} threshold."
                            if best
                            else "No candidate resolved any value."
                        ),
                        distinct_values=best.distinct_source_values if best else 0,
                    )
                )
                continue

            # The column name is the strongest statement of intent, so a named
            # target wins the clean link name even when the party master
            # resolves more rows.
            kept.sort(key=lambda c: (not c.is_named_target, -c.match_ratio))

            # The party fallback exists only to catch references the named role
            # projection cannot resolve. Where the named target already resolves
            # every row it adds a second arrow that means the same thing, so it is
            # dropped - otherwise the graph doubles in size and every object gains
            # a duplicate path to the party master.
            named_complete = any(
                c.is_named_target and c.match_ratio >= 0.999 for c in kept
            )
            if named_complete:
                kept = [c for c in kept if c.is_named_target]

            result.links.extend(kept)

    _assign_names(result.links)

    complete = sum(1 for link in result.links if link.match_ratio >= 0.999)
    log.info(
        "Discovered %d link types (%d complete joins, %d partial) and %d unresolved references.",
        len(result.links), complete, len(result.links) - complete, len(result.unresolved),
    )
    for link in sorted(result.links, key=lambda c: c.match_ratio):
        if link.match_ratio < 0.999:
            log.info(
                "    partial  %-46s %5.1f%% of %d rows -> %s",
                f"{link.source_view.api_name}.{link.source_column}",
                link.match_ratio * 100, link.candidate_rows, link.target_view.api_name,
            )
    for ref in result.unresolved:
        log.info("    unresolved %-40s %s", f"{ref.source_view}.{ref.source_column}", ref.reason)

    return result


def _distinct_count(conn: psycopg.Connection, view: ViewInfo, column: str) -> int:
    try:
        row = query(
            conn,
            f'SELECT count(DISTINCT "{column}") AS n FROM {view.qualified} WHERE "{column}" IS NOT NULL',
        )[0]
        return int(row["n"] or 0)
    except psycopg.Error:
        conn.rollback()
        return 0


def _assign_names(links: list[LinkCandidate]) -> None:
    """Give every link a stable, readable api_name and a sensible inverse.

    The first link for a given (source, column) pair gets the clean name; any
    further candidate for the same column - which is always the party fallback -
    is suffixed with its target so the two never collide.
    """
    # Uniqueness is per owning type, not global: Account.orders and BillTo.orders
    # are different properties on different objects and must both keep the clean
    # name. A global set would rename the second to "orders2".
    seen_forward: dict[str, set[str]] = {}
    seen_inverse: dict[str, set[str]] = {}
    by_column: dict[tuple[str, str], int] = {}

    for link in links:
        slot = by_column.get((link.source_view.view_name, link.source_column), 0)
        by_column[(link.source_view.view_name, link.source_column)] = slot + 1

        base = camel_case(f"{link.source_view.base_name}_{link.fk_prefix}")
        forward = base if slot == 0 else camel_case(
            f"{link.source_view.base_name}_{link.fk_prefix}_{link.target_view.base_name}"
        )
        forward = _unique(forward, seen_forward.setdefault(link.source_view.view_name, set()))

        role = link.role_prefix
        source_plural = camel_case(pluralize(link.source_view.api_name))
        inverse = source_plural if not role else camel_case(
            f"{pluralize(link.source_view.api_name)}_as_{role}"
        )
        if slot > 0:
            inverse = camel_case(f"{inverse}_{link.target_view.base_name}")
        inverse = _unique(inverse, seen_inverse.setdefault(link.target_view.view_name, set()))

        link.api_name = forward           # type: ignore[attr-defined]
        link.inverse_api_name = inverse   # type: ignore[attr-defined]
        link.label = humanize(link.fk_prefix)  # type: ignore[attr-defined]
        link.inverse_label = (            # type: ignore[attr-defined]
            f"{pluralize(humanize(link.source_view.base_name))}"
            + (f" (as {humanize(role).lower()})" if role else "")
        )
        # Spell out what the link means, including how complete it is, because
        # this string is what the assistant reads when deciding whether to
        # traverse it.
        completeness = (
            "resolves every reference"
            if link.match_ratio >= 0.999
            else f"resolves {link.match_ratio:.0%} of references"
        )
        observed = (
            " In this snapshot each source row points at a distinct target."
            if link.is_source_unique and link.candidate_rows > 1
            else ""
        )
        link.description = (  # type: ignore[attr-defined]
            f"{humanize(link.source_view.base_name)}.{humanize(link.fk_prefix)} "
            f"points at {humanize(link.target_view.base_name)}; {completeness} "
            f"({link.matched_rows} of {link.candidate_rows} rows).{observed}"
        )


def _unique(name: str, seen: set[str]) -> str:
    if name not in seen:
        seen.add(name)
        return name
    for suffix in range(2, 100):
        alternative = f"{name}{suffix}"
        if alternative not in seen:
            seen.add(alternative)
            return alternative
    seen.add(name)
    return name
