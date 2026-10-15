/*
 * Brief <-> Lark row. Pure functions: no DOM, no network, no location.
 *
 * The readable columns are a projection of the brief (written from the "Brief JSON"
 * column's document); Status, Done, Next Steps, Requirement, VAT, Attachments and
 * Due Date belong to Lark and are written only when the person changed them here.
 *
 * Writes never contain a blank or a placeholder ("Not specified", "Untitled Project"):
 * empty values are left out, and a cell is cleared (null) only when the person
 * emptied it. Select values go through matchOption against the live options.
 */
import * as B from "./brief.js";
import { RULES, LARK } from "./config.js";
import { FIELD, COLUMNS, SINGLE_SELECTS, MULTI_SELECTS, DONE } from "./schema.js";
import { plain, clean, matchOption, toLarkDay, fromLarkDay, canon, sameCell, cellSig } from "./cells.js";

export { FIELD };

// ---- reading a row ---------------------------------------------------------------
const lineBreaks = (s) => String(s).split("\n").map((l) => l.replace(/^\s*(?:•|\d+\.)\s*/, "").trim())
  .filter((l) => l && !B.isMissing(l));
const splitLines = (v) => lineBreaks(plain(v).replace(/\r\n?/g, "\n"));

/** Map a Lark option name ("RFQ (Request for Quotation)", "No ") back to its key.
 *  `raw` keeps what Lark holds, so an option Fetch doesn't know is never lost on save. */
function matchChoice(choices, value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return { key: "", raw: "" };
  const key = Object.keys(choices).find((k) => choices[k].label.trim().toLowerCase() === v || v.startsWith(k.toLowerCase())) || "";
  return { key, raw: key ? "" : String(value).trim() };
}

/** A fingerprint of every column, so a save can tell what changed in Lark since the page read the row. */
export const sigs = (fields) => Object.fromEntries(COLUMNS.map((c) => [c.name, cellSig((fields || {})[c.name])]));

/** Rebuild a brief from a row: the JSON column first, the readable columns as a fallback. */
export function fromRecord(rec) {
  const f = rec.fields || {};
  const tz = LARK.tzOffsetMinutes;
  let model = null, newer = 0;
  try { model = JSON.parse(clean(f[FIELD.json])); } catch (_) { /* fall back below */ }
  if (model && typeof model === "object") {
    if (B.isNewer(model)) newer = Number(model.schema_version);   // written by a newer Fetch: read-only here
  } else {
    const [period, ...keyDates] = plain(f[FIELD.period]).split("\n");
    model = {
      project_title: clean(f[FIELD.title]), client_name: clean(f[FIELD.client]),
      date_filed: fromLarkDay(f[FIELD.filed], tz), due_date: { date: fromLarkDay(f[FIELD.due], tz), note: "" },
      event_period: period, key_dates: keyDates.map((l) => {
        const [date, ...rest] = l.replace(/^•\s*/, "").split(" - ");
        return { date, label: rest.join(" - ") };
      }),
      venue: clean(f[FIELD.venue]), objectives: splitLines(f[FIELD.objective]),
      target_audience: splitLines(f[FIELD.audience]), kpis: splitLines(f[FIELD.kpis]),
      scope_of_work: splitLines(f[FIELD.scope]).map((l) => {
        const i = l.indexOf(": ");
        return i > 0 ? { item: l.slice(0, i), detail: l.slice(i + 2) } : { item: "", detail: l };
      }),
      budget: { amount: clean(f[FIELD.budget]), type: clean(f[FIELD.budgetType]).toUpperCase() },
      proposal_submission: { type: clean(f[FIELD.submission]).toUpperCase(), details: clean(f[FIELD.submissionDetails]) },
      notes: splitLines(f[FIELD.notes]), clarifications: splitLines(f[FIELD.questions]),
      summary: clean(f[FIELD.summary]),
    };
  }
  // If someone changes the Due Date column in Lark, that wins over the JSON.
  if (typeof f[FIELD.due] === "number") model.due_date = { ...(model.due_date || {}), date: fromLarkDay(f[FIELD.due], tz) };
  const nextSteps = Array.isArray(f[FIELD.nextSteps]) ? f[FIELD.nextSteps] : f[FIELD.nextSteps] ? [f[FIELD.nextSteps]] : [];
  const req = matchChoice(RULES.requirementTypes, clean(f[FIELD.requirement]));
  const vat = matchChoice(RULES.vatChoices, [].concat(f[FIELD.vat] || []).map(clean)[0] || "");
  return {
    id: rec.record_id,
    model: B.normalize(model),
    newer,
    status: clean(f[FIELD.status]) || RULES.newStatus,
    filedBy: clean(f[FIELD.filedBy]),
    sources: clean(f[FIELD.sources]),
    nextSteps: nextSteps.map(clean).filter(Boolean),
    done: clean(f[FIELD.done]).toLowerCase() === "yes",   // "No" or empty = still active
    requirement: req.key, requirementRaw: req.raw,
    vat: vat.key, vatRaw: vat.raw,
    // Attachment links (url / tmp_url) expire, so they are never kept.
    attachments: (Array.isArray(f[FIELD.attachments]) ? f[FIELD.attachments] : [])
      .filter((a) => a && a.file_token)
      .map((a) => ({ token: a.file_token, name: a.name || "file", size: a.size || 0 })),
    modified: typeof f[FIELD.modified] === "number" ? f[FIELD.modified] : null,
    sig: sigs(f),
  };
}

