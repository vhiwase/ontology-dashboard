"""Run one Python transform from a code repository.

WHAT THIS IS. The platform's half of a Foundry-shaped transform: the user
writes a decorated function, this runs it, and the ontology service writes what
it returns into a dataset.

    @transform(
        output=Output("repo_out.order_exception_scores"),
        orders=Input("tms_views.v_order"),
    )
    def compute(orders, output):
        output.write([...])

TWO PASSES, and the reason for them. The service cannot know which relations to
read until it has seen the decorator, and it cannot hand the rows over until it
has read them. So:

    declare <code.py>              prints the declared inputs and output
    execute <code.py> <data.json>  runs the function against those rows

The module is imported in both passes, so anything at module level runs twice.
That is a property worth knowing rather than a problem: a transform's module
body should declare, not do.

WHAT USER CODE CANNOT REACH. No database handle, no connection string, no
credential: the environment is emptied by the caller and the rows arrive as
plain lists of dicts on a file descriptor. Everything it can touch, it was
given. This is not a sandbox against a determined adversary - it shares a
container with the service, and the honest description is "an ordinary Python
process with nothing useful in it" - but it does mean a transform cannot reach
the warehouse behind the service's back.

PROTOCOL. One JSON document on stdout, and nothing else: user code writing to
stdout would otherwise corrupt the result, so stdout is redirected to stderr
for the duration of the call and print() lands in the build log where it is
useful.
"""

from __future__ import annotations

import contextlib
import datetime
import decimal
import importlib.util
import io
import json
import sys
import traceback
from typing import Any


class TransformError(Exception):
    """A fault in the transform, as opposed to a fault in this runner."""


# ── the API the transform imports ───────────────────────────────────────────


class Input:
    """A relation this transform reads. Arrives as a list of dicts."""

    def __init__(self, relation: str):
        if not isinstance(relation, str) or not relation.strip():
            raise TransformError("Input() needs a relation name, e.g. Input('tms_views.v_order').")
        self.relation = relation.strip()

    def __repr__(self) -> str:
        return f"Input({self.relation!r})"


class Output:
    """The dataset this transform writes. Exactly one per transform."""

    def __init__(self, relation: str):
        if not isinstance(relation, str) or not relation.strip():
            raise TransformError(
                "Output() needs a relation name, e.g. Output('repo_out.my_table')."
            )
        self.relation = relation.strip()
        self._rows: list[dict[str, Any]] | None = None

    def write(self, rows: Any) -> None:
        """Hand the result back. Calling it twice replaces the first result."""
        if rows is None:
            raise TransformError(
                "output.write(None) writes nothing. Pass a list of dicts, or [] "
                "if the transform genuinely produced no rows."
            )
        if isinstance(rows, dict):
            raise TransformError(
                "output.write() takes a LIST of dicts, one per row. It was given a "
                "single dict - wrap it: output.write([row])."
            )
        try:
            materialised = list(rows)
        except TypeError as exc:
            raise TransformError(
                f"output.write() takes a list of dicts; {type(rows).__name__} is not iterable."
            ) from exc

        for index, row in enumerate(materialised):
            if not isinstance(row, dict):
                raise TransformError(
                    f"Row {index} is a {type(row).__name__}, not a dict. Every row must be a "
                    "dict whose keys are the column names."
                )
        self._rows = materialised

    @property
    def written(self) -> bool:
        return self._rows is not None

    def __repr__(self) -> str:
        return f"Output({self.relation!r})"


_REGISTERED: list[dict[str, Any]] = []


def transform(output: Output | None = None, **inputs: Input):
    """Declare a transform: what it reads, and the one dataset it writes."""

    def decorate(function):
        if output is not None and not isinstance(output, Output):
            raise TransformError("output= must be an Output(...).")
        for name, value in inputs.items():
            if not isinstance(value, Input):
                raise TransformError(
                    f"{name}= must be an Input(...); it is a {type(value).__name__}."
                )
        _REGISTERED.append({"function": function, "output": output, "inputs": dict(inputs)})
        return function

    return decorate


def _install_api_module() -> None:
    """Make `from transforms.api import ...` resolve to this file's objects.

    A real package on disk would be tidier, but it would also be one more thing
    that can be out of step with the runner actually executing. Registering the
    modules in sys.modules keeps the API and its implementation the same code.
    """
    import types

    package = types.ModuleType("transforms")
    package.__path__ = []  # marks it as a package so the submodule import works
    api = types.ModuleType("transforms.api")
    api.transform = transform
    api.Input = Input
    api.Output = Output
    api.TransformError = TransformError
    package.api = api
    sys.modules["transforms"] = package
    sys.modules["transforms.api"] = api


