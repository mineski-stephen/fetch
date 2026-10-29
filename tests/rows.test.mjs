import test from "node:test";
import assert from "node:assert/strict";
import * as B from "../js/brief.js";
import { FIELD, fromRecord, briefCells, extraCells, newRowCells, changedCells, toFields, sigs, downloadRequest, downloadLink, fileRequest } from "../js/rows.js";
import { plain, clean, isBlank, canon, sameCell, cellSig, matchOption, toLarkDay, fromLarkDay } from "../js/cells.js";
import { liveFields, fakeLark, TABLE } from "./fake-lark.mjs";
import { optionsOf } from "../js/schema.js";
import { createRecord, getRecord } from "../js/tables.js";

const MODEL = {
  schema_version: 1, date_filed: "2026-10-02", due_date: { date: "2026-10-16", note: "5:00 PM via email" },
  client_name: "NovaFizz", project_title: "Campus Clash", event_period: "Dec 5-7, 2026",
  key_dates: [{ date: "2026-11-01", label: "Pitch day" }], venue: "SM Mall of Asia Arena",
  objectives: ["Grow awareness"], target_audience: ["Students"], kpis: ["50,000 reach"],
  scope_of_work: [{ item: "Booth", detail: "Design and build" }, { item: "", detail: "Social posts" }],
  budget: { amount: "PHP 2,000,000", type: "ALL-IN" }, proposal_submission: { type: "PITCH / PRESENTATION", details: "Deck by Oct 16" },
  requirement: { type: "RFP", reason: "r" }, vat: { applies: "NO", reason: "Prices are exclusive of VAT." },
  notes: ["Not confirmed"], clarifications: ["Is the venue booked?"], summary: "A campus esports cup.",
};
const state = (model = MODEL, x = {}) => ({ model, nextSteps: [], requirement: "", vat: "", attachments: [], ...x });
const OPTIONS = optionsOf(liveFields());

test("a brief with nothing in it writes no blank and no placeholder", () => {
  const cells = briefCells({});
  for (const [k, v] of Object.entries(cells)) {
    assert.ok(v !== "" && v !== null, `${k} is blank`);
    assert.ok(!/^Not specified$|^Untitled Project$/.test(String(v)), `${k} holds a placeholder`);
  }
  assert.ok(!(FIELD.title in cells), "no title written for Untitled Project");
  assert.ok(!(FIELD.client in cells));
  assert.ok(!(FIELD.venue in cells));
  assert.ok(!(FIELD.budgetType in cells), "an unspecified budget type is not written");
  assert.ok(FIELD.json in cells, "the document itself is always written");
});

test("a full brief maps to readable columns", () => {
  const c = briefCells(MODEL);
  assert.equal(c[FIELD.title], "Campus Clash");
  assert.equal(c[FIELD.period], "Dec 5-7, 2026\n• 2026-11-01 - Pitch day");
  assert.equal(c[FIELD.objective], "• Grow awareness");
  assert.equal(c[FIELD.scope], "• Booth: Design and build\n• Social posts");
  assert.equal(c[FIELD.questions], "1. Is the venue booked?");
  assert.equal(c[FIELD.budgetType], "All-in");
  assert.equal(c[FIELD.submission], "Pitch / Presentation");
  assert.match(c[FIELD.submissionDetails], /^Due 16 Oct 2026 \(Fri\) - 5:00 PM via email\nDeck by Oct 16$/);
  assert.equal(c[FIELD.due], Date.UTC(2026, 9, 16) - 480 * 60000);
  assert.equal(JSON.parse(c[FIELD.json]).project_title, "Campus Clash");
});

test("extras are only the values the person picked", () => {
  assert.deepEqual(extraCells({}), {});
  const c = extraCells({ nextSteps: ["Pitch Deck"], requirement: "RFQ", vat: "NO", attachments: ["tok1"] });
  assert.deepEqual(c, {
    [FIELD.nextSteps]: ["Pitch Deck"], [FIELD.requirement]: "RFQ (Request for Quotation)", [FIELD.vat]: ["VAT Ex."],
    [FIELD.attachments]: [{ file_token: "tok1" }],
  });
  assert.deepEqual(extraCells({ requirement: "nonsense", vat: "MAYBE" }), {});
});

