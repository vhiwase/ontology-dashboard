"""User administration.

Password hashes are scrypt in the portable form

    scrypt$<N>$<r>$<p>$<salt base64>$<derived key base64>

which hashlib here and crypto.scrypt in the ontology service both produce, so
neither service carries a hashing dependency and either can verify a hash the
other wrote.

    python -m pipeline.users seed                 create the bootstrap admin
    python -m pipeline.users add <name> <role>    add a user
    python -m pipeline.users passwd <name>        change a password
    python -m pipeline.users list                 list users
    python -m pipeline.users revoke <name>        invalidate issued tokens
    python -m pipeline.users disable <name>       deactivate and revoke
    python -m pipeline.users enable <name>        reactivate
    python -m pipeline.users delete <name>        remove outright
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import logging
import os
import secrets
import sys

from .db import connect

log = logging.getLogger("pipeline.users")

# Platform access tier: which API routes the user may reach.
ROLES = ("viewer", "analyst", "admin")

# Business hat, declared in the generated ontology, checked by AccessController
# to decide which actions the user may execute. Kept in step with ROLES in
# pipeline/actions.py.
ONTOLOGY_ROLES = (
    "tms:AdminRole",
    "tms:OperationsManagerRole",
    "tms:DispatcherRole",
    "tms:FinanceRole",
    "tms:AnalystRole",
)

# The business hat a platform tier gets when none is named. Analyst reads
# everything and mutates nothing, so defaulting never widens what a user can do.
DEFAULT_ONTOLOGY_ROLE = {
    "viewer": "tms:AnalystRole",
    "analyst": "tms:AnalystRole",
    "admin": "tms:AdminRole",
}

# OWASP's floor for interactive logins. n=16384 keeps a verify near 50 ms on
# this hardware: slow enough to matter offline, fast enough that a login does
# not feel stalled.
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_KEYLEN = 32
SCRYPT_MAXMEM = 64 * 1024 * 1024


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_KEYLEN,
        maxmem=SCRYPT_MAXMEM,
    )
    return "$".join(
        [
            "scrypt",
            str(SCRYPT_N),
            str(SCRYPT_R),
            str(SCRYPT_P),
            base64.b64encode(salt).decode(),
            base64.b64encode(derived).decode(),
        ]
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(hash_b64)
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
            maxmem=SCRYPT_MAXMEM,
        )
        return hmac.compare_digest(derived, expected)
    except (ValueError, TypeError):
        return False


def _require_password(supplied: str | None, env_var: str) -> str:
    """A password from the argument, else the environment. Never prompted.

    This runs inside a container with no TTY, so an interactive prompt would
    hang the compose run rather than ask anything.
    """
    password = supplied or os.environ.get(env_var)
    if not password:
        raise RuntimeError(
            f"No password supplied. Pass one as an argument or set {env_var}."
        )
    if len(password) < 12:
        raise RuntimeError("Password must be at least 12 characters.")
    return password


def add_user(
    username: str,
    role: str,
    password: str,
    display_name: str | None = None,
    ontology_role: str | None = None,
) -> bool:
    if role not in ROLES:
        raise RuntimeError(f"Role must be one of {', '.join(ROLES)}.")
    hat = ontology_role or DEFAULT_ONTOLOGY_ROLE[role]
    if hat not in ONTOLOGY_ROLES:
        raise RuntimeError(
            f"Ontology role must be one of {', '.join(ONTOLOGY_ROLES)}."
        )
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO platform.app_user
                       (username, display_name, password_hash, role, ontology_role)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (username) DO NOTHING
                   RETURNING app_user_id""",
                (
                    username,
                    display_name or username,
                    hash_password(password),
                    role,
                    hat,
                ),
            )
            created = cur.fetchone()
        conn.commit()
    if created:
        log.info("Created user %r (platform=%r, ontology=%r).", username, role, hat)
    else:
        log.info("User %r already exists - left untouched.", username)
    return bool(created)


def set_password(username: str, password: str) -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE platform.app_user
                      SET password_hash = %s, token_version = token_version + 1
                    WHERE username = %s
                RETURNING app_user_id""",
                (hash_password(password), username),
            )
            if not cur.fetchone():
                raise RuntimeError(f"No such user: {username}")
        conn.commit()
    log.info("Password changed for %r; existing tokens are now invalid.", username)


def revoke(username: str) -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE platform.app_user
                      SET token_version = token_version + 1
                    WHERE username = %s
                RETURNING token_version""",
                (username,),
            )
            row = cur.fetchone()
            if not row:
                raise RuntimeError(f"No such user: {username}")
        conn.commit()
    log.info(
        "Revoked tokens for %r (token_version now %d).", username, row["token_version"]
    )


