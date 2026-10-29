/*
 * "Check sources": shows the passage a field was taken from, highlighted in the
 * user's own file.
 *
 * The service returns, with each new draft, a short verbatim quote per value
 * (evidence) and the converted text of Office files and e-mails (texts). The files
 * of a draft stay in this tab's memory only (attach/drop): nothing is kept in
 * browser storage, so after a reload the quote still shows and the file can be
 * added again to see it in place. A filed brief brings its quotes and texts from
 * its "Fetch Files" column (bundle.js), and its files are downloaded from Lark the
 * first time one is shown (attach's `load`).
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
import { passagesOf } from "./evidence.js";
import { panZoom } from "./viewport.js";
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
const MAX_CANVAS_PX = 4e6;     // keeps phones from running out of memory on big pages
const MAX_PAGES_SEARCHED = 80;

// ---- the files behind a brief (memory only) ------------------------------------------
// By the brief's client token: { files: Map<name, File>, texts: (string|null)[], typed, load?, loading }
const stores = new Map();
const pdfDocs = new Map();   // File -> Promise<PDFDocumentProxy>
const pageCache = new WeakMap();   // PDFDocumentProxy -> Map<page, {units, scanned}>
const ocrCache = new Map();        // File | "name:size:page" -> Map<langs, Promise<units>>

/**
 * Keep the files of a brief: a freshly extracted draft's, or a filed one's (its `texts` and
 * `typed` from the sources file, and `load(name)` to download a file when it's first shown).
 * Files already kept under the same token stay.
 */
export function attach(token, { files = [], texts = [], typed = "", load = null } = {}) {
  const had = stores.get(token);
  const map = new Map(had ? had.files : []);
  files.forEach((f) => map.set(f.name, f));
  stores.set(token, { files: map, texts: Array.isArray(texts) ? texts : [], typed, load, loading: new Map() });
}

/** Forget one brief's files (a token), or every brief's. */
export function drop(token) {
  const gone = token === undefined ? [...stores.values()] : [stores.get(token)].filter(Boolean);
  const files = new Set(gone.flatMap((s) => [...s.files.values()]));
  pdfDocs.forEach((p, f) => {
    if (!files.has(f)) return;
    p.then((d) => d.destroy()).catch(() => {});
    pdfDocs.delete(f);
  });
  ocrCache.clear();
  if (token === undefined) stores.clear(); else stores.delete(token);
}

/** Add a file back after a reload. True if it belongs to this brief. */
export function addFile(draft, file) {
  const names = (draft.meta?.sources || []).map((s) => s.name);
  if (!names.includes(file.name)) return false;
  if (!stores.has(draft.clientToken)) attach(draft.clientToken);
  stores.get(draft.clientToken).files.set(file.name, file);
  return true;
}

export const kept = (draft) => (draft && stores.get(draft.clientToken)) || null;

/** A kept file, downloading it first if the brief is filed. Null if it can't be had. */
export function fileOf(k, name) {
  if (!k) return Promise.resolve(null);
  if (k.files.has(name)) return Promise.resolve(k.files.get(name));
  if (!k.load) return Promise.resolve(null);
  if (!k.loading.has(name)) {
    k.loading.set(name, Promise.resolve(k.load(name)).then((f) => {
      if (f) k.files.set(name, f);
      k.loading.delete(name);
      return f || null;
    }, (err) => { k.loading.delete(name); throw err; }));
  }
  return k.loading.get(name);
}