test("a new row gets who filed it, the sources and the starting status", () => {
  const c = newRowCells(state(), { filedBy: "Ana Cruz", sources: "brief.pdf" });
  assert.equal(c[FIELD.filedBy], "Ana Cruz");
  assert.equal(c[FIELD.sources], "brief.pdf");
  assert.equal(c[FIELD.status], "New");
  assert.equal(c[FIELD.done], "No");
  assert.ok(!(FIELD.nextSteps in c) && !(FIELD.requirement in c));
  const noName = newRowCells(state(), { filedBy: "" });
  assert.ok(!(FIELD.filedBy in noName), "a missing name is left out, not written as blank");
});

test("changedCells: nothing changed means nothing to write", () => {
  assert.deepEqual(changedCells(state(), state()), {});
  assert.deepEqual(changedCells(state(MODEL, { nextSteps: ["A", "B"] }), state(MODEL, { nextSteps: ["B", "A"] })), {});
});

test("changedCells: only the edited cell and the document are written", () => {
  const after = { ...MODEL, venue: "Araneta Coliseum" };
  const d = changedCells(state(), state(after));
  assert.deepEqual(Object.keys(d).sort(), [FIELD.venue, FIELD.json].sort());
  assert.equal(d[FIELD.venue], "Araneta Coliseum");
});

test("changedCells: an extra change touches only its own column", () => {
  const d = changedCells(state(), state(MODEL, { nextSteps: ["Pitch Deck"], vat: "YES" }));
  assert.deepEqual(Object.keys(d).sort(), [FIELD.nextSteps, FIELD.vat].sort());
  assert.deepEqual(d[FIELD.vat], ["VAT Inc."]);
});

test("changedCells: emptying a cell on purpose clears it; an untouched blank stays out", () => {
  const cleared = changedCells(state(), state({ ...MODEL, venue: "", due_date: { date: "", note: "" } }));
  assert.equal(cleared[FIELD.venue], null);
  assert.equal(cleared[FIELD.due], null);
  const picked = changedCells(state(MODEL, { requirement: "RFP", nextSteps: ["X"], attachments: ["t"] }), state());
  assert.equal(picked[FIELD.requirement], null);
  assert.equal(picked[FIELD.nextSteps], null);
  assert.equal(picked[FIELD.attachments], null);
  assert.ok(!(FIELD.client in changedCells(state({ ...MODEL, client_name: "" }), state({ ...MODEL, client_name: "" }))));
});

test("toFields: selects are written with Lark's own option names", () => {
  const { fields, skipped } = toFields({ [FIELD.budgetType]: "ALL-IN".toLowerCase().replace("all-in", "all - in"), [FIELD.done]: "yes" }, OPTIONS);
  assert.deepEqual(skipped, []);
  assert.equal(fields[FIELD.budgetType], "All-in");   // "all - in" fits the option "All-in"
  assert.equal(fields[FIELD.done], "Yes");
});

test("toFields: an option Lark doesn't have is not written", () => {
  const { fields, skipped } = toFields({ [FIELD.requirement]: "RFX (Something)", [FIELD.vat]: ["VAT Weird"] }, OPTIONS);
  assert.deepEqual(fields, { [FIELD.vat]: [] });
  assert.deepEqual(skipped.map((s) => s.column).sort(), [FIELD.requirement, FIELD.vat].sort());
});

test("toFields: Next Steps may add a new option on purpose", () => {
  const { fields, skipped } = toFields({ [FIELD.nextSteps]: ["pitch deck", "Brand new step"] }, OPTIONS);
  assert.deepEqual(skipped, []);
  assert.deepEqual(fields[FIELD.nextSteps], ["Pitch Deck", "Brand new step"]);
});

test("toFields: a cleared multi-select or attachment list is an empty list, a cleared date is null", () => {
  const { fields } = toFields({ [FIELD.nextSteps]: null, [FIELD.attachments]: null, [FIELD.due]: null, [FIELD.requirement]: null }, OPTIONS);
  assert.deepEqual(fields, { [FIELD.nextSteps]: [], [FIELD.attachments]: [], [FIELD.due]: null, [FIELD.requirement]: null });
});

test("a row written by Fetch reads back to the same brief and the same cells", async () => {
  const call = fakeLark();
  const cells = newRowCells(state(MODEL, { nextSteps: ["Pitch Deck"], requirement: "RFP", vat: "NO" }), { filedBy: "Ana Cruz", sources: "a.pdf\nb.pdf" });
  const { fields } = toFields(cells, OPTIONS);
  const rec = await createRecord(call, TABLE, fields, "tok-1");
  const row = fromRecord(await getRecord(call, TABLE, rec.record_id));
  assert.deepEqual(row.model, B.normalize(MODEL));
  assert.equal(row.filedBy, "Ana Cruz");
  assert.equal(row.requirement, "RFP");
  assert.equal(row.vat, "NO");
  assert.deepEqual(row.nextSteps, ["Pitch Deck"]);
  assert.equal(row.done, false);
  assert.equal(row.status, "New");
  // Saving that row without touching it changes nothing.
  const before = state(row.model, { nextSteps: row.nextSteps, requirement: row.requirement, vat: row.vat });
  assert.deepEqual(changedCells(before, before), {});
});

