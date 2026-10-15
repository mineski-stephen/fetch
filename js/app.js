/*
 * Fetch - page controller.
 *
 * Views (hash routes):
 *   #/              compose: drop files / type the brief      (+ processing state)
 *   #/result        the freshly extracted, unsaved draft
 *   #/briefs        every brief saved in the Lark Base
 *   #/briefs/<id>   one saved brief, editable
 *   #/settings      account, Gemini key, connections   (#/settings/key focuses the key)
 *
 * Everything except Settings needs a Lark login (auth.js). Without one, any route
 * shows the login screen and returns to that route after logging in.
 */
import * as B from "./brief.js";
import * as auth from "./auth.js";
import * as extract from "./extract.js";
import * as lark from "./lark.js";
import * as paper from "./doc.js";   // not "doc": that name is used for the open brief below
import * as E from "./evidence.js";
import * as sources from "./sources.js";
import * as pdf from "./pdf.js";
import { createSettingsView, fmtLeft, fmtTime } from "./settings-view.js";
import * as settings from "./settings.js";
import { cfg, geminiKey } from "./settings.js";
import { larkService, geminiService, onAnyService, blockedHosts, describe } from "./net.js";
import { describeWrite, isUncertain, LarkError } from "./errors.js";
import { APP, ENV_LABEL, RULES, LARK } from "./config.js";
import { sigs } from "./rows.js";
import { ICONS } from "./icons.js";
import { $, $$, h, ic, fillIcons, toast, busy, flashDone, popBadge, copyText, flash, openMenu, closeMenu, confirmDanger,
         radioKeys, confetti, store, recall, reduceMotion } from "./ui.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const fingerprint = (m) => JSON.stringify(B.normalize(m));
const NEWER_MSG = "This was saved by a newer version of Fetch. Reload the page to edit it.";

// ---- storage (localStorage; null clears a key) ----------------------------
const save = (key, value) => store("local", key, value == null ? undefined : value);

// What "Clear local data" and the end of a session remove (the login and the theme are kept).
const KEYS = { draft: "fetch.draft", eta: "fetch.etaFactor", edits: "fetch.edits" };
const CACHE_PREFIX = "fetch.cache.";   // cached list of briefs, one key per table
const cacheKey = () => { const t = cfg().table; return t ? `${CACHE_PREFIX}${t.app}:${t.table}` : ""; };
/** Remove every cached list of briefs (any table). Shared computers: nothing outlives a session. */
function dropCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  } catch (_) { /* storage blocked: nothing was cached */ }
}

// ---- state --------------------------------------------------------------
const S = {
  view: null,
  items: [],        // compose: { id, file, kind, thumb }
  job: null,        // running extraction
  draft: recall("local", KEYS.draft),   // { model, original, meta, sources, createdAt, clientToken, newer, evidence }
  doc: null,        // what the result view shows
  edits: {},        // unsaved edits to saved briefs, by record id: { model, nextSteps, attachments }
  draftFiles: [],   // File objects behind the draft (memory only; attached to the Lark row on save)
  briefs: null, briefsAt: 0, briefsLoading: null, larkError: null, highlight: null,
  working: new Set(),   // ids with a Done change in flight
  checking: false,      // "Check sources" mode on the open draft
};
if (S.draft && !S.draft.model) S.draft = null;
// The cached list gives an instant first paint, but only while a login is alive (it is dropped
// when a session ends) and never as the basis for a write: saving re-reads the row.
if (auth.currentToken() && cacheKey()) {
  const cached = recall("local", cacheKey());
  if (cached && cached.v === 2 && Array.isArray(cached.rows)) { S.briefs = cached.rows; S.briefsAt = 0; S.cachedAt = cached.at; }
} else {
  dropCache();
}

// ---- small UI helpers -----------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

