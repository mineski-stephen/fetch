/*
 * Lark login: OAuth 2.0 + PKCE, the same flow as Polaris, Suppliers and tech/lark-user-login.
 *
 *   1. "Log in with Lark" sends the browser to Lark's authorize page with a PKCE
 *      challenge and a random state (both kept in this tab's sessionStorage).
 *   2. Lark sends the user back here with ?code=…&state=…. The code is removed from the
 *      address bar at once, the Lark proxy is woken, and the code is swapped for a
 *      user_access_token through it (the proxy adds the app secret). Once, 45 s, never retried.
 *   3. The token is shared by every Mineski tool on this site (js/session.js): log in to Fetch,
 *      Polaris or Suppliers and you're logged in to all three, in every tab, with one timer.
 *      Every Lark call, plus every brief sent to the extraction service, runs as that person.
 *      Lark gives about 2 hours and no refresh token, so after that the user logs in again.
 *
 * The page's own address is the redirect URL, so it must be registered on the Lark app
 * (Security Settings > Redirect URLs). redirectProblem() checks this.
 *
 * The session clock lives here too: it ticks every 20 s, warns 5 minutes before the end,
 * ends the session on time (but never under a running write: see track()) and tells the
 * app through onEnded(). A change made in another tab or tool arrives through onShared().
 */
import { LARK } from "./config.js";
import { larkService, lark, viaProxy, setDeadTokenHandler, describe } from "./net.js";
import { LarkError } from "./errors.js";
import { store, recall, toast, fmt } from "./ui.js";
import * as shared from "./session.js";

// Lark returns to this page's own address (minus query, hash and index.html).
export const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html?$/i, "");
const PENDING_KEY = "fetch.auth.pending";   // sessionStorage: a login in progress finishes in the tab that started it
const PENDING_MAX_MS = 10 * 60 * 1000;
const RETURN_TO = /^#\/[\w\-/%.]*$/;
const ENDED = "Your login ended after about 2 hours. Log in again to keep going.";
const ENDED_ELSEWHERE = "Your login ended in another tab. Log in again to keep going.";

// A login this tab kept for itself before logins were shared moves to the shared one.
shared.adopt("fetch");

// ---- the session ------------------------------------------------------------
// memo: the last login this tab saw. Work already running (track) finishes with it, even if
// another tab logs out meanwhile (Lark still accepts the token until it really expires).
let memo = null;
const raw = () => { const t = shared.readToken(); if (t) memo = t; return t; };
// seen: the login this tab last acted on (at load, its own login, or a change it heard). Only those
// move it, never a plain read, so a read between another tab's write and its event can't hide it.
let seen = shared.readToken();
/** The token, if it has more than 30 s left (for new work). */
export function currentToken() {
  const t = raw();
  return shared.isLive(t) ? t : null;
}
/** The token for work already running (inside track()): good until its real expiry. */
export function workToken() {
  const t = raw() || (inflight ? memo : null);
  return t && t.expires_at > Date.now() ? t : null;
}
export const token = () => (currentToken() || {}).access_token || "";
export const hadSession = () => !!raw();
export const msLeft = () => { const t = raw(); return t ? Math.max(0, t.expires_at - Date.now()) : 0; };
export const endsAt = () => { const t = raw(); return t ? t.expires_at : 0; };
/** Writing needs bitable:app (an empty scope means Lark didn't say, so let Lark decide). */
export function canWrite() {
  const t = currentToken();
  return !!t && (!t.scope || t.scope.split(" ").includes("bitable:app"));
}
/** Forget the login: in every Mineski tool and tab (they share it). */
export function clearSession() {
  shared.clear();
  memo = seen = null;
}

// ---- when a login ends ------------------------------------------------------------
const endedListeners = new Set();
/** Subscribe to the session ending (expired, logged out, or Lark refused the token): fn(message, { elsewhere }).
 *  elsewhere: another tab or tool ended it early (Log out there, or Lark refused it there). */
export const onEnded = (fn) => { endedListeners.add(fn); return () => endedListeners.delete(fn); };
let warned = false, closeWarning = null;
function resetWarning() {
  warned = false;
  if (closeWarning) closeWarning();
  closeWarning = null;
}

/** The login is over: clear it (here and in every other tab) and tell the app (it shows the login screen). */
export function end(message, { elsewhere = false } = {}) {
  clearSession();
  resetWarning();
  endedListeners.forEach((fn) => fn(message, { elsewhere }));
}
/** Log out: of every Mineski tool in this browser, since they share the login. Local only
 *  (Lark has no revoke call). */
