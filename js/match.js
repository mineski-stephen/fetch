/*
 * Finding Gemini's quote in a source document ("Check sources"). Pure functions: no DOM.
 *
 * A document is a list of units (a PDF text item, an OCR word, or a whole text file),
 * each with its own text. buildIndex() turns them into one normalised search string
 * with a map from every character back to (unit, offset), so a match can be drawn as
 * boxes over the page or as a <mark> in text. Adapted from tech/ocr demo (buildIndex,
 * rectsFor), plus tolerance for reworded quotes and OCR typos.
 *
 * Normalising: accents and case are dropped, every run of punctuation or spaces is
 * one separator, and separators between two digits ("3,500,000" = "3 500 000") or
 * between two characters of a script written without spaces (CJK, Thai) are dropped.
 */

// Scripts written without spaces between words (CJK, Thai, Lao, Khmer, Burmese, Tibetan).
const NOSPACE = /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-໿က-႟ក-៿ༀ-࿿]/;
const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;

// Separators that may sit inside a number ("3,500,000", "3 500 000", "1.200.000"); a hyphen or slash
// between digits is a range or a date ("22-35", "8/8") and stays a separator.
const SOFT = /[\s,.'   ]/u;
const GAP = "\u0001";   // a soft separator, until the second pass decides

/** One character, normalised: "" for marks, a separator for anything that isn't a letter or digit. */
function normChar(c) {
  const k = c.normalize("NFKC");
  // Accents go (é = e), but not kana voicing marks (ビ ≠ ヒ) or Thai vowels.
  const out = (NOSPACE.test(k) ? k : k.normalize("NFKD").replace(/\p{M}/gu, "")).toLowerCase();
  return [...out].map((x) => (WORD.test(x) ? x : SOFT.test(x) ? GAP : " ")).join("");
}

const isSep = (ch) => ch === " " || ch === GAP;

/** A soft separator goes between two digits; any separator goes between two no-space-script characters. */
const dropGap = (gap, a, b) => (gap === GAP && DIGIT.test(a) && DIGIT.test(b)) || (NOSPACE.test(a) && NOSPACE.test(b));

/**
 * Normalise a list of units into { hay, unit: Int32Array, off: Int32Array, units }.
 * unit[i] / off[i] say where hay[i] came from (-1 for a separator added between units).
 */
export function buildIndex(units) {
  const chars = [], unitOf = [], offOf = [];
  const push = (ch, u, o) => {
    const last = chars.length - 1;
    if (isSep(ch)) {
      if (last < 0) return;
      if (isSep(chars[last])) {   // a run of 2+ separators ("35, 8") is never inside a number
        chars[last] = " ";
        return;
      }
    }
    chars.push(ch); unitOf.push(u); offOf.push(o);
  };
  units.forEach((u, ui) => {
    const text = String(u.text ?? "");
    if (ui > 0 && !u.glue) push(GAP, ui, -1);   // glue: continues the previous unit (a kerned PDF word)
    let o = 0;
    for (const c of text) {
      for (const n of normChar(c)) push(n, ui, o);
      o += c.length;
    }
  });
  // Second pass: drop separators inside numbers and no-space scripts; the rest become one space.
  const hay = [], unit = [], off = [];
  for (let i = 0; i < chars.length; i++) {
    if (isSep(chars[i]) && (i === chars.length - 1 || dropGap(chars[i], chars[i - 1], chars[i + 1]))) continue;
    hay.push(isSep(chars[i]) ? " " : chars[i]); unit.push(unitOf[i]); off.push(offOf[i]);
  }
  return { hay: hay.join(""), unit: Int32Array.from(unit), off: Int32Array.from(off), units };
}

/** Normalise free text (a quote, a field value) the same way as a document. */
export const norm = (text) => buildIndex([{ text }]).hay;

// ---- fuzzy matching ---------------------------------------------------------

/** Edit distance, stopping early once it exceeds `max`. */
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** Two tokens are the same if equal, or (5+ characters) one typo apart: OCR 0/O, l/1. */
const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && within(a, b, 1));

/** Tokens of a normalised string with their start positions. */
function tokens(hay) {
  const out = [];
  const re = /[^ ]+/g;
  let m;
  while ((m = re.exec(hay))) out.push({ t: m[0], at: m.index });
  return out;
}

