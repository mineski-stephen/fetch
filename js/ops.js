/*
 * Every Lark read and write Fetch makes on the briefs table, as functions of
 * `call(method, url, body, opts)` (see tables.js). The page passes one that goes through
 * the Lark proxy with the signed-in person's token; tests/check-live.mjs and tests/e2e.mjs
 * pass one that calls Lark directly, so they run exactly the same logic.
 *
 * Writes: the cells that changed (never blanks or placeholders), selects through
 * matchOption, a re-read before an update, a read-back after, and the row as Lark
 * holds it afterwards (not one rebuilt locally).
 */
import { loadFields, loadRecords, getRecord, createRecord, updateRecord, deleteRecords, tableUrl } from "./tables.js";
import { checkAll, blockers, presentColumns, tableSpec, FIELD, DONE } from "./schema.js";
import { fromRecord, newRowCells, changedCells, toFields, describeSkipped, shareUrl, linkCell } from "./rows.js";
import { readBack, safeUpdate, verifyWritten } from "./verify.js";
import { cellSig, matchOption } from "./cells.js";
import { WriteBlocked } from "./errors.js";

/** Read the columns, check them, then read every brief. Resolves { rows, schema }. */
export async function loadBriefs(call, t, onPage) {
  const fields = await loadFields(call, t);
  const schema = checkAll(fields);
  const records = await loadRecords(call, t, presentColumns(fields, tableSpec()), onPage);
  return { rows: records.map(fromRecord), schema };
}

/** Why this write can't go ahead (schema problems, values Lark has no option for), or nothing. */
function readyToWrite(schema, cells, options) {
  const fields = toFields(cells, schema && schema.checked ? schema.options : undefined);
  const why = [...blockers(schema, Object.keys(cells)), ...describeSkipped(fields.skipped)];
  if (why.length) throw new WriteBlocked(why);
  return fields.fields;
}

/** The live "Fetch URL" column, if Fetch writes it (a URL or text column; a formula fills itself). */
function linkColumn(schema) {
  const f = schema && schema.checked ? (schema.fields || []).find((x) => x.field_name === FIELD.fetchUrl) : null;
  return f && (f.type === 15 || f.type === 1) ? f : null;
}

/** The cells that point a row's "Fetch URL" at its sharing link, or null if nothing to write. */
export function linkCells(schema, recordId, current) {
  const col = linkColumn(schema);
  const url = shareUrl(recordId);
  return col && current !== url ? { [FIELD.fetchUrl]: linkCell(url, col.type) } : null;
}

/** A new row, then a read-back. `state` is { model, nextSteps, requirement, vat, attachments: [token] }.
 *  The client token makes a retry idempotent: the same token returns the first record. */
export async function createBrief(call, t, schema, state, { filedBy, sources, clientToken, fetchFiles }) {
  const fields = readyToWrite(schema, newRowCells(state, { filedBy, sources, fetchFiles }));
  const rec = await createRecord(call, t, fields, clientToken);
  let back = await readBack(call, t, rec.record_id, fields);
  // Lark answered a replayed token with an older attempt's row: bring it up to the current payload.
  if (back.mismatches && back.mismatches.some((m) => m.field === FIELD.json)) {
    const stale = Object.fromEntries(Object.entries(fields).filter(([k]) => back.mismatches.some((m) => m.field === k)));
    await updateRecord(call, t, rec.record_id, stale);
    back = await readBack(call, t, rec.record_id, fields);
  }
  const row = fromRecord(back.record || rec);
  // Its sharing link, now that Lark has given it an id. A failure here never fails the save:
  // the link is written again on the next save, or with "Update them" in All briefs.
  const link = linkCells(schema, rec.record_id, row.fetchUrl);
  if (link) {
    try { await updateRecord(call, t, rec.record_id, link); row.fetchUrl = shareUrl(rec.record_id); } catch (_) { /* see above */ }
  }
  return { recordId: rec.record_id, written: fields, ...back, row };
}

/** Save an opened brief. `row` is the row as the page loaded it (its `sig` says what Lark held then);
 *  `before` and `after` are states (see createBrief). Only the cells that differ are written, and
 *  only if those cells still hold what the page loaded.
 *  `force`: write even though they changed (the person saw what changed and chose to overwrite). */
export async function updateBrief(call, t, schema, row, before, after, { force = false } = {}) {
  const cells = changedCells(before, after);
  if (!Object.keys(cells).length) return { recordId: row.id, written: {}, mismatches: [], readBackError: null, record: null, row, nothing: true };
  const fields = { ...readyToWrite(schema, cells), ...linkCells(schema, row.id, row.fetchUrl) };   // the link, while we're at it
  const expect = force || !row.sig ? null : (fresh) =>
    Object.keys(fields).filter((col) => col !== FIELD.fetchUrl && col in row.sig && cellSig(fresh[col]) !== row.sig[col]);
  const res = await safeUpdate(call, t, row.id, fields, { expect, label: row.model && row.model.project_title });
  return { ...res, row: res.record ? fromRecord(res.record) : row };
}

/** Move a brief to Done (or back). One cell, so no re-read: the read-back tells if it stuck. */
export async function setDone(call, t, schema, id, done) {
  const live = schema && schema.checked ? schema.options[FIELD.done] : undefined;
  const value = live ? matchOption(done ? DONE.yes : DONE.no, live) : (done ? DONE.yes : DONE.no);
  const why = [...blockers(schema, [FIELD.done])];
  if (!value) why.push(`“${FIELD.done}” has no option “${done ? DONE.yes : DONE.no}” in Lark.`);
  if (why.length) throw new WriteBlocked(why);
  const written = { [FIELD.done]: value };
  await updateRecord(call, t, id, written);
  return { recordId: id, written, ...await readBack(call, t, id, written) };
}

/**
 * Point every row's "Fetch URL" at its sharing link (old #/briefs/ links, typed ones, empty ones).
 * Only that one cell is written, in batches of 500. Resolves with how many rows were updated.
 */
export async function fixLinks(call, t, schema, rows) {
  const why = blockers(schema, [FIELD.fetchUrl]);
  if (why.length) throw new WriteBlocked(why);
  const todo = rows.map((r) => ({ record_id: r.id, fields: linkCells(schema, r.id, r.fetchUrl) })).filter((r) => r.fields);
  for (let i = 0; i < todo.length; i += 500) {
    await call("POST", `${tableUrl(t)}/records/batch_update`, { records: todo.slice(i, i + 500) });
  }
  return todo.length;
}

/** Delete a brief for good (batch endpoint: the proxy only forwards GET and POST). */
export async function deleteBrief(call, t, id) {
  await deleteRecords(call, t, [id]);
  return { recordId: id };
}

export { getRecord, verifyWritten };
