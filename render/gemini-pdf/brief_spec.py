"""
The Project Brief contract: prompt, Gemini response schema, and normalisation.

Everything that defines *what* gets extracted lives here (plus ``prompt.md``),
so the HTTP server and the Gemini client stay generic. The static page and the
Lark table both depend on the shape produced by ``normalize()`` — bump
``SCHEMA_VERSION`` if you change it incompatibly.
"""
import datetime as _dt
import json
import os
import re

SCHEMA_VERSION = 1
NOT_SPECIFIED = "Not specified"

BUDGET_TYPES = ("ALL-IN", "BASELINE / BALLPARK", "TO BE CONFIRMED", "NOT SPECIFIED")
SUBMISSION_TYPES = ("PAPER PASS ONLY", "PITCH / PRESENTATION", "NOT SPECIFIED")

# Caps keep a runaway response from producing an unreadable document.
MAX_LIST_ITEMS = 20
MAX_CLARIFICATIONS = 8
MAX_FIELD_CHARS = 2000

_PROMPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompt.md")


def system_prompt(today):
    """Return the system instruction with today's date filled in."""
    with open(_PROMPT_PATH, encoding="utf-8") as f:
        text = f.read()
    return (text.replace("{{TODAY}}", today.strftime("%d %b %Y").lstrip("0"))
                .replace("{{WEEKDAY}}", today.strftime("%A")))


# ---- Gemini response schema (OpenAPI subset used by responseSchema) ---------

def _s(desc):
    return {"type": "STRING", "description": desc}


def _list(desc):
    return {"type": "ARRAY", "items": {"type": "STRING"}, "description": desc}


def _obj(props, desc=None):
    out = {"type": "OBJECT", "properties": props,
           "required": list(props), "propertyOrdering": list(props)}
    if desc:
        out["description"] = desc
    return out


def _enum(values, desc):
    return {"type": "STRING", "format": "enum", "enum": list(values), "description": desc}


RESPONSE_SCHEMA = _obj({
    "client_name": _s("Company/brand that gave the brief; 'Brand (via Agency)' if relayed."),
    "project_title": _s("Official project name, or a 3-7 word descriptive placeholder."),
    "project_title_is_placeholder": {"type": "BOOLEAN",
                                     "description": "True if project_title was created, not given."},
    "event_period": _s("When and how long the project runs, one line."),
    "key_dates": {"type": "ARRAY", "description": "Milestones in chronological order.",
                  "items": _obj({"date": _s("Date or range, 'D Mon YYYY'."),
                                 "label": _s("What happens on that date.")})},
    "venue": _s("Venue and city, or online platform(s)."),
    "due_date": _obj({
        "date": _s("Proposal due date as YYYY-MM-DD, or empty string if unknown."),
        "note": _s("Time, time zone, channel, or how the date was computed."),
    }, "When our proposal/response is due to the client."),
    "objectives": _list("What the project aims to achieve."),
    "target_audience": _list("Who the project is for."),
    "kpis": _list("Measurable indicators we must deliver or report, with targets."),
    "scope_of_work": {"type": "ARRAY", "description": "Agency responsibilities, most important first.",
                      "items": _obj({"item": _s("2-5 word label."),
                                     "detail": _s("One-sentence specifics.")})},
    "budget": _obj({
        "amount": _s("Amount as written with currency, inclusions/exclusions."),
        "type": _enum(BUDGET_TYPES, "How firm the budget is."),
    }),
    "proposal_submission": _obj({
        "type": _enum(SUBMISSION_TYPES, "Paper pass only, or pitch/presentation."),
        "details": _s("Format, required sections, pitch date, channel."),
    }),
    "notes": _list("Every other relevant information."),
    "clarifications": _list("Questions to ask the client, most important first."),
    "summary": _s("1-2 sentence TL;DR for a group chat, max 45 words."),
    "extraction_warnings": _list("Problems with the sources themselves."),
})


# ---- Normalisation ----------------------------------------------------------

def parse_model_json(text):
    """Parse the model's JSON, tolerating code fences or stray prose."""
    text = (text or "").strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise


def _clean(value, fallback=NOT_SPECIFIED):
    if value is None:
        return fallback
    if not isinstance(value, str):
        value = str(value)
    value = re.sub(r"[ \t]+", " ", value.replace("\r", "")).strip()
    if len(value) > MAX_FIELD_CHARS:
        value = value[:MAX_FIELD_CHARS - 1].rstrip() + "…"
    if not value or value.lower() in ("n/a", "na", "none", "null", "not specified", "unknown", "-"):
        return fallback
    return value


