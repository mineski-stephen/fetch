#!/usr/bin/env python3
"""
Gemini brief-extraction proxy for the Project Brief Extractor — Render ready.

Why this exists
---------------
The static page can't hold the Gemini API key: anything shipped to a browser
is public. This service keeps the key server-side and exposes ONE narrow
operation — "turn these brief files into a Project Brief Summary" — instead of
a general Gemini relay. The prompt and output schema live here too, so a
caller can't repurpose the key for arbitrary prompts.

    browser ──multipart POST /extract──▶ this proxy ──generateContent──▶ Gemini
            ◀────── {brief, meta} JSON ─────────────────────────────────◀

Endpoints
---------
    GET  /          service info (model, limits)
    GET  /health    {"status":"ok"} — also used by the page to wake the service
    POST /extract   multipart/form-data:
                      files  0..n files (PDF, images, Office, text, e-mail, audio…)
                      text   optional typed / pasted brief text
                      today  optional YYYY-MM-DD in the user's time zone
                    optional header X-Gemini-Api-Key: the user's own key, used
                    instead of GEMINI_API_KEY for this request only
                    -> {"brief": {...}, "meta": {...}}
    OPTIONS *       CORS preflight

Configuration (environment variables)
-------------------------------------
    GEMINI_API_KEY         shared key (optional if every user brings their own)
    GEMINI_MODEL           primary model, or "auto" = newest Flash-Lite (default auto)
    GEMINI_FALLBACK_MODELS "auto" or comma list         (default auto)
    MAX_FALLBACKS          fallback models to try       (default 3)
    ALLOWED_ORIGINS        comma list or "*"            (default *)
    MAX_UPLOAD_MB          total upload cap             (default 50)
    MAX_FILES              files per request            (default 10)
    INLINE_BUDGET_MB       above this, use Files API    (default 14)
    RATE_LIMIT_PER_HOUR    extractions per client IP    (default 60)
    MAX_CONCURRENT         simultaneous extractions     (default 4)
    REQUEST_TIMEOUT        seconds per extraction       (default 280)
    TZ_OFFSET_HOURS        server "today" offset        (default 8, PH/SG)
    PORT                   bind port (Render sets this)

Standard library only — no pip install.
"""
import collections
import datetime as dt
import json
import os
import re
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

import brief_spec
import extractors
from gemini_client import Client, GeminiError, file_part, inline_part

VERSION = "1.2.0"


def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Where the shared key may live. Env var names are matched case-insensitively;
# Render "Secret Files" are mounted under /etc/secrets/.
KEY_ENV_NAMES = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_KEY", "GOOGLE_GENAI_API_KEY", "API_KEY")
KEY_FILES = ("/etc/secrets/GEMINI_API_KEY", "/etc/secrets/gemini_api_key", "/etc/secrets/GOOGLE_API_KEY")


def _clean_key(value):
    return (value or "").strip().strip("\"'").strip()


def load_shared_key(environ=None, files=KEY_FILES):
    """Find the shared Gemini key. Returns (key, source); source never contains the key."""
    environ = os.environ if environ is None else environ
    by_upper = {name.upper(): name for name in environ}
    for wanted in KEY_ENV_NAMES:
        name = by_upper.get(wanted)
        if name and _clean_key(environ[name]):
            return _clean_key(environ[name]), f"environment variable {name}"
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                key = _clean_key(f.read())
        except OSError:
            continue
        if key:
            return key, f"secret file {path}"
    return "", ""


API_KEY, KEY_SOURCE = load_shared_key()
MODEL = os.environ.get("GEMINI_MODEL", "auto").strip() or "auto"
FALLBACK_MODELS = os.environ.get("GEMINI_FALLBACK_MODELS", "auto")
MAX_FALLBACKS = _env_int("MAX_FALLBACKS", 3)
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()}
MAX_UPLOAD_BYTES = _env_int("MAX_UPLOAD_MB", 50) * 1024 * 1024
MAX_FILES = _env_int("MAX_FILES", 10)
MAX_TEXT_CHARS = 200_000
INLINE_BUDGET = _env_int("INLINE_BUDGET_MB", 14) * 1024 * 1024
RATE_LIMIT_PER_HOUR = _env_int("RATE_LIMIT_PER_HOUR", 60)
MAX_CONCURRENT = _env_int("MAX_CONCURRENT", 4)
REQUEST_TIMEOUT = _env_int("REQUEST_TIMEOUT", 280)
TZ = dt.timezone(dt.timedelta(hours=float(os.environ.get("TZ_OFFSET_HOURS", "8"))))

