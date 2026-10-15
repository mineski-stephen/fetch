/* Read-only check against the briefs table in js/config.js. Writes nothing.
   Run: npm run check:live

   1. Every column the page uses exists with the right type and options (the same check the page
      runs on load).
   2. Every brief maps to a row model, and saving it untouched would change nothing (the mapping
      round-trips on the real data).
   3. For every brief, builds the cells the page would write when it is saved with one edit, and checks
      they're well-formed: no blank or placeholder, every select value an existing option.
   Needs LARK_APP_ID / LARK_APP_SECRET (tools/.env). The Lark app must be able to open the table. */

import * as ops from "../js/ops.js";
import * as B from "../js/brief.js";
import { FIELD, selectOptions } from "../js/schema.js";
import { newRowCells, changedCells, toFields } from "../js/rows.js";
import { tenantToken, makeCall, briefsTable, APP } from "./lark-node.mjs";

const call = makeCall(await tenantToken());
const t = briefsTable();
const t0 = Date.now();
const { rows, schema } = await ops.loadBriefs(call, t);
console.log(`Loaded ${rows.length} briefs (${APP.env}) in ${Date.now() - t0} ms.`);

let failures = 0;
const fail = (msg) => { failures++; console.log("  ✗ " + msg); };

console.log("\nColumns:", schema.problems.length || schema.partial.length ? "" : "all present with the expected types and options ✓");
[...schema.problems, ...schema.partial].forEach(fail);

const state = (row, extra = {}) => ({ model: row.model, nextSteps: row.nextSteps, requirement: row.requirement,
  vat: row.vat, attachments: row.attachments.map((a) => a.token), ...extra });
const blank = (v) => v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length);

let unknownChoices = 0, newer = 0;
for (const row of rows) {
  const label = `${row.id} “${row.model.project_title}”`;
  if (row.newer) { newer++; console.log(`  ! ${label}: written by a newer Fetch (v${row.newer}); read-only here`); continue; }
  if (row.requirementRaw || row.vatRaw) {
    unknownChoices++;
    console.log(`  ! ${label}: Lark holds ${[row.requirementRaw, row.vatRaw].filter(Boolean).map((x) => `“${x}”`).join(", ")}, which Fetch doesn't offer (kept on save)`);
  }
  // Saving it untouched must write nothing.
  const same = changedCells(state(row), state(row));
  if (Object.keys(same).length) fail(`${label}: an untouched save would write ${Object.keys(same).join(", ")}`);
  // Saving it with a new venue writes the venue and the document, nothing else.
  const edited = changedCells(state(row), state({ ...row, model: { ...row.model, venue: `${row.model.venue} (edited)` } }));
  const keys = Object.keys(edited).sort().join(", ");
  if (keys !== [FIELD.venue, FIELD.json].sort().join(", ")) fail(`${label}: a venue edit would write ${keys}`);
  const { fields, skipped } = toFields(edited, schema.options);
  skipped.forEach((s) => fail(`${label}: “${s.column}” has no option “${s.value}”`));
  for (const [k, v] of Object.entries(fields)) if (blank(v)) fail(`${label}: ${k} would be written blank`);
}

// A brand-new row built from each brief's model: every cell well-formed, every select an existing option.
const opts = Object.fromEntries(schema.fields.filter((f) => f.type === 3 || f.type === 4).map((f) => [f.field_name, selectOptions(f)]));
for (const row of rows.filter((r) => !r.newer)) {
  const cells = newRowCells(state(row), { filedBy: row.filedBy, sources: row.sources });
  const { fields, skipped } = toFields(cells, schema.options);
  skipped.forEach((s) => fail(`${row.id}: new row, “${s.column}” has no option “${s.value}”`));
  for (const [k, v] of Object.entries(fields)) {
    if (blank(v)) fail(`${row.id}: new row, ${k} is blank`);
    for (const x of Array.isArray(v) && v.every((e) => typeof e === "string") ? v : [v]) {
      if (opts[k] && typeof x === "string" && !opts[k].includes(x) && k !== FIELD.nextSteps) fail(`${row.id}: ${k} = "${x}" is not an existing option`);
    }
    if (typeof v === "string" && (v === B.NS || v === B.UNTITLED)) fail(`${row.id}: ${k} holds the placeholder "${v}"`);
  }
}

console.log(`\n${rows.length} brief(s) checked; ${unknownChoices} with an option Fetch doesn't offer; ${newer} from a newer version.`);
console.log(failures ? `${failures} problem(s) found.` : "All live checks passed ✓");
process.exitCode = failures ? 1 : 0;
