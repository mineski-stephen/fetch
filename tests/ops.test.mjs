import test from "node:test";
import assert from "node:assert/strict";
import * as B from "../js/brief.js";
import * as ops from "../js/ops.js";
import { loadFields, loadRecords, getRecord } from "../js/tables.js";
import { verifyWritten, readBack, safeUpdate } from "../js/verify.js";
import { checkAll, FIELD, T } from "../js/schema.js";
import { newRowCells, toFields } from "../js/rows.js";
import { fakeLark, liveFields, TABLE } from "./fake-lark.mjs";
import { AlreadyDone, WriteBlocked } from "../js/errors.js";

const MODEL = {
  date_filed: "2026-10-02", due_date: { date: "2026-10-16", note: "" }, client_name: "NovaFizz", project_title: "Campus Clash",
  event_period: "Dec 5-7", venue: "MOA Arena", objectives: ["Grow awareness"], budget: { amount: "PHP 2M", type: "ALL-IN" },
  summary: "A cup.",
};
const st = (model = MODEL, x = {}) => ({ model, nextSteps: [], requirement: "", vat: "", attachments: [], ...x });

async function opened(overrides = {}) {
  const call = fakeLark(overrides);
  const { schema } = await ops.loadBriefs(call, TABLE);
  const made = await ops.createBrief(call, TABLE, schema, st(), { filedBy: "Ana Cruz", sources: "a.pdf", clientToken: "tok-A" });
  const { rows } = await ops.loadBriefs(call, TABLE);
  return { call, schema, row: rows.find((r) => r.id === made.recordId), made };
}

test("loading reads every page, and a truncated list throws instead", async () => {
  const call = fakeLark({ pageSize: 2 });
  for (let i = 0; i < 5; i++) call.state.add({ [FIELD.title]: `Brief ${i}`, [FIELD.json]: JSON.stringify({ project_title: `Brief ${i}` }) });
  const { rows, schema } = await ops.loadBriefs(call, TABLE);
  assert.equal(rows.length, 5);
  assert.deepEqual(schema.problems, []);
  assert.deepEqual(rows.map((r) => r.model.project_title), ["Brief 0", "Brief 1", "Brief 2", "Brief 3", "Brief 4"]);
  call.state.noPageToken = true;   // Lark says "more" but gives no token
  await assert.rejects(() => ops.loadBriefs(call, TABLE), /no page token/);
});

test("loading asks only for columns the table has", async () => {
  const call = fakeLark({ fields: liveFields((f) => f.filter((x) => x.field_name !== "Attachments")) });
  const { schema } = await ops.loadBriefs(call, TABLE);
  assert.deepEqual(schema.partial, ["Column “Attachments” is missing."]);
  const search = call.state.calls.find((c) => c.url.startsWith("/records/search"));
  assert.ok(!search.body.field_names.includes("Attachments"));
  assert.equal(search.body.automatic_fields, false);
});

test("create: written with Lark's options, read back, and checked", async () => {
  const { made, row, call } = await opened();
  assert.deepEqual(made.mismatches, []);
  assert.equal(made.readBackError, null);
  assert.equal(made.row.model.project_title, "Campus Clash");
  assert.equal(row.filedBy, "Ana Cruz");
  assert.equal(row.status, "New");
  assert.equal(Object.keys(made.written).length > 10, true);
  assert.ok(call.state.calls.some((c) => c.url.startsWith("/records?client_token=tok-A")));
  assert.ok(call.state.calls.some((c) => c.url === "/records/batch_get"), "the row is re-read, not rebuilt locally");
});

test("create: the same client token never adds a second row", async () => {
  const { call, schema } = await opened();
  const again = await ops.createBrief(call, TABLE, schema, st(), { filedBy: "Ana Cruz", sources: "a.pdf", clientToken: "tok-A" });
  assert.equal(call.state.records.length, 1);
  assert.equal(again.recordId, call.state.records[0].record_id);
});

test("create: a replayed token with an older draft is brought up to the current one", async () => {
  const { call, schema } = await opened();
  const edited = { ...MODEL, venue: "Araneta Coliseum" };
  const again = await ops.createBrief(call, TABLE, schema, st(edited), { filedBy: "Ana Cruz", sources: "a.pdf", clientToken: "tok-A" });
  assert.equal(call.state.records.length, 1);
  assert.deepEqual(again.mismatches, []);
  assert.equal(again.row.model.venue, "Araneta Coliseum");
});

