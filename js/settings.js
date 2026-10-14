/*
 * Settings - per-browser preferences layered over config.js:
 *
 *   config.js defaults  ←  saved addresses (localhost only)  ←  ?gemini= / ?lark= (localhost only, for testing)
 *
 * Service addresses and the table link can only be overridden on a local page:
 * the Lark proxy receives people's login tokens, so a hosted page must always
 * use the real one.
 *
 * cfg() is rebuilt whenever settings change, so modules should always call it at
 * use time rather than keeping a copy. The theme has its own key (fetch.theme,
 * ui.js initTheme); the Settings screen itself is settings-view.js.
 */
import { CONFIG } from "./config.js";
import { store, recall } from "./ui.js";

/** Fired after the saved settings change. */
export const SETTINGS_EVENT = "fetch:settings";

const KEY = "fetch.settings";
const DEFAULTS = Object.assign({}, CONFIG);
const KEY_SHAPE = /^[A-Za-z0-9_\-.]{20,200}$/;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

// ---- storage --------------------------------------------------------------
const read = () => recall("local", KEY) || {};
const write = (value) => store("local", KEY, value);

/** Pull app token + table id out of a Lark Base link. */
function parseLarkTable(link) {
  try {
    const u = new URL(String(link).trim());
    const app = (u.pathname.match(/\/(?:base|wiki)\/([A-Za-z0-9]+)/) || [])[1];
    const table = u.searchParams.get("table");
    if (!app || !table || !/^https:$/.test(u.protocol)) return null;
    return { appToken: app, tableId: table, url: u.toString() };
  } catch (_) {
    return null;
  }
}

const isLocal = (u) => {
  try { return /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(new URL(u).hostname); } catch (_) { return false; }
};
const isServiceUrl = (u) => {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && isLocal(u)); } catch (_) { return false; }
};

const localPage = isLocal(location.href);

let current;
/** The configuration in force right now. */
export const cfg = () => current;

export function rebuild() {
  const s = localPage ? read() : {};
  const c = Object.assign({}, DEFAULTS);
  if (s.geminiUrl) c.GEMINI_PROXY_URL = s.geminiUrl;
  if (s.larkUrl) c.LARK_PROXY_URL = s.larkUrl;
  const table = s.larkTable && parseLarkTable(s.larkTable);
  if (table) Object.assign(c, { LARK_APP_TOKEN: table.appToken, LARK_TABLE_ID: table.tableId, LARK_TABLE_URL: table.url });
  c.OVERRIDDEN = !!(s.geminiUrl || s.larkUrl || table);
  if (localPage) {   // testing overrides; only local URLs, so a shared link can't redirect uploads
    const q = new URLSearchParams(location.search);
    if (q.has("reset")) ["gemini", "lark"].forEach((k) => store("session", `fetch.override.${k}`, undefined));
    ["gemini", "lark"].forEach((k) => q.get(k) && isLocal(q.get(k)) && store("session", `fetch.override.${k}`, q.get(k)));
    const gemini = recall("session", "fetch.override.gemini"), lark = recall("session", "fetch.override.lark");
    c.GEMINI_OVERRIDDEN = !!gemini;
    c.GEMINI_PROXY_URL = gemini || c.GEMINI_PROXY_URL;
    c.LARK_PROXY_URL = lark || c.LARK_PROXY_URL;
  }
  c.GEMINI_PROXY_URL = (c.GEMINI_PROXY_URL || "").replace(/\/+$/, "");
  c.LARK_PROXY_URL = (c.LARK_PROXY_URL || "").replace(/\/+$/, "");
  current = c;
}

function set(patch) {
  const next = Object.assign(read(), patch);
  Object.keys(next).forEach((k) => (next[k] == null || next[k] === "") && delete next[k]);
  const ok = write(next);
  rebuild();
  document.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: patch }));
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

export { read as get, set, DEFAULTS as defaults, parseLarkTable, isServiceUrl, testKey, KEY_SHAPE, geminiKey, localPage };
