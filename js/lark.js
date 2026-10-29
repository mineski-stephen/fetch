/*
 * Lark Base client for the page. Every call runs as the signed-in person (their
 * user_access_token from auth.js), so Lark applies their own permissions on the Base.
 * Calls go through the Lark CORS proxy (net.js):
 *   POST {proxy}/proxy?url=<lark api>   -> forwarded with the user's Bearer token
 * The reads and writes themselves are in ops.js (they take `call`, so Node reuses them);
 * this module adds the token, the table from Settings, and the live schema check.
 *
 * Column names are in schema.js; tools/setup_lark_table.py creates them from the same list.
 */
import * as auth from "./auth.js";
import { lark, larkUpload, larkDownload, LarkError } from "./net.js";
import { cfg } from "./settings.js";
import { LARK } from "./config.js";
import { WriteBlocked } from "./errors.js";
import { newClientToken, getRecord } from "./tables.js";
import { downloadRequest, downloadLink, fileRequest, shareUrl } from "./rows.js";
import { FIELD, T } from "./schema.js";
import * as ops from "./ops.js";

/** The live check of the table's columns: { checked, problems, partial, missing, options, fields }. */
const schema = { checked: false, problems: [], partial: [], missing: new Set(), options: {}, fields: [] };

/** The table Fetch reads and writes: from Settings or the config. */
function table() {
  const t = cfg().table;
  if (!t) throw new WriteBlocked([], "Fetch has no briefs table set for this environment. Tell the tool owner.");
  return t;
}

/** The signed-in user's token; if the login has ended, the app shows the login screen. */
function token() {
  const value = auth.token();
  if (!value) {
    auth.end();
    throw new LarkError("login ended", { deadToken: true });
  }
  return value;
}

/** One Lark call with the person's token. Reads pass { read: true } (retried while the proxy wakes);
 *  everything else is a write: 120 s, never retried. */
const call = (method, url, body, opts = {}) =>
  lark(method, url, { token: token(), body, read: !!opts.read, write: !opts.read && method !== "GET" });

/** Read the columns, check them, then read every brief (oldest first, as Lark returns them). */
async function listAll(onProgress) {
  const { rows, schema: checked } = await ops.loadBriefs(call, table(), onProgress);
  Object.assign(schema, checked);
  return rows;
}

/** A new row. `state`: { model, nextSteps, requirement, vat, attachments: [file_token] }. */
const create = (state, extra, clientToken = newClientToken()) =>
  auth.track(() => ops.createBrief(call, table(), schema, state, { ...extra, clientToken }));

/** Save an opened brief: only the cells that changed, and only if they still hold what was loaded. */
const update = (row, before, after, opts) =>
  auth.track(() => ops.updateBrief(call, table(), schema, row, before, after, opts));

const setDone = (id, done) => auth.track(() => ops.setDone(call, table(), schema, id, done));

const remove = (id) => auth.track(() => ops.deleteBrief(call, table(), id));

/** Upload one file into the Base (Drive "media" API) and return its file_token. */
async function uploadFile(file) {
  if (file.size > LARK.maxUploadMb * 1048576) {
    throw new LarkError("too large", { json: { code: 413, msg: `“${file.name}” is over ${LARK.maxUploadMb} MB, the most the connection service takes. Compress it first.` } });
  }
  const t = table();
  const form = new FormData();
  form.append("file_name", file.name);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", t.app);
  form.append("size", String(file.size));
  form.append("extra", JSON.stringify({ bitablePerm: { tableId: t.table } }));   // advanced-permission Bases
  form.append("file", file, file.name);   // the browser sets the multipart boundary
  const { json, status } = await larkUpload(`${LARK.api}/drive/v1/medias/upload_all`, form, { token: token() });
  if (status === 413 || /too large/i.test(json.error || json.msg || "")) {
    throw new LarkError("too large", { json: { code: 413, msg: `“${file.name}” is too large for the connection service.` } });
  }
  if (Number(json.code) !== 0 || !json.data || !json.data.file_token) throw new LarkError("Lark error", { status, json });
  return json.data.file_token;
}

/**
 * One attachment of a filed brief, for downloading: { blob } (the file itself, fetched through
 * the proxy, so the page can save it under its own name) or, if Lark won't hand the bytes to
 * the proxy, { link } (a temporary address, valid about a day). `column`: the attachment column
 * it's in (Attachments, or Fetch Files for the brief's sources). The row is read again first:
 * its cell says how to ask (the Base's permission context) and whether the file is still there.
 */
async function attachmentFile(recordId, fileToken, column = FIELD.attachments) {
  const t = table();
  const rec = await getRecord(call, t, recordId);
  const direct = fileRequest(rec.fields, fileToken, t.table, column);
  if (!direct) throw new LarkError("gone", { json: { code: 404, msg: "This file is no longer attached to the brief in Lark. Reload the brief." } });
  try {
    return { blob: await larkDownload(direct, { token: token() }) };
  } catch (err) {
    if (err.deadToken) throw err;
    const json = await call("GET", downloadRequest(rec.fields, fileToken, t.table, column), null, { read: true }).catch(() => null);
    const link = downloadLink(json, fileToken);
    if (!link) throw err;
    return { link };
  }
}

/**
 * The "Fetch URL" column versus the briefs: { todo } rows whose link isn't their sharing link yet,
 * and whether Fetch can write it (`formula`: Lark fills it, so its formula needs changing instead).
 */
function linkStatus(rows) {
  const col = (schema.fields || []).find((f) => f.field_name === FIELD.fetchUrl);
  if (!schema.checked || !col) return { todo: 0, formula: false, missing: !!schema.checked && !col };
  const todo = (rows || []).filter((r) => r.fetchUrl !== shareUrl(r.id)).length;
  return { todo, formula: col.type === T.formula, missing: false };
}

/** Point every brief's "Fetch URL" at its sharing link. Resolves with how many were updated. */
const fixLinks = (rows) => auth.track(() => ops.fixLinks(call, table(), schema, rows));

export { schema, listAll, create, update, setDone, remove, uploadFile, attachmentFile, linkStatus, fixLinks, newClientToken as uuid };
