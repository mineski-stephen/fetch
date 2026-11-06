/* Checks the page's shell. Offline; reads files only. Run: npm run check:shell

   - index.html's import map lists every js/*.js (a missing one fails only on the live site)
   - js/ui.js, js/icons.js and css/mineski-base.css are byte-identical to the design skill's copies
   - squeeze/ (the PDF compressor) is byte-identical to tech/pdf-compress
   - the boot watchdog is there, and app.js stands it down
   - every module passes `node --check`
   - no secret-shaped strings, and no old "bx." storage keys outside the head's migration script */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");
let failures = 0;
let section = 0;   // problems found in the current section
const fail = (msg) => { failures++; section++; console.log("  ✗ " + msg); };
const begin = (title) => { section = 0; console.log(title); };
const ok = (msg) => console.log("  ✓ " + msg);

const html = read("index.html");
const modules = readdirSync(root + "js").filter((f) => f.endsWith(".js")).sort();

begin("Import map");
const listed = (html.match(/var files = \[([\s\S]*?)\]/) || [])[1] || "";
const inMap = new Set([...listed.matchAll(/"js\/([^"]+\.js)"/g)].map((m) => m[1]));
for (const f of modules) if (!inMap.has(f)) fail(`js/${f} is not in index.html's import map`);
for (const f of inMap) if (!modules.includes(f)) fail(`the import map lists js/${f}, which doesn't exist`);
if (!section) ok(`all ${modules.length} modules are listed`);

begin("Shared files");
const skills = ["../design-ref/mineski-design-language/assets", ".claude/skills/mineski-design-language/assets"]
  .map((p) => root + p).filter((p) => existsSync(p));
if (!skills.length) console.log("  - the design skill isn't next to this folder; skipped");
else {
  const [skill] = skills;
  for (const [mine, theirs] of [["js/ui.js", "ui.js"], ["js/icons.js", "icons.js"], ["css/mineski-base.css", "mineski-base.css"]]) {
    if (md5(root + mine) === md5(`${skill}/${theirs}`)) ok(`${mine} matches the skill`);
    else fail(`${mine} differs from the skill's ${theirs}. Fix the skill first, then copy it back unedited.`);
  }
}
const systems = ["../design-ref/mineski-systems-design/assets", ".claude/skills/mineski-systems-design/assets"]
  .map((p) => root + p).find((p) => existsSync(`${p}/session.js`));
if (!systems) console.log("  - the systems design isn't next to this folder; js/session.js not compared");
else if (md5(root + "js/session.js") === md5(`${systems}/session.js`)) ok("js/session.js matches the systems design");
else fail("js/session.js differs from the systems design's assets/session.js. Fix it there first, then copy it back unedited.");

// The PDF compressor (js/compress.js) runs Squeeze's engine, copied unedited from tech/pdf-compress.
const squeezeHome = root + "../tech/pdf-compress/";
for (const [mine, theirs] of [["squeeze/js/engine.js", "js/engine.js"], ["squeeze/js/worker.js", "js/worker.js"],
  ["squeeze/vendor/pdf-lib/pdf-lib.esm.min.js", "vendor/pdf-lib/pdf-lib.esm.min.js"]]) {
  if (!existsSync(root + mine)) fail(`${mine} is missing (copy it from tech/pdf-compress)`);
  else if (!existsSync(squeezeHome + theirs)) console.log(`  - tech/pdf-compress isn't next to this folder; ${mine} not compared`);
  else if (md5(root + mine) === md5(squeezeHome + theirs)) ok(`${mine} matches Squeeze`);
  else fail(`${mine} differs from tech/pdf-compress/${theirs}. Change it there first, then copy it back unedited.`);
}

begin("Boot watchdog");
if (/data-booted/.test(html) && /couldn\\?'t start/.test(html)) ok("index.html has it");
else fail("index.html has no boot watchdog (data-booted / \"couldn't start\")");
if (/dataset\.booted/.test(read("js/app.js"))) ok("app.js stands it down");
else fail("app.js never sets <html data-booted>");

begin("Syntax");
for (const f of modules) {
  try { execFileSync(process.execPath, ["--check", `${root}js/${f}`], { stdio: "inherit" }); }
  catch (_) { fail(`js/${f} doesn't parse`); }
}
if (!section) ok("node --check passes on every module");

begin("Secrets and old keys");
const secrets = [new RegExp("AIza[0-9A-Za-z_-]{20,}"), new RegExp("app" + "_secret\\s*[:=]\\s*[\"'][^\"']{8,}"), /cli_[a-z0-9]{16}[\s\S]{0,40}secret/i];
const scan = [...modules.map((f) => `js/${f}`), "index.html", "css/app.css", ...readdirSync(root + "tests").filter((f) => /\.(m?js|json)$/.test(f)).map((f) => `tests/${f}`)];
for (const p of scan) {
  const text = read(p);
  for (const re of secrets) if (re.test(text)) fail(`${p} looks like it holds a secret (${re.source.slice(0, 12)}…)`);
}
for (const f of modules) if (/\bbx\./i.test(read(`js/${f}`))) fail(`js/${f} mentions an old "bx." storage key`);
const bodyAfterHead = html.split("</script>").slice(1).join("</script>");   // everything but the first (migration) script
if (/\bbx\./i.test(bodyAfterHead)) fail("index.html mentions \"bx.\" outside the head's migration script");
const own = modules.filter((f) => !["ui.js", "icons.js", "session.js"].includes(f));   // the shared files are the skills' to fix
if (/\u2014/.test(html + own.map((f) => read(`js/${f}`)).join(""))) fail("an em dash in the page or its scripts (house voice: hyphen, colon or a new sentence)");
if (!section) ok("none found");

begin("Version");
const version = (read("js/config.js").match(/\bversion:\s*"(\d+\.\d+\.\d+)"/) || [])[1];
const logged = existsSync(root + "CHANGELOG.md") && (read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m) || [])[1];
if (!version) fail("APP.version (x.y.z) isn't in js/config.js");
else if (!logged) fail("CHANGELOG.md has no \"## x.y.z\" entry");
else if (logged !== version) fail(`CHANGELOG.md's newest entry is ${logged}, but APP.version is ${version}`);
if (!/id="appVersion"/.test(html)) fail("the top bar doesn't show the version (#appVersion)");
if (!section) ok(`APP.version ${version} matches CHANGELOG.md and is shown in the top bar`);

console.log(failures ? `\n${failures} problem(s).` : "\nShell checks passed ✓");
process.exitCode = failures ? 1 : 0;