function downloadText(name, text, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- views & routing --------------------------------------------------------
const TITLES = { login: "Log in", busy: "Logging in", compose: "New brief", processing: "Extracting a brief",
  result: "Brief", briefs: "All briefs", settings: "Settings" };
const setTitle = (text) => { document.title = `${text} · ${APP.name}`; };

function showView(name) {
  const changed = S.view !== name;
  S.view = name;
  setTitle(TITLES[name] || APP.name);
  paper.close();
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  document.body.dataset.view = name;
  const section = name === "login" || name === "busy" ? "" : name === "settings" ? "settings"
    : name === "briefs" || (name === "result" && S.doc?.mode === "record") ? "briefs" : "compose";
  $$("[data-nav]").forEach((a) => {
    if (a.dataset.nav === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (changed) window.scrollTo(0, 0);
}

const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };

function route() {
  const [a, b] = location.hash.replace(/^#\/?/, "").split("/");
  renderHeader();
  updateWriteNote();
  if (a !== "settings" && !auth.currentToken()) return showLogin();
  if (a === "briefs" && b) return showRecord(decodeURIComponent(b));
  if (a === "briefs") return showBriefs();
  if (a === "result") return S.draft ? showDraft() : go("#/");
  if (a === "settings") return showSettings();
  return showCompose();
}

function showSettings() {
  showView("settings");
  settingsView.show();
}

// ---- Lark login ------------------------------------------------------------------
const LOW_SESSION_MS = 10 * 60 * 1000;
const loginState = { note: "", returnTo: "", redirectChecked: false };

function showLogin() {
  loginState.returnTo = location.hash && location.hash !== "#/login" ? location.hash : "#/";
  showView("login");
  $("#loginMsg").hidden = !loginState.note;
  $("#loginMsg").textContent = loginState.note;
  busy($("#loginBtn"), false);
  if (!loginState.redirectChecked || loginState.note) {   // is this address registered on the Lark app? (again after a failure)
    loginState.redirectChecked = true;
    auth.redirectProblem().then((problem) => {
      $("#redirectMsg").hidden = !problem;
      $("#redirectMsg").textContent = problem || "";
    });
  }
}

async function login(returnTo) {
  try {
    busy($("#loginBtn"), true, "Opening Lark…");
    await auth.startLogin(returnTo || loginState.returnTo || "#/");
  } catch (e) {
    busy($("#loginBtn"), false);
    loginState.note = e.message;
    if (S.view === "login") showLogin(); else toast(e.message, { type: "error" });
  }
}

/** The login ended (expired, logged out, or Lark refused the token). Unsaved work stays:
 *  the draft is in localStorage and edits are kept for the next login. Cached business
 *  data does not: it is dropped with the session. */
function sessionEnded(message) {
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());   // shared sheets resolve and remove themselves
  closeMenu();
  S.briefs = null;
  S.briefsAt = 0;
  S.larkError = null;
  dropCache();
  cacheBriefs(false);
  loginState.note = message || "Your login ended. Log in again to keep going.";
  renderHeader();
  if (S.view === "settings") return settingsView.show();
  if (S.job) return;   // let a running extraction finish; it reports the login error itself
  showLogin();
}

function initials(name) {
  return (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

function renderHeader() {
  const overrides = cfg().overrides;   // the red badge, whenever anything is overridden
  $("#envBadge").hidden = !ENV_LABEL;
  $("#envBadge").textContent = ENV_LABEL;
  $("#overrideBadge").hidden = !overrides.length;
  $("#overrideBadge").title = `Overridden: ${overrides.join("; ")}`;
  const signedIn = !!auth.currentToken();
  document.body.dataset.auth = signedIn ? "in" : "out";
  if (!signedIn) return;
  const left = auth.msLeft();
  const pill = $("#sessionPill");
  $("#sessionLeft").textContent = fmtLeft(left);
  pill.classList.toggle("is-low", left < LOW_SESSION_MS);
  pill.title = `Your login lasts until ${fmtTime(auth.endsAt())}`;
  pill.setAttribute("aria-label", `Logged in for ${fmtLeft(left)} more, until ${fmtTime(auth.endsAt())}`);
  const u = auth.user() || {};
  const img = $("#avatar");
  img.hidden = !u.avatar;
  if (u.avatar && img.getAttribute("src") !== u.avatar) img.src = u.avatar;
  $("#initials").hidden = !!u.avatar;
  $("#initials").textContent = initials(u.name);
  $("#meLink").title = u.name ? `${u.name} · Settings` : "Settings";
}

/** Why saving, Done and Delete are off right now ("" if they're on): a login that can only read,
 *  or a table that doesn't match what Fetch expects (schema.js lists the details). */
function writeProblem() {
  if (!auth.canWrite()) return "Your login can only read the tables. Log in again to allow saving.";
  if (lark.schema.problems.length) return "Saving is off until the briefs table is fixed. Tell the tool owner.";
  return "";
}

/** Plain-language list for the callout and Settings. */
const schemaProblems = () => (auth.canWrite() ? [] : ["Your login can only read the tables. Log in again to allow saving."])
  .concat(lark.schema.problems, lark.schema.partial);

/** Show or hide the "saving is off" callout. */
function updateWriteNote() {
  const list = auth.currentToken() ? schemaProblems() : [];
  const note = $("#writeNote");
  note.hidden = !list.length;
  if (!list.length) return;
  const tableProblem = lark.schema.problems.length > 0 || lark.schema.partial.length > 0;
  $("#writeNoteText").replaceChildren(h("b", {}, writeProblem() ? "Saving is switched off." : "Some actions are switched off."),
    tableProblem ? " The briefs table doesn't match what Fetch expects. Tell the tool owner." : "");
  $("#writeNoteList").replaceChildren(...list.map((p) => h("li", {}, p)));
}

/** Why extraction can't run right now ("" if it can). */
function setupProblem() {
  if (!cfg().geminiUrl) return "The extraction service isn't connected. Add its address in Settings.";
  if (geminiService.status.state === "outdated") return "The extraction service is out of date. Ask the admin to redeploy it.";
  if (geminiService.status.state === "awake" && geminiService.status.info.configured === false && !geminiKey()) {
    return "Add your Gemini API key in Settings to start extracting briefs.";
  }
  return "";
}

function updateSetupNote() {
  const problem = setupProblem();
  $("#setupNote").hidden = !problem;
  if (problem) {
    $("#setupText").textContent = !cfg().geminiUrl ? "connect the extraction service."
      : geminiService.status.state === "outdated" ? "the extraction service is out of date. Ask the admin to redeploy it."
        : "add your Gemini API key to start extracting briefs.";
  }
  updateCompose();
}

/** The red banner at the top of the page when the browser blocks a service. */
function updateBlockNote() {
  const hosts = blockedHosts();
  $("#blockNote").hidden = !hosts.length;
  $("#blockHost").textContent = hosts.join(" and ");
}

// ==== 1. Compose ================================================================
const textarea = () => $("#briefText");

function composeReady() {
  return S.items.length > 0 || textarea().value.trim().length > 0;
}

function updateCompose() {
  const n = S.items.length, bytes = S.items.reduce((s, it) => s + it.file.size, 0);
  const chars = textarea().value.trim().length;
  const parts = [];
  if (n) parts.push(`${n} file${n > 1 ? "s" : ""} · ${fmtBytes(bytes)}`);
  if (chars) parts.push(`${chars.toLocaleString()} characters of text`);
  $("#composeHint").textContent = parts.length ? `Ready: ${parts.join(" + ")}` : "";
  $("#extractBtn").disabled = !composeReady() || !!setupProblem();
  $("#dropzone").classList.toggle("has-content", composeReady());
}

const KIND_LABEL = { pdf: "PDF", image: "IMG", doc: "DOC", slides: "PPT", sheet: "XLS", mail: "EML", audio: "AUD", video: "VID", text: "TXT" };

function renderFiles() {
  const list = $("#fileList");
  list.replaceChildren(...S.items.map((it) => h("li", { class: `file kind-${it.kind}`, "data-id": it.id },
    it.thumb ? h("img", { class: "file-thumb", src: it.thumb, alt: "" }) : h("span", { class: "file-badge" }, KIND_LABEL[it.kind]),
    h("span", { class: "file-info" }, h("span", { class: "file-name", title: it.file.name }, it.file.name),
      h("span", { class: "file-size" }, fmtBytes(it.file.size))),
    h("button", { type: "button", class: "file-x", "aria-label": `Remove ${it.file.name}`, "data-remove": it.id }, ic("x")))));
  updateCompose();
}

function addFiles(fileList, { pasted = false } = {}) {
  const { maxUploadMb, maxFiles } = extract.limits();   // what the extraction service reports, else the config's
  const maxBytes = maxUploadMb * 1048576;
  let skipped = 0;
  for (let file of fileList) {
    if (!file || !file.size) continue;
    if (S.items.length >= maxFiles) { toast(`You can add up to ${maxFiles} files per brief.`, { type: "error" }); break; }
    if (S.items.some((it) => it.file.name === file.name && it.file.size === file.size && it.file.lastModified === file.lastModified)) { skipped++; continue; }
    const total = S.items.reduce((s, it) => s + it.file.size, 0) + file.size;
    if (total > maxBytes) { toast(`That would be over ${maxUploadMb} MB in total. Try compressing the file first.`, { type: "error" }); break; }
    if (pasted && /^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
      const t = new Date();
      const stamp = `${t.getHours()}-${String(t.getMinutes()).padStart(2, "0")}-${String(t.getSeconds()).padStart(2, "0")}`;
      file = new File([file], `Pasted screenshot ${stamp}.${file.name.split(".").pop()}`, { type: file.type, lastModified: file.lastModified });
    }
    const kind = extract.kindOf(file);
    const thumb = kind === "image" && /^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/.test(file.type) ? URL.createObjectURL(file) : null;
    S.items.push({ id: Math.random().toString(36).slice(2), file, kind, thumb });
  }
  if (skipped) toast("That file is already added.");
  renderFiles();
}

function removeFile(id) {
  const i = S.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  const [it] = S.items.splice(i, 1);
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  const li = $(`#fileList [data-id="${id}"]`);
  if (li && !reduceMotion()) { li.classList.add("out"); setTimeout(renderFiles, 180); } else renderFiles();
}

function clearCompose() {
  S.items.forEach((it) => it.thumb && URL.revokeObjectURL(it.thumb));
  S.items = [];
  textarea().value = "";
  saveComposeText();
  autosize();
  renderFiles();
}

// Typed text survives a trip to Lark's login page (this tab only).
function saveComposeText() {
  store("session", "fetch.composeText", textarea().value || undefined);
}
function restoreComposeText() {
  const t = recall("session", "fetch.composeText");
  if (t && !textarea().value) textarea().value = t;
}

function autosize() {
  const ta = textarea();
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.max(160, window.innerHeight * 0.45))}px`;
}

function showCompose() {
  if (S.job) return showView("processing");
  showView("compose");
  const banner = $("#resumeBanner");
  banner.hidden = !S.draft;
  if (S.draft) $("#resumeTitle").textContent = B.normalize(S.draft.model).project_title;
  updateCompose();
}

function wireCompose() {
  const dz = $("#dropzone"), input = $("#fileInput");
  $("#browseBtn").onclick = () => input.click();
  dz.addEventListener("click", (e) => {
    if (e.target === dz || e.target.closest(".dz-top") && !e.target.closest("button")) input.click();
  });
  input.onchange = () => { addFiles(input.files); input.value = ""; };
  $("#fileList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (b) { e.stopPropagation(); removeFile(b.dataset.remove); }
  });
  restoreComposeText();
  textarea().addEventListener("input", () => { autosize(); updateCompose(); saveComposeText(); });
  textarea().addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && composeReady()) { autoRetry.used = false; startExtraction(); }
  });
  $("#extractBtn").onclick = () => { autoRetry.used = false; startExtraction(); };
  $("#resumeOpen").onclick = () => go("#/result");
  $("#resumeDiscard").onclick = () => {
    const draft = S.draft, files = S.draftFiles;
    setDraft(null);
    S.draftFiles = [];
    $("#resumeBanner").hidden = true;
    toast("Draft discarded.", { type: "success", action: "Undo", onAction: () => {
      if (S.draft) return;   // a newer brief has been extracted since
      setDraft(draft);
      S.draftFiles = files;
      if (S.view === "compose") showCompose();
    } });
  };

  // Drag & drop anywhere on the page.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) document.body.classList.add("dragging");
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); }
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    if (S.job) return toast("Please wait for the current brief to finish.");
    addFiles(e.dataTransfer.files);
    if (S.view !== "compose") go("#/");
  });

  // Paste screenshots / text from anywhere on the compose view.
  document.addEventListener("paste", (e) => {
    if (S.view !== "compose") return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files, { pasted: true });
      toast(files.length > 1 ? `${files.length} pasted files added.` : "Pasted file added.", { type: "success", timeout: 2200 });
      return;
    }
    const editable = e.target.closest?.("textarea, input, [contenteditable]");
    const text = e.clipboardData?.getData("text/plain");
    if (!editable && text) {
      e.preventDefault();
      const ta = textarea();
      ta.value = ta.value ? `${ta.value.trimEnd()}\n\n${text}` : text;
      ta.focus();
      autosize();
      updateCompose();
    }
  });
}

// ==== 2. Processing =============================================================
const RING = 2 * Math.PI * 52;
const STAGES = ["Uploading your files…", "Reading the brief…", "Extracting key details…", "Formatting the summary…"];

const STEP_ORDER = ["wake", 0, 1, 2, 3];

/** Mark step `i` ("wake" or 0–3) as current; earlier steps done. */
function setStep(i, done = false) {
  const at = STEP_ORDER.indexOf(i);
  $$("#steps li").forEach((li) => {
    const n = STEP_ORDER.indexOf(li.dataset.step === "wake" ? "wake" : Number(li.dataset.step));
    const state = done || n < at ? "done" : n === at ? "current" : "";
    if (li.className === state && li.firstElementChild.matches({ done: ".i", current: ".spinner" }[state] || ".slot")) return;   // unchanged
    li.className = state;
    li.firstElementChild.replaceWith(state === "done" ? ic("check") : state === "current"
      ? h("span", { class: "spinner", "aria-hidden": "true" }) : h("span", { class: "slot" }));
  });
}

/** The upload's real progress beside "Uploading files" ("" hides it). */
const setUploadCount = (text) => { $('#steps [data-step="0"] .n').textContent = text; };

function setRing(p) {
  $("#ringFill").style.strokeDashoffset = String(RING * (1 - Math.max(0, Math.min(1, p))));
}

function resetLoader() {
  $("#loader").classList.remove("is-error", "is-done", "is-waking", "is-overtime");
  $("#loaderError").hidden = true;
  $("#errSettingsBtn").hidden = true;
  $('#steps [data-step="wake"]').hidden = true;
  $("#retryBtn").textContent = "Try again";
  $("#cancelBtn").hidden = false;
  $("#ringFill").style.strokeDasharray = String(RING);
  setRing(0);
  setStep(0);
  setUploadCount("");
  $("#stageLabel").textContent = "Preparing your files…";
  $("#etaNumber").textContent = "…";
  $("#etaUnit").textContent = "";
  $("#etaLabel").textContent = "Working out how long this will take…";
}

function tickWake() {
  setStep("wake");
  $("#stageLabel").textContent = "Waking up the extraction service…";
  $("#etaLabel").textContent = "It sleeps when nobody's used it for a while, so the first brief takes a little longer.";
}

function tick() {
  const job = S.job;
  if (job?.phase === "wake") return tickWake();
  if (!job || !job.est) return;
  const now = performance.now();
  const t = (now - job.t0) / 1000;
  const est = job.est;
  const share = Math.min(0.45, Math.max(0.06, (est.upload + est.cold) / est.total));
  let p, step, label;

  if (!job.uploadedAt) {
    const frac = job.upload || 0;
    p = share * Math.max(frac, Math.min(0.9, t / Math.max(2, est.upload + est.cold)));
    step = 0;
    label = STAGES[0];
    setUploadCount(frac > 0 && frac < 1 ? `${Math.round(frac * 100)}%` : "");
  } else {
    setUploadCount("");
    const spent = (job.uploadedAt - job.t0) / 1000;
    const r = (t - spent) / Math.max(6, est.total - spent);
    p = share + (1 - share) * (r < 1 ? 0.9 * r : 0.9 + 0.08 * (1 - Math.exp(-(r - 1) * 2)));
    // Gemini reads, extracts and formats in one call, so stay on "Extracting" until it answers;
    // "Formatting" ticks off with the result instead of sitting there for a minute.
    step = r < 0.3 ? 1 : 2;
    label = STAGES[step];
  }

  const left = Math.ceil(est.total - t);
  const over = !!job.uploadedAt && left <= 2;
  $("#loader").classList.toggle("is-overtime", over);
  setRing(over ? 0.25 : p);   // past the estimate the ring spins: still alive, no fake percentage
  setStep(step);
  if (!over) {
    $("#stageLabel").textContent = label;
    $("#etaNumber").textContent = left > 2 ? `~${left}` : "…";
    $("#etaUnit").textContent = left > 2 ? "sec" : "";
    $("#etaLabel").textContent = left > 60 ? `About ${Math.round(left / 60 * 2) / 2} min left` : `About ${Math.max(left, 1)} seconds left`;
    return;
  }

  // Past the estimate: count up instead of sitting on "almost", and say why it's slow.
  const secs = Math.floor(t);
  $("#etaNumber").textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  $("#etaUnit").textContent = "elapsed";
  const [head, sub] = -left < 15
    ? ["Almost there…", "Taking a few seconds longer than estimated."]
    : t < 60
      ? ["Still working - complex briefs take a little longer…", "Gemini is still writing the summary. Long or image-heavy briefs can take a minute or more."]
      : t < 150
        ? ["Still working - Gemini may be busy right now", "If Gemini is overloaded, Fetch retries and switches to a backup model by itself. This can take up to 3 minutes - no need to start over."]
        : ["Taking much longer than usual", "Still waiting on Gemini. You can keep waiting (it gives up by itself after about 5 minutes), or cancel and try again later."];
  $("#stageLabel").textContent = head;
  $("#etaLabel").textContent = sub;
}

async function startExtraction() {
  if (!composeReady() || S.job) return;
  if (!auth.ensureTime(2 * 60 * 1000)) return;
  const problem = setupProblem();
  if (problem) {
    return toast(problem, { type: "error", action: "Open Settings", onAction: () => go("#/settings/key") });
  }
  const text = textarea().value.trim();
  const items = S.items.slice();
  resetLoader();
  showView("processing");

  const job = { started: performance.now(), upload: 0 };
  S.job = job;
  let files;
  try {
    files = await extract.prepare(items);
  } catch (_) {
    files = items.map((it) => it.file);
  }
  if (S.job !== job) return;   // cancelled while preparing

  // The free Render instance sleeps when idle. If it doesn't answer at once,
  // show a "waking up" phase and wait for it before uploading anything.
  if (!geminiService.isFresh()) {
    const awake = geminiService.wake();
    const quick = await Promise.race([awake, new Promise((r) => setTimeout(() => r("slow"), 1200))]);
    if (S.job !== job) return;
    if (quick !== true) {
      job.phase = "wake";
      $("#loader").classList.add("is-waking");
      $('#steps [data-step="wake"]').hidden = false;
      setRing(0.25);
      job.timer = setInterval(tick, 250);
      tick();
      const ok = await awake;
      clearInterval(job.timer);
      $("#loader").classList.remove("is-waking");
      if (S.job !== job) return;
      if (!ok) {
        S.job = null;
        const state = geminiService.status.state;
        if (state === "blocked") {
          return showLoaderError({ code: "network", message: describe({ network: true }) });
        }
        if (state === "outdated") {
          return showLoaderError({ code: "outdated", message: `The extraction service is out of date (${geminiService.status.detail}). Ask the admin to redeploy it.` });
        }
        return showLoaderError({ code: "network", message: `Fetch can't reach its extraction service (${geminiService.host()}).${
          cfg().overrides.some((o) => o.startsWith("Extraction service")) ? " It's a test address; open the page with ?reset to use the normal one." : ""
        } Check your connection, then try again.` });
      }
    }
    if (setupProblem()) {
      S.job = null;
      return showLoaderError({ code: "not_configured", message: "No Gemini API key is set up yet. Add your own key in Settings." });
    }
  }
  job.phase = "work";
  job.t0 = performance.now();
  job.est = extract.estimate(files, text.length);
  job.timer = setInterval(tick, 200);
  tick();

  const req = extract.send(files, text, {
    onUploadProgress: (f) => { job.upload = f; },
    onUploaded: () => { job.uploadedAt = performance.now(); },
  });
  job.abort = req.abort;

  try {
    const res = await auth.track(req.promise);   // the clock won't end the login under a running extraction
    if (job.uploadedAt) extract.calibrate(job.est.work, (performance.now() - job.uploadedAt) / 1000);
    clearInterval(job.timer);
    setRing(1);
    setStep(4, true);
    $("#stageLabel").textContent = "Done!";
    $("#loader").classList.remove("is-overtime");
    $("#loader").classList.add("is-done");
    autoRetry.used = false;
    const model = B.normalize(res.brief);
    const clientToken = lark.uuid();
    setDraft({
      model, original: clone(model), meta: res.meta, createdAt: Date.now(), clientToken,
      newer: B.isNewer(res.brief),   // made by a newer extraction service than this page knows: don't save from here
      sources: [...files.map((f) => f.name), ...(text ? ["Typed / pasted text"] : [])], nextSteps: [],
      // Where each value came from ("Check sources"); null from a service older than 1.6. Never sent to Lark.
      evidence: Array.isArray(res.evidence) ? res.evidence : null,
    });
    S.draftFiles = [...files, ...(text ? [new File([text], "Brief text.txt", { type: "text/plain" })] : [])];
    sources.attach(clientToken, { files, texts: res.texts, typed: text });   // memory only, like draftFiles
    S.job = null;
    clearCompose();
    const secs = Math.round((performance.now() - job.started) / 1000);
    await new Promise((r) => setTimeout(r, reduceMotion() ? 0 : 550));
    if (S.view === "processing") {
      go("#/result");
      toast(`Brief extracted in ${secs}s. Review it, then save it to Lark.`, { type: "success" });
    } else {
      toast("Your brief is ready.", { type: "success", action: "View", onAction: () => go("#/result"), timeout: 0 });
    }
  } catch (err) {
    clearInterval(job.timer);
    if (S.job !== job) return;
    S.job = null;
    if (err.code === "aborted") return showCompose();
    if (/^login_/.test(err.code || "")) {   // typed text and the draft survive; files must be re-added after login
      return sessionEnded(`${err.message} Your typed text is kept; files need to be added again after logging in.`);
    }
    showLoaderError(err);
  }
}

let autoRetry = { timer: null, used: false };

function stopAutoRetry() {
  clearInterval(autoRetry.timer);
  autoRetry.timer = null;
  $("#autoRetry").hidden = true;
}

function showLoaderError(err) {
  showView("processing");
  $("#loader").classList.remove("is-overtime");
  $("#loader").classList.add("is-error");
  $("#cancelBtn").hidden = true;
  $("#loaderError").hidden = false;
  const retryable = !["unsupported_file", "no_input", "too_large", "too_many_files", "content_rejected",
    "forbidden_origin", "not_configured", "invalid_api_key", "not_authorized", "outdated",
    "login_required", "login_expired", "login_invalid"].includes(err.code);
  $("#loaderErrorText").textContent = err.message || "Something went wrong.";
  $("#retryBtn").hidden = !retryable;
  $("#errSettingsBtn").hidden = !["not_configured", "invalid_api_key", "quota_exceeded"].includes(err.code);
  $("#stageLabel").textContent = {
    not_configured: "A Gemini API key is needed",
    invalid_api_key: "Your Gemini key needs attention",
    quota_exceeded: "Gemini usage limit reached",
    not_authorized: "Your account doesn't have access",
    outdated: "The extraction service is out of date",
    login_required: "Please log in again",
    login_expired: "Your login has ended",
    login_invalid: "Please log in again",
  }[err.code] || (retryable ? "That didn't work this time" : "This brief couldn't be processed");
  $("#etaLabel").textContent = "";

  // Gemini overloads are usually brief: retry once on our own, with a visible countdown.
  if (err.code === "upstream_unavailable" && !autoRetry.used) {
    autoRetry.used = true;
    let left = Math.min(45, Math.max(15, err.retryAfter || 20));
    const note = $("#autoRetry");
    const paint = () => { note.textContent = `Retrying automatically in ${left}s…`; };
    note.hidden = false;
    paint();
    $("#retryBtn").textContent = "Retry now";
    autoRetry.timer = setInterval(() => {
      if (--left <= 0) { stopAutoRetry(); startExtraction(); } else paint();
    }, 1000);
  }
}

function wireProcessing() {
  $("#cancelBtn").onclick = () => {
    const job = S.job;
    S.job = null;
    if (job) { clearInterval(job.timer); job.abort?.(); }
    showCompose();
    toast("Cancelled. Your files are still here.");
  };
  $("#retryBtn").onclick = () => { stopAutoRetry(); startExtraction(); };
  $("#backBtn").onclick = () => { stopAutoRetry(); autoRetry.used = false; showCompose(); };
}

// ==== 3. Result (draft or saved brief) ===========================================
function setDraft(draft) {
  S.draft = draft;
  save(KEYS.draft, draft);
}

let persistTimer = null;
function persistDraftSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => S.doc?.mode === "draft" && S.draft && save(KEYS.draft, S.draft), 400);
}

function showDraft() {
  const d = S.draft;
  d.model = B.normalize(d.model);   // tidy drafts saved by older versions (e.g. em dashes)
  openDoc({
    mode: "draft", model: d.model, original: d.original, meta: d.meta, sources: d.sources,
    nextSteps: d.nextSteps || [],
    requirement: d.requirement ?? d.model.requirement?.type ?? "",
    vat: d.vat ?? B.normalize(d.model).vat.applies,
    attachments: S.draftFiles.map((f) => ({ name: f.name, size: f.size, file: f })),
    newer: !!d.newer,
    filesLost: !S.draftFiles.length && (d.sources || []).length > 0,   // page was reloaded since extraction
  });
}

// ---- Next steps & attachments: saved to the Lark row, never part of the document ----
const extrasKey = (doc) => JSON.stringify([doc.requirement || "", doc.vat || "", [...doc.nextSteps].sort(),
  doc.attachments.map((a) => a.token || `new:${a.name}:${a.size}`)]);

function rememberEdits(doc) {
  if (doc.mode !== "record") return;
  if (isDirty(doc)) {
    S.edits[doc.id] = { model: doc.model, nextSteps: doc.nextSteps, attachments: doc.attachments,
      requirement: doc.requirement, vat: doc.vat, sig: doc.sig };
  }
  else delete S.edits[doc.id];
}

function onExtrasChange() {
  const doc = S.doc;
  if (!doc) return;
  if (doc.mode === "draft" && S.draft) {
    S.draft.nextSteps = doc.nextSteps;
    S.draft.requirement = doc.requirement;
    S.draft.vat = doc.vat;
    S.draftFiles = doc.attachments.filter((a) => a.file).map((a) => a.file);
    persistDraftSoon();
  }
  rememberEdits(doc);
  renderExtras();
  refreshResult();
}

function stepOptions(doc) {
  const seen = new Map();
  const add = (v) => { const t = String(v || "").trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
  RULES.nextSteps.forEach(add);
  (S.briefs || []).forEach((b) => (b.nextSteps || []).forEach(add));
  doc.nextSteps.forEach(add);
  return [...seen.values()];
}

/** Single-choice chips for Requirement type / VAT (new briefs start on Gemini's pick). */
/** Re-render a chip list without losing keyboard focus (arrow keys re-render it on every move). */
function keepFocus(list, attr, render) {
  const had = list.contains(document.activeElement) ? document.activeElement.getAttribute(attr) : null;
  render();
  if (had != null) [...list.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === had)?.focus();
}

function renderChoice(listId, whyId, choices, picked, suggestion) {
  const list = $(listId);
  keepFocus(list, "data-choice", () => list.replaceChildren(...Object.entries(choices).map(([key, c]) => h("button", {
    type: "button", role: "radio", class: "chip-opt", "aria-checked": String(picked === key), "data-choice": key,
  }, picked === key ? ic("check") : null, key === "YES" || key === "NO" ? c.label.trim() : key, " ", h("small", {}, c.hint)))));
  const why = $(whyId);
  why.hidden = !suggestion.reason;
  why.replaceChildren(h("b", {}, "Note: "), suggestion.reason || "");
}

function renderExtras() {
  const doc = S.doc;
  if (!doc) return;
  const m = doc.model;
  // A value Lark holds that isn't one of Fetch's options is kept unless a chip is picked.
  const kept = (raw, picked) => (raw && !picked ? `Lark has “${raw}” here. It stays unless you pick one.` : "");
  renderChoice("#reqChips", "#reqWhy", RULES.requirementTypes, doc.requirement,
    { key: m.requirement?.type || "", reason: kept(doc.requirementRaw, doc.requirement) || m.requirement?.reason || "" });
  const vat = B.normalize(m).vat;   // pick always agrees with its note
  renderChoice("#vatChips", "#vatWhy", RULES.vatChoices, doc.vat,
    { key: vat.applies, reason: kept(doc.vatRaw, doc.vat) || vat.reason });
  const chosen = new Set(doc.nextSteps.map((t) => t.toLowerCase()));
  keepFocus($("#nsChips"), "data-step", () => $("#nsChips").replaceChildren(...stepOptions(doc).map((opt) => h("button", {
    type: "button", class: "chip-opt", "aria-pressed": String(chosen.has(opt.toLowerCase())), "data-step": opt,
  }, chosen.has(opt.toLowerCase()) ? ic("check") : null, opt))));

  const max = LARK.maxUploadMb * 1048576;
  const list = $("#attList");
  list.replaceChildren(...doc.attachments.map((a, i) => {
    const tooBig = !a.token && a.size > max;
    return h("li", { class: `att${tooBig ? " is-warn" : ""}` },
      ic(tooBig ? "alert" : "file"),
      h("span", { class: "att-info" }, h("span", { class: "att-name", title: a.name }, a.name),
        h("span", { class: "att-meta" }, [fmtBytes(a.size || 0),
          a.token ? "in Lark" : tooBig ? `too large (max ${LARK.maxUploadMb} MB)` : "uploads on save"].join(" · "))),
      h("button", { type: "button", class: "att-x", "data-remove": String(i), "aria-label": `Remove ${a.name}` }, ic("x")));
  }));
  list.hidden = !doc.attachments.length;
  const note = $("#attNote");
  note.hidden = !doc.filesLost;
  note.textContent = doc.filesLost ? "The page was reloaded, so the original files need adding again if you want them attached." : "";
}

function wireExtras() {
  for (const [id, prop] of [["#reqChips", "requirement"], ["#vatChips", "vat"]]) {
    $(id).addEventListener("click", (e) => {
      const chip = e.target.closest("[data-choice]");
      if (!chip || !S.doc) return;
      S.doc[prop] = S.doc[prop] === chip.dataset.choice ? "" : chip.dataset.choice;   // click again to clear
      onExtrasChange();
    });
  }
  $("#nsChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip-opt[data-step]");
    if (!chip || !S.doc) return;
    const t = chip.dataset.step, steps = S.doc.nextSteps;
    const i = steps.findIndex((x) => x.toLowerCase() === t.toLowerCase());
    if (i >= 0) steps.splice(i, 1); else steps.push(t);
    onExtrasChange();
  });
  $("#nsAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#nsAddInput"), t = input.value.trim();
    if (!t || !S.doc) return;
    if (!S.doc.nextSteps.some((x) => x.toLowerCase() === t.toLowerCase())) S.doc.nextSteps.push(t);
    input.value = "";
    onExtrasChange();
  });
  $("#attAddBtn").onclick = () => $("#attInput").click();
  $("#attInput").onchange = (e) => {
    if (!S.doc) return;
    for (const f of e.target.files) {
      if (!S.doc.attachments.some((a) => a.file && a.name === f.name && a.size === f.size)) {
        S.doc.attachments.push({ name: f.name, size: f.size, file: f });
      }
    }
    e.target.value = "";
    S.doc.filesLost = false;
    onExtrasChange();
  };
  $("#attList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b || !S.doc) return;
    S.doc.attachments.splice(Number(b.dataset.remove), 1);
    onExtrasChange();
  });
}

/** Upload attachments that aren't in Lark yet. Every file is tried; the row is written only when
 *  none failed (see confirmSave). Returns the ones that failed, as { name, why }. A login that
 *  ends mid-way throws instead. */
async function uploadPending(doc, label) {
  const max = LARK.maxUploadMb * 1048576;
  const pending = doc.attachments.filter((a) => a.file && !a.token);
  const failed = [];
  for (let i = 0; i < pending.length; i++) {
    const a = pending[i];
    if (a.file.size > max) { failed.push({ name: a.name, why: `over ${LARK.maxUploadMb} MB` }); continue; }
    label.textContent = pending.length > 1 ? `Uploading file ${i + 1} of ${pending.length}…` : "Uploading file…";
    try {
      a.token = await auth.track(lark.uploadFile(a.file));   // kept on the item, so a retry won't upload it twice
    } catch (err) {
      if (err.deadToken) throw err;
      failed.push({ name: a.name, why: describe(err) });
    }
  }
  label.textContent = "Saving…";
  return failed;
}

const attachedTokens = (doc) => doc.attachments.filter((a) => a.token).map((a) => a.token);
const attachedList = (doc) => doc.attachments.filter((a) => a.token)
  .map(({ token, name, size }) => ({ token, name, size }));

/** The state ops.js writes: the brief plus what the person picked for Lark's own columns. */
const stateOf = (model, x) => ({ model, nextSteps: x.nextSteps || [], requirement: x.requirement || "", vat: x.vat || "",
  attachments: x.attachments || [] });

function openDoc(doc) {
  doc.savedJSON = doc.mode === "record" ? fingerprint(doc.original) : null;
  doc.nextSteps = [...(doc.nextSteps || [])];
  doc.requirement = doc.requirement || "";
  doc.vat = doc.vat || "";
  doc.attachments = (doc.attachments || []).map((a) => ({ ...a }));
  doc.savedExtras = doc.mode === "record" ? extrasKey({ requirement: doc.savedRequirement ?? doc.requirement,
    vat: doc.savedVat ?? doc.vat, nextSteps: doc.savedNextSteps || doc.nextSteps,
    attachments: doc.savedAttachments || doc.attachments }) : null;
  if (S.checking) setChecking(false);
  S.doc = doc;
  showView("result");
  $("#checkBar").hidden = !(doc.mode === "draft" && Array.isArray(S.draft?.evidence));
  $("#checkBtn").disabled = !S.draft?.evidence?.length;
  $("#checkBtn").title = S.draft?.evidence?.length ? "" : "Gemini didn't quote any sources for this brief.";
  setTitle(B.isMissing(doc.model.project_title) ? "Brief" : B.normalize(doc.model).project_title);
  const sheet = $("#paper");   // sections animate in only when a brief is opened
  sheet.classList.add("paper-enter");
  clearTimeout(sheet._entering);
  sheet._entering = setTimeout(() => sheet.classList.remove("paper-enter"), 1000);
  paper.render(doc.model);
  renderExtras();
  refreshResult();
  pdf.prefetch();
}

function isDirty(doc = S.doc) {
  if (!doc) return false;
  if (doc.mode === "record" && doc.savedExtras !== extrasKey(doc)) return true;
  return fingerprint(doc.model) !== (doc.savedJSON ?? fingerprint(doc.original));
}

let chatTimer = null;
function refreshResult() {
  const doc = S.doc;
  if (!doc) return;
  const m = B.normalize(doc.model);
  const record = doc.mode === "record";
  const dirty = isDirty();

  $("#backLink").href = record ? "#/briefs" : "#/";
  $("#backText").textContent = record ? "All briefs" : "New brief";

  const meta = [];
  if (record) {
    meta.push(`Filed ${B.fmtDate(m.date_filed)}${doc.filedBy ? ` by ${doc.filedBy}` : ""}`);
    if (doc.status) meta.push(`Status: ${doc.status}`);
    if (dirty) meta.push("Unsaved changes");
  } else if (doc.meta) {
    const n = (doc.sources || []).length;
    meta.push(`Extracted from ${n} source${n === 1 ? "" : "s"} in ${Math.round((doc.meta.duration_ms || 0) / 1000)}s`);
    meta.push("Not saved to Lark yet");
  }
  if (doc.newer) meta.push(NEWER_MSG);
  $("#resultMeta").textContent = meta.join(" · ");

  const warn = $("#warnBanner");
  warn.hidden = !m.extraction_warnings.length;
  if (m.extraction_warnings.length) {
    warn.replaceChildren(ic("alert"), h("div", {}, h("b", {}, "Check these: "), m.extraction_warnings.join(" · ")));
  }

  const saveBtn = $("#saveBtn");
  if (!saveBtn.classList.contains("is-busy")) {
    saveBtn.querySelector(".label").textContent = record ? (dirty ? "Save changes to Lark" : "All changes saved") : "Save to Lark Base";
    saveBtn.disabled = (record && !dirty) || !!doc.newer || !!writeProblem();
    saveBtn.title = doc.newer ? NEWER_MSG : writeProblem();
    saveBtn.querySelector(".i").innerHTML = ICONS[record && !dirty ? "check" : "save"];
  }
  $("#resetBtn").hidden = !(record ? dirty : fingerprint(doc.model) !== fingerprint(doc.original));

  clearTimeout(chatTimer);
  chatTimer = setTimeout(() => { $("#chatPreview").textContent = B.toChatText(m); }, 120);
}

function onDocChange() {
  const doc = S.doc;
  if (!doc) return;
  if (doc.mode === "draft") persistDraftSoon();
  else rememberEdits(doc);
  refreshResult();
}

// ---- Check sources (new drafts only): click a value to see where it came from ---------
const NARROW = matchMedia("(max-width: 1024px)");   // the aside stacks below the paper: use a dialog
let srcFocus = null;

function setChecking(on) {
  const d = S.draft;
  on = !!(on && S.doc?.mode === "draft" && d?.evidence?.length);
  if (on === S.checking) return;
  S.checking = on;
  $("#checkBtn").setAttribute("aria-pressed", String(on));
  $("#checkBtn .label").textContent = on ? "Done checking" : "Check sources";
  $("#checkHint").hidden = !on;
  $('[data-view="result"] .split').classList.toggle("is-checking", on);
  $("#srcPanel").hidden = !on;
  paper.setChecking(on ? {
    has: (path) => E.has(path, S.doc.model, d.original, d.evidence),
    pick: (path, el) => openSource(path, el),
  } : null);
  if (on) {
    sources.warm(d);
    showSourceHint();
  } else {
    sources.clear($("#srcBody"));
    if ($("#srcDialog").open) $("#srcDialog").close();
  }
}

function showSourceHint() {
  $("#srcTitleText").textContent = "Sources";
  sources.clear($("#srcBody"));
  $("#srcBody").append(h("p", { class: "hint" }, "Click an underlined value in the document to see the passage it came from."));
}

function openSource(path, el) {
  const d = S.draft;
  if (!S.checking || !d) return;
  paper.markActive(path);
  const narrow = NARROW.matches;
  const host = narrow ? $("#srcDialogBody") : $("#srcBody");
  (narrow ? $("#srcDialogTitle") : $("#srcTitleText")).textContent = sources.fieldLabel(path);
  sources.show(host, {
    path, draft: d, res: E.resolve(path, S.doc.model, d.original, d.evidence),
    onAddFile: (file) => {
      if (sources.addFile(d, file)) openSource(path, el);
      else toast(`“${file.name}” isn't one of the files this brief was extracted from.`, { type: "error" });
    },
  });
  if (narrow && !$("#srcDialog").open) {
    srcFocus = el;
    $("#srcDialog").showModal();
    $("#srcDialogClose").focus();
  }
}

