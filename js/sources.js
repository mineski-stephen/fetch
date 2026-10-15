/*
 * "Check sources": shows the passage a field was taken from, highlighted in the
 * user's own file.
 *
 * The service returns, with each new draft, a short verbatim quote per value
 * (evidence) and the converted text of Office files and e-mails (texts). The files
 * themselves stay in this tab's memory only (attach/drop): nothing is kept in
 * browser storage, so after a reload the quote still shows and the file can be
 * added again to see it in place.
 *
 *   PDF          pdf.js renders the page; its text layer locates the quote
 *                (scanned pages: OCR with Tesseract.js)
 *   image        Tesseract.js reads the words, then the quote is located
 *   Office/mail  the text Gemini read, with the quote marked
 *   typed text   the same
 *   audio/video  the quote only
 *
 * Both libraries are lazy-loaded from jsDelivr at pinned versions with SRI, the
 * first time a source is shown. Page CSP: connect-src needs https://cdn.jsdelivr.net
 * (pdf.js fonts and character maps, Tesseract's engine and language data).
 */
import { buildIndex, find, rects, spanUnits, pageOrder } from "./match.js";
import { h, ic, copyText, flashDone } from "./ui.js";

const CDN = "https://cdn.jsdelivr.net/npm/";
const PDFJS = `${CDN}pdfjs-dist@4.10.38/`;   // ≥ 4.2.67 (CVE-2024-4367)
const LIB = {
  pdf: [`${PDFJS}build/pdf.min.mjs`, "sha384-+0ti2moQlmLN7WZHE2RHIf5lV8hHxhxEalN0il3YZceG26fUPyOkR0hp9daxk1i7"],
  ocr: [`${CDN}tesseract.js@5.1.1/dist/tesseract.min.js`, "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F"],
};
const PDF_WORKER = `${PDFJS}build/pdf.worker.min.mjs`;
const TESS_WORKER = `${CDN}tesseract.js@5.1.1/dist/worker.min.js`;
const SVGNS = "http://www.w3.org/2000/svg";
const BIG_TEXT = 60000;        // longer texts show a window around the quote first
const MAX_CANVAS_PX = 4e6;     // keeps phones from running out of memory on big pages
const MAX_PAGES_SEARCHED = 80;

// ---- the files behind the current draft (memory only) ----------------------------
let store = null;   // { token, files: Map<name, File>, texts: (string|null)[], typed: string }
const pdfDocs = new Map();   // File -> Promise<PDFDocumentProxy>
const pageCache = new WeakMap();   // PDFDocumentProxy -> Map<page, {units, scanned}>
const ocrCache = new Map();        // File | "name:size:page" -> Map<langs, Promise<units>>

/** Keep the files of a freshly extracted draft. Replaces whatever was kept before. */
export function attach(token, { files = [], texts = [], typed = "" } = {}) {
  drop();
  store = { token, files: new Map(files.map((f) => [f.name, f])), texts: Array.isArray(texts) ? texts : [], typed };
}

/** Forget the files (after a save, or when the draft is discarded). */
export function drop() {
  pdfDocs.forEach((p) => p.then((d) => d.destroy()).catch(() => {}));
  pdfDocs.clear();
  ocrCache.clear();
  store = null;
}

/** Add a file back after a reload. True if it belongs to this draft. */
export function addFile(draft, file) {
  const names = (draft.meta?.sources || []).map((s) => s.name);
  if (!names.includes(file.name)) return false;
  if (store?.token !== draft.clientToken) store = { token: draft.clientToken, files: new Map(), texts: [], typed: "" };
  store.files.set(file.name, file);
  return true;
}

const kept = (draft) => (store && store.token === draft.clientToken ? store : null);

// ---- labels ---------------------------------------------------------------------
const LABELS = {
  client_name: "Client name", project_title: "Project title", event_period: "Event date / period", venue: "Venue",
  "due_date.date": "Due date", "due_date.note": "Due date", "budget.amount": "Estimated budget",
  "budget.type": "Budget type", "proposal_submission.type": "Proposal submission",
  "proposal_submission.details": "Proposal submission", summary: "TL;DR", objectives: "Objective",
  target_audience: "Target audience", kpis: "KPI", key_dates: "Key date", scope_of_work: "Scope of work",
  notes: "Note", clarifications: "Question for the client",
};

