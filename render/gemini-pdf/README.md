# Gemini Brief Proxy (`render/gemini-pdf`)

A small web service that turns client brief files into a structured **Project
Brief Summary** using Google **Gemini Flash-Lite**. It is the AI back end for
**Fetch**, the brief extractor page (`../../index.html`).

Deployed at **https://gemini-proxy-oj4u.onrender.com**.

It's written in Python's standard library only (no `pip install`) and ships with
a Dockerfile and a `render.yaml`, so it deploys to [Render](https://render.com)
as a web service.

---

## Why it exists

The static page can't hold a shared Gemini API key, because anything shipped to
a browser is public. This service keeps the key server-side and offers **one
narrow operation**: "turn these brief files into a Project Brief Summary". It is
deliberately *not* a general Gemini relay. The prompt and output schema live
here, so nobody can reuse the key for arbitrary prompts through it.

**Bring your own key.** The shared `GEMINI_API_KEY` is optional. Each user can
instead paste their own key in Fetch's **Settings**. The page sends it in the
`X-Gemini-Api-Key` header with each request, and the service uses it for that
request only: it is never stored or logged.

```
 Browser (index.html)                     this service                       Google
 ──────────────────────────               ─────────────────────────          ──────────
 files + typed text  ── POST /extract ──▶ 1. detect each file's real type
 (multipart)                              2. convert Office/RTF/HTML/e-mail
                                             to text (+ embedded images)
                                          3. build prompt + JSON schema  ──▶ Gemini
                                          4. retry / fall back if busy   ◀── JSON
                                          5. validate + normalise JSON
 {brief, meta}       ◀─────────────────── 6. respond
```

---

## Endpoints

| Method    | Path       | Purpose |
| --------- | ---------- | ------- |
| `GET`     | `/`        | Service info: model, limits, schema version. |
| `GET`     | `/health`  | `{"status":"ok","configured":false,"accepts_user_key":true}`. `configured` = a shared key is set. The page calls this on load to wake a sleeping instance and to decide whether to ask for a key. Point Render's health check here. |
| `POST`    | `/extract` | The main route (below). |
| `OPTIONS` | *any*      | CORS preflight. |

### `POST /extract`

`multipart/form-data` with:

| Field   | Required | Description |
| ------- | -------- | ----------- |
| `files` | 0–10     | The brief files. Repeat the field for several files. |
| `text`  | optional | Text typed or pasted by the user (up to 200,000 characters). |
| `today` | optional | `YYYY-MM-DD` in the user's time zone. Used for "Date filed" and to resolve relative dates. Ignored if more than a day away from the server's date. |

Optional header **`X-Gemini-Api-Key`**: the user's own Gemini key. If present,
it is used instead of `GEMINI_API_KEY` for this request. If neither exists, the
request fails with `503 not_configured`.

At least one file or some text is required.

**Response `200`:**

```json
{
  "brief": {
    "schema_version": 1,
    "date_filed": "2026-10-02",
    "due_date": { "date": "2026-10-16", "note": "5:00 PM PHT via email to …" },
    "client_name": "NovaFizz Philippines — Carla Mendoza, Senior Brand Manager",
    "project_title": "NovaFizz Zero University Esports League 2027",
    "project_title_is_placeholder": true,
    "event_period": "Jan – Mar 2027; Grand Final 20 Mar 2027",
    "key_dates": [{ "date": "16 Oct 2026", "label": "Proposal deadline" }],
    "venue": "Online (qualifiers) and SM North EDSA Skydome (Grand Final)",
    "objectives": ["…"],
    "target_audience": ["…"],
    "kpis": ["2,000 registered players", "…"],
    "scope_of_work": [{ "item": "Tournament operations", "detail": "…" }],
    "budget": { "amount": "PHP 8,500,000, inclusive of VAT and agency fees", "type": "ALL-IN" },
    "proposal_submission": { "type": "PITCH / PRESENTATION", "details": "…" },
    "notes": ["…"],
    "clarifications": ["Which 8 universities are targeted?"],
    "summary": "One or two sentences for the group chat.",
    "extraction_warnings": []
  },
  "meta": {
    "model": "gemini-3.5-flash-lite",
    "duration_ms": 5056,
    "sources": [{ "name": "brief.pdf", "kind": "pdf", "handling": "inline", "chars": 0, "images": 0 }],
    "usage": { "input_tokens": 5982, "output_tokens": 1212, "thinking_tokens": null }
  }
}
```

Enum values:

- `budget.type`: `ALL-IN` · `BASELINE / BALLPARK` · `TO BE CONFIRMED` (a figure
  exists but it's unclear whether it's all-in) · `NOT SPECIFIED`
- `proposal_submission.type`: `PAPER PASS ONLY` · `PITCH / PRESENTATION` · `NOT SPECIFIED`

Missing text fields are always the exact string `Not specified`, and missing
lists are `[]`. `brief_spec.normalize()` enforces the shape, whatever the model
returns.

**Errors** are always `{"error": {"code": "...", "message": "human readable"}}`:

| Status | `code` | When |
| ------ | ------ | ---- |
| 400 | `no_input`, `too_many_files`, `bad_request` | Nothing sent, more than `MAX_FILES` files, or a malformed body. |
| 400 | `invalid_api_key` | The `X-Gemini-Api-Key` header doesn't look like a key. |
| 401 | `invalid_api_key` | Google rejected the user's own key. |
| 403 | `forbidden_origin` | The page's origin isn't in `ALLOWED_ORIGINS`. |
| 413 | `too_large` | More than `MAX_UPLOAD_MB` in total. |
| 415 | `bad_request` | The body isn't multipart. |
| 422 | `unsupported_file`, `content_rejected` | A file can't be read (the message says what to do), or Gemini refused the content. |
| 429 | `rate_limited` | Too many requests from one IP in an hour. Includes `Retry-After`. |
| 429 | `quota_exceeded` | The Gemini key (user's or shared) hit its per-minute/per-day quota on every model tried. |
| 502 | `upstream_error` | Gemini failed in an unexpected way. |
| 503 | `upstream_unavailable`, `busy`, `not_configured` | Gemini is overloaded (after retries and fallbacks), the server is at capacity, or there is no usable key (no shared key and none sent, or the shared key was rejected). |

The page shows an **Open Settings** button for `not_configured`, `invalid_api_key`
and `quota_exceeded`.

---

## Supported files

Gemini reads some formats natively; the rest are converted here first. File
types are detected **from the bytes**, not from the browser-supplied MIME type.

| Input | How it's handled |
| ----- | ---------------- |
| PDF | Sent to Gemini as-is (Gemini reads text, tables and images, including scans). |
| PNG, JPEG, WEBP, HEIC/HEIF | Sent as-is. The page converts GIF, BMP, SVG and AVIF to PNG, and shrinks huge screenshots, before uploading. |
| Word `.docx` | Text extracted in reading order (headings, lists, tables, text boxes; tracked deletions skipped) **plus** up to 8 large embedded images. |
| PowerPoint `.pptx` | Slide text in presentation order **plus speaker notes**, plus up to 8 large embedded images (decks often hold their content in pictures). |
| Excel `.xlsx` | Every visible sheet as rows (up to 3,000 rows per sheet). |
| OpenDocument `.odt/.odp/.ods` | Text, slides and sheets extracted from `content.xml`, plus pictures. |
| E-mail `.eml` / `.mht` | Headers and body, **plus attachments**, each processed recursively (e.g. a PDF attached to an e-mail). |
| RTF, HTML, TXT, MD, CSV, JSON, XML… | Converted or decoded to text (UTF-8, UTF-16 or Windows-1252 detected). |
| Audio (mp3, wav, m4a, ogg, flac…) | Sent to Gemini, e.g. a recorded briefing call. |
| Video (mp4, mov, webm…) | Uploaded via the Files API (processing can take a while). |
| Legacy `.doc/.ppt/.xls`, Outlook `.msg`, ZIP | Rejected with a message asking the user to save as PDF/.docx (or unzip). |

**Large files.** If inline binary data exceeds `INLINE_BUDGET_MB` (default
14 MB, safely under Gemini's request limit), the largest files go through the
**Gemini Files API** instead. Uploaded files are deleted right after the
request (they would expire after 48 hours anyway).

---

## Models: Flash-Lite only

From 9 Oct 2026, free Gemini accounts are limited to **Flash-Lite**, so the
service uses Flash-Lite models only. With `GEMINI_MODEL=auto` (the default), it
lists the models the key can use and picks the newest `gemini-X.Y-flash-lite`
(currently `gemini-3.5-flash-lite`), then falls back to older ones
(`gemini-3.1-flash-lite`, …). New Lite releases are picked up automatically.
If the model list can't be fetched, it uses Google's `gemini-flash-lite-latest`
alias.

Flash-Lite is also much faster: a typical brief takes **~4–6 s** (Flash took
15–60 s). Accuracy on the test briefs matched Flash after tightening two prompt
rules (budget-type wording and applying short updates).

## Reliability

The Gemini free tier sometimes answers *"This model is currently experiencing
high demand"* (503). The service handles that so users don't have to:

1. **Retry**: on 429/5xx or network errors, the same model is retried once
   after 2 s.
2. **Fall back**: then the next model is tried. With
   `GEMINI_FALLBACK_MODELS=auto`, fallbacks are discovered via `GET /models`
   (Flash-Lite only, newest first, cached per key for an hour).
3. **Cool down**: a model that just failed with overload is moved to the back
   of the queue for 2 minutes, so only the first user after an outage pays for
   the failed attempts.
4. **Fail fast**: errors another model can't fix (bad key, refused content)
   are returned immediately. If every model fails with a **quota** error, the
   response says so (`quota_exceeded`) instead of "overloaded".
5. **Time budget**: an extraction gives up after `REQUEST_TIMEOUT` seconds
   (default 280).

The page adds one automatic retry, with a visible countdown, when the service
still answers `upstream_unavailable`.

Measured during development (Flash-Lite): a warm request takes **~4–6 s**.

---

## Configuration

Environment variables. None is strictly required.

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `GEMINI_API_KEY` | — | The **shared key** used for everyone (from Google AI Studio). Users' own keys from Fetch's Settings override it per request. If unset, every user must add their own. Also accepted as `GOOGLE_API_KEY` / `GEMINI_KEY` / `API_KEY` (any letter case; surrounding quotes are stripped) or as a Render **Secret File** named `GEMINI_API_KEY` (`/etc/secrets/GEMINI_API_KEY`). Never commit it. |
| `GEMINI_MODEL` | `auto` | `auto` = the newest Flash-Lite model available to the key. Or pin one, e.g. `gemini-3.5-flash-lite`. |
| `GEMINI_FALLBACK_MODELS` | `auto` | `auto` (discover Flash-Lite models, newest first) or a comma list, e.g. `gemini-3.1-flash-lite`. |
| `MAX_FALLBACKS` | `3` | How many fallback models to try. |
| `ALLOWED_ORIGINS` | `*` | Comma list of page origins allowed to call `/extract`, e.g. `https://briefs.example.com`. Use `null` to allow a page opened from `file://`. |
| `MAX_UPLOAD_MB` | `50` | Total upload cap per request. |
| `MAX_FILES` | `10` | Files per request. |
| `INLINE_BUDGET_MB` | `14` | Above this, the largest files go through the Files API. |
| `RATE_LIMIT_PER_HOUR` | `60` | Extractions per client IP per hour (`0` disables). |
| `MAX_CONCURRENT` | `4` | Simultaneous extractions; extra requests wait up to 60 s, then get `503 busy`. |
| `REQUEST_TIMEOUT` | `280` | Seconds before an extraction gives up. |
| `TZ_OFFSET_HOURS` | `8` | Offset for the server's idea of "today" (PH/SG = 8). |
| `PORT` | `8000` | Bind port. Render sets this automatically. |

Keep `MAX_UPLOAD_MB` / `MAX_FILES` in sync with `config.js`.

---

## Deploying to Render

### Option A — Dashboard

1. Push this folder to a Git repository (like `tech/lark-proxy`, it works well
   as its own repo).
2. Render → **New → Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Docker
   - **Root Directory:** leave blank if this folder is the repo root, otherwise `render/gemini-pdf`
   - **Health Check Path:** `/health`
   - **Instance type:** Free works; Starter avoids cold starts (see below).
4. **Environment**: optionally add `GEMINI_API_KEY` (secret) as a shared key.
   Optionally set `ALLOWED_ORIGINS` to the page's origin.
5. **Create Web Service.** You get a URL like `https://gemini-pdf.onrender.com`.
6. Put that URL in `config.js` → `GEMINI_PROXY_URL`.

### Option B — Blueprint

With this folder as the repo root: Render → **New → Blueprint** → select the
repo. `render.yaml` defines the service; Render prompts for `GEMINI_API_KEY`
(you can leave it empty).

### Updating the existing deployment (v1.1)

1. Push the updated folder to the repo Render deploys from; Render rebuilds automatically.
2. In Render → the service → **Environment**: if `GEMINI_MODEL` is set to a
   Flash model (e.g. `gemini-3.8-flash`, the old `render.yaml` value), change it to
   `auto` or delete it. Otherwise the service keeps trying Flash first.
3. Check `https://gemini-proxy-oj4u.onrender.com/`: `"version"` should be
   `"1.2.0"`, `"model"` `"auto"`, and `"shared_key"."configured"` `true` (its
   `"source"` says where the key was found).

Until it's redeployed, the old version rejects requests that carry a user key
(the browser blocks the new `X-Gemini-Api-Key` header).

### Cold starts

Free Render instances sleep after 15 minutes idle and take roughly 20–60 s to
wake. The page pings `/health` as soon as it opens, so the service is usually
awake by the time the user has picked their files, and the loader's estimate
includes the wake-up time if it isn't. For instant responses, use a paid
instance.

---

## Running locally

Python 3.10+ with no dependencies:

```bash
cd render/gemini-pdf
GEMINI_API_KEY=your-key python gemini_proxy.py        # http://localhost:8000 (the key is optional)
```

On Windows PowerShell: `$env:GEMINI_API_KEY="your-key"; python gemini_proxy.py`.

Quick checks:

```bash
curl http://localhost:8000/health
curl -F "files=@brief.pdf" --form-string "text=Extra notes" http://localhost:8000/extract
curl -H "X-Gemini-Api-Key: your-key" --form-string "text=Client: Acme…" http://localhost:8000/extract
```

Point the page at it without editing anything:
`index.html?gemini=http://localhost:8000` (only `localhost` overrides are
accepted, so a shared link can't redirect uploads elsewhere).

Docker:

```bash
docker build -t gemini-pdf .
docker run --rm -p 8000:8000 -e GEMINI_API_KEY=your-key gemini-pdf
```

### Tests

```bash
python -m unittest discover -s tests -v
```

30 offline tests (Gemini is mocked) cover multipart parsing (binary-exact,
Unicode file names), DOCX/PPTX/XLSX/RTF/HTML/EML extraction, normalisation,
shared-key lookup (names, case, quotes, secret files), Flash-Lite discovery,
retry, fallback, cooldown and quota detection, user keys
(header, CORS, validation, rejection), and the HTTP error mapping.

Use `--form-string` (not `-F`) for text fields when testing with curl: `-F`
treats `;` in a value as a parameter separator and silently truncates it.

---

## Changing what gets extracted

| To change… | Edit |
| ---------- | ---- |
| Wording, rules, tone, field guidance | `prompt.md`. It's re-read on every request: edit, redeploy, done. `{{TODAY}}` and `{{WEEKDAY}}` are filled in automatically. |
| Fields / output structure | `RESPONSE_SCHEMA` and `normalize()` in `brief_spec.py`, then the page (`brief.js`, `doc.js`, `pdf.js`, `lark.js`) and the Lark columns (`tools/setup_lark_table.py`). Bump `SCHEMA_VERSION` for incompatible changes. |
| Supported file types | `extractors.py` |

---

## Security model

- **Shared key stays server-side**, read from the environment and sent only
  to Google in the `x-goog-api-key` header. It never appears in responses or logs.
- **User keys** arrive in the `X-Gemini-Api-Key` header over HTTPS, are
  shape-checked, used for that one request, and never stored or logged. Only a
  hash of the key is kept in memory, as the model-list cache key.
- **Narrow API**: a fixed prompt and schema. Callers can't send their own
  prompt, so the key can't be reused for anything else.
- **Prompt-injection guard**: the system prompt treats source content as
  data and tells the model to ignore instructions inside it.
- **Origin allow-list**: `ALLOWED_ORIGINS` (browsers only; non-browser
  clients can still call it, so combine it with the rate limit).
- **Rate limit** per client IP (via `X-Forwarded-For` on Render), plus a
  concurrency cap and an upload size cap.
- **Logs** record only method, path, status, file count, model and timing:
  never file names, file contents, brief text or headers.
- **Zip-bomb guard**: any single XML part of an Office file over 80 MB is
  refused. ZIP archives aren't unpacked at all.
- Runs as a non-root user in the container.

Data note: uploaded briefs are sent to Google's Gemini API for processing.
Under the paid tier Google doesn't use API data to improve its products; under
the **free tier it may**. Use a paid key for confidential client material.

---

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `/health` shows `"configured": false` | The running service found no shared key. Open `/`: `shared_key.hint` says what to do. The startup log shows `shared Gemini key: NOT FOUND` plus any similarly named variables (names only), which helps spot a typo. In Render → **Environment**, add `GEMINI_API_KEY` and choose **Save, rebuild, and deploy** (a plain *Save* doesn't restart the service). When it's found, the log says `shared Gemini key: found in environment variable GEMINI_API_KEY (39 characters)`. |
| `401 invalid_api_key` | The user's own key was rejected. They should re-copy it from Google AI Studio into Settings. |
| `429 quota_exceeded` | The key hit its free-tier limits. Wait, or use a different key. |
| `503 upstream_unavailable` | All candidate models were overloaded. Wait a minute; the page retries once automatically. A paid tier helps a lot. |
| `503 not_configured` | No usable key: none shared and none sent, or the shared key is invalid. |
| `403 forbidden_origin` | Add the page's exact origin (scheme + host + port) to `ALLOWED_ORIGINS`. |
| Model not found / `429` on Flash in logs | `GEMINI_MODEL` is pinned to a retired or non-free model. Set it to `auto`. |
| Render: "No open ports detected" | Don't override `PORT`; the app binds to whatever Render injects. |
| First request after idle is slow | Free-tier cold start; expected. |

---

## Files

| File | Purpose |
| ---- | ------- |
| `gemini_proxy.py` | HTTP server: routes, CORS, multipart parsing, rate limiting, orchestration. |
| `gemini_client.py` | Gemini REST client: retries, fallback, cooldown, Files API. |
| `brief_spec.py` | The contract: prompt loading, response schema, normalisation. |
| `prompt.md` | The system prompt (edit this to tune the output). |
| `extractors.py` | File-type detection and conversion to Gemini parts. |
| `tests/test_proxy.py` | Offline unit and integration tests. |
| `Dockerfile`, `.dockerignore` | Container image for Render. |
| `render.yaml` | Render Blueprint. |
