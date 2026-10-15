/* Prints the briefs table's column list as JSON, for tools/setup_lark_table.py:
     node tools/export-spec.mjs
   The columns come from js/schema.js and the table from js/config.js (the active
   environment), so the setup script never repeats either. */

import { APP, tableLinks } from "../js/config.js";
import { parseBaseLink } from "../js/tables.js";
import { setupColumns } from "../js/schema.js";

let table;
try {
  const t = parseBaseLink(tableLinks().briefs);
  table = { app: t.app, table: t.table };
} catch (e) {
  console.error(`No briefs table is set for the "${APP.env}" environment in js/config.js (${e.message})`);
  process.exit(1);
}
console.log(JSON.stringify({ table, ...setupColumns() }));