function wireSources() {
  $("#checkBtn").onclick = () => setChecking(!S.checking);
  $("#srcClose").onclick = () => { setChecking(false); $("#checkBtn").focus(); };
  $("#srcDialogClose").onclick = () => $("#srcDialog").close();
  $("#srcDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $("#srcDialog").addEventListener("close", () => {
    sources.clear($("#srcDialogBody"));
    paper.markActive(null);
    srcFocus?.focus?.();
    srcFocus = null;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.checking && S.view === "result" && !$("#srcDialog").open && !document.querySelector("dialog[open]")) {
      setChecking(false);
      $("#checkBtn").focus();
    }
  });
  // Crossing the breakpoint moves the source between the side panel and the dialog.
  NARROW.addEventListener("change", () => {
    if (!S.checking) return;
    if ($("#srcDialog").open) $("#srcDialog").close();
    showSourceHint();
    paper.markActive(null);
  });
}

function wireResult() {
  paper.mount($("#paper"), onDocChange);
  wireSources();

  $("#copyChatBtn").onclick = async (e) => {
    const btn = e.currentTarget;   // read before awaiting: currentTarget is null afterwards
    const m = B.normalize(S.doc.model);
    const ok = await copyText(B.toChatText(m), B.toChatHtml(m));
    if (!ok) return toast("Couldn't copy. Select the preview text and copy it manually.", { type: "error" });
    flashDone(btn, "Copied - paste it in the chat");
    popBadge(btn, "Copied!");
  };

  $("#pdfBtn").onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, "Preparing PDF…");
    try {
      await pdf.download(S.doc.model);
      busy(btn, false);
      flashDone(btn, "PDF downloaded");
    } catch (err) {
      busy(btn, false);
      toast(err.message || "Couldn't create the PDF.", { type: "error" });
    }
  };

  $("#copyMdBtn").onclick = async () => {
    const ok = await copyText(B.toMarkdown(B.normalize(S.doc.model)));
    toast(ok ? "Markdown copied." : "Couldn't copy the Markdown.", ok ? { type: "success", timeout: 2200 } : { type: "error" });
    $("#moreOptions").open = false;
  };
  $("#mdBtn").onclick = () => {
    const m = B.normalize(S.doc.model);
    downloadText(`${B.fileStem(m)}.md`, B.toMarkdown(m));
    $("#moreOptions").open = false;
  };
  // One click; reversible from the toast (no "click again" arming).
  $("#resetBtn").onclick = () => {
    const doc = S.doc, before = clone(doc.model);
    const apply = (model) => {
      doc.model = model;
      if (doc.mode === "draft") { if (S.draft) { S.draft.model = model; persistDraftSoon(); } }
      else if (model === before) rememberEdits(doc);
      else delete S.edits[doc.id];
      if (S.doc !== doc) return;
      paper.render(doc.model);
      refreshResult();
    };
    apply(clone(doc.original));
    $("#moreOptions").open = false;
    toast("Edits undone.", { type: "success", action: "Undo", onAction: () => apply(before) });
  };

  $("#saveBtn").onclick = openSaveDialog;
  $("#saveForm").addEventListener("submit", (e) => { e.preventDefault(); confirmSave(); });
  $("#saveSkip").onclick = () => confirmSave({ skipFailed: true });
  // The sheet stays static (the upload progress writes into its button). Escape and the
  // backdrop close it, except while it's saving.
  const saving = () => $("#saveConfirm").classList.contains("is-busy");
  $("#saveCancel").onclick = () => $("#saveDialog").close();
  $("#saveDialog").addEventListener("cancel", (e) => { if (saving()) e.preventDefault(); });
  $("#saveDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget && !saving()) e.currentTarget.close(); });
}