/** "Venue", "KPI 3", "Key date 1". */
export function fieldLabel(path) {
  if (LABELS[path]) return LABELS[path];
  const [name, k] = path.split(".");
  return LABELS[name] ? `${LABELS[name]}${/^\d+$/.test(k ?? "") ? ` ${Number(k) + 1}` : ""}` : path;
}

/** Which source a quote points at: { name, kind, hasBlobs, truncated } or null. */
function sourceOf(draft, ev) {
  const list = draft.meta?.sources || [];
  const i = ev.source - 1;
  if (i >= 0 && i < list.length) {
    const s = list[i];
    // has_blobs matters for a document or e-mail with images or attachments inside (a PDF is itself one).
    return { index: i, name: s.name, kind: s.kind, hasBlobs: !!s.has_blobs && !["pdf", "image", "audio", "video"].includes(s.kind),
      truncated: !!s.text_truncated };
  }
  if (i === list.length && (draft.meta?.typed_text_chars || (draft.sources || []).includes("Typed / pasted text"))) {
    return { index: i, name: "Typed / pasted text", kind: "typed", hasBlobs: false };
  }
  return null;
}

// ---- library loading --------------------------------------------------------------
const loading = {};

function loadScript([src, integrity], type) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    if (type) s.type = type;
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the document viewer. Check your connection, or allow cdn.jsdelivr.net if a blocker is on."));
    document.head.append(s);
  });
}

function loadPdf() {
  loading.pdf ??= loadScript(LIB.pdf, "module").then(() => {
    const lib = globalThis.pdfjsLib;
    if (!lib?.getDocument) throw new Error("The PDF viewer didn't start.");
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;   // pdf.js wraps a cross-origin worker itself
    return lib;
  }).catch((e) => { loading.pdf = null; throw e; });
  return loading.pdf;
}

function loadOcr() {
  loading.ocr ??= loadScript(LIB.ocr).then(() => globalThis.Tesseract)
    .catch((e) => { loading.ocr = null; throw e; });
  return loading.ocr;
}

/** Start loading what the draft's files will need (once checking mode is on). */
export function warm(draft) {
  const kinds = new Set((draft?.meta?.sources || []).map((s) => s.kind));
  if (kinds.has("pdf")) loadPdf().catch(() => {});
}

// ---- OCR (images, scanned PDF pages) ----------------------------------------------
let worker = null, workerKey = "", useDataWorker = false, onOcrProgress = null;

/** Language packs for a quote: English plus whatever script the quote is written in. */
function langsFor(quote) {
  const langs = ["eng"];
  if (/[぀-ヿ]/.test(quote)) langs.push("jpn");
  else if (/[一-鿿]/.test(quote)) langs.push("chi_sim");
  if (/[가-힯]/.test(quote)) langs.push("kor");
  if (/[฀-๿]/.test(quote)) langs.push("tha");
  return langs.join("+");
}

// Tesseract starts its worker from a blob: URL; where that's blocked, fall back to a data:
// URL worker that pulls the same script (as in tech/ocr demo).
async function getWorker(langs) {
  if (worker && workerKey === langs) return worker;
  if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  const T = await loadOcr();
  const base = { logger: (m) => onOcrProgress?.(m), errorHandler: () => {} };
  if (!useDataWorker) {
    try { worker = await T.createWorker(langs, 1, base); }
    catch (e) {
      if (!/worker|blob|origin|security/i.test(String(e?.message || e))) throw e;
      useDataWorker = true;
    }
  }
  if (useDataWorker) {
    worker = await T.createWorker(langs, 1, { ...base, workerBlobURL: false, cacheMethod: "none",
      workerPath: `data:text/javascript,${encodeURIComponent(`importScripts(${JSON.stringify(TESS_WORKER)});`)}` });
  }
  workerKey = langs;
  return worker;
}

/** OCR a canvas into word units (canvas pixels, scaled by `k` into the caller's coordinates). */
async function ocrUnits(canvas, langs, k = 1) {
  const w = await getWorker(langs);
  await w.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" });
  const { data } = await w.recognize(canvas);
  const units = [];
  (data.lines || []).forEach((line, li) => (line.words || []).forEach((word) => units.push({
    text: word.text, line: li, x0: word.bbox.x0 * k, y0: word.bbox.y0 * k, x1: word.bbox.x1 * k, y1: word.bbox.y1 * k,
  })));
  return units;
}

