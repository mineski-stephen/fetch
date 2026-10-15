/* Makes tests/preview-fixture.json: SYNTHETIC data for preview mode (http://127.0.0.1:9124/?preview).
   Made-up clients and briefs, rows shaped exactly as Lark returns them (built with the page's own
   row mapping), and a canned extraction. There is no real data in it, so it is committed.
   Run: npm run preview:fixture */

import { writeFileSync } from "node:fs";
import { RULES, SERVICES } from "../js/config.js";
import { newRowCells, toFields } from "../js/rows.js";
import { optionsOf } from "../js/schema.js";
import { fakeLark, liveFields } from "./fake-lark.mjs";

const fields = liveFields();
const options = optionsOf(fields);
const lark = fakeLark({ fields });

const brief = (o) => ({
  schema_version: 1, date_filed: "2026-01-01", due_date: { date: "", note: "" }, client_name: "", project_title: "",
  event_period: "", key_dates: [], venue: "", objectives: [], target_audience: [], kpis: [], scope_of_work: [],
  budget: { amount: "", type: "NOT SPECIFIED" }, proposal_submission: { type: "NOT SPECIFIED", details: "" },
  requirement: { type: "", reason: "" }, vat: { applies: "", reason: "" }, notes: [], clarifications: [],
  show_clarifications: false, summary: "", extraction_warnings: [], ...o,
});

const BRIEFS = [
  { due: 3, filed: 2, status: "New", next: ["AM Assignment"], req: "RFP", vat: "NO", by: "Sample Person", model: brief({
    client_name: "Acme Soda Co.", project_title: "Summer Splash Roadshow", event_period: "Mar 14-16, 2027",
    key_dates: [{ date: "2027-03-01", label: "Venue walkthrough" }], venue: "Sample Mall Atrium",
    objectives: ["Introduce the new citrus line", "Sample 20,000 cups across three days"],
    target_audience: ["Students and young professionals, 18-30"], kpis: ["20,000 samples", "5,000 social posts"],
    scope_of_work: [{ item: "Booth", detail: "Design, build and staff three booths" }, { item: "Content", detail: "Daily recap videos" }],
    budget: { amount: "PHP 1,800,000", type: "ALL-IN" }, proposal_submission: { type: "PITCH / PRESENTATION", details: "Deck and budget by the due date" },
    requirement: { type: "RFP", reason: "The brief asks for a proposal and a budget." }, vat: { applies: "NO", reason: "Prices are exclusive of VAT." },
    due_date: { date: "", note: "5:00 PM via email" }, notes: ["Venue is not confirmed yet"], summary: "A three-day sampling roadshow for a new soda flavour.",
  }) },
  { due: 12, filed: 6, status: "In Progress", next: ["PM Assignment", "Pitch Deck"], req: "RFQ", vat: "YES", by: "Sample Person", model: brief({
    client_name: "Northwind Bank", project_title: "Branch Anniversary Gala", event_period: "Jun 20, 2027", venue: "Sample Grand Ballroom",
    objectives: ["Thank long-time clients"], kpis: ["300 guests"], scope_of_work: [{ item: "", detail: "Full event production" }],
    budget: { amount: "To be confirmed", type: "TO BE CONFIRMED" }, proposal_submission: { type: "PAPER PASS ONLY", details: "Quotation only" },
    requirement: { type: "RFQ", reason: "Only a quotation is asked for." }, vat: { applies: "YES", reason: "Prices are inclusive of VAT." },
    summary: "An anniversary dinner for 300 guests.",
  }) },
  { due: -2, filed: 20, status: "Submitted", next: [], req: "", vat: "", by: "Another Sample", model: brief({
    client_name: "Contoso Telecom", project_title: "Esports Campus Cup", event_period: "Nov 2026", venue: "Various campuses",
    objectives: ["Grow the student base"], budget: { amount: "PHP 3,500,000", type: "BASELINE / BALLPARK" },
    proposal_submission: { type: "PITCH / PRESENTATION", details: "Pitch on the due date" }, summary: "A campus esports league.",
  }) },
  { due: null, filed: 45, status: "Won", done: true, next: ["File Project Brief and trigger Lark GC"], req: "RFP", vat: "NO", by: "Sample Person", model: brief({
    client_name: "Fabrikam Foods", project_title: "Holiday Pop-up Market", event_period: "Dec 2026", venue: "Sample Plaza",
    objectives: ["Seasonal sales"], budget: { amount: "PHP 900,000", type: "ALL-IN" }, summary: "A holiday pop-up market.",
  }), files: 2 },
  { due: 30, filed: 1, status: "New", next: [], req: "RFX (Open Tender)", vat: "", by: "Another Sample", model: brief({
    client_name: "Tailspin Toys", project_title: "Toy Fair Booth", event_period: "Sep 2027", venue: "Sample Convention Center",
    objectives: ["Show the autumn range"], summary: "A trade-fair booth. Its requirement type is one Fetch doesn't offer.",
  }) },
  { due: 6, filed: 3, status: "Lost", done: true, next: [], req: "", vat: "", by: "Sample Person", model: brief({
    client_name: "Adventure Works", project_title: "Trail Run Series", event_period: "Feb 2027", venue: "Sample Park",
    objectives: ["Brand awareness"], budget: { amount: "Not specified", type: "NOT SPECIFIED" }, summary: "Three trail runs.",
  }) },
];