test("create: never writes a blank, a placeholder or a made-up name", async () => {
  const call = fakeLark();
  const { schema } = await ops.loadBriefs(call, TABLE);
  const made = await ops.createBrief(call, TABLE, schema, st({}), { filedBy: "", sources: "", clientToken: "tok-B" });
  const rec = call.state.records[0].fields;
  assert.ok(!(FIELD.title in rec) && !(FIELD.client in rec) && !(FIELD.filedBy in rec) && !(FIELD.venue in rec));
  assert.equal(made.row.model.project_title, B.UNTITLED, "shown as Untitled Project, not stored as one");
});

test("create: stops when the table doesn't match, and says what", async () => {
  const call = fakeLark({ fields: liveFields((f) => f.filter((x) => x.field_name !== "Done")) });
  const { schema } = await ops.loadBriefs(call, TABLE);
  await assert.rejects(() => ops.createBrief(call, TABLE, schema, st(), { clientToken: "t" }),
    (e) => e instanceof WriteBlocked && e.problems.includes("Column “Done” is missing."));
  assert.equal(call.state.records.length, 0);
});

test("update: writes only the cells that changed, then reads them back", async () => {
  const { call, schema, row } = await opened();
  call.state.calls.length = 0;
  const res = await ops.updateBrief(call, TABLE, schema, row, st(row.model), st({ ...row.model, venue: "Araneta Coliseum" }));
  assert.deepEqual(Object.keys(res.written).sort(), [FIELD.venue, FIELD.json].sort());
  assert.deepEqual(res.mismatches, []);
  assert.equal(res.row.model.venue, "Araneta Coliseum");
  const update = call.state.calls.find((c) => c.url === "/records/batch_update");
  assert.deepEqual(Object.keys(update.body.records[0].fields).sort(), [FIELD.venue, FIELD.json].sort());
  const order = call.state.calls.map((c) => c.url);
  assert.ok(order.indexOf("/records/batch_get") < order.indexOf("/records/batch_update"), "re-read before writing");
  assert.equal(order.lastIndexOf("/records/batch_get") > order.indexOf("/records/batch_update"), true, "read back after");
});

test("update: Status, Done and other Lark-owned cells are never touched by a content save", async () => {
  const { call, schema, row } = await opened();
  call.state.edit(row.id, { [FIELD.status]: "Won", [FIELD.done]: "Yes", [FIELD.nextSteps]: ["Pitch Deck"] });
  const res = await ops.updateBrief(call, TABLE, schema, row, st(row.model), st({ ...row.model, summary: "A bigger cup." }));
  assert.ok(!(FIELD.status in res.written) && !(FIELD.done in res.written) && !(FIELD.nextSteps in res.written));
  const now = call.state.records[0].fields;
  assert.equal(now[FIELD.status], "Won");
  assert.equal(now[FIELD.done], "Yes");
  assert.deepEqual(now[FIELD.nextSteps], ["Pitch Deck"]);
});

test("update: a cell changed in Lark since it was loaded is not overwritten", async () => {
  const { call, schema, row } = await opened();
  call.state.edit(row.id, { [FIELD.nextSteps]: ["Pitch Deck"] });   // someone else, in Lark
  const seen = call.state.calls.length;   // the row's creation (and its link) came before
  const mine = st({ ...row.model }, { nextSteps: ["PM Assignment"] });
  await assert.rejects(() => ops.updateBrief(call, TABLE, schema, row, st(row.model), mine), (e) => {
    assert.ok(e instanceof AlreadyDone);
    assert.deepEqual(e.changed, [FIELD.nextSteps]);
    assert.match(e.message, /“Campus Clash” changed in Lark since you opened it\. Nothing was written\./);
    assert.ok(e.fresh.fields, "the fresh row comes with it, so the page can rebase");
    return true;
  });
  assert.deepEqual(call.state.records[0].fields[FIELD.nextSteps], ["Pitch Deck"], "their change survived");
  assert.ok(!call.state.calls.slice(seen).some((c) => c.url === "/records/batch_update"));
});

