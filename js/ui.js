/* Mineski UI helpers: the behavior half of the design language.
   ES module, no dependencies. Pairs with mineski-base.css and icons.js.

   import { $, $$, h, ic, fillIcons, toast, busy, flashDone, popBadge, copyText, copyable,
            collapse, flash, openMenu, confirmDanger, confirmSheet, initTheme, radioKeys, store, recall,
            fmt, reduceMotion, confetti } from "./ui.js";

   Every helper encodes a rule from references/feedback-and-states.md; read that
   before changing timings or behavior. */

import { ICONS } from "./icons.js";

/* ---------------------------------------------------------------- DOM */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* h("div", { class: "x", onclick }, "text", child, [more]) builds an element.
   Text is always set as text, never as HTML (no injection from Lark data). */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === "") continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/* An icon from icons.js (trusted, static markup). */
export function ic(name, cls = "i") {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

/* Fill every <span data-icon="name"> in the page (call once on load). */
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) el.innerHTML = ICONS[el.dataset.icon] || "";
}

/* ---------------------------------------------------------------- storage that never throws */
// Private mode or blocked site data must never break the page.
export function store(area, key, value) {
  try {
    const s = window[area + "Storage"];
    if (value === undefined) s.removeItem(key); else s.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}
export function recall(area, key) {
  try { return JSON.parse(window[area + "Storage"].getItem(key)); } catch (e) { return null; }
}

/* ---------------------------------------------------------------- theme */
/* Light / Dark / System. The choice is applied before paint by the inline script
   in <head> (see templates/starter/index.html); this wires the Settings control.
   Markup: <div class="seg" role="radiogroup"> <button role="radio" data-theme-choice="system|light|dark"> */
export function initTheme(seg, key) {
  const paint = () => {
    const now = recall("local", key) || "system";
    for (const b of seg.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-checked", String(b.dataset.themeChoice === now));
  };
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-choice]");
    if (!b) return;
    const choice = b.dataset.themeChoice;
    if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    store("local", key, choice === "system" ? undefined : choice);
    paint();
  });
  radioKeys(seg);
  paint();
}

/* Arrow keys, Home and End move focus and the choice within a role="radiogroup"
   (theme switch, choice chips), like native radios. Only the checked option is a
   tab stop. Call once per group; it follows options added or re-rendered later. */
export function radioKeys(group) {
  const items = () => [...group.querySelectorAll('[role="radio"]')].filter((b) => !b.disabled);
  const tabStops = () => {
    const list = items();
    const on = list.find((b) => b.getAttribute("aria-checked") === "true") || list[0];
    for (const b of list) b.tabIndex = b === on ? 0 : -1;
  };
  group.addEventListener("keydown", (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const n = list.length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = list[to % n];
    next.focus(); next.click();
  });
  group.addEventListener("click", () => setTimeout(tabStops));
  new MutationObserver(tabStops).observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked"] });
  tabStops();
}

/* ---------------------------------------------------------------- toasts */
/* Results answer at once. Success fades (4.5 s, or 8 s when it carries an
   action such as Undo); errors and warnings stay until dismissed. At most 3
   at a time. While a modal <dialog> is open the stack moves inside it, because
   the browser makes everything outside a modal unclickable.
   Needs <div class="toasts" id="toasts" aria-live="polite"></div> in the page. */
export function toast(message, { type = "info", detail, action, onAction, link, timeout } = {}) {
  const box = $("#toasts");
  const icon = { success: "check", error: "alert", warn: "alert", info: "info" }[type];
  const body = h("div", { class: "toast-body" }, h("p", { class: "toast-msg" }, message),
                 detail ? h("p", { class: "toast-detail" }, detail) : null);
  const el = h("div", { class: `toast toast-${type} is-entering`, role: type === "error" ? "alert" : "status" },
               icon ? ic(icon, "i toast-icon") : null, body);
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), reduceMotion() ? 0 : 180);
  };
  if (link) body.append(h("a", { class: "toast-link", href: link.href, target: "_blank", rel: "noopener" }, link.text));
  if (action) el.append(h("button", { type: "button", class: "toast-action", onclick: () => { close(); onAction && onAction(); } }, action));
  el.append(h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, ic("x")));
  el.lastElementChild.addEventListener("click", close);
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  const host = document.querySelector("dialog[open]") || document.body;
  if (box.parentElement !== host) host.append(box);
  const ms = timeout !== undefined ? timeout : (type === "error" || type === "warn") ? 0 : action ? 8000 : 4500;
  if (ms) setTimeout(close, ms);
  setTimeout(() => el.classList.remove("is-entering"), 400);
  return close;
}
/* A dialog closed (or is about to be removed): its toasts go back to the page, or to
   the next open dialog. Called directly before removing a dialog, because the
   "close" event alone can arrive late or after the element is gone. */
