/*
 * Lark Base table access: links, fields, records.
 *
 * Every function takes `call(method, url, body, opts)`, which sends one Lark Open API
 * request and resolves with its JSON body (or throws). The page passes one that goes
 * through the Lark proxy with the signed-in person's token; the Node checks in tests/
 * pass one that calls Lark directly. Both therefore run exactly the same logic.
 * Reads pass { read: true }, so the page may retry them; writes are never retried.
 */
import { LARK } from "./config.js";

export const PAGE_SIZE = 500;   // Lark's max for records/search
const MAX_PAGES = 200;          // runaway guard: 100,000 records
const PAGE_DELAY_MS = 120;      // pause between pages to stay clear of rate limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "https://<tenant>.larksuite.com/base/<app>?table=<tbl>&view=<vew>" -> {app, table, view, url}.
 *  Throws a plain sentence for anything else (a wiki link, no table, not a link). */
export function parseBaseLink(link) {
  let u;
  try { u = new URL(String(link || "").trim()); } catch (_) { throw new Error("That isn't a link."); }
  if (u.protocol !== "https:") throw new Error("A Lark link starts with https://");
  if (/\/wiki\//.test(u.pathname)) throw new Error("That's a wiki page. Open the Base itself and copy its link.");
  const app = (u.pathname.match(/\/base\/([A-Za-z0-9]+)/) || [])[1];
  const table = u.searchParams.get("table") || "";
  if (!app || !/^tbl[A-Za-z0-9]+$/.test(table)) {
    throw new Error("That isn't a Lark table link. Copy it from the table's address bar (…/base/…?table=…).");
  }
  return { app, table, view: u.searchParams.get("view") || "", url: u.toString() };
}

export const tableUrl = (t) =>
  `${LARK.api}/bitable/v1/apps/${encodeURIComponent(t.app)}/tables/${encodeURIComponent(t.table)}`;

// ---- reads ---------------------------------------------------------------------
export async function loadFields(call, t) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await call("GET", `${tableUrl(t)}/fields?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
      undefined, { read: true });
    const d = j.data || {};
    out.push(...(d.items || []));
    if (!d.has_more) return out;
    if (!d.page_token) throw new Error("Lark said there are more columns but gave no page token.");
    pageToken = d.page_token;
  }
  throw new Error(`Stopped after ${MAX_PAGES} pages of columns.`);
}

/** All records of a table. Never through a view (views filter rows) and never a partial list:
 *  a truncated list would look like missing rows, so it throws instead. */
export async function loadRecords(call, t, fieldNames, onPage) {
  const items = [];
  let pageToken = "";
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const body = { automatic_fields: false };
    if (fieldNames) body.field_names = fieldNames;
    const j = await call("POST", `${tableUrl(t)}/records/search?page_size=${PAGE_SIZE}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
      body, { read: true });
    const d = j.data || {};
    items.push(...(d.items || []));
    if (onPage) onPage(items.length, typeof d.total === "number" ? d.total : null);
    if (!d.has_more) return items;
    if (!d.page_token) throw new Error("Lark said there are more briefs but gave no page token, so the list would be incomplete.");
    pageToken = d.page_token;
    await sleep(PAGE_DELAY_MS);
  }
  throw new Error(`Stopped after ${MAX_PAGES} pages; the table is larger than Fetch supports.`);
}

/** One record, by batch_get: the single-record GET returns display formats (numbers as text)
 *  that don't match what search returns or what was written. */
export async function getRecord(call, t, recordId) {
  const j = await call("POST", `${tableUrl(t)}/records/batch_get`, { record_ids: [recordId] }, { read: true });
  const rec = ((j.data && j.data.records) || []).find((r) => r.record_id === recordId);
  if (!rec) throw Object.assign(new Error(`Record ${recordId} isn't in the table.`), { notFound: true });
  return rec;
}

// ---- writes (never retried) --------------------------------------------------------
export function newClientToken() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** client_token makes the create idempotent: retrying after a lost response with the same
 *  token returns the first record instead of adding another. */
export async function createRecord(call, t, fields, clientToken) {
  const j = await call("POST", `${tableUrl(t)}/records${clientToken ? `?client_token=${encodeURIComponent(clientToken)}` : ""}`, { fields });
  const rec = j.data && j.data.record;
  if (!rec || !rec.record_id) throw new Error("Lark didn't return the new record.");
  return rec;
}

/** batch_update is a POST, so every write goes through the proxy's POST route. */
export async function updateRecord(call, t, recordId, fields) {
  await call("POST", `${tableUrl(t)}/records/batch_update`, { records: [{ record_id: recordId, fields }] });
}

export async function deleteRecords(call, t, recordIds) {
  await call("POST", `${tableUrl(t)}/records/batch_delete`, { records: recordIds });
}
