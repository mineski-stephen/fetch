/*
 * The Settings screen: account, Gemini key, appearance, connections, advanced
 * addresses (local page only) and "This browser". The stored settings themselves
 * live in settings.js. The app creates the view with a ctx for what touches its own
 * state: ctx = { larkStatus, schemaProblems, reconnect, login, logout, clearLocal }.
 * The view subscribes to the services' status itself (net.js onAnyService).
 */
import * as settings from "./settings.js";
import { cfg } from "./settings.js";
import * as auth from "./auth.js";
import { larkService, geminiService, onAnyService } from "./net.js";
import { parseBaseLink } from "./tables.js";
import { $, h, ic, initTheme, toast, fmt } from "./ui.js";

function result(el, ok, text) {
  el.textContent = text || "";
  el.className = `set-result${ok === true ? " is-ok" : ok === false ? " is-err" : ""}`;
}

// The family's shared formats ("3:29 PM", "1h 33m"), the same in every tool.
const fmtTime = fmt.time;
const fmtLeft = fmt.duration;
const sessionLine = () => `Logged in until ${fmtTime(auth.endsAt())} · ${fmtLeft(auth.msLeft())} left`;

/** One service's status as [dot class, sentence]: the same words for every service. */
function serviceLine(svc, { awake = "Awake", blockedHelp = "Allow the address below, then reload." } = {}) {
  const s = svc.status;
  const [tone, text] = {
    unset: ["", "Not set. Add its address under Advanced."],
    unknown: ["", "Not checked yet"],
    waking: ["is-warn", "Waking up… It sleeps when nobody's using it. This can take up to a minute."],
    awake: ["is-ok", `${awake}${s.version ? ` · v${s.version}` : ""}`],
    down: ["is-err", `Unreachable (${s.detail || "no answer"}). Fetch keeps trying when you use it.`],
    blocked: ["is-err", `Blocked by an ad blocker or privacy extension in this browser. ${blockedHelp}`],
    outdated: ["is-warn", `Out of date (${s.detail}). Ask the admin to redeploy it.`],
  }[svc.url() ? s.state : "unset"] || ["", ""];
  const mine = cfg().overrides.filter((o) => o.startsWith(svc.id === "gemini" ? "Extraction service" : "Lark proxy"));
  const note = mine.length ? (mine.some((o) => o.includes("page link"))
    ? " (test address from the page link; open the page with ?reset to go back)" : " (test address from Advanced)") : "";
  return [tone, `${text}${svc.host() ? ` · ${svc.host()}` : ""}${note}`];
}