function rehomeToasts(dlg) {
  const box = document.getElementById("toasts");
  if (!box || !dlg.contains(box)) return;
  const host = [...document.querySelectorAll("dialog[open]")].find((d) => d !== dlg) || document.body;
  host.append(box);
}
document.addEventListener("close", (e) => { if (e.target.contains) rehomeToasts(e.target); }, true);

/* ---------------------------------------------------------------- button feedback */
/* busy(btn, true, "Saving…") → disabled, spinner in place of the icon, label says what's happening.
   busy(btn, false) restores it. The button's text must be in <span class="label">. */
export function busy(btn, on, text) {
  btn.disabled = on;
  btn.classList.toggle("is-busy", on);
  btn.setAttribute("aria-busy", String(on));
  // A button without an icon gets a spinner of its own while busy.
  if (on && !btn.querySelector(".i") && !btn.querySelector(".spinner.busy-spin"))
    btn.prepend(h("span", { class: "spinner busy-spin", "aria-hidden": "true" }));
  if (!on) btn.querySelectorAll(".spinner.busy-spin").forEach((s) => s.remove());
  const label = btn.querySelector(".label");
  if (label && on) { btn._label = btn._label || label.textContent; if (text) label.textContent = text; }
  if (label && !on && btn._label) { label.textContent = btn._label; btn._label = null; }
}

/* flashDone(btn, "Saved") → the button turns green with a check for 2 s, then restores. */
export function flashDone(btn, text, icon = "check", ms = 2000) {
  const label = btn.querySelector(".label"), ico = btn.querySelector(".i");
  if (!btn._orig) btn._orig = [label && label.textContent, ico && ico.innerHTML];
  if (label) label.textContent = text;
  if (ico) ico.innerHTML = ICONS[icon];
  btn.classList.add("is-done");
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    if (label) label.textContent = btn._orig[0];
    if (ico) ico.innerHTML = btn._orig[1];
    btn._orig = null;
    btn.classList.remove("is-done");
  }, ms);
}

/* popBadge(btn, "Copied!") → a small green bubble pops above the button. Add class "has-badge" to the button. */
export function popBadge(btn, text, ms = 1800) {
  const old = btn.querySelector(".pop-badge");
  if (old) old.remove();
  const el = h("span", { class: "pop-badge", role: "status" }, ic("check"), text);
  btn.append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

/* ---------------------------------------------------------------- clipboard */
export async function copyText(text, html) {
  try {
    if (html && navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }) })]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {}
  const ta = h("textarea", { style: "position:fixed;opacity:0;top:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  return ok;
}

/* An identifier (project code, request number, invoice number) you can click to copy.
   cls "code" gives the monospace chip; the default "copy" is a dotted underline. */
export function copyable(text, { label = "number", cls = "copy", empty } = {}) {
  text = String(text || "").trim();
  if (!text) return empty !== undefined ? empty : h("span", { class: "muted" }, "None");
  return h("button", { type: "button", class: cls, title: `Copy ${label}`, "aria-label": `Copy ${label} ${text}`,
    onclick: async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const ok = await copyText(text);
      toast(ok ? `Copied ${text}.` : `Couldn't copy. Select ${text} and copy it by hand.`,
            { type: ok ? "success" : "error", timeout: ok ? 2200 : 0 });
    } }, text);
}

/* ---------------------------------------------------------------- list motion */
/* Fold an element away so the ones below slide up instead of jumping; resolves when done. */
export function collapse(el, gap = 10) {
  if (!el || reduceMotion()) return Promise.resolve();
  el.style.height = `${el.getBoundingClientRect().height}px`;
  el.classList.add("is-collapsing");
  void el.offsetWidth;
  Object.assign(el.style, { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: `-${gap}px`,
                            borderWidth: "0px", opacity: "0", transform: "translateX(14px)" });
  return new Promise((r) => setTimeout(r, 230));
}

/* Highlight something that just arrived or just changed, and bring it into view. */
export function flash(el, { scroll = true } = {}) {
  if (!el) return;
  el.classList.remove("is-new");
  void el.offsetWidth;   // restart the animation
  el.classList.add("is-new");
  if (scroll) el.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
  setTimeout(() => el.classList.remove("is-new"), 3200);
}