test("fromRecord: the JSON column wins, the Due Date column wins over the JSON", () => {
  const json = JSON.stringify({ ...MODEL, due_date: { date: "2026-10-16", note: "" } });
  const rec = { record_id: "r1", fields: {
    [FIELD.json]: [{ type: "text", text: json }], [FIELD.due]: Date.UTC(2026, 10, 3) - 480 * 60000,
  } };
  const row = fromRecord(rec);
  assert.equal(row.model.project_title, "Campus Clash");
  assert.equal(row.model.due_date.date, "2026-11-03");
});

test("fromRecord: without the JSON, the readable columns are used", () => {
  const rec = { record_id: "r2", fields: {
    [FIELD.title]: [{ type: "text", text: "Plain row" }], [FIELD.client]: [{ type: "text", text: "Acme" }],
    [FIELD.objective]: [{ type: "text", text: "• One\r\n• Two" }], [FIELD.done]: "Yes",
    [FIELD.filed]: Date.UTC(2026, 9, 2) - 480 * 60000,
  } };
  const row = fromRecord(rec);
  assert.equal(row.model.project_title, "Plain row");
  assert.deepEqual(row.model.objectives, ["One", "Two"]);
  assert.equal(row.model.date_filed, "2026-10-02");
  assert.equal(row.done, true);
});

test("fromRecord: an option Fetch doesn't know is kept, not cleared", () => {
  const rec = { record_id: "r3", fields: { [FIELD.requirement]: "RFX (Something new)", [FIELD.vat]: ["VAT Maybe"] } };
  const row = fromRecord(rec);
  assert.equal(row.requirement, "");
  assert.equal(row.requirementRaw, "RFX (Something new)");
  assert.equal(row.vatRaw, "VAT Maybe");
  // The person didn't touch them, so the save leaves both columns alone.
  const same = state(row.model, { requirement: row.requirement, vat: row.vat });
  assert.deepEqual(changedCells(same, same), {});
});

test("fromRecord: knows RFQ and a padded 'No ' choice, keeps no attachment links", () => {
  const rec = { record_id: "r4", fields: {
    [FIELD.requirement]: "RFQ (Request for Quotation)", [FIELD.vat]: ["VAT Ex. "],
    [FIELD.attachments]: [{ file_token: "t1", name: "a.pdf", size: 5, url: "https://x/y", tmp_url: "https://x/z" }],
  } };
  const row = fromRecord(rec);
  assert.equal(row.requirement, "RFQ");
  assert.equal(row.vat, "NO");
  assert.deepEqual(row.attachments, [{ token: "t1", name: "a.pdf", size: 5 }]);
});

test("fromRecord: a brief from a newer version is flagged", () => {
  const rec = { record_id: "r5", fields: { [FIELD.json]: JSON.stringify({ ...MODEL, schema_version: 99 }) } };
  assert.equal(fromRecord(rec).newer, 99);
  assert.equal(fromRecord({ record_id: "r6", fields: {} }).newer, 0);
});

test("sigs: a changed cell changes its signature, nothing else", () => {
  const a = sigs({ [FIELD.venue]: [{ type: "text", text: "A" }], [FIELD.client]: "X" });
  const b = sigs({ [FIELD.venue]: [{ type: "text", text: "B" }], [FIELD.client]: [{ type: "text", text: "X" }] });
  assert.notEqual(a[FIELD.venue], b[FIELD.venue]);
  assert.equal(a[FIELD.client], b[FIELD.client], "the same text in either format has the same signature");
});