USER_KEY_HEADER = "X-Gemini-Api-Key"
_KEY_SHAPE = re.compile(r"^[A-Za-z0-9_\-.]{20,200}$")


def make_client(api_key):
    """A Gemini client for one request (caches are shared across clients)."""
    return Client(api_key, MODEL, FALLBACK_MODELS, MAX_FALLBACKS, timeout=240)


_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def log(msg):
    print(f"[{dt.datetime.now(TZ):%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


class ApiError(Exception):
    def __init__(self, status, code, message, headers=None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


# ---- rate limiting ------------------------------------------------------------

class RateLimiter:
    def __init__(self, per_hour):
        self.per_hour, self.hits, self.lock = per_hour, collections.defaultdict(collections.deque), threading.Lock()

    def check(self, key):
        """Record a hit; return seconds to wait if over the limit, else 0."""
        if self.per_hour <= 0:
            return 0
        now = time.time()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > 3600:
                q.popleft()
            if len(q) >= self.per_hour:
                return int(3600 - (now - q[0])) + 1
            q.append(now)
            if len(self.hits) > 5000:  # forget idle clients
                for k in [k for k, v in self.hits.items() if not v]:
                    del self.hits[k]
            return 0


limiter = RateLimiter(RATE_LIMIT_PER_HOUR)


# ---- multipart parsing ----------------------------------------------------------

class Upload:
    def __init__(self, name, filename, ctype, data):
        self.name, self.filename, self.ctype, self.data = name, filename, ctype, data


def _header_params(value):
    """Parse 'form-data; name="x"; filename="y"' into a dict (RFC 7578 style)."""
    params = {}
    for m in re.finditer(r';\s*([\w*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)', value):
        key, val = m.group(1).lower(), m.group(2).strip()
        if val.startswith('"'):
            val = val[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        if key.endswith("*"):  # filename*=UTF-8''name%20here
            key = key[:-1]
            val = unquote(val.split("''", 1)[-1])
        params[key] = val
    return params


def parse_multipart(content_type, body):
    """Split a multipart/form-data body into ({field: str}, [Upload])."""
    m = re.search(r'boundary=("?)([^";]+)\1', content_type)
    if not m:
        raise ApiError(400, "bad_request", "Missing multipart boundary.")
    delim = b"--" + m.group(2).encode("latin-1")
    fields, files = {}, []
    for chunk in body.split(delim)[1:]:
        if chunk.startswith(b"--"):
            break
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        head, sep, data = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        if data.endswith(b"\r\n"):
            data = data[:-2]
        headers = {}
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        disp = _header_params(headers.get("content-disposition", ""))
        name = disp.get("name", "")
        if "filename" in disp:
            ctype = headers.get("content-type", "application/octet-stream").split(";")[0].strip().lower()
            files.append(Upload(name, os.path.basename(disp["filename"].replace("\\", "/")) or "upload", ctype, data))
        else:
            fields[name] = data.decode("utf-8", "replace")
    return fields, files


# ---- the extraction pipeline ------------------------------------------------------

def resolve_today(raw):
    """Use the caller's local date if it is plausible, else the server's."""
    server_today = dt.datetime.now(TZ).date()
    try:
        d = dt.date.fromisoformat((raw or "").strip()[:10])
        if abs((d - server_today).days) <= 1:
            return d
    except ValueError:
        pass
    return server_today


def run_extraction(uploads, typed_text, today, client):
    started = time.time()
    deadline = started + REQUEST_TIMEOUT

    sources = []
    for up in uploads:
        try:
            sources.append(extractors.process(up.filename, up.data, up.ctype))
        except extractors.UnsupportedFile as e:
            raise ApiError(422, "unsupported_file", str(e))

    # Assemble the user turn: a labelled header before each source's parts.
    parts, blobs = [], []
    for i, src in enumerate(sources, 1):
        parts.append({"text": f"=== SOURCE {i}: “{src.name}” ({src.label}) ==="})
        for p in src.parts:
            if p[0] == "text":
                parts.append({"text": p[1]})
            else:
                ref = {"mime": p[1], "data": p[2], "name": src.name}
                parts.append(ref)
                blobs.append(ref)
    if typed_text:
        parts.append({"text": f"=== SOURCE {len(sources) + 1}: text typed or pasted by the user ===\n{typed_text}"})
    parts.append({"text": "=== END OF SOURCES ===\nWrite the Project Brief Summary for the sources above."})

    # Inline small binaries; push the largest through the Files API until the
    # inline payload fits Gemini's request-size limit. Video always uploads.
    uploaded, handling = [], {}
    inline_total = sum(len(b["data"]) for b in blobs)
    try:
        for ref in sorted(blobs, key=lambda b: len(b["data"]), reverse=True):
            if ref["mime"].startswith("video/") or inline_total > INLINE_BUDGET:
                name, uri = client.upload(ref["data"], ref["mime"], ref["name"])
                uploaded.append(name)
                inline_total -= len(ref["data"])
                ref["part"] = file_part(ref["mime"], uri)
                handling[ref["name"]] = "files-api"
            else:
                ref["part"] = inline_part(ref["mime"], ref["data"])
        contents = [p["part"] if "mime" in p else p for p in parts]

        body = {
            "systemInstruction": {"parts": [{"text": brief_spec.system_prompt(today)}]},
            "contents": [{"role": "user", "parts": contents}],
            "generationConfig": {"responseMimeType": "application/json",
                                 "responseSchema": brief_spec.RESPONSE_SCHEMA},
        }
        brief, info = client.generate_with_fallback(
            body, lambda text: brief_spec.normalize(brief_spec.parse_model_json(text), today),
            deadline, log=log)
    finally:
        client.delete_later(uploaded)

    usage = info.get("usage") or {}
    meta = {
        "model": info["model"],
        "model_version": info["model_version"],
        "duration_ms": int((time.time() - started) * 1000),
        "sources": [dict(s.describe(), handling=handling.get(s.name, "inline" if any(
            p[0] == "blob" for p in s.parts) else "text")) for s in sources],
        "typed_text_chars": len(typed_text),
        "usage": {"input_tokens": usage.get("promptTokenCount"),
                  "output_tokens": usage.get("candidatesTokenCount"),
                  "thinking_tokens": usage.get("thoughtsTokenCount")},
    }
    return {"brief": brief, "meta": meta}


# ---- HTTP -------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"GeminiBriefProxy/{VERSION}"
    timeout = 120  # per socket read; drops stalled clients

    # -- helpers
    def _cors(self):
        origin = self.headers.get("Origin")
        if "*" in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", f"Content-Type, {USER_KEY_HEADER}")
        self.send_header("Access-Control-Expose-Headers", "Retry-After")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, status, obj, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, err):
        # The request body may be unread, so don't reuse this connection.
        self.close_connection = True
        self._send_json(err.status, {"error": {"code": err.code, "message": err.message}},
                        dict(err.headers, Connection="close"))

    def _client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[0].strip() or self.client_address[0]

    def _read_body(self):
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            chunks, total = [], 0
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return b"".join(chunks)
                total += size
                if total > MAX_UPLOAD_BYTES + 1024 * 1024:
                    raise ApiError(413, "too_large", self._too_large_msg())
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise ApiError(411, "bad_request", "Content-Length is required.")
        if length > MAX_UPLOAD_BYTES + 1024 * 1024:  # allow for multipart overhead
            raise ApiError(413, "too_large", self._too_large_msg())
        return self.rfile.read(length)

    @staticmethod
    def _too_large_msg():
        return f"That's more than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB in total. Remove a file or compress it, then try again."

    # -- routes
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json(200, {"status": "ok", "configured": bool(API_KEY), "accepts_user_key": True})
        elif path == "/":
            self._send_json(200, {
                "service": "gemini-brief-proxy", "version": VERSION, "model": MODEL,
                "model_family": "gemini-flash-lite", "configured": bool(API_KEY),
                "shared_key": {"configured": bool(API_KEY), "source": KEY_SOURCE or None,
                               "hint": None if API_KEY else
                               "Add GEMINI_API_KEY under Environment in the Render dashboard, then redeploy."},
                "endpoints": ["GET /health", "POST /extract"],
                "limits": {"max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024), "max_files": MAX_FILES,
                           "rate_limit_per_hour": RATE_LIMIT_PER_HOUR},
                "schema_version": brief_spec.SCHEMA_VERSION,
            })
        else:
            self._send_json(404, {"error": {"code": "not_found", "message": "Not found."}})

    def do_POST(self):
        started = time.time()
        if urlparse(self.path).path != "/extract":
            return self._send_json(404, {"error": {"code": "not_found", "message": "Use POST /extract."}})
        try:
            result = self._extract()
        except ApiError as e:
            log(f"extract {e.status} {e.code} ms={int((time.time() - started) * 1000)}")
            return self._error(e)
        except Exception as e:  # never leak a traceback to the client
            log(f"extract 500 internal {type(e).__name__}: {e}")
            return self._error(ApiError(500, "internal", "Something went wrong on the server. Please try again."))
        m = result["meta"]
        log(f"extract 200 files={len(m['sources'])} model={m['model']} ms={m['duration_ms']}")
        self._send_json(200, result)

    def _extract(self):
        origin = self.headers.get("Origin")
        if origin and "*" not in ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
            raise ApiError(403, "forbidden_origin", "This page isn't allowed to use the extraction service.")
        user_key = (self.headers.get(USER_KEY_HEADER) or "").strip()
        if user_key and not _KEY_SHAPE.match(user_key):
            raise ApiError(400, "invalid_api_key", "That doesn't look like a Gemini API key. Check it in Settings.")
        if not (user_key or API_KEY):
            raise ApiError(503, "not_configured", "No Gemini API key is set up yet. Add your own key in Settings.")
        ctype = self.headers.get("Content-Type", "")
        if not ctype.lower().startswith("multipart/form-data"):
            raise ApiError(415, "bad_request", "Send the brief as multipart/form-data.")

        body = self._read_body()  # read before rate-limiting so keep-alive stays in sync
        wait = limiter.check(self._client_ip())
        if wait:
            raise ApiError(429, "rate_limited", "Too many briefs from this network in the last hour. Please wait a bit.",
                           {"Retry-After": str(wait)})

        fields, uploads = parse_multipart(ctype, body)
        del body
        uploads = [u for u in uploads if u.data]
        typed = (fields.get("text") or "").strip()[:MAX_TEXT_CHARS]
        if not uploads and not typed:
            raise ApiError(400, "no_input", "Add a file or type the brief first.")
        if len(uploads) > MAX_FILES:
            raise ApiError(400, "too_many_files", f"Please upload at most {MAX_FILES} files at once.")

        if not _slots.acquire(timeout=60):
            raise ApiError(503, "busy", "The service is busy with other briefs. Please try again in a minute.",
                           {"Retry-After": "30"})
        try:
            client = make_client(user_key or API_KEY)
            return run_extraction(uploads, typed, resolve_today(fields.get("today")), client)
        except GeminiError as e:
            raise self._map_gemini_error(e, bool(user_key))
        finally:
            _slots.release()

    @staticmethod
    def _map_gemini_error(e, user_key=False):
        log(f"gemini error kind={e.kind} status={e.status} user_key={user_key}: {str(e)[:300]}")
        if e.kind == "content":
            return ApiError(422, "content_rejected", str(e))
        if e.kind == "config" and user_key:
            return ApiError(401, "invalid_api_key", "Google rejected your Gemini API key. Check it in Settings.")
        if e.kind == "config":
            return ApiError(503, "not_configured",
                            "The service's shared Gemini key was rejected. Add your own key in Settings, or ask the admin to check it.")
        if e.kind == "quota":
            who = "Your Gemini key" if user_key else "The shared Gemini key"
            return ApiError(429, "quota_exceeded",
                            f"{who} has reached its usage limit for now (free keys have per-minute and per-day limits). "
                            "Try again later, or use a different key in Settings.", {"Retry-After": "60"})
        if e.kind in ("retryable", "model"):
            return ApiError(503, "upstream_unavailable",
                            "Gemini is overloaded right now. Please try again in a minute.", {"Retry-After": "30"})
        return ApiError(502, "upstream_error", "Gemini couldn't process this brief. Please try again.")

    def log_request(self, code="-", size="-"):
        # One concise line per request; never bodies, file names or headers.
        if urlparse(self.path).path != "/extract":
            self.log_message('"%s %s" %s', self.command, urlparse(self.path).path, str(code))


def main():
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else "8000"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True

    def _on_sigterm(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _on_sigterm)

    log(f"Gemini brief proxy {VERSION} listening on http://0.0.0.0:{port}")
    log(f"  model={MODEL}  origins={','.join(sorted(ALLOWED_ORIGINS))}")
    if API_KEY:
        log(f"  shared Gemini key: found in {KEY_SOURCE} ({len(API_KEY)} characters)")
    else:
        # Names only (never values), to spot a typo like GEMINI_APIKEY.
        similar = sorted(k for k in os.environ if re.search(r"KEY|GEMINI|GOOGLE|SECRET|TOKEN", k, re.I))
        log("  shared Gemini key: NOT FOUND - users must add their own in Settings. "
            "To set one, add GEMINI_API_KEY under Environment in Render and redeploy.")
        log(f"  similar variable names present: {', '.join(similar) or 'none'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down…")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
