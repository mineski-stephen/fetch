/*
 * "Brief files": the whole brief, read like a document, beside the summary it became.
 *
 * A full-screen dialog (the page behind it dims) with a tab per file. PDFs show every
 * page, images and text files show whole. Every passage the summary was based on is
 * highlighted; clicking one opens a card naming the parts of the summary it supports,
 * with a way back to them. A search box highlights every match of a word or phrase.
 *
 * Built on the same helpers as the side panel (sources.js); files stay in memory only.
 */
import { buildIndex, findAll, rects, spanUnits, find, norm } from "./match.js";
import { passagesOf } from "./evidence.js";
import * as src from "./sources.js";
import { h, ic } from "./ui.js";

const MAX_COL = 920;   // widest a page is shown, CSS px
const TEXT_W = 760;

let dlg = null, ctx = null, run = 0;

function build() {
  const tabs = h("div", { class: "docs-tabs", role: "tablist", "aria-label": "Brief files" });
  const input = h("input", { type: "search", class: "docs-q", placeholder: "Search the brief…", "aria-label": "Search the brief",
    autocomplete: "off", spellcheck: "false" });
  const count = h("span", { class: "docs-count", "aria-live": "polite" });
  const prev = h("button", { type: "button", class: "icon-btn", "aria-label": "Previous match", title: "Previous (Shift+Enter)" }, ic("arrowLeft"));
  const next = h("button", { type: "button", class: "icon-btn", "aria-label": "Next match", title: "Next (Enter)" }, ic("arrowRight"));
  const close = h("button", { type: "button", class: "icon-btn docs-close", "aria-label": "Close the brief files" }, ic("x"));
  const status = h("p", { class: "docs-status", role: "status" });
  const pages = h("div", { class: "docs-pages", tabindex: "0", "aria-label": "Brief file" });
  const card = h("aside", { class: "docs-card card card-pad", hidden: "", "aria-live": "polite" });
  dlg = h("dialog", { class: "docs", "aria-labelledby": "docsTitle" },
    h("header", { class: "docs-head" },
      h("h2", { id: "docsTitle" }, ic("file"), "Brief files"),
      tabs,
      h("form", { class: "docs-search", role: "search", onsubmit: (e) => e.preventDefault() }, ic("search"), input, count, prev, next),
      close),
    status,
    h("div", { class: "docs-main" }, pages, card));
  document.body.append(dlg);

  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(input.value), 220); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  });
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  close.onclick = () => dlg.close();
  dlg.addEventListener("close", () => { run++; ctx?.observer?.disconnect(); ctx = null; pages.replaceChildren(); card.hidden = true; });
  pages.addEventListener("click", (e) => {
    const hit = e.target.closest?.("[data-key]");
    if (hit) pick(hit.dataset.key);
  });
  Object.assign(dlg, { $: { tabs, input, count, prev, next, status, pages, card } });
}

/**
 * Open the brief files of a draft. `describe(field)` gives { label, text } for a summary
 * field (as it reads now); `onReveal(field)` shows it in the summary (the dialog closes first).
 */
export function open({ draft, describe, onReveal }) {
  if (!dlg) build();
  const k = src.kept(draft);
  const list = (draft.meta?.sources || []).map((s, i) => ({ index: i, source: i + 1, name: s.name, kind: s.kind }));
  if (draft.meta?.typed_text_chars || (draft.sources || []).includes("Typed / pasted text")) {
    list.push({ index: list.length, source: list.length + 1, name: "Typed / pasted text", kind: "typed" });
  }
  // Every passage, once per place in a file, with the summary fields that cite it.
  const passages = new Map();
  (draft.evidence || []).forEach((ev) => passagesOf(ev).forEach((p) => {
    const key = `${p.source}|${norm(p.quote)}`;
    if (!passages.has(key)) passages.set(key, { key, source: p.source, page: p.page, quote: p.quote, fields: [] });
    const entry = passages.get(key);
    if (!entry.fields.includes(ev.field)) entry.fields.push(ev.field);
  }));
  ctx = { draft, k, list, passages, describe, onReveal, tab: null, query: "", hits: [], at: -1 };
  const { tabs, input } = dlg.$;
  tabs.replaceChildren(...list.map((s) => {
    const n = [...passages.values()].filter((p) => p.source === s.source).length;
    return h("button", { type: "button", role: "tab", class: "docs-tab", "aria-selected": "false", onclick: () => showTab(s) },
      s.name, n ? h("span", { class: "docs-tab-n", title: `${n} passages used in the summary` }, String(n)) : "");
  }));
  input.value = "";
  dlg.showModal();
  if (list.length) showTab(list[0]);
  else dlg.$.pages.replaceChildren(h("p", { class: "docs-empty" }, "This brief has no files to show."));
}

