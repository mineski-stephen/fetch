"""
Minimal Gemini REST client: generateContent with retries and model fallback,
plus the Files API for uploads too large to send inline.

Standard library only. A Client is cheap to create — one per request — so a
request can use either the service's key or a key the user brought. The model
list and the overload cooldowns are shared module-level caches. Keys are sent
only as the ``x-goog-api-key`` header and never logged.

Model policy: Flash-Lite only. With ``primary_model="auto"`` the newest
``gemini-X.Y-flash-lite`` model available to the key is used, followed by the
older ones as fallbacks.
"""
import base64
import hashlib
import json
import re
import socket
import threading
import time
import urllib.error
import urllib.request

API = "https://generativelanguage.googleapis.com/v1beta"
UPLOAD_API = "https://generativelanguage.googleapis.com/upload/v1beta/files"

RETRY_DELAYS = (2.0,)              # backoff between attempts on the same model
COOLDOWN_SECONDS = 120             # an overloaded model is tried last for this long
MODEL_CACHE_SECONDS = 3600
FILE_POLL_SECONDS = 120            # how long to wait for an uploaded video to process
FALLBACK_ALIAS = "gemini-flash-lite-latest"   # used if model discovery fails
MODEL_PATTERN = re.compile(r"^gemini-(\d+(?:\.\d+)?)-flash-lite$")

_lock = threading.Lock()
_model_cache = {}   # sha256(key)[:16] -> (models, fetched_at)
_cooldown = {}      # model -> time until which it is tried last


class GeminiError(Exception):
    """An upstream failure, tagged with how the caller should react.

    kind:
      retryable  transient (overload, rate limit, network) — retry, then fall back
      model      this model can't serve the request — try the next model
      quota      the key has run out of quota on every model tried
      content    the input itself was refused or is too large — tell the user
      config     bad/missing API key or permissions — fix the key
      fatal      anything else
    """

    def __init__(self, message, kind="fatal", status=None):
        super().__init__(message)
        self.kind, self.status = kind, status


def _is_quota(status, message):
    low = message.lower()
    return status == 429 and ("quota" in low or "billing" in low or "exhausted" in low)