/* ---------------------------------------------------------------- context menu */
/* openMenu([{ label, icon, onSelect, danger }, "-", …], { x, y, anchor })
   One menu at a time. Arrow keys, Home/End, Escape; closes on outside click,
   scroll, resize and navigation. Use it for both right-click and the ⋯ button. */
let menu = null;
export function closeMenu() {
  if (!menu) return;
  menu.el.remove();
  if (menu.anchor) menu.anchor.setAttribute("aria-expanded", "false");
  menu = null;
}
export function openMenu(items, { x, y, anchor } = {}) {
  if (anchor && menu && menu.anchor === anchor) { closeMenu(); return; }   // the ⋯ button toggles
  closeMenu();
  const el = h("div", { class: "ctx-menu", role: "menu" }, items.map((it) => it === "-" ? h("hr")
    : h("button", { type: "button", role: "menuitem", class: it.danger ? "danger" : null,
        onclick: () => { closeMenu(); it.onSelect && it.onSelect(); } }, it.icon ? ic(it.icon) : null, it.label)));
  document.body.append(el);
  if (anchor && x === undefined) { const r = anchor.getBoundingClientRect(); x = r.right - el.offsetWidth; y = r.bottom + 6; }
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  if (anchor) anchor.setAttribute("aria-expanded", "true");
  menu = { el, anchor };
  el.querySelector("button").focus();
  el.addEventListener("keydown", (e) => {
    const list = [...el.querySelectorAll("button")], i = list.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (go !== undefined) { e.preventDefault(); list[(go + list.length) % list.length].focus(); }
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeMenu(); anchor && anchor.focus(); }
  });
}
document.addEventListener("pointerdown", (e) => { if (menu && !menu.el.contains(e.target) && !(menu.anchor && menu.anchor.contains(e.target))) closeMenu(); }, true);
window.addEventListener("scroll", closeMenu, true);
window.addEventListener("resize", closeMenu);
window.addEventListener("hashchange", closeMenu);

/* ---------------------------------------------------------------- dialogs */
/* A generic sheet: shows a summary of what will happen, then runs `run`.
   confirmSheet({ title, sub, icon, body: Node, confirm: "Save to Lark", run: async () => {} })
   Resolves true if `run` finished, false if cancelled. Errors from `run` show
   inside the sheet (the sheet stays open so nothing typed is lost). */
export function confirmSheet({ title, sub, icon, body, confirm = "Confirm", busyText = "Working…", run, danger = false }) {
  return new Promise((resolve) => {
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const cancel = h("button", { type: "button", class: "btn btn-ghost" }, "Cancel");
    const go = h("button", { type: "submit", class: `btn ${danger ? "btn-danger" : "btn-primary"}` }, h("span", { class: "label" }, confirm));
    const form = h("form", { class: "modal-form", method: "dialog" },
      h("header", { class: "modal-head" }, icon ? h("div", { class: "modal-icon", "aria-hidden": "true" }, ic(icon)) : null,
        h("h2", null, title), sub ? h("p", { class: "modal-sub" }, sub) : null),
      body ? h("div", { class: "modal-body" }, body) : null,
      err,
      h("footer", { class: "modal-actions" }, cancel, go));
    const dlg = h("dialog", { class: `modal${danger ? " modal-danger" : ""}`, "aria-label": title }, form);
    document.body.append(dlg);
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); rehomeToasts(dlg); dlg.remove(); resolve(v); };
    cancel.addEventListener("click", () => finish(false));
    dlg.addEventListener("close", () => finish(false));   // closed from outside (e.g. the login ended)
    dlg.addEventListener("cancel", (e) => { if (go.disabled) e.preventDefault(); else finish(false); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg && !go.disabled) finish(false); });   // backdrop
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      busy(go, true, busyText);
      cancel.disabled = true;
      try { await (run ? run() : null); busy(go, false); finish(true); }
      catch (ex) { busy(go, false); cancel.disabled = false; err.textContent = ex.message || "That didn't work. Try again."; err.hidden = false; }
    });
    dlg.showModal();
    cancel.focus();   // the safe choice has focus
  });
}

/* Permanent delete: two confirmations. Step 1 shows the item's details; step 2
   asks "Are you absolutely sure?". Focus starts on Cancel each time, and the
   confirm button is locked for 900 ms after each step so a double-click can't
   skip one. Suggest the reversible alternative in `safer`.
   confirmDanger({ what: "Q3 Launch brief", details: [["Client","Acme"],…], consequence, safer, run }) */
