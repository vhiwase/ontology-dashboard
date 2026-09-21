"""The full start-up sequence, in order.

This is what compose runs for the pipeline service. It exists as a module
rather than as a shell chain in the compose file so that the documented
one-off form still works:

    docker compose run --rm pipeline python -m pipeline.users list

An `entrypoint: ["/bin/sh", "-c"]` override would turn that into
`sh -c python -- -m pipeline.users list`, where everything after the command
string becomes $0, $1, ... - so python would be started with no arguments,
read an empty stdin and exit 0 having done nothing at all.

Order matters:
  1. migrate   the schema has to be current before anything writes to it
  2. run       ingestion, ontology generation, lineage, dashboards
  3. users     seed the first admin, which needs app_user to exist
  4. retention purge chat history past the policy window

Any step failing stops the sequence with a non-zero exit, so compose's
service_completed_successfully gate holds the dependent services back.
"""

from __future__ import annotations

import logging
import sys

log = logging.getLogger("pipeline.bootstrap")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )

    from . import migrate, retention, run, users

    steps: list[tuple[str, object]] = [
        ("migrate", lambda: migrate.main([])),
        ("run", lambda: run.main([])),
        ("seed users", lambda: users.main(["seed"])),
        ("retention", lambda: retention.main([])),
    ]

    for name, step in steps:
        log.info("── %s ──", name)
        try:
            code = step()  # type: ignore[operator]
        except SystemExit as exit_signal:
            # argparse and some steps raise SystemExit rather than returning.
            code = exit_signal.code
        except Exception:
            log.exception("Step %r failed.", name)
            return 1
        if code:
            log.error("Step %r exited with %s - stopping.", name, code)
            return int(code)

    log.info("Bootstrap complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
