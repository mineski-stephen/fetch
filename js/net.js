/*
 * Networking for every service Fetch talks to (the Lark proxy and the extraction service).
 *
 * - Free Render services sleep when idle, so each one is woken on page load and before the
 *   login exchange, and Lark reads are retried while it starts. Writes are never retried.
 * - The Lark proxy has two addresses (SERVICES.lark.urls: Cloudflare, then Render). A read that
 *   can't reach the one in use moves to the other at once. A write is never resent anywhere:
 *   if the proxy in use hasn't answered lately it's checked (and maybe swapped) BEFORE sending,
 *   and a write that fails only makes the NEXT call check again.
 * - Awake means GET / answered with the service's own JSON (not Render's "starting" page).
 *   The answer is also checked for compatibility (version, allowed CORS headers).
 * - Two instant network failures while online almost always mean an ad blocker or privacy
 *   extension; that's counted per service and reported plainly with the host to allow.
 * - Failures are facts (LarkError); describe() turns them into sentences when shown.
 */
import { APP, SERVICES } from "./config.js";
import { cfg } from "./settings.js";
import { sleep } from "./ui.js";
import { LarkError, DEAD_TOKEN_CODES, describe as describeError, incompatible } from "./errors.js";

export { LarkError };

const PING_TIMEOUT_MS = 20000;        // per wake attempt
const WAKE_BUDGET_MS = 180000;        // give up after about 3 minutes
const SLOW_AFTER_MS = 1200;           // "Waking up" shows after this long without an answer
const BLOCKER_MS = 600;               // two failures faster than this while online: a blocker
const READ_TIMEOUT_MS = 60000;
const WRITE_TIMEOUT_MS = 120000;
const UPLOAD_TIMEOUT_MS = 180000;
const READ_WAITS = [1500, 3000, 6000, 12000, 20000];

export const isLocalPage = () => /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(location.hostname);
const hostOf = (url) => { try { return new URL(url).host; } catch (_) { return url || ""; } };

// ---- services ------------------------------------------------------------------------
/** One status object per service: state is unset | unknown | waking | awake | down | blocked | outdated.
 *  A service may have several addresses (`urls`, in order of preference: the Lark proxy runs on
 *  Cloudflare and on Render). It uses one at a time, url(), and moves to the next when that one
 *  can't be reached; status.backup says it's not on the first. */