async function cachedOcr(key, langs, make) {
  let m = ocrCache.get(key);
  if (!m) ocrCache.set(key, (m = new Map()));
  if (!m.has(langs)) m.set(langs, make().catch((e) => { m.delete(langs); throw e; }));
  return m.get(langs);
}

// ---- drawing helpers ------------------------------------------------------------------
/**
 * A stage: the page (canvas) shown `cssWidth` px wide, with an SVG layer of highlight boxes
 * in `w` x `h` page units on top.
 */
function stage(canvas, w, hgt, boxes, cssWidth) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "src-hits");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const pad = Math.max(1.5, w / 400);
  boxes.forEach((b) => {
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", b.x0 - pad); r.setAttribute("y", b.y0 - pad);
    r.setAttribute("width", b.x1 - b.x0 + pad * 2); r.setAttribute("height", b.y1 - b.y0 + pad * 2);
    r.setAttribute("rx", pad * 1.5);
    svg.append(r);
  });
  canvas.classList.add("src-canvas");
  return h("div", { class: "src-stage", style: `width:${Math.round(cssWidth)}px` }, canvas, svg);
}

/** Scroll `box` so `el` sits in its middle, both ways. */
function centerIn(box, el) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  box.scrollTop += r.top - b.top - (box.clientHeight - r.height) / 2;
  box.scrollLeft += r.left - b.left - (box.clientWidth - r.width) / 2;
}

const firstBox = (stageEl) => stageEl.querySelector(".src-hits rect");

/** The viewer's frame: a toolbar (pager, zoom) above its own scroll box. */
function frame(view, ...tools) {
  const scroll = h("div", { class: "src-scroll", tabindex: "0", "aria-label": "Source document" });
  view.replaceChildren(...(tools.length ? [h("div", { class: "src-toolbar" }, tools)] : []), scroll);
  return scroll;
}

// Zoom is relative to the page's real size (a PDF page as printed, an image pixel for pixel).
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * Zoom buttons for a page `natural` CSS px wide. Starts close to real size (at least the box's
 * width, never past real size), so text is readable without zooming. `apply(cssWidth)` redraws.
 */
function zoomer(natural, fitWidth, apply) {
  let width = Math.min(natural, Math.max(fitWidth(), 760));
  const label = h("span", { class: "src-zoom-n", "aria-live": "polite" });
  const out = h("button", { type: "button", class: "icon-btn", "aria-label": "Zoom out", title: "Zoom out", onclick: () => step(-1) }, "−");
  const inn = h("button", { type: "button", class: "icon-btn", "aria-label": "Zoom in", title: "Zoom in", onclick: () => step(1) }, "+");
  const fit = h("button", { type: "button", class: "btn btn-sm btn-ghost", title: "Fit the page to the panel", onclick: () => set(fitWidth()) }, "Fit");
  function set(w) {
    width = Math.max(120, Math.min(natural * ZOOMS[ZOOMS.length - 1], w));
    label.textContent = `${Math.round((width / natural) * 100)}%`;
    out.disabled = width <= natural * ZOOMS[0] + 1;
    inn.disabled = width >= natural * ZOOMS[ZOOMS.length - 1] - 1;
    apply(width);
  }
  function step(dir) {
    const now = width / natural;
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
    if (next) set(natural * next);
  }
  return { tools: h("div", { class: "src-zoom" }, out, label, inn, fit), start: () => set(width), width: () => width };
}