export const logout = () => end("You've logged out of every Mineski tool in this browser. You're still logged in to Lark itself.");
// Lark said the token is dead: end the session here, once, for every call site.
setDeadTokenHandler(() => { if (hadSession()) end("Your login ended. Log in again to keep going."); });

// ---- the login shared with the other tabs and tools ------------------------------------
const sharedListeners = new Set();
/** Subscribe to another tab or tool logging in or renewing the login: fn({ renewed }).
 *  renewed: this tab was already logged in (only the time left and maybe the person changed). */
export const onShared = (fn) => { sharedListeners.add(fn); return () => sharedListeners.delete(fn); };
let endAfterWork = null;
shared.onChange((t) => {
  const before = seen;
  if (shared.isLive(t)) {
    seen = memo = t;
    if (before && before.access_token === t.access_token) return;
    endAfterWork = null;   // logged in again before running work settled: nothing to end any more
    resetWarning();        // a fresh 2 hours: the "ends at" warning no longer applies
    sharedListeners.forEach((fn) => fn({ renewed: shared.isLive(before) }));
    return;
  }
  seen = null;
  if (!before) return;   // this tab wasn't logged in: nothing to end
  const elsewhere = before.expires_at > Date.now() + 30000;   // ended early, so not by the clock
  const message = elsewhere ? ENDED_ELSEWHERE : ENDED;
  if (inflight) { endAfterWork = { message, elsewhere }; return; }   // a running write finishes first (with memo)
  end(message);
});

// ---- before and after Lark's page --------------------------------------------------
const beforeLogin = new Set();
/** Register what to save before the browser leaves for Lark (in-memory edits go to sessionStorage). */
export const onBeforeLogin = (fn) => { beforeLogin.add(fn); return () => beforeLogin.delete(fn); };

function b64url(bytes) {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send the browser to Lark. `returnTo` (a #/route) is restored after login. */
export async function startLogin(returnTo) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error("Logging in needs https (or http://127.0.0.1). Open Fetch from its normal address.");
  }
  // PKCE: the proxy adds the app secret for anyone, so the verifier is what stops
  // an intercepted login code from being used by someone else.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const back = RETURN_TO.test(returnTo || "") ? returnTo : "";
  if (!store("session", PENDING_KEY, { state, verifier, returnTo: back, createdAt: Date.now() })) {
    throw new Error("This browser is blocking site storage, so the login can't finish. Allow it for this site.");
  }
  beforeLogin.forEach((fn) => { try { fn(); } catch (_) { /* a failed save must not stop the login */ } });
  const q = new URLSearchParams({
    client_id: LARK.appId, redirect_uri: REDIRECT_URI, scope: LARK.scopes, state,
    code_challenge: b64url(new Uint8Array(digest)), code_challenge_method: "S256",
  });
  location.assign(`${LARK.authorize}?${q.toString().replace(/\+/g, "%20")}`);
}

/** Handle Lark's redirect back (?code=…&state=… or ?error=…). Resolves null when this isn't a
 *  redirect, else { ok, returnTo, message? }. The code is taken out of the address bar before
 *  anything is awaited, so it can't linger in history or be shared. */
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return null;
  const pending = recall("session", PENDING_KEY);
  store("session", PENDING_KEY, undefined);
  const returnTo = RETURN_TO.test((pending && pending.returnTo) || "") ? pending.returnTo : "";
  history.replaceState(null, "", location.pathname + (returnTo || "#/"));

  if (params.has("error")) {
    return { ok: false, returnTo, message: params.get("error") === "access_denied"
      ? "Login cancelled. Fetch needs your OK on Lark's page to read and save briefs."
      : `Lark couldn't log you in (${params.get("error_description") || params.get("error")}). Try again.` };
  }
  if (!pending || pending.state !== params.get("state")) {
    return { ok: false, returnTo, message: "That login started in another tab. Log in again here." };
  }
  if (!(Date.now() - (Number(pending.createdAt) || 0) < PENDING_MAX_MS)) {
    return { ok: false, returnTo, message: "That login took too long. Log in again." };
  }
  try {
    // The proxy may have fallen asleep while the person was on Lark's page: wait for it first
    // (the busy screen says so), then give the exchange a time limit so a stuck connection ends
    // in a message instead of an endless spinner. The code is single-use: never retried.
    if (!await larkService.wake()) throw new LarkError("connection service unreachable", { network: true });
    const j = await lark("POST", `${LARK.api}/authen/v2/oauth/token`, { timeout: 45000, body: {
      grant_type: "authorization_code",
      client_id: LARK.appId,             // no client_secret: the proxy adds it
      code: params.get("code"),
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    } });
    if (!j.access_token) throw new LarkError("no access_token in response", { json: j });
    shared.writeUser(undefined);   // another account may be logging in: never keep the old name and picture
    const t = { access_token: j.access_token, scope: j.scope || "", expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000 };
    shared.writeToken(t);          // every other open tab of every tool hears about it
    memo = seen = t;
    resetWarning();
    return { ok: true, returnTo };
  } catch (err) {
    return { ok: false, returnTo, message: describe(err, { redirect: REDIRECT_URI }) };
  }
}

