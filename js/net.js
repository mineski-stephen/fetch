/*
 * Networking for every service Fetch talks to (the Lark proxy and the extraction service).
 *
 * - Free Render services sleep when idle, so each one is woken on page load and before the
 *   login exchange, and Lark reads are retried while it starts. Writes are never retried.
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
/** One status object per service: state is unset | unknown | waking | awake | down | blocked | outdated. */
export function createService({ id, label, url, def, freshMs }) {
  const status = { state: "unknown", detail: "", version: "", info: {}, checkedAt: 0 };
  const listeners = new Set();
  let quickFails = 0, waking = null;
  const set = (patch) => { Object.assign(status, patch); listeners.forEach((fn) => fn(status)); };

  const svc = {
    id, label, status, def,
    url: () => (url() || "").replace(/\/+$/, ""),
    host: () => hostOf(url()),
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    isFresh: () => status.state === "awake" && Date.now() - status.checkedAt < freshMs,
    isBlocked: () => status.state === "blocked",
    /** A request to the service worked: clears a blocked state, keeps it marked awake. */
    worked() {
      quickFails = 0;
      if (status.state !== "awake" && status.state !== "outdated") set({ state: "awake", detail: "", checkedAt: Date.now() });
      else status.checkedAt = Date.now();
    },
    /** A request to the service threw (not an HTTP error). Two quick ones while online = a blocker. */
    threw(startedAt) {
      if (performance.now() - startedAt < BLOCKER_MS && navigator.onLine !== false && ++quickFails >= 2) {
        set({ state: "blocked", detail: "blocked by this browser" });
      }
    },
    /** One check of GET /. Resolves "ok", "retry" (not ready yet) or "stop" (retrying won't help). */
    async ping() {
      const started = performance.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
      try {
        const res = await fetch(`${svc.url()}/`, { cache: "no-store", signal: ctl.signal });
        quickFails = 0;
        if (res.status >= 400 && res.status < 500) { set({ state: "down", detail: `answered HTTP ${res.status}` }); return "stop"; }
        const info = res.ok && /json/.test(res.headers.get("content-type") || "") ? await res.json().catch(() => null) : null;
        if (!info) return "retry";                                 // Render's "starting" page, or a 5xx
        if (def.service && info.service !== def.service) {
          set({ state: "down", detail: "answered, but it isn't this service (check the address)" });
          return "stop";
        }
        const problem = incompatible(info, def);
        set({ state: problem ? "outdated" : "awake", detail: problem, version: String(info.version || ""), info, checkedAt: Date.now() });
        return "ok";
      } catch (_) {
        svc.threw(started);
        return status.state === "blocked" ? "stop" : "retry";
      } finally {
        clearTimeout(timer);
      }
    },
    /** Wake the service: ping until it answers, for about 3 minutes (2 s, backing off to 15 s).
     *  Resolves true once it's awake and compatible. One loop is shared by every caller. */
    wake({ force = false } = {}) {
      if (!svc.url()) { set({ state: "unset", detail: "" }); return Promise.resolve(false); }
      if (!force && svc.isFresh()) return Promise.resolve(true);
      if (waking) return waking;
      waking = (async () => {
        const until = Date.now() + WAKE_BUDGET_MS;
        let wait = 2000;
        const slow = setTimeout(() => { if (status.state !== "awake") set({ state: "waking", detail: "" }); }, SLOW_AFTER_MS);
        try {
          for (;;) {
            const r = await svc.ping();
            if (r === "ok") return status.state === "awake";
            if (r === "stop") return false;
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
  url: () => cfg().larkUrl });
export const geminiService = createService({ id: "gemini", label: "Extraction service", def: SERVICES.gemini, freshMs: 4 * 60000,
  url: () => cfg().geminiUrl });
export const services = [larkService, geminiService];

/** Subscribe to every service's status changes. */
export const onAnyService = (fn) => { const offs = services.map((s) => s.on(fn)); return () => offs.forEach((off) => off()); };

/** The hosts of every service the browser is blocking. */
export const blockedHosts = () => services.filter((s) => s.isBlocked()).map((s) => s.host());

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
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await send(larkService, viaProxy(url), init, ms);
    } catch (e) {
      if (write && !larkService.isBlocked()) e.uncertain = true;
      if (larkService.isBlocked() || attempt >= waits.length) throw e;
      await sleep(waits[attempt]);
      continue;
    }
    if ([502, 503, 504].includes(res.status) && attempt < waits.length) {
      await sleep(waits[attempt]);
      continue;
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

/** Upload a multipart form to Lark through the proxy (media upload). Resolves with Lark's JSON. */
export async function larkUpload(url, form, { token, timeout = UPLOAD_TIMEOUT_MS } = {}) {
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