function setStatus(text, loading = false) {
  const el = dlg.$.status;
  el.replaceChildren(...(loading ? [h("span", { class: "spinner", "aria-hidden": "true" })] : []), text);
  el.hidden = !text;
}

// ---- one file -------------------------------------------------------------------------------
async function showTab(s) {
  const my = ++run;
  const stale = () => my !== run || !ctx;
  ctx.observer?.disconnect();
  ctx.tab = { source: s, pages: new Map(), text: null };
  [...dlg.$.tabs.children].forEach((b, i) => b.setAttribute("aria-selected", String(ctx.list[i] === s)));
  dlg.$.card.hidden = true;
  const { pages } = dlg.$;
  pages.replaceChildren();
  pages.scrollTop = 0;
  setStatus("");
  const file = ctx.k?.files.get(s.name);
  const text = s.kind === "typed" ? ctx.k?.typed : ctx.k?.texts[s.index];
  try {
    if (s.kind === "pdf" && file) await pdfTab(file, stale);
    else if (s.kind === "image" && file) await imageTab(file, stale);
    else if (text) textTab(text);
    else if (s.kind === "pdf" || s.kind === "image") {
      const input = h("input", { type: "file", hidden: "", accept: s.kind === "pdf" ? ".pdf,application/pdf" : "image/*",
        onchange: () => { if (input.files[0] && src.addFile(ctx.draft, input.files[0])) { ctx.k = src.kept(ctx.draft); showTab(s); } } });
      pages.append(h("div", { class: "docs-empty" }, ic("file"),
        h("p", {}, `The page was reloaded, so “${s.name}” isn't open any more. Add it again to read it here.`),
        h("button", { type: "button", class: "btn btn-sm btn-tonal", onclick: () => input.click() }, ic("plus"), `Add “${s.name}”`), input));
    } else if (s.kind === "audio" || s.kind === "video") {
      pages.append(h("p", { class: "docs-empty" }, `“${s.name}” is a recording, so there's nothing to show here.`));
    } else {
      pages.append(h("p", { class: "docs-empty" }, "The text of this file is only kept until the page reloads."));
    }
  } catch (err) {
    if (!stale()) pages.append(h("p", { class: "form-error docs-empty" }, err?.message || "Couldn't open this file."));
  }
  if (!stale() && ctx.query) search(ctx.query);
}

const colWidth = () => Math.min(MAX_COL, dlg.$.pages.clientWidth - 32);
const cited = (source) => [...ctx.passages.values()].filter((p) => p.source === source);

/** Boxes on one page: the summary's passages (clickable) and this search's matches. */
function boxesFor(pg) {
  const ev = pg.ev.flatMap(({ key, boxes }) => boxes.map((b) => ({ ...b, cls: key === ctx.picked ? "ev is-picked" : "ev", key })));
  const found = ctx.hits.filter((x) => x.page === pg.n).flatMap((x) => x.boxes.map((b) => ({ ...b, cls: x === ctx.hits[ctx.at] ? "hit is-current" : "hit" })));
  return [...ev, ...found];
}

function redraw() {
  ctx?.tab?.pages.forEach((pg) => pg.svg && src.drawBoxes(pg.svg, boxesFor(pg), pg.w));
  if (ctx?.tab?.text) textMarks();
}