class Client:
    def __init__(self, api_key, primary_model="auto", fallback_models="auto", max_fallbacks=3, timeout=240):
        self.api_key = api_key
        self.primary = (primary_model or "auto").strip()
        self.fallback_setting = (fallback_models or "auto").strip()
        self.max_fallbacks = max_fallbacks
        self.timeout = timeout
        self._key_id = hashlib.sha256((api_key or "").encode()).hexdigest()[:16]

    # ---- low-level HTTP -----------------------------------------------------
    def _request(self, method, url, body=None, headers=None, timeout=60):
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("x-goog-api-key", self.api_key)
        if isinstance(body, (dict, list)):
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
            raise GeminiError(f"Couldn't reach Gemini ({e}).", "retryable")

    @staticmethod
    def _json(raw):
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    @staticmethod
    def _classify(status, payload):
        msg = (payload.get("error") or {}).get("message") or f"HTTP {status}"
        low = msg.lower()
        if _is_quota(status, msg):
            return GeminiError(msg, "model", status)       # retrying won't help; another model might
        if status in (429, 500, 502, 503, 504):
            return GeminiError(msg, "retryable", status)
        if status in (401, 403) or "api key" in low or "permission" in low:
            return GeminiError(msg, "config", status)
        if status == 404 or (status == 400 and re.search(
                r"model|not supported|unsupported|schema|thinking|no longer available", low)):
            return GeminiError(msg, "model", status)
        if status in (400, 413) and re.search(r"payload|too large|exceed|token|size|page", low):
            return GeminiError(msg, "content", status)
        return GeminiError(msg, "fatal", status)

    # ---- models -------------------------------------------------------------
    def candidate_models(self):
        """Models to try, in order: primary first, then fallbacks.

        Models that were recently overloaded move to the back of the queue, so
        only the first request after an outage pays for the failed retries.
        """
        auto = self.primary.lower() == "auto"
        if self.fallback_setting.lower() not in ("auto", ""):
            extra = [m.strip() for m in self.fallback_setting.split(",") if m.strip()]
        else:
            extra = self._discover_lite_models()
        head = [] if auto else [self.primary]
        models = head + [m for m in extra if m not in head]
        models = models[:len(head) + self.max_fallbacks + (1 if auto else 0)] or [FALLBACK_ALIAS]
        now = time.time()
        with _lock:
            cooling = {m for m, until in _cooldown.items() if until > now}
        return [m for m in models if m not in cooling] + [m for m in models if m in cooling]

    def _cool_down(self, model):
        with _lock:
            _cooldown[model] = time.time() + COOLDOWN_SECONDS

    def _discover_lite_models(self):
        """Newest-first list of gemini-X.Y-flash-lite models this key can use."""
        with _lock:
            hit = _model_cache.get(self._key_id)
            if hit and time.time() - hit[1] < MODEL_CACHE_SECONDS:
                return hit[0]
        found = []
        try:
            status, _, raw = self._request("GET", f"{API}/models?pageSize=1000", timeout=20)
            if status == 200:
                for m in self._json(raw).get("models", []):
                    name = m.get("name", "").replace("models/", "")
                    match = MODEL_PATTERN.match(name)
                    if match and "generateContent" in m.get("supportedGenerationMethods", []):
                        found.append((float(match.group(1)), name))
        except GeminiError:
            pass
        models = [n for _, n in sorted(found, reverse=True)]
        if models:   # don't cache a failed lookup
            with _lock:
                _model_cache[self._key_id] = (models, time.time())
                if len(_model_cache) > 500:
                    _model_cache.clear()
        return models

    # ---- generation -----------------------------------------------------------
    def generate(self, model, body, timeout):
        """One generateContent call. Returns (text, usage, model_version)."""
        status, _, raw = self._request("POST", f"{API}/models/{model}:generateContent", body, timeout=timeout)
        payload = self._json(raw)
        if status != 200:
            raise self._classify(status, payload)

        block = (payload.get("promptFeedback") or {}).get("blockReason")
        if block:
            raise GeminiError(f"Gemini declined to read these files (reason: {block}).", "content")
        candidates = payload.get("candidates") or []
        if not candidates:
            raise GeminiError("Gemini returned an empty response.", "model")
        cand = candidates[0]
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        finish = cand.get("finishReason", "")
        if not text.strip():
            if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"):
                raise GeminiError(f"Gemini declined to summarise this content (reason: {finish}).", "content")
            raise GeminiError(f"Gemini returned no text (finish reason: {finish or 'unknown'}).", "model")
        if finish == "MAX_TOKENS":
            raise GeminiError("Gemini's answer was cut off before it finished.", "model")
        return text, payload.get("usageMetadata") or {}, payload.get("modelVersion") or model

    def generate_with_fallback(self, body, parse, deadline, log=lambda *_: None):
        """Try each candidate model (with retries) until ``parse(text)`` succeeds.

        ``parse`` turns the model text into a result or raises ValueError, in
        which case the same model is retried once before moving on.
        """
        last, saw_quota = None, False
        for model in self.candidate_models():
            for attempt in range(len(RETRY_DELAYS) + 1):
                remaining = deadline - time.time()
                if remaining < 15:
                    raise last or GeminiError("Ran out of time waiting for Gemini.", "retryable")
                try:
                    text, usage, version = self.generate(model, body, min(self.timeout, remaining))
                    return parse(text), {"model": model, "model_version": version, "usage": usage,
                                         "attempts": attempt + 1}
                except ValueError:
                    last = GeminiError("Gemini returned malformed JSON.", "model")
                    if attempt >= 1:
                        break
                    log(f"model={model} attempt={attempt + 1} malformed JSON, retrying")
                    continue
                except GeminiError as e:
                    last = e
                    saw_quota = saw_quota or _is_quota(e.status, str(e))
                    log(f"model={model} attempt={attempt + 1} {e.kind} status={e.status}")
                    if e.kind != "retryable" or attempt >= len(RETRY_DELAYS):
                        break
                    time.sleep(RETRY_DELAYS[attempt])
            if last and last.kind == "retryable":
                self._cool_down(model)
            if last and last.kind in ("content", "config", "fatal"):
                break  # another model won't fix these
        if saw_quota and last and last.kind in ("retryable", "model"):
            raise GeminiError(str(last), "quota", 429)
        raise last or GeminiError("No Gemini model was available.", "retryable")

    # ---- Files API --------------------------------------------------------------
    def upload(self, data, mime, display_name):
        """Upload bytes via the resumable Files API; return (file_name, file_uri)."""
        status, headers, raw = self._request(
            "POST", UPLOAD_API, {"file": {"display_name": display_name[:120]}},
            headers={"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                     "X-Goog-Upload-Header-Content-Length": str(len(data)),
                     "X-Goog-Upload-Header-Content-Type": mime}, timeout=60)
        url = headers.get("X-Goog-Upload-URL") if headers else None
        if status != 200 or not url:
            raise self._classify(status, self._json(raw))

        status, _, raw = self._request(
            "POST", url, data,
            headers={"Content-Length": str(len(data)), "X-Goog-Upload-Offset": "0",
                     "X-Goog-Upload-Command": "upload, finalize"}, timeout=300)
        if status != 200:
            raise self._classify(status, self._json(raw))
        info = self._json(raw).get("file") or {}

        deadline = time.time() + FILE_POLL_SECONDS
        while info.get("state") == "PROCESSING" and time.time() < deadline:
            time.sleep(2)
            status, _, raw = self._request("GET", f"{API}/{info['name']}", timeout=30)
            if status == 200:
                info = self._json(raw)
        if info.get("state") == "FAILED":
            raise GeminiError(f"Gemini couldn't process “{display_name}”.", "content")
        if info.get("state") == "PROCESSING":
            raise GeminiError(f"“{display_name}” is taking too long to process; try a shorter file.", "content")
        return info["name"], info["uri"]

    def delete_later(self, names):
        """Best-effort cleanup of uploaded files (they also expire after 48h)."""
        def run():
            for name in names:
                try:
                    self._request("DELETE", f"{API}/{name}", timeout=20)
                except GeminiError:
                    pass
        if names:
            threading.Thread(target=run, daemon=True).start()


def inline_part(mime, data):
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}}


def file_part(mime, uri):
    return {"fileData": {"mimeType": mime, "fileUri": uri}}
