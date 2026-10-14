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
import * as pdf from "./pdf.js";
import * as settingsView from "./settings-view.js";
import { cfg, geminiKey, SETTINGS_EVENT } from "./settings.js";
import { ICONS } from "./icons.js";
import { $, $$, h, ic, fillIcons, toast, busy, flashDone, popBadge, copyText, flash, openMenu, closeMenu, confirmDanger,
         radioKeys, confetti, store, recall, reduceMotion } from "./ui.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const fingerprint = (m) => JSON.stringify(B.normalize(m));
const emitStatus = () => document.dispatchEvent(new Event(extract.STATUS_EVENT));

// ---- storage (localStorage; null clears a key) ----------------------------
const save = (key, value) => store("local", key, value == null ? undefined : value);

// ---- state --------------------------------------------------------------
const S = {
  view: null,
  items: [],        // compose: { id, file, kind, thumb }
  job: null,        // running extraction
  draft: recall("local", "fetch.draft"),   // { model, original, meta, sources, createdAt, clientToken }
  doc: null,        // what the result view shows
  edits: {},        // unsaved edits to saved briefs, by record id: { model, nextSteps, attachments }
  draftFiles: [],   // File objects behind the draft (memory only; attached to the Lark row on save)
  briefs: null, briefsAt: 0, briefsLoading: null, larkError: null, highlight: null,
};
if (S.draft && !S.draft.model) S.draft = null;
const cached = recall("local", "fetch.briefsCache");
if (Array.isArray(cached)) S.briefs = cached;

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
function showView(name) {
  const changed = S.view !== name;
  S.view = name;
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
const loginState = { note: "", returnTo: "", redirectChecked: false, warnedLow: false };

function showLogin() {
  loginState.returnTo = location.hash && location.hash !== "#/login" ? location.hash : "#/";
  showView("login");
  $("#loginMsg").hidden = !loginState.note;
  $("#loginMsg").textContent = loginState.note;
  busy($("#loginBtn"), false);
  if (!loginState.redirectChecked) {   // is this address registered on the Lark app?
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

/** The login ended (expired, logged out, or Lark refused the token). Unsaved work
 *  stays: the draft is in localStorage and edits are kept in memory. */
function sessionEnded(message) {
  const wasIn = !!auth.hadSession();
  auth.clearSession();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());   // shared sheets resolve and remove themselves
  closeMenu();
  loginState.note = message || "Your Lark login has ended. Log in again to keep going.";
  loginState.warnedLow = false;
  renderHeader();
  if (S.view === "settings") return settingsView.show();
  if (S.job) return;   // let a running extraction finish; it reports the login error itself
  if (wasIn || S.view !== "login") showLogin();
}

function initials(name) {
  return (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

function renderHeader() {
  const signedIn = !!auth.currentToken();
  document.body.dataset.auth = signedIn ? "in" : "out";
  if (!signedIn) return;
  const left = auth.msLeft();
  const pill = $("#sessionPill");
  $("#sessionLeft").textContent = settingsView.fmtLeft(left);
  pill.classList.toggle("is-low", left < LOW_SESSION_MS);
  pill.title = `Your login lasts until ${settingsView.fmtTime(auth.endsAt())}`;
  pill.setAttribute("aria-label", `Logged in for ${settingsView.fmtLeft(left)} more`);
  const u = auth.user() || {};
  const img = $("#avatar");
  img.hidden = !u.avatar;
  if (u.avatar && img.getAttribute("src") !== u.avatar) img.src = u.avatar;
  $("#initials").hidden = !!u.avatar;
  $("#initials").textContent = initials(u.name);
  $("#meLink").title = u.name ? `${u.name} · Settings` : "Settings";
}

/** Every 20 s: update the clock, warn 5 minutes before the end, and end the session on time. */
function tickSession() {
  if (!auth.hadSession()) return;
  if (!auth.currentToken()) return sessionEnded("Your login ended after about 2 hours. Log in again to keep going.");
  renderHeader();
  settingsView.tick();
  if (!loginState.warnedLow && auth.msLeft() < 5 * 60 * 1000) {
    loginState.warnedLow = true;
    toast(`Your Lark login ends at ${settingsView.fmtTime(auth.endsAt())}. Log in again to keep working without a break.`, {
      type: "error", action: "Log in again", onAction: () => login(location.hash), timeout: 0,
    });
  }
}

/** Long actions need a little time left on the login. */
function ensureLoginTime(ms, what) {
  if (auth.msLeft() > ms) return true;
  toast(`Your Lark login is about to end, so Fetch didn't ${what}. Log in again first.`, {
    type: "error", action: "Log in again", onAction: () => login(location.hash),
  });
  return false;
}

/** Why extraction can't run right now ("" if it can). */
function setupProblem() {
  if (!cfg().GEMINI_PROXY_URL) return "The extraction service isn't connected. Add its address in Settings.";
  if (extract.warm.configured === false && !geminiKey()) {
    return "Add your Gemini API key in Settings to start extracting briefs.";
  }
  return "";
}

function updateSetupNote() {
  const problem = setupProblem();
  $("#setupNote").hidden = !problem;
  if (problem) {
    $("#setupText").textContent = cfg().GEMINI_PROXY_URL
      ? "add your Gemini API key to start extracting briefs."
      : "connect the extraction service.";
  }
  updateCompose();
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
  const maxBytes = cfg().MAX_UPLOAD_MB * 1048576;
  let skipped = 0;
  for (let file of fileList) {
    if (!file || !file.size) continue;
    if (S.items.length >= cfg().MAX_FILES) { toast(`You can add up to ${cfg().MAX_FILES} files per brief.`, { type: "error" }); break; }
    if (S.items.some((it) => it.file.name === file.name && it.file.size === file.size && it.file.lastModified === file.lastModified)) { skipped++; continue; }
    const total = S.items.reduce((s, it) => s + it.file.size, 0) + file.size;
    if (total > maxBytes) { toast(`That would be over ${cfg().MAX_UPLOAD_MB} MB in total. Try compressing the file first.`, { type: "error" }); break; }
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
  $("#loader").classList.remove("is-error", "is-done", "is-waking");
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
    step = r < 0.3 ? 1 : r < 0.75 ? 2 : 3;
    label = r > 1.25 ? "Still working - complex briefs take a little longer…" : STAGES[step];
  }
  setRing(p);
  setStep(step);
  $("#stageLabel").textContent = label;

  const left = Math.ceil(est.total - t);
  if (left > 2) {
    $("#etaNumber").textContent = `~${left}`;
    $("#etaUnit").textContent = "sec";
    $("#etaLabel").textContent = left > 60 ? `About ${Math.round(left / 60 * 2) / 2} min left` : `About ${left} seconds left`;
  } else {
    $("#etaNumber").textContent = "…";
    $("#etaUnit").textContent = "almost";
    $("#etaLabel").textContent = left > -20 ? "Almost done…" : "Gemini is taking longer than usual. Hang tight - it'll retry automatically if it's busy.";
  }
}

async function startExtraction() {
  if (!composeReady() || S.job) return;
  if (!ensureLoginTime(2 * 60 * 1000, "start the extraction")) return;
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
  if (!extract.isFresh()) {
    const awake = extract.ensureAwake();
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
        if (extract.warm.blocked) {
          return showLoaderError({ code: "network", message: "An ad blocker or privacy extension in this browser is blocking Fetch's extraction service. "
            + `Allow ${new URL(cfg().GEMINI_PROXY_URL).host} in the blocker (or pause it for this page), reload, and try again.` });
        }
        return showLoaderError({ code: "network", message: `Couldn't reach the extraction service at ${cfg().GEMINI_PROXY_URL}${
          cfg().GEMINI_OVERRIDDEN ? " (a test address set by the page link; open the page with ?reset to use the normal one)" : ""
        }. Check your connection, then try again.` });
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
    const res = await req.promise;
    if (job.uploadedAt) extract.calibrate(job.est.work, (performance.now() - job.uploadedAt) / 1000);
    clearInterval(job.timer);
    setRing(1);
    setStep(4, true);
    $("#stageLabel").textContent = "Done!";
    $("#loader").classList.add("is-done");
    autoRetry.used = false;
    const model = B.normalize(res.brief);
    setDraft({
      model, original: clone(model), meta: res.meta, createdAt: Date.now(), clientToken: lark.uuid(),
      sources: [...files.map((f) => f.name), ...(text ? ["Typed / pasted text"] : [])], nextSteps: [],
    });
    S.draftFiles = [...files, ...(text ? [new File([text], "Brief text.txt", { type: "text/plain" })] : [])];
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
  $("#loader").classList.add("is-error");
  $("#cancelBtn").hidden = true;
  $("#loaderError").hidden = false;
  const retryable = !["unsupported_file", "no_input", "too_large", "too_many_files", "content_rejected",
    "forbidden_origin", "not_configured", "invalid_api_key", "not_authorized",
    "login_required", "login_expired", "login_invalid"].includes(err.code);
  $("#loaderErrorText").textContent = err.message || "Something went wrong.";
  $("#retryBtn").hidden = !retryable;
  $("#errSettingsBtn").hidden = !["not_configured", "invalid_api_key", "quota_exceeded"].includes(err.code);
  $("#stageLabel").textContent = {
    not_configured: "A Gemini API key is needed",
    invalid_api_key: "Your Gemini key needs attention",
    quota_exceeded: "Gemini usage limit reached",
    not_authorized: "Your account doesn't have access",
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
  save("fetch.draft", draft);
}

let persistTimer = null;
function persistDraftSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => S.doc?.mode === "draft" && S.draft && save("fetch.draft", S.draft), 400);
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
      requirement: doc.requirement, vat: doc.vat };
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
  (cfg().NEXT_STEP_OPTIONS || []).forEach(add);
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
  renderChoice("#reqChips", "#reqWhy", cfg().REQUIREMENT_TYPES, doc.requirement,
    { key: m.requirement?.type || "", reason: m.requirement?.reason || "" });
  const vat = B.normalize(m).vat;   // pick always agrees with its note
  renderChoice("#vatChips", "#vatWhy", cfg().VAT_CHOICES, doc.vat, { key: vat.applies, reason: vat.reason });
  const chosen = new Set(doc.nextSteps.map((t) => t.toLowerCase()));
  keepFocus($("#nsChips"), "data-step", () => $("#nsChips").replaceChildren(...stepOptions(doc).map((opt) => h("button", {
    type: "button", class: "chip-opt", "aria-pressed": String(chosen.has(opt.toLowerCase())), "data-step": opt,
  }, chosen.has(opt.toLowerCase()) ? ic("check") : null, opt))));

  const max = cfg().LARK_ATTACH_MAX_MB * 1048576;
  const list = $("#attList");
  list.replaceChildren(...doc.attachments.map((a, i) => {
    const tooBig = !a.token && a.size > max;
    return h("li", { class: `att${tooBig ? " is-warn" : ""}` },
      ic(tooBig ? "alert" : "file"),
      h("span", { class: "att-info" }, h("span", { class: "att-name", title: a.name }, a.name),
        h("span", { class: "att-meta" }, [fmtBytes(a.size || 0),
          a.token ? "in Lark" : tooBig ? `too large (max ${cfg().LARK_ATTACH_MAX_MB} MB)` : "uploads on save"].join(" · "))),
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

/** Upload attachments that aren't in Lark yet. Returns the names that were skipped. */
async function uploadPending(doc, label) {
  const max = cfg().LARK_ATTACH_MAX_MB * 1048576;
  const pending = doc.attachments.filter((a) => a.file && !a.token);
  const skipped = [];
  for (let i = 0; i < pending.length; i++) {
    const a = pending[i];
    if (a.file.size > max) { skipped.push(`${a.name} (over ${cfg().LARK_ATTACH_MAX_MB} MB)`); continue; }
    label.textContent = `Uploading file ${i + 1} of ${pending.length}…`;
    try {
      a.token = await lark.uploadFile(a.file);   // kept on the item, so a retry won't upload it twice
    } catch (err) {
      skipped.push(`${a.name} (${err.message})`);
    }
  }
  label.textContent = "Saving…";
  return skipped;
}

const attachedTokens = (doc) => doc.attachments.filter((a) => a.token).map((a) => a.token);
const attachedList = (doc) => doc.attachments.filter((a) => a.token)
  .map(({ token, name, size, url }) => ({ token, name, size, url: url || "" }));

function openDoc(doc) {
  doc.savedJSON = doc.mode === "record" ? fingerprint(doc.original) : null;
  doc.nextSteps = [...(doc.nextSteps || [])];
  doc.requirement = doc.requirement || "";
  doc.vat = doc.vat || "";
  doc.attachments = (doc.attachments || []).map((a) => ({ ...a }));
  doc.savedExtras = doc.mode === "record" ? extrasKey({ requirement: doc.savedRequirement ?? doc.requirement,
    vat: doc.savedVat ?? doc.vat, nextSteps: doc.savedNextSteps || doc.nextSteps,
    attachments: doc.savedAttachments || doc.attachments }) : null;
  S.doc = doc;
  showView("result");
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
  $("#resultMeta").textContent = meta.join(" · ");

  const warn = $("#warnBanner");
  warn.hidden = !m.extraction_warnings.length;
  if (m.extraction_warnings.length) {
    warn.replaceChildren(ic("alert"), h("div", {}, h("b", {}, "Check these: "), m.extraction_warnings.join(" · ")));
  }

  const saveBtn = $("#saveBtn");
  if (!saveBtn.classList.contains("is-busy")) {
    saveBtn.querySelector(".label").textContent = record ? (dirty ? "Save changes to Lark" : "All changes saved") : "Save to Lark Base";
    saveBtn.disabled = record && !dirty;
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

function wireResult() {
  paper.mount($("#paper"), onDocChange);

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
  $("#saveConfirm .label").textContent = isNew ? "Save to Lark" : "Save changes";
  $("#saveDialog").showModal();
  $("#saveCancel").focus();   // the safe choice has focus
}

async function confirmSave() {
  const doc = S.doc;
  const btn = $("#saveConfirm");
  const isNew = doc.mode === "draft";
  if (!ensureLoginTime(60 * 1000, "save")) return;
  busy(btn, true, "Saving…");
  $("#saveCancel").disabled = true;
  $("#saveError").hidden = true;
  try {
    let rec;
    if (isNew) {
      const filedBy = (auth.user() || {}).name || "";
      const skipped = await uploadPending(doc, $("#saveConfirm .label"));
      const extra = { filedBy, sources: (doc.sources || []).join("\n") };
      if (doc.nextSteps.length) extra.nextSteps = doc.nextSteps;
      if (doc.requirement) extra.requirement = doc.requirement;
      if (doc.vat) extra.vat = doc.vat;
      if (attachedTokens(doc).length) extra.attachments = attachedTokens(doc);
      rec = await lark.create(doc.model, extra, S.draft?.clientToken);
      Object.assign(rec, { nextSteps: [...doc.nextSteps], attachments: attachedList(doc), requirement: doc.requirement, vat: doc.vat });
      if (skipped.length) toast(`Saved, but these files weren't attached: ${skipped.join("; ")}`, { type: "warn" });
      setDraft(null);
      S.draftFiles = [];
      S.highlight = rec.id;
      upsertBrief(rec, true);
    } else {
      const skipped = await uploadPending(doc, $("#saveConfirm .label"));
      await lark.update(doc.id, doc.model, { nextSteps: doc.nextSteps, attachments: attachedTokens(doc),
        requirement: doc.requirement, vat: doc.vat });
      const model = B.normalize(doc.model);
      doc.original = clone(model);
      doc.savedJSON = fingerprint(model);
      doc.attachments = attachedList(doc);
      doc.savedExtras = extrasKey(doc);
      delete S.edits[doc.id];
      renderExtras();
      if (skipped.length) toast(`Saved, but these files weren't attached: ${skipped.join("; ")}`, { type: "warn" });
      // The update response only echoes the columns we sent, so keep Status etc. from the list.
      upsertBrief({ id: doc.id, model: clone(model), nextSteps: [...doc.nextSteps], attachments: attachedList(doc),
        requirement: doc.requirement, vat: doc.vat }, false);
    }
    busy(btn, false);
    $("#saveCancel").disabled = false;
    $("#saveDialog").close();
    if (isNew) {
      confetti($("#saveBtn"));   // once per milestone: the first save of a new brief
      toast("Saved to Lark Base. Here's every brief the team has filed.", { type: "success",
        link: { href: cfg().LARK_TABLE_URL, text: "Open in Lark" } });
      go("#/briefs");
    } else {
      toast("Changes saved to Lark.", { type: "success" });
      refreshResult();
    }
  } catch (err) {
    busy(btn, false);
    $("#saveCancel").disabled = false;
    $("#saveConfirm .label").textContent = "Try again";
    $("#saveError").textContent = err.message || "Couldn't save to Lark.";
    $("#saveError").hidden = false;
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

function cacheBriefs() {
  save("fetch.briefsCache", S.briefs);
  const count = $("#briefCount");   // open briefs only; done ones sit in their own section
  const open = (S.briefs || []).filter((b) => !b.done).length;
  count.hidden = !open;
  count.textContent = open || "";
}

function loadBriefs() {
  if (S.briefsLoading) return S.briefsLoading;
  S.larkError = null;
  const status = $("#briefsStatus");
  const first = !S.briefs;
  const say = (text) => status.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), h("span", {}, text));
  status.className = "list-status";
  say(first ? "Loading briefs from Lark…" : "Refreshing…");
  $("#refreshBtn").classList.add("is-busy");
  if (first) renderSkeletons();
  const slow = setTimeout(() => {
    say("Waking up the Lark connection - the first load after a quiet spell can take up to a minute…");
  }, 5000);
  S.briefsLoading = lark.listAll()
    .then((list) => {
      S.briefs = list.reverse();   // Lark returns oldest first
      S.briefsAt = Date.now();
      cacheBriefs();
      status.replaceChildren();
      if (S.view === "result" && S.doc?.mode === "record") refreshResult();
      if (S.view === "briefs") renderBriefs();
      return list;
    })
    .catch((err) => {
      S.larkError = err.message;
      status.className = "list-status is-error";
      status.replaceChildren(ic("alert"), h("span", {}, `${err.message} `,
        h("button", { type: "button", class: "linkish", onclick: () => loadBriefs() }, "Try again")));
      if (S.view === "briefs" && first) renderBriefs();
      throw err;
    })
    .finally(() => {
      clearTimeout(slow);
      $("#refreshBtn").classList.remove("is-busy");
      S.briefsLoading = null;
      emitStatus();
    });
  emitStatus();
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
  return h("div", { class: "rcard-wrap", "data-id": b.id }, card,
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

async function toggleDone(b, done = !b.done) {
  b.done = done;   // update the list right away; undo if Lark refuses
  cacheBriefs();
  renderBriefs();
  try {
    await lark.setDone(b.id, done);
    toast(done ? `“${b.model.project_title}” moved to Done.` : `“${b.model.project_title}” is back in the list.`, {
      type: "success", action: "Undo", onAction: () => toggleDone(b, !done),
    });
  } catch (err) {
    b.done = !done;
    cacheBriefs();
    renderBriefs();
    toast(err.message || "Couldn't update Lark.", { type: "error" });
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
  const ok = await confirmDanger({
    what: m.project_title,
    details: [["Project", m.project_title], ["Client", B.isMissing(m.client_name) ? "" : m.client_name],
      ["Filed", `${B.fmtDate(m.date_filed)}${b.filedBy ? ` by ${b.filedBy}` : ""}`]],
    consequence: "This removes the brief from the Lark Base for everyone, including its attachments, next steps and notes.",
    safer: "Mark it Done instead if you might need it again.",
    run: () => lark.remove(b.id),
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
        $("#paper").replaceChildren(h("div", { class: "paper-loading is-error" }, ic("alert"), err.message));
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
  });
}

function wireBriefs() {
  $("#briefSearch").addEventListener("input", renderBriefs);
  $("#briefSort").addEventListener("change", renderBriefs);
  $("#refreshBtn").onclick = () => loadBriefs();
  applyLinks();
}

function applyLinks() {
  $("#larkTableLink").href = cfg().LARK_TABLE_URL;
  $("#openLarkLink").href = cfg().LARK_TABLE_URL;
}

// ---- Settings hooks ----------------------------------------------------------------
function wireSettings() {
  settingsView.mount({
    larkStatus: () => (S.briefsLoading ? { state: "loading" }
      : S.larkError ? { state: "error", error: S.larkError }
        : S.briefsAt ? { state: "ok", count: S.briefs.length } : { state: "unknown" }),
    reconnect({ tableChanged = false } = {}) {
      applyLinks();
      if (tableChanged) {
        S.briefs = null;
        S.edits = {};
        cacheBriefs();
      }
      extract.warm.at = 0;   // force a fresh check of the extraction service
      extract.ensureAwake();
      S.briefsAt = 0;
      if (auth.currentToken()) loadBriefs().catch(() => {});
    },
    login: (returnTo) => login(returnTo),
    logout() {
      // Logging out also forgets the cached list, so the next person on this
      // computer can't see it. The unsaved draft is theirs to resume or discard.
      S.briefs = null;
      S.briefsAt = 0;
      S.edits = {};
      cacheBriefs();
      sessionEnded("You've logged out of Fetch. You're still logged in to Lark itself.");
      go("#/");
    },
    clearLocal() {   // one click; Undo in the toast puts the draft, the cached list and the estimate back
      const kept = { draft: S.draft, files: S.draftFiles, briefs: S.briefs, at: S.briefsAt, edits: S.edits,
        factor: recall("local", "fetch.etaFactor") };
      setDraft(null);
      S.draftFiles = [];
      S.briefs = null;
      S.briefsAt = 0;
      S.edits = {};
      cacheBriefs();
      extract.resetEstimate();
      toast("Cleared this browser's draft and cached list.", { type: "success", action: "Undo", onAction: () => {
        if (!S.draft && kept.draft) { setDraft(kept.draft); S.draftFiles = kept.files; }
        S.edits = { ...kept.edits, ...S.edits };
        if (kept.factor != null && recall("local", "fetch.etaFactor") == null) store("local", "fetch.etaFactor", kept.factor);
        if (!S.briefs && kept.briefs) { S.briefs = kept.briefs; S.briefsAt = kept.at; cacheBriefs(); }
        if (S.view === "compose") showCompose();
        if (S.view === "briefs") renderBriefs();
        emitStatus();
      } });
      if (auth.currentToken()) loadBriefs().catch(() => {});
    },
  });
}

// ---- boot -------------------------------------------------------------------
/** Back from Lark's login page (?code=…&state=… or ?error=…)? Finish the login. */
async function finishLoginIfReturning() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  showView("busy");
  const res = await auth.finishLogin(params);
  // Drop ?code from the address bar (and history) at once.
  history.replaceState(null, "", location.pathname + (res.returnTo || location.hash || "#/"));
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
  cacheBriefs();

  wireSettings();
  $("#loginBtn").onclick = () => login();
  document.addEventListener(auth.AUTH_ENDED, (e) => sessionEnded(e.detail?.message));
  setInterval(tickSession, 20000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tickSession());
  document.addEventListener(extract.STATUS_EVENT, updateSetupNote);
  document.addEventListener(extract.STATUS_EVENT, () => {
    $("#blockNote").hidden = !extract.warm.blocked;
    try { $("#blockHost").textContent = new URL(cfg().GEMINI_PROXY_URL).host; } catch (_) { /* unset */ }
  });
  document.addEventListener(SETTINGS_EVENT, updateSetupNote);

  // Wake both Render services and load the briefs list right away, so the
  // service is ready and "All briefs" is populated before the user needs them.
  extract.ensureAwake();   // keeps retrying for ~3 min while a free instance boots
  lark.warmup();
  document.addEventListener("visibilitychange", () => {   // back after a while: it may have gone to sleep
    if (document.visibilityState === "visible" && !extract.isFresh()) extract.ensureAwake();
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
  window.addEventListener("beforeunload", (e) => {
    if (S.job || Object.keys(S.edits).length) { e.preventDefault(); e.returnValue = ""; }
  });
  window.addEventListener("resize", () => S.view === "compose" && autosize());
  route();
}

init();
