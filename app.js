/*
 * Fetch — page controller.
 *
 * Views (hash routes):
 *   #/              compose: drop files / type the brief      (+ processing state)
 *   #/result        the freshly extracted, unsaved draft
 *   #/briefs        every brief saved in the Lark Base
 *   #/briefs/<id>   one saved brief, editable
 *   #/settings      Gemini key, name, connections   (#/settings/key focuses the key)
 */
(function (BX) {
  "use strict";
  const B = BX.brief;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const h = BX.doc.h;
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fingerprint = (m) => JSON.stringify(B.normalize(m));

  // Settings can change BX.config at any time (settings.js), so always read it fresh.
  const cfg = () => BX.config;
  const emitStatus = () => document.dispatchEvent(new Event("bx:status"));

  // ---- storage ------------------------------------------------------------
  const store = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
    },
    set(key, value) {
      try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* full or blocked */ }
    },
  };

  // ---- state --------------------------------------------------------------
  const S = {
    view: null,
    items: [],        // compose: { id, file, kind, thumb }
    job: null,        // running extraction
    draft: store.get("bx.draft"),   // { model, original, meta, sources, createdAt, clientToken }
    doc: null,        // what the result view shows
    edits: {},        // unsaved edits to saved briefs, by record id: { model, nextSteps, attachments }
    draftFiles: [],   // File objects behind the draft (memory only; attached to the Lark row on save)
    briefs: null, briefsAt: 0, briefsLoading: null, larkError: null, highlight: null,
  };
  if (S.draft && !S.draft.model) S.draft = null;
  const cached = store.get("bx.briefsCache");
  if (Array.isArray(cached)) S.briefs = cached;

  // ---- small UI helpers -----------------------------------------------------
  function hydrateIcons(root = document) {
    $$("[data-icon]", root).forEach((el) => { el.classList.add("i"); el.innerHTML = BX.icons[el.dataset.icon] || ""; });
  }
  const iconEl = (name) => h("span", { class: "i", "aria-hidden": "true", html: BX.icons[name] || "" });

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  }

  function toast(message, { type = "info", action, onAction, timeout = 4500 } = {}) {
    const el = h("div", { class: `toast toast-${type}`, role: type === "error" ? "alert" : "status" },
      iconEl(type === "error" ? "alert" : type === "success" ? "check" : "sparkles"),
      h("span", { class: "toast-msg" }, message),
      action && h("button", { type: "button", class: "toast-action" }, action),
      h("button", { type: "button", class: "toast-x", "aria-label": "Dismiss" }, iconEl("x")));
    const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 250); };
    el.querySelector(".toast-x").onclick = close;
    if (action) el.querySelector(".toast-action").onclick = () => { onAction?.(); close(); };
    $("#toasts").append(el);
    if (timeout) setTimeout(close, timeout);
    return close;
  }

  function flash(btn, text, icon = "check", ms = 2000) {
    const label = btn.querySelector(".label");
    const ico = btn.querySelector(".i");
    const prev = [label?.textContent, ico?.innerHTML];
    if (label) label.textContent = text;
    if (ico) ico.innerHTML = BX.icons[icon];
    btn.classList.add("is-done");
    clearTimeout(btn._flash);
    btn._flash = setTimeout(() => {
      if (label) label.textContent = prev[0];
      if (ico) ico.innerHTML = prev[1];
      btn.classList.remove("is-done");
    }, ms);
  }

  function busy(btn, on, text) {
    btn.disabled = on;
    btn.classList.toggle("is-busy", on);
    const label = btn.querySelector(".label");
    if (label && on) { btn._label = label.textContent; label.textContent = text; }
    if (label && !on && btn._label) label.textContent = btn._label;
  }

  function confetti(fromEl) {
    if (reduceMotion() || !fromEl.animate) return;
    const r = fromEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const colors = ["#FFC800", "#16150F", "#FFE36E", "#F2A900", "#FFFFFF"];
    for (let i = 0; i < 42; i++) {
      const p = h("span", { class: "confetti" });
      p.style.left = `${cx}px`; p.style.top = `${cy}px`;
      p.style.background = colors[i % colors.length];
      p.style.width = `${6 + Math.random() * 6}px`; p.style.height = `${8 + Math.random() * 8}px`;
      document.body.append(p);
      const angle = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 160;
      const dx = Math.cos(angle) * dist, dy = Math.sin(angle) * dist - 90, spin = (Math.random() - 0.5) * 900;
      p.animate([
        { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy}px)) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 180}px)) rotate(${spin}deg)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 600, easing: "cubic-bezier(.2,.7,.3,1)" }).onfinish = () => p.remove();
    }
  }

  async function copyToClipboard(text, html) {
    try {
      if (html && navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        })]);
        return true;
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = h("textarea", { style: "position:fixed;opacity:0;top:0;left:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
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
    const apply = () => {
      $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
      document.body.dataset.view = name;
      const section = name === "settings" ? "settings"
        : name === "briefs" || (name === "result" && S.doc?.mode === "record") ? "briefs" : "compose";
      $$("[data-nav]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.nav === section));
    };
    const changed = S.view !== name;
    const animate = changed && S.view && document.startViewTransition && !reduceMotion() && document.visibilityState === "visible";
    S.view = name;
    BX.doc.close();
    if (animate) {
      const t = document.startViewTransition(apply);
      t.ready.catch(() => {});      // a skipped transition still applies the update
      t.finished.catch(() => {});
    } else {
      apply();
    }
    if (changed) window.scrollTo(0, 0);
  }

  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };

  function route() {
    const [a, b] = location.hash.replace(/^#\/?/, "").split("/");
    if (a === "briefs" && b) return showRecord(decodeURIComponent(b));
    if (a === "briefs") return showBriefs();
    if (a === "result") return S.draft ? showDraft() : go("#/");
    if (a === "settings") return showSettings();
    return showCompose();
  }

  function showSettings() {
    showView("settings");
    BX.settingsView.show();
  }

  /** Why extraction can't run right now ("" if it can). */
  function setupProblem() {
    if (!cfg().GEMINI_PROXY_URL) return "The extraction service isn't connected. Add its address in Settings.";
    if (BX.extract.warm.configured === false && !BX.settings.geminiKey()) {
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
      h("button", { type: "button", class: "file-x", "aria-label": `Remove ${it.file.name}`, "data-remove": it.id }, iconEl("x")))));
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
      const kind = BX.extract.kindOf(file);
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
    autosize();
    renderFiles();
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
    textarea().addEventListener("input", () => { autosize(); updateCompose(); });
    textarea().addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && composeReady()) { autoRetry.used = false; startExtraction(); }
    });
    $("#extractBtn").onclick = () => { autoRetry.used = false; startExtraction(); };
    $("#resumeOpen").onclick = () => go("#/result");
    $("#resumeDiscard").onclick = () => {
      setDraft(null);
      S.draftFiles = [];
      $("#resumeBanner").hidden = true;
      toast("Draft discarded.");
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
      li.classList.toggle("done", done || n < at);
      li.classList.toggle("current", !done && n === at);
    });
  }

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
    $("#stageLabel").textContent = "Preparing your files…";
    $("#etaNumber").textContent = "…";
    $("#etaUnit").textContent = "";
    $("#etaLabel").textContent = "Working out how long this will take…";
  }

  function tickWake() {
    const left = BX.extract.coldLeft();
    setStep("wake");
    $("#stageLabel").textContent = "Waking up the extraction service…";
    $("#etaNumber").textContent = left > 2 ? `~${left}` : "…";
    $("#etaUnit").textContent = left > 2 ? "sec" : "almost";
    $("#etaLabel").textContent = left > 2
      ? "It sleeps when nobody's used it for a while, so the first brief takes up to a minute longer."
      : "Almost awake…";
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
    } else {
      const spent = (job.uploadedAt - job.t0) / 1000;
      const r = (t - spent) / Math.max(6, est.total - spent);
      p = share + (1 - share) * (r < 1 ? 0.9 * r : 0.9 + 0.08 * (1 - Math.exp(-(r - 1) * 2)));
      step = r < 0.3 ? 1 : r < 0.75 ? 2 : 3;
      label = r > 1.25 ? "Still working — complex briefs take a little longer…" : STAGES[step];
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
      $("#etaLabel").textContent = left > -20 ? "Almost done…" : "Gemini is taking longer than usual. Hang tight — it'll retry automatically if it's busy.";
    }
  }

  async function startExtraction() {
    if (!composeReady() || S.job) return;
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
      files = await BX.extract.prepare(items);
    } catch (_) {
      files = items.map((it) => it.file);
    }
    if (S.job !== job) return;   // cancelled while preparing

    // The free Render instance sleeps when idle. If it doesn't answer at once,
    // show a "waking up" phase and wait for it before uploading anything.
    if (!BX.extract.isFresh()) {
      const awake = BX.extract.ensureAwake();
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
          return showLoaderError({ code: "network", message: `Couldn't reach the extraction service at ${cfg().GEMINI_PROXY_URL}${
            BX.config.GEMINI_OVERRIDDEN ? " (a test address set by the page link; open the page with ?reset to use the normal one)" : ""
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
    job.est = BX.extract.estimate(files, text.length);
    job.timer = setInterval(tick, 200);
    tick();

    const req = BX.extract.send(files, text, {
      onUploadProgress: (f) => { job.upload = f; },
      onUploaded: () => { job.uploadedAt = performance.now(); },
    });
    job.abort = req.abort;

    try {
      const res = await req.promise;
      if (job.uploadedAt) BX.extract.calibrate(job.est.work, (performance.now() - job.uploadedAt) / 1000);
      clearInterval(job.timer);
      setRing(1);
      setStep(4, true);
      $("#stageLabel").textContent = "Done!";
      $("#loader").classList.add("is-done");
      autoRetry.used = false;
      const model = B.normalize(res.brief);
      setDraft({
        model, original: clone(model), meta: res.meta, createdAt: Date.now(), clientToken: BX.lark.uuid(),
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
      "forbidden_origin", "not_configured", "invalid_api_key"].includes(err.code);
    $("#loaderErrorText").textContent = err.message || "Something went wrong.";
    $("#retryBtn").hidden = !retryable;
    $("#errSettingsBtn").hidden = !["not_configured", "invalid_api_key", "quota_exceeded"].includes(err.code);
    $("#stageLabel").textContent = {
      not_configured: "A Gemini API key is needed",
      invalid_api_key: "Your Gemini key needs attention",
      quota_exceeded: "Gemini usage limit reached",
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
    store.set("bx.draft", draft);
  }

  let persistTimer = null;
  function persistDraftSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => S.doc?.mode === "draft" && S.draft && store.set("bx.draft", S.draft), 400);
  }

  function showDraft() {
    const d = S.draft;
    openDoc({
      mode: "draft", model: d.model, original: d.original, meta: d.meta, sources: d.sources,
      nextSteps: d.nextSteps || [],
      attachments: S.draftFiles.map((f) => ({ name: f.name, size: f.size, file: f })),
      filesLost: !S.draftFiles.length && (d.sources || []).length > 0,   // page was reloaded since extraction
    });
  }

  // ---- Next steps & attachments: saved to the Lark row, never part of the document ----
  const extrasKey = (doc) => JSON.stringify([[...doc.nextSteps].sort(),
    doc.attachments.map((a) => a.token || `new:${a.name}:${a.size}`)]);

  function rememberEdits(doc) {
    if (doc.mode !== "record") return;
    if (isDirty(doc)) S.edits[doc.id] = { model: doc.model, nextSteps: doc.nextSteps, attachments: doc.attachments };
    else delete S.edits[doc.id];
  }

  function onExtrasChange() {
    const doc = S.doc;
    if (!doc) return;
    if (doc.mode === "draft" && S.draft) {
      S.draft.nextSteps = doc.nextSteps;
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

  function renderExtras() {
    const doc = S.doc;
    if (!doc) return;
    const chosen = new Set(doc.nextSteps.map((t) => t.toLowerCase()));
    $("#nsChips").replaceChildren(...stepOptions(doc).map((opt) => h("button", {
      type: "button", class: "ns-chip", "aria-pressed": String(chosen.has(opt.toLowerCase())), "data-step": opt,
    }, chosen.has(opt.toLowerCase()) ? iconEl("check") : null, opt)));

    const max = cfg().LARK_ATTACH_MAX_MB * 1048576;
    const list = $("#attList");
    list.replaceChildren(...doc.attachments.map((a, i) => {
      const tooBig = !a.token && a.size > max;
      return h("li", { class: `att${tooBig ? " is-warn" : ""}` },
        iconEl(tooBig ? "alert" : "file"),
        h("span", { class: "att-info" }, h("span", { class: "att-name", title: a.name }, a.name),
          h("span", { class: "att-meta" }, [fmtBytes(a.size || 0),
            a.token ? "in Lark" : tooBig ? `too large (max ${cfg().LARK_ATTACH_MAX_MB} MB)` : "uploads on save"].join(" · "))),
        h("button", { type: "button", class: "att-x", "data-remove": String(i), "aria-label": `Remove ${a.name}` }, iconEl("x")));
    }));
    list.hidden = !doc.attachments.length;
    const note = $("#attNote");
    note.hidden = !doc.filesLost;
    note.textContent = doc.filesLost ? "The page was reloaded, so the original files need adding again if you want them attached." : "";
  }

  function wireExtras() {
    $("#nsChips").addEventListener("click", (e) => {
      const chip = e.target.closest(".ns-chip");
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
        a.token = await BX.lark.uploadFile(a.file);   // kept on the item, so a retry won't upload it twice
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
    doc.attachments = (doc.attachments || []).map((a) => ({ ...a }));
    doc.savedExtras = doc.mode === "record" ? extrasKey({ nextSteps: doc.savedNextSteps || doc.nextSteps,
      attachments: doc.savedAttachments || doc.attachments }) : null;
    S.doc = doc;
    showView("result");
    BX.doc.render(doc.model);
    renderExtras();
    refreshResult();
    BX.pdf.prefetch();
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
      warn.replaceChildren(iconEl("alert"), h("div", {}, h("b", {}, "Check these: "), m.extraction_warnings.join(" · ")));
    }

    const save = $("#saveBtn");
    if (!save.classList.contains("is-busy")) {
      save.querySelector(".label").textContent = record ? (dirty ? "Save changes to Lark" : "All changes saved") : "Save to Lark Base";
      save.disabled = record && !dirty;
      save.classList.toggle("is-saved", record && !dirty);
      save.querySelector(".i").innerHTML = BX.icons[record && !dirty ? "check" : "save"];
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
    BX.doc.mount($("#paper"), onDocChange);

    $("#copyChatBtn").onclick = async (e) => {
      const m = B.normalize(S.doc.model);
      const ok = await copyToClipboard(B.toChatText(m), B.toChatHtml(m));
      ok ? flash(e.currentTarget, "Copied — paste it in the chat") : toast("Couldn't copy. Select the preview text and copy it manually.", { type: "error" });
    };

    $("#pdfBtn").onclick = async (e) => {
      const btn = e.currentTarget;
      busy(btn, true, "Preparing PDF…");
      try {
        await BX.pdf.download(S.doc.model);
        busy(btn, false);
        flash(btn, "PDF downloaded");
      } catch (err) {
        busy(btn, false);
        toast(err.message || "Couldn't create the PDF.", { type: "error" });
      }
    };

    $("#copyMdBtn").onclick = async () => {
      const ok = await copyToClipboard(B.toMarkdown(B.normalize(S.doc.model)));
      toast(ok ? "Markdown copied." : "Couldn't copy the Markdown.", { type: ok ? "success" : "error", timeout: 2200 });
      $(".more").open = false;
    };
    $("#mdBtn").onclick = () => {
      const m = B.normalize(S.doc.model);
      downloadText(`${B.fileStem(m)}.md`, B.toMarkdown(m));
      $(".more").open = false;
    };
    $("#resetBtn").onclick = (e) => {
      const btn = e.currentTarget;
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        btn.lastChild.textContent = " Click again to undo all edits";
        setTimeout(() => { delete btn.dataset.armed; btn.lastChild.textContent = " Undo all my edits"; }, 3500);
        return;
      }
      delete btn.dataset.armed;
      btn.lastChild.textContent = " Undo all my edits";
      S.doc.model = clone(S.doc.original);
      if (S.doc.mode === "draft") { S.draft.model = S.doc.model; persistDraftSoon(); }
      else delete S.edits[S.doc.id];
      BX.doc.render(S.doc.model);
      refreshResult();
      $(".more").open = false;
      toast("Edits undone.");
    };

    $("#saveBtn").onclick = openSaveDialog;
    $("#saveForm").addEventListener("submit", (e) => { e.preventDefault(); confirmSave(); });
    $("#saveCancel").onclick = () => $("#saveDialog").close();
    $("#saveDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  // ---- saving ------------------------------------------------------------------
  function openSaveDialog() {
    const doc = S.doc;
    if (!doc) return;
    BX.doc.close();
    const m = B.normalize(doc.model);
    const isNew = doc.mode === "draft";
    $("#saveTitle").textContent = isNew ? "Save this brief to Lark?" : "Save your changes to Lark?";
    $("#saveSub").textContent = isNew
      ? "It'll be added as a new row in the team's briefs table, where everyone can see it."
      : "This updates the existing row in the team's briefs table.";
    const rows = [["Project", m.project_title], ["Client", m.client_name], ["Due", B.dueText(m, false)],
      ["Budget", `${m.budget.amount}${m.budget.type !== "NOT SPECIFIED" ? ` (${B.label(m.budget.type)})` : ""}`]];
    $("#saveSummary").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", { class: B.isMissing(v) ? "muted" : "" }, v)]));
    const field = $("#filedBy").closest(".field");
    field.hidden = !isNew;
    $("#filedBy").value = BX.settings.name();
    $("#saveError").hidden = true;
    $("#saveConfirm .label").textContent = isNew ? "Save to Lark" : "Save changes";
    $("#saveDialog").showModal();
    $("#saveConfirm").focus();
  }

  async function confirmSave() {
    const doc = S.doc;
    const btn = $("#saveConfirm");
    const isNew = doc.mode === "draft";
    busy(btn, true, "Saving…");
    $("#saveError").hidden = true;
    try {
      let rec;
      if (isNew) {
        const filedBy = $("#filedBy").value.trim();
        if (filedBy) BX.settings.set({ name: filedBy });
        const skipped = await uploadPending(doc, $("#saveConfirm .label"));
        const extra = { filedBy, sources: (doc.sources || []).join("\n") };
        if (doc.nextSteps.length) extra.nextSteps = doc.nextSteps;
        if (attachedTokens(doc).length) extra.attachments = attachedTokens(doc);
        rec = await BX.lark.create(doc.model, extra, S.draft?.clientToken);
        Object.assign(rec, { nextSteps: [...doc.nextSteps], attachments: attachedList(doc) });
        if (skipped.length) toast(`Saved, but these files weren't attached: ${skipped.join("; ")}`, { type: "error", timeout: 9000 });
        setDraft(null);
        S.draftFiles = [];
        S.highlight = rec.id;
        upsertBrief(rec, true);
      } else {
        const skipped = await uploadPending(doc, $("#saveConfirm .label"));
        await BX.lark.update(doc.id, doc.model, { nextSteps: doc.nextSteps, attachments: attachedTokens(doc) });
        const model = B.normalize(doc.model);
        doc.original = clone(model);
        doc.savedJSON = fingerprint(model);
        doc.attachments = attachedList(doc);
        doc.savedExtras = extrasKey(doc);
        delete S.edits[doc.id];
        renderExtras();
        if (skipped.length) toast(`Saved, but these files weren't attached: ${skipped.join("; ")}`, { type: "error", timeout: 9000 });
        // The update response only echoes the columns we sent, so keep Status etc. from the list.
        upsertBrief({ id: doc.id, model: clone(model), nextSteps: [...doc.nextSteps], attachments: attachedList(doc) }, false);
      }
      busy(btn, false);
      $("#saveDialog").close();
      confetti($("#saveBtn"));
      if (isNew) {
        toast("Saved to Lark Base. Here's every brief the team has filed.", { type: "success", action: "Open in Lark",
          onAction: () => window.open(cfg().LARK_TABLE_URL, "_blank", "noopener") });
        go("#/briefs");
      } else {
        toast("Changes saved to Lark.", { type: "success" });
        refreshResult();
      }
    } catch (err) {
      busy(btn, false);
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
    store.set("bx.briefsCache", S.briefs);
    const count = $("#briefCount");
    count.hidden = !S.briefs?.length;
    count.textContent = S.briefs?.length || "";
  }

  function loadBriefs() {
    if (S.briefsLoading) return S.briefsLoading;
    S.larkError = null;
    const status = $("#briefsStatus");
    const first = !S.briefs;
    status.className = "briefs-status";
    status.textContent = first ? "Loading briefs from Lark…" : "Refreshing…";
    $("#refreshBtn").classList.add("spinning");
    if (first) renderSkeletons();
    const slow = setTimeout(() => {
      status.textContent = "Waking up the Lark connection — the first load after a quiet spell can take up to a minute…";
    }, 5000);
    S.briefsLoading = BX.lark.listAll()
      .then((list) => {
        S.briefs = list.reverse();   // Lark returns oldest first
        S.briefsAt = Date.now();
        cacheBriefs();
        status.textContent = "";
        if (S.view === "result" && S.doc?.mode === "record") refreshResult();
        if (S.view === "briefs") renderBriefs();
        return list;
      })
      .catch((err) => {
        S.larkError = err.message;
        status.className = "briefs-status is-error";
        status.replaceChildren(iconEl("alert"), ` ${err.message} `,
          h("button", { type: "button", class: "linkish", onclick: null }, "Try again"));
        status.querySelector("button").onclick = () => loadBriefs();
        if (S.view === "briefs" && first) renderBriefs();
        throw err;
      })
      .finally(() => {
        clearTimeout(slow);
        $("#refreshBtn").classList.remove("spinning");
        S.briefsLoading = null;
        emitStatus();
      });
    emitStatus();
    S.briefsLoading.catch(() => {});
    return S.briefsLoading;
  }

  function renderSkeletons() {
    $("#briefGrid").replaceChildren(...Array.from({ length: 6 }, (_, i) =>
      h("div", { class: "bcard skeleton", style: `--i:${i}`, "aria-hidden": "true" },
        h("span", { class: "sk sk-chip" }), h("span", { class: "sk sk-title" }), h("span", { class: "sk sk-line" }),
        h("span", { class: "sk sk-line short" }), h("span", { class: "sk sk-foot" }))));
  }

  const STATUS_TONE = { new: "new", "in progress": "progress", submitted: "submitted", won: "won", lost: "lost", declined: "lost" };

  function briefCard(b, i) {
    const m = b.model;
    const due = m.due_date.date ? B.dueBadge(m.due_date.date) : null;
    const tone = STATUS_TONE[(b.status || "").toLowerCase()] || "new";
    return h("a", { class: `bcard${S.highlight === b.id ? " is-new" : ""}`, href: `#/briefs/${encodeURIComponent(b.id)}`, style: `--i:${Math.min(i, 12)}` },
      h("div", { class: "bcard-top" },
        h("span", { class: `status s-${tone}` }, b.status || "New"),
        due ? h("span", { class: `due-pill tone-${due.tone}` }, iconEl("clock"), `Due ${B.fmtDate(m.due_date.date)} · ${due.text}`)
          : h("span", { class: "due-pill tone-none" }, iconEl("clock"), "No due date")),
      h("h3", {}, m.project_title),
      h("p", { class: "bcard-client" }, B.isMissing(m.client_name) ? "Client not specified" : m.client_name),
      m.summary && h("p", { class: "bcard-summary" }, m.summary),
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, iconEl("calendar"), "Event"), h("dd", {}, B.isMissing(m.event_period) ? "—" : m.event_period)),
        h("div", {}, h("dt", {}, iconEl("coin"), "Budget"), h("dd", {}, B.isMissing(m.budget.amount) ? "—" : m.budget.amount))),
      (b.nextSteps || []).length ? h("div", { class: "bcard-steps" },
        b.nextSteps.slice(0, 3).map((t) => h("span", { class: "step-pill" }, t)),
        b.nextSteps.length > 3 ? h("span", { class: "step-pill more" }, `+${b.nextSteps.length - 3}`) : null) : null,
      h("div", { class: "bcard-foot" }, `Filed ${B.fmtDate(m.date_filed)}${b.filedBy ? ` · ${b.filedBy}` : ""}`
        + ((b.attachments || []).length ? ` · ${b.attachments.length} file${b.attachments.length === 1 ? "" : "s"}` : ""),
        S.edits[b.id] ? h("span", { class: "unsaved" }, "• unsaved edits") : null));
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

    if (!S.briefs.length) {
      grid.replaceChildren(h("div", { class: "empty" },
        h("div", { class: "empty-art", "aria-hidden": "true" }, iconEl("inbox")),
        h("h2", {}, "No briefs yet"),
        h("p", {}, "Extract your first brief and save it — it'll show up here for the whole team."),
        h("a", { class: "btn btn-primary", href: "#/" }, iconEl("sparkles"), " Extract a brief")));
      return;
    }
    if (!list.length) {
      grid.replaceChildren(h("div", { class: "empty small" }, h("p", {}, `No briefs match “${q}”.`)));
      return;
    }
    grid.replaceChildren(...list.map(briefCard));
    const hl = grid.querySelector(".is-new");
    if (hl) {
      hl.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
      setTimeout(() => { S.highlight = null; }, 4000);
    }
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
          $("#paper").replaceChildren(h("div", { class: "paper-loading is-error" }, iconEl("alert"), err.message));
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
      savedNextSteps: b.nextSteps || [], savedAttachments: b.attachments || [],
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
    BX.settingsView.mount({
      toast,
      larkStatus: () => (S.briefsLoading ? { state: "loading" }
        : S.larkError ? { state: "error", error: S.larkError }
          : S.briefsAt ? { state: "ok", count: S.briefs.length } : { state: "unknown" }),
      reconnect({ tableChanged = false } = {}) {
        applyLinks();
        BX.lark.resetToken();
        if (tableChanged) {
          S.briefs = null;
          S.edits = {};
          cacheBriefs();
        }
        BX.extract.warm.at = 0;   // force a fresh check of the extraction service
        BX.extract.ensureAwake();
        S.briefsAt = 0;
        loadBriefs().catch(() => {});
      },
      clearLocal() {
        setDraft(null);
        S.draftFiles = [];
        S.briefs = null;
        S.briefsAt = 0;
        S.edits = {};
        cacheBriefs();
        try { localStorage.removeItem("bx.etaFactor.lite"); } catch (_) { /* blocked */ }
        toast("Local data cleared.", { type: "success" });
        loadBriefs().catch(() => {});
      },
    });
  }

  // ---- boot -------------------------------------------------------------------
  function init() {
    hydrateIcons();
    wireCompose();
    wireProcessing();
    wireResult();
    wireExtras();
    wireBriefs();
    cacheBriefs();

    wireSettings();
    document.addEventListener("bx:status", updateSetupNote);
    document.addEventListener("bx:settings", updateSetupNote);

    // Wake both Render services and load the briefs list right away, so the
    // service is ready and "All briefs" is populated before the user needs them.
    BX.extract.ensureAwake();   // keeps retrying for ~3 min while a free instance boots
    BX.lark.warmup();
    document.addEventListener("visibilitychange", () => {   // back after a while: it may have gone to sleep
      if (document.visibilityState === "visible" && !BX.extract.isFresh()) BX.extract.ensureAwake();
    });
    loadBriefs().catch(() => {});
    updateSetupNote();

    window.addEventListener("hashchange", route);
    window.addEventListener("beforeunload", (e) => {
      if (S.job || Object.keys(S.edits).length) { e.preventDefault(); e.returnValue = ""; }
    });
    window.addEventListener("resize", () => S.view === "compose" && autosize());
    route();
  }

  init();
})((window.BX = window.BX || {}));