export function confirmDanger({ what, details = [], consequence, safer, confirm2 = "Yes, delete permanently", busyText = "Deleting…", run }) {
  return new Promise((resolve) => {
    let stage = 1;
    const title = h("h2"), sub = h("p", { class: "modal-sub" });
    const list = h("dl", { class: "summary-list" }, details.flatMap(([k, v]) =>
      [h("dt", null, k), h("dd", { class: v ? null : "is-empty" }, v || "Not specified")]));
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const cancel = h("button", { type: "button", class: "btn btn-ghost" }, "Cancel");
    const go = h("button", { type: "submit", class: "btn btn-danger" }, h("span", { class: "label" }));
    const form = h("form", { class: "modal-form", method: "dialog" },
      h("header", { class: "modal-head" }, h("div", { class: "modal-icon", "aria-hidden": "true" }, ic("trash")), title, sub),
      h("div", { class: "modal-body" }, list), err, h("footer", { class: "modal-actions" }, cancel, go));
    const dlg = h("dialog", { class: "modal modal-danger" }, form);
    const paint = () => {
      title.textContent = stage === 1 ? `Delete “${what}”?` : "Are you absolutely sure?";
      sub.textContent = stage === 1 ? [consequence, safer].filter(Boolean).join(" ")
        : `“${what}” will be permanently deleted. This cannot be undone.`;
      list.hidden = stage !== 1;
      go.querySelector(".label").textContent = stage === 1 ? "Delete…" : confirm2;
    };
    const lock = () => { go.disabled = true; setTimeout(() => { go.disabled = false; }, 900); };
    document.body.append(dlg);
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); rehomeToasts(dlg); dlg.remove(); resolve(v); };
    const working = () => go.classList.contains("is-busy");
    cancel.addEventListener("click", () => finish(false));
    dlg.addEventListener("close", () => finish(false));   // closed from outside (e.g. the login ended)
    dlg.addEventListener("cancel", (e) => { if (working()) e.preventDefault(); else finish(false); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg && !working()) finish(false); });   // backdrop
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (stage === 1) { stage = 2; paint(); lock(); cancel.focus(); return; }
      busy(go, true, busyText);
      cancel.disabled = true;
      try { await run(); busy(go, false); finish(true); }
      catch (ex) { busy(go, false); cancel.disabled = false; err.textContent = ex.message || "Couldn't delete it. Try again."; err.hidden = false; }
    });
    paint();
    dlg.showModal();
    lock();
    cancel.focus();
  });
}

/* ---------------------------------------------------------------- delight (use sparingly) */
/* A burst of confetti from an element: once, for a real milestone (first save
   of a new record), never for routine actions. Skipped under reduced motion. */
export function confetti(fromEl, colors) {
  if (reduceMotion() || !fromEl || !fromEl.animate) return;
  const cs = getComputedStyle(document.documentElement);
  colors = colors || ["--brand", "--brand-text", "--ok", "--info"].map((t) => cs.getPropertyValue(t).trim());
  const r = fromEl.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < 42; i++) {
    const p = h("span", { class: "confetti" });
    Object.assign(p.style, { left: `${cx}px`, top: `${cy}px`, background: colors[i % colors.length],
                             width: `${6 + Math.random() * 6}px`, height: `${8 + Math.random() * 8}px` });
    document.body.append(p);
    const a = Math.random() * Math.PI * 2, d = 80 + Math.random() * 160;
    const dx = Math.cos(a) * d, dy = Math.sin(a) * d - 90, spin = (Math.random() - 0.5) * 900;
    p.animate([
      { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy}px)) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 180}px)) rotate(${spin}deg)`, opacity: 0 },
    ], { duration: 1100 + Math.random() * 600, easing: "cubic-bezier(.2,.7,.3,1)" }).onfinish = () => p.remove();
  }
}

/* ---------------------------------------------------------------- formats */
/* Dates are written "Oct 14, 2026" everywhere; money with two decimals and a
   currency in front; durations "1h 05m" / "12 min". Numbers use tabular figures (.num). */
export const fmt = {
  day: (ms) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""),
  time: (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
  money: (v, cur) => `${cur ? cur + " " : ""}${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  peso: (v) => "₱" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  short(v) {   // ₱1.2M style, for summaries only
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return Math.round(v / 1e3) + "K";
    return String(Math.round(v));
  },
  duration(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
  },
  relDays(ms) {   // "today", "tomorrow", "in 3 days", "2 days ago"
    const d = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
    return d === 0 ? "today" : d === 1 ? "tomorrow" : d === -1 ? "yesterday" : d > 0 ? `in ${d} days` : `${-d} days ago`;
  },
  plural: (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`,
};