// ---- saving ------------------------------------------------------------------
function openSaveDialog() {
  const doc = S.doc;
  if (!doc) return;
  if (doc.newer) return toast(NEWER_MSG, { type: "error" });
  if (writeProblem()) return toast(writeProblem(), { type: "error" });
  paper.close();
  const m = B.normalize(doc.model);
  const isNew = doc.mode === "draft";
  $("#saveTitle").textContent = isNew ? "Save this brief to Lark?" : "Save your changes to Lark?";
  $("#saveSub").textContent = isNew
    ? "It'll be added as a new row in the team's briefs table, where everyone can see it."
    : "This updates the existing row in the team's briefs table.";
  const rows = [["Project", m.project_title], ["Client", m.client_name], ["Due", B.dueText(m, false)],
    ["Budget", `${m.budget.amount}${m.budget.type !== "NOT SPECIFIED" ? ` (${B.label(m.budget.type)})` : ""}`]];
  if (isNew) rows.push(["Filed by", (auth.user() || {}).name || "You"]);
  $("#saveSummary").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", { class: B.isMissing(v) ? "is-empty" : null }, v)]));
  $("#saveError").hidden = true;
  $("#saveSkip").hidden = true;
  $("#saveConfirm .label").textContent = isNew ? "Save to Lark" : "Save changes";
  $("#saveDialog").showModal();
  $("#saveCancel").focus();   // the safe choice has focus
}