/** Will showing this file need a download first? */
export const needsDownload = (k, name) => !!(k && k.load && !k.files.has(name));

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
export function sourceOf(draft, ev) {
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

export function loadPdf() {
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
export function langsFor(quote) {
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
 * A stage: the page (canvas) laid out cssW x cssH, with an SVG layer of boxes in `w` x `h`
 * page units on top. A box may carry `cls` (its class) and `key` (data-key, to click on).
 */
export function stage(canvas, w, hgt, boxes, cssW, cssH) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "src-hits");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("preserveAspectRatio", "none");
  drawBoxes(svg, boxes, w);
  canvas.classList.add("src-canvas");
  const el = h("div", { class: "src-stage" }, canvas, svg);
  el.style.width = `${cssW}px`;
  el.style.height = `${cssH}px`;
  return el;
}

/** (Re)draw the boxes of a stage's SVG layer. */
export function drawBoxes(svg, boxes, w) {
  svg.replaceChildren();
  const pad = Math.max(1.5, w / 400);
  boxes.forEach((b) => {
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", b.x0 - pad); r.setAttribute("y", b.y0 - pad);
    r.setAttribute("width", b.x1 - b.x0 + pad * 2); r.setAttribute("height", b.y1 - b.y0 + pad * 2);
    r.setAttribute("rx", pad * 1.5);
    const cls = b.cls || (b.active ? "is-active" : "");
    if (cls) r.setAttribute("class", cls);
    if (b.key) r.dataset.key = b.key;
    svg.append(r);
  });
}

/** The smallest rectangle around some boxes, scaled by k (page units to CSS px). */
export function around(boxes, k = 1) {
  if (!boxes.length) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)) * k, y0: Math.min(...boxes.map((b) => b.y0)) * k,
    x1: Math.max(...boxes.map((b) => b.x1)) * k, y1: Math.max(...boxes.map((b) => b.y1)) * k,
  };
}

/** Text spans as <mark>s: ranges [{ from, to, cls, key }] may overlap (their classes add up). */
export function markText(pre, text, ranges) {
  const cuts = new Set([0, text.length]);
  ranges.forEach((r) => { cuts.add(r.from); cuts.add(r.to); });
  const points = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((a, b) => a - b);
  pre.replaceChildren();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const on = ranges.filter((r) => r.from <= a && r.to >= b);
    if (!on.length) { pre.append(text.slice(a, b)); continue; }
    const m = h("mark", { class: [...new Set(on.map((r) => r.cls).filter(Boolean))].join(" ") }, text.slice(a, b));
    const key = on.find((r) => r.key)?.key;
    if (key) m.dataset.key = key;
    pre.append(m);
  }
}

/** A mark's (or element's) rectangle inside `page`, in the page's own CSS px (undoing the zoom). */
export function rectIn(page, els, scale) {
  const p = page.getBoundingClientRect();
  const rs = els.flatMap((el) => [...el.getClientRects()]);
  if (!rs.length) return null;
  return {
    x0: (Math.min(...rs.map((r) => r.left)) - p.left) / scale, y0: (Math.min(...rs.map((r) => r.top)) - p.top) / scale,
    x1: (Math.max(...rs.map((r) => r.right)) - p.left) / scale, y1: (Math.max(...rs.map((r) => r.bottom)) - p.top) / scale,
  };
}

/** The viewer's frame: a toolbar (pager, zoom) above the pan-and-zoom box. */
function frame(view, ...tools) {
  const pan = h("div", { class: "src-pan", "aria-label": "Source document: scroll to zoom, drag to move" });
  view.replaceChildren(...(tools.length ? [h("div", { class: "src-toolbar" }, tools)] : []), pan);
  return pan;
}

/** − / percentage / + buttons for a viewport. */
export function zoomTools(pz) {
  const label = h("span", { class: "src-zoom-n", "aria-live": "polite" });
  pz.onChange((sc) => { label.textContent = `${Math.round(sc * 100)}%`; });
  return h("div", { class: "src-zoom" },
    h("button", { type: "button", class: "icon-btn", "aria-label": "Zoom out", title: "Zoom out", onclick: () => pz.zoomBy(1 / 1.25) }, "−"),
    label,
    h("button", { type: "button", class: "icon-btn", "aria-label": "Zoom in", title: "Zoom in", onclick: () => pz.zoomBy(1.25) }, "+"));
}

// ---- PDFs -----------------------------------------------------------------------------
/** The PDF document of a File (opened once). */
export async function openPdf(file) {
  const lib = await loadPdf();
  if (!pdfDocs.has(file)) {
    pdfDocs.set(file, file.arrayBuffer().then((data) => lib.getDocument({
      data, isEvalSupported: false, cMapUrl: `${PDFJS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}standard_fonts/`,
    }).promise).catch((e) => { pdfDocs.delete(file); throw e; }));
  }
  return pdfDocs.get(file);
}