async function pdfTab(file, stale) {
  setStatus("Opening the PDF…", true);
  const doc = await src.openPdf(file);
  if (stale()) return;
  const col = colWidth();
  const { pages } = dlg.$;
  const tab = ctx.tab;
  for (let n = 1; n <= doc.numPages; n++) {
    const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
    if (stale()) return;
    const hgt = (col * vp.height) / vp.width;
    const slot = h("div", { class: "docs-page", "data-page": n, "aria-label": `Page ${n}` });
    slot.style.width = `${col}px`;
    slot.style.height = `${hgt}px`;
    pages.append(slot);
    tab.pages.set(n, { n, slot, w: vp.width, h: vp.height, cssW: col, cssH: hgt, ev: [], svg: null, index: null, drawn: false });
  }
  const langs = src.langsFor(cited(tab.source.source).map((p) => p.quote).join(" "));
  // Draw pages as they scroll near, not all at once.
  ctx.observer = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    const pg = tab.pages.get(Number(e.target.dataset.page));
    if (pg && !pg.drawn) { pg.drawn = true; drawPdfPage(doc, file, pg, langs, stale); }
  }), { root: pages, rootMargin: "800px 0px" });
  tab.pages.forEach((pg) => ctx.observer.observe(pg.slot));

  // Find where each passage is, then mark them.
  const list = cited(tab.source.source);
  for (let i = 0; i < list.length; i++) {
    setStatus(`Marking the passages the summary used… ${i + 1} of ${list.length}`, true);
    const p = list[i];
    const f = await src.locateInPdf(doc, file, p, { langs, stale });
    if (stale()) return;
    if (f) tab.pages.get(f.page)?.ev.push({ key: p.key, boxes: f.boxes });
    redraw();
  }
  for (const pg of tab.pages.values()) {   // text of every page, for searching
    const info = await src.pdfPage(doc, pg.n);
    if (stale()) return;
    pg.index ??= info.index;
    pg.units ??= info.units;
  }
  setStatus(list.length ? "" : "Gemini didn't point to any passages in this file.");
}

async function drawPdfPage(doc, file, pg, langs, stale) {
  const r = await src.renderPdfPage(doc, pg.n, pg.cssW);
  if (stale()) return;
  const st = src.stage(r.canvas, r.w, r.h, [], pg.cssW, pg.cssH);
  pg.slot.replaceChildren(st);
  pg.svg = st.querySelector("svg");
  const info = await src.pdfPage(doc, pg.n);
  if (stale()) return;
  if (info.scanned && !pg.index) {   // a scan: read it so it can be searched
    const ocr = await src.scannedPage(doc, file, pg.n, langs);
    if (stale()) return;
    pg.index = ocr.index;
    if (ctx.query) search(ctx.query, { keep: true });
  }
  src.drawBoxes(pg.svg, boxesFor(pg), pg.w);
}

async function imageTab(file, stale) {
  setStatus("Opening the image…", true);
  const img = await src.imageCanvas(file);
  if (stale()) return;
  if (!img) { dlg.$.pages.append(h("p", { class: "docs-empty" }, "This image format can't be shown in this browser.")); return setStatus(""); }
  const col = Math.min(colWidth(), img.canvas.width / img.k);
  const cssH = (col * img.canvas.height) / img.canvas.width;
  const st = src.stage(src.copyCanvas(img.canvas), img.canvas.width, img.canvas.height, [], col, cssH);
  const slot = h("div", { class: "docs-page", "data-page": 1 }, st);
  dlg.$.pages.append(slot);
  const pg = { n: 1, slot, w: img.canvas.width, svg: st.querySelector("svg"), ev: [], index: null };
  ctx.tab.pages.set(1, pg);
  const list = cited(ctx.tab.source.source);
  setStatus("Reading the image…", true);
  const { index } = await src.imageWords(file, img.canvas, src.langsFor(list.map((p) => p.quote).join(" ")), (m) => {
    if (!stale() && m.status === "recognizing text") setStatus(`Reading the image… ${Math.round((m.progress || 0) * 100)}%`, true);
  });
  if (stale()) return;
  pg.index = index;
  list.forEach((p) => { const hit = find(index, p.quote, { min: 0.6 }); if (hit) pg.ev.push({ key: p.key, boxes: rects(index, hit) }); });
  setStatus("");
  redraw();
}

function textTab(text) {
  const pre = h("pre", { class: "src-text", dir: "auto" });
  const page = h("div", { class: "docs-textpage" }, pre);
  page.style.maxWidth = `${TEXT_W}px`;
  dlg.$.pages.append(page);
  const index = buildIndex([{ text }]);
  const ev = [];
  cited(ctx.tab.source.source).forEach((p) => {
    const hit = find(index, p.quote);
    const sp = hit && spanUnits(index, hit)[0];
    if (sp) ev.push({ key: p.key, from: sp.from, to: sp.to });
  });
  ctx.tab.text = { text, pre, index, ev };
  textMarks();
}