test("update: an unrelated change in Lark doesn't block the save", async () => {
  const { call, schema, row } = await opened();
  call.state.edit(row.id, { [FIELD.status]: "In Progress" });
  const res = await ops.updateBrief(call, TABLE, schema, row, st(row.model), st({ ...row.model, venue: "New venue" }));
  assert.deepEqual(res.mismatches, []);
});

test("update: after seeing what changed, the person can overwrite it", async () => {
  const { call, schema, row } = await opened();
  call.state.edit(row.id, { [FIELD.nextSteps]: ["Pitch Deck"] });
  const mine = st(row.model, { nextSteps: ["PM Assignment"] });
  const res = await ops.updateBrief(call, TABLE, schema, row, st(row.model), mine, { force: true });
  assert.deepEqual(call.state.records[0].fields[FIELD.nextSteps], ["PM Assignment"]);
  assert.deepEqual(res.mismatches, []);
});

test("update: an unknown Requirement value in Lark survives a save that doesn't touch it", async () => {
  const { call, schema, row } = await opened();
  call.state.edit(row.id, { [FIELD.requirement]: "RFX (Something new)" });
  const { rows } = await ops.loadBriefs(call, TABLE);
  const fresh = rows[0];
  assert.equal(fresh.requirement, "");
  assert.equal(fresh.requirementRaw, "RFX (Something new)");
  await ops.updateBrief(call, TABLE, schema, fresh, st(fresh.model, { requirement: fresh.requirement }),
    st({ ...fresh.model, summary: "Edited" }, { requirement: fresh.requirement }));
  assert.equal(call.state.records[0].fields[FIELD.requirement], "RFX (Something new)");
});

test("update: picking and clearing choices, attachments and next steps", async () => {
  const { call, schema, row } = await opened();
  let cur = row;
  const r1 = await ops.updateBrief(call, TABLE, schema, cur, st(cur.model),
    st(cur.model, { requirement: "RFQ", vat: "YES", nextSteps: ["Pitch Deck", "Custom step"], attachments: ["tokA"] }));
  assert.deepEqual(r1.mismatches, []);
  cur = r1.row;
  assert.equal(cur.requirement, "RFQ");
  assert.equal(cur.vat, "YES");
  assert.deepEqual(cur.nextSteps.sort(), ["Custom step", "Pitch Deck"]);
  assert.deepEqual(cur.attachments.map((a) => a.token), ["tokA"]);
  const r2 = await ops.updateBrief(call, TABLE, schema, cur,
    st(cur.model, { requirement: "RFQ", vat: "YES", nextSteps: cur.nextSteps, attachments: ["tokA"] }), st(cur.model));
  assert.deepEqual(r2.mismatches, []);
  assert.equal(r2.row.requirement, "");
  assert.deepEqual(r2.row.nextSteps, []);
  assert.deepEqual(r2.row.attachments, []);
});

test("update: nothing changed means nothing is sent", async () => {
  const { call, schema, row } = await opened();
  call.state.calls.length = 0;
  const res = await ops.updateBrief(call, TABLE, schema, row, st(row.model), st(row.model));
  assert.equal(res.nothing, true);
  assert.equal(call.state.calls.length, 0);
});

test("update: a row deleted in Lark meanwhile is reported, nothing is written", async () => {
  const { call, schema, row } = await opened();
  call.state.records.length = 0;
  await assert.rejects(() => ops.updateBrief(call, TABLE, schema, row, st(row.model), st({ ...row.model, venue: "x" })), (e) => e.notFound === true);
});

test("update: Lark refusing a write surfaces as its error", async () => {
  const { call, schema, row } = await opened();
  call.state.fail = { code: 1254302, msg: "forbidden", once: true, when: (m, u) => /batch_update/.test(u) };
  await assert.rejects(() => ops.updateBrief(call, TABLE, schema, row, st(row.model), st({ ...row.model, venue: "x" })), (e) => e.json.code === 1254302);
});