// ---- the viewers ------------------------------------------------------------------------
function textView(view, text, quote, setStatus) {
  const index = buildIndex([{ text }]);
  const hit = find(index, quote);
  const span = hit && spanUnits(index, hit)[0];
  const pre = h("pre", { class: "src-text", dir: "auto", "aria-label": "Source text" });
  const fill = (from, to) => {
    pre.replaceChildren();
    if (from > 0) pre.append(h("span", { class: "src-more" }, "…\n"));
    if (span) {
      pre.append(text.slice(from, span.from), h("mark", {}, text.slice(span.from, span.to)), text.slice(span.to, to));
    } else pre.append(text.slice(from, to));
    if (to < text.length) pre.append(h("span", { class: "src-more" }, "\n…"));
  };
  const big = text.length > BIG_TEXT;
  const from = big && span ? Math.max(0, span.from - 8000) : 0;
  const to = big ? Math.min(text.length, (span ? span.to : 0) + (span ? 8000 : BIG_TEXT)) : text.length;
  fill(from, to);
  const scroll = frame(view);
  scroll.append(pre);
  if (big) {
    scroll.append(h("button", { type: "button", class: "btn btn-sm btn-ghost src-whole", onclick: (e) => {
      fill(0, text.length); e.currentTarget.remove(); centerIn(scroll, pre.querySelector("mark"));
    } }, "Show the whole file"));
  }
  centerIn(scroll, pre.querySelector("mark"));
  setStatus(hit ? (hit.exact ? "found" : "close") : "missing");
}

async function pdfUnits(lib, doc, n) {
  let pages = pageCache.get(doc);
  if (!pages) pageCache.set(doc, (pages = new Map()));
  if (pages.has(n)) return pages.get(n);
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const units = [];
  let prev = null, line = 0;
  for (const it of tc.items) {
    if (!it.str) { if (it.hasEOL) prev = null; continue; }
    const t = lib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(t[2], t[3]) || 10;
    const x0 = t[4], base = t[5], x1 = x0 + it.width * vp.scale;
    const sameLine = prev && Math.abs(prev.base - base) < fh * 0.4;
    if (!sameLine) line++;
    // Kerned words come as separate items with no gap: join them without a space.
    const glue = sameLine && x0 - prev.x1 < fh * 0.12 && !/\s$/.test(prev.text) && !/^\s/.test(it.str);
    units.push({ text: it.str, glue, x0, x1, y0: base - fh, y1: base + fh * 0.25, line });
    prev = { base, x1, text: it.str };
    if (it.hasEOL) prev = null;
  }
  const scanned = units.reduce((n, u) => n + u.text.trim().length, 0) < 20;
  const out = { units, scanned, w: vp.width, h: vp.height };
  pages.set(n, out);
  return out;
}

