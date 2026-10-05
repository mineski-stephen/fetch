/*
 * Talking to the Gemini proxy (render/gemini-pdf): warm-up, file preparation,
 * wait-time estimate, and the upload itself (XHR, for real upload progress).
 */
(function (BX) {
  "use strict";
  const cfg = () => BX.config;

  // Formats Gemini accepts as images; other images are converted in the browser.
  const NATIVE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);
  const MAX_IMAGE_SIDE = 3072;
  const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
  const COLD_START_S = 50;          // a sleeping free Render instance takes ~20–60 s
  const FRESH_MS = 4 * 60 * 1000;   // after this long without contact, re-check before uploading

  // state: unset | unknown | waking | warm | down. `configured` = the service has a shared key.
  // `error` explains the last failed check (shown in Settings).
  const warm = { state: "unknown", since: Date.now(), at: 0, configured: null, error: "", promise: null, loop: null };
  const emit = () => document.dispatchEvent(new Event("bx:status"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** One GET /health. Anything but the service's JSON (e.g. Render's HTML
   *  "starting up" page or a 502 during a deploy) counts as "not ready yet". */
  function ping(timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    return fetch(`${cfg().GEMINI_PROXY_URL}/health`, { cache: "no-store", signal: ctl.signal })
      .then(async (r) => {
        const type = r.headers.get("content-type") || "";
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!type.includes("json")) throw new Error("the service is still starting");
        const d = await r.json();
        if (d.status !== "ok") throw new Error("unexpected health response");
        Object.assign(warm, { state: "warm", configured: !!d.configured, at: Date.now(), error: "" });
        return true;
      })
      .catch((e) => {
        warm.error = e.name === "AbortError" ? "no answer within 90 s"
          : e instanceof TypeError ? "network error — address wrong, offline, or blocked" : e.message;
        warm.state = "down";
        return false;
      })
      .finally(() => { clearTimeout(timer); emit(); });
  }

  /** One wake attempt (shared by concurrent callers). Resolves true once awake. */
  function warmup(force = false) {
    if (!cfg().GEMINI_PROXY_URL) { warm.state = "unset"; emit(); return Promise.resolve(false); }
    if (warm.promise) return warm.promise;
    if (!force && isFresh()) return Promise.resolve(true);
    if (warm.state !== "waking") warm.since = Date.now();
    warm.state = "waking";
    emit();
    warm.promise = ping(90000).finally(() => { warm.promise = null; });
    return warm.promise;
  }

  const isFresh = () => warm.state === "warm" && Date.now() - warm.at < FRESH_MS;

  /** Keep trying to wake the service for up to `maxMs` (one shared loop at a time). */
  function ensureAwake(maxMs = 180000) {
    if (isFresh()) return Promise.resolve(true);
    if (warm.loop) return warm.loop;
    warm.loop = (async () => {
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        if (await warmup(true)) return true;
        if (!cfg().GEMINI_PROXY_URL) return false;
        warm.state = "waking";   // a failed check while booting is normal; keep trying
        emit();
        await sleep(3000);
      }
      warm.state = "down";
      emit();
      return false;
    })().finally(() => { warm.loop = null; });
    return warm.loop;
  }

  /** Seconds left in a typical cold start, measured from when waking began. */
  const coldLeft = () => Math.max(0, Math.round(COLD_START_S - (Date.now() - warm.since) / 1000));

  // ---- file preparation ------------------------------------------------------
  function kindOf(file) {
    const n = (file.name || "").toLowerCase(), t = file.type || "";
    if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
    if (t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif|tiff?)$/.test(n)) return "image";
    if (/\.(docx?|odt|rtf|pages)$/.test(n)) return "doc";
    if (/\.(pptx?|odp|key)$/.test(n)) return "slides";
    if (/\.(xlsx?|ods|csv|tsv|numbers)$/.test(n)) return "sheet";
    if (/\.(eml|msg|mht)$/.test(n)) return "mail";
    if (t.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|opus|aiff?)$/.test(n)) return "audio";
    if (t.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi|mpe?g)$/.test(n)) return "video";
    return "text";
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
      img.src = url;
    });
  }

  /** Convert unsupported images (GIF, BMP, SVG, AVIF…) and shrink huge ones. */
  async function prepareImage(file) {
    const native = NATIVE_IMAGES.has(file.type);
    if (native && file.size <= MAX_IMAGE_BYTES) {
      if (file.type !== "image/png" && file.type !== "image/jpeg") return file;
    }
    let loaded;
    try {
      loaded = await loadImage(file);
    } catch (_) {
      return file;   // e.g. HEIC outside Safari — the proxy accepts it as-is
    }
    const { img, url } = loaded;
    try {
      const w0 = img.naturalWidth || 1600, h0 = img.naturalHeight || 1200;
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w0, h0));
      if (native && scale === 1 && file.size <= MAX_IMAGE_BYTES) return file;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w0 * scale);
      canvas.height = Math.round(h0 * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";   // transparent GIF/SVG areas become white, not black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const big = file.size > MAX_IMAGE_BYTES || canvas.width * canvas.height > 4e6;
      const type = big ? "image/jpeg" : "image/png";
      const blob = await new Promise((r) => canvas.toBlob(r, type, 0.9));
      if (!blob) return file;
      const base = file.name.replace(/\.[^.]+$/, "") || "image";
      return new File([blob], `${base}.${type === "image/png" ? "png" : "jpg"}`, { type });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function prepare(items) {
    return Promise.all(items.map((it) => (it.kind === "image" ? prepareImage(it.file) : it.file)));
  }

  // ---- wait-time estimate ---------------------------------------------------------
  const FACTOR_KEY = "bx.etaFactor.lite";   // re-learn after the switch to Flash-Lite
  const readFactor = () => {
    try { return Math.min(2.5, Math.max(0.5, Number(localStorage.getItem(FACTOR_KEY)) || 1)); } catch (_) { return 1; }
  };

  /** Seconds we expect the whole request to take (calibrated by past runs). */
  function estimate(files, textChars) {
    const mb = files.reduce((s, f) => s + f.size, 0) / 1048576;
    const upload = mb / 1.5;   // assume ~1.5 MB/s upstream
    const work = 6 + 1.5 * files.length + 1.0 * mb + textChars / 30000;   // Flash-Lite: ~4–8 s for a typical brief
    return { total: Math.round(Math.min(240, upload + work * readFactor())), upload, cold: 0, work: work * readFactor() };
  }

  /** Learn from a finished run so the next estimate is closer. */
  function calibrate(predictedWork, actualWork) {
    if (!(predictedWork > 0) || !(actualWork > 0)) return;
    const ratio = Math.min(3, Math.max(0.33, actualWork / (predictedWork / readFactor())));
    try { localStorage.setItem(FACTOR_KEY, String(readFactor() * 0.7 + ratio * 0.3)); } catch (_) { /* private mode */ }
  }

  // ---- the request -----------------------------------------------------------------
  class ExtractError extends Error {
    constructor(message, code, status, retryAfter) {
      super(message);
      Object.assign(this, { code, status, retryAfter });
    }
  }

  /** POST /extract. Returns { promise, abort }. */
  function send(files, text, { onUploadProgress, onUploaded } = {}) {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    if (text) form.append("text", text);
    form.append("today", BX.brief.todayISO());

    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open("POST", `${cfg().GEMINI_PROXY_URL}/extract`);
      const key = BX.settings.geminiKey();
      if (key) xhr.setRequestHeader("X-Gemini-Api-Key", key);   // the user's own key, from Settings
      xhr.timeout = 6 * 60 * 1000;
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => e.lengthComputable && onUploadProgress?.(e.loaded / e.total);
      xhr.upload.onload = () => onUploaded?.();
      xhr.onload = () => {
        const body = xhr.response || {};
        if (xhr.status === 200 && body.brief) {
          warm.state = "warm";
          warm.at = Date.now();
          return resolve(body);
        }
        const err = body.error || {};
        reject(new ExtractError(err.message || `The extraction service returned an error (HTTP ${xhr.status}).`,
          err.code || "http", xhr.status, Number(xhr.getResponseHeader("Retry-After")) || 0));
      };
      xhr.onerror = () => reject(new ExtractError(
        "Couldn't reach the extraction service. Check your connection, or try again in a minute if it was asleep.", "network", 0));
      xhr.ontimeout = () => reject(new ExtractError("The extraction took too long. Try again, or split very large files.", "timeout", 0));
      xhr.onabort = () => reject(new ExtractError("Cancelled.", "aborted", 0));
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  }

  BX.extract = { warm, warmup, ensureAwake, isFresh, coldLeft, kindOf, prepare, estimate, calibrate, send, ExtractError };
})((window.BX = window.BX || {}));
