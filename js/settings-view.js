/*
 * The Settings screen: account, Gemini key, appearance, connections, advanced
 * addresses (localhost only) and "This browser". The stored settings themselves
 * live in settings.js; app.js passes the callbacks that touch its own state
 * (larkStatus, reconnect, login, logout, clearLocal).
 */
import * as settings from "./settings.js";
import { cfg } from "./settings.js";
import * as auth from "./auth.js";
import * as extract from "./extract.js";
import { $, h, initTheme, toast } from "./ui.js";

let hooks = {};

function result(el, ok, text) {
  el.textContent = text || "";
  el.className = `set-result${ok === true ? " is-ok" : ok === false ? " is-err" : ""}`;
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}
const sessionLine = () => `Logged in until ${fmtTime(auth.endsAt())} · ${fmtLeft(auth.msLeft())} left`;

function paintAccount() {
  const box = $("#account");
  if (auth.currentToken()) {
    const u = auth.user() || {};
    const initials = (u.name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
    const pic = u.avatar ? h("img", { class: "avatar", src: u.avatar, alt: "", referrerpolicy: "no-referrer" })
      : h("span", { class: "avatar avatar-initials", "aria-hidden": "true" }, initials);
    box.replaceChildren(pic,
      h("div", { class: "account-text" }, h("b", {}, u.name || "Logged in with Lark"), h("span", { id: "accSession" }, sessionLine())),
      h("div", { class: "account-actions" },
        h("button", { type: "button", class: "btn btn-sm", onclick: () => hooks.login?.(location.hash) }, "Log in again"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => hooks.logout?.() }, "Log out")));
  } else {
    box.replaceChildren(
      h("div", { class: "account-text" }, h("b", {}, "You're not logged in."), h("span", {}, "Log in with Lark to extract and save briefs. A login lasts about 2 hours.")),
      h("div", { class: "account-actions" },
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => hooks.login?.("#/") }, "Log in with Lark")));
  }
}

function paintKey() {
  const has = !!settings.geminiKey();
  const configured = extract.warm.configured;
  const pill = $("#keyStatus");
  let text, tone;
  if (has) [text, tone] = ["Using your key", "is-ok"];
  else if (configured === true) [text, tone] = ["Using the shared key", "is-ok"];
  else if (configured === false) [text, tone] = ["Key needed", "is-warn"];
  else [text, tone] = ["Checking…", ""];
  pill.textContent = text;
  pill.className = `pill ${tone}`.trim();
  $("#keyIntro").textContent = configured === true
    ? "A shared key is already set up on the extraction service. Add your own only if you'd rather use your personal quota."
    : "Fetch uses Google Gemini to read briefs. Add your own API key to start extracting; it's free.";
  $("#removeKey").hidden = !has;
  if (has && document.activeElement !== $("#geminiKey")) $("#geminiKey").value = settings.geminiKey();
}

function paintStatus() {
  const w = extract.warm;
  const gem = {
    unset: ["", "Not set - add its address under Advanced"],
    unknown: ["", "Not checked yet"],
    waking: ["is-warn", "Waking up… free servers sleep when idle (up to a minute)"],
    warm: ["is-ok", w.configured === false ? "Awake · no shared key, so add yours above" : "Awake · using the shared Gemini key"],
    down: ["is-err", w.blocked
      ? "Blocked by an ad blocker or privacy extension in this browser. Allow the address below, then reload."
      : `Can't reach it${w.error ? ` (${w.error})` : ""}. Fetch will keep trying; check the address under Advanced if this persists.`],
  }[cfg().GEMINI_PROXY_URL ? w.state : "unset"] || ["", ""];
  $("#geminiDot").className = `dot ${gem[0]}`.trim();
  let where = "";
  try { where = new URL(cfg().GEMINI_PROXY_URL).host; } catch (_) { /* unset */ }
  $("#geminiStatus").textContent = gem[1] + (where ? ` · ${where}` : "")
    + (cfg().GEMINI_OVERRIDDEN ? " (test address from the page link; open the page with ?reset to go back)" : "");

  const l = !auth.currentToken() ? { state: "out" } : hooks.larkStatus ? hooks.larkStatus() : { state: "unknown" };
  const lark = {
    out: ["", "Log in to connect"],
    loading: ["is-warn", "Connecting… (can take up to a minute after a quiet spell)"],
    ok: ["is-ok", `Connected · ${l.count} brief${l.count === 1 ? "" : "s"}`],
    error: ["is-err", l.error || "Couldn't connect"],
    unknown: ["", "Not checked yet"],
  }[l.state];
  $("#larkDot").className = `dot ${lark[0]}`.trim();
  $("#larkStatus").textContent = lark[1];
  $("#refreshLark").hidden = l.state === "out";
  paintKey();
  paintAccount();
}