/** Render page `n` for showing `cssWidth` px wide, sharp on this screen (and a little sharper than 1:1). */
async function renderPdfPage(doc, n, cssWidth) {
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const sharp = Math.min(3, Math.max(window.devicePixelRatio || 1, 1.5));
  let scale = (cssWidth / vp1.width) * sharp;
  const cap = matchMedia("(pointer: coarse)").matches ? MAX_CANVAS_PX : MAX_CANVAS_PX * 4;
  if (vp1.width * vp1.height * scale * scale > cap) scale = Math.sqrt(cap / (vp1.width * vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = h("canvas", { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, w: vp1.width, h: vp1.height, k: vp1.width / canvas.width };
}

async function pdfView(view, file, ev, setStatus, stale) {
  setStatus("loading", "Opening the PDF…");
  const lib = await loadPdf();
  if (!pdfDocs.has(file)) {
    pdfDocs.set(file, file.arrayBuffer().then((data) => lib.getDocument({
      data, isEvalSupported: false, cMapUrl: `${PDFJS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}standard_fonts/`,
    }).promise).catch((e) => { pdfDocs.delete(file); throw e; }));
  }
  const doc = await pdfDocs.get(file);
  if (stale()) return;
  const langs = langsFor(ev.quote);
  const near = pageOrder(ev.page, doc.numPages).slice(0, ev.page ? 3 : 2);
  let found = null;
  setStatus("loading", "Looking for the quote…");
  for (const n of pageOrder(ev.page, doc.numPages).slice(0, MAX_PAGES_SEARCHED)) {
    let { units, scanned } = await pdfUnits(lib, doc, n);
    if (stale()) return;
    if (scanned) {
      if (!near.includes(n)) continue;   // OCR is slow: only the pages Gemini pointed at
      setStatus("loading", `Reading page ${n} (it's a scan)…`);
      units = await cachedOcr(`${file.name}:${file.size}:${n}`, langs, async () => {
        const r = await renderPdfPage(doc, n, 1000);
        return ocrUnits(r.canvas, langs, r.k);
      });
      if (stale()) return;
    }
    const index = buildIndex(units);
    const hit = find(index, ev.quote, { min: scanned ? 0.6 : 0.75 });
    if (hit) { found = { page: n, boxes: rects(index, hit), exact: hit.exact }; break; }
  }

  let current = found ? found.page : ev.page >= 1 && ev.page <= doc.numPages ? ev.page : 1;
  const first = await doc.getPage(current);
  const natural = first.getViewport({ scale: 1 }).width * (4 / 3);   // PDF points to CSS px: printed size
  let drawing = 0, scroll = null;
  const shown = new Promise((resolve) => {
    const show = async (width) => {
      const my = ++drawing;
      const r = await renderPdfPage(doc, current, width);
      if (stale() || my !== drawing) return resolve();
      const st = stage(r.canvas, r.w, r.h, found && found.page === current ? found.boxes : [], width);
      pageN.textContent = `Page ${current} of ${doc.numPages}`;
      prevBtn.disabled = current <= 1;
      nextBtn.disabled = current >= doc.numPages;
      scroll.replaceChildren(st);
      centerIn(scroll, firstBox(st));
      resolve();
    };
    const go = (d) => { current = Math.max(1, Math.min(doc.numPages, current + d)); show(zoom.width()); };
    const prevBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Previous page", onclick: () => go(-1) }, ic("arrowLeft"));
    const nextBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Next page", onclick: () => go(1) }, ic("arrowRight"));
    const pageN = h("span", { class: "src-page-n" });
    const zoom = zoomer(natural, () => Math.max(240, (scroll?.clientWidth || 480) - 2), show);
    scroll = frame(view, h("div", { class: "src-pager" }, prevBtn, pageN, nextBtn), zoom.tools);
    zoom.start();
  });
  await shown;
  if (stale()) return;
  // Gemini's page numbers can be off (or count a cover page): say so when the quote was elsewhere.
  setStatus(found ? (found.exact ? "found" : "close") : "missing",
    found && ev.page && found.page !== ev.page ? `It's on page ${found.page}.` : "");
}

async function imageView(view, file, ev, setStatus, stale) {
  setStatus("loading", "Opening the image…");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (_) {
    view.replaceChildren(h("p", { class: "hint" }, "This image format can't be shown in this browser."));
    return setStatus("missing");
  }
  // Same sizing as tech/ocr demo: big enough for small text, small enough to stay quick.
  const long = Math.max(bitmap.width, bitmap.height);
  const k = long > 2400 ? 2400 / long : long < 900 ? Math.min(2, 900 / long) : 1;
  const canvas = h("canvas", { width: Math.round(bitmap.width * k), height: Math.round(bitmap.height * k) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  // Shown at the image's own size (k undone), with zoom; OCR reads the canvas as drawn.
  let boxes = [], scroll = null;
  const natural = canvas.width / k;
  const draw = (width) => {
    const copy = h("canvas", { width: canvas.width, height: canvas.height });
    copy.getContext("2d").drawImage(canvas, 0, 0);
    const st = stage(copy, canvas.width, canvas.height, boxes, width);
    scroll.replaceChildren(st);
    centerIn(scroll, firstBox(st));
  };
  const zoom = zoomer(natural, () => Math.max(240, (scroll?.clientWidth || 480) - 2), draw);
  scroll = frame(view, zoom.tools);
  zoom.start();
  const langs = langsFor(ev.quote);
  onOcrProgress = (m) => {
    if (stale() || m.status !== "recognizing text") return;
    setStatus("loading", `Reading the image… ${Math.round((m.progress || 0) * 100)}%`);
  };
  setStatus("loading", "Reading the image (the first time takes a little longer)…");
  const units = await cachedOcr(file, langs, () => ocrUnits(canvas, langs));
  if (stale()) return;
  const index = buildIndex(units);
  const hit = find(index, ev.quote, { min: 0.6 });
  boxes = hit ? rects(index, hit) : [];
  draw(zoom.width());
  setStatus(hit ? (hit.exact ? "found" : "close") : "missing");
}

// ---- the panel content ------------------------------------------------------------------
let run = 0;

const STATUS = {
  found: "Highlighted where it appears.",
  close: "Closest match highlighted: the wording differs slightly, so read it carefully.",
  missing: "Couldn't pinpoint this in the document. Check the quote above against the source.",
};

/**
 * Fill `host` with the source of one field. `res` is evidence.resolve()'s result.
 * `onAddFile(file)` is called when the user adds a missing file back.
 */
export async function show(host, { path, res, draft, onAddFile }) {
  const my = ++run;
  const stale = () => my !== run || !host.isConnected;
  const ev = res?.ev;
  const status = h("p", { class: "src-status", role: "status" });
  const setStatus = (state, text = "") => {
    if (stale()) return;
    status.className = `src-status is-${state}`;
    status.replaceChildren(state === "loading" ? h("span", { class: "spinner", "aria-hidden": "true" }) : "",
      [STATUS[state], text].filter(Boolean).join(" "));
  };

  if (!ev) {
    host.replaceChildren(h("div", { class: "src-empty" }, ic("info"), h("p", {}, res?.why === "added"
      ? "This point was added or rewritten after extraction, so there's no source to show."
      : "Gemini didn't quote a source for this value. It may be inferred, a default, or not in the brief: check it yourself.")));
    return;
  }

  const src = sourceOf(draft, ev);
  const k = kept(draft);
  const where = [src?.name || `Source ${ev.source}`, ev.page && src?.kind === "pdf" ? `page ${ev.page}` : ""]
    .filter(Boolean).join(" · ");
  const copyBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: async (e) => {
    const btn = e.currentTarget;
    if (await copyText(ev.quote)) flashDone(btn, "Copied");
  } }, ic("copy"), "Copy quote");
  const view = h("div", { class: "src-view" });
  host.replaceChildren(
    h("figure", { class: "src-quote" },
      h("figcaption", {}, ic("file"), where),
      h("blockquote", { dir: "auto" }, `“${ev.quote}”`),
      copyBtn),
    res.edited ? h("p", { class: "hint src-edited" }, "You've edited this value since. Gemini extracted: ",
      h("b", {}, res.extracted || "(empty)")) : "",
    status, view);

  const file = src && k?.files.get(src.name);
  const text = src?.kind === "typed" ? k?.typed : src ? k?.texts[src.index] : null;
  try {
    if (src?.kind === "pdf" && file) await pdfView(view, file, ev, setStatus, stale);
    else if (src?.kind === "image" && file) await imageView(view, file, ev, setStatus, stale);
    else if (text) {
      textView(view, text, ev.quote, setStatus);
      if (src.truncated && status.classList.contains("is-missing")) {
        status.append(" This file was long, so only its first part is shown here.");
      }
    } else if (src && (src.kind === "pdf" || src.kind === "image")) {
      const input = h("input", { type: "file", hidden: "", accept: src.kind === "pdf" ? ".pdf,application/pdf" : "image/*",
        onchange: () => input.files[0] && onAddFile?.(input.files[0]) });
      view.replaceChildren(h("div", { class: "src-empty" }, ic("file"),
        h("p", {}, `The page was reloaded, so “${src.name}” isn't open any more. Add it again to see the quote in place.`),
        h("button", { type: "button", class: "btn btn-sm btn-tonal", onclick: () => input.click() }, ic("plus"), `Add “${src.name}”`),
        input));
    } else if (src && (src.kind === "audio" || src.kind === "video")) {
      view.replaceChildren(h("p", { class: "hint" }, `Gemini ${src.kind === "audio" ? "listened to" : "watched"} “${src.name}”, so there's no page to highlight. The quote above is what it heard.`));
    } else if (src) {
      view.replaceChildren(h("p", { class: "hint" }, "The text of this file is only kept until the page reloads. The quote above is what Gemini read."));
    }
    if (src?.hasBlobs && status.classList.contains("is-missing")) {
      status.append(" It may be in an image or attachment inside this file.");
    }
  } catch (err) {
    if (stale()) return;
    setStatus("missing");
    view.replaceChildren(h("p", { class: "form-error" }, err?.message || "Couldn't open this file."));
  }
}

/** Stop showing anything (panel closed): late results are ignored. */
export function clear(host) {
  run++;
  host?.replaceChildren();
}
