# Fetch — Project Brief Extractor

<img src="img/fetch-icon.svg" alt="Fetch logo" width="96" align="right">

**Fetch** turns long, messy client briefs into a **one-page Project Brief
Summary** in seconds, then files it in the team's Lark Base.

Business Development drops in a brief (PDF, Word, PowerPoint, Excel, a
screenshot of a chat, an e-mail, or just pasted text) and gets back:

- a **standardised document** they can edit by clicking on it and download as a PDF;
- a **copy-paste message** formatted for the group chat;
- **Check sources**: click any point of the summary to see the passages of the
  brief it was based on, highlighted in the original file, and **Brief files**
  to read and search the whole brief with everything the summary used marked;
- a **row in the Lark Base** (on confirmation), with the full brief stored
  as JSON so it can be reopened, edited and re-shared from the page later;
- a **history of every brief** the team has filed, searchable and sortable
  by due date.

No training needed: log in with Lark, and the landing page is one box that says
"Upload your brief files". Only people who can open the team's briefs table in
Lark can use Fetch.

> **Owner to do (once):** Fetch's local address is now `http://127.0.0.1:9124/`. Add it
> under *Security Settings → Redirect URLs* on the Lark app, or logging in from a local
> copy stops on Lark's error 20029. See [Lark login](#lark-login).

---

## Contents