function fillAdvanced() {
  const s = settings.get();
  const d = settings.defaults;
  $("#setGeminiUrl").value = s.geminiUrl || "";
  $("#setGeminiUrl").placeholder = d.GEMINI_PROXY_URL || "https://…onrender.com";
  $("#setLarkUrl").value = s.larkUrl || "";
  $("#setLarkUrl").placeholder = d.LARK_PROXY_URL;
  $("#setLarkTable").value = s.larkTable || "";
  $("#setLarkTable").placeholder = d.LARK_TABLE_URL;
}

function show() {
  $("#advancedBox").hidden = !settings.localPage;
  $("#geminiKey").value = settings.geminiKey();
  $("#geminiKey").type = "password";
  result($("#keyResult"));
  result($("#advResult"));
  fillAdvanced();
  if (["down", "unknown"].includes(extract.warm.state)) extract.ensureAwake();   // retry on open
  paintStatus();
  if (location.hash.includes("key")) setTimeout(() => $("#geminiKey").focus(), 350);
}

function mount(callbacks) {
  hooks = callbacks;
  initTheme($("#themeSeg"), "fetch.theme");
  $("#toggleKey").onclick = () => {
    const input = $("#geminiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("#toggleKey").setAttribute("aria-label", input.type === "password" ? "Show key" : "Hide key");
    $("#toggleKey").classList.toggle("is-on", input.type === "text");
  };

  $("#saveKey").onclick = async () => {
    const key = $("#geminiKey").value.trim();
    if (!key) return result($("#keyResult"), false, "Paste your key first.");
    if (!settings.KEY_SHAPE.test(key)) return result($("#keyResult"), false, "That doesn't look like a Gemini API key.");
    settings.set({ geminiKey: key });
    result($("#keyResult"), null, "Saved. Checking it with Google…");
    paintKey();
    const r = await settings.testKey(key);
    result($("#keyResult"), r.ok, r.ok ? `Saved. ${r.message}` : `Saved, but: ${r.message}`);
    if (r.ok) toast("Gemini key saved. You're ready to extract briefs.", { type: "success" });
  };

  $("#testKey").onclick = async () => {
    const key = $("#geminiKey").value.trim() || settings.geminiKey();
    if (!key) return result($("#keyResult"), false, "Paste a key to test.");
    result($("#keyResult"), null, "Checking with Google…");
    const r = await settings.testKey(key);
    result($("#keyResult"), r.ok, r.message);
  };

  $("#removeKey").onclick = () => {
    settings.set({ geminiKey: "" });
    $("#geminiKey").value = "";
    result($("#keyResult"), null, "Key removed from this browser.");
    paintKey();
  };
  $("#geminiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#saveKey").click(); });

  $("#wakeGemini").onclick = () => { extract.warm.at = 0; extract.ensureAwake(); paintStatus(); };
  $("#refreshLark").onclick = () => hooks.reconnect?.();

  $("#saveAdvanced").onclick = () => {
    const g = $("#setGeminiUrl").value.trim(), l = $("#setLarkUrl").value.trim(), t = $("#setLarkTable").value.trim();
    if (g && !settings.isServiceUrl(g)) return result($("#advResult"), false, "The extraction service URL must start with https://");
    if (l && !settings.isServiceUrl(l)) return result($("#advResult"), false, "The Lark proxy URL must start with https://");
    if (t && !settings.parseLarkTable(t)) return result($("#advResult"), false, "That isn't a Lark table link. Copy it from the table's address bar (…/base/…?table=…).");
    const before = cfg().LARK_TABLE_ID;
    settings.set({ geminiUrl: g, larkUrl: l, larkTable: t });
    result($("#advResult"), true, "Saved. Reconnecting…");
    hooks.reconnect?.({ tableChanged: cfg().LARK_TABLE_ID !== before });
  };
  $("#resetAdvanced").onclick = () => {
    const before = cfg().LARK_TABLE_ID;
    settings.set({ geminiUrl: "", larkUrl: "", larkTable: "" });
    fillAdvanced();
    result($("#advResult"), true, "Back to the default addresses. Reconnecting…");
    hooks.reconnect?.({ tableChanged: cfg().LARK_TABLE_ID !== before });
  };

  // One click; the toast that follows offers Undo (app.js keeps what it cleared).
  $("#clearLocal").onclick = () => hooks.clearLocal?.();

  document.addEventListener(extract.STATUS_EVENT, () => { if (document.body.dataset.view === "settings") paintStatus(); });
}

/** Refresh just the "time left" line (called by the app's session clock). */
function tick() {
  const line = document.getElementById("accSession");
  if (line && auth.currentToken()) line.textContent = sessionLine();
}

export { mount, show, paintStatus as paint, tick, fmtLeft, fmtTime };