// ---- who is logged in ----------------------------------------------------------------
/** The signed-in person's name and picture, cached with the shared login. */
export async function loadUser() {
  const cached = shared.readUser();
  if (cached) return cached;
  const t = token();
  if (!t) return null;
  const get = () => lark("GET", `${LARK.api}/authen/v1/user_info`, { token: t, read: true });
  let j;
  try {
    j = await get();
  } catch (e) {
    if (e.deadToken) throw e;
    await larkService.wake();   // asleep or briefly down: once more after it answers
    j = await get();
  }
  const u = j.data || {};
  const user = { name: u.name || u.en_name || "", avatar: u.avatar_thumb || u.avatar_url || "", email: u.email || "" };
  if (token() === t) shared.writeUser(user);   // not if another tab logged in someone else meanwhile
  return user;
}
export const user = () => shared.readUser();

/** Is this page's address a registered redirect URL? Lark's authorize page answers an
 *  unregistered one with an error page carrying "code":20029. Waits for the proxy first.
 *  Resolves null when fine (or when it can't tell), else a sentence. */
export async function redirectProblem() {
  if (!/^https?:$/.test(location.protocol)) {
    return "Fetch is open as a file, so Lark can't send you back to it. Open it from its web address.";
  }
  if (!await larkService.wake()) return null;   // can't tell; the login button still works
  const probe = `${LARK.api}/authen/v1/authorize?client_id=${encodeURIComponent(LARK.appId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(LARK.scopes)}`;
  try {
    const html = await (await fetch(viaProxy(probe), { cache: "no-store" })).text();
    const code = (html.match(/"code":\s*(\d+)/) || [])[1];
    if (code === "20029") {
      return `This address (${REDIRECT_URI}) isn't registered on the Lark app, so login would stop on a Lark error page. `
        + "Add it under Security Settings > Redirect URLs in the Lark developer console.";
    }
    if (code && /errorPage/.test(html)) return `Lark rejected a test login for this page (code ${code}).`;
  } catch (_) { /* can't tell (proxy asleep or blocked); the login button still works */ }
  return null;
}

// ---- the clock -----------------------------------------------------------------------
const LOW_MS = 5 * 60 * 1000;
let inflight = 0, deferred = false, onTick = null;

/** Wrap a write or a long task: the clock won't end the session while it runs, and its calls
 *  may use the token until its real expiry (workToken), even if another tab logs out meanwhile.
 *  If the login ends meanwhile, the session ends when the work settles. Accepts a promise or a
 *  function returning one. */
export function track(work) {
  inflight++;
  return Promise.resolve(typeof work === "function" ? work() : work).finally(() => {
    inflight--;
    if (inflight) return;
    if (endAfterWork) { const { message, elsewhere } = endAfterWork; endAfterWork = null; deferred = false; return end(message, { elsewhere }); }
    if (deferred) { deferred = false; tick(); }
  });
}
export const busyWorking = () => inflight > 0;

/** Before any write (60 s) or long task (120 s): is there enough login left? If not, says so. */
export function ensureTime(ms = 60000) {
  if (msLeft() > ms) return true;
  toast("Your login is about to end, so this wasn't sent.", {
    type: "error", detail: "Log in again, then try it.", action: "Log in again",
    onAction: () => relogin(),
  });
  return false;
}

/** "Log in again" from a toast or button: keeps the current route. */
export function relogin() {
  return startLogin(location.hash).catch((e) => toast(e.message, { type: "error" }));
}

function tick() {
  if (!hadSession()) return;
  if (!currentToken()) {
    if (inflight) { deferred = true; return; }
    return end(ENDED);
  }
  if (onTick) onTick();
  if (!warned && msLeft() < LOW_MS) {
    warned = true;
    closeWarning = toast(`Your login ends at ${fmt.time(endsAt())}.`, {
      type: "warn", detail: "Log in again to keep working without a break.", action: "Log in again",
      onAction: () => relogin(), timeout: 0,
    });
  }
}

/** Start the session clock: every 20 s and whenever the tab comes back. `fn` runs on each tick
 *  while logged in (the app repaints the time left). */
export function startClock(fn) {
  onTick = fn || null;
  setInterval(tick, 20000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());
}
