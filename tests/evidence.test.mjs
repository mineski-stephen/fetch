import test from "node:test";
import assert from "node:assert/strict";
import { resolve, has, passagesOf } from "../js/evidence.js";

const clone = (x) => JSON.parse(JSON.stringify(x));
const ORIGINAL = {
  venue: "SMX Manila", budget: { amount: "PHP 2,000,000", type: "ALL-IN" },
  proposal_submission: { type: "PITCH / PRESENTATION", details: "Deck by 16 Oct" },
  due_date: { date: "2026-10-16", note: "5 PM via email" },
  kpis: ["50,000 reach", "1,000 sign-ups", "20 creators posting"],
  key_dates: [{ date: "1 Nov 2026", label: "Pitch day" }],
};
const EVIDENCE = [
  { field: "venue", source: 1, page: 2, quote: "Venue: SMX Manila" },
  { field: "budget.amount", source: 1, page: 3, quote: "Budget is PHP 2,000,000 all-in" },
  { field: "due_date", source: 1, page: 1, quote: "Submit by 16 October, 5 PM" },
  { field: "kpis.0", source: 1, page: 4, quote: "reach 50,000" },
  { field: "kpis.2", source: 2, page: 0, quote: "20 creators" },
  { field: "key_dates.0", source: 1, page: 1, quote: "Pitch on 1 November" },
];

test("a scalar field gets its quote, and says when it was edited", () => {
  const model = clone(ORIGINAL);
  assert.equal(resolve("venue", model, ORIGINAL, EVIDENCE).ev.page, 2);
  assert.equal(resolve("venue", model, ORIGINAL, EVIDENCE).edited, false);
  model.venue = "SMX Convention Center, Manila";
  const r = resolve("venue", model, ORIGINAL, EVIDENCE);
  assert.equal(r.edited, true);
  assert.equal(r.extracted, "SMX Manila");
});

test("chips and the due-date note borrow the nearest quote", () => {
  assert.equal(resolve("budget.type", ORIGINAL, ORIGINAL, EVIDENCE).field, "budget.amount");
  assert.equal(resolve("due_date.note", ORIGINAL, ORIGINAL, EVIDENCE).field, "due_date");
  assert.equal(resolve("due_date.date", ORIGINAL, ORIGINAL, EVIDENCE).ev.quote, "Submit by 16 October, 5 PM");
  assert.equal(resolve("proposal_submission.type", ORIGINAL, ORIGINAL, EVIDENCE).ev, null);
  assert.equal(has("event_period", ORIGINAL, ORIGINAL, EVIDENCE), false);
});

test("list items keep their quote after reorder, delete and insert", () => {
  const model = clone(ORIGINAL);
  model.kpis = ["20 creators posting", "New KPI typed by hand", "50,000 reach"];   // moved, deleted, added
  assert.equal(resolve("kpis.0", model, ORIGINAL, EVIDENCE).ev.quote, "20 creators");
  assert.equal(resolve("kpis.2", model, ORIGINAL, EVIDENCE).ev.quote, "reach 50,000");
  assert.deepEqual(resolve("kpis.1", model, ORIGINAL, EVIDENCE), { ev: null, why: "added" });
  assert.equal(resolve("kpis.9", model, ORIGINAL, EVIDENCE).why, "added");   // the empty placeholder row
});

test("a lightly edited item still resolves; a rewritten one does not", () => {
  const model = clone(ORIGINAL);
  model.kpis = ["50,000 reach on TikTok", "Completely different goal"];
  const r = resolve("kpis.0", model, ORIGINAL, EVIDENCE);
  assert.equal(r.ev.quote, "reach 50,000");
  assert.equal(r.edited, true);
  assert.equal(resolve("kpis.1", model, ORIGINAL, EVIDENCE).why, "added");
});

test("an original item without a quote says so; pair items resolve by either half", () => {
  assert.deepEqual(resolve("kpis.1", ORIGINAL, ORIGINAL, EVIDENCE).ev, null);
  assert.equal(resolve("kpis.1", ORIGINAL, ORIGINAL, EVIDENCE).why, "none");
  assert.equal(resolve("key_dates.0.label", ORIGINAL, ORIGINAL, EVIDENCE).ev.quote, "Pitch on 1 November");
  assert.equal(resolve("key_dates.0.date", ORIGINAL, ORIGINAL, EVIDENCE).ev.quote, "Pitch on 1 November");
});

test("no evidence at all is handled", () => {
  assert.equal(resolve("venue", ORIGINAL, ORIGINAL, null).ev, null);
  assert.equal(resolve("kpis.0", ORIGINAL, undefined, undefined).why, "added");
});

test("several passages per field (service 1.7) and one (1.6) both work", () => {
  const evidence = [{ field: "kpis.0", passages: [
    { source: 1, page: 2, quote: "The vendor must produce an ornamental tree for the holidays" },
    { source: 1, page: 5, quote: "The tree must contain specifically only red ornaments" },
    { source: 9, page: 0, quote: "" }]}];
  const model = { kpis: ["Create a Christmas tree with only red ornaments"] };
  const r = resolve("kpis.0", model, model, evidence);
  assert.deepEqual(passagesOf(r.ev).map((p) => p.page), [2, 5]);
  assert.deepEqual(passagesOf({ field: "venue", source: 1, page: 0, quote: "SMX" }), [{ source: 1, page: 0, quote: "SMX" }]);
  assert.deepEqual(passagesOf(null), []);
});
