/*
 * Which quote belongs to a field in the document ("Check sources"). Pure functions: no DOM.
 *
 * The service returns evidence keyed by paths in the brief as extracted
 * (draft.original): venue, budget.amount, kpis.0, scope_of_work.1. The user may
 * since have reordered, deleted, added or edited list items, so a list item is
 * matched to its original by text rather than by position. Nothing is reindexed
 * when the document changes.
 */

const LISTS = ["objectives", "target_audience", "kpis", "key_dates", "scope_of_work", "notes", "clarifications"];

// Paths with no quote of their own borrow one: the chip beside a value, or the due-date note.
const ALIASES = {
  "budget.type": ["budget.type", "budget.amount"],
  "proposal_submission.type": ["proposal_submission.type", "proposal_submission.details"],
  "proposal_submission.details": ["proposal_submission.details", "proposal_submission.type"],
  "due_date.date": ["due_date"],
  "due_date.note": ["due_date"],
};

const text = (item) => (item && typeof item === "object" ? Object.values(item).join(" ") : String(item ?? ""));
const simple = (s) => text(s).toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => new Set(simple(s).match(/[\p{L}\p{N}]+/gu) || []);

/** Share of words two texts have in common (0-1). */
export function overlap(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  x.forEach((w) => { if (y.has(w)) both++; });
  return both / (x.size + y.size - both);
}

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Index in `originals` of the item `current` started as, or -1 (added or rewritten). */
function originalIndex(current, originals, k) {
  const want = simple(current);
  if (!want) return -1;
  if (simple(originals[k]) === want) return k;
  const exact = originals.findIndex((o) => simple(o) === want);
  if (exact >= 0) return exact;
  let best = -1, score = 0.6;   // tolerate small edits, not a rewrite
  originals.forEach((o, i) => {
    const s = overlap(current, o);
    if (s >= score) { best = i; score = s; }
  });
  return best;
}

/**
 * The quote for a document path (a data-path in doc.js), or why there is none.
 * Returns { ev, field, edited, extracted } where ev is {field, source, page, quote}
 * or null, and `why` is "added" (list item not in the extraction) or "none".
 */
export function resolve(path, model, original, evidence) {
  const byField = new Map((Array.isArray(evidence) ? evidence : []).map((e) => [e.field, e]));
  const [name, k] = path.split(".");
  if (LISTS.includes(name) && /^\d+$/.test(k ?? "")) {
    const current = model?.[name]?.[Number(k)];
    const originals = Array.isArray(original?.[name]) ? original[name] : [];
    const i = current === undefined ? -1 : originalIndex(current, originals, Number(k));
    if (i < 0) return { ev: null, why: "added" };
    const ev = byField.get(`${name}.${i}`) || null;
    const extracted = text(originals[i]);
    return { ev, field: `${name}.${i}`, edited: simple(current) !== simple(originals[i]), extracted, why: ev ? "" : "none" };
  }
  for (const field of ALIASES[path] || [path]) {
    const ev = byField.get(field);
    if (!ev) continue;
    const valuePath = field === "due_date" ? "due_date.date" : field;
    const now = get(model, valuePath), then = get(original, valuePath);
    return { ev, field, edited: simple(now) !== simple(then), extracted: text(then), why: "" };
  }
  return { ev: null, why: "none" };
}

/**
 * The passages of an evidence entry: [{ source, page, quote }]. Service 1.7 sends several per
 * field ({ field, passages }); drafts from 1.6 hold one ({ field, source, page, quote }).
 */
export function passagesOf(ev) {
  if (!ev) return [];
  const list = Array.isArray(ev.passages) ? ev.passages : [ev];
  return list.filter((p) => p && p.quote && p.source >= 1)
    .map((p) => ({ source: Number(p.source), page: Number(p.page) || 0, quote: String(p.quote) }));
}

/** True when a path has a passage to show (for styling fields in checking mode). */
export const has = (path, model, original, evidence) => !!resolve(path, model, original, evidence).ev;