BRIEFS.forEach((b, i) => {
  const reqLabel = RULES.requirementTypes[b.req] ? RULES.requirementTypes[b.req].label : b.req;
  const cells = newRowCells({ model: b.model, nextSteps: b.next, requirement: RULES.requirementTypes[b.req] ? b.req : "",
    vat: b.vat, attachments: Array.from({ length: b.files || 0 }, (_, k) => `previewfile${i}${k}`) },
    { filedBy: b.by, sources: "sample-brief.pdf" });
  const { fields: written } = toFields(cells, options);
  if (b.req && !RULES.requirementTypes[b.req]) written["Requirement Type"] = reqLabel;   // a value Fetch doesn't know, as Lark could hold
  written.Status = b.status;
  written.Done = b.done ? "Yes" : "No";
  const rec = lark.state.add(written);
  rec.record_id = `recSample${i + 1}`;
  rec.dueInDays = b.due;
  rec.filedDaysAgo = b.filed;
});

const extractBrief = brief({
  client_name: "Globex Beverages", project_title: "Launch Party for Zest", event_period: "Aug 8, 2027, 7:00 PM", venue: "Sample Rooftop Bar",
  key_dates: [{ date: "2027-07-20", label: "Guest list due" }],
  objectives: ["Launch the new drink with press and creators", "Create 200 pieces of social content"],
  target_audience: ["Lifestyle press and creators", "Young professionals, 22-35"], kpis: ["150 guests", "200 social posts", "20 press mentions"],
  scope_of_work: [{ item: "Venue", detail: "Sourcing and styling" }, { item: "Program", detail: "Host, DJ and a short product reveal" }],
  budget: { amount: "PHP 1,200,000", type: "ALL-IN" }, proposal_submission: { type: "PITCH / PRESENTATION", details: "Short deck with a budget" },
  requirement: { type: "RFP", reason: "The brief asks for a creative proposal and a budget." },
  vat: { applies: "NO", reason: "Budget is stated exclusive of VAT." }, due_date: { date: "", note: "12:00 PM via email" },
  notes: ["The client will confirm the date next week"], clarifications: ["Is the rooftop venue already booked?"],
  summary: "A launch party for a new drink, with press, creators and social content.",
});

// "Check sources": a two-page sample PDF holding the extraction's quotes. Upload tests/preview-sample.pdf
// in preview mode, then turn on Check sources. The quotes deliberately include a wrong page (kpis.2 says
// page 1; it's on 2), a reworded quote (target_audience.1) and a value with no quote (scope_of_work).
const SAMPLE_PAGES = [
  ["Globex Beverages - Brief for Agencies", "Launch Party for Zest", "",
    "Event: August 8, 2027, 7:00 PM", "Venue: Sample Rooftop Bar, Makati", "Guest list due on July 20, 2027.",
    "Proposals are due at 12:00 PM via email."],
  ["Objectives: launch the new drink with press and creators, and", "create 200 pieces of social content.", "",
    "Audience: lifestyle press and creators; young professionals aged 22-35.", "",
    "Success measures: 150 guests, 200 social posts and 20 press mentions.", "",
    "Budget: PHP 1,200,000 all-in, exclusive of VAT.", "Submit a short deck with a budget for a pitch presentation."],
];
const ev = (field, page, quote) => ({ field, source: 1, page, quote });
const extractEvidence = [
  ev("client_name", 1, "Globex Beverages"), ev("project_title", 1, "Launch Party for Zest"),
  ev("event_period", 1, "Event: August 8, 2027, 7:00 PM"), ev("venue", 1, "Venue: Sample Rooftop Bar, Makati"),
  ev("key_dates.0", 1, "Guest list due on July 20, 2027"), ev("due_date", 1, "Proposals are due at 12:00 PM via email"),
  ev("objectives.0", 2, "launch the new drink with press and creators"), ev("objectives.1", 2, "create 200 pieces of social content"),
  ev("target_audience.0", 2, "lifestyle press and creators"), ev("target_audience.1", 2, "young professionals aged 22 to 35"),
  ev("kpis.0", 2, "150 guests"), ev("kpis.1", 2, "200 social posts"), ev("kpis.2", 1, "20 press mentions"),
  ev("budget.amount", 2, "Budget: PHP 1,200,000 all-in, exclusive of VAT"),
  ev("proposal_submission.details", 2, "Submit a short deck with a budget"),
];

/** A minimal A4 PDF (Helvetica, one text line per entry). Enough for pdf.js to render and read. */
function samplePdf(pages) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  pages.forEach((lines) => {
    const stream = `BT /F1 13 Tf 16 TL 60 770 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
writeFileSync(new URL("./preview-sample.pdf", import.meta.url), samplePdf(SAMPLE_PAGES), "latin1");

writeFileSync(new URL("./preview-fixture.json", import.meta.url), JSON.stringify({
  note: "Synthetic sample data for ?preview. Made by tests/make-preview-fixture.mjs. No real data.",
  fields,
  records: lark.state.records,
  extract: { dueInDays: 14, brief: extractBrief, evidence: extractEvidence,
    meta: { model: "gemini-sample", duration_ms: 6200, sources: [{ kind: "pdf", name: "sample-brief.pdf" }], failed_attempts: [] } },
  services: {
    gemini: { service: SERVICES.gemini.service, version: "1.5.0", api: 1, configured: true, endpoints: ["GET /", "GET /health", "POST /extract"],
      cors: { origins: "*", allow_headers: SERVICES.gemini.headers.concat("Content-Type") },
      limits: { max_upload_mb: 50, max_files: 10, rate_limit_per_hour: 60 }, login: { provider: "lark", required: true } },
  },
}, null, 1) + "\n");
console.log(`Wrote tests/preview-fixture.json: ${lark.state.records.length} sample briefs.`);
