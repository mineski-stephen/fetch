import test from "node:test";
import assert from "node:assert/strict";
import * as B from "../js/brief.js";

const FULL = {
  schema_version: 1, date_filed: "2026-10-02", due_date: { date: "2026-10-16", note: "5:00 PM via email" },
  client_name: "NovaFizz", project_title: "Campus Clash", event_period: "Dec 5-7, 2026",
  key_dates: [{ date: "2026-11-01", label: "Pitch day" }], venue: "SM Mall of Asia Arena",
  objectives: ["Grow awareness among students"], target_audience: ["Students 18-24"], kpis: ["50,000 reach"],
  scope_of_work: [{ item: "Booth", detail: "Design and build" }, { item: "", detail: "Social posts" }],
  budget: { amount: "PHP 2,000,000", type: "ALL-IN" }, proposal_submission: { type: "PITCH / PRESENTATION", details: "Deck by Oct 16" },
  requirement: { type: "RFP", reason: "The brief asks for a proposal and a quotation." },
  vat: { applies: "NO", reason: "Prices are exclusive of VAT." }, notes: ["Venue is not confirmed"],
  clarifications: ["Is the venue booked?"], show_clarifications: true, summary: "A campus esports cup.",
};

test("normalize fills defaults for an empty or odd input", () => {
  for (const raw of [null, undefined, {}, "text", 12, []]) {
    const m = B.normalize(raw);
    assert.equal(m.schema_version, B.SCHEMA_VERSION);
    assert.equal(m.project_title, B.UNTITLED);
    assert.equal(m.client_name, B.NS);
    assert.deepEqual(m.objectives, []);
    assert.equal(m.budget.type, "NOT SPECIFIED");
    assert.match(m.date_filed, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("normalize is idempotent on a full brief", () => {
  const once = B.normalize(FULL);
  assert.deepEqual(B.normalize(once), once);
  assert.equal(once.client_name, "NovaFizz");
  assert.equal(once.due_date.date, "2026-10-16");
});

test("enums are forced to the allowed values", () => {
  const m = B.normalize({ budget: { type: "who knows" }, proposal_submission: { type: "pitch / presentation" } });
  assert.equal(m.budget.type, "NOT SPECIFIED");
  assert.equal(m.proposal_submission.type, "PITCH / PRESENTATION");
});

test("em dashes become hyphens, and 'Not specified' lists are dropped", () => {
  const m = B.normalize({ summary: "One \u2014 two", objectives: ["Not specified", "Real goal \u2014 yes"], notes: [" ", ""] });
  assert.equal(m.summary, "One - two");
  assert.deepEqual(m.objectives, ["Real goal - yes"]);
  assert.deepEqual(m.notes, []);
});

test("the VAT pick agrees with its own note", () => {
  assert.equal(B.normalize({ vat: { applies: "YES", reason: "Prices are exclusive of VAT." } }).vat.applies, "NO");
  assert.equal(B.normalize({ vat: { applies: "NO", reason: "Prices are inclusive of VAT." } }).vat.applies, "YES");
  assert.equal(B.normalize({ vat: { applies: "NO", reason: "The brief does not mention VAT." } }).vat.applies, "NO");
});

test("invalid dates are dropped, not kept", () => {
  assert.equal(B.validISO("2026-02-30"), "");
  assert.equal(B.validISO("2026-10-16"), "2026-10-16");
  assert.equal(B.normalize({ due_date: { date: "soon" } }).due_date.date, "");
});

test("a document from a newer version is recognised", () => {
  assert.equal(B.isNewer({ schema_version: B.SCHEMA_VERSION + 1 }), true);
  assert.equal(B.isNewer({ schema_version: B.SCHEMA_VERSION }), false);
  assert.equal(B.isNewer({}), false);
  assert.equal(B.isNewer(null), false);
});

test("due text and badges", () => {
  const m = B.normalize(FULL);
  assert.equal(B.dueText(m), "16 Oct 2026 (Fri) - 5:00 PM via email");
  assert.equal(B.dueText(m, false), "16 Oct 2026 (Fri)");
  assert.equal(B.dueText(B.normalize({})), "Not specified");
  assert.equal(B.dueBadge("not a date"), null);
});

test("markdown, chat text and file name", () => {
  const m = B.normalize(FULL);
  const md = B.toMarkdown(m);
  assert.match(md, /^# Project Brief Summary/);
  assert.match(md, /\| \*\*Client Name\*\* \| NovaFizz \|/);
  assert.match(md, /Questions for the Client/);
  const chat = B.toChatText(m);
  assert.match(chat, /PROJECT BRIEF: Campus Clash/);
  assert.match(chat, /• Design and build|• Booth: Design and build/);
  assert.equal(B.fileStem(m), "Project Brief - NovaFizz - Campus Clash - 2026-10-02");
  assert.ok(!/\u2014/.test(md + chat), "no em dashes in generated text");
});

test("chat html escapes what it shows", () => {
  const html = B.toChatHtml(B.normalize({ ...FULL, project_title: "A <b> & \"B\"" }));
  assert.match(html, /A &lt;b&gt; &amp; &quot;B&quot;/);
});