def _clean_list(values, limit=MAX_LIST_ITEMS):
    if isinstance(values, str):
        values = [values]
    out, seen = [], set()
    for v in values if isinstance(values, list) else []:
        v = _clean(v, "")
        v = re.sub(r"^[\-•*●▪]\s*", "", v)  # leading bullet glyphs
        key = v.lower()
        if v and key != NOT_SPECIFIED.lower() and key not in seen:
            seen.add(key)
            out.append(v)
    return out[:limit]


def _clean_pairs(values, a, b, limit=MAX_LIST_ITEMS):
    out = []
    for v in values if isinstance(values, list) else []:
        if not isinstance(v, dict):
            v = {a: "", b: str(v)}
        x, y = _clean(v.get(a), ""), _clean(v.get(b), "")
        if x or y:
            out.append({a: x, b: y})
    return out[:limit]


def _enum_value(raw, allowed, aliases):
    raw = (raw or "").upper()
    if raw in allowed:
        return raw
    for needle, value in aliases:
        if needle in raw:
            return value
    return allowed[-1]  # NOT SPECIFIED


def _iso_date(raw):
    raw = (raw or "").strip()
    try:
        return _dt.date.fromisoformat(raw[:10]).isoformat() if raw else ""
    except ValueError:
        return ""


def normalize(raw, today):
    """Coerce whatever the model returned into the fixed v1 brief shape."""
    raw = raw if isinstance(raw, dict) else {}
    budget = raw.get("budget") if isinstance(raw.get("budget"), dict) else {}
    sub = raw.get("proposal_submission") if isinstance(raw.get("proposal_submission"), dict) else {}
    due = raw.get("due_date") if isinstance(raw.get("due_date"), dict) else {}

    amount = _clean(budget.get("amount"))
    btype = _enum_value(budget.get("type"), BUDGET_TYPES, (
        ("ALL", "ALL-IN"), ("BASE", "BASELINE / BALLPARK"), ("BALL", "BASELINE / BALLPARK"),
        ("ESTIM", "BASELINE / BALLPARK"), ("CONFIRM", "TO BE CONFIRMED"), ("UNCLEAR", "TO BE CONFIRMED"),
    ))
    if amount == NOT_SPECIFIED:
        btype = "NOT SPECIFIED"
    elif btype == "NOT SPECIFIED":
        btype = "TO BE CONFIRMED"

    title = _clean(raw.get("project_title"), "")
    client = _clean(raw.get("client_name"))
    placeholder = bool(raw.get("project_title_is_placeholder")) or not title
    if not title:
        title = f"{client} Project" if client != NOT_SPECIFIED else "Untitled Project"

    due_date = _iso_date(due.get("date"))
    due_note = _clean(due.get("note"), "" if due_date else NOT_SPECIFIED)

    return {
        "schema_version": SCHEMA_VERSION,
        "date_filed": today.isoformat(),
        "due_date": {"date": due_date, "note": due_note},
        "client_name": client,
        "project_title": title,
        "project_title_is_placeholder": placeholder,
        "event_period": _clean(raw.get("event_period")),
        "key_dates": _clean_pairs(raw.get("key_dates"), "date", "label"),
        "venue": _clean(raw.get("venue")),
        "objectives": _clean_list(raw.get("objectives")),
        "target_audience": _clean_list(raw.get("target_audience")),
        "kpis": _clean_list(raw.get("kpis")),
        "scope_of_work": _clean_pairs(raw.get("scope_of_work"), "item", "detail"),
        "budget": {"amount": amount, "type": btype},
        "proposal_submission": {
            "type": _enum_value(sub.get("type"), SUBMISSION_TYPES, (
                ("PAPER", "PAPER PASS ONLY"), ("PITCH", "PITCH / PRESENTATION"),
                ("PRESENT", "PITCH / PRESENTATION"),
            )),
            "details": _clean(sub.get("details")),
        },
        "notes": _clean_list(raw.get("notes")),
        "clarifications": _clean_list(raw.get("clarifications"), MAX_CLARIFICATIONS),
        "summary": _clean(raw.get("summary"), ""),
        "extraction_warnings": _clean_list(raw.get("extraction_warnings"), 10),
    }