test("done: one cell, read back; a wrong table blocks it", async () => {
  const { call, schema, row } = await opened();
  const res = await ops.setDone(call, TABLE, schema, row.id, true);
  assert.deepEqual(res.written, { [FIELD.done]: "Yes" });
  assert.deepEqual(res.mismatches, []);
  assert.equal(call.state.records[0].fields[FIELD.done], "Yes");
  await ops.setDone(call, TABLE, schema, row.id, false);
  assert.equal(call.state.records[0].fields[FIELD.done], "No");
  const broken = checkAll(liveFields((f) => f.filter((x) => x.field_name !== "Done")));
  await assert.rejects(() => ops.setDone(call, TABLE, broken, row.id, true), WriteBlocked);
});

test("delete removes only that row", async () => {
  const { call } = await opened();
  call.state.add({ [FIELD.title]: "Keep me" });
  const id = call.state.records[0].record_id;
  await ops.deleteBrief(call, TABLE, id);
  assert.deepEqual(call.state.records.map((r) => r.fields[FIELD.title]?.[0]?.text), ["Keep me"]);
});

test("read-back reports what didn't land, and a failed read-back isn't an error", async () => {
  const call = fakeLark();
  const rec = call.state.add({ [FIELD.venue]: "Lark's version", [FIELD.client]: "Acme" });
  const bad = await readBack(call, TABLE, rec.record_id, { [FIELD.venue]: "My version", [FIELD.client]: "Acme" });
  assert.deepEqual(bad.mismatches, [{ field: FIELD.venue, want: "My version", got: "Lark's version" }]);
  const gone = await readBack(call, TABLE, "recNope", { [FIELD.venue]: "x" });
  assert.equal(gone.mismatches, null);
  assert.ok(gone.readBackError);
});

test("verifyWritten compares each format the way Lark returns it", () => {
  const fields = {
    [FIELD.venue]: [{ type: "text", text: "A\r\nB" }], [FIELD.due]: 1000, [FIELD.vat]: ["VAT Ex."], [FIELD.done]: "Yes",
    [FIELD.attachments]: [{ file_token: "t2", name: "x" }, { file_token: "t1" }],
  };
  assert.deepEqual(verifyWritten({
    [FIELD.venue]: "A\nB", [FIELD.due]: 1000.001, [FIELD.vat]: ["VAT Ex."], [FIELD.done]: "Yes",
    [FIELD.attachments]: [{ file_token: "t1" }, { file_token: "t2" }], [FIELD.client]: null, [FIELD.nextSteps]: [],
  }, fields), []);
  const bad = verifyWritten({ [FIELD.due]: 5000, [FIELD.vat]: ["VAT Inc."], [FIELD.done]: "No" }, fields);
  assert.deepEqual(bad.map((b) => b.field), [FIELD.due, FIELD.vat, FIELD.done]);
});

test("safeUpdate: an `expect` that names changed columns stops the write", async () => {
  const call = fakeLark();
  const rec = call.state.add({ [FIELD.venue]: "A" });
  await assert.rejects(() => safeUpdate(call, TABLE, rec.record_id, { [FIELD.venue]: "B" }, { expect: () => [FIELD.venue], label: "Cup" }),
    (e) => e instanceof AlreadyDone && /“Cup” changed in Lark/.test(e.message) && /Venue was edited there\./.test(e.detail));
});

test("tables: fields and records page through, a missing token throws", async () => {
  const call = fakeLark({ pageSize: 10 });
  const fields = await loadFields(call, TABLE);
  assert.equal(fields.length, liveFields().length);
  for (let i = 0; i < 25; i++) call.state.add({ [FIELD.title]: `r${i}` });
  const seen = [];
  const recs = await loadRecords(call, TABLE, [FIELD.title], (n, total) => seen.push([n, total]));
  assert.equal(recs.length, 25);
  assert.deepEqual(seen.at(-1), [25, 25]);
  assert.equal((await getRecord(call, TABLE, recs[3].record_id)).record_id, recs[3].record_id);
});

// ---- the sharing link in "Fetch URL" ----------------------------------------------------
const SHARE = (id) => `https://mineski-stephen.github.io/fetch/#/share/${id}`;
const withLinkType = (type) => liveFields((fs) => fs.map((f) => (f.field_name === FIELD.fetchUrl ? { ...f, type } : f)));

