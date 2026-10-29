/*
 * The briefs table: its columns, and the check that the live table still matches.
 * Pure functions: no DOM, no network.
 *
 * COLUMNS is the one list of columns. The page, the live check and
 * tools/setup_lark_table.py (through tools/export-spec.mjs) all read it, so a column
 * is named in exactly one place. Names must match the Lark table letter for letter.
 */
import * as B from "./brief.js";
import { RULES } from "./config.js";

/** Lark field type ids. */
export const T = { text: 1, number: 2, select: 3, multi: 4, date: 5, checkbox: 7, user: 11, url: 15, attachment: 17, formula: 20, modified: 1002 };
export const TYPE_NAMES = { 1: "Text", 2: "Number", 3: "Single select", 4: "Multi select", 5: "Date", 7: "Checkbox",
                            11: "Person", 15: "URL", 17: "Attachment", 18: "Link", 19: "Lookup", 20: "Formula",
                            1001: "Created time", 1002: "Last modified time" };
/** Columns Lark fills itself (lookup, formula, link, auto fields): never written. */
export const COMPUTED = new Set([18, 19, 20, 21, 24, 1001, 1002, 1003, 1004, 1005]);

const reqLabels = Object.values(RULES.requirementTypes).map((c) => c.label);
const vatLabels = Object.values(RULES.vatChoices).map((c) => c.label);

// `options`: what the page writes (must exist in Lark, and the setup script creates them).
// `optional`: may be missing; the actions that need the column switch off until it exists.
// `open`: writes may add new options here on purpose (people type their own next steps).
// `types`: other column types that are fine too (the first one, `type`, is what the setup script creates).
export const COLUMNS = [
  { key: "title", name: "Project Title", type: T.text, primary: true },
  { key: "client", name: "Client", type: T.text },
  { key: "filed", name: "Date Filed", type: T.date },
  { key: "due", name: "Due Date", type: T.date },
  { key: "status", name: "Status", type: T.select, options: RULES.statuses, need: [RULES.newStatus] },
  { key: "period", name: "Event Date / Period", type: T.text },
  { key: "venue", name: "Venue", type: T.text },
  { key: "objective", name: "Objective", type: T.text },
  { key: "audience", name: "Target Audience", type: T.text },
  { key: "kpis", name: "KPIs", type: T.text },
  { key: "scope", name: "Scope of Work", type: T.text },
  { key: "budget", name: "Estimated Budget", type: T.text },
  { key: "budgetType", name: "Budget Type", type: T.select, options: B.BUDGET_TYPES.map(B.label),
    need: B.BUDGET_TYPES.filter((t) => t !== "NOT SPECIFIED").map(B.label) },
  { key: "submission", name: "Proposal Submission", type: T.select, options: B.SUBMISSION_TYPES.map(B.label),
    need: B.SUBMISSION_TYPES.filter((t) => t !== "NOT SPECIFIED").map(B.label) },
  { key: "submissionDetails", name: "Submission Details", type: T.text },
  { key: "notes", name: "Notes", type: T.text },
  { key: "questions", name: "Questions for Client", type: T.text },
  { key: "summary", name: "Summary", type: T.text },
  { key: "filedBy", name: "Filed By", type: T.text },
  { key: "sources", name: "Source Files", type: T.text },
  { key: "json", name: "Brief JSON", type: T.text },
  { key: "nextSteps", name: "Next Steps", type: T.multi, options: RULES.nextSteps, open: true, optional: true },
  { key: "attachments", name: "Attachments", type: T.attachment, optional: true },
  { key: "requirement", name: "Requirement Type", type: T.select, options: reqLabels, need: reqLabels, optional: true },
  { key: "vat", name: "VAT", type: T.multi, options: vatLabels, need: vatLabels, optional: true },
  { key: "done", name: "Done", type: T.select, options: ["Yes", "No"], need: ["Yes", "No"] },   // Yes = in the collapsed Done section
  { key: "modified", name: "Last Modified", type: T.modified, optional: true },
  // The brief's sharing link (#/share/<record id>). Fetch writes it as a URL or text; as a formula
  // (built from RECORD_ID()) Lark fills it, and Fetch only reads it.
  { key: "fetchUrl", name: "Fetch URL", type: T.url, types: [T.url, T.text, T.formula], optional: true },
  // What "Check sources" and "Brief files" need once the draft is filed: one small gzipped JSON
  // file (bundle.js). Without the column, filed briefs simply don't offer them.
  { key: "fetchFiles", name: "Fetch Files", type: T.attachment, optional: true },
];

export const TABLE_TITLE = "Briefs";
export const FIELD = Object.fromEntries(COLUMNS.map((c) => [c.key, c.name]));
export const DONE = { yes: "Yes", no: "No" };
export const SINGLE_SELECTS = new Set(COLUMNS.filter((c) => c.type === T.select).map((c) => c.name));
export const MULTI_SELECTS = new Set(COLUMNS.filter((c) => c.type === T.multi).map((c) => c.name));

