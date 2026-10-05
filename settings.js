/*
 * Settings - per-browser preferences layered over config.js:
 *
 *   config.js defaults  ←  saved settings (this browser)  ←  ?gemini= / ?lark= (localhost only, for testing)
 *
 * BX.config is rebuilt whenever settings change, so modules should always read
 * BX.config at call time rather than caching it.
 */
(function (BX) {
  "use strict";

  const KEY = "bx.settings";
  const DEFAULTS = Object.assign({}, window.BRIEF_CONFIG);
  const KEY_SHAPE = /^[A-Za-z0-9_\-.]{20,200}$/;
  const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

  // ---- storage --------------------------------------------------------------
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; }
  }

  function write(value) {
    try { localStorage.setItem(KEY, JSON.stringify(value)); return true; } catch (_) { return false; }
  }

  (function migrate() {   // v1.0 kept the "Filed by" name under its own key
    try {
      const old = JSON.parse(localStorage.getItem("bx.filedBy") || "null");
      if (old && !read().name) write(Object.assign(read(), { name: old }));
      localStorage.removeItem("bx.filedBy");
    } catch (_) { /* storage blocked */ }
  })();

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

  function build() {
    const s = read();
    const c = Object.assign({}, DEFAULTS);
    if (s.geminiUrl) c.GEMINI_PROXY_URL = s.geminiUrl;
    if (s.larkUrl) c.LARK_PROXY_URL = s.larkUrl;
    const table = s.larkTable && parseLarkTable(s.larkTable);
    if (table) Object.assign(c, { LARK_APP_TOKEN: table.appToken, LARK_TABLE_ID: table.tableId, LARK_TABLE_URL: table.url });
    try {   // testing overrides; only local URLs, so a shared link can't redirect uploads
      const q = new URLSearchParams(location.search);
      if (q.has("reset")) ["gemini", "lark"].forEach((k) => sessionStorage.removeItem(`bx.override.${k}`));
      ["gemini", "lark"].forEach((k) => q.get(k) && isLocal(q.get(k)) && sessionStorage.setItem(`bx.override.${k}`, q.get(k)));
      c.GEMINI_OVERRIDDEN = !!sessionStorage.getItem("bx.override.gemini");
      c.GEMINI_PROXY_URL = sessionStorage.getItem("bx.override.gemini") || c.GEMINI_PROXY_URL;
      c.LARK_PROXY_URL = sessionStorage.getItem("bx.override.lark") || c.LARK_PROXY_URL;
    } catch (_) { /* storage blocked */ }
    c.GEMINI_PROXY_URL = (c.GEMINI_PROXY_URL || "").replace(/\/+$/, "");
    c.LARK_PROXY_URL = (c.LARK_PROXY_URL || "").replace(/\/+$/, "");
    BX.config = c;
  }

  function set(patch) {
    const next = Object.assign(read(), patch);
    Object.keys(next).forEach((k) => (next[k] == null || next[k] === "") && delete next[k]);
    const ok = write(next);
    build();
    document.dispatchEvent(new CustomEvent("bx:settings", { detail: patch }));
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

  /** "system" follows the OS; "light" / "dark" force it (see the inline script in index.html). */
  function applyTheme(theme = read().theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  BX.settings = {
    applyTheme,
    get: read,
    set,
    build,
    defaults: DEFAULTS,
    parseLarkTable,
    isServiceUrl,
    testKey,
    KEY_SHAPE,
    geminiKey: () => read().geminiKey || "",
    name: () => read().name || "",
  };
  build();

  // ---- the Settings screen ------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  let hooks = {};

  function result(el, ok, text) {
    el.textContent = text || "";
    el.className = `set-result${ok === true ? " is-ok" : ok === false ? " is-err" : ""}`;
  }

  function paintKey() {
    const has = !!BX.settings.geminiKey();
    const configured = BX.extract.warm.configured;
    const pill = $("#keyStatus");
    let text, tone;
    if (has) [text, tone] = ["Using your key", "ok"];
    else if (configured === true) [text, tone] = ["Using the shared key", "ok"];
    else if (configured === false) [text, tone] = ["Key needed", "warn"];
    else [text, tone] = ["Checking…", "muted"];
    pill.textContent = text;
    pill.className = `pill tone-${tone}`;
    $("#keyIntro").textContent = configured === true
      ? "A shared key is already set up on the extraction service. Add your own only if you'd rather use your personal quota."
      : "Fetch uses Google Gemini to read briefs. Add your own API key to start extracting; it's free.";
    $("#removeKey").hidden = !has;
    if (has && document.activeElement !== $("#geminiKey")) $("#geminiKey").value = BX.settings.geminiKey();
  }

  function paintStatus() {
    const w = BX.extract.warm;
    const gem = {
      unset: ["muted", "Not set - add its address under Advanced"],
      unknown: ["muted", "Not checked yet"],
      waking: ["warn", "Waking up… free servers sleep when idle (up to a minute)"],
      warm: ["ok", w.configured === false ? "Awake · no shared key, so add yours above" : "Awake · using the shared Gemini key"],
      down: ["err", w.blocked
        ? "Blocked by an ad blocker or privacy extension in this browser. Allow the address below, then reload."
        : `Can't reach it${w.error ? ` (${w.error})` : ""}. Fetch will keep trying; check the address under Advanced if this persists.`],
    }[BX.config.GEMINI_PROXY_URL ? w.state : "unset"] || ["muted", ""];
    $("#geminiDot").className = `dot tone-${gem[0]}`;
    let where = "";
    try { where = new URL(BX.config.GEMINI_PROXY_URL).host; } catch (_) { /* unset */ }
    $("#geminiStatus").textContent = gem[1] + (where ? ` · ${where}` : "")
      + (BX.config.GEMINI_OVERRIDDEN ? " (test address from the page link; open the page with ?reset to go back)" : "");

    const l = hooks.larkStatus ? hooks.larkStatus() : { state: "unknown" };
    const lark = {
      loading: ["warn", "Connecting… (can take up to a minute after a quiet spell)"],
      ok: ["ok", `Connected · ${l.count} brief${l.count === 1 ? "" : "s"}`],
      error: ["err", l.error || "Couldn't connect"],
      unknown: ["muted", "Not checked yet"],
    }[l.state];
    $("#larkDot").className = `dot tone-${lark[0]}`;
    $("#larkStatus").textContent = lark[1];
    paintKey();
  }

  function fillAdvanced() {
    const s = read();
    $("#setGeminiUrl").value = s.geminiUrl || "";
    $("#setGeminiUrl").placeholder = DEFAULTS.GEMINI_PROXY_URL || "https://…onrender.com";
    $("#setLarkUrl").value = s.larkUrl || "";
    $("#setLarkUrl").placeholder = DEFAULTS.LARK_PROXY_URL;
    $("#setLarkTable").value = s.larkTable || "";
    $("#setLarkTable").placeholder = DEFAULTS.LARK_TABLE_URL;
  }

  function paintTheme() {
    const current = read().theme || "system";
    document.querySelectorAll("#themeSeg [data-theme-choice]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.themeChoice === current));
    });
  }

  function show() {
    paintTheme();
    $("#setName").value = BX.settings.name();
    $("#geminiKey").value = BX.settings.geminiKey();
    $("#geminiKey").type = "password";
    result($("#keyResult"));
    result($("#advResult"));
    fillAdvanced();
    if (["down", "unknown"].includes(BX.extract.warm.state)) BX.extract.ensureAwake();   // retry on open
    paintStatus();
    if (location.hash.includes("key")) setTimeout(() => $("#geminiKey").focus(), 350);
  }

  function mount(h) {
    hooks = h;
    $("#themeSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-theme-choice]");
      if (!b) return;
      const theme = b.dataset.themeChoice;
      set({ theme: theme === "system" ? "" : theme });
      applyTheme(theme);
      paintTheme();
    });
    $("#toggleKey").onclick = () => {
      const input = $("#geminiKey");
      input.type = input.type === "password" ? "text" : "password";
      $("#toggleKey").setAttribute("aria-label", input.type === "password" ? "Show key" : "Hide key");
      $("#toggleKey").classList.toggle("is-on", input.type === "text");
    };

    $("#saveKey").onclick = async () => {
      const key = $("#geminiKey").value.trim();
      if (!key) return result($("#keyResult"), false, "Paste your key first.");
      if (!KEY_SHAPE.test(key)) return result($("#keyResult"), false, "That doesn't look like a Gemini API key.");
      set({ geminiKey: key });
      result($("#keyResult"), null, "Saved. Checking it with Google…");
      paintKey();
      const r = await testKey(key);
      result($("#keyResult"), r.ok, r.ok ? `Saved. ${r.message}` : `Saved, but: ${r.message}`);
      if (r.ok) hooks.toast?.("Gemini key saved. You're ready to extract briefs.", { type: "success" });
    };

    $("#testKey").onclick = async () => {
      const key = $("#geminiKey").value.trim() || BX.settings.geminiKey();
      if (!key) return result($("#keyResult"), false, "Paste a key to test.");
      result($("#keyResult"), null, "Checking with Google…");
      const r = await testKey(key);
      result($("#keyResult"), r.ok, r.message);
    };

    $("#removeKey").onclick = () => {
      set({ geminiKey: "" });
      $("#geminiKey").value = "";
      result($("#keyResult"), null, "Key removed from this browser.");
      paintKey();
    };
    $("#geminiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#saveKey").click(); });

    const saveName = () => {
      set({ name: $("#setName").value.trim() });
      result($("#nameResult"), true, "Saved.");
      setTimeout(() => result($("#nameResult")), 1800);
    };
    $("#saveName").onclick = saveName;
    $("#setName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); });

    $("#wakeGemini").onclick = () => { BX.extract.warm.at = 0; BX.extract.ensureAwake(); paintStatus(); };
    $("#refreshLark").onclick = () => hooks.reconnect?.();

    $("#saveAdvanced").onclick = () => {
      const g = $("#setGeminiUrl").value.trim(), l = $("#setLarkUrl").value.trim(), t = $("#setLarkTable").value.trim();
      if (g && !isServiceUrl(g)) return result($("#advResult"), false, "The extraction service URL must start with https://");
      if (l && !isServiceUrl(l)) return result($("#advResult"), false, "The Lark proxy URL must start with https://");
      if (t && !parseLarkTable(t)) return result($("#advResult"), false, "That isn't a Lark table link. Copy it from the table's address bar (…/base/…?table=…).");
      const before = BX.config.LARK_TABLE_ID;
      set({ geminiUrl: g, larkUrl: l, larkTable: t });
      result($("#advResult"), true, "Saved. Reconnecting…");
      hooks.reconnect?.({ tableChanged: BX.config.LARK_TABLE_ID !== before });
    };
    $("#resetAdvanced").onclick = () => {
      const before = BX.config.LARK_TABLE_ID;
      set({ geminiUrl: "", larkUrl: "", larkTable: "" });
      fillAdvanced();
      result($("#advResult"), true, "Back to the default addresses. Reconnecting…");
      hooks.reconnect?.({ tableChanged: BX.config.LARK_TABLE_ID !== before });
    };

    $("#clearLocal").onclick = (e) => {
      const btn = e.currentTarget;
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        btn.textContent = "Click again to clear";
        setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Clear local data"; }, 3500);
        return;
      }
      delete btn.dataset.armed;
      btn.textContent = "Clear local data";
      hooks.clearLocal?.();
    };

    document.addEventListener("bx:status", () => { if (document.body.dataset.view === "settings") paintStatus(); });
  }

  BX.settingsView = { mount, show, paint: paintStatus };
})((window.BX = window.BX || {}));