/** Page n's text as units with boxes (page units), its search index, and whether it is a scan. */
export async function pdfPage(doc, n) {
  const lib = await loadPdf();
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
  const out = { units, scanned, w: vp.width, h: vp.height, index: scanned ? null : buildIndex(units) };
  pages.set(n, out);
  return out;
}

/** A scanned page read with OCR (cached): its units and search index. */
export async function scannedPage(doc, file, n, langs) {
  const units = await cachedOcr(`${file.name}:${file.size}:${n}`, langs, async () => {
    const r = await renderPdfPage(doc, n, 1000);
    return ocrUnits(r.canvas, langs, r.k);
  });
  return { units, index: buildIndex(units) };
}

/** Render page `n` for showing `cssWidth` px wide, sharp on this screen (and a little sharper than 1:1). */
export async function renderPdfPage(doc, n, cssWidth) {
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

/**
 * Where a passage { quote, page } is in a PDF: { page, exact, boxes } (page units) or null.
 * Gemini's page first, then its neighbours, then the rest; scanned pages are read with OCR
 * only near the page Gemini named.
 */
export async function locateInPdf(doc, file, it, { langs, onStatus, stale = () => false } = {}) {
  const near = pageOrder(it.page, doc.numPages).slice(0, it.page ? 3 : 2);
  for (const n of pageOrder(it.page, doc.numPages).slice(0, MAX_PAGES_SEARCHED)) {
    const pg = await pdfPage(doc, n);
    if (stale()) return null;
    let index = pg.index, scanned = pg.scanned;
    if (scanned) {
      if (!near.includes(n)) continue;
      onStatus?.(`Reading page ${n} (it's a scan)…`);
      ({ index } = await scannedPage(doc, file, n, langs));
      if (stale()) return null;
    }
    const hit = find(index, it.quote, { min: scanned ? 0.6 : 0.75 });
    if (hit) return { page: n, exact: hit.exact, boxes: rects(index, hit) };
  }
  return null;
}

// ---- images -------------------------------------------------------------------------------
const imageCache = new WeakMap();   // File -> Promise<{ canvas, k } | null>

/**
 * An image drawn on a canvas sized for OCR (as in tech/ocr demo: big enough for small text,
 * small enough to stay quick); `k` = canvas px per image px. Null if the browser can't read it.
 */
export function imageCanvas(file) {
  if (!imageCache.has(file)) {
    imageCache.set(file, createImageBitmap(file).then((bitmap) => {
      const long = Math.max(bitmap.width, bitmap.height);
      const k = long > 2400 ? 2400 / long : long < 900 ? Math.min(2, 900 / long) : 1;
      const canvas = h("canvas", { width: Math.round(bitmap.width * k), height: Math.round(bitmap.height * k) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return { canvas, k };
    }).catch(() => null));
  }
  return imageCache.get(file);
}

/** A copy of a canvas (a canvas can only be in one place on the page). */
export function copyCanvas(canvas) {
  const c = h("canvas", { width: canvas.width, height: canvas.height });
  c.getContext("2d").drawImage(canvas, 0, 0);
  return c;
}

/** The image's words (OCR, cached per file) and search index. */
export async function imageWords(file, canvas, langs, onProgress) {
  onOcrProgress = onProgress || null;
  const units = await cachedOcr(file, langs, () => ocrUnits(canvas, langs));
  return { units, index: buildIndex(units) };
}

// ---- the viewers in the side panel ----------------------------------------------------------
// Each viewer gets `items`: the passages of one field that are in this source, as
// { quote, page, active }. All are highlighted; the active one (picked in the panel) is
// stronger, and the view zooms so it fills the viewer's width.

const statusOf = (hit) => (hit ? (hit.exact ? "found" : "close") : "missing");
const TEXT_PAGE_W = 680;   // a text source is laid out like a page this wide

function textView(view, text, items, setStatus) {
  const index = buildIndex([{ text }]);
  let activeHit = null;
  const ranges = [];
  items.forEach((it) => {
    const hit = find(index, it.quote);
    if (it.active) activeHit = hit;
    const sp = hit && spanUnits(index, hit)[0];
    if (sp) ranges.push({ from: sp.from, to: sp.to, cls: it.active ? "is-active" : "is-other" });
  });
  const pre = h("pre", { class: "src-text", dir: "auto" });
  markText(pre, text, ranges);
  const page = h("div", { class: "src-textpage" }, pre);
  const pan = frame(view);
  const pz = panZoom(pan);
  view.prepend(h("div", { class: "src-toolbar" }, h("span"), zoomTools(pz)));
  page.style.width = `${TEXT_PAGE_W}px`;
  pan.append(page);
  pz.set(page, TEXT_PAGE_W, page.offsetHeight);
  const target = pre.querySelectorAll("mark.is-active");
  const r = target.length ? rectIn(page, [...target], pz.scale()) : null;
  if (r) pz.fitRect(r);
  setStatus(statusOf(activeHit));
}

async function pdfView(view, file, items, setStatus, stale) {
  setStatus("loading", "Opening the PDF…");
  const doc = await openPdf(file);
  if (stale()) return;
  const langs = langsFor(items.map((it) => it.quote).join(" "));
  setStatus("loading", "Looking for the passage…");
  const active = items.find((it) => it.active) || items[0];
  const found = new Map();
  for (const it of [active, ...items.filter((x) => x !== active)]) {
    const f = await locateInPdf(doc, file, it, { langs, stale, onStatus: (t) => setStatus("loading", t) });
    if (stale()) return;
    if (f) f.boxes = f.boxes.map((b) => ({ ...b, cls: it.active ? "is-active" : "is-other" }));
    found.set(it, f);
  }
  const af = found.get(active);
  let current = af ? af.page : active.page >= 1 && active.page <= doc.numPages ? active.page : 1;
  const boxesOn = (n) => [...found.values()].filter((f) => f && f.page === n).flatMap((f) => f.boxes);

  let drawing = 0, sharpening = 0, st = null;
  const k = 4 / 3;   // PDF points to CSS px: the page at its printed size
  const sharpen = async (sc) => {   // redraw the page for the new zoom, so text stays crisp
    const my = ++sharpening, target = st, n = current;
    if (!target) return;
    const r = await renderPdfPage(doc, n, parseFloat(target.style.width) * sc);
    if (stale() || my !== sharpening || st !== target) return;
    target.querySelector("canvas").replaceWith(Object.assign(r.canvas, { className: "src-canvas" }));
  };
  const pageN = h("span", { class: "src-page-n" });
  const prevBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Previous page", onclick: () => go(-1) }, ic("arrowLeft"));
  const nextBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Next page", onclick: () => go(1) }, ic("arrowRight"));
  const pan = frame(view, h("div", { class: "src-pager" }, prevBtn, pageN, nextBtn));
  const pz = panZoom(pan, { onZoom: sharpen });
  view.querySelector(".src-toolbar").append(zoomTools(pz));

  async function showPage(n, focus) {
    const my = ++drawing;
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const W = vp1.width * k, H = vp1.height * k;
    const r = await renderPdfPage(doc, n, Math.max(W, pan.clientWidth * 2));
    if (stale() || my !== drawing) return;
    const boxes = boxesOn(n);
    st = stage(r.canvas, r.w, r.h, boxes, W, H);
    pageN.textContent = `Page ${n} of ${doc.numPages}`;
    prevBtn.disabled = n <= 1;
    nextBtn.disabled = n >= doc.numPages;
    pz.set(st, W, H);
    const target = around(boxes.filter((b) => b.cls === "is-active"), k) || (focus ? around(boxes, k) : null);
    if (target) pz.fitRect(target);
  }
  function go(d) {
    current = Math.max(1, Math.min(doc.numPages, current + d));
    showPage(current, false);
  }
  await showPage(current, true);
  if (stale()) return;
  // Gemini's page numbers can be off (or count a cover page): say so when the passage was elsewhere.
  setStatus(statusOf(af), af && active.page && af.page !== active.page ? `It's on page ${af.page}.` : "");
}

async function imageView(view, file, items, setStatus, stale) {
  setStatus("loading", "Opening the image…");
  const img = await imageCanvas(file);
  if (stale()) return;
  if (!img) {
    view.replaceChildren(h("p", { class: "hint" }, "This image format can't be shown in this browser."));
    return setStatus("missing");
  }
  const { canvas, k } = img;
  const W = canvas.width / k, H = canvas.height / k;   // shown at the image's own size
  const pan = frame(view);
  const pz = panZoom(pan);
  view.prepend(h("div", { class: "src-toolbar" }, h("span"), zoomTools(pz)));
  let st = stage(copyCanvas(canvas), canvas.width, canvas.height, [], W, H);
  pz.set(st, W, H);
  const langs = langsFor(items.map((it) => it.quote).join(" "));
  setStatus("loading", "Reading the image (the first time takes a little longer)…");
  const { index } = await imageWords(file, canvas, langs, (m) => {
    if (!stale() && m.status === "recognizing text") setStatus("loading", `Reading the image… ${Math.round((m.progress || 0) * 100)}%`);
  });
  if (stale()) return;
  let activeHit = null;
  const boxes = items.flatMap((it) => {
    const hit = find(index, it.quote, { min: 0.6 });
    if (it.active) activeHit = hit;
    return hit ? rects(index, hit).map((b) => ({ ...b, cls: it.active ? "is-active" : "is-other" })) : [];
  });
  drawBoxes(st.querySelector("svg"), boxes, canvas.width);
  const target = around(boxes.filter((b) => b.cls === "is-active"), 1 / k);
  if (target) pz.fitRect(target);
  setStatus(statusOf(activeHit));
}

// ---- the panel content ------------------------------------------------------------------
let run = 0;

const STATUS = {
  found: "Highlighted where it appears.",
  close: "Closest match highlighted: the wording differs slightly, so read it carefully.",
  missing: "Couldn't pinpoint this passage in the document. Check it against the source yourself.",
  idle: "",
};

/**
 * A status line. Updating it while loading only changes the words: the spinner element
 * stays, so it keeps turning instead of restarting on every progress update.
 */
function statusLine() {
  const el = h("p", { class: "src-status", role: "status" });
  const spin = h("span", { class: "spinner", "aria-hidden": "true" });
  const words = h("span");
  el.append(spin, words);
  return {
    el,
    set(state, text = "") {
      el.className = `src-status is-${state}`;
      spin.hidden = state !== "loading";
      words.textContent = [STATUS[state], text].filter(Boolean).join(" ");
    },
    note(text) { words.textContent += ` ${text}`; },
    is: (state) => el.classList.contains(`is-${state}`),
  };
}

/**
 * Fill `host` with where one field came from: every passage Gemini based it on (a list to
 * pick from), and the picked one shown in its file with the field's other passages too.
 * `res` is evidence.resolve()'s result. `onAddFile(file)` is called when the user adds a
 * missing file back.
 */
export async function show(host, { res, draft, onAddFile }) {
  run++;
  const ev = res?.ev;
  if (!ev) {
    host.replaceChildren(h("div", { class: "src-empty" }, ic("info"), h("p", {}, res?.why === "added"
      ? "This point was added or rewritten after extraction, so there's no source to show."
      : "Gemini didn't point to a source for this value. It may be a default or not in the brief: check it yourself.")));
    return;
  }

  const passages = passagesOf(ev);
  const k = kept(draft);
  const status = statusLine();
  const view = h("div", { class: "src-view" });
  const picks = [];
  const cards = passages.map((p, i) => {
    const src = sourceOf(draft, p);
    const where = [src?.name || `Source ${p.source}`, p.page && src?.kind === "pdf" ? `page ${p.page}` : ""]
      .filter(Boolean).join(" · ");
    const pick = h("button", { type: "button", class: "src-pick", "aria-pressed": "false", onclick: () => select(i) },
      h("span", { class: "src-where" }, ic("file"), where),
      h("span", { class: "src-q", dir: "auto" }, `“${p.quote}”`));
    picks.push(pick);
    const copy = h("button", { type: "button", class: "icon-btn src-copy", "aria-label": "Copy this passage", title: "Copy",
      onclick: async (e) => { const btn = e.currentTarget; if (await copyText(p.quote)) flashDone(btn, ""); } }, ic("copy"));
    return h("li", { class: "src-passage" }, pick, copy);
  });
  host.replaceChildren(
    h("p", { class: "src-lead" }, passages.length > 1
      ? `Based on ${passages.length} passages in the brief. Pick one to see it in place:`
      : "Based on this passage in the brief:"),
    h("ol", { class: "src-passages" }, cards),
    res.edited ? h("p", { class: "hint src-edited" }, "You've edited this value since. Gemini extracted: ",
      h("b", {}, res.extracted || "(empty)")) : "",
    status.el, view);

  async function select(i) {
    const my = ++run;
    const stale = () => my !== run || !host.isConnected;
    const setStatus = (state, text) => { if (!stale()) status.set(state, text); };
    picks.forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
    const p = passages[i];
    const src = sourceOf(draft, p);
    // This field's passages in the same file, highlighted together.
    const items = passages.filter((q) => q.source === p.source).map((q) => ({ quote: q.quote, page: q.page, active: q === p }));
    const text = src?.kind === "typed" ? k?.typed : src ? k?.texts[src.index] : null;
    try {
      const visual = src && (src.kind === "pdf" || src.kind === "image");
      if (visual && needsDownload(k, src.name)) {
        setStatus("loading", `Downloading “${src.name}” from Lark…`);
        view.replaceChildren();
      }
      const file = visual ? await fileOf(k, src.name) : null;
      if (stale()) return;
      if (src?.kind === "pdf" && file) await pdfView(view, file, items, setStatus, stale);
      else if (src?.kind === "image" && file) await imageView(view, file, items, setStatus, stale);
      else if (text) {
        textView(view, text, items, setStatus);
        if (src.truncated && status.is("missing")) status.note("This file was long, so only its first part is shown here.");
      } else if (src && (src.kind === "pdf" || src.kind === "image")) {
        setStatus("idle");
        const input = h("input", { type: "file", hidden: "", accept: src.kind === "pdf" ? ".pdf,application/pdf" : "image/*",
          onchange: () => input.files[0] && onAddFile?.(input.files[0]) });
        view.replaceChildren(h("div", { class: "src-empty" }, ic("file"),
          h("p", {}, k?.load ? `“${src.name}” isn't attached to this brief in Lark any more. Add a copy to see the passage in place.`
            : `The page was reloaded, so “${src.name}” isn't open any more. Add it again to see the passage in place.`),
          h("button", { type: "button", class: "btn btn-sm btn-tonal", onclick: () => input.click() }, ic("plus"), `Add “${src.name}”`),
          input));
      } else if (src && (src.kind === "audio" || src.kind === "video")) {
        setStatus("idle");
        view.replaceChildren(h("p", { class: "hint" }, `Gemini ${src.kind === "audio" ? "listened to" : "watched"} “${src.name}”, so there's no page to highlight. The passage above is what it heard.`));
      } else {
        setStatus("idle");
        view.replaceChildren(h("p", { class: "hint" }, k?.load ? "Fetch didn't keep the text of this file. The passage above is what Gemini read."
          : "The text of this file is only kept until the page reloads. The passage above is what Gemini read."));
      }
      if (src?.hasBlobs && status.is("missing")) status.note("It may be in an image or attachment inside this file.");
    } catch (err) {
      if (stale()) return;
      setStatus("missing");
      view.replaceChildren(h("p", { class: "form-error" }, err?.message || "Couldn't open this file."));
    }
  }
  await select(0);
}

/** Stop showing anything (panel closed): late results are ignored. */
export function clear(host) {
  run++;
  host?.replaceChildren();
}