- [How it works](#how-it-works)
- [Lark login](#lark-login)
- [Repository layout](#repository-layout)
- [What gets extracted](#what-gets-extracted)
- [Check sources](#check-sources)
- [The Lark table](#the-lark-table)
- [Deploying](#deploying)
- [Using it (for the BD team)](#using-it-for-the-bd-team)
- [Settings](#settings)
- [Local development](#local-development)
- [Testing](#testing)
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
        ① multipart POST    │                           │  ⑤ POST /proxy?url=…records
          /extract + login  │                           │    (as the signed-in user)
                            ▼                           ▼
  ┌─────────────────────────────────┐      ┌────────────────────────────────┐
  │ render/gemini-pdf  (Render)     │      │ Lark CORS proxy  (Render)      │
  │ gemini-pdf-6wp4.onrender.com  │      │ tech/lark-proxy                │
  │ · checks the Lark login         │      │ · adds the app secret at login │
  │ · converts Office/e-mail → text │      │ · lark-proxy-dwiw.onrender.com │
  │ · fixed prompt + JSON schema    │      └───────────────┬────────────────┘
  │ · Flash-Lite, retries, fallback │                      │
  └───────────────┬─────────────────┘                      │
                  │ ② generateContent                      │ ⑥ Bitable API
                  ▼                                        ▼
     Google Gemini API (Flash-Lite)              Lark Base "AM BD Universe"
          ③ structured JSON                     table tblG3XcLw2auB4lM
```

0. The user **logs in with Lark** (see [Lark login](#lark-login)). As soon as
   the page opens it **wakes both Render services** (free instances sleep when
   idle; the Settings screen shows each one's state), and once logged in it
   **loads the briefs list** from Lark in the background: every row, never
   through a view, and it checks the table's columns first. A list it can't read
   completely is an error, never a shorter list.
1. The user drops files and/or types the brief. The page converts odd image
   formats, shrinks huge screenshots, and uploads everything to the **Gemini
   proxy** with real upload progress, together with the user's Lark login. If
   the proxy is still waking up, the loader says so and waits for it first.
2. The proxy checks the login with Lark (is this person allowed to see the
   briefs table?), detects each file's real type, converts what Gemini can't read
   natively (DOCX, PPTX, XLSX, e-mails…) to text, and calls **Gemini
   Flash-Lite** with a **fixed prompt and a strict JSON schema**. It uses the
   service's shared key, or the user's own key from Settings if they added one.
3. The JSON is validated and normalised, so the page always gets the same shape.
   In the same answer Gemini lists, for every value and bullet, the passages of
   the sources it was based on (`evidence`), and the service sends back the text
   it converted from Office files and e-mails (`texts`). See [Check sources](#check-sources).
4. The page renders it as an **editable document** (following
   `project-brief-template.md`), generates the **chat message**, and can
   produce a **PDF**. Every edit updates one JSON model that feeds all outputs.
5. When the user clicks **Save to Lark Base** and confirms, the page uploads
   any attachments first (if one fails, nothing is saved until the person
   chooses *Try again* or *Save without these files*), then adds a row through
   the **Lark proxy**, as the signed-in user: readable columns plus a
   `Brief JSON` column, with *Filed by* set to their Lark name. It then reads
   the row back from Lark and says "All N fields checked in Lark." (or lists
   what Lark holds differently).
6. The **All briefs** view reads every row back, rebuilds each document from
   its JSON, and lets anyone reopen, edit and **Save changes**. A save re-reads
   the row, writes **only the cells that changed**, and refuses if one of those
   cells was changed in Lark since the page loaded it. Briefs marked
   **Done** move to a collapsed *Done* section; any brief can be deleted.

---

## Lark login

Fetch works the same way as Polaris (`../polaris`): people log in
with their own Lark account, and every Lark call runs **as that person**
(a `user_access_token`), not as the app.

```
 Log in with Lark ─▶ accounts.larksuite.com/…/authorize  (PKCE challenge + state)
                  ◀─ back to Fetch with ?code=…&state=…   (the code is removed from the address bar at once)
 wake the Lark proxy if it's asleep, then (once, 45 s limit, never retried):
 POST {lark proxy}/proxy?url=…/authen/v2/oauth/token   {code, code_verifier}   (no secret)
      the proxy adds the app secret ─▶ Lark ─▶ { access_token, expires_in: ~2 h }
 Every Lark call:            Authorization: Bearer <user token>  (through the Lark proxy)
 Every brief sent to Gemini: Authorization: Bearer <user token>  (the service checks it)
```

**Who can use Fetch.** Exactly the people who can open the briefs table in
Lark. Lark applies each user's own permissions, so:

- the **page** can only read, add, edit or delete what that person could in
  Lark itself (they need **edit** access to the table, plus permission to
  delete records for *Delete*);
- the **extraction service** asks Lark, with the same token, who the person
  is and whether they can open the briefs table, and refuses the brief
  otherwise (`401 login_required` / `login_expired`, `403 not_authorized`).
  A login token from another Lark app or company doesn't get through, and
  removing someone from the Base locks them out of extraction within 5 minutes.

**How long a login lasts.** About 2 hours (Lark gives no refresh token). The
top bar shows the time left, turning amber in the last 10 minutes, and a
warning stays on screen from 5 minutes before the end ("Your login ends at
4:30 PM."). Fetch won't start an extraction with under 2 minutes left, or a
save, Done or Delete with under 1 minute ("Your login is about to end, so this
wasn't sent."). The clock never ends the login under a running save or
extraction: it ends when that work settles. When a login ends (or Lark says it
has), the login screen appears and returns to the same page afterwards, the
cached list of briefs is dropped, and everything in progress is kept: the
unsaved draft, typed text and unsaved edits to saved briefs. Files picked for
upload have to be added again.

**Read-only logins.** If the login's scope doesn't include `bitable:app`, saving
is switched off with "Your login can only read the tables. Log in again to allow
saving."

**Where the token lives.** In `sessionStorage`: this tab only, gone when the
tab closes, never in a URL. A new tab means logging in again (one click if
you're already signed in to Lark). *Log out* (Settings → Account) is local only
(Lark has no way to revoke a token): it forgets the token and the cached briefs
list on this computer; you stay logged in to Lark itself, and the token itself
stays valid until it expires.

**One-time setup on the Lark app** (`cli_aab0716138b8ded3`, the same app as
Polaris, in the [Lark Developer Console](https://open.larksuite.com/app)):

| Setting | Value |
| ------- | ----- |
| *Security Settings → Redirect URLs* | Every address Fetch is opened from, exactly, with the trailing slash: **`http://127.0.0.1:9124/`** for local testing (Fetch's port; **the app owner has to add it, it isn't registered yet**), and the GitHub Pages address, e.g. `https://<user>.github.io/<repo>/`. Use `127.0.0.1`, never `localhost`: they are different origins. The old `http://localhost:8770/` and `http://localhost:9123/` entries can go (9123 is Polaris's port). The login screen checks its own address once the Lark proxy is awake and says if it isn't registered (Lark error 20029). |
| *Permissions & Scopes* | `bitable:app` enabled for **user identity** (already on for Polaris). |
| *Availability* | Everyone who should use Fetch (otherwise error 20010 at login). |

The Lark proxy needs its user-login support (forwarding GET, and adding the
app secret on `/authen/v2/oauth/token`). The hosted one has it.

---

## Repository layout

```
project-brief/                     ← the repository root = the website root
├── index.html                     ★ Page shell: compose, loader, document, history, settings, dialog
├── css/
│   ├── theme.css                  Fetch's colors, light and dark (copied unedited from the Mineski design language)
│   ├── mineski-base.css           Every shared component (copied unedited; never edit it here)
│   └── app.css                    Fetch's own parts on tokens: drop zone, loader dog, the white paper, phone bar
├── js/                            ES modules, loaded through the import map in index.html (every one is listed there)
│   ├── config.js                  ★ Everything a maintainer changes: APP.env, services, Lark app, table links, rules
│   ├── schema.js                  ★ The Lark table's columns (one list), the load-time check, what blocks a write
│   ├── app.js                     Routing and screens (incl. Next steps & Attachments cards)
│   ├── net.js                     Services (wake, status, version check, ad-blocker detection) and the Lark call
│   ├── auth.js                    Lark login (OAuth + PKCE), the session and its clock
│   ├── settings.js                Per-browser settings (Gemini key, local overrides) and cfg()
│   ├── settings-view.js           The Settings screen (a factory that takes a ctx)
│   ├── extract.js                 Talking to the Gemini proxy: file preparation, upload, wait estimate
│   ├── lark.js                    The page's Lark client: adds the token and the table, keeps the schema check
│   ├── ops.js                     Every Lark read and write (load, create, save, Done, delete), as functions of `call`
│   ├── rows.js                    Brief <-> Lark row mapping, changed cells, select values (pure)
│   ├── tables.js                  Table links, fields, records, create/update/delete (take `call`)
│   ├── verify.js                  Read-back after a write, and the re-read before an update (take `call`)
│   ├── cells.js                   Reading and comparing cell values, dates (pure)
│   ├── errors.js                  Errors as facts, `describe(err)` (one sentence), service version check (pure)
│   ├── brief.js                   Brief model: normalise, dates, Markdown, chat text (pure)
│   ├── doc.js                     Editable document renderer (click-to-edit)
│   ├── pdf.js                     PDF export (pdfmake, lazy-loaded from cdnjs)
│   ├── sources.js                 "Check sources" side panel: passages, PDF / image / text viewers (pdf.js, Tesseract.js OCR), files kept in memory
│   ├── docview.js                 "Brief files": every file in full, search, the summary's passages marked, cards back to the summary
│   ├── viewport.js                Pan-and-zoom box for one page: wheel / pinch zoom, drag, keys, fit a passage to the width
│   ├── evidence.js                Which passages belong to a field, after reorders and edits (pure)
│   ├── match.js                   Finding a quote or search phrase in a page, text or OCR words, typo-tolerant (pure)
│   ├── ui.js                      Shared helpers: toasts, menus, sheets, busy buttons, theme (copied unedited)
│   └── icons.js                   Shared inline SVG icons (copied unedited)
├── manifest.webmanifest           App name + icons for "Add to Home Screen"
├── .nojekyll                      Tells GitHub Pages to serve files as-is
├── img/
│   ├── fetch-logo.svg             Logo source (single colour, no dash lines)
│   ├── fetch-icon.svg             App icon / favicon, built from fetch-logo.svg
│   └── fetch-icon-32/180/512.png  PNG fallbacks (browser tab, iPhone home screen, app icon)
├── README.md                      ← you are here
├── project-brief-template.md      The summary template the document follows
├── package.json                   No dependencies: just the script names (`npm run serve`, `npm test`, `npm run check:shell`...)
├── .gitignore                     Keeps tools/.env (the Lark app secret) out of the repository
├── render/
│   └── gemini-pdf/                The Gemini proxy (Render web service) — see its README
├── tests/
│   ├── *.test.mjs                 Offline tests of the pure modules (incl. match.js, evidence.js) and of ops.js against a fake Lark (`npm test`)
│   ├── fake-lark.mjs              An in-memory stand-in for the Lark endpoints Fetch uses
│   ├── check-live.mjs             Read-only check of the live table (`npm run check:live`)
│   ├── check-proxy.mjs            GET / of both services: version, headers (`npm run check:proxy`)
│   ├── check-shell.mjs            Import map, shared files, watchdog, syntax, secrets (`npm run check:shell`)
│   ├── e2e.mjs                    Every write, on a TEST COPY of the table only (`npm run check:e2e`)
│   └── lark-node.mjs              Direct Lark access for those scripts (app token from tools/.env)
└── tools/
    ├── setup_lark_table.py        Creates or repairs the Lark table's columns (re-runnable, dry run by default)
    ├── export-spec.mjs            Prints the column list from js/schema.js for the setup script
    ├── serve.py                   Serves the page on 127.0.0.1:9124 with caching disabled (for testing)
    └── .env.example               Copy to tools/.env and fill in (git-ignored)
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

## Check sources

A summary rewords, merges and deduces. *Check sources* shows, for any point of
it, where in a long brief that point came from, so it can be checked against the
original in seconds.

**Where the passages come from.** In the same Gemini call that writes the
summary, the prompt (`render/gemini-pdf/prompt.md`, *# Evidence*) asks for every
value and bullet (notes included; not the TL;DR or the questions for the client)
with the 1-3 passages of the sources it was based on, copied word for word, with
the file number and PDF page. The service validates them (`normalize_evidence` in
`brief_spec.py`: known fields, real files, list items re-pointed after duplicates
are dropped, at most 80 fields and 3 passages each) and returns them as
`evidence` beside the brief, with `texts` (what it converted from Office files,
e-mails and other text). If Gemini refuses to quote (its recitation filter), the
service retries once without passages so the extraction still succeeds. The
passages add roughly 2-4k output tokens (about 5-15 seconds) to an extraction.

**Where they are kept.** `evidence` is stored with the draft (`fetch.draft`, a
few KB) and never written to Lark; the brief's own shape (schema v1) is
unchanged. The files and `texts` stay in the tab's memory only (`sources.js`
`attach`), so after a reload a passage still shows as text and **Add “file”
again** brings back the highlights. Saving the brief forgets them.

**Finding a passage in the file** (`js/match.js`). The passage is located in the
file itself: a PDF's text layer (pdf.js), the words Tesseract.js reads from a
screenshot or a scanned page, or the text. Matching ignores case, accents,
punctuation and number formatting ("3,500,000" = "3 500 000"; "22-35" stays two
numbers), joins words a PDF splits, tolerates one typo per long word (OCR), and
falls back to the closest wording, which is labelled *Closest match*. A passage
it can't find is shown as text with *Couldn't pinpoint…*, never as a wrong
highlight. A PDF is searched from the page Gemini named, then its neighbours,
then the rest; scanned pages are only read near the page Gemini named. Which
passage belongs to a field survives reordering, deleting, adding and editing
list items (`js/evidence.js` matches items to the extraction by their text).

**The side panel** (`js/sources.js`, a bottom sheet on phones and tablets). The
passages are listed as cards; the picked one is shown in its file, zoomed so it
fills the viewer's width, with the field's other passages in the same file
marked more lightly. The viewer (`js/viewport.js`) has no scroll bars: the
mouse wheel or a pinch zooms around the pointer, dragging moves the page, − / +
zoom, and with the viewer focused the arrow keys move, + / − zoom and 0 fits the
width. A PDF page is redrawn sharp at every zoom. The Save / Copy / PDF card is
hidden while checking, so the source gets the whole column.

**Brief files** (`js/docview.js`). A full-screen view over the dimmed page: a tab
per file (with how many passages the summary used from it), every PDF page
drawn as it scrolls into view, images and text in full. Every passage the
summary used is marked in yellow; clicking one opens a card with the parts of
the summary it supports (as they read now) and **Show in summary**, which closes
the view, turns on checking and opens that field. The search box (Enter / Shift+Enter
for next / previous) marks every match in blue, ignoring case, accents and
punctuation; scanned pages become searchable once they have been read.

**Libraries.** pdf.js 4.10.38 and Tesseract.js 5.1.1 are loaded from jsDelivr the
first time they're needed, pinned and checked with SRI (`LIB` in `sources.js`).
pdf.js is pre-loaded when checking starts on a brief with a PDF; Tesseract
downloads about 10 MB (engine and language data) the first time an image or
scan is read, then reads a page in a few seconds. The page's CSP allows
`https://cdn.jsdelivr.net` and `data:` in `connect-src` for them.

**Versions.** The service sends passages from 1.6.0 (one per value) and several
per value, notes included, from 1.7.0. Each entry also carries its first
passage at the top level, so pages and services of either version work
together. A draft extracted before 1.6.0 has no **Check sources** button.

---

## The Lark table

Base **AM BD Universe** → table `tblG3XcLw2auB4lM`
([open](https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblG3XcLw2auB4lM&view=vewMIKkyNv)).
The columns are listed once, in `js/schema.js`; `tools/setup_lark_table.py` creates them from that list, and the
page checks them against it on every load (see [Schema check](#schema-check)):

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
| Filed By | Text | Your Lark name (from your login), written when the brief is first saved. Never written blank. |
| Source Files | Text | Names of the uploaded files. |
| Requirement Type | Single select | RFP (Request for Proposal: pitch and propose) · RFQ (Request for Quotation: quotation only) · RFI (Request for Information: just asking, nothing to submit). Gemini detects it, and the choice is pre-selected in the **Requirement & VAT** card beside the document, with Gemini's one-line reason; the user can change it. Saved to Lark only, not in the document. |
| VAT | Multi-select (one value used) | **VAT Inc.** (prices include 12% VAT) or **VAT Ex.** (VAT-exclusive, or 0% for foreign / exempt clients). Gemini follows what the brief explicitly says first; if it says nothing, a local client means VAT Inc. and a foreign one VAT Ex. The pre-selected choice always agrees with the note shown under it. Labels: `RULES.vatChoices` in `js/config.js`. A value in Lark that isn't one of these is kept, and the card says so ("Lark has “…” here. It stays unless you pick one."). |
| Next Steps | Multi-select | Picked in the **Next steps** card beside the document (AM Assignment, File Project Brief and trigger Lark GC, PM Assignment, Pitch Deck, Other, or a custom step, which Lark adds as a new option: this is the one column where that's on purpose). Saved to Lark only, never part of the document, PDF or chat text. The default list is `RULES.nextSteps` in `js/config.js`. |
| Attachments | Attachment | The uploaded brief files (plus typed text as `Brief text.txt`), uploaded on save through the Lark proxy (Drive media API, always with the table's `bitablePerm`). The login asks only for the `bitable:app` scope; if uploads ever fail with a missing-permission message, add `drive:drive` to `LARK.scopes` in `js/config.js` and to the Lark app. Files can be added or removed in the **Attachments** card. Limit per file: `LARK.maxUploadMb` (10 MB, the Lark proxy's default `MAX_BODY_BYTES`; Lark allows up to 20 MB). Files from before a page reload must be re-added. Attachment links from Lark expire, so Fetch never keeps them. |
| Done | Single select | **Yes** or **No**. Set from the page (right-click a card, or its ⋯ button → *Mark as Done* / *Mark as Not Done*) or in Lark. **Yes** moves the brief out of the main list into the collapsed **Done** section (newest filed first). **No** or empty keeps it in the list. New rows start as **No**. |
| **Brief JSON** | Text | **The source of truth the page renders from. Don't edit it by hand.** |
| Last Modified | Modified time | Automatic. |

**Where edits belong.** The page renders each brief from `Brief JSON`; the
readable columns are copies of it. Edit content **on the page** (click the
document, then *Save changes to Lark*), which writes the JSON and **only the
readable columns that changed**. **Status**, **Due Date**, **Done**, **Next Steps**,
**Requirement Type**, **VAT** and **Attachments** belong to Lark: Fetch writes them
only when you changed them on the page. In Lark itself, edit those freely. A
readable column edited in Lark (say Venue) is not read back into the page,
because the JSON wins, and is replaced when someone changes that same cell on
the page. If a row's JSON is ever missing or broken, the page rebuilds the brief
from the readable columns instead.

**If someone changes the same cell meanwhile.** *Save changes* re-reads the row
first. If a cell you changed was changed in Lark since the page loaded it, nothing
is written and the dialog says which ("“Tranche 2” changed in Lark since you
opened it. Nothing was written. Next Steps was edited there."). **Save anyway**
then writes your version of just the cells you changed.

**Never blank, never a placeholder.** Fetch leaves empty values out of a save
(an empty Venue is not written as "Not specified", a brief without a title is not
saved as "Untitled Project"). A cell is cleared only when you emptied it on
purpose. A saved date, "Filed by" or option name is always a real one.

**Newer versions.** A brief saved by a newer version of Fetch can't be saved from an
older page ("This was saved by a newer version of Fetch. Reload the page to edit
it."), so a cached old page can't downgrade it.

**Permissions.** Fetch acts as the signed-in person, so each user needs
**edit** access to this table in Lark (add and edit records), plus permission
to **delete records** for the page's *Delete* option (otherwise deleting fails
with a permission error and nothing is removed). People who can't open the
table can't use Fetch at all. The setup script runs as the Lark app itself
(`cli_aab0716138b8ded3`) and needs permission to manage fields.

### Schema check

On every load Fetch reads the table's columns and checks each one it uses (name,
type, and the options it writes). If something doesn't match, saving, Done and
Delete are switched off, and a callout (and Settings → Connections) lists what
doesn't match in plain words ("Column “Done” is missing."), for example after a
column was renamed in Lark. A missing **optional** column (Next Steps, Attachments,
Requirement Type, VAT, Last Modified) only switches off what uses it. To fix a table,
rename the column back, or run the setup script.

### Setting up or repairing the columns

Re-running the setup is safe. It only creates what's missing (and adds missing
options to existing select columns; it never removes or renames anything):

```bash
python tools/setup_lark_table.py            # dry run: shows the plan
python tools/setup_lark_table.py --apply    # create or repair columns
```

It reads `LARK_APP_ID` and `LARK_APP_SECRET` from the environment or from
`tools/.env` (copy `tools/.env.example`; the file is git-ignored; the secret is the
Lark app's *App Secret* in the developer console) and gets an app token straight
from Lark. It needs Node 18+ to read the column list from `js/schema.js`.
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

**After updating the proxy's code** (it is at version 1.7.0), follow the deploy
checklist in [`render/gemini-pdf/README.md`](render/gemini-pdf/README.md#deploying-to-render):
proxy first, page second. In particular, set `LARK_BASE_TOKEN` and `LARK_TABLE_ID`
on the service before deploying 1.5.0 or later, or it won't start. When it is live, run
`npm run check:proxy`; after that `SERVICES.gemini.min` in `js/config.js` can be
raised (it is `1.4.0`; *Check sources* needs 1.6.0, and shows one passage per value
until 1.7.0, but nothing breaks on an older service: the button just doesn't appear).

### 2. Point the page at it

`js/config.js` already points at the deployed services (`SERVICES`):

```js
lark:   { url: "https://lark-proxy-dwiw.onrender.com", service: "lark-cors-proxy", min: "", ... },
gemini: { url: "https://gemini-pdf-6wp4.onrender.com", service: "gemini-brief-proxy", min: "1.4.0", ... },
```

These are the same for everyone. **Settings → Advanced** (local copies only,
on `127.0.0.1`) can point a developer's browser elsewhere; a hosted page always
uses these, because the Lark proxy receives people's login tokens. The page checks
each service's `GET /` on every wake: if the version is below `min`, or the
service doesn't allow a header the page sends, Settings says "Out of date (v1.3.0,
needs 1.4.0). Ask the admin to redeploy it." and only extraction is switched off.
The Lark table is one link per environment (`TABLES.live`, `TABLES.test`); `APP.env`
picks which. There is no cache to bust after an
update: the page loads its styles and modules under a fresh URL every time it
opens (`APP_BUILD` and the import map in `index.html`; list every new `js/` file
there, `npm run check:shell` fails if one is missing), so users always get the latest files.

### 3. Host the page (GitHub Pages)

Before the first login from the new address, add it to the Lark app's
**Redirect URLs** (see [Lark login](#lark-login)).

The website is the files in the project root: `index.html`, `css/`, `js/`,
`manifest.webmanifest`, `.nojekyll` and `img/`. They're plain
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

The page is built from ES modules, so it must be served over http(s) (or
`http://127.0.0.1`): opened straight from disk it shows *Fetch couldn't start*.

### 4. Lock it down (recommended)

On the Gemini proxy, set `ALLOWED_ORIGINS` to the page's origin. For GitHub
Pages that is `https://<user>.github.io`, with no repo path, because an origin
is scheme + host only. The Lark proxy has its own `ALLOWED_ORIGIN`
variable (see `tech/lark-proxy/README.md`).

---

## Using it (for the BD team)

0. **Log in with Lark** and approve on Lark's page. Your Lark name is used as
   *Filed by*. If a yellow *Setup needed* bar appears, click it and paste your
   Gemini API key in **Settings** (free from
   [Google AI Studio](https://aistudio.google.com/apikey)).
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
   **Check sources** (above the document) pauses editing and underlines every
   value and bullet Gemini can point back to. Click one to see the passages of
   the brief it was based on, even when the summary words it differently or
   combines several of them (up to three, e.g. two sentences on different
   pages). The source opens zoomed so the passage fills the viewer; **scroll
   to zoom, drag to move**, or use − / +. Pick another passage to jump to it.
   A dimmed value has no passage: it's a default, or you added it. Click
   **Done checking** (or press Esc) to edit again.
   **Brief files** (next to it) opens the whole brief over the page: every
   file in full, a search box, and every passage the summary used marked in
   yellow. Click one to see which parts of the summary it became, and **Show
   in summary** to jump there. Both work on a new brief until you save it;
   filed briefs are assumed checked. More in [Check sources](#check-sources).
4. **Copy for group chat** → paste it in the chat. **Download PDF** for a file.
5. **Save to Lark Base** → check the summary → **Save to Lark**. You land on
   **All briefs**, with your new brief highlighted.
6. Later, open **All briefs**, search or sort by due date, click a card to
   reopen it, edit, and **Save changes to Lark**.
7. When a brief is finished, right-click its card (or click ⋯) → **Mark as
   Done**. It moves to the collapsed **Done** section under the list; open that
   section and choose **Mark as Not Done** to bring it back. An **Undo** link
   appears for a few seconds after either change.
8. **Delete…** in the same menu removes the brief (row, attachments and all)
   from Lark permanently. It asks twice: once with the brief's details, then
   *Are you absolutely sure?*. There's no undo; mark it Done instead if you
   might need it again.

If you close the tab before saving, the page offers to **resume** your
unsaved brief next time.

---

## Settings

The gear at the end of the top bar's menu opens **Settings**. Everything there is saved in
the current browser only.

| Setting | What it does |
| ------- | ------------ |
| **Account** | Your Lark name and picture, how long the login has left, **Log in again** (a fresh 2 hours) and **Log out**. Settings is the one screen that opens without logging in. |
| **Appearance** | System (follows the computer), Light or Dark (arrow keys move between them). Saved per browser under `fetch.theme` and applied before the page draws, so there's no flash. |
| **Gemini API key** | Your own key from [Google AI Studio](https://aistudio.google.com/apikey). It's sent to the extraction service with each brief (`X-Gemini-Api-Key` header), used once, and never stored there. **Required** when the service has no shared key; the status pill shows *Key needed*, *Using the shared key* or *Using your key*. **Save key** also checks it with Google and shows which Flash-Lite model you'll get; **Test key** re-checks it. |
| **Connections** | Live status of the extraction service and the connection service (the Lark proxy): *Awake · v1.5.0* / *Waking up…* / *Unreachable (no answer for 3 minutes)* / *Blocked by an ad blocker…* / *Out of date (v1.3.0, needs 1.4.0). Ask the admin to redeploy it.*; and Lark Base (*Connected · N briefs*) with any table problems listed. **Wake up** and **Refresh** buttons. |
| **Advanced: service addresses** | Only on `127.0.0.1`. Override the extraction service URL, the Lark proxy URL (https, or http on this computer), or the Lark table (paste the table's link; a wiki link is refused). Empty = the defaults in `js/config.js`. While any override is active a red **Override** badge shows in the top bar. |
| **This browser** | Clears the unsaved draft and the cached briefs list (keeps your key, theme and login). One click; **Undo** in the toast puts them back. |

Everything Fetch keeps in the browser uses `fetch.*` keys: in `localStorage`
`fetch.settings` (JSON), `fetch.theme`, `fetch.draft` (with its `client_token`),
`fetch.etaFactor` and `fetch.cache.<app>:<table>` (the list of briefs, without
attachment links); in `sessionStorage` the login (`fetch.auth.token`, `.pending`,
`.user`), `fetch.composeText`, `fetch.edits` (unsaved edits, only while you are at
Lark's login page) and `fetch.override.*`. The cached list is dropped whenever a
session ends (not only on Log out), because shared computers outlive a login.
Older versions used `bx.*`; a small script at the top of `index.html` moves
those once (and drops the old `fetch.briefsCache`), and can be removed after
January 2027. The header also shows a **Test copy** badge when `APP.env` isn't `live`.

The *Setup needed* bar on the landing page, and any key-related error in the
loader, link straight to the key field (`#/settings/key`).

---

## Local development

```bash
# 1. Gemini proxy on :8000 (needs a key; the Lark ids are required unless login is off)
cd render/gemini-pdf
REQUIRE_LARK_LOGIN=false GEMINI_API_KEY=your-key python gemini_proxy.py

# 2. Static page on 127.0.0.1:9124 (Fetch's port)
cd ../..
npm run serve                      # = python tools/serve.py 9124, with caching disabled
```

Open `http://127.0.0.1:9124/` and log in. **That address must be a Redirect URL on
the Lark app** (the app owner adds `http://127.0.0.1:9124/` under *Security Settings →
Redirect URLs*; see [Lark login](#lark-login)). Use `127.0.0.1`, never `localhost`. For a
local extraction service open `http://127.0.0.1:9124/?gemini=http://127.0.0.1:8000`. The
`?gemini=` and `?lark=` overrides (https, or http on this computer) are remembered for
the tab session (`?reset` clears them) and only work on a local page; a red
**Override** badge shows while any is active. `.claude/launch.json` defines the same
static server for Claude Code's preview. Ports: 9123 Polaris, 9124 Fetch, 8000 the Gemini
proxy locally, 8001 the Lark proxy locally.

---

## Testing

```bash
npm test                 # offline: brief, rows, schema, errors, match, evidence, and ops.js against a fake Lark
npm run check:shell      # import map lists every js/*.js, shared files unedited, watchdog, syntax, no secrets
npm run check:proxy      # GET / on both hosted services: version >= min, headers allowed (read-only)
npm run check:live       # read-only against the live table: columns, and every payload the page would write
npm run check:e2e        # every write, on a TEST COPY of the table only (see below)
npm run test:proxy       # the Gemini proxy's own unit tests (offline, Gemini mocked)
```

*Check sources* has no automated browser test: check it by hand on a local page
(`npm run serve`, log in, extract a real brief) with a text PDF, a scanned PDF, a
screenshot, a Word file and typed text. `npm test` covers the matching
(`tests/match.test.mjs`) and which passages belong to a field after edits
(`tests/evidence.test.mjs`); `npm run test:proxy` covers the service side
(validation, re-pointing list items, the recitation retry).

`check:live` and `check:e2e` need `LARK_APP_ID` and `LARK_APP_SECRET` in
`tools/.env` (or the environment); they get an app token straight from Lark, and the Lark
app must be able to open the table. `check:live` writes nothing.

`check:e2e` refuses to run unless `APP.env` is `"test"` in `js/config.js` and
`TABLES.test.briefs` holds a link. **There is no test copy yet.** To make one:
duplicate the briefs table in Lark (with its records), give the Lark app edit access
to it, paste its link into `TABLES.test.briefs`, and in a working copy set `APP.env`
to `"test"` (the page then shows a **Test copy** badge and uses that table). It creates
one row, saves an edit, marks it Done, deletes it, and checks that only the intended cells
changed and every other row is untouched.

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
  prefetches the briefs list, so *All briefs* is populated instantly. Reads are
  retried while a service wakes (about 3 minutes); writes never are.
- **Resilient to Gemini outages.** Retry, model fallback, a cooldown for
  overloaded models, and one automatic client retry with a visible countdown.
- **Safe writes.** A new row is created once (each draft carries a
  `client_token`, saved with the draft, so a retried save can't add a duplicate).
  An update re-reads the row, writes only the cells that changed, refuses if one of
  them changed in Lark meanwhile, and reads the row back. A write is never retried by
  the page, and is never reported as "nothing was written" unless Lark answered with an
  error: after a timeout or a dropped connection it says "Fetch couldn't confirm the
  save. Refresh before trying again." and the list is re-read first.
- **One list of columns** (`js/schema.js`), checked against the live table on every
  load, used by the setup script and by `check:live`. Select values are written with
  Lark's own option names (`matchOption`), so a write can't create an option by accident.
- **Pure where it can be.** `brief.js`, `rows.js`, `cells.js`, `schema.js` and
  `errors.js` have no DOM and no network, so Node tests cover them; `ops.js`,
  `tables.js` and `verify.js` take a `call` function, so the same code runs in the page
  (with the user's token) and in the Node checks (with an app token).
- **Honest errors.** Network code throws facts; `describe(err)` turns them into one
  sentence at display time (a code table in `js/errors.js`, tested so every code has a message).
- **Stateless and cheap.** Both proxies are stdlib-only Python containers with
  no database. Lark is the database.
- **Sources from the same call, found by the page.** Gemini names the passages
  it used while it writes the summary (no second call, no second upload), copied
  word for word; the page then finds them in the user's own file. Gemini is never
  trusted for positions, so a passage it misquotes is labelled, not misplaced.
- **Files stay in the tab.** Check sources needs the files, but keeping client
  documents in browser storage on a shared origin isn't worth it: they live in
  memory until the brief is saved or the tab closes; the passages themselves (a few
  KB of text) survive a reload with the draft.

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
- **Brand**: Fetch follows the Mineski design language (`design-ref/mineski-design-language`),
  shared with Polaris: the same buttons, fields, cards, badges, toasts, sheets,
  menus, focus rings and motion, from the unedited `css/mineski-base.css`,
  `js/ui.js` and `js/icons.js`. Fetch's own dials are the Fetch logo (a dog
  fetching a letter), Mineski yellow (`#FFC800`) with near-black ink, warm
  neutrals with one subtle background glow and Plus Jakarta Sans
  (`css/theme.css`). Its own parts are the drop zone, the running dog, the
  always-white paper (its colors are the `--p-*` tokens in `css/app.css`, in
  step with `js/pdf.js`) and the phone bottom action bar. Light and dark
  themes; motion respects *reduce motion* (spinners keep turning slowly, the
  dog is hidden).

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
- **Access**: everything except Settings needs a Lark login, and Lark
  enforces each person's own permissions on the Base. The extraction service
  checks the login itself, so the shared Gemini key can't be used by someone
  who merely finds its URL. See [Lark login](#lark-login).
- **Login tokens** stay in the tab's `sessionStorage` (so **each tab logs in on its
  own**, one click if Lark's own session exists) and are sent only to
  the Lark proxy and the extraction service, both over HTTPS. PKCE and the
  `state` check protect the login callback, and `?code=` is removed from the
  address bar before anything else happens. Service-address overrides only work on
  a local page, so a hosted page can't be pointed at a proxy that collects tokens.
  `index.html` also carries a referrer policy and a Content-Security-Policy whose
  `connect-src` lists only the page itself, the two services, Google (to test a key), jsDelivr
  (the *Check sources* viewer's fonts, character maps and OCR data; nothing is sent there),
  `data:` and this computer (for the test addresses); this alone stops a token being sent anywhere else.
- **Check sources keeps files in memory only.** The quotes travel with the draft
  (`fetch.draft`, a few KB); the files and their converted text stay in the tab's
  memory and are gone on reload or save. Nothing about them is stored in Lark.
- **Log out is local.** Lark has no way to revoke a token, so *Log out* forgets it
  (and the cached briefs) in this browser only. The token stays valid until it expires (about 2 hours).
- **The cached list of briefs** (`fetch.cache.<app>:<table>`) lets the page paint at
  once. It holds no attachment links, is never the basis for a write (a save re-reads the
  row), and is dropped whenever a session ends.
- **Same origin, same storage.** Per-tool key prefixes keep keys apart but aren't isolation:
  every page on one `github.io` origin can read them. Host Fetch on an address that
  serves nothing else (a custom domain or a dedicated account).
- **Lark proxy (not in this repository).** Its `GET /token` endpoint, and its
  `tenant_access_token` forwarding, still hand out an **app** token to anyone who asks.
  That token can read and write the Base without any login, so it's the remaining way
  around Fetch's login. Fetch no longer uses it: `tools/setup_lark_table.py`,
  `tests/check-live.mjs` and `tests/e2e.mjs` get their app token directly from Lark with the
  secret in the git-ignored `tools/.env`. The proxy's owner can now remove `/token`
  (the proxy should add the app secret only to `/authen/v2/oauth/token`), and set its
  `ALLOWED_ORIGIN` (see `tech/lark-proxy/README.md`).
- **Abuse limits** on the Gemini proxy: the login check, an origin
  allow-list, a per-user hourly rate limit, a concurrency cap and an upload cap.

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
- **Check sources** shows the passages Gemini says it used, then finds each in
  the file. A slightly misquoted passage is highlighted as a "closest match"; one
  it can't find says so rather than guessing. Scanned PDFs and screenshots are read with OCR in the
  browser (a ~10 MB download the first time, a few seconds per page; only the
  pages Gemini named are read). The passages add roughly 2-4k output tokens
  to each extraction (about 5-15 seconds, depending on the brief's length).
- **Legacy formats** (`.doc`, `.ppt`, `.xls`, Outlook `.msg`) must be saved
  as PDF or a modern Office format first; the page tells the user how.
- **History is rendered from JSON**: see [The Lark table](#the-lark-table)
  for which Lark edits are reflected.

---

## Troubleshooting

| You see | What to do |
| ------- | ---------- |
| A yellow bar: "**Setup needed:** add your Gemini API key to start extracting briefs." | The extraction service has no shared key and you haven't added yours. Click the bar and paste your key in Settings. |
| No **Check sources** button | The brief was extracted by a service older than 1.6.0, or it's a filed brief (the button is for new drafts only). |
| Brief files: "Add “file” again" | The page was reloaded since the extraction, so the file isn't in memory any more. Add the same file (same name) and it opens. |
| The source viewer moves or zooms instead of scrolling the panel | That's the viewer: the wheel zooms and dragging moves the page. Scroll the panel with the wheel outside the grey viewer, or with its scroll bar. |
| Check sources shows only one passage per value | The extraction service is 1.6.0. Deploy 1.7.0 (`render/gemini-pdf`) for several passages per value, and for notes. |
| Check sources: "Couldn't load the document viewer" | The page couldn't reach `cdn.jsdelivr.net` (offline, or a blocker). Allow it and click the field again; the quote itself always shows. |
| Check sources: "Couldn't pinpoint this passage in the document" | Gemini's quote isn't word-for-word in the file (or is in an image inside a Word file or e-mail). Read the quote and check that part of the brief yourself. |
| "Your Gemini key needs attention" | Google rejected your key. Re-copy it from Google AI Studio into Settings and click **Test key**. |
| "Gemini usage limit reached" | Your key hit its free-tier limit. Wait a bit, or use another key. |
| "Gemini is overloaded right now. Please try again in a minute." | Temporary Gemini capacity issue. The page retries once on its own ("Retrying automatically in 20s…"); try again in a minute. |
| A red bar: "**Fetch can't reach its connection service.** An ad blocker or privacy extension is probably blocking it." (or "Your browser is blocking …, probably an ad blocker or privacy extension.") | An ad blocker or privacy extension is blocking the host named in the bar. Allow it (or pause the blocker on this page), then reload. Fetch pings each service's `/`, not `/health`, because filter lists such as uBlock Origin's block `onrender.com/health`. If something else is blocked, the blocker's request log shows the rule. |
| "Fetch can't reach its connection service (lark-proxy-dwiw.onrender.com). It may still be waking up; try again in a moment." | The Lark proxy is asleep or unreachable. Wait a moment and try again. Settings → Connections shows its state and has **Wake up**. |
| "Fetch can't reach its extraction service (…). It may still be waking up; try again in a moment." | Same, for the extraction service. If it keeps happening, check the address under Settings → Advanced. |
| "Waking up the connection… It sleeps when nobody's using it. This can take up to a minute." / "Waking up the extraction service…" | A free Render service is starting (up to a minute after ~15 idle minutes). Normal; the page continues by itself. |
| Settings → Connections: "Unreachable (no answer for 3 minutes)" | The page tried for 3 minutes. Open the service's address in a browser (it should show JSON with its `service` name), then **Wake up**. For the extraction service check the address under Settings → Advanced. |
| Settings → Connections: "Out of date (v1.3.0, needs 1.4.0). Ask the admin to redeploy it." | The service is older than this page needs, or its CORS rules lack a header the page sends. Redeploy it on Render ([deploy checklist](render/gemini-pdf/README.md#deploying-to-render)); extraction is off until then. |
| "A user key fails with a network error right after an update" (or "Out of date" above) | The extraction service still runs an old version. Redeploy it on Render. |
| "Setup needed" even though a shared key is set on Render | The service doesn't see the key. Check `shared_key` at the service's root URL, then save the variable with **Save, rebuild, and deploy**. |
| A red **Override** badge in the top bar | A test address or table is active (Settings → Advanced, or a `?gemini=` / `?lark=` link). Hover for what. Clear it in Settings, or open the page with `?reset`. |
| A **Test copy** badge next to the name | `APP.env` is `"test"`: Fetch is using the test copy of the table. Set it back to `"live"`. |
| Login screen: "This address (…) isn't registered on the Lark app, so login would stop on a Lark error page." (or Lark's page shows error **20029**) | Add exactly that address (with the trailing `/`, `127.0.0.1` not `localhost` for local use) under *Security Settings → Redirect URLs* on the Lark app, then reload. |
| "Your Lark account isn't allowed to use this app yet. Ask the app admin to add you." (20010) | Add the person to the Lark app's availability range (*Version Management & Release → Availability*). |
| "That login started in another tab. Log in again here." / "The login check failed, probably because it started in another tab. Log in again here." | Log in again from the tab you're using. |
| "That login code expired or was already used. Log in again." / "That login took too long. Log in again." | Log in again. A login must finish within 10 minutes of leaving Fetch. |
| "The connection service couldn't complete the login. Try again; if it keeps happening, tell the admin." | The Lark proxy had a problem. Try again; if it persists, check the proxy (it must add the app secret on `/authen/v2/oauth/token`). |
| "Your login is missing a permission Fetch needs (…). Log out, then log in again." | The Lark app's scopes changed after you logged in. Log out, then log in. |
| "Your login ended after about 2 hours. Log in again to keep going." | Logins last about 2 hours. Log in again; the draft, typed text and unsaved edits are kept. |
| "Your login ends at 4:30 PM." (stays on screen) | Click **Log in again** before it ends, or finish what you're doing; nothing is lost either way. |
| "Your login is about to end, so this wasn't sent." | Less than a minute (2 for an extraction) of login left. **Log in again**, then try it. |
| "Your login can only read the tables. Log in again to allow saving." | The login lacks the `bitable:app` scope. Log in again. |
| "Your account doesn't have access" when extracting (`not_authorized`) | The person can't open the briefs table in Lark. Share the Base with them (edit access), then they log in again. |
| "Lark says your account can't open or edit this Base. Ask its owner for edit access." / "Your account isn't allowed to change this table (its permissions are restricted). Ask the Base owner." | Give the person edit access to the briefs table in Lark. |
| "Your account isn't allowed to delete rows. Mark it Done instead." | Give the person permission to delete records on the table, or mark the brief Done. |
| A yellow callout: "**Saving is switched off.** The briefs table doesn't match what Fetch expects. Tell the tool owner." with "Column “Done” is missing." (or "“Done” has no option “Yes”.", "Column “Due Date” is Text, expected Date.") | A column was renamed, deleted or retyped in Lark. Rename it back, or run `python tools/setup_lark_table.py --apply`, then Refresh in Settings. Saving, Done and Delete come back on their own. |
| "Some actions are switched off." with "Column “Attachments” is missing." | An optional column is gone. Only what uses it is off. Restore it, or run the setup script. |
| "A column Fetch needs doesn't exist: …. Tell the tool owner." | Same as above, reported by Lark when a write names a missing column. |
| "“…” changed in Lark since you opened it. Nothing was written." with the cell names, and the button reads **Save anyway** | Someone changed those cells in Lark meanwhile. The list has refreshed. Choose **Save anyway** to write your version of just the cells you changed, or close the dialog and reopen the brief to see theirs. |
| "Fetch couldn't confirm the save. Refresh before trying again." | The connection dropped or timed out after the save was sent, so Fetch can't know whether it landed. The list re-reads from Lark; check there before saving again (a new brief can safely be retried: it uses the same `client_token`). |
| "Nothing was written. …" | Lark answered with an error (the sentence after it says which); the table is unchanged. |
| A warning: "Check these in Lark: Venue: sent “…”, Lark has “…”" | The save worked, but Lark holds a cell differently from what Fetch sent. **Open in Lark** and check it. |
| A warning: "Saved, but Fetch couldn't read it back to check it." | The save worked; only the check failed. Refresh the list to see the row. |
| "These files didn't upload, so nothing was saved: …" with **Try again** and **Save without these files** | An upload failed or a file is over the size limit. Try again, or save the brief without those files (they're listed in the message). |
| "This was saved by a newer version of Fetch. Reload the page to edit it." | Your page is older than the data. Reload (hard reload if needed) and open the brief again. |
| "Lark has “…” here. It stays unless you pick one." under Requirement or VAT | The Lark cell holds an option Fetch doesn't offer. It is kept on save unless you pick another. |
| "Fetch has no briefs table set for this environment. Tell the tool owner." | `TABLES.test.briefs` in `js/config.js` is empty while `APP.env` is `"test"`. |
| "That row isn't in Lark any more. The list refreshed." | Someone deleted the brief in Lark. |
| "Lark is getting too many requests. Wait a moment and try again." | Lark's rate limit. Wait a moment and try again. |
| A file is rejected | The message says why: e.g. an old `.doc`/`.ppt` (save as PDF), a ZIP (unzip it), or over 50 MB in total. |
| Users see an old version after an update | Only `index.html` itself could be stale (scripts and styles always load fresh). Reload the page; hosts normally revalidate HTML on every visit. |
| "Fetch couldn't start. Reload the page. If it keeps happening, open it from its web address (not a saved file)." | A module failed to load (a flaky connection or a half-finished deploy), or the page was opened from a file. Reload; open it from its web address. After a deploy, `npm run check:shell` catches a module missing from the import map. |

---
## Maintenance recipes

**Tune the wording or rules**: edit `render/gemini-pdf/prompt.md` and redeploy
the proxy. No page changes needed. The *# Evidence* section there decides what
*Check sources* gets; `MAX_EVIDENCE` and `MAX_PASSAGES` in `brief_spec.py` cap it
(fewer passages make extractions faster).

**Add a field** (e.g. "Competitors"):

1. `render/gemini-pdf/brief_spec.py`: add it to `RESPONSE_SCHEMA` and
   `normalize()`; describe it in `prompt.md`.
2. `js/brief.js`: add it to `normalize()`, `toMarkdown()` and the chat text.
3. `js/doc.js`: render it (use `ed()` for text or `listBlock()` for a list).
4. `js/pdf.js`: add it to `build()`.
5. `js/schema.js` → `COLUMNS` (name, type, options), then `js/rows.js` (`briefCells()`
   and `fromRecord()`); `npm test` shows what moved. Run `python tools/setup_lark_table.py --apply`
   to create the column (it reads the list from `schema.js`).
6. For *Check sources*: add its path to `EVIDENCE_SCALARS` or `EVIDENCE_LISTS` in
   `brief_spec.py` and to the field list under *# Evidence* in `prompt.md`, and a
   label to `LABELS` in `js/sources.js` (lists also go in `LISTS` in `js/evidence.js`
   and `EV_LISTS` in `js/app.js`).

**Rename a Lark column**: rename it in `js/schema.js` (`COLUMNS`) and in Lark at the
same time. Until both match, Fetch switches saving off and the callout says
"Column “…” is missing." (a rename in Lark alone does exactly that, on purpose).

**Move to a different table, or add a test copy**: paste the table's link into
`TABLES.live.briefs` (or `TABLES.test.briefs`) in `js/config.js`, exactly as copied from
Lark's address bar (a `/base/` link with `?table=tbl…`; a wiki link is refused). The app token,
table id and "Open in Lark" link all come from it. Give the Lark app access, then
run `python tools/setup_lark_table.py --apply`. The extraction service also
checks the table (`LARK_BASE_TOKEN` and `LARK_TABLE_ID` in Render's environment): change those too.

**Add a Next Steps choice**: `RULES.nextSteps` in `js/config.js` (and the option in Lark, or
run the setup script, which adds missing options).

**Raise the extraction service's required version**: deploy the service first, run
`npm run check:proxy`, then raise `SERVICES.gemini.min` in `js/config.js`.

**Move a service to another host**: change its `url` in `js/config.js` and add the host to
`connect-src` in the Content-Security-Policy `<meta>` in `index.html`, or the browser blocks the page's
requests to it (a test address on `127.0.0.1` is already allowed).

**Add a page module**: list it in the import map in `index.html`; `npm run check:shell` fails if you forget.