function textMarks() {
  const t = ctx.tab.text;
  const ranges = [
    ...t.ev.map((r) => ({ ...r, cls: r.key === ctx.picked ? "ev is-picked" : "ev" })),
    ...ctx.hits.map((x) => ({ from: x.from, to: x.to, cls: x === ctx.hits[ctx.at] ? "hit is-current" : "hit" })),
  ];
  src.markText(t.pre, t.text, ranges);
}

// ---- search ------------------------------------------------------------------------------------
function search(q, { keep = false } = {}) {
  if (!ctx?.tab) return;
  ctx.query = q.trim().length >= 2 ? q.trim() : "";
  const prevAt = ctx.at;
  ctx.hits = [];
  if (ctx.query) {
    if (ctx.tab.text) {
      const { index } = ctx.tab.text;
      ctx.hits = findAll(index, ctx.query).map((m) => spanUnits(index, m)[0]).filter(Boolean).map((sp) => ({ from: sp.from, to: sp.to }));
    } else {
      ctx.tab.pages.forEach((pg) => {
        if (!pg.index) return;
        findAll(pg.index, ctx.query).forEach((m) => ctx.hits.push({ page: pg.n, boxes: rects(pg.index, m) }));
      });
    }
  }
  ctx.at = ctx.hits.length ? (keep ? Math.min(Math.max(prevAt, 0), ctx.hits.length - 1) : 0) : -1;
  dlg.$.count.textContent = !ctx.query ? "" : ctx.hits.length ? `${ctx.at + 1} of ${ctx.hits.length}` : "No matches";
  dlg.$.prev.disabled = dlg.$.next.disabled = ctx.hits.length < 2;
  redraw();
  if (!keep && ctx.hits.length) reveal(ctx.hits[ctx.at]);
}

function step(d) {
  if (!ctx?.hits.length) return;
  ctx.at = (ctx.at + d + ctx.hits.length) % ctx.hits.length;
  dlg.$.count.textContent = `${ctx.at + 1} of ${ctx.hits.length}`;
  redraw();
  reveal(ctx.hits[ctx.at]);
}

/** Scroll the file so a match (or passage) sits in the middle. */
function reveal(x) {
  const { pages } = dlg.$;
  let el = null;
  if (ctx.tab.text) el = ctx.tab.text.pre.querySelector("mark.is-current") || ctx.tab.text.pre.querySelector("mark.is-picked");
  else if (x?.page) {
    const pg = ctx.tab.pages.get(x.page);
    const b = src.around(x.boxes, pg.cssW / pg.w);
    pages.scrollTo({ top: pg.slot.offsetTop + (b ? (b.y0 + b.y1) / 2 : 0) - pages.clientHeight / 2, behavior: "smooth" });
    return;
  }
  if (el) {
    const r = el.getBoundingClientRect(), p = pages.getBoundingClientRect();
    pages.scrollBy({ top: r.top - p.top - pages.clientHeight / 2, behavior: "smooth" });
  }
}

// ---- the card: what the summary made of a passage ----------------------------------------------
function pick(key) {
  const p = ctx?.passages.get(key);
  if (!p) return;
  ctx.picked = key;
  redraw();
  const { card } = dlg.$;
  card.replaceChildren(
    h("div", { class: "card-head" }, h("h3", {}, p.fields.length > 1 ? `Used for ${p.fields.length} parts of the summary` : "Used in the summary for"),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close this card", onclick: () => { card.hidden = true; ctx.picked = null; redraw(); } }, ic("x"))),
    h("blockquote", { class: "docs-quote", dir: "auto" }, `“${p.quote}”`),
    h("ul", { class: "docs-fields" }, p.fields.map((field) => {
      const d = ctx.describe(field);
      return h("li", {},
        h("span", { class: "subhead" }, d.label),
        h("span", { class: "docs-field-text" }, d.text || "(empty)"),
        d.canReveal ? h("button", { type: "button", class: "btn btn-sm btn-tonal", onclick: () => { const go = ctx.onReveal; dlg.close(); go(field); } },
          ic("arrowRight"), "Show in summary") : "");
    })));
  card.hidden = false;
}
