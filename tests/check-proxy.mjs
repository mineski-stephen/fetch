/* Checks the hosted services in js/config.js with one GET / each (nothing is written).
   Run: npm run check:proxy

   For each service: it answers with its own JSON (`service`), its version is at least `min`,
   and, once it reports its CORS headers, every header the page sends is allowed.
   A free Render service may be asleep: each is retried for about 3 minutes before it counts as down. */

import { SERVICES } from "../js/config.js";
import { incompatible } from "../js/errors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(url) {
  const until = Date.now() + 180000;
  let wait = 2000, last = "no answer";
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (res.status >= 400 && res.status < 500) return { error: `answered HTTP ${res.status}` };
      if (res.ok && /json/.test(res.headers.get("content-type") || "")) return { info: await res.json() };
      last = `HTTP ${res.status}, not the service's JSON yet`;
    } catch (e) {
      last = e.name === "TimeoutError" ? "no answer in 20 s" : e.message;
    }
    console.log(`  ... ${last}; waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
    wait = Math.min(wait * 1.6, 15000);
  }
  return { error: `no answer for 3 minutes (${last})` };
}

let failures = 0;
for (const [id, def] of Object.entries(SERVICES)) {
  console.log(`${id}: ${def.url}`);
  const { info, error } = await ping(def.url);
  if (error) { failures++; console.log(`  ✗ ${error}`); continue; }
  if (info.service !== def.service) { failures++; console.log(`  ✗ service is "${info.service}", expected "${def.service}"`); continue; }
  const problem = incompatible(info, def);
  if (problem) { failures++; console.log(`  ✗ out of date (${problem})`); continue; }
  const cors = info.cors && info.cors.allow_headers ? `CORS allows ${info.cors.allow_headers.join(", ")}` : "does not report its CORS headers yet";
  console.log(`  ✓ ${info.service} ${info.version ? `v${info.version}` : "(no version reported)"}${info.commit ? ` @ ${info.commit}` : ""}; ${cors}`);
  if (info.endpoints && /\/token\b/.test(JSON.stringify(info.endpoints))) {
    failures++;
    console.log("  ✗ it still lists a public /token endpoint (anyone can get an app token from it)");
  }
}
console.log(failures ? `\n${failures} service problem(s).` : "\nAll services answer and are compatible ✓");
process.exitCode = failures ? 1 : 0;
