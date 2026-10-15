/*
 * Talking to the Gemini proxy (render/gemini-pdf): file preparation, wait-time estimate,
 * and the upload itself (XHR, for real upload progress). Waking the service, its status
 * and the compatibility check are in net.js (geminiService).
 */
import { todayISO } from "./brief.js";
import * as auth from "./auth.js";
import { geminiService } from "./net.js";
import { RULES } from "./config.js";
import { geminiKey } from "./settings.js";
import { store, recall } from "./ui.js";

// Formats Gemini accepts as images; other images are converted in the browser.
const NATIVE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);
const MAX_IMAGE_SIDE = 3072;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

/** Upload limits: what the service itself reports at GET /, else the config's fallback. */
export function limits() {
  const l = (geminiService.status.info || {}).limits || {};
  return { maxUploadMb: Number(l.max_upload_mb) || RULES.maxUploadMb, maxFiles: Number(l.max_files) || RULES.maxFiles };
}

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
    return file;   // e.g. HEIC outside Safari - the proxy accepts it as-is
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
const FACTOR_KEY = "fetch.etaFactor";   // a JSON number, learned from Flash-Lite runs
const readFactor = () => Math.min(2.5, Math.max(0.5, Number(recall("local", FACTOR_KEY)) || 1));

/** Seconds we expect the whole request to take (calibrated by past runs). */
function estimate(files, textChars) {
  const mb = files.reduce((s, f) => s + f.size, 0) / 1048576;
  const upload = mb / 1.5;   // assume ~1.5 MB/s upstream
  // Flash-Lite: ~4–8 s for a typical brief, plus ~6 s for the "Check sources" passages (service 1.7+)
  const work = 12 + 1.5 * files.length + 1.0 * mb + textChars / 30000;
  return { total: Math.round(Math.min(240, upload + work * readFactor())), upload, cold: 0, work: work * readFactor() };
}

/** Learn from a finished run so the next estimate is closer. */
function calibrate(predictedWork, actualWork) {
  if (!(predictedWork > 0) || !(actualWork > 0)) return;
  const ratio = Math.min(3, Math.max(0.33, actualWork / (predictedWork / readFactor())));
  store("local", FACTOR_KEY, readFactor() * 0.7 + ratio * 0.3);
}

/** Forget what past runs taught the estimate (Settings > Clear local data). */
const resetEstimate = () => store("local", FACTOR_KEY, undefined);

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
  form.append("today", todayISO());

  const xhr = new XMLHttpRequest();
  const started = performance.now();
  const promise = new Promise((resolve, reject) => {
    const login = auth.token();
    if (!login) {
      auth.end();
      return reject(new ExtractError("Your login has ended. Log in again, then extract the brief.", "login_expired", 401));
    }
    xhr.open("POST", `${geminiService.url()}/extract`);
    xhr.setRequestHeader("Authorization", `Bearer ${login}`);   // the service checks this with Lark
    const key = geminiKey();
    if (key) xhr.setRequestHeader("X-Gemini-Api-Key", key);   // the user's own key, from Settings
    xhr.timeout = 6 * 60 * 1000;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onUploadProgress?.(e.loaded / e.total);
    xhr.upload.onload = () => onUploaded?.();
    xhr.onload = () => {
      geminiService.worked();   // it answered, so it's awake
      const body = xhr.response || {};
      if (xhr.status === 200 && body.brief) return resolve(body);
      const err = body.error || {};
      if (["login_required", "login_expired", "login_invalid"].includes(err.code)) auth.end(err.message);
      reject(new ExtractError(err.message || `The extraction service answered with an error (HTTP ${xhr.status}). Try again in a moment.`,
        err.code || "http", xhr.status, Number(xhr.getResponseHeader("Retry-After")) || 0));
    };
    xhr.onerror = () => {
      geminiService.threw(started);
      reject(new ExtractError(geminiService.isBlocked()
        ? `Your browser is blocking ${geminiService.host()}, probably an ad blocker or privacy extension. Allow that site, then reload.`
        : `Fetch can't reach its extraction service (${geminiService.host()}). It may still be waking up; try again in a moment.`,
        "network", 0));
    };
    xhr.ontimeout = () => reject(new ExtractError("The extraction took too long. Try again, or split very large files.", "timeout", 0));
    xhr.onabort = () => reject(new ExtractError("Cancelled.", "aborted", 0));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export { kindOf, prepare, estimate, calibrate, resetEstimate, send, ExtractError };
