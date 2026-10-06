# Fetch — Project Brief Extractor

<img src="img/fetch-icon.svg" alt="Fetch logo" width="96" align="right">

**Fetch** turns long, messy client briefs into a **one-page Project Brief
Summary** in seconds, then files it in the team's Lark Base.

Business Development drops in a brief (PDF, Word, PowerPoint, Excel, a
screenshot of a chat, an e-mail, or just pasted text) and gets back:

- a **standardised document** they can edit by clicking on it and download as a PDF;
- a **copy-paste message** formatted for the group chat;
- a **row in the Lark Base** (on confirmation), with the full brief stored
  as JSON so it can be reopened, edited and re-shared from the page later;
- a **history of every brief** the team has filed, searchable and sortable
  by due date.

No training needed: the landing page is one box that says "Upload your brief files".

---

## Contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [What gets extracted](#what-gets-extracted)
- [The Lark table](#the-lark-table)
- [Deploying](#deploying)
- [Using it (for the BD team)](#using-it-for-the-bd-team)
- [Settings](#settings)
- [Local development](#local-development)
- [Design decisions](#design-decisions)
- [Security & privacy](#security--privacy)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Maintenance recipes](#maintenance-recipes)

---

## How it works

```
                    ┌──────────────────────────────────────────────┐
                    │  index.html — static page (no build step)   │
                    │  drop files / type ▸ loader ▸ editable doc   │
                    └───────┬───────────────────────────┬──────────┘
        ① multipart POST    │                           │  ⑤ GET /token
          /extract          │                           │    POST /proxy?url=…records
                            ▼                           ▼
  ┌─────────────────────────────────┐      ┌────────────────────────────────┐
  │ render/gemini-pdf  (Render)     │      │ Lark CORS proxy  (Render)      │
  │ gemini-pdf-6wp4.onrender.com  │      │ tech/lark-proxy                │
  │ · shared key or user's own key  │      │ · holds Lark app credentials   │
  │ · converts Office/e-mail → text │      │ · lark-proxy-dwiw.onrender.com │
  │ · fixed prompt + JSON schema    │      └───────────────┬────────────────┘
  │ · Flash-Lite, retries, fallback │                      │
  └───────────────┬─────────────────┘                      │
                  │ ② generateContent                      │ ⑥ Bitable API
                  ▼                                        ▼
     Google Gemini API (Flash-Lite)              Lark Base "AM BD Universe"
          ③ structured JSON                     table tblG3XcLw2auB4lM
```

0. As soon as the page opens it **wakes both Render services** (free instances
   sleep when idle) and **loads the briefs list** from Lark in the background.
1. The user drops files and/or types the brief. The page converts odd image
   formats, shrinks huge screenshots, and uploads everything to the **Gemini
   proxy** with real upload progress. If the proxy is still waking up, the
   loader says so and waits for it first.
2. The proxy detects each file's real type, converts what Gemini can't read
   natively (DOCX, PPTX, XLSX, e-mails…) to text, and calls **Gemini
   Flash-Lite** with a **fixed prompt and a strict JSON schema**. It uses the
   service's shared key, or the user's own key from Settings if they added one.
3. The JSON is validated and normalised, so the page always gets the same shape.
4. The page renders it as an **editable document** (following
   `project-brief-template.md`), generates the **chat message**, and can
   produce a **PDF**. Every edit updates one JSON model that feeds all outputs.
5. When the user clicks **Save to Lark Base** and confirms, the page calls
   the **Lark proxy**, which adds a row: readable columns plus a `Brief JSON` column.
6. The **All briefs** view reads every row back, rebuilds each document from
   its JSON, and lets anyone reopen, edit and **Save changes**.

---

## Repository layout

```
project-brief/                     ← the repository root = the website root
├── index.html                     ★ Page shell: compose, loader, document, history, settings, dialog
├── config.js                      ★ Defaults for everyone (service URLs, Lark table, Next Steps list)
├── styles.css                     Design tokens, light/dark themes, motion, responsive layout
├── app.js                         Routing and screens (incl. Next steps & Attachments cards)
├── settings.js                    Per-browser settings (Gemini key, name, addresses) + Settings screen
├── brief.js                       Brief model: normalise, dates, Markdown, chat text
├── doc.js                         Editable document renderer (click-to-edit)
├── pdf.js                         PDF export (pdfmake, lazy-loaded from cdnjs)
├── lark.js                        Lark Base client: rows, column mapping, file uploads
├── extract.js                     Talking to the Gemini proxy: wake-up, upload, wait estimate
├── icons.js                       Inline SVG icons
├── manifest.webmanifest           App name + icons for "Add to Home Screen"
├── .nojekyll                      Tells GitHub Pages to serve files as-is
├── img/
│   ├── fetch-logo.svg             Logo source (single colour, no dash lines)
│   ├── fetch-icon.svg             App icon / favicon, built from fetch-logo.svg
│   └── fetch-icon-32/180/512.png  PNG fallbacks (browser tab, iPhone home screen, app icon)
├── README.md                      ← you are here
├── project-brief-template.md      The summary template the document follows
├── render/
│   └── gemini-pdf/                The Gemini proxy (Render web service) — see its README
└── tools/
    ├── setup_lark_table.py        Creates or repairs the Lark table's columns (re-runnable)
    └── serve_web.py               Serves the page locally with caching disabled (for testing)
```

---

## What gets extracted

Each requested field maps to one place in the JSON, the document, the PDF and
the Lark row:

| Field | JSON (`schema_version: 1`) | Document section | Lark column(s) |
| ----- | -------------------------- | ---------------- | -------------- |
| Date filed | `date_filed` (set by the system, user's local date) | Header, Overview | **Date Filed** (date) |
| **Due date** | `due_date.date` (ISO) + `due_date.note` (time, channel) | Overview, with a "due in N days" badge | **Due Date** (date), **Submission Details** |
| Client name | `client_name` | Header, Overview | **Client** |
| Project title | `project_title` + `project_title_is_placeholder` | Header ("Suggested title" badge if invented), Overview | **Project Title** (primary) |
| Event date / period | `event_period` + `key_dates[]` | Overview, with a milestone list | **Event Date / Period** |
| Venue | `venue` | Overview | **Venue** |
| Objective | `objectives[]` | Project Core 1 | **Objective** |
| Target / primary audience | `target_audience[]` | Project Core 2 | **Target Audience** |
| KPIs | `kpis[]` | Project Core 3 | **KPIs** |
| Scope of work | `scope_of_work[{item, detail}]` | Execution & Requirements | **Scope of Work** |
| Estimated budget | `budget.amount` + `budget.type` | Financials | **Estimated Budget**, **Budget Type** |
| Proposal submission | `proposal_submission.type` + `.details` | Financials | **Proposal Submission**, **Submission Details** |
| Notes | `notes[]` | Additional Notes | **Notes** |
| *(added)* Questions for the client | `clarifications[]` + `show_clarifications` | Optional **Questions for the Client** section, hidden by default: a bar under Additional Notes offers **Show** / **Hide**. Only included in the PDF, Markdown and chat text while shown. | **Questions for Client** (always saved) |
| *(added)* TL;DR | `summary` | Under the title; first lines of the chat text | **Summary** |
| *(added)* Source problems | `extraction_warnings[]` | Yellow banner above the document (not printed) | — |

Rules the model follows (see `render/gemini-pdf/prompt.md`):

- **Never invent.** Anything missing is exactly `Not specified` (shown greyed
  and italic) and usually generates a question in *To clarify with the client*.
  Inferred facts are marked `(inferred)`.
- **Budget type:** `ALL-IN`, `BASELINE / BALLPARK`, `TO BE CONFIRMED` (a figure
  exists but inclusivity is unclear) or `NOT SPECIFIED`.
- **Proposal submission:** `PAPER PASS ONLY`, `PITCH / PRESENTATION` or `NOT SPECIFIED`.
- **Project title:** if the brief has none, a descriptive placeholder is
  created and flagged "Suggested title".
- **Due date** is *our* proposal deadline; other milestones go to key dates.
- Evaluation criteria and weights go to **Notes**, never to KPIs.
- Several sources are merged into one brief, and conflicts between them are
  called out in Notes.
- Non-English briefs are summarised in English.
- Text inside the files can't change these rules (prompt-injection guard).

### The fixed document format

The document follows `project-brief-template.md`, rendered the same way every
time: a yellow band, the "PROJECT BRIEF SUMMARY" kicker, the title, client and
filed date, the TL;DR, then **Overview** (table) → **Project Core** (1 Objective,
2 Target / Primary Audience, 3 KPIs) → **Execution & Requirements** (Scope of
Work, Financials & Submissions) → **Additional Notes** (notes plus questions for
the client). The PDF is built from the same JSON with pdfmake: A4, vector text,
page numbers.

### The group-chat message

Plain text with emoji section markers, so it scans well in Lark. "Copy for
group chat" places **both rich text and plain text** on the clipboard, so
headings stay bold where the chat supports it:

```
📋 PROJECT BRIEF: Travel Tour Expo 2027 – KTO Korea Pavilion
🏢 Client: Korea Tourism Organization Manila Office
⏰ Due: 9 Nov 2026 (Mon) — via email to ktomanila.event@gmail.com
📅 Event: 3-day event, 5–7 Feb 2027
📍 Venue: SMX Convention Center Manila, Pasay City, Philippines

TL;DR: KTO Manila seeks an in-house fabrication agency to design, build and …

🎯 Objective
• Create a highly visible Korea Pavilion …
…
💰 Budget: Approximately USD 45,000, all-inclusive (All-in)
📝 Proposal: Pitch / Presentation — Submit via email … plus 5 printed copies …
❓ To clarify with client
1. What are the quantitative KPIs for footfall and lead generation?
Filed 2 Oct 2026
```

---

## The Lark table

Base **AM BD Universe** → table `tblG3XcLw2auB4lM`
([open](https://mineskiglobal.sg.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblG3XcLw2auB4lM&view=vewMIKkyNv)).
The columns were created by `tools/setup_lark_table.py`:

| Column | Type | Notes |
| ------ | ---- | ----- |
| Project Title | Text (primary) | |
| Client | Text | |
| Date Filed | Date | |
| Due Date | Date | Sort or filter by this to see upcoming deadlines. **Editing it in Lark is reflected on the page.** |
| Status | Single select | New · In Progress · Submitted · Won · Lost · Declined. New rows start as **New**; manage it in Lark, and the page shows it on each card. |
| Event Date / Period, Venue, Objective, Target Audience, KPIs, Scope of Work, Estimated Budget | Text | Readable copies for browsing in Lark. |
| Budget Type | Single select | All-in · Baseline / Ballpark · To be confirmed · Not specified |
| Proposal Submission | Single select | Paper pass only · Pitch / Presentation · Not specified |
| Submission Details, Notes, Questions for Client, Summary | Text | |
| Filed By | Text | Optional name entered in the save dialog (remembered per browser). |
| Source Files | Text | Names of the uploaded files. |
| Requirement Type | Single select | RFP (Request for Proposal: pitch and propose) · RFQ (Request for Quotation: quotation only) · RFI (Request for Information: just asking, nothing to submit). Gemini detects it, and the choice is pre-selected in the **Requirement & VAT** card beside the document, with Gemini's one-line reason; the user can change it. Saved to Lark only, not in the document. |
| VAT | Multi-select (one value used) | **VAT Inc.** (prices include 12% VAT) or **VAT Ex.** (VAT-exclusive, or 0% for foreign / exempt clients). Gemini follows what the brief explicitly says first; if it says nothing, a local client means VAT Inc. and a foreign one VAT Ex. The pre-selected choice always agrees with the note shown under it. Labels: `VAT_CHOICES` in `config.js`. |
| Next Steps | Multi-select | Picked in the **Next steps** card beside the document (AM Assignment, File Project Brief and trigger Lark GC, PM Assignment, Pitch Deck, Other, or a custom step, which Lark adds as a new option). Saved to Lark only, never part of the document, PDF or chat text. The default list is `NEXT_STEP_OPTIONS` in `config.js`. |
| Attachments | Attachment | The uploaded brief files (plus typed text as `Brief text.txt`), uploaded on save through the Lark proxy (Drive media API, `drive:drive` scope). Files can be added or removed in the **Attachments** card. Limit per file: `LARK_ATTACH_MAX_MB` (10 MB, the Lark proxy's default `MAX_BODY_BYTES`; Lark allows up to 20 MB). Files from before a page reload must be re-added. |
| **Brief JSON** | Text | **The source of truth the page renders from. Don't edit it by hand.** |
| Last Modified | Modified time | Automatic. |

**Where edits belong.** The page renders each brief from `Brief JSON`. Edit
content **on the page** (click the document, then *Save changes to Lark*), which
rewrites the JSON and every readable column together. In Lark itself, edit only
**Status** and **Due Date**. Changes to other readable columns are overwritten
the next time someone saves that brief from the page. If a row's JSON is ever
missing or broken, the page rebuilds the brief from the readable columns instead.

**Permissions.** The Base uses Advanced Permissions. The Lark app used by the
proxy (`cli_aab0716138b8ded3`) needs **Can edit** (add and edit records) on
this table at runtime. Running the setup script again additionally needs
permission to manage fields.

Re-running the setup is safe. It only creates what's missing:

```bash
python tools/setup_lark_table.py            # dry run: shows the plan
python tools/setup_lark_table.py --apply    # create or repair columns
```

`--prune` additionally removes columns and rows that hold **no data at all**
(used once, to clear the blank rows a new Lark table starts with).

---

## Deploying

### 1. Deploy the Gemini proxy (Render)

Already deployed at **https://gemini-pdf-6wp4.onrender.com**. To set it up
from scratch, follow [`render/gemini-pdf/README.md`](render/gemini-pdf/README.md#deploying-to-render):
Render → **New → Web Service** → Docker, root `render/gemini-pdf`, health check
`/health`.

- `GEMINI_API_KEY` is the **shared key** everyone uses by default. Users only
  need their own key (Settings) if no shared key is set, or if they prefer
  their personal quota. The service also accepts the key under
  `GOOGLE_API_KEY` (any letter case) or as a Render **Secret File** named
  `GEMINI_API_KEY`.
- To confirm the service sees it, open
  https://gemini-pdf-6wp4.onrender.com/: `shared_key.configured` should be
  `true`, and `shared_key.source` says where the key was found. If it says
  `false`, the Render log line `shared Gemini key: NOT FOUND` lists any
  similarly named variables, which helps spot a typo.
- `GEMINI_MODEL` should be `auto` (or unset), which uses the newest Flash-Lite model.

**After updating the code** (e.g. this v1.1), redeploy the service and check
its `GEMINI_MODEL` variable. See
[Updating the existing deployment](render/gemini-pdf/README.md#updating-the-existing-deployment-v11).

### 2. Point the page at it

`config.js` already points at the deployed services:

```js
GEMINI_PROXY_URL: "https://gemini-pdf-6wp4.onrender.com",
LARK_PROXY_URL:   "https://lark-proxy-dwiw.onrender.com",
```

These are the defaults for everyone. A user can override them for their own
browser under **Settings → Advanced**. There is no cache to bust after an
update: the page loads its styles and scripts under a fresh URL every time it
opens (`BX_BUILD` in `index.html`), so users always get the latest files.

### 3. Host the page (GitHub Pages)

The website is the files in the project root: `index.html`, the `.js` files,
`styles.css`, `manifest.webmanifest`, `.nojekyll` and `img/`. They're plain
static files (no build step, no server code) linked with relative paths, so
they work at any address, including a GitHub Pages sub-path like
`https://<user>.github.io/<repo>/`.

To publish manually:
1. Push the project to a GitHub repository.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, then pick `main` and `/ (root)`, and **Save**.
3. After a minute the site is live at the URL shown in Settings → Pages.
   Every later push to `main` republishes it.

Branch publishing serves **every file in the repository**, including
`render/`, `tools/`, this README and `project-brief-template.md`. None of them
contain secrets (the Gemini key lives only in Render's environment), but keep
it that way: never commit API keys or `.env` files to this repository. The
`.nojekyll` file makes GitHub serve the files as-is.

Other static hosts (Netlify, Cloudflare Pages, Render Static Site) work the
same way: publish the project root, no build command.

For quick internal use you can also open `index.html` straight from disk. It
works from `file://`, but then the Gemini proxy's `ALLOWED_ORIGINS` must
include `null` or stay `*`.

### 4. Lock it down (recommended)

On the Gemini proxy, set `ALLOWED_ORIGINS` to the page's origin. For GitHub
Pages that is `https://<user>.github.io`, with no repo path, because an origin
is scheme + host only. The Lark proxy has its own `ALLOWED_ORIGIN`
variable (see `tech/lark-proxy/README.md`).

---

## Using it (for the BD team)

0. **First time only:** if a yellow *Setup needed* bar appears, click it and
   paste your Gemini API key in **Settings** (free from
   [Google AI Studio](https://aistudio.google.com/apikey)), then add your
   name so it shows as *Filed by*.
1. Open Fetch. **Upload** the brief files (drop them on the box or click
   *Upload your brief files*), **paste** a screenshot with Ctrl+V, and/or
   **type or paste** the brief text. Several files at once is fine: they're
   merged into one brief.
2. Click **Extract brief**. A countdown shows roughly how long it will take
   (usually 5–10 s; up to a minute more if the service was asleep, and the
   loader tells you when that's happening).
3. Read the summary. **Click any text to change it.** Press Enter for a new
   bullet; Backspace on an empty bullet removes it. Click the yellow chips to
   change *budget type* or *submission type*, and the date chip to pick the
   *due date*.
4. **Copy for group chat** → paste it in the chat. **Download PDF** for a file.
5. **Save to Lark Base** → check the summary → **Save to Lark**. You land on
   **All briefs**, with your new brief highlighted.
6. Later, open **All briefs**, search or sort by due date, click a card to
   reopen it, edit, and **Save changes to Lark**.

If you close the tab before saving, the page offers to **resume** your
unsaved brief next time.

---

## Settings

The gear icon in the top bar opens **Settings**. Everything there is saved in
the current browser only.

| Setting | What it does |
| ------- | ------------ |
| **Gemini API key** | Your own key from [Google AI Studio](https://aistudio.google.com/apikey). It's sent to the extraction service with each brief (`X-Gemini-Api-Key` header), used once, and never stored there. **Required** when the service has no shared key; the status pill shows *Key needed*, *Using the shared key* or *Using your key*. **Save key** also checks it with Google and shows which Flash-Lite model you'll get; **Test key** re-checks it. |
| **Appearance** | System (follows the computer), Light or Dark. Saved per browser and applied before the page draws, so there's no flash. |
| **Your name** | Pre-fills *Filed by* when you save a brief. |
| **Connections** | Live status of the extraction service (*Awake* / *Waking up…* / *Unreachable*) and Lark (*Connected · N briefs*), with **Wake up** and **Refresh** buttons. |
| **Advanced: service addresses** | Override the extraction service URL, the Lark proxy URL, or the Lark table (paste the table's link). Empty = the defaults in `config.js`. |
| **This browser** | Clears the unsaved draft and the cached briefs list (keeps your key and name). |

The *Setup needed* bar on the landing page, and any key-related error in the
loader, link straight to the key field (`#/settings/key`).

---

## Local development

```bash
# 1. Gemini proxy on :8000 (needs a key)
cd render/gemini-pdf
GEMINI_API_KEY=your-key python gemini_proxy.py

# 2. Static page on :8770 (any static server works)
cd ../..
python tools/serve_web.py          # serves the page on :8770 with caching disabled
```

Open `http://localhost:8770/?gemini=http://localhost:8000`. The `?gemini=` and
`?lark=` overrides are remembered for the tab session (`?reset` clears them),
and they **only accept localhost URLs**, so a shared link can't redirect
uploads elsewhere. `.claude/launch.json` defines the same static server for
Claude Code's preview.

Tests for the proxy (offline, Gemini mocked):

```bash
cd render/gemini-pdf && python -m unittest discover -s tests -v
```

---

## Design decisions

**System design**

- **Two small proxies, one job each.** The Gemini proxy holds the AI key; the
  existing Lark proxy holds the Lark credentials. Neither secret reaches the
  browser.
- **The prompt lives server-side.** The Gemini proxy exposes "extract a
  brief", not "call Gemini", so the key can't be reused for anything else, and
  the prompt is versioned with the service. Edit `prompt.md` and redeploy.
- **Structured output, then deterministic rendering.** Gemini returns JSON
  against a strict schema (`responseSchema`), and the server normalises it.
  The document, PDF, Markdown, chat text and Lark row are all generated from
  that one JSON, so the format is fixed and can't drift the way free-form
  Markdown would.
- **One model, many views.** Inline edits write straight into the JSON model.
  There is no HTML to scrape back, and what you see is exactly what gets saved.
- **Any format in.** Types are sniffed from the bytes. Office, OpenDocument,
  RTF, HTML and e-mail (including attachments) become text plus the larger
  embedded images. Large files go through the Gemini Files API.
- **Flash-Lite only.** Free Gemini accounts are limited to Flash-Lite from
  9 Oct 2026, so the proxy auto-selects the newest `gemini-X.Y-flash-lite`
  model. It's also 3–10× faster than Flash (~5 s per brief).
- **Bring your own key.** The proxy can run without a shared key; each user's
  key travels with their request and is never stored server-side.
- **Ready before you are.** On page load Fetch wakes both Render services and
  prefetches the briefs list, so *All briefs* is populated instantly.
- **Resilient to Gemini outages.** Retry, model fallback, a cooldown for
  overloaded models, and one automatic client retry with a visible countdown.
- **Idempotent saves.** Each draft carries a `client_token`, so a retried save
  can't create a duplicate row.
- **Stateless and cheap.** Both proxies are stdlib-only Python containers with
  no database. Lark is the database.

**UX**

- **One obvious action per screen**: drop or type → extract → review → save.
- **Honest waiting**: a self-calibrating estimate (it learns from past runs in
  this browser), real upload progress and staged steps. If the service is
  asleep, a separate *Waking up the service* step with its own countdown runs
  before anything is uploaded. The loader art is the Fetch dog, running to
  fetch your brief.
- **Edit in place**: the document *is* the editor, with hover highlights,
  word-processor keys, and click-to-pick chips for fixed choices.
- **Nothing is lost**: unsaved drafts survive a refresh; unsaved edits to saved
  briefs are kept while you browse and flagged on their card; closing the tab
  mid-extraction asks for confirmation.
- **Brand**: the Fetch logo (a dog fetching a letter), Mineski yellow (`#FFC800`) with near-black ink
  for contrast, a warm neutral palette with a single subtle background glow,
  Plus Jakarta Sans, light and dark themes, motion that respects *reduce
  motion*, and a phone layout with a bottom action bar.

---

## Security & privacy

- **Secrets**: the optional shared `GEMINI_API_KEY` is an environment
  variable on Render. The Lark app secret lives in the Lark proxy (see its
  README). Neither is in the website files.
- **User keys** live in the user's own browser storage (`localStorage`) and
  are sent only to the extraction service over HTTPS (and to Google when the
  user clicks *Test key*). The page loads no third-party scripts except
  pdfmake from cdnjs, pinned with Subresource Integrity. Anyone with access to
  that browser profile can read the key, so users should **Remove** it on
  shared computers.
- **Client data**: brief files are sent to Google Gemini for processing. On
  the **free tier, Google may use API inputs to improve its products**; use a
  **paid** Gemini key for confidential client briefs. Nothing is stored by the
  Gemini proxy, and uploaded Files-API copies are deleted after each request.
- **Access**: the page has no login of its own. Anyone who can open it can
  read the history (it shows what the Lark app can read) and add briefs. Host
  it somewhere internal, or behind your SSO or IP rules, if that matters.
- **Lark proxy**: the existing proxy can mint tokens for the app and forwards
  to any Lark API path. Treat its URL as internal and set its `ALLOWED_ORIGIN`
  (see `tech/lark-proxy/README.md`).
- **Abuse limits** on the Gemini proxy: an origin allow-list, a per-IP hourly
  rate limit, a concurrency cap and an upload cap.

---

## Limitations

- **Gemini free tier.** Free keys get Flash-Lite with per-minute and per-day
  limits; heavy use can hit `quota_exceeded`. Flash-Lite is slightly less
  thorough than Flash on very long or messy briefs, so review the summary
  before saving. A paid key lifts the limits.
- **Cold starts.** Free Render services sleep after 15 minutes; the first
  request can take 20–60 s extra. The page pre-warms both services and
  includes this in its estimate.
- **PDF font**: the PDF uses Roboto (bundled with pdfmake), which covers
  Latin, Greek and Cyrillic but not CJK. Since summaries are written in
  English this rarely matters, but Korean or Chinese proper nouns would not
  show in the PDF (they do show on screen and in the chat text).
- **Legacy formats** (`.doc`, `.ppt`, `.xls`, Outlook `.msg`) must be saved
  as PDF or a modern Office format first; the page tells the user how.
- **History is rendered from JSON**: see [The Lark table](#the-lark-table)
  for which Lark edits are reflected.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Yellow "Setup needed" bar on the landing page | The extraction service has no shared key and you haven't added yours: click the bar and paste your key in Settings. |
| "Your Gemini key needs attention" | Google rejected your key. Re-copy it from Google AI Studio into Settings and click **Test key**. |
| "Gemini usage limit reached" | Your key hit its free-tier limit. Wait a bit, or use another key. |
| A user key fails with a network error right after an update | The extraction service still runs the old version. Redeploy it on Render. |
| "Gemini is overloaded right now" | Temporary Gemini capacity issue. The page retries once automatically; try again in a minute. |
| Red "Fetch can't reach its extraction service" bar, or console `net::ERR_BLOCKED_BY_CLIENT` | An ad blocker or privacy extension is blocking `gemini-pdf-6wp4.onrender.com`. Known cause, now avoided: uBlock Origin's lists block `||onrender.com/health` on every Render service, so the page checks each service's root URL (`/`) instead. Render's own health check can keep using `/health`. If something else gets blocked, open the blocker's request log to find the rule, then allow the address or pause the blocker for Fetch. Fetch detects instant in-browser rejections and shows the bar instead of retrying. |
| "Waking up the extraction service…" | Render cold start (up to a minute after ~15 idle minutes). Normal; it continues by itself. |
| Settings shows the extraction service as "Can't reach it (…)" | Fetch retries for ~3 minutes before saying this, and the reason is in brackets. Check the address under Settings → Advanced. Open https://gemini-pdf-6wp4.onrender.com/health in a browser: it should show `"status": "ok"`. |
| "Setup needed" even though a shared key is set on Render | The service doesn't see the key. See [Deploying → 1](#1-deploy-the-gemini-proxy-render): check `shared_key` at the service's root URL, then save the variable with **Save, rebuild, and deploy**. |
| "The app doesn't have permission to this Lark table" (`1254302`) | In the Base → Advanced Permissions, give the app's role **Can edit** on the table. |
| "The Lark table is missing a column" (`1254045`) | A column was renamed or deleted. Run `python tools/setup_lark_table.py --apply`. |
| All briefs shows "Waking up the Lark connection…" | The Lark proxy is cold-starting (up to ~1 minute). |
| A file is rejected | The message says why: e.g. an old `.doc`/`.ppt` (save as PDF), a ZIP (unzip it), or over 50 MB in total. |
| Users see an old version after an update | Only `index.html` itself could be stale (scripts and styles always load fresh). Reload the page; hosts normally revalidate HTML on every visit. |

---

## Maintenance recipes

**Tune the wording or rules**: edit `render/gemini-pdf/prompt.md` and redeploy
the proxy. No page changes needed.

**Add a field** (e.g. "Competitors"):

1. `render/gemini-pdf/brief_spec.py`: add it to `RESPONSE_SCHEMA` and
   `normalize()`; describe it in `prompt.md`.
2. `brief.js`: add it to `normalize()`, `toMarkdown()` and the chat text.
3. `doc.js`: render it (use `ed()` for text or `listBlock()` for a list).
4. `pdf.js`: add it to `build()`.
5. `lark.js` → `FIELD` and `toFields()`; `tools/setup_lark_table.py` →
   `FIELDS`; then run the script with `--apply`.

**Rename a Lark column**: update the name in both `lark.js` (`FIELD`) and
`tools/setup_lark_table.py` (`FIELDS`) first, otherwise saves fail with
`1254045`.

**Move to a different table**: update `LARK_APP_TOKEN`, `LARK_TABLE_ID` and
`LARK_TABLE_URL` in `config.js` and the constants at the top of the setup
script, grant the app access, then run the script with `--apply`.
