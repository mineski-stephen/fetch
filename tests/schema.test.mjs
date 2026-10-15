import test from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, FIELD, T, tableSpec, setupColumns, checkSchema, checkNeeded, checkAll, blockers, presentColumns,
  writableOnly, optionsOf, selectOptions } from "../js/schema.js";
import { parseBaseLink, tableUrl } from "../js/tables.js";
import { TABLES, APP, tableLinks, SERVICES, LARK } from "../js/config.js";
import { liveFields } from "./fake-lark.mjs";

const without = (name) => liveFields((f) => f.filter((x) => x.field_name !== name));
const retype = (name, type) => liveFields((f) => f.map((x) => (x.field_name === name ? { ...x, type } : x)));
const dropOption = (col, opt) => liveFields((f) => f.map((x) => (x.field_name === col
  ? { ...x, property: { options: x.property.options.filter((o) => o.name !== opt) } } : x)));

test("every column has a unique name and a key; there is one primary column", () => {
  assert.equal(new Set(COLUMNS.map((c) => c.name)).size, COLUMNS.length);
  assert.equal(new Set(COLUMNS.map((c) => c.key)).size, COLUMNS.length);
  assert.equal(COLUMNS.filter((c) => c.primary).length, 1);
  assert.equal(COLUMNS[0].primary, true);
  assert.equal(FIELD.json, "Brief JSON");
  assert.equal(FIELD.done, "Done");
});

test("the setup list is the same list", () => {
  const s = setupColumns();
  assert.equal(s.primary, "Project Title");
  assert.deepEqual(s.columns.map((c) => c.name), COLUMNS.map((c) => c.name));
  const status = s.columns.find((c) => c.name === "Status");
  assert.deepEqual(status.options, ["New", "In Progress", "Submitted", "Won", "Lost", "Declined"]);
  assert.equal(s.columns.find((c) => c.name === "Done").type, T.select);
});

test("a table that matches the spec has no problems", () => {
  const all = checkAll(liveFields());
  assert.deepEqual(all.problems, []);
  assert.deepEqual(all.partial, []);
  assert.deepEqual(blockers(all, Object.values(FIELD)), []);
  assert.deepEqual(all.options["Done"], ["Yes", "No"]);
});

test("a renamed Done or Brief JSON is a problem that stops writing", () => {
  for (const name of ["Done", "Brief JSON", "Project Title"]) {
    const all = checkAll(without(name));
    assert.deepEqual(all.problems, [`Column “${name}” is missing.`]);
    assert.deepEqual(blockers(all, []), all.problems);
  }
});

test("a wrong column type is named in words", () => {
  assert.deepEqual(checkSchema(retype("Due Date", T.text)), ["Column “Due Date” is Text, expected Date."]);
  assert.deepEqual(checkSchema(retype("Status", 99)), ["Column “Status” is type 99, expected Single select."]);
});

test("a missing option the page writes is a problem", () => {
  assert.deepEqual(checkSchema(dropOption("Done", "Yes")), ["“Done” has no option “Yes”."]);
  assert.deepEqual(checkSchema(dropOption("Status", "New")), ["“Status” has no option “New”."]);
  // Options the page doesn't write may differ freely (people add statuses in Lark).
  assert.deepEqual(checkSchema(dropOption("Status", "Declined")), []);
});

test("optional columns switch off only what uses them", () => {
  for (const [name, kind] of [["Attachments", "attachments"], ["Next Steps", "nextSteps"], ["Requirement Type", "requirement"], ["VAT", "vat"]]) {
    const all = checkAll(without(name));
    assert.deepEqual(all.problems, [], `${name}: saving stays on`);
    assert.deepEqual(all.partial, [`Column “${name}” is missing.`]);
    assert.deepEqual(blockers(all, [FIELD.venue, FIELD.json]), [], "a save that doesn't touch it goes ahead");
    assert.deepEqual(blockers(all, [name]), [`Column “${name}” is missing.`]);
    assert.deepEqual(checkNeeded(without(name))[kind], [`Column “${name}” is missing.`]);
  }
  assert.deepEqual(checkAll(without("Last Modified")).partial, []);
});

test("an optional column of the wrong type is still reported", () => {
  assert.deepEqual(checkSchema(retype("Attachments", T.text)), ["Column “Attachments” is Text, expected Attachment."]);
});

test("reads ask only for columns the table has; past 50 names, for all", () => {
  assert.deepEqual(presentColumns(without("Venue")).includes("Venue"), false);
  assert.equal(presentColumns(liveFields()).length, COLUMNS.length);
  const many = Array.from({ length: 60 }, (_, i) => `c${i}`);
  assert.equal(presentColumns(many.map((n) => ({ field_name: n })), { read: many }), undefined);
});

test("writableOnly drops computed and unknown columns", () => {
  const out = writableOnly({ "Last Modified": 1, Venue: "x", Nope: 1 }, liveFields());
  assert.deepEqual(out, { Venue: "x" });
});

test("live select options are read by name", () => {
  const f = liveFields();
  assert.deepEqual(selectOptions(f.find((x) => x.field_name === "VAT")), ["VAT Inc.", "VAT Ex."]);
  assert.ok(!("Venue" in optionsOf(f)));
  assert.ok(tableSpec().openOptions.includes("Next Steps"));
});

test("table links: /base/ only, with a table id", () => {
  const ok = parseBaseLink("https://mineskiglobal.larksuite.com/base/NP7TbjwHNaTyLOsWafelN9wNgEd?table=tblG3XcLw2auB4lM&view=vewMIKkyNv");
  assert.deepEqual([ok.app, ok.table, ok.view], ["NP7TbjwHNaTyLOsWafelN9wNgEd", "tblG3XcLw2auB4lM", "vewMIKkyNv"]);
  assert.match(tableUrl(ok), /\/bitable\/v1\/apps\/NP7TbjwHNaTyLOsWafelN9wNgEd\/tables\/tblG3XcLw2auB4lM$/);
  assert.throws(() => parseBaseLink("https://x.larksuite.com/wiki/abc123?table=tblx1"), /wiki page/);
  assert.throws(() => parseBaseLink("https://x.larksuite.com/base/abc123"), /table link/);
  assert.throws(() => parseBaseLink("https://x.larksuite.com/base/abc123?table=nope"), /table link/);
  assert.throws(() => parseBaseLink("not a link"), /isn't a link/);
  assert.throws(() => parseBaseLink("http://x.larksuite.com/base/abc?table=tbl1"), /https/);
});

test("config: one tenant host, a parseable live link, services and scopes", () => {
  assert.equal(new URL(TABLES.live.briefs).host, "mineskiglobal.larksuite.com");
  assert.doesNotThrow(() => parseBaseLink(TABLES.live.briefs));
  assert.ok(TABLES.test.briefs === "" || new URL(TABLES.test.briefs).host === "mineskiglobal.larksuite.com");
  assert.equal(APP.env, "live", "the checked-in config is the live one");
  assert.deepEqual(tableLinks("live"), TABLES.live);
  assert.equal(SERVICES.gemini.service, "gemini-brief-proxy");
  assert.equal(SERVICES.lark.service, "lark-cors-proxy");
  assert.equal(LARK.scopes, "bitable:app");
  assert.equal(LARK.tzOffsetMinutes, 480);
});