# ── loading the user's module ───────────────────────────────────────────────


def _load(path: str, log: io.StringIO) -> dict[str, Any]:
    _install_api_module()
    _REGISTERED.clear()

    spec = importlib.util.spec_from_file_location("repo_transform", path)
    if spec is None or spec.loader is None:
        raise TransformError(f"{path} could not be loaded as a Python module.")
    module = importlib.util.module_from_spec(spec)

    # print() from module level belongs in the build log, not in the result.
    with contextlib.redirect_stdout(log):
        spec.loader.exec_module(module)

    if len(_REGISTERED) == 0:
        raise TransformError(
            "No @transform in this file. A transform file declares one function "
            "decorated with @transform(output=Output(...), name=Input(...))."
        )
    if len(_REGISTERED) > 1:
        raise TransformError(
            f"{len(_REGISTERED)} @transform functions in one file. Put each in its own "
            "file, so a build can name the one that failed."
        )
    return _REGISTERED[0]


# ── JSON that survives the round trip ───────────────────────────────────────


def _encode(value: Any) -> Any:
    """Values Python produced, in a shape the service can write to a column."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, decimal.Decimal):
        # Through a string rather than a float: a freight charge that arrives as
        # 1200212.47 must not come back as 1200212.469999999.
        return str(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (list, tuple, dict)):
        return json.loads(json.dumps(value, default=str))
    if isinstance(value, (bytes, bytearray)):
        raise TransformError("Binary values cannot be written to a dataset column.")
    return str(value)


# ── the two passes ──────────────────────────────────────────────────────────


def _declare(path: str) -> dict[str, Any]:
    log = io.StringIO()
    registered = _load(path, log)
    output = registered["output"]
    return {
        "ok": True,
        "output": output.relation if output is not None else None,
        "inputs": {name: value.relation for name, value in registered["inputs"].items()},
        "function": registered["function"].__name__,
        "log": log.getvalue(),
    }


def _execute(path: str, data_path: str) -> dict[str, Any]:
    with open(data_path, encoding="utf-8") as handle:
        supplied = json.load(handle)

    log = io.StringIO()
    registered = _load(path, log)
    output = registered["output"]
    if output is None:
        raise TransformError("This transform declares no Output, so there is nothing to write.")

    arguments: dict[str, Any] = {}
    for name, declared in registered["inputs"].items():
        if declared.relation not in supplied:
            raise TransformError(f"No rows were supplied for {name}={declared!r}.")
        arguments[name] = supplied[declared.relation]
    arguments["output"] = output

    with contextlib.redirect_stdout(log):
        returned = registered["function"](**arguments)

    # A function that returns rows instead of writing them is a common and
    # easily corrected mistake, so it is accepted and reported rather than
    # failed - but only when nothing was written, so the two never disagree.
    if returned is not None and not output.written:
        output.write(returned)

    if not output.written:
        raise TransformError(
            f"{registered['function'].__name__}() never wrote to its Output. "
            f"Call output.write(rows) with a list of dicts, or return the rows from "
            f"the function. A transform that declares {output.relation} and writes "
            f"nothing to it produces no dataset."
        )

    rows = [{key: _encode(value) for key, value in row.items()} for row in output._rows or []]
    return {
        "ok": True,
        "output": output.relation,
        "rows": rows,
        "rowCount": len(rows),
        "log": log.getvalue(),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: runner.py declare|execute <file> [data]"}))
        return 2

    mode, path = argv[1], argv[2]
    try:
        if mode == "declare":
            result = _declare(path)
        elif mode == "execute":
            if len(argv) < 4:
                raise TransformError("execute needs the data file to read its inputs from.")
            result = _execute(path, argv[3])
        else:
            raise TransformError(f"'{mode}' is not a mode.")
    except TransformError as exc:
        # The transform's own fault, reported as a sentence rather than a stack.
        result = {"ok": False, "error": str(exc)}
    except SyntaxError as exc:
        result = {
            "ok": False,
            "error": f"Syntax error on line {exc.lineno}: {exc.msg}",
        }
    except Exception as exc:  # noqa: BLE001 - the user's code raised; report it whole
        # The traceback, trimmed to the frames inside the transform: the
        # runner's own frames are noise to whoever is reading the build log.
        frames = [
            line
            for line in traceback.format_exc().splitlines()
            if "runner.py" not in line
        ]
        result = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": "\n".join(frames[-12:]),
        }

    sys.stdout.write(json.dumps(result, default=str))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
