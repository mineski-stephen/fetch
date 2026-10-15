/*
 * Checking what Lark holds: read-back after a write, and the re-read before an update.
 * Takes `call` like tables.js, so the page and the Node checks run the same code.
 */
import { getRecord, updateRecord } from "./tables.js";
import { plain, clean } from "./cells.js";
import { AlreadyDone } from "./errors.js";

export { AlreadyDone };

/** Compare what was written (write format) with the record Lark returns (read format).
 *  Returns [{field, want, got}] for every field that didn't land as sent. */
export function verifyWritten(expected, actualFields) {
  const bad = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = (actualFields || {})[name];
    if (!sameValue(want, got)) bad.push({ field: name, want: show(want), got: show(got) });
  }
  return bad;
}

function sameValue(want, got) {
  if (want === null) return got === null || got === undefined || got === "" || (Array.isArray(got) && !got.length);
  const isObj = (x) => x !== null && typeof x === "object";
  if (Array.isArray(want) && want.every((x) => typeof x === "string")) {   // multi-select: compare the option names
    const names = (a) => (Array.isArray(a) ? a : isObj(a) && Array.isArray(a.value) ? a.value : [])
      .map((x) => (typeof x === "string" ? x : plain(x))).filter(Boolean).sort().join("\n");
    return names(want) === names(got);
  }
  if (Array.isArray(want) && want.every((x) => isObj(x) && "file_token" in x)) {   // attachments: compare tokens
    const toks = (a) => (Array.isArray(a) ? a : []).map((x) => isObj(x) && x.file_token).filter(Boolean).sort().join(",");
    return toks(want) === toks(got);
  }
  if (Array.isArray(want)) {                                    // people: compare ids
    const ids = (a) => (Array.isArray(a) ? a : []).map((u) => u && u.id).filter(Boolean).sort().join(",");
    return ids(want) === ids(got);
  }
  if (typeof want === "number") return typeof got === "number" && Math.abs(got - want) < 0.005;
  if (typeof want === "boolean") return (got === true) === want;
  return clean(got) === String(want).replace(/\r\n?/g, "\n").trim();
}

function show(v) {
  if (v === null || v === undefined) return "(empty)";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ") || "(empty)";
  if (Array.isArray(v) && v.every((x) => x && typeof x === "object" && "file_token" in x)) {
    return `${v.length} file${v.length === 1 ? "" : "s"}`;
  }
  if (typeof v === "number") return String(v);
  const t = plain(v);
  return t ? (t.length > 80 ? `${t.slice(0, 77)}…` : t) : "(empty)";
}

/** After a write has succeeded: read the record back and compare. A failed read doesn't undo
 *  the write, so it's reported as `readBackError`, not thrown. `record` is the row as Lark holds it. */
export async function readBack(call, t, recordId, written) {
  try {
    const record = await getRecord(call, t, recordId);
    return { mismatches: verifyWritten(written, record.fields), readBackError: null, record };
  } catch (e) {
    return { mismatches: null, readBackError: e, record: null };
  }
}

/** The cells to write, and only those. Writes nothing and throws AlreadyDone when the row changed:
 *    1. re-read the row,
 *    2. `expect(freshFields)` returns "" when the cells still are what the page loaded, or the
 *       list of column names that changed (then nothing is written),
 *    3. write only `patch`,
 *    4. read back and compare.
 *  Resolves { recordId, written, mismatches, readBackError, record }. */
export async function safeUpdate(call, t, recordId, patch, { expect, label } = {}) {
  const now = await getRecord(call, t, recordId);
  const changed = expect ? expect(now.fields || {}) : [];
  if (changed && changed.length) {
    throw new AlreadyDone(`${label ? `“${label}”` : "That brief"} changed in Lark since you opened it. Nothing was written.`,
      `${changed.join(", ")} ${changed.length === 1 ? "was" : "were"} edited there.`, { changed, fresh: now });
  }
  await updateRecord(call, t, recordId, patch);
  return { recordId, written: patch, ...await readBack(call, t, recordId, patch) };
}
