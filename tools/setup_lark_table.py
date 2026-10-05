#!/usr/bin/env python3
"""
One-time (and re-runnable) setup of the Lark Base table that stores briefs.

Creates every column the Project Brief Extractor page writes to, renames the
table's primary column to "Project Title", and — only with --prune — removes
leftover default columns and blank rows that a new Lark table starts with.

    python tools/setup_lark_table.py                  # dry run: show the plan
    python tools/setup_lark_table.py --apply          # create/rename columns
    python tools/setup_lark_table.py --apply --prune  # ...and remove empty defaults

The access token comes from the hosted Lark proxy's GET /token (the proxy holds
the app credentials). This script runs server-side, so it calls the Lark Open
API directly — no CORS proxy needed for the API calls themselves.

Standard library only. Keep FIELDS in sync with web/lark.js (FIELD names).
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_PROXY = "https://lark-proxy-dwiw.onrender.com"
LARK_API = "https://open.larksuite.com/open-apis"
APP_TOKEN = "NP7TbjwHNaTyLOsWafelN9wNgEd"
TABLE_ID = "tblG3XcLw2auB4lM"

TEXT, SELECT, MULTI_SELECT, DATE, ATTACHMENT, MODIFIED_TIME = 1, 3, 4, 5, 17, 1002
DATE_PROP = {"date_formatter": "yyyy/MM/dd", "auto_fill": False}


def options(*names):
    return {"options": [{"name": n, "color": i} for i, n in enumerate(names)]}


# (name, type, property). The first entry is the table's primary column.
FIELDS = [
    ("Project Title", TEXT, None),
    ("Client", TEXT, None),
    ("Date Filed", DATE, DATE_PROP),
    ("Due Date", DATE, DATE_PROP),
    ("Status", SELECT, options("New", "In Progress", "Submitted", "Won", "Lost", "Declined")),
    ("Event Date / Period", TEXT, None),
    ("Venue", TEXT, None),
    ("Objective", TEXT, None),
    ("Target Audience", TEXT, None),
    ("KPIs", TEXT, None),
    ("Scope of Work", TEXT, None),
    ("Estimated Budget", TEXT, None),
    ("Budget Type", SELECT, options("All-in", "Baseline / Ballpark", "To be confirmed", "Not specified")),
    ("Proposal Submission", SELECT, options("Paper pass only", "Pitch / Presentation", "Not specified")),
    ("Submission Details", TEXT, None),
    ("Notes", TEXT, None),
    ("Questions for Client", TEXT, None),
    ("Summary", TEXT, None),
    ("Filed By", TEXT, None),
    ("Source Files", TEXT, None),
    ("Brief JSON", TEXT, None),
    ("Next Steps", MULTI_SELECT, options("AM Assignment", "File Project Brief and trigger Lark GC",
                                         "PM Assignment", "Pitch Deck", "Other")),
    ("Attachments", ATTACHMENT, None),
    ("Requirement Type", SELECT, options("RFP (Request for Proposal)", "RFQ (Request for Quotation)",
                                         "RFI (Request for Information)")),
    ("VAT", MULTI_SELECT, options("VAT Inc.", "VAT Ex.")),
    ("Last Modified", MODIFIED_TIME, {"date_formatter": "yyyy/MM/dd HH:mm"}),
]


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


def get_token(proxy):
    data = call("GET", f"{proxy.rstrip('/')}/token", None)
    token = data.get("tenant_access_token") or data.get("app_access_token")
    if not token:
        raise LarkError("The proxy didn't return an access token.")
    return token


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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="make the changes (default is a dry run)")
    ap.add_argument("--prune", action="store_true", help="also delete empty non-brief columns and blank rows")
    ap.add_argument("--proxy", default=DEFAULT_PROXY, help="Lark proxy base URL used for GET /token")
    args = ap.parse_args()

    token = get_token(args.proxy)
    base = f"/bitable/v1/apps/{APP_TOKEN}/tables/{TABLE_ID}"
    fields = paged(f"{base}/fields", token)
    records = paged(f"{base}/records/search", token, "POST", {"automatic_fields": False})
    by_name = {f["field_name"]: f for f in fields}
    primary = next((f for f in fields if f.get("is_primary")), None)
    wanted = {name for name, _, _ in FIELDS}

    plan = []
    title = FIELDS[0][0]
    if primary and primary["field_name"] != title and title not in by_name:
        plan.append(("rename primary", primary["field_name"], title,
                     lambda: call("PUT", f"{base}/fields/{primary['field_id']}", token,
                                  {"field_name": title, "type": TEXT})))
        by_name[title] = dict(primary, field_name=title)
    for name, ftype, prop in FIELDS:
        existing = by_name.get(name)
        if existing is None:
            body = {"field_name": name, "type": ftype}
            if prop:
                body["property"] = prop
            plan.append(("create", name, ftype, lambda b=body: call("POST", f"{base}/fields", token, b)))
        elif existing["type"] != ftype:
            print(f"  ! column “{name}” exists with type {existing['type']} (expected {ftype}); left unchanged")

    if args.prune:
        for f in fields:
            if f["field_name"] in wanted or f.get("is_primary"):
                continue
            if all(is_blank((r.get("fields") or {}).get(f["field_name"])) for r in records):
                plan.append(("delete empty column", f["field_name"], "",
                             lambda fid=f["field_id"]: call("DELETE", f"{base}/fields/{fid}", token)))
            else:
                print(f"  ! column “{f['field_name']}” holds data; not deleting it")
        blank = [r["record_id"] for r in records if all(is_blank(v) for v in (r.get("fields") or {}).values())]
        if blank:
            plan.append(("delete blank rows", f"{len(blank)} row(s)", "",
                         lambda: call("POST", f"{base}/records/batch_delete", token, {"records": blank})))

    print(f"Table {TABLE_ID}: {len(fields)} column(s), {len(records)} row(s)")
    if not plan:
        print("Nothing to do — the table is already set up.")
        return
    for action, a, b, _ in plan:
        print(f"  - {action}: {a}{' -> ' + str(b) if b != '' else ''}")
    if not args.apply:
        print("\nDry run only. Re-run with --apply to make these changes.")
        return
    for action, a, _, run in plan:
        run()
        print(f"  ✓ {action}: {a}")
    print("Done.")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        main()
    except LarkError as e:
        sys.exit(f"Lark error: {e}")
