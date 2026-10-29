/*
 * Fetch: everything a maintainer may change. No secrets: the site is public.
 *
 * Each person can override the service addresses, the Lark table and their own
 * Gemini API key on the page's Settings screen (saved in their browser only;
 * addresses and the table only on a local page). For local testing you can also
 * override the two service URLs per tab:
 *   http://127.0.0.1:9124/?gemini=http://127.0.0.1:8000&lark=http://127.0.0.1:8001
 * (local page only; add ?reset to clear them). Every active override shows a red
 * badge in the top bar.
 *
 * On every load the page re-checks each Lark column it uses (name, type, select
 * options) and switches saving off if one doesn't match, so a renamed column
 * fails loudly instead of writing bad data. The column list lives in schema.js.
 */
/* version: bump it with every release and add an entry to CHANGELOG.md (newest first, same number).
   The top bar shows it beside the name, so people can see at a glance which version they're running. */
export const APP = { name: "Fetch", key: "fetch", version: "1.3.0", env: "live",   // env: "live" | "test"
  // Where the page is hosted. Sharing links (and the "Fetch URL" column) always point here, even
  // when they're made from a local copy, so a link in Lark works for everyone.
  url: "https://mineski-stephen.github.io/fetch/" };
export const ENV_LABEL = APP.env === "test" ? "Test copy" : "";    // display only, never a gate

export const SERVICES = {   // hosted defaults; `min` and `headers` are checked on every wake
  lark: { url: "https://lark-proxy-dwiw.onrender.com", service: "lark-cors-proxy", min: "", headers: ["Authorization"] },
  gemini: { url: "https://gemini-pdf-6wp4.onrender.com", service: "gemini-brief-proxy", min: "1.4.0",
            headers: ["Authorization", "X-Gemini-Api-Key"] },
};

// Same Lark app as Polaris; the Lark proxy holds its secret. Every address Fetch is
// served from must be a Redirect URL on this app (http://127.0.0.1:9124/ for local use).
export const LARK = {
  appId: "cli_aab0716138b8ded3",
  scopes: "bitable:app",
  api: "https://open.larksuite.com/open-apis",
  authorize: "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
  tzOffsetMinutes: 480,   // date-only cells are midnight in the Base's zone (Asia/Singapore, UTC+8)
  maxUploadMb: 10,        // largest file attached to a row; the Lark proxy's MAX_BODY_BYTES
};

// One Lark link per table, exactly as copied from the address bar. Only people who can
// open this table can use Fetch (the extraction service checks it too).
export const TABLES = {
  live: { briefs: "https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblG3XcLw2auB4lM&view=vewMIKkyNv" },
  // A copy of the briefs table for trying things out and for tests/e2e.mjs. Make it
  // (Lark > the table's menu > Duplicate, with its records), then paste its link here.
  test: { briefs: "" },
};

export const RULES = {
  // "Status" choices; a new brief starts as "New". Lark owns the column after that.
  statuses: ["New", "In Progress", "Submitted", "Won", "Lost", "Declined"],
  newStatus: "New",

  // "Next Steps" multi-select choices (same as the Lark column). Choices used on other
  // briefs, or typed by people, are offered too; new ones are added to Lark on save.
  nextSteps: ["AM Assignment", "File Project Brief and trigger Lark GC", "PM Assignment", "Pitch Deck", "Other"],

  // "Requirement Type" and "VAT" choices, written to Lark exactly as named in those columns.
  requirementTypes: {
    RFP: { label: "RFP (Request for Proposal)", hint: "Pitch and propose" },
    RFQ: { label: "RFQ (Request for Quotation)", hint: "Quotation only" },
    RFI: { label: "RFI (Request for Information)", hint: "Just asking, nothing to submit" },
  },
  vatChoices: {
    YES: { label: "VAT Inc.", hint: "Prices include 12% VAT" },
    NO: { label: "VAT Ex.", hint: "VAT-exclusive or 0% VAT" },
  },

  // Fallback upload limits for the extraction service; the page reads the real ones from
  // the service's GET / once it answers (render/gemini-pdf MAX_UPLOAD_MB / MAX_FILES).
  maxUploadMb: 50,
  maxFiles: 10,
};

/** The table links in force for this environment ("" for a test copy that isn't set up yet). */
export const tableLinks = (env = APP.env) => ({ ...(TABLES[env] || {}) });