/** Longest common subsequence of q (tokens) inside w (tokens): count + first/last matched w index. */
function lcs(q, w) {
  const n = q.length, m = w.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = same(q[i - 1], w[j - 1].t) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = n, j = m, first = -1, last = -1;
  while (i > 0 && j > 0) {
    if (same(q[i - 1], w[j - 1].t) && dp[i][j] === dp[i - 1][j - 1] + 1) {
      if (last < 0) last = j - 1;
      first = j - 1; i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return { count: dp[n][m], first, last };
}

/**
 * Find a quote in an index. Returns { start, end, score, exact } (hay positions,
 * end exclusive) or null when nothing scores at least `min` (share of quote words found).
 */
export function find(index, quote, { min = 0.75 } = {}) {
  const q = norm(quote);
  if (!q || !index.hay) return null;
  const at = index.hay.indexOf(q);
  if (at >= 0) return { start: at, end: at + q.length, score: 1, exact: true };

  const qt = q.split(" ");
  if (qt.length < 2) {   // one word: allow a typo, nothing looser
    const hit = tokens(index.hay).find((x) => same(qt[0], x.t));
    return hit ? { start: hit.at, end: hit.at + hit.t.length, score: 0.9, exact: false } : null;
  }
  const ht = tokens(index.hay);
  // Vote for where the quote would start, from every quote word (3+ characters) found.
  const votes = new Map();
  qt.forEach((t, i) => {
    if (t.length < 3) return;
    ht.forEach((h, j) => { if (same(t, h.t)) votes.set(j - i, (votes.get(j - i) || 0) + 1); });
  });
  const starts = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s]) => s);
  let best = null;
  const pad = Math.ceil(qt.length / 2);
  for (const s of starts) {
    const from = Math.max(0, s - pad), win = ht.slice(from, Math.min(ht.length, s + qt.length + pad));
    const r = lcs(qt, win);
    const score = r.count / qt.length;
    if (r.count && (!best || score > best.score)) {
      best = { start: win[r.first].at, end: win[r.last].at + win[r.last].t.length, score, exact: false };
    }
  }
  return best && best.score >= min ? best : null;
}

// ---- mapping a match back to the document ---------------------------------------

/** The units a match covers: [{ unit, from, to }] (character offsets in the unit's text, to exclusive). */
export function spanUnits(index, span) {
  const out = [];
  for (let i = span.start; i < span.end; i++) {
    const u = index.unit[i], o = index.off[i];
    if (o < 0 || index.hay[i] === " ") continue;   // separators: don't box a trailing colon or space
    const last = out[out.length - 1];
    if (last && last.unit === u) last.to = Math.max(last.to, o + 1);
    else out.push({ unit: u, from: o, to: o + 1 });
  }
  // A typo-tolerant match may end mid-character of a surrogate pair or ligature: extend to whole characters.
  for (const p of out) {
    const text = String(index.units[p.unit].text ?? "");
    while (p.to < text.length && /[\udc00-\udfff\p{M}]/u.test(text[p.to])) p.to++;
  }
  return out;
}

/**
 * Highlight boxes for a match over units that have boxes ({x0, y0, x1, y1, line?}).
 * Part of a unit is sliced by character share; neighbours on the same line merge into one box.
 */
export function rects(index, span) {
  const out = [];
  for (const p of spanUnits(index, span)) {
    const u = index.units[p.unit], len = Math.max(1, String(u.text ?? "").length), w = u.x1 - u.x0;
    const box = { x0: u.x0 + (w * p.from) / len, x1: u.x0 + (w * p.to) / len, y0: u.y0, y1: u.y1,
      line: u.line ?? null, unit: p.unit };
    const last = out[out.length - 1];
    const sameLine = last && (box.line !== null ? last.line === box.line
      : Math.abs((last.y0 + last.y1) / 2 - (box.y0 + box.y1) / 2) < (box.y1 - box.y0) / 2);
    if (last && sameLine && box.x0 >= last.x0 - 1) {
      last.x1 = Math.max(last.x1, box.x1); last.y0 = Math.min(last.y0, box.y0); last.y1 = Math.max(last.y1, box.y1);
    } else out.push(box);
  }
  return out.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/** Pages to search for a quote Gemini placed on `page` (1-based; 0 = unknown): that page, its neighbours, the rest. */
export function pageOrder(page, count) {
  const all = Array.from({ length: count }, (_, i) => i + 1);
  if (!(page >= 1 && page <= count)) return all;
  const first = [page, page - 1, page + 1].filter((p) => p >= 1 && p <= count);
  return [...first, ...all.filter((p) => !first.includes(p))];
}
