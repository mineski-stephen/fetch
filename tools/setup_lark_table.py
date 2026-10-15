#!/usr/bin/env python3
"""
Setup (and repair) of the Lark Base table that stores briefs. Owner/admin only.

Creates every column Fetch writes to, renames the table's primary column, adds
any select options the table lacks, and - only with --prune - removes leftover
default columns and blank rows that a new Lark table starts with.

    python tools/setup_lark_table.py                  # dry run: show the plan
    python tools/setup_lark_table.py --apply          # create/rename/top up columns
    python tools/setup_lark_table.py --apply --prune  # ...and remove empty defaults
    python tools/setup_lark_table.py --spec spec.json # read the column list from a file

The column list (and which table to set up) lives in js/schema.js and
js/config.js. This script gets it from `node tools/export-spec.mjs`, so it needs
Node 18 or newer on PATH. Nothing is duplicated here.

Credentials: LARK_APP_ID and LARK_APP_SECRET, from the environment or from
tools/.env (git-ignored; copy tools/.env.example). The app id is public. The
secret is the Lark app's "App Secret" in the developer console: keep it private
and never commit it. The script asks Lark directly for a tenant access token;
the secret and the token are never printed.

Standard library only.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

LARK_API = "https://open.larksuite.com/open-apis"
TOOLS_DIR = Path(__file__).resolve().parent
ENV_FILE = TOOLS_DIR / ".env"
CRED_KEYS = ("LARK_APP_ID", "LARK_APP_SECRET")

TEXT, SELECT, MULTI_SELECT, DATE, ATTACHMENT, MODIFIED_TIME = 1, 3, 4, 5, 17, 1002
DATE_PROP = {"date_formatter": "yyyy/MM/dd", "auto_fill": False}
MODIFIED_PROP = {"date_formatter": "yyyy/MM/dd HH:mm"}


class LarkError(Exception):
    pass


def call(method, path, token, body=None):
    url = path if path.startswith("http") else f"{LARK_API}{path}"
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read() or b"{}")
    if payload.get("code", 0) != 0:
        hint = ""
        if payload.get("code") in (1254302, 91403):
            hint = ("\n  -> The app can't access this table. In the Base, open Advanced Permissions and give "
                    "the app's role access to this table (\"Can manage\" for this setup, \"Can edit\" at runtime).")
        raise LarkError(f"{method} {path.split('?')[0]} -> {payload.get('code')} {payload.get('msg')}{hint}")
    return payload.get("data") or payload


def load_env_file(path):
    """Parse simple KEY=VALUE lines ('#' comments, optional quotes). Missing file -> {}."""
    values = {}
    try:
        lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def get_credentials(env_file=ENV_FILE, environ=None):
    """(app_id, app_secret); environment variables win over the .env file."""
    environ = os.environ if environ is None else environ
    file_values = load_env_file(env_file)
    creds = {k: (environ.get(k) or file_values.get(k) or "").strip() for k in CRED_KEYS}
    missing = [k for k in CRED_KEYS if not creds[k]]
    if missing:
        sys.exit(f"Missing {' and '.join(missing)}. Put them in tools/.env (copy tools/.env.example) "
                 "or the environment.")
    return creds["LARK_APP_ID"], creds["LARK_APP_SECRET"]


def get_token(app_id, app_secret):
    data = call("POST", f"{LARK_API}/auth/v3/tenant_access_token/internal", None,
                {"app_id": app_id, "app_secret": app_secret})
    token = data.get("tenant_access_token")
    if not token:
        raise LarkError("Lark didn't return an access token.")
    return token


def load_spec(spec_file=None):
    """The column list as JSON: from --spec FILE, or from `node tools/export-spec.mjs`."""
    if spec_file:
        try:
            return json.loads(Path(spec_file).read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as e:
            sys.exit(f"Can't read the spec file: {e}")
    node = shutil.which("node")
    if not node:
        sys.exit("This script reads the column list from js/schema.js, so it needs Node 18 or newer on PATH.")
    run = subprocess.run([node, str(TOOLS_DIR / "export-spec.mjs")], cwd=TOOLS_DIR.parent,
                         capture_output=True, timeout=60)
    if run.returncode != 0:
        err = run.stderr.decode("utf-8", "replace").strip()
        sys.exit(f"tools/export-spec.mjs failed: {err or 'exit code ' + str(run.returncode)}")
    try:
        return json.loads(run.stdout.decode("utf-8-sig"))
    except ValueError:
        sys.exit("tools/export-spec.mjs didn't print valid JSON.")


def column_property(col):
    """The Lark property for a new column, or None."""
    if col["type"] == DATE:
        return DATE_PROP
    if col["type"] == MODIFIED_TIME:
        return MODIFIED_PROP
    if col["type"] in (SELECT, MULTI_SELECT):
        return {"options": [{"name": n, "color": i} for i, n in enumerate(col.get("options") or [])]}
    return None


def paged(path, token, method="GET", body=None):
    items, page = [], ""
    while True:
        sep = "&" if "?" in path else "?"
        data = call(method, f"{path}{sep}page_size=100{'&page_token=' + page if page else ''}", token, body)
        items += data.get("items") or []
        if not data.get("has_more"):
            return items
        page = data.get("page_token", "")


def is_blank(value):
    return value in (None, "", [], {}) or (isinstance(value, list) and all(is_blank(v) for v in value))


def build_plan(spec, base, token, fields, records, prune=False):
    """List of (action, detail, extra, run). Prints warnings for things it leaves alone."""
    columns, title = spec["columns"], spec["primary"]
    by_name = {f["field_name"]: f for f in fields}
    primary = next((f for f in fields if f.get("is_primary")), None)
    wanted = {c["name"] for c in columns}
    plan = []

    if primary and primary["field_name"] != title and title not in by_name:
        plan.append(("rename primary", primary["field_name"], title,
                     lambda: call("PUT", f"{base}/fields/{primary['field_id']}", token,
                                  {"field_name": title, "type": TEXT})))
        by_name[title] = dict(primary, field_name=title)
    for col in columns:
        name, ftype = col["name"], col["type"]
        existing = by_name.get(name)
        if existing is None:
            body = {"field_name": name, "type": ftype}
            prop = column_property(col)
            if prop:
                body["property"] = prop
            plan.append(("create", name, ftype, lambda b=body: call("POST", f"{base}/fields", token, b)))
        elif existing["type"] != ftype:
            print(f"  ! column \"{name}\" exists with type {existing['type']} (expected {ftype}); left unchanged")
        elif ftype in (SELECT, MULTI_SELECT):
            have = (existing.get("property") or {}).get("options") or []
            known = {o["name"] for o in have}
            new = [n for n in (col.get("options") or []) if n not in known]
            if new and existing.get("field_id"):
                merged = list(have) + [{"name": n, "color": (len(have) + i) % 55} for i, n in enumerate(new)]
                body = {"field_name": name, "type": ftype, "property": {"options": merged}}
                plan.append(("add options", name, ", ".join(new),
                             lambda fid=existing["field_id"], b=body: call("PUT", f"{base}/fields/{fid}", token, b)))

    if prune:
        for f in fields:
            if f["field_name"] in wanted or f.get("is_primary"):
                continue
            if all(is_blank((r.get("fields") or {}).get(f["field_name"])) for r in records):
                plan.append(("delete empty column", f["field_name"], "",
                             lambda fid=f["field_id"]: call("DELETE", f"{base}/fields/{fid}", token)))
            else:
                print(f"  ! column \"{f['field_name']}\" holds data; not deleting it")
        blank = [r["record_id"] for r in records if all(is_blank(v) for v in (r.get("fields") or {}).values())]
        if blank:
            plan.append(("delete blank rows", f"{len(blank)} row(s)", "",
                         lambda: call("POST", f"{base}/records/batch_delete", token, {"records": blank})))
    return plan


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="make the changes (default is a dry run)")
    ap.add_argument("--prune", action="store_true", help="also delete empty non-brief columns and blank rows")
    ap.add_argument("--spec", metavar="FILE", help="read the column list JSON from FILE instead of running node")
    args = ap.parse_args()

    spec = load_spec(args.spec)
    app_token, table_id = spec["table"]["app"], spec["table"]["table"]
    token = get_token(*get_credentials())
    base = f"/bitable/v1/apps/{app_token}/tables/{table_id}"
    fields = paged(f"{base}/fields", token)
    records = paged(f"{base}/records/search", token, "POST", {"automatic_fields": False})
    plan = build_plan(spec, base, token, fields, records, args.prune)

    print(f"Table {table_id}: {len(fields)} column(s), {len(records)} row(s)")
    if not plan:
        print("Nothing to do - the table is already set up.")
        return
    for action, a, b, _ in plan:
        print(f"  - {action}: {a}{' -> ' + str(b) if b != '' else ''}")
    if not args.apply:
        print("\nDry run only. Re-run with --apply to make these changes.")
        return
    for action, a, _, run in plan:
        run()
        print(f"  OK {action}: {a}")
    print("Done.")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        main()
    except LarkError as e:
        sys.exit(f"Lark error: {e}")