export function createService({ id, label, urls, def, freshMs }) {
  const status = { state: "unknown", detail: "", version: "", info: {}, checkedAt: 0, backup: false };
  const listeners = new Set();
  const quickFails = new Map();   // address -> instant failures in a row
  const blocked = new Set();      // addresses this browser blocks
  let active = 0, waking = null;
  const set = (patch) => { Object.assign(status, patch); listeners.forEach((fn) => fn(status)); };
  const list = () => (urls() || []).map((u) => String(u || "").replace(/\/+$/, "")).filter(Boolean);
  const current = () => { const l = list(); if (active >= l.length) active = 0; return l[active] || ""; };
  const use = (i) => { active = i; status.backup = i > 0; };

  /** One GET / of one address: { r: "ok" | "retry" | "stop", state, detail, version, info }. */
  async function check(u) {
    const started = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(`${u}/`, { cache: "no-store", signal: ctl.signal });
      quickFails.set(u, 0);
      blocked.delete(u);
      if (res.status >= 400 && res.status < 500) return { r: "stop", state: "down", detail: `answered HTTP ${res.status}` };
      const info = res.ok && /json/.test(res.headers.get("content-type") || "") ? await res.json().catch(() => null) : null;
      if (!info) return { r: "retry" };                          // Render's "starting" page, or a 5xx
      if (def.service && info.service !== def.service) {
        return { r: "stop", state: "down", detail: "answered, but it isn't this service (check the address)" };
      }
      const problem = incompatible(info, def);
      return { r: "ok", state: problem ? "outdated" : "awake", detail: problem, version: String(info.version || ""), info };
    } catch (_) {
      return noteFailure(u, started) ? { r: "stop", state: "blocked", detail: "blocked by this browser" } : { r: "retry" };
    } finally {
      clearTimeout(timer);
    }
  }
  /** A request to `u` threw. Two instant ones in a row while online = this browser blocks it. True if blocked. */
  function noteFailure(u, startedAt) {
    if (performance.now() - startedAt < BLOCKER_MS && navigator.onLine !== false) {
      const n = (quickFails.get(u) || 0) + 1;
      quickFails.set(u, n);
      if (n >= 2) blocked.add(u);
    }
    return blocked.has(u);
  }

  const svc = {
    id, label, status, def,
    url: current,
    host: () => hostOf(current()),
    /** Every address's host, in order (the first is the usual one). */
    hosts: () => list().map(hostOf),
    /** The hosts this browser blocks (all of them, when the service is "blocked"). */
    blockedHosts: () => list().filter((u) => blocked.has(u)).map(hostOf),
    count: () => list().length,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    isFresh: () => status.state === "awake" && Date.now() - status.checkedAt < freshMs,
    isBlocked: () => status.state === "blocked",
    /** A request to the service worked: clears a blocked state, keeps it marked awake. */
    worked() {
      quickFails.set(current(), 0);
      blocked.delete(current());
      if (status.state !== "awake" && status.state !== "outdated") set({ state: "awake", detail: "", checkedAt: Date.now() });
      else status.checkedAt = Date.now();
    },
    /** A request to the service threw (not an HTTP error). If this browser blocks the address,
     *  the next one is used; with none left, the service is "blocked". */
    threw(startedAt) {
      if (!noteFailure(current(), startedAt)) return;
      if (!svc.failover()) set({ state: "blocked", detail: "blocked by this browser" });
    },
    /** Something failed: the next call checks the service again first (see wake). */
    suspect() { status.checkedAt = 0; },
    /** Move to the next address this browser doesn't block. True if there was one. The new one
     *  isn't known to be awake yet, so it counts as not fresh. */
    failover() {
      const l = list();
      for (let step = 1; step < l.length; step++) {
        const i = (active + step) % l.length;
        if (!blocked.has(l[i])) { use(i); set({ checkedAt: 0 }); return true; }
      }
      return false;
    },
    /** Wake the service: GET / of the address in use, then the others, until one answers, for
     *  about 3 minutes (2 s, backing off to 15 s). Resolves true once one is awake and
     *  compatible, and keeps using that one. One loop is shared by every caller. */
    wake({ force = false } = {}) {
      if (!list().length) { set({ state: "unset", detail: "" }); return Promise.resolve(false); }
      if (!force && svc.isFresh()) return Promise.resolve(true);
      if (waking) return waking;
      waking = (async () => {
        const until = Date.now() + WAKE_BUDGET_MS;
        const stopped = new Map();   // address -> why it won't answer (this wake)
        let wait = 2000;
        const slow = setTimeout(() => { if (status.state !== "awake") set({ state: "waking", detail: "" }); }, SLOW_AFTER_MS);
        try {
          for (;;) {
            const l = list();
            let outdated = null, retrying = false;
            for (let step = 0; step < l.length; step++) {
              const i = (active + step) % l.length;
              if (stopped.has(l[i])) continue;
              const c = await check(l[i]);
              if (c.r === "ok" && c.state === "awake") {
                use(i);
                set({ state: "awake", detail: "", version: c.version, info: c.info, checkedAt: Date.now() });
                return true;
              }
              if (c.r === "ok") outdated = outdated || { i, c };
              else if (c.r === "stop") stopped.set(l[i], c);
              else retrying = true;
            }
            // None awake. Out of date counts once nothing else might still wake up.
            if (outdated && !retrying) {
              use(outdated.i);
              const c = outdated.c;
              set({ state: "outdated", detail: c.detail, version: c.version, info: c.info, checkedAt: Date.now() });
              return false;
            }
            if (stopped.size >= l.length) {
              const why = [...stopped.values()];
              const all = why.every((c) => c.state === "blocked");
              const c = all ? { state: "blocked", detail: "blocked by this browser" } : why.find((x) => x.state !== "blocked");
              set({ state: c.state, detail: c.detail });
              return false;
            }
            if (Date.now() > until) { set({ state: "down", detail: "no answer for 3 minutes" }); return false; }
            set({ state: "waking", detail: "" });
            await sleep(wait);
            wait = Math.min(wait * 1.6, 15000);
          }
        } finally {
          clearTimeout(slow);
          waking = null;
        }
      })();
      return waking;
    },
  };
  return svc;
}

export const larkService = createService({ id: "lark", label: "Connection service", def: SERVICES.lark, freshMs: 60000,
  urls: () => cfg().larkUrls });
export const geminiService = createService({ id: "gemini", label: "Extraction service", def: SERVICES.gemini, freshMs: 4 * 60000,
  urls: () => [cfg().geminiUrl] });
export const services = [larkService, geminiService];

/** Subscribe to every service's status changes. */
export const onAnyService = (fn) => { const offs = services.map((s) => s.on(fn)); return () => offs.forEach((off) => off()); };

/** The hosts of every service the browser is blocking. */
export const blockedHosts = () => services.flatMap((s) => (s.isBlocked() ? s.blockedHosts() : []));

/** One plain sentence for a failure, with what the page knows about the services. */
export const describe = (err, extra = {}) => describeError(err,
  { app: APP.name, host: larkService.host(), blocked: blockedHosts(), redirect: extra.redirect, deleting: extra.deleting });

export const viaProxy = (url) => `${larkService.url()}/proxy?url=${encodeURIComponent(url)}`;

