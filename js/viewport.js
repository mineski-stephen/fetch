/*
 * A pan-and-zoom viewport for one page (a PDF page, an image, or a block of text).
 *
 * No scroll bars: the mouse wheel (or a two-finger pinch) zooms around the pointer,
 * dragging pans, and the keyboard works too when the box has focus (+ / - zoom,
 * arrows pan, 0 fits the width). fitRect() zooms so a passage fills the box's width.
 *
 * The page is a `content` element laid out at its natural CSS size (w x h) and moved
 * with a CSS transform; `onZoom(scale)` fires (debounced) so a caller can redraw a
 * canvas sharper for the new scale. A tap that isn't a drag still clicks what's under it.
 */

const MAX_SCALE = 6;
const DRAG_PX = 4;   // movement before a press becomes a drag (a smaller one is a click)

/** Make `box` a viewport. Returns { set, zoomBy, fitRect, fitWidth, scale, onChange }. */
export function panZoom(box, { onZoom } = {}) {
  let content = null, W = 1, H = 1, s = 1, x = 0, y = 0;
  let listeners = [], zoomTimer = null;
  const pointers = new Map();
  let drag = null, pinch = null;

  box.classList.add("pz");
  box.tabIndex = 0;

  const fit = () => box.clientWidth / W;              // the scale at which the page fills the width
  const minScale = () => Math.min(fit(), box.clientHeight / H) * 0.5;

  function clamp() {
    const bw = box.clientWidth, bh = box.clientHeight, cw = W * s, ch = H * s, m = 48;
    x = cw <= bw ? (bw - cw) / 2 : Math.min(m, Math.max(bw - cw - m, x));
    y = ch <= bh ? Math.max(0, Math.min(y, bh - ch)) : Math.min(m, Math.max(bh - ch - m, y));
  }

  function apply(zoomed) {
    clamp();
    if (content) content.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    listeners.forEach((fn) => fn(s));
    if (zoomed && onZoom) {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => onZoom(s), 180);
    }
  }

  /** Zoom to scale `ns`, keeping the point (cx, cy) of the box where it is. */
  function zoomAt(ns, cx = box.clientWidth / 2, cy = box.clientHeight / 2) {
    ns = Math.max(minScale(), Math.min(MAX_SCALE, ns));
    x = cx - ((cx - x) * ns) / s;
    y = cy - ((cy - y) * ns) / s;
    s = ns;
    apply(true);
  }

  const local = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  box.addEventListener("wheel", (e) => {
    if (!content) return;
    e.preventDefault();
    const [cx, cy] = local(e);
    zoomAt(s * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)), cx, cy);
  }, { passive: false });

  box.addEventListener("pointerdown", (e) => {
    if (!content || e.button > 0) return;
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) drag = { id: e.pointerId, start: local(e), x, y, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s };
      drag = null;
    }
  });
  box.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomAt(pinch.s * ((Math.hypot(a[0] - b[0], a[1] - b[1]) || 1) / pinch.d), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (drag && drag.id === e.pointerId) {
      const [px, py] = local(e);
      if (!drag.moved && Math.hypot(px - drag.start[0], py - drag.start[1]) < DRAG_PX) return;
      if (!drag.moved) { drag.moved = true; box.setPointerCapture(e.pointerId); box.classList.add("is-dragging"); }
      x = drag.x + px - drag.start[0];
      y = drag.y + py - drag.start[1];
      apply(false);
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag?.id === e.pointerId) {
      if (drag.moved) box.addEventListener("click", (c) => { c.stopPropagation(); c.preventDefault(); }, { capture: true, once: true });
      drag = null;
      box.classList.remove("is-dragging");
    }
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);

  box.addEventListener("keydown", (e) => {
    if (!content || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = 60;
    const keys = {
      "+": () => zoomAt(s * 1.25), "=": () => zoomAt(s * 1.25), "-": () => zoomAt(s / 1.25), 0: () => fitWidth(),
      ArrowLeft: () => { x += step; apply(false); }, ArrowRight: () => { x -= step; apply(false); },
      ArrowUp: () => { y += step; apply(false); }, ArrowDown: () => { y -= step; apply(false); },
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  new ResizeObserver(() => content && apply(false)).observe(box);

  /** Fill the box's width with the page, top first. */
  function fitWidth() {
    s = fit();
    x = 0;
    y = 0;
    apply(true);
  }

  /**
   * Zoom so the rectangle {x0, y0, x1, y1} (in the page's CSS px) fills the box's width,
   * centred; a tall one is fitted to the height instead. Never zooms out past the page width.
   */
  function fitRect(r, pad = 14) {
    const bw = box.clientWidth, bh = box.clientHeight;
    const byWidth = (bw - pad * 2) / Math.max(1, r.x1 - r.x0);
    const byHeight = (bh - pad * 2) / Math.max(1, r.y1 - r.y0);
    s = Math.max(Math.min(fit(), MAX_SCALE), Math.min(MAX_SCALE, byWidth, byHeight));
    x = bw / 2 - ((r.x0 + r.x1) / 2) * s;
    y = bh / 2 - ((r.y0 + r.y1) / 2) * s;
    apply(true);
  }

  /** Show a new page (`el`, natural size w x h). keepView keeps the current zoom and position. */
  function set(el, w, h, { keepView = false } = {}) {
    if (content && content !== el) content.remove();
    content = el;
    W = Math.max(1, w);
    H = Math.max(1, h);
    el.classList.add("pz-content");
    el.style.width = `${W}px`;
    el.style.height = `${H}px`;
    if (el.parentNode !== box) box.append(el);
    if (keepView) apply(false);
    else fitWidth();
  }

  return {
    set, fitRect, fitWidth,
    zoomBy: (f) => zoomAt(s * f),
    scale: () => s,
    onChange: (fn) => { listeners.push(fn); },
  };
}
