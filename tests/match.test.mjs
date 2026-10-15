import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, norm, find, findAll, spanUnits, rects, pageOrder } from "../js/match.js";

const doc = (text) => buildIndex([{ text }]);
const found = (index, span) => index.units[0].text.slice(...Object.values(spanUnits(index, span)[0]).slice(1));

test("norm drops accents, case, punctuation and number separators", () => {
  assert.equal(norm("  Café “SMX” – Hall A "), "cafe smx hall a");
  assert.equal(norm("PHP 3,500,000.00"), norm("php 3 500 000 00"));
  assert.equal(norm("ＰＨＰ １２３"), "php123".replace("php", "php "));   // full-width letters and digits
  assert.equal(norm("東京 ビッグサイト"), "東京ビッグサイト");
  assert.equal(norm("aged 22-35, 8/8"), "aged 22 35 8 8");   // ranges and dates keep their numbers apart
});

test("a range written differently is a close match, not a miss", () => {
  const index = doc("Audience: lifestyle press and creators; young professionals aged 22-35.");
  const hit = find(index, "young professionals aged 22 to 35");
  assert.ok(hit && !hit.exact && hit.score >= 0.8);
});

test("an exact quote is found across line breaks and table pipes", () => {
  const index = doc("Scope\n| Budget | PHP 3,500,000 |\n| Venue | SMX\nManila |");
  const hit = find(index, "Budget: PHP 3 500 000");
  assert.equal(hit.exact, true);
  assert.equal(found(index, hit), "Budget | PHP 3,500,000");
  assert.equal(found(index, find(index, "Venue SMX Manila")), "Venue | SMX\nManila");
});

test("a lightly reworded or OCR-damaged quote still matches", () => {
  const index = doc("The event will be held at SMX Convention Center Manila on 5 December 2026 for students.");
  const hit = find(index, "held at the SMX Convention Centre Manila on 5 December 2026");
  assert.ok(hit && !hit.exact && hit.score >= 0.75, JSON.stringify(hit));
  assert.match(found(index, hit), /^held at SMX Convention Center Manila on 5 December 2026$/);
  const ocr = doc("Budget: PHP 5OO,OOO inclusive of VAT, Manlla office");
  assert.ok(find(ocr, "Budget: PHP 500,000 inclusive of VAT", { min: 0.6 }));
  assert.ok(find(ocr, "Manila"));
});

test("an unrelated quote is not found", () => {
  const index = doc("The event will be held at SMX Convention Center Manila on 5 December 2026.");
  assert.equal(find(index, "Target audience is mothers aged 30 to 45 in Cebu"), null);
  assert.equal(find(index, ""), null);
});

test("kerned PDF pieces join into one word; units map back with offsets", () => {
  const units = [
    { text: "Total", x0: 0, x1: 50, y0: 0, y1: 10, line: 1 },
    { text: "Bud", x0: 60, x1: 90, y0: 0, y1: 10, line: 1 },
    { text: "get:", glue: true, x0: 90, x1: 130, y0: 0, y1: 10, line: 1 },
    { text: "PHP 2M", x0: 0, x1: 60, y0: 20, y1: 30, line: 2 },
  ];
  const index = buildIndex(units);
  const hit = find(index, "budget PHP 2M");
  assert.ok(hit?.exact);
  assert.deepEqual(spanUnits(index, hit).map((p) => p.unit), [1, 2, 3]);
  const boxes = rects(index, hit);
  assert.equal(boxes.length, 2);   // "Budget" on line 1, "PHP 2M" on line 2
  assert.deepEqual(boxes[0], { x0: 60, x1: 120, y0: 0, y1: 10 });   // "get" without the colon
});

test("pages are searched from the one Gemini named, then its neighbours", () => {
  assert.deepEqual(pageOrder(3, 5), [3, 2, 4, 1, 5]);
  assert.deepEqual(pageOrder(1, 3), [1, 2, 3]);
  assert.deepEqual(pageOrder(0, 3), [1, 2, 3]);
  assert.deepEqual(pageOrder(9, 2), [1, 2]);
});

test("findAll finds every occurrence of a search phrase, ignoring case and punctuation", () => {
  const index = doc("Red ornaments only. RED-ornaments are required; red ornaments, red ornaments!");
  const all = findAll(index, "red ornaments");
  assert.equal(all.length, 4);
  assert.equal(found(index, all[1]), "RED-ornaments");
  assert.deepEqual(findAll(index, ""), []);
  assert.equal(findAll(index, "red", 2).length, 2);
});