// ---- Lark calls ---------------------------------------------------------------------------
let onDeadToken = null;
/** auth.js registers what happens when Lark says the login is dead (it ends the session). */
export const setDeadTokenHandler = (fn) => { onDeadToken = fn; };

async function send(service, url, init, timeout) {
  const started = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    service.worked();
    return res;
  } catch (e) {
    service.threw(started);
    service.suspect();   // the next call checks the service (and may move to its other address) first
    throw new LarkError(ctl.signal.aborted ? "no answer in time" : e.message, { network: true, timedOut: ctl.signal.aborted });
  } finally {
    clearTimeout(timer);
  }
}

/** One Lark call through the proxy. Resolves with the JSON body; throws LarkError carrying
 *  {network | status, json | raw}. Reads (`read`) are retried while the proxy wakes up and after
 *  a rate limit. Writes are never retried: if one may have landed (a network error or timeout
 *  after it left) the error says so (`uncertain`). `write` marks a call that changes the table
 *  (120 s, never retried); `timeout` overrides the default for the kind. */
export async function lark(method, url, { token, body, read = false, write = false, timeout = 0 } = {}) {
  const init = { method, headers: {}, cache: "no-store" };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body || {});
  }
  const ms = timeout || (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
  const waits = read ? READ_WAITS : [];
  if (!read) await ready();   // sent once, to one proxy: make sure of it before sending
  let hops = 0;               // a read's moves to the other proxy during this call
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await send(larkService, viaProxy(url), init, ms);
    } catch (e) {
      if (!read) {
        if (write && !larkService.isBlocked()) e.uncertain = true;   // it may have landed: never resent
        throw e;
      }
      if (hops < larkService.count() - 1 && larkService.failover()) { hops++; continue; }   // the other proxy, at once
      if (larkService.isBlocked() || attempt >= waits.length) throw e;
      await sleep(waits[attempt]);
      continue;
    }
    if (read && [502, 503, 504].includes(res.status)) {
      if (hops < larkService.count() - 1 && larkService.failover()) { hops++; continue; }
      if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (!json || typeof json !== "object") {
      throw new LarkError(`HTTP ${res.status}, not JSON`, { status: res.status, raw: text.slice(0, 2000) });
    }
    // Lark reports failures in the body (code != 0); bodies without a code are the proxy's own.
    const ok = json.code !== undefined ? Number(json.code) === 0 : !json.error;
    if (ok) return json;
    const code = Number(json.code);
    if (read && [1254290, 99991400].includes(code) && attempt < 2) { await sleep(1200); continue; }
    if (token && DEAD_TOKEN_CODES.includes(code) && onDeadToken) onDeadToken();
    throw new LarkError("Lark error", { status: res.status, json, deadToken: !!token && DEAD_TOKEN_CODES.includes(code) });
  }
}

/** Before anything that is sent only once (a write, an upload, the login exchange): if the proxy
 *  in use hasn't answered lately, check it, or find the other one, first. Nothing has been sent
 *  yet, so moving to the other proxy here can never send anything twice. */
async function ready() {
  if (larkService.isFresh()) return;
  if (!await larkService.wake()) throw new LarkError("connection service unreachable", { network: true });
}

/** Upload a multipart form to Lark through the proxy (media upload). Resolves with Lark's JSON. */
export async function larkUpload(url, form, { token, timeout = UPLOAD_TIMEOUT_MS } = {}) {
  await ready();
  const res = await send(larkService, viaProxy(url), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, cache: "no-store" }, timeout);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!json || typeof json !== "object") {
    throw new LarkError(`HTTP ${res.status}, not JSON`, { status: res.status, raw: text.slice(0, 2000) });
  }
  const code = Number(json.code);
  if (token && DEAD_TOKEN_CODES.includes(code) && onDeadToken) onDeadToken();
  return { json, status: res.status };
}

/**
 * Download a file's bytes from Lark through the proxy (it passes them through as they are).
 * Resolves with a Blob; a JSON answer instead of a file is Lark (or the proxy) refusing.
 */
export async function larkDownload(url, { token, timeout = UPLOAD_TIMEOUT_MS } = {}) {
  const get = () => send(larkService, viaProxy(url), { method: "GET", headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }, timeout);
  let res;
  try {
    res = await get();
  } catch (e) {
    if (!larkService.failover()) throw e;   // a read: once more through the other proxy
    res = await get();
  }
  const type = res.headers.get("content-type") || "";
  if (res.ok && !/json/i.test(type)) return res.blob();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  const code = Number(json && json.code);
  if (token && DEAD_TOKEN_CODES.includes(code) && onDeadToken) onDeadToken();
  throw new LarkError(json ? "Lark error" : `HTTP ${res.status}, not a file`,
    { status: res.status, json: json || undefined, raw: json ? undefined : text.slice(0, 2000), deadToken: !!token && DEAD_TOKEN_CODES.includes(code) });
}
