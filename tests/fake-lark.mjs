/* A small in-memory stand-in for the Lark Bitable endpoints Fetch uses, as a `call(method, url,
   body, opts)` (the shape tables.js takes). It answers like Lark does: text cells come back as
   rich-text segments, dates as ms, attachments with names, a create with a repeated client_token
   returns the first record, and Lark's errors arrive as LarkError with `json: { code, msg }`.
   Used by the offline tests, so ops.js and verify.js run against something with Lark's shape. */

import { COLUMNS, T } from "../js/schema.js";
import { LarkError } from "../js/errors.js";

/** The live `fields` of a table that matches the spec exactly. */
export function liveFields(mutate = (f) => f) {
  return mutate(COLUMNS.map((c, i) => ({
    field_id: `fld${i}`, field_name: c.name, type: c.type, is_primary: !!c.primary,
    property: c.options ? { options: c.options.map((name, k) => ({ id: `opt${i}_${k}`, name, color: k })) } : null,
  })));
}

const toRead = (field, v) => {
  if (v === null || v === undefined) return undefined;
  if (field.type === T.text) return typeof v === "string" && v ? [{ type: "text", text: v }] : undefined;
  if (field.type === T.attachment) return v.length ? v.map((a) => ({ file_token: a.file_token, name: `${a.file_token}.pdf`, size: 1000, url: "https://expires.example/x" })) : undefined;
  if (Array.isArray(v) && !v.length) return undefined;
  return v;
};

export function fakeLark({ fields = liveFields(), pageSize = 500, now = () => 1790000000000 } = {}) {
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const state = { records: [], tokens: new Map(), seq: 0, calls: [], fail: null };
  const fail = (code, msg) => { throw new LarkError("Lark error", { status: 200, json: { code, msg } }); };

  const write = (rec, cells) => {
    for (const [name, v] of Object.entries(cells)) {
      const f = byName.get(name);
      if (!f) fail(1254045, "FieldNameNotFound");
      const read = toRead(f, v);
      if (read === undefined) delete rec.fields[name]; else rec.fields[name] = read;
    }
    rec.fields["Last Modified"] = now();
  };
  const page = (items, url, body) => {
    const u = new URL(url);
    const size = pageSize < 500 ? pageSize : Number(u.searchParams.get("page_size")) || pageSize;   // a small pageSize forces paging
    const start = Number(u.searchParams.get("page_token") || 0);
    const slice = items.slice(start, start + size);
    const more = start + size < items.length;
    const data = { items: slice, has_more: more, total: items.length };
    if (more && !(state.noPageToken)) data.page_token = String(start + size);
    return data;
  };
  const pick = (rec, names) => ({ record_id: rec.record_id,
    fields: Object.fromEntries(Object.entries(rec.fields).filter(([k]) => !names || names.includes(k))) });

  async function call(method, url, body = {}) {
    state.calls.push({ method, url: url.replace(/^.*\/tables\/[^/]+/, ""), body });
    if (state.fail) { const f = state.fail; if (!f.when || f.when(method, url)) { state.fail = f.once ? null : f; fail(f.code, f.msg); } }
    const path = url.replace(/^.*\/tables\/[^/?]+/, "").split("?")[0];
    if (method === "GET" && path === "/fields") return { code: 0, data: page(fields, url) };
    if (method === "POST" && path === "/records/search") {
      for (const n of body.field_names || []) if (!byName.has(n)) fail(1254045, "FieldNameNotFound");
      const data = page(state.records, url);
      data.items = data.items.map((r) => pick(r, body.field_names));
      return { code: 0, data };
    }
    if (method === "POST" && path === "/records/batch_get") {
      return { code: 0, data: { records: state.records.filter((r) => body.record_ids.includes(r.record_id)).map((r) => pick(r)) } };
    }
    if (method === "POST" && path === "/records") {
      const token = new URL(url).searchParams.get("client_token");
      if (token && state.tokens.has(token)) return { code: 0, data: { record: pick(state.tokens.get(token)) } };
      const rec = { record_id: `rec${++state.seq}`, fields: {} };
      write(rec, body.fields);
      state.records.push(rec);
      if (token) state.tokens.set(token, rec);
      return { code: 0, data: { record: pick(rec) } };
    }
    if (method === "POST" && path === "/records/batch_update") {
      const out = body.records.map((u) => {
        const rec = state.records.find((r) => r.record_id === u.record_id);
        if (!rec) fail(1254043, "RecordIdNotFound");
        write(rec, u.fields);
        return pick(rec);
      });
      return { code: 0, data: { records: out } };
    }
    if (method === "POST" && path === "/records/batch_delete") {
      state.records = state.records.filter((r) => !body.records.includes(r.record_id));
      return { code: 0, data: { records: body.records.map((id) => ({ deleted: true, record_id: id })) } };
    }
    throw new Error(`fake Lark: no answer for ${method} ${url}`);
  }

  /** Put a row in the table as if someone had typed it in Lark. `cells` are in write format. */
  state.add = (cells) => {
    const rec = { record_id: `rec${++state.seq}`, fields: {} };
    write(rec, cells);
    state.records.push(rec);
    return rec;
  };
  /** Someone edits a cell in Lark. */
  state.edit = (id, cells) => write(state.records.find((r) => r.record_id === id), cells);
  return Object.assign(call, { state, fields });
}

export const TABLE = { app: "appFake", table: "tblFake", view: "", url: "https://mineskiglobal.larksuite.com/base/appFake?table=tblFake" };