const larkLink = () => ({ href: cfg().table ? cfg().table.url : "#", text: "Open in Lark" });
/** The words for a failed write (see errors.js describeWrite). */
const sayWrite = (err, extra = {}) => describeWrite(err, { app: APP.name, host: larkService.host(), blocked: blockedHosts(), ...extra });

/** What the read-back found, as a toast: "All 15 fields checked in Lark." or the list to check. */
function readBackNote(res) {
  if (res.readBackError) return { warn: "Saved, but Fetch couldn't read it back to check it.", link: larkLink() };
  if (res.mismatches && res.mismatches.length) {
    return { warn: `Check these in Lark: ${res.mismatches.map((m) => `${m.field}: sent “${m.want}”, Lark has “${m.got}”`).join("; ")}`,
      link: larkLink() };
  }
  const n = Object.keys(res.written || {}).length;
  return { ok: n ? `All ${n} field${n === 1 ? "" : "s"} checked in Lark.` : "" };
}

function showSaveError(message, { label = "Try again", skip = false } = {}) {
  $("#saveConfirm .label").textContent = label;
  $("#saveSkip").hidden = !skip;
  $("#saveError").textContent = message;
  $("#saveError").hidden = false;
}

/** Save the open brief: files first (any that fail stop the save and offer a choice), then the
 *  row. A new row is created once (the draft's client token); an opened one changes only the
 *  cells the person edited, if they still hold what was loaded. Then it reads the row back. */