test("cells: reading and comparing", () => {
  assert.equal(plain([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(clean("  x\r\ny  "), "x\ny");
  assert.equal(isBlank(0), false);
  assert.equal(isBlank([]), true);
  assert.equal(isBlank([{ type: "text", text: " " }]), true);
  assert.equal(canon(["b", "a"]), "a\nb");
  assert.ok(sameCell([{ file_token: "1" }, { file_token: "2" }], [{ file_token: "2", name: "x" }, { file_token: "1" }]));
  assert.equal(typeof cellSig("abc"), "string");
  assert.equal(matchOption("PDEI - Event Service", ["PDEI-Event Service"]), "PDEI-Event Service");
  assert.equal(matchOption("nope", ["a"]), null);
  assert.equal(matchOption("", ["a"]), null);
});

test("cells: Lark's date-only cells round-trip in the Base's zone", () => {
  const ms = toLarkDay("2026-10-16", 480);
  assert.equal(ms, Date.UTC(2026, 9, 15, 16, 0, 0));
  assert.equal(fromLarkDay(ms, 480), "2026-10-16");
  assert.equal(toLarkDay("2026-02-30", 480), null);
  assert.equal(toLarkDay("", 480), null);
  assert.equal(fromLarkDay(undefined, 480), "");
});

test("an attachment's download request uses Lark's own tmp_url, never another address", () => {
  const api = "https://open.larksuite.com/open-apis/drive/v1/medias/batch_get_tmp_download_url";
  const own = `${api}?file_tokens=t1&extra=%7B%22bitablePerm%22%3A%7B%7D%7D`;
  const fields = { [FIELD.attachments]: [
    { file_token: "t1", name: "a.pdf", tmp_url: own },
    { file_token: "t2", name: "b.pdf", tmp_url: "https://evil.example/steal?file_tokens=t2" },
  ] };
  assert.equal(downloadRequest(fields, "t1", "tblX"), own);
  const built = downloadRequest(fields, "t2", "tblX");
  assert.ok(built.startsWith(`${api}?file_tokens=t2&extra=`));
  assert.match(decodeURIComponent(built), /"tableId":"tblX"/);
  assert.equal(downloadRequest(fields, "gone", "tblX"), null);
  assert.equal(downloadRequest({}, "t1", "tblX"), null);
});

test("the download link is read from Lark's answer, https only", () => {
  const json = { code: 0, data: { tmp_download_urls: [{ file_token: "t1", tmp_download_url: "https://internal-api-drive-stream.larksuite.com/x" }] } };
  assert.equal(downloadLink(json, "t1"), "https://internal-api-drive-stream.larksuite.com/x");
  assert.equal(downloadLink({ data: { tmp_download_urls: [{ file_token: "t1", tmp_download_url: "javascript:alert(1)" }] } }, "t1"), "");
  assert.equal(downloadLink({ data: {} }, "t1"), "");
});

test("an attachment's file request uses the cell's own download address only if it is Lark's", () => {
  const base = "https://open.larksuite.com/open-apis/drive/v1/medias";
  const own = `${base}/t1/download?extra=%7B%22bitablePerm%22%3A%7B%7D%7D`;
  const fields = { [FIELD.attachments]: [
    { file_token: "t1", name: "a.pdf", url: own },
    { file_token: "t2", name: "b.pdf", url: `${base}/OTHER/download` },
    { file_token: "t3", name: "c.pdf", url: "https://evil.example/t3/download" },
  ] };
  assert.equal(fileRequest(fields, "t1", "tblX"), own);
  for (const t of ["t2", "t3"]) {
    const built = fileRequest(fields, t, "tblX");
    assert.ok(built.startsWith(`${base}/${t}/download?extra=`), built);
    assert.match(decodeURIComponent(built), /"tableId":"tblX"/);
  }
  assert.equal(fileRequest(fields, "gone", "tblX"), null);
});

test("Fetch Files: read as files, written only for a new row, downloaded from its own column", () => {
  const rec = { record_id: "r9", fields: { [FIELD.fetchFiles]: [{ file_token: "s1", name: "fetch-sources.json.gz", size: 900, url: "https://x" }] } };
  assert.deepEqual(fromRecord(rec).fetchFiles, [{ token: "s1", name: "fetch-sources.json.gz", size: 900 }]);
  assert.deepEqual(newRowCells(state(), { fetchFiles: ["s1"] })[FIELD.fetchFiles], [{ file_token: "s1" }]);
  assert.equal(newRowCells(state())[FIELD.fetchFiles], undefined);
  assert.equal(fileRequest(rec.fields, "s1", "tblX"), null, "not in Attachments");
  assert.match(fileRequest(rec.fields, "s1", "tblX", FIELD.fetchFiles), /\/medias\/s1\/download\?extra=/);
  assert.match(downloadRequest(rec.fields, "s1", "tblX", FIELD.fetchFiles), /file_tokens=s1/);
});