export function createSettingsView(ctx) {
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
          h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.login(location.hash) }, "Log in again"),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => ctx.logout() }, ic("logout"), "Log out")));
    } else {
      box.replaceChildren(
        h("div", { class: "account-text" }, h("b", {}, "You're not logged in."), h("span", {}, "Log in with Lark to extract and save briefs. A login lasts about 2 hours.")),
        h("div", { class: "account-actions" },
          h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => ctx.login("#/") }, "Log in with Lark")));
    }
  }

  function paintKey() {
    const has = !!settings.geminiKey();
    const configured = geminiService.status.state === "awake" ? !!geminiService.status.info.configured : null;
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
    const info = geminiService.status.info || {};
    const gem = serviceLine(geminiService, {
      awake: info.configured === false ? "Awake · no shared key, so add yours above" : info.configured ? "Awake · using the shared Gemini key" : "Awake",
      blockedHelp: "Allow the address below, then reload.",
    });
    $("#geminiDot").className = `dot ${gem[0]}`.trim();
    $("#geminiStatus").textContent = gem[1];
    const conn = serviceLine(larkService);
    $("#larkProxyDot").className = `dot ${conn[0]}`.trim();
    $("#larkProxyStatus").textContent = conn[1];

    const l = !auth.currentToken() ? { state: "out" } : ctx.larkStatus ? ctx.larkStatus() : { state: "unknown" };
    const lark = {
      out: ["", "Log in to connect"],
      loading: ["is-warn", "Connecting… This can take up to a minute after a quiet spell."],
      ok: ["is-ok", `Connected · ${(l.count || 0).toLocaleString()} brief${l.count === 1 ? "" : "s"}`],
      error: ["is-err", l.error || "Couldn't connect"],
      unknown: ["", "Not checked yet"],
    }[l.state];
    $("#larkDot").className = `dot ${lark[0]}`.trim();
    $("#larkStatus").textContent = lark[1];
    $("#refreshLark").hidden = l.state === "out";
    const problems = ctx.schemaProblems ? ctx.schemaProblems() : [];
    $("#schemaBox").hidden = !problems.length;
    $("#schemaList").replaceChildren(...problems.map((p) => h("li", {}, p)));
    paintKey();
    paintAccount();
  }

  function fillAdvanced() {
    const s = settings.get();
    const d = settings.defaults;
    $("#setGeminiUrl").value = s.geminiUrl || "";
    $("#setGeminiUrl").placeholder = d.geminiUrl || "https://…onrender.com";
    $("#setLarkUrl").value = s.larkUrl || "";
    $("#setLarkUrl").placeholder = d.larkUrl;
    $("#setLarkTable").value = s.larkTable || "";
    $("#setLarkTable").placeholder = (d.table && d.table.url) || "https://…larksuite.com/base/…?table=…";
  }

  function show() {
    $("#advancedBox").hidden = !settings.localPage;
    $("#geminiKey").value = settings.geminiKey();
    $("#geminiKey").type = "password";
    result($("#keyResult"));
    result($("#advResult"));
    fillAdvanced();
    for (const svc of [geminiService, larkService]) if (!svc.isFresh()) svc.wake();   // retry on open
    paintStatus();
    if (location.hash.includes("key")) setTimeout(() => $("#geminiKey").focus(), 350);
  }

  function mount() {
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

    $("#wakeGemini").onclick = () => { geminiService.wake({ force: true }); paintStatus(); };
    $("#wakeLark").onclick = () => { larkService.wake({ force: true }); paintStatus(); };
    $("#refreshLark").onclick = () => ctx.reconnect();

    $("#saveAdvanced").onclick = () => {
      const g = $("#setGeminiUrl").value.trim(), l = $("#setLarkUrl").value.trim(), t = $("#setLarkTable").value.trim();
      if (g && !settings.isServiceUrl(g)) return result($("#advResult"), false, "The extraction service URL must start with https:// (or http:// on this computer).");
      if (l && !settings.isServiceUrl(l)) return result($("#advResult"), false, "The Lark proxy URL must start with https:// (or http:// on this computer).");
      if (t) {
        try { parseBaseLink(t); } catch (e) { return result($("#advResult"), false, e.message); }
      }
      const before = cfg().table && cfg().table.table;
      settings.set({ geminiUrl: g, larkUrl: l, larkTable: t });
      result($("#advResult"), true, "Saved. Reconnecting…");
      ctx.reconnect({ tableChanged: (cfg().table && cfg().table.table) !== before });
    };
    $("#resetAdvanced").onclick = () => {
      const before = cfg().table && cfg().table.table;
      settings.set({ geminiUrl: "", larkUrl: "", larkTable: "" });
      fillAdvanced();
      result($("#advResult"), true, "Back to the default addresses. Reconnecting…");
      ctx.reconnect({ tableChanged: (cfg().table && cfg().table.table) !== before });
    };

    // One click; the toast that follows offers Undo (the app keeps what it cleared).
    $("#clearLocal").onclick = () => ctx.clearLocal();

    onAnyService(() => { if (document.body.dataset.view === "settings") paintStatus(); });
  }

  /** Refresh just the "time left" line (called by the app's session clock). */
  function tick() {
    const line = document.getElementById("accSession");
    if (line && auth.currentToken()) line.textContent = sessionLine();
  }

  return { mount, show, paint: paintStatus, tick };
}

export { fmtLeft, fmtTime };