/** The spec in the shape the standard describes (SKILL.md 6.2). */
export function tableSpec() {
  const fields = {}, optional = {}, options = {}, neededBy = {};
  for (const c of COLUMNS) {
    (c.optional ? optional : fields)[c.name] = c.types || c.type;
    if (c.need) options[c.name] = c.need;
    if (c.optional && c.type !== T.modified && c.key !== "fetchUrl" && c.key !== "fetchFiles") neededBy[c.key] = [c.name];
  }
  return {
    title: TABLE_TITLE, fields, optional, options,
    openOptions: COLUMNS.filter((c) => c.open).map((c) => c.name),
    read: COLUMNS.map((c) => c.name),
    neededBy,
  };
}

/** What tools/setup_lark_table.py needs: the columns in order, with the options to create. */
export function setupColumns() {
  return { primary: COLUMNS.find((c) => c.primary).name,
           columns: COLUMNS.map((c) => ({ name: c.name, type: c.type, options: c.options || null })) };
}

export const selectOptions = (field) => ((field && field.property && field.property.options) || []).map((o) => o.name);

/** The live options of every select column the table has: { "Status": ["New", ...], ... }. */
export function optionsOf(fields) {
  const out = {};
  for (const f of fields || []) if (f.type === T.select || f.type === T.multi) out[f.field_name] = selectOptions(f);
  return out;
}

/** Check the live fields against the spec. Returns plain-language problems; each one
 *  stops saving, because a write to a wrong column corrupts the table. */
export function checkSchema(fields, spec = tableSpec()) {
  const byName = new Map((fields || []).map((f) => [f.field_name, f]));
  const typeName = (t) => TYPE_NAMES[t] || `type ${t}`;
  const fits = (f, type) => (Array.isArray(type) ? type.includes(f.type) : f.type === type);
  const wanted = (type) => (Array.isArray(type) ? type.map(typeName).join(" or ") : typeName(type));
  const problems = [];
  for (const [name, type] of Object.entries(spec.fields)) {
    const f = byName.get(name);
    if (!f) { problems.push(`Column “${name}” is missing.`); continue; }
    if (!fits(f, type)) problems.push(`Column “${name}” is ${typeName(f.type)}, expected ${wanted(type)}.`);
  }
  for (const [name, type] of Object.entries(spec.optional || {})) {
    const f = byName.get(name);
    if (f && !fits(f, type)) problems.push(`Column “${name}” is ${typeName(f.type)}, expected ${wanted(type)}.`);
  }
  for (const [name, wanted] of Object.entries(spec.options || {})) {
    if (!byName.has(name)) continue;
    const have = selectOptions(byName.get(name));
    for (const w of wanted) if (!have.includes(w)) problems.push(`“${name}” has no option “${w}”.`);
  }
  return problems;
}

/** Problems with columns only one kind of change needs (spec.neededBy), by kind. */
export function checkNeeded(fields, spec = tableSpec()) {
  const names = new Set((fields || []).map((f) => f.field_name));
  const out = {};
  for (const [kind, list] of Object.entries(spec.neededBy || {})) {
    out[kind] = list.filter((n) => !names.has(n)).map((n) => `Column “${n}” is missing.`);
  }
  return out;
}

/** The columns to request: the ones the spec reads that the table has (Lark rejects unknown
 *  names), or all columns (undefined) past 50 names. */
export function presentColumns(fields, spec = tableSpec()) {
  const present = new Set((fields || []).map((f) => f.field_name));
  const names = spec.read.filter((n) => present.has(n));
  return names.length > 50 ? undefined : names;
}

/** Only the columns a person can type into (not formulas or auto fields), and only ones the table has. */
export function writableOnly(payload, fields) {
  const byName = new Map((fields || []).map((f) => [f.field_name, f]));
  return Object.fromEntries(Object.entries(payload).filter(([k]) => byName.has(k) && !COMPUTED.has(byName.get(k).type)));
}

/** The full result of checking live fields: what the page keeps and shows. */
export function checkAll(fields) {
  const spec = tableSpec();
  const problems = checkSchema(fields, spec);
  const needed = checkNeeded(fields, spec);
  const present = new Set((fields || []).map((f) => f.field_name));
  return {
    checked: true,
    problems,                                                          // switch off saving, Done and Delete
    partial: Object.values(needed).flat(),                              // switch off only what uses the column
    missing: new Set(COLUMNS.filter((c) => !present.has(c.name)).map((c) => c.name)),
    options: optionsOf(fields),
    fields: fields || [],
  };
}

/** What stops a write to these columns right now: schema problems, plus any optional column
 *  the write touches that the table doesn't have. [] means go ahead. */
export function blockers(schema, columns = []) {
  if (!schema || !schema.checked) return [];
  const extra = columns.filter((c) => schema.missing.has(c)).map((c) => `Column “${c}” is missing.`);
  return [...new Set([...schema.problems, ...extra])];
}
