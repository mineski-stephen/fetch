/* Lark access for the Node checks: an app (tenant) token, then direct HTTPS calls (CORS only
   applies to browsers). Gives the same `call(method, url, body, opts)` shape the page uses,
   so ops.js runs unchanged.

   The token comes straight from Lark with the app's id and secret, read from the environment
   or a git-ignored .env file (tools/.env, or .env in the project root):
     LARK_APP_ID=cli_...
     LARK_APP_SECRET=...
   The shared Lark proxy never hands out app tokens. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LARK, TABLES, APP, tableLinks } from "../js/config.js";
import { parseBaseLink } from "../js/tables.js";
import { LarkError } from "../js/errors.js";

const root = fileURLToPath(new URL("../", import.meta.url));

/** KEY=VALUE lines of a .env file (comments and quotes allowed). The environment wins. */
function readEnv() {
  const out = {};
  for (const file of [`${root}tools/.env`, `${root}.env`]) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const v = m[2].replace(/^(["'])(.*)\1$/, "$2");
      if (!(m[1] in out)) out[m[1]] = v;
    }
  }
  return { ...out, ...Object.fromEntries(["LARK_APP_ID", "LARK_APP_SECRET"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
}

export async function tenantToken() {
  const env = readEnv();
  const appId = env.LARK_APP_ID || LARK.appId;   // the app id is public
  if (!env.LARK_APP_SECRET) {
    throw new Error("LARK_APP_SECRET is missing. Put it in tools/.env (see tools/.env.example) or the environment.");
  }
  const res = await fetch(`${LARK.api}/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: env.LARK_APP_SECRET }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0 || !j.tenant_access_token) throw new Error(`Couldn't get a tenant token (code ${j.code}: ${j.msg}).`);
  return j.tenant_access_token;
}

export function makeCall(token) {
  return async function call(method, url, body) {
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new LarkError(`HTTP ${res.status}, not JSON`, { status: res.status, raw: text.slice(0, 300) }); }
    if (Number(j.code) !== 0) throw new LarkError(`Lark ${j.code}: ${j.msg}`, { status: res.status, json: j });
    return j;
  };
}

/** The briefs table of the environment in js/config.js. */
export const briefsTable = () => parseBaseLink(tableLinks().briefs);
export { APP, TABLES };