async function confirmSave({ skipFailed = false } = {}) {
  const doc = S.doc;
  if (!doc) return;
  const btn = $("#saveConfirm");
  const isNew = doc.mode === "draft";
  if (doc.newer) return showSaveError(NEWER_MSG);
  const blocked = writeProblem();
  if (blocked) return showSaveError(blocked);
  if (!auth.ensureTime(60 * 1000)) return;
  busy(btn, true, "Saving…");
  $("#saveCancel").disabled = true;
  $("#saveSkip").hidden = true;
  $("#saveError").hidden = true;
  const label = $("#saveConfirm .label");
  let outcome = null;
  try {
    let failed = [];
    if (skipFailed) {   // "Save without these files": leave out whatever isn't in Lark yet
      failed = doc.attachments.filter((a) => a.file && !a.token).map((a) => ({ name: a.name, why: "left out" }));
    } else {
      failed = await uploadPending(doc, label);
      if (failed.length) {   // never skip a file silently: the row isn't written until the person chooses
        busy(btn, false);
        $("#saveCancel").disabled = false;
        return showSaveError(`${failed.length === 1 ? "This file" : "These files"} didn't upload, so nothing was saved: `
          + `${failed.map((f) => `${f.name} (${f.why})`).join("; ")}.`, { skip: true });
      }
    }
    const tokens = attachedTokens(doc);
    let res, row;
    if (isNew) {
      const me = auth.user() || await auth.loadUser().catch(() => null);   // never write a blank "Filed by"
      res = await lark.create(stateOf(doc.model, { ...doc, attachments: tokens }),
        { filedBy: (me && me.name) || "", sources: (doc.sources || []).join("\n") }, S.draft?.clientToken);
      row = res.row;
    } else {
      const was = { nextSteps: doc.savedNextSteps, requirement: doc.savedRequirement, vat: doc.savedVat,
        attachments: (doc.savedAttachments || []).map((a) => a.token) };
      res = await lark.update({ id: doc.id, sig: doc.sig, model: doc.original }, stateOf(doc.original, was),
        stateOf(doc.model, { ...doc, attachments: tokens }), { force: !!doc.overwrite });
      row = res.row;
    }
    outcome = { res, row, failed };
  } catch (err) {
    busy(btn, false);
    $("#saveCancel").disabled = false;
    if (err.name === "AlreadyDone" && err.changed) {
      // Someone changed these cells in Lark. Nothing was written. Take Lark's cells as the new
      // base, so saving again overwrites only what this person edited.
      doc.sig = { ...doc.sig, ...sigs(err.fresh.fields) };
      doc.overwrite = true;
      loadBriefs().catch(() => {});   // the list refreshes behind the dialog
      return showSaveError(`${err.message} ${err.detail} Choose Save anyway to overwrite it with your version.`, { label: "Save anyway" });
    }
    if (isUncertain(err) || err.notFound) loadBriefs().catch(() => {});   // see what Lark really holds before a retry
    showSaveError(err.name === "WriteBlocked" ? `${err.message} ${err.problems.join(" ")}` : sayWrite(err),
      { label: err.deadToken ? "Save to Lark" : "Try again" });
  }
  if (!outcome) return;

  // Lark has the row. Whatever goes wrong from here is the page's own tidying up, never "nothing was written".
  const { res, row, failed: left } = outcome;
  try {
    if (isNew) {
      setDraft(null);
      S.draftFiles = [];
      sources.drop();
      S.highlight = row.id;
      upsertBrief(row, true);
    } else {
      doc.overwrite = false;
      doc.original = clone(row.model);   // the row as Lark holds it now, not as we sent it
      doc.savedJSON = fingerprint(row.model);
      doc.savedNextSteps = row.nextSteps; doc.savedAttachments = row.attachments;
      doc.savedRequirement = row.requirement; doc.savedVat = row.vat;
      doc.sig = row.sig;
      doc.attachments = attachedList(doc);
      doc.savedExtras = extrasKey(doc);
      delete S.edits[doc.id];
      renderExtras();
      upsertBrief(row, false);
    }
    busy(btn, false);
    $("#saveCancel").disabled = false;
    $("#saveDialog").close();
    const note = readBackNote(res);
    if (left.length) toast(`Saved without ${left.map((f) => f.name).join(", ")}.`, { type: "warn" });
    if (note.warn) toast(note.warn, { type: "warn", link: note.link });
    else if (isNew) {
      try { confetti($("#saveBtn")); } catch (_) { /* decoration only */ }   // once per milestone: the first save of a new brief
      toast("Saved to Lark Base. Here's every brief the team has filed.", { type: "success", detail: note.ok || undefined, link: larkLink() });
    } else {
      toast(res.nothing ? "Nothing needed saving in Lark." : "Changes saved to Lark.", { type: "success", detail: note.ok || undefined });
    }
    if (isNew) go("#/briefs"); else refreshResult();
  } catch (e) {
    console.error(e);
  }
}

// ==== 4. All briefs =============================================================
function upsertBrief(rec, prepend) {
  if (!S.briefs) S.briefs = [];
  const i = S.briefs.findIndex((b) => b.id === rec.id);
  if (i >= 0) S.briefs[i] = { ...S.briefs[i], ...rec };
  else prepend ? S.briefs.unshift(rec) : S.briefs.push(rec);
  cacheBriefs();
}

/** Update the count in the nav, and (unless `persist` is false) keep the list for the next visit.
 *  The cache is keyed by table, holds no attachment links, and goes when the session ends. */
function cacheBriefs(persist = true) {
  const key = cacheKey();
  if (persist && key && S.briefs && auth.currentToken()) save(key, { v: 2, at: S.briefsAt || Date.now(), rows: S.briefs });
  const count = $("#briefCount");   // open briefs only; done ones sit in their own section
  const open = (S.briefs || []).filter((b) => !b.done).length;
  count.hidden = !open;
  count.textContent = open || "";
}

/** The settings screen shows what's loading; tell it when that changes. */
const repaintSettings = () => { if (S.view === "settings") settingsView.paint(); };

