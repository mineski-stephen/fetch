/*
 * Settings - per-browser preferences layered over config.js:
 *
 *   config.js defaults  <-  saved addresses (local page only)  <-  ?gemini= / ?lark= (local page only, per tab)
 *
 * Service addresses and the table link can only be overridden on a local page: the Lark
 * proxy receives people's login tokens, so a hosted page must always use the real one.
 * Every active override is listed by overrides() and shown as a red badge in the top bar.
 *
 * cfg() is rebuilt whenever settings change, so modules should always call it at use
 * time rather than keeping a copy. The theme has its own key (fetch.theme, ui.js
 * initTheme); the Settings screen itself is settings-view.js.
 */
import { APP, SERVICES, tableLinks } from "./config.js";
import { parseBaseLink } from "./tables.js";
import { store, recall } from "./ui.js";

const KEY = "fetch.settings";
const KEY_SHAPE = /^[A-Za-z0-9_\-.]{20,200}$/;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

// ---- storage --------------------------------------------------------------
const read = () => recall("local", KEY) || {};
const write = (value) => store("local", KEY, value);

const isLocal = (u) => {
  try { return /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(new URL(u).hostname); } catch (_) { return false; }
};
/** https, or http on this computer. */
const isServiceUrl = (u) => {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && isLocal(u)); } catch (_) { return false; }
};

const localPage = isLocal(location.href);

/** The table links as the config has them: { app, table, view, url } or null when there isn't one. */
function configTable() {
  try { return parseBaseLink(tableLinks().briefs); } catch (_) { return null; }
}

const defaults = {
  geminiUrl: SERVICES.gemini.url,
  larkUrl: SERVICES.lark.url,
  get table() { return configTable(); },
};

let current;
const listeners = new Set();
/** The configuration in force right now: { geminiUrl, larkUrl, table, overrides: ["…", …] }. */
export const cfg = () => current;
/** Subscribe to changes of the saved settings. Returns the unsubscribe function. */
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function rebuild() {
  const s = localPage ? read() : {};
  const c = { geminiUrl: defaults.geminiUrl, larkUrl: defaults.larkUrl, table: defaults.table, overrides: [] };
  if (s.geminiUrl && isServiceUrl(s.geminiUrl)) { c.geminiUrl = s.geminiUrl; c.overrides.push("Extraction service address (Settings)"); }
  if (s.larkUrl && isServiceUrl(s.larkUrl)) { c.larkUrl = s.larkUrl; c.overrides.push("Lark proxy address (Settings)"); }
  if (s.larkTable) {
    try { c.table = parseBaseLink(s.larkTable); c.overrides.push("Lark table (Settings)"); } catch (_) { /* ignored: not a table link */ }
  }
  if (localPage) {   // testing overrides, per tab; only https or local http, and only on a local page
    const q = new URLSearchParams(location.search);
    const names = { gemini: "geminiUrl", lark: "larkUrl" };
    if (q.has("reset")) Object.keys(names).forEach((k) => store("session", `fetch.override.${k}`, undefined));
    Object.keys(names).forEach((k) => q.get(k) && isServiceUrl(q.get(k)) && store("session", `fetch.override.${k}`, q.get(k)));
    for (const [k, prop] of Object.entries(names)) {
      const v = recall("session", `fetch.override.${k}`);
      if (v && isServiceUrl(v)) { c[prop] = v; c.overrides.push(`${k === "gemini" ? "Extraction service" : "Lark proxy"} address (page link)`); }
    }
  }
  if (APP.env !== "live") c.overrides.push(`Environment: ${APP.env}`);
  c.geminiUrl = (c.geminiUrl || "").replace(/\/+$/, "");
  c.larkUrl = (c.larkUrl || "").replace(/\/+$/, "");
  current = c;
}

function set(patch) {
  const next = Object.assign(read(), patch);
  Object.keys(next).forEach((k) => (next[k] == null || next[k] === "") && delete next[k]);
  const ok = write(next);
  rebuild();
  listeners.forEach((fn) => fn(patch));
  return ok;
}

/** Ask Google directly which Flash-Lite models a key can use. */
async function testKey(key) {
  if (!KEY_SHAPE.test(key)) return { ok: false, message: "That doesn't look like a Gemini API key." };
  try {
    const res = await fetch(`${GEMINI_API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || `HTTP ${res.status}`;
      return { ok: false, message: /api key/i.test(msg) ? "Google rejected this key. Check that you copied all of it." : msg };
    }
    const lite = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /^gemini-[\d.]+-flash-lite$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!lite.length) return { ok: false, message: "The key works, but it has no Flash-Lite models available." };
    const pretty = lite[0].replace(/^gemini-([\d.]+)-flash-lite$/, "Gemini $1 Flash-Lite");
    return { ok: true, message: `Key works. Fetch will use ${pretty}.` };
  } catch (_) {
    return { ok: false, message: "Couldn't reach Google to check the key. Check your connection." };
  }
}

const geminiKey = () => read().geminiKey || "";

rebuild();

export { read as get, set, defaults, isServiceUrl, testKey, KEY_SHAPE, geminiKey, localPage };