test("a new brief gets its sharing link in Fetch URL (as a link in a URL column)", async () => {
  const { call, made } = await opened();
  const cell = call.state.records.find((r) => r.record_id === made.recordId).fields[FIELD.fetchUrl];
  assert.deepEqual(cell, { link: SHARE(made.recordId), text: SHARE(made.recordId) });
  assert.equal(made.row.fetchUrl, SHARE(made.recordId));
});

test("a text Fetch URL column gets the address; a formula one is never written", async () => {
  const text = await opened({ fields: withLinkType(T.text) });
  assert.equal(text.row.fetchUrl, SHARE(text.made.recordId));
  const formula = await opened({ fields: withLinkType(T.formula) });
  assert.deepEqual(formula.schema.problems, [], "a formula column is fine");
  assert.equal(call0(formula).fields[FIELD.fetchUrl], undefined);
  assert.equal(ops.linkCells(formula.schema, "rec1", ""), null);
});
const call0 = ({ call, made }) => call.state.records.find((r) => r.record_id === made.recordId);

test("a brief without Fetch URL still saves, and the link is written with its next save", async () => {
  const { call, schema, row } = await opened();
  call.state.edit(row.id, { [FIELD.fetchUrl]: { link: "https://old.example/#/briefs/x", text: "old" } });
  const { rows } = await ops.loadBriefs(call, TABLE);
  const fresh = rows.find((r) => r.id === row.id);
  assert.equal(fresh.fetchUrl, "https://old.example/#/briefs/x");
  await ops.updateBrief(call, TABLE, schema, fresh, st(fresh.model), st({ ...fresh.model, venue: "New venue" }));
  assert.equal(call0({ call, made: { recordId: row.id } }).fields[FIELD.fetchUrl].link, SHARE(row.id));
});

test("fixLinks points every old or empty Fetch URL at the sharing view, and only that cell", async () => {
  const { call, schema } = await opened();
  call.state.add({ [FIELD.title]: "Old", [FIELD.json]: JSON.stringify({ project_title: "Old" }),
    [FIELD.fetchUrl]: { link: "https://mineski-stephen.github.io/fetch/#/briefs/recOld", text: "x" } });
  call.state.add({ [FIELD.title]: "Empty", [FIELD.json]: JSON.stringify({ project_title: "Empty" }) });
  const { rows } = await ops.loadBriefs(call, TABLE);
  const seen = call.state.calls.length;
  assert.equal(await ops.fixLinks(call, TABLE, schema, rows), 2);
  const writes = call.state.calls.slice(seen).filter((c) => c.url === "/records/batch_update");
  assert.equal(writes.length, 1);
  for (const r of writes[0].body.records) assert.deepEqual(Object.keys(r.fields), [FIELD.fetchUrl]);
  const again = (await ops.loadBriefs(call, TABLE)).rows;
  assert.ok(again.every((r) => r.fetchUrl === SHARE(r.id)));
  assert.equal(await ops.fixLinks(call, TABLE, schema, again), 0);
});

// ---- the sources file in "Fetch Files" ------------------------------------------------------
test("a new brief can carry its sources file in Fetch Files; without it the cell is left out", async () => {
  const call = fakeLark();
  const { schema } = await ops.loadBriefs(call, TABLE);
  const made = await ops.createBrief(call, TABLE, schema, st(), { filedBy: "Ana", sources: "a.pdf", clientToken: "tok-F", fetchFiles: ["src1"] });
  assert.deepEqual(made.row.fetchFiles.map((f) => f.token), ["src1"]);
  const plain = await ops.createBrief(call, TABLE, schema, st(), { filedBy: "Ana", sources: "a.pdf", clientToken: "tok-G" });
  assert.equal(call.state.records.find((r) => r.record_id === plain.recordId).fields[FIELD.fetchFiles], undefined);
  assert.deepEqual(plain.row.fetchFiles, []);
});

test("a table without Fetch Files is fine: nothing is reported missing", async () => {
  const call = fakeLark({ fields: liveFields((fs) => fs.filter((f) => f.field_name !== FIELD.fetchFiles)) });
  const { schema } = await ops.loadBriefs(call, TABLE);
  assert.deepEqual(schema.problems, []);
  assert.ok(!schema.partial.some((p) => p.includes(FIELD.fetchFiles)));
  assert.ok(schema.missing.has(FIELD.fetchFiles));
});