function loadBriefs() {
  if (S.briefsLoading) return S.briefsLoading;
  S.larkError = null;
  const status = $("#briefsStatus");
  const first = !S.briefs;
  const say = (text) => status.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), h("span", {}, text));
  status.className = "list-status";
  say(first ? "Reading the briefs…" : "Refreshing…");
  $("#refreshBtn").classList.add("is-busy");
  if (first) renderSkeletons();
  const slow = setTimeout(() => {
    if (larkService.status.state === "waking") say("Waking up the connection… It sleeps when nobody's using it. This can take up to a minute.");
  }, 1200);
  S.briefsLoading = (async () => {
    // Wake the proxy first (a sleeping one answers 502), then read every brief.
    if (!await larkService.wake()) throw new LarkError("connection service unreachable", { network: true });
    return lark.listAll((n, total) => say(`Reading the briefs… ${n.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ""}`));
  })()
    .then((list) => {
      S.briefs = list.reverse();   // Lark returns oldest first
      S.briefsAt = Date.now();
      cacheBriefs();
      updateWriteNote();
      status.replaceChildren();
      if (S.view === "result" && S.doc?.mode === "record") refreshResult();
      if (S.view === "briefs") renderBriefs();
      return list;
    })
    .catch((err) => {
      S.larkError = describe(err);
      status.className = "list-status is-error";
      status.replaceChildren(ic("alert"), h("span", {}, `${S.larkError} `,
        h("button", { type: "button", class: "linkish", onclick: () => loadBriefs() }, "Try again")));
      if (S.view === "briefs" && first) renderBriefs();
      throw err;
    })
    .finally(() => {
      clearTimeout(slow);
      $("#refreshBtn").classList.remove("is-busy");
      S.briefsLoading = null;
      repaintSettings();
    });
  repaintSettings();
  S.briefsLoading.catch(() => {});
  return S.briefsLoading;
}

function renderSkeletons() {   // the first load: the shape of the cards, shimmering
  $("#briefGrid").replaceChildren(...Array.from({ length: 6 }, () =>
    h("div", { class: "rcard is-skeleton", "aria-hidden": "true" },
      h("span", { class: "sk sk-chip" }), h("span", { class: "sk sk-title" }), h("span", { class: "sk sk-line" }),
      h("span", { class: "sk sk-line short" }), h("span", { class: "sk sk-foot" }))));
}

// Lark's Status column → the shared badge colors. "New" is muted: yellow is the brand, never a status.
const STATUS_BADGE = { new: "badge-muted", "in progress": "badge-info", submitted: "badge-violet", won: "badge-ok",
  lost: "badge-muted", declined: "badge-muted" };

/** Due soon → warn, due today → urgent, overdue (still open) → err, otherwise muted. */
function dueBadgeClass(b) {
  const n = B.daysUntil(b.model.due_date.date);
  if (n == null || b.done) return "badge-muted";
  return n < 0 ? "badge-err" : n === 0 ? "badge-urgent" : n <= 7 ? "badge-warn" : "badge-muted";
}

let entered = false;   // cards stagger in on the first render only, not on every search or sort

function briefCard(b, i) {
  const m = b.model;
  const due = m.due_date.date ? B.dueBadge(m.due_date.date) : null;
  // The ⋯ button sits beside the link, not inside it: a button inside <a> is invalid.
  const card = h("a", { class: `rcard${b.done ? " is-done" : ""}${entered ? "" : " is-entering"}`,
    href: `#/briefs/${encodeURIComponent(b.id)}`, style: `--i:${Math.min(i, 12)}`, "data-id": b.id },
    h("div", { class: "rcard-top" },
      h("span", { class: `badge ${STATUS_BADGE[(b.status || "").toLowerCase()] || "badge-muted"}` }, b.status || "New"),
      h("span", { class: `badge ${dueBadgeClass(b)}` }, ic("clock"), due ? `Due ${B.fmtDate(m.due_date.date)} · ${due.text}` : "No due date")),
    h("h3", {}, m.project_title),
    h("p", { class: "rcard-sub" }, B.isMissing(m.client_name) ? "Client not specified" : m.client_name),
    m.summary && h("p", { class: "rcard-body" }, m.summary),
    h("dl", { class: "facts" },
      h("div", {}, h("dt", {}, ic("calendar"), "Event"), h("dd", {}, B.isMissing(m.event_period) ? "-" : m.event_period)),
      h("div", {}, h("dt", {}, ic("coin"), "Budget"), h("dd", {}, B.isMissing(m.budget.amount) ? "-" : m.budget.amount))),
    (b.nextSteps || []).length ? h("div", { class: "rcard-steps" },
      b.nextSteps.slice(0, 3).map((t) => h("span", { class: "step-pill" }, t)),
      b.nextSteps.length > 3 ? h("span", { class: "step-pill is-more" }, `+${b.nextSteps.length - 3}`) : null) : null,
    h("div", { class: "rcard-foot" }, `Filed ${B.fmtDate(m.date_filed)}${b.filedBy ? ` · ${b.filedBy}` : ""}`
      + ((b.attachments || []).length ? ` · ${b.attachments.length} file${b.attachments.length === 1 ? "" : "s"}` : ""),
      S.edits[b.id] ? h("span", { class: "unsaved" }, "• unsaved edits") : null));
  return h("div", { class: `rcard-wrap${S.working.has(b.id) ? " is-working" : ""}`, "data-id": b.id }, card,
    h("button", { type: "button", class: "more-btn", "aria-label": `More actions for ${m.project_title}`, "aria-haspopup": "menu",
      "aria-expanded": "false", title: "More actions" }, ic("dots")));
}

function renderBriefs() {
  const grid = $("#briefGrid");
  if (!S.briefs) return;
  const q = $("#briefSearch").value.trim().toLowerCase();
  const sort = $("#briefSort").value;
  let list = S.briefs.filter((b) => !q || [b.model.project_title, b.model.client_name, b.model.venue, b.model.summary, b.filedBy, b.status]
    .join(" ").toLowerCase().includes(q));
  const by = {
    filed: (a, b) => (b.model.date_filed || "").localeCompare(a.model.date_filed || ""),
    due: (a, b) => (a.model.due_date.date || "9999").localeCompare(b.model.due_date.date || "9999"),
    client: (a, b) => a.model.client_name.localeCompare(b.model.client_name),
  }[sort];
  list = list.map((b, i) => [b, i]).sort((x, y) => by(x[0], y[0]) || x[1] - y[1]).map(([b]) => b);
  const done = list.filter((b) => b.done)
    .sort((a, b) => (b.model.date_filed || "").localeCompare(a.model.date_filed || ""));   // newest filed first
  list = list.filter((b) => !b.done);
  const group = $("#doneGroup");
  group.hidden = !done.length;
  $("#doneCount").textContent = done.length || "";
  $("#doneGrid").replaceChildren(...done.map(briefCard));

  if (!S.briefs.length) {
    grid.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-art", "aria-hidden": "true" }, ic("inbox")),
      h("h2", {}, "No briefs yet"),
      h("p", {}, "Extract your first brief and save it - it'll show up here for the whole team."),
      h("a", { class: "btn btn-primary", href: "#/" }, ic("sparkles"), " Extract a brief")));
    return;
  }
  if (!list.length) {
    grid.replaceChildren(h("div", { class: "empty small" }, h("p", {},
      q ? `No open briefs match “${q}”.` : "Every brief is marked as done. Nice work!")));
    return;
  }
  grid.replaceChildren(...list.map(briefCard));
  if (!entered) setTimeout(() => { entered = true; }, 50);
  const hl = S.highlight && [...grid.querySelectorAll(".rcard[data-id]")].find((el) => el.dataset.id === S.highlight);
  if (hl) {   // the brief that was just saved: glow and scroll into view, once
    S.highlight = null;
    flash(hl);
  }
}

// ---- card actions: right-click or the ⋯ button (ui.js openMenu) ------------------------
const menuFor = (b) => [
  { label: "Open", icon: "open", onSelect: () => go(`#/briefs/${encodeURIComponent(b.id)}`) },
  { label: b.done ? "Mark as Not Done" : "Mark as Done", icon: b.done ? "undoneCircle" : "doneCircle", onSelect: () => toggleDone(b) },
  "-",
  { label: "Delete…", icon: "trash", danger: true, onSelect: () => removeBrief(b) },
];

/** A single-cell flag, so it changes at once: the card is dimmed (`working`) while Lark answers,
 *  rolled back with the reason if Lark refuses, and Undo stays for 8 s. */
async function toggleDone(b, done = !b.done) {
  if (S.working.has(b.id)) return;
  if (writeProblem()) return toast(writeProblem(), { type: "error" });
  if (!auth.ensureTime(60 * 1000)) return;
  S.working.add(b.id);
  b.done = done;
  cacheBriefs();
  renderBriefs();
  try {
    const res = await lark.setDone(b.id, done);
    const note = readBackNote(res);
    if (note.warn) {
      toast(note.warn, { type: "warn", link: note.link });
      loadBriefs().catch(() => {});   // show what Lark really holds
    } else {
      toast(done ? `“${b.model.project_title}” moved to Done.` : `“${b.model.project_title}” is back in the list.`, {
        type: "success", action: "Undo", onAction: () => toggleDone(b, !done),
      });
    }
  } catch (err) {
    b.done = !done;
    toast(sayWrite(err), { type: "error" });
    if (isUncertain(err)) loadBriefs().catch(() => {});
  } finally {
    S.working.delete(b.id);
    cacheBriefs();
    renderBriefs();
  }
}