def set_active(username: str, active: bool) -> None:
    """Disable or re-enable an account.

    Disabling is the usual answer for someone who has left: it keeps their
    audit rows and chat history attributable, where deleting the row would
    leave those referencing a name nothing explains. It also revokes their
    tokens, so access stops now rather than at expiry.
    """
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE platform.app_user
                      SET is_active = %s, token_version = token_version + 1
                    WHERE username = %s
                RETURNING app_user_id""",
                (active, username),
            )
            if not cur.fetchone():
                raise RuntimeError(f"No such user: {username}")
        conn.commit()
    log.info("User %r is now %s.", username, "active" if active else "disabled")


def delete_user(username: str) -> None:
    """Remove an account outright.

    Prefer `disable`. This exists for accounts that should never have been
    created - a test user, a typo - where there is no history worth keeping.
    Audit and chat rows reference the username as text, not by foreign key, so
    they survive this and would be left naming a user that no longer exists.
    """
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM platform.app_user WHERE username = %s RETURNING app_user_id",
                (username,),
            )
            if not cur.fetchone():
                raise RuntimeError(f"No such user: {username}")
        conn.commit()
    log.info("Deleted user %r.", username)


def list_users() -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT username, role, ontology_role, is_active, last_login_at
                     FROM platform.app_user ORDER BY username"""
            )
            rows = cur.fetchall()
    if not rows:
        print("(no users - run: python -m pipeline.users seed)")
        return
    print(
        "{:<18} {:<9} {:<26} {:<7} {}".format(
            "username", "role", "ontology role", "active", "last login"
        )
    )
    for row in rows:
        last = (
            row["last_login_at"].isoformat(timespec="seconds")
            if row["last_login_at"]
            else "never"
        )
        print(
            "{:<18} {:<9} {:<26} {:<7} {}".format(
                row["username"],
                row["role"],
                row["ontology_role"],
                str(row["is_active"]),
                last,
            )
        )


def seed() -> None:
    """Create the bootstrap admin if the user table is empty.

    Idempotent, so compose can run it on every pass. It refuses to invent a
    password: without BOOTSTRAP_ADMIN_PASSWORD the stack comes up with no users
    and every route answers 401, which is a visible failure rather than a
    silent default credential.
    """
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM platform.app_user")
            if cur.fetchone()["n"] > 0:
                log.info("Users already exist - seeding skipped.")
                return

    username = os.environ.get("BOOTSTRAP_ADMIN_USERNAME", "admin")
    password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not password:
        log.warning(
            "No users exist and BOOTSTRAP_ADMIN_PASSWORD is unset, so none were "
            "created. Every API route will answer 401 until you run: "
            "docker compose run --rm pipeline "
            "python -m pipeline.users add <name> admin <password>"
        )
        return
    add_user(username, "admin", password, display_name="Bootstrap admin")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Manage application users.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("seed", help="Create the bootstrap admin if no users exist.")
    sub.add_parser("list", help="List users.")

    p_add = sub.add_parser("add", help="Add a user.")
    p_add.add_argument("username")
    p_add.add_argument("role", choices=ROLES)
    p_add.add_argument("password", nargs="?")
    p_add.add_argument(
        "--ontology-role",
        choices=ONTOLOGY_ROLES,
        help="Business hat; defaults by platform tier.",
    )

    p_pw = sub.add_parser("passwd", help="Change a password.")
    p_pw.add_argument("username")
    p_pw.add_argument("password", nargs="?")

    p_rv = sub.add_parser("revoke", help="Invalidate the tokens issued to a user.")
    p_rv.add_argument("username")

    p_dis = sub.add_parser("disable", help="Deactivate an account and revoke its tokens.")
    p_dis.add_argument("username")

    p_en = sub.add_parser("enable", help="Reactivate a disabled account.")
    p_en.add_argument("username")

    p_del = sub.add_parser("delete", help="Remove an account outright (prefer disable).")
    p_del.add_argument("username")

    args = parser.parse_args(argv)
    try:
        if args.command == "seed":
            seed()
        elif args.command == "list":
            list_users()
        elif args.command == "add":
            add_user(
                args.username,
                args.role,
                _require_password(args.password, "NEW_USER_PASSWORD"),
                ontology_role=args.ontology_role,
            )
        elif args.command == "passwd":
            set_password(
                args.username, _require_password(args.password, "NEW_USER_PASSWORD")
            )
        elif args.command == "revoke":
            revoke(args.username)
        elif args.command == "disable":
            set_active(args.username, False)
        elif args.command == "enable":
            set_active(args.username, True)
        elif args.command == "delete":
            delete_user(args.username)
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI top level
        log.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
