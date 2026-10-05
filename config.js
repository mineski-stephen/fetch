/*
 * Fetch - default settings for everyone who opens the page.
 *
 * Each user can override the service addresses, the Lark table and their own
 * Gemini API key on the page's Settings screen (saved in their browser only).
 * For local testing you can also override the two service URLs per tab:
 *   index.html?gemini=http://localhost:8000&lark=http://localhost:8001
 * (localhost only; add ?reset to clear them).
 */
window.BRIEF_CONFIG = {
  // Render service hosting render/gemini-pdf (no trailing slash).
  GEMINI_PROXY_URL: "https://gemini-pdf-6wp4.onrender.com",

  // Render service hosting the Lark CORS proxy (tech/lark-proxy).
  LARK_PROXY_URL: "https://lark-proxy-dwiw.onrender.com",

  // Lark Base that stores every filed brief.
  LARK_API_BASE: "https://open.larksuite.com/open-apis",
  LARK_APP_TOKEN: "NP7TbjwHNaTyLOsWafelN9wNgEd",
  LARK_TABLE_ID: "tblG3XcLw2auB4lM",
  LARK_TABLE_URL:
    "https://mineskiglobal.sg.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblG3XcLw2auB4lM&view=vewMIKkyNv",
  // The Base's time zone (Asia/Singapore = UTC+8), used for date columns.
  LARK_TZ_OFFSET_MINUTES: 480,

  // "Next Steps" multi-select choices (same as the Lark column). Choices used on
  // other briefs, or typed by users, are offered too; new ones are added to Lark on save.
  NEXT_STEP_OPTIONS: ["AM Assignment", "File Project Brief and trigger Lark GC", "PM Assignment", "Pitch Deck", "Other"],

  // "Requirement Type" and "VAT" choices, written to Lark exactly as named in those columns.
  REQUIREMENT_TYPES: {
    RFP: { label: "RFP (Request for Proposal)", hint: "Pitch and propose" },
    RFQ: { label: "RFQ (Request for Quotation)", hint: "Quotation only" },
    RFI: { label: "RFI (Request for Information)", hint: "Just asking, nothing to submit" },
  },
  VAT_CHOICES: {
    YES: { label: "VAT Inc.", hint: "Prices include 12% VAT" },
    NO: { label: "VAT Ex.", hint: "VAT-exclusive or 0% VAT" },
  },

  // Largest file attached to the Lark row. The Lark proxy rejects request bodies
  // over 10 MB by default (its MAX_BODY_BYTES); Lark itself allows up to 20 MB.
  LARK_ATTACH_MAX_MB: 10,

  // Upload limits - keep in sync with the proxy's MAX_UPLOAD_MB / MAX_FILES.
  MAX_UPLOAD_MB: 50,
  MAX_FILES: 10,
};