// ---- writing: the cells --------------------------------------------------------------
const text = (v) => (B.isMissing(v) ? "" : String(v));
const lines = (arr) => arr.map((x) => `• ${x}`).join("\n");   // "" for an empty list

/** The cells the brief's readable columns and its JSON hold. Blank ones are left out. */
export function briefCells(model) {
  const m = B.normalize(model);
  const tz = LARK.tzOffsetMinutes;
  const c = {
    [FIELD.title]: m.project_title === B.UNTITLED ? "" : m.project_title,
    [FIELD.client]: text(m.client_name),
    [FIELD.filed]: toLarkDay(m.date_filed, tz),
    [FIELD.due]: toLarkDay(m.due_date.date, tz),
    [FIELD.period]: [text(m.event_period)].concat(m.key_dates.map((k) => `• ${[k.date, k.label].filter(Boolean).join(" - ")}`)).join("\n"),
    [FIELD.venue]: text(m.venue),
    [FIELD.objective]: lines(m.objectives),
    [FIELD.audience]: lines(m.target_audience),
    [FIELD.kpis]: lines(m.kpis),
    [FIELD.scope]: lines(m.scope_of_work.map((s) => (s.item ? `${s.item}: ${s.detail}` : s.detail))),
    [FIELD.budget]: text(m.budget.amount),
    [FIELD.budgetType]: m.budget.type === "NOT SPECIFIED" ? "" : B.label(m.budget.type),
    [FIELD.submission]: m.proposal_submission.type === "NOT SPECIFIED" ? "" : B.label(m.proposal_submission.type),
    [FIELD.submissionDetails]: [m.due_date.date ? `Due ${B.dueText(m)}` : "", text(m.proposal_submission.details)].filter(Boolean).join("\n"),
    [FIELD.notes]: lines(m.notes),
    [FIELD.questions]: m.clarifications.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    [FIELD.summary]: m.summary,
    [FIELD.json]: JSON.stringify(m),
  };
  return leaveBlanksOut(c);
}

/** The Lark-owned cells a person picks on the page: next steps, requirement, VAT, attachments (file tokens). */
export function extraCells(x = {}) {
  const c = {};
  if ((x.nextSteps || []).length) c[FIELD.nextSteps] = [...x.nextSteps];
  const req = RULES.requirementTypes[x.requirement];
  if (req) c[FIELD.requirement] = req.label;
  const vat = RULES.vatChoices[x.vat];
  if (vat) c[FIELD.vat] = [vat.label];
  if ((x.attachments || []).length) c[FIELD.attachments] = x.attachments.map((t) => ({ file_token: t }));
  return c;
}

function leaveBlanksOut(cells) {
  return Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== null && v !== undefined && v !== ""
    && !(Array.isArray(v) && !v.length)));
}

/** Every cell a brief state holds. state: { model, nextSteps, requirement, vat, attachments: [file_token] } */
export const cellsOf = (state) => ({ ...briefCells(state.model), ...extraCells(state) });

/** The cells for a brand-new row: the brief, its extras, who filed it, and the starting status. */
export function newRowCells(state, { filedBy = "", sources = "" } = {}) {
  return leaveBlanksOut({
    ...cellsOf(state),
    [FIELD.filedBy]: filedBy,
    [FIELD.sources]: sources,
    [FIELD.status]: RULES.newStatus,
    [FIELD.done]: DONE.no,
  });
}

/** Only the cells that differ between two states. A cell the person emptied is null (cleared on
 *  purpose); a cell that was and is still blank is left out. */
export function changedCells(before, after) {
  const a = cellsOf(before), b = cellsOf(after);
  const out = {};
  for (const [k, v] of Object.entries(b)) if (!sameCell(a[k], v)) out[k] = v;
  for (const k of Object.keys(a)) if (!(k in b)) out[k] = null;
  return out;
}

/** Turn cells into what Lark takes: select values through matchOption against the live options
 *  (so a write never creates an option by accident, except in open columns), and clears as null
 *  (an empty list for multi-selects and attachments).
 *  options: { "Status": ["New", ...] } from the live table; omit it to write labels as they are.
 *  Returns { fields, skipped: [{ column, value }] }: skipped are values Lark has no option for. */
export function toFields(cells, options) {
  const open = new Set(COLUMNS.filter((c) => c.open).map((c) => c.name));
  const fields = {}, skipped = [];
  for (const [col, value] of Object.entries(cells)) {
    const live = options && options[col];
    if (value === null) { fields[col] = SINGLE_SELECTS.has(col) || !(MULTI_SELECTS.has(col) || col === FIELD.attachments) ? null : []; continue; }
    if (SINGLE_SELECTS.has(col)) {
      const hit = live ? matchOption(value, live) : value;
      if (hit) fields[col] = hit; else skipped.push({ column: col, value });
    } else if (MULTI_SELECTS.has(col)) {
      const names = [];
      for (const v of value) {
        const hit = live ? matchOption(v, live) : v;
        if (hit) names.push(hit); else if (open.has(col)) names.push(v); else skipped.push({ column: col, value: v });
      }
      fields[col] = names;
    } else {
      fields[col] = value;
    }
  }
  return { fields, skipped };
}

/** The plain-language sentence for values Lark has no option for. */
export const describeSkipped = (skipped) =>
  skipped.map((s) => `“${s.column}” has no option “${s.value}” in Lark.`);

export { canon };
