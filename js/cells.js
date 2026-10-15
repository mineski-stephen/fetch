/*
 * Reading and comparing Lark cell values. Pure functions: no DOM, no network.
 *
 * Values are in Lark's read format (text as rich-text segments, people as objects,
 * dates as ms timestamps) or its write format (what Fetch sends). Copied from
 * Polaris's sync.js (plain, clean, isBlank, matchOption) plus the date and
 * comparison helpers Fetch needs.
 */

/** Reduce any Bitable cell value to plain text. */
export function plain(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // Text fields arrive as rich-text segments ({type, text}); join those seamlessly.
    const segments = v.length > 0 && v.every((x) => x && typeof x === "object"
      && typeof x.type === "string" && typeof x.text === "string");
    return v.map(plain).filter((s) => s !== "").join(segments ? "" : ", ");
  }
  if (typeof v === "object") {
    if ("value" in v) return plain(v.value);                 // formula / lookup
    if (typeof v.text === "string") return v.text;            // text segment, URL field
    if (typeof v.name === "string") return v.name;            // person, attachment
    if (Array.isArray(v.text_arr)) return v.text_arr.join(", ");
  }
  return "";
}

/** Plain text with Windows line endings and outer whitespace removed. */
export const clean = (v) => plain(v).replace(/\r\n?/g, "\n").trim();

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A number from a number column or a formula ({type, value: [n]}). */
export const numOf = (v) => num(v) ?? (v && typeof v === "object" && Array.isArray(v.value) ? num(v.value[0]) : null);

/** Blank as Lark shows it: no value, empty text, an empty list. Zero isn't blank. */
export function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) {
    return v.every((x) => x === null || x === undefined || x === ""
      || (typeof x === "object" && !x.id && !x.file_token && plain(x).trim() === ""));
  }
  if (typeof v === "number") return Number.isNaN(v);
  if (typeof v === "object" && "value" in v) return isBlank(v.value);
  if (typeof v === "object" && "link" in v) return !v.link;
  return false;
}

/** Select options are matched loosely ("PDEI - Event Service" fits "PDEI-Event Service") but
 *  always written using the option's own name, so a write never creates an option by accident. */
const optionKey = (s) => String(s || "").toLowerCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
export function matchOption(value, options) {
  const k = optionKey(value);
  return k ? (options || []).find((o) => optionKey(o) === k) || null : null;
}

// ---- dates ------------------------------------------------------------------
/** "2026-10-16" -> midnight of that day in the Base's zone, as ms (how Lark stores date-only cells). */
export function toLarkDay(iso, offsetMinutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const back = new Date(t);
  if (back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3]) return null;
  return t - (offsetMinutes || 0) * 60000;
}

/** A Lark date-only cell (ms) -> "2026-10-16" ("" when it isn't a date). */
export const fromLarkDay = (ms, offsetMinutes) =>
  (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms + (offsetMinutes || 0) * 60000).toISOString().slice(0, 10) : "");

// ---- comparing cells ------------------------------------------------------------
/** One canonical string for a cell, in either format, so two cells can be compared:
 *  text via clean, selects by option names, attachments by file tokens, people by ids. */
export function canon(v) {
  if (isBlank(v)) return "";
  const obj = (x) => x !== null && typeof x === "object";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return [...v].sort().join("\n");
    if (v.every((x) => obj(x) && "file_token" in x)) return v.map((x) => x.file_token).sort().join(",");
    if (v.every((x) => obj(x) && typeof x.id === "string")) return v.map((x) => x.id).sort().join(",");
    const segments = v.every((x) => obj(x) && typeof x.type === "string" && typeof x.text === "string");
    if (!segments) return v.map(canon).sort().join("\n");   // multi-select read back as {text} objects
  }
  if (obj(v) && !Array.isArray(v) && "value" in v) return canon(v.value);
  return clean(v);
}

export const sameCell = (a, b) => canon(a) === canon(b);

/** A short fingerprint of a cell (FNV-1a, base 36): small enough to keep for every column of every row. */
export function cellSig(v) {
  let h = 0x811c9dc5;
  const s = canon(v);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