function wireCardMenu() {
  const briefFor = (wrap) => S.briefs?.find((x) => x.id === wrap?.dataset.id);
  [$("#briefGrid"), $("#doneGrid")].forEach((list) => {
    list.addEventListener("contextmenu", (e) => {
      const b = briefFor(e.target.closest(".rcard-wrap[data-id]"));
      if (!b) return;
      e.preventDefault();
      openMenu(menuFor(b), { x: e.clientX, y: e.clientY });
    });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest(".more-btn");
      const b = btn && briefFor(btn.closest(".rcard-wrap"));
      if (b) openMenu(menuFor(b), { anchor: btn });   // a second click on the same ⋯ closes it
    });
  });
}

/** Permanent delete: two confirmations (ui.js confirmDanger). */
async function removeBrief(b) {
  const m = b.model;
  if (writeProblem()) return toast(writeProblem(), { type: "error" });
  if (!auth.ensureTime(60 * 1000)) return;
  const ok = await confirmDanger({
    what: m.project_title,
    details: [["Project", m.project_title], ["Client", B.isMissing(m.client_name) ? "" : m.client_name],
      ["Filed", `${B.fmtDate(m.date_filed)}${b.filedBy ? ` by ${b.filedBy}` : ""}`]],
    consequence: "This removes the brief from the Lark Base for everyone, including its attachments, next steps and notes.",
    safer: "Mark it Done instead if you might need it again.",
    run: async () => {
      if (auth.msLeft() < 60 * 1000) throw new Error("Your login is about to end, so this wasn't sent. Log in again, then try it.");
      try { await lark.remove(b.id); } catch (err) { throw new Error(sayWrite(err, { deleting: true })); }
    },
  });
  if (!ok) return;
  S.briefs = S.briefs.filter((x) => x.id !== b.id);
  delete S.edits[b.id];
  cacheBriefs();
  renderBriefs();
  if (S.doc?.id === b.id) go("#/briefs");
  toast(`Deleted “${m.project_title}”.`, { type: "success" });
}

function showBriefs() {
  showView("briefs");
  if (S.briefs) renderBriefs();
  if (!S.briefs || Date.now() - S.briefsAt > 30000) loadBriefs();
}

async function showRecord(id) {
  const hash = location.hash;
  let b = S.briefs?.find((x) => x.id === id);
  if (!S.briefsAt) {
    const loading = loadBriefs();   // refresh in the background; open from cache if we can
    if (!b) {
      S.doc = null;
      showView("result");
      $("#resultMeta").textContent = "";
      $("#warnBanner").hidden = true;
      $("#paper").replaceChildren(h("div", { class: "paper-loading" }, h("span", { class: "spinner" }), "Loading brief from Lark…"));
      try {
        await loading;
      } catch (err) {
        $("#paper").replaceChildren(h("div", { class: "paper-loading is-error" }, ic("alert"), describe(err)));
        return;
      }
      if (location.hash !== hash) return;
      b = S.briefs.find((x) => x.id === id);
      if (!b) {
        toast("That brief couldn't be found. It may have been deleted in Lark.", { type: "error" });
        return go("#/briefs");
      }
    }
  }
  const e = S.edits[id];
  openDoc({
    mode: "record", id, model: clone(e?.model || b.model), original: clone(b.model),
    status: b.status, filedBy: b.filedBy, sources: b.sources,
    nextSteps: e?.nextSteps || b.nextSteps || [], attachments: e?.attachments || b.attachments || [],
    requirement: e ? e.requirement : b.requirement || "", vat: e ? e.vat : b.vat || "",
    savedNextSteps: b.nextSteps || [], savedAttachments: b.attachments || [],
    savedRequirement: b.requirement || "", savedVat: b.vat || "",
    requirementRaw: b.requirementRaw || "", vatRaw: b.vatRaw || "",
    sig: e?.sig || b.sig, newer: !!b.newer,   // what Lark held when this was opened (or when the edits began)
  });
}

function wireBriefs() {
  $("#briefSearch").addEventListener("input", renderBriefs);
  $("#briefSort").addEventListener("change", renderBriefs);
  $("#refreshBtn").onclick = () => loadBriefs();
  applyLinks();
}

function applyLinks() {
  const url = cfg().table ? cfg().table.url : "";
  for (const id of ["#larkTableLink", "#openLarkLink"]) {
    if (url) $(id).href = url; else $(id).removeAttribute("href");
  }
}

// ---- in-progress edits survive a trip to Lark's login page ---------------------------
/** Edits live in memory; before the browser leaves for Lark they go to sessionStorage (this tab
 *  only). Files still waiting to upload can't be kept: a new login needs them added again. */
function persistEdits() {
  const out = {};
  for (const [id, e] of Object.entries(S.edits)) out[id] = { ...e, attachments: (e.attachments || []).filter((a) => a.token) };
  store("session", KEYS.edits, Object.keys(out).length ? out : undefined);
}
function restoreEdits() {
  const saved = recall("session", KEYS.edits);
  store("session", KEYS.edits, undefined);
  if (saved && typeof saved === "object") S.edits = { ...saved, ...S.edits };
}

// ---- Settings ----------------------------------------------------------------------
const settingsView = createSettingsView({
  larkStatus: () => (S.briefsLoading ? { state: "loading" }
    : S.larkError ? { state: "error", error: S.larkError }
      : S.briefsAt ? { state: "ok", count: S.briefs.length } : { state: "unknown" }),
  schemaProblems,
  reconnect({ tableChanged = false } = {}) {
    applyLinks();
    if (tableChanged) {
      S.briefs = null;
      S.edits = {};
      cacheBriefs(false);
    }
    [larkService, geminiService].forEach((s) => s.wake({ force: true }));   // fresh checks of both services
    S.briefsAt = 0;
    if (auth.currentToken()) loadBriefs().catch(() => {});
  },
  login: (returnTo) => login(returnTo),
  logout() {
    // Logging out also forgets the cached list (sessionEnded drops it), so the next person on this
    // computer can't see it. The unsaved draft is theirs to resume or discard.
    S.edits = {};
    store("session", KEYS.edits, undefined);
    auth.logout("You've logged out of Fetch. You're still logged in to Lark itself.");
    go("#/");
  },
  clearLocal() {   // one click; Undo in the toast puts the draft, the cached list and the estimate back
    const kept = { draft: S.draft, files: S.draftFiles, briefs: S.briefs, at: S.briefsAt, edits: S.edits,
      factor: recall("local", KEYS.eta) };
    setDraft(null);
    S.draftFiles = [];
    S.briefs = null;
    S.briefsAt = 0;
    S.edits = {};
    dropCache();
    cacheBriefs(false);
    extract.resetEstimate();
    toast("Cleared this browser's draft and cached list.", { type: "success", action: "Undo", onAction: () => {
      if (!S.draft && kept.draft) { setDraft(kept.draft); S.draftFiles = kept.files; }
      S.edits = { ...kept.edits, ...S.edits };
      if (kept.factor != null && recall("local", KEYS.eta) == null) store("local", KEYS.eta, kept.factor);
      if (!S.briefs && kept.briefs) { S.briefs = kept.briefs; S.briefsAt = kept.at; cacheBriefs(); }
      if (S.view === "compose") showCompose();
      if (S.view === "briefs") renderBriefs();
      repaintSettings();
    } });
    if (auth.currentToken()) loadBriefs().catch(() => {});
  },
});

// ---- boot -------------------------------------------------------------------
/** Back from Lark's login page (?code=…&state=… or ?error=…)? Finish the login. */
async function finishLoginIfReturning() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  showView("busy");
  const off = larkService.on((s) => {   // the proxy may have gone to sleep while the person was on Lark's page
    if (s.state === "waking") $("#busyText").textContent = "Waking up the connection… This can take up to a minute.";
  });
  const res = await auth.handleRedirect();   // also takes ?code out of the address bar, before anything is awaited
  off();
  loginState.note = res.ok ? "" : res.message;
}

async function init() {
  fillIcons();
  radioKeys($("#reqChips"));
  radioKeys($("#vatChips"));
  wireCompose();
  wireProcessing();
  wireResult();
  wireExtras();
  wireBriefs();
  wireCardMenu();
  $("#reloadBtn").onclick = () => location.reload();
  restoreEdits();
  cacheBriefs();

  settingsView.mount();
  $("#loginBtn").onclick = () => login();
  auth.onEnded(sessionEnded);
  auth.onBeforeLogin(persistEdits);
  auth.startClock(() => { renderHeader(); settingsView.tick(); });
  geminiService.on(updateSetupNote);
  onAnyService(updateBlockNote);
  settings.on(() => { renderHeader(); updateSetupNote(); });

  // Wake both Render services right away (also on the login screen), so they are ready before
  // they're needed. Each keeps trying for ~3 min while a free instance boots.
  geminiService.wake();
  larkService.wake();
  document.addEventListener("visibilitychange", () => {   // back after a while: they may have gone to sleep
    if (document.visibilityState === "visible") [larkService, geminiService].forEach((s) => s.isFresh() || s.wake());
  });
  updateSetupNote();
  document.documentElement.dataset.booted = "";   // wired up: the boot watchdog in index.html stands down

  await finishLoginIfReturning();
  if (auth.currentToken()) {
    loadBriefs().catch(() => {});
    auth.loadUser().then(() => { renderHeader(); if (S.view === "settings") settingsView.show(); }).catch(() => {});
  } else if (auth.hadSession() && !loginState.note) {
    loginState.note = "Your login ended after about 2 hours. Log in again to keep going.";
    auth.clearSession();
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => {   // a long task or a write is in flight, or there are unsaved edits
    if (S.job || S.working.size || Object.keys(S.edits).length || $("#saveConfirm").classList.contains("is-busy")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  window.addEventListener("resize", () => S.view === "compose" && autosize());
  route();
}

init();
