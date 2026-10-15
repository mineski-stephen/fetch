/* End-to-end check of every write Fetch makes, against a TEST COPY of the briefs table.
   Run: npm run check:e2e

   It refuses to run unless js/config.js has APP.env === "test" and a link in TABLES.test.briefs
   (it never looks at the label text, and never touches the live table). To set that up:
     1. Duplicate the briefs table in Lark (with its records) and paste the copy's link into
        TABLES.test.briefs. The Lark app needs edit access to it.
     2. Set APP.env to "test" (in a working copy; don't publish that).
     3. Put LARK_APP_ID and LARK_APP_SECRET in tools/.env.

   It runs the same ops.js the page runs, with a direct caller. Steps:
     snapshot every row -> create one row (and again with the same token: expect the same row)
     -> save an edit (only the intended cells change; a stale save is refused)
     -> Done and back -> delete that row. The other rows must come out untouched. */

import { APP, tableLinks } from "../js/config.js";
import * as ops from "../js/ops.js";
import { FIELD } from "../js/schema.js";
import { AlreadyDone } from "../js/errors.js";
import { getRecord } from "../js/tables.js";
import { canon } from "../js/cells.js";
import { tenantToken, makeCall, briefsTable } from "./lark-node.mjs";

if (APP.env !== "test" || !tableLinks().briefs) {
  console.log(`Refusing to run: APP.env is "${APP.env}"${APP.env === "test" ? " but TABLES.test.briefs is empty" : ""}.`);
  console.log("This writes to the briefs table, so it only runs against a test copy. See the top of this file.");
  process.exit(2);
}

const call = makeCall(await tenantToken());
const t = briefsTable();
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log("  ✗ " + msg); } else console.log("  ✓ " + msg); };
const st = (model, x = {}) => ({ model, nextSteps: [], requirement: "", vat: "", attachments: [], ...x });
const snapshot = async () => new Map((await ops.loadBriefs(call, t)).rows.map((r) => [r.id, r]));

/** The cells that differ between two raw records (as comparable text). */
async function rawFields(id) { return (await getRecord(call, t, id)).fields; }
const diffRaw = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
  .filter((k) => k !== FIELD.modified && canon(a[k]) !== canon(b[k])).sort();

const { rows: before0, schema } = await ops.loadBriefs(call, t);
console.log(`Test table: ${before0.length} rows. Columns: ${schema.problems.length ? schema.problems.join(" ") : "ok"}`);
if (schema.problems.length) { console.log("Fix the test table's columns first (tools/setup_lark_table.py)."); process.exit(1); }
const others = new Map(before0.map((r) => [r.id, JSON.stringify([r.model, r.nextSteps, r.done, r.status])]));

const MODEL = { date_filed: "2026-10-02", due_date: { date: "2026-10-16", note: "" }, client_name: "E2E Test Client",
  project_title: `E2E ${new Date().toISOString().slice(0, 16)}`, venue: "Test venue", objectives: ["Check every write"], summary: "Made by tests/e2e.mjs." };
const token = `e2e-${Date.now()}`;
let id = "";
try {
  console.log("\nCreate");
  const made = await ops.createBrief(call, t, schema, st(MODEL), { filedBy: "E2E Test", sources: "e2e.mjs", clientToken: token });
  id = made.recordId;
  check(made.mismatches && made.mismatches.length === 0, `read-back agrees on all ${Object.keys(made.written).length} fields`);
  const again = await ops.createBrief(call, t, schema, st(MODEL), { filedBy: "E2E Test", sources: "e2e.mjs", clientToken: token });
  check(again.recordId === id, "the same client token returns the same row (no duplicate)");
  check((await snapshot()).size === before0.length + 1, "exactly one new row");

  console.log("\nSave an edit");
  let row = (await snapshot()).get(id);
  const raw0 = await rawFields(id);
  const edit = await ops.updateBrief(call, t, schema, row, st(row.model), st({ ...row.model, venue: "Edited venue" }, { nextSteps: ["Pitch Deck"] }));
  const raw1 = await rawFields(id);
  check(edit.mismatches.length === 0, "read-back agrees");
  check(diffRaw(raw0, raw1).join("|") === [FIELD.venue, FIELD.json, FIELD.nextSteps].sort().join("|"),
    `only the intended cells changed (${diffRaw(raw0, raw1).join(", ")})`);
  let refused = false;
  try { await ops.updateBrief(call, t, schema, row, st(row.model), st({ ...row.model, venue: "Stale save" }, { nextSteps: ["PM Assignment"] })); }
  catch (e) { refused = e instanceof AlreadyDone; }
  check(refused, "saving from a stale copy is refused, not written");
  check(diffRaw(raw1, await rawFields(id)).length === 0, "...and nothing changed in Lark");

  console.log("\nDone and back");
  row = (await snapshot()).get(id);
  const d1 = await ops.setDone(call, t, schema, id, true);
  check(d1.mismatches.length === 0 && (await snapshot()).get(id).done === true, "marked Done");
  const raw2 = await rawFields(id);
  await ops.setDone(call, t, schema, id, true);
  check(diffRaw(raw2, await rawFields(id)).length === 0, "doing it again changes nothing");
  await ops.setDone(call, t, schema, id, false);
  check((await snapshot()).get(id).done === false, "back in the list");
} finally {
  if (id) {
    console.log("\nDelete");
    await ops.deleteBrief(call, t, id);
    const after = await snapshot();
    check(!after.has(id), "the test row is gone");
    const untouched = [...others].every(([k, v]) => { const r = after.get(k); return r && JSON.stringify([r.model, r.nextSteps, r.done, r.status]) === v; });
    check(after.size === before0.length && untouched, "every other row is exactly as it was");
  }
}
console.log(failures ? `\n${failures} problem(s).` : "\nAll end-to-end checks passed ✓");
process.exitCode = failures ? 1 : 0;
