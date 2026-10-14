/*
 * Lark login: OAuth 2.0 + PKCE, the same flow as tech/universe-updater (Polaris).
 *
 *   1. "Log in with Lark" sends the browser to Lark's authorize page with a PKCE
 *      challenge and a random state (both kept in sessionStorage).
 *   2. Lark sends the user back here with ?code=…&state=…; the code is swapped for
 *      a user_access_token through the Lark proxy, which adds the app secret.
 *   3. The token lives in sessionStorage (this tab only, gone when it closes) and
 *      every Lark call, plus every brief sent to the extraction service, runs as
 *      the signed-in person. Lark gives about 2 hours and no refresh token, so
 *      after that the user logs in again.
 *
 * The page's own address is the redirect URL, so it must be registered on the
 * Lark app (Security Settings > Redirect URLs). redirectProblem() checks this.
 */
import { cfg } from "./settings.js";
import { store, recall } from "./ui.js";

/** Fired when a Lark call says the login is dead; app.js shows the login screen. */
export const AUTH_ENDED = "fetch:auth-ended";

// Lark returns to this page's own address (minus query, hash and index.html).
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html?$/i, "");
const AUTHORIZE_URL = "https://accounts.larksuite.com/open-apis/authen/v1/authorize";
const KEY = { token: "fetch.auth.token", pending: "fetch.auth.pending", user: "fetch.auth.user" };   // sessionStorage

// ---- the session ------------------------------------------------------------
const raw = () => recall("session", KEY.token);
/** The token, if it has more than 30 s left. */
function currentToken() {
  const t = raw();
  return t && t.access_token && t.expires_at > Date.now() + 30000 ? t : null;
}
const token = () => (currentToken() || {}).access_token || "";
const hadSession = () => !!raw();
const msLeft = () => { const t = raw(); return t ? Math.max(0, t.expires_at - Date.now()) : 0; };
const endsAt = () => { const t = raw(); return t ? t.expires_at : 0; };
function clearSession() {
  store("session", KEY.token, undefined);
  store("session", KEY.user, undefined);
}

/** A Lark call said the login is dead: tell the app (it shows the login screen). */
function ended(message) {
  document.dispatchEvent(new CustomEvent(AUTH_ENDED, { detail: { message } }));
}

// ---- talking to Lark through the proxy ------------------------------------------
const viaProxy = (url) => `${cfg().LARK_PROXY_URL}/proxy?url=${encodeURIComponent(url)}`;

async function larkJSON(method, url, { body, bearer } = {}) {
  const init = { method, headers: {}, cache: "no-store" };
  if (bearer) init.headers.Authorization = `Bearer ${bearer}`;
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body || {});
  }
  let res;
  try {
    res = await fetch(viaProxy(url), init);
  } catch (_) {
    throw Object.assign(new Error("Couldn't reach the Lark connection. It may still be waking up; try again in a moment."), { code: "network" });
  }
  const json = await res.json().catch(() => null);
  if (!json) throw Object.assign(new Error(`The Lark connection answered with an error (HTTP ${res.status}). Try again.`), { code: res.status });
  return json;
}

// ---- login ------------------------------------------------------------------------
function b64url(bytes) {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send the browser to Lark. `returnTo` (a #/route) is restored after login. */
async function startLogin(returnTo) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error("Logging in needs https (or http://localhost). Open Fetch from its normal address.");
  }
  // PKCE: the proxy adds the app secret for anyone, so the verifier is what stops
  // an intercepted login code from being used by someone else.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  if (!store("session", KEY.pending, { state, verifier, returnTo: returnTo || "" })) {
    throw new Error("This browser is blocking site storage, so the login can't finish. Allow it for this site.");
  }
  const q = new URLSearchParams({
    client_id: cfg().LARK_APP_ID, redirect_uri: REDIRECT_URI, scope: cfg().LARK_SCOPES, state,
    code_challenge: b64url(new Uint8Array(digest)), code_challenge_method: "S256",
  });
  location.assign(`${AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`);
}

const LOGIN_ERRORS = {
  20003: "That login code expired or was already used. Log in again.",
  20004: "That login code expired or was already used. Log in again.",
  20065: "That login code expired or was already used. Log in again.",
  20049: "The login check failed, probably because it started in another tab. Log in again.",
  20071: "The login came back to a different address than it started from. Log in again.",
  20010: "Your Lark account isn't allowed to use this app yet. Ask the app admin to add you.",
  20001: "The Lark connection couldn't complete the login. Try again in a moment.",
  20002: "The Lark connection couldn't complete the login. Try again in a moment.",
};

/** Handle Lark's redirect back (?code=…&state=… or ?error=…).
 *  Resolves { ok, returnTo, message? }. */
async function finishLogin(params) {
  const pending = recall("session", KEY.pending);
  store("session", KEY.pending, undefined);
  const returnTo = (pending && pending.returnTo) || "";
  if (params.has("error")) {
    return { ok: false, returnTo, message: params.get("error") === "access_denied"
      ? "Login cancelled. Fetch needs your OK on Lark's page to read and save briefs."
      : `Lark couldn't log you in (${params.get("error")}). Try again.` };
  }
  if (!pending || pending.state !== params.get("state")) {
    return { ok: false, returnTo, message: "That login started in another tab. Log in again here." };
  }
  try {
    const j = await larkJSON("POST", `${cfg().LARK_API_BASE}/authen/v2/oauth/token`, { body: {
      grant_type: "authorization_code",
      client_id: cfg().LARK_APP_ID,      // no client_secret: the proxy adds it
      code: params.get("code"),
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    } });
    if (!j.access_token) {
      const code = Number(j.code);
      if (j.code === undefined && j.error === "not found") {
        return { ok: false, returnTo, message: "The Lark connection doesn't support logging in. Check its address in Settings." };
      }
      return { ok: false, returnTo, message: LOGIN_ERRORS[code]
        || `Lark couldn't log you in: ${j.error_description || j.msg || j.error || "no token"}${Number.isNaN(code) ? "" : ` (code ${code})`}` };
    }
    store("session", KEY.token, {
      access_token: j.access_token,
      scope: j.scope || "",
      expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
    });
    store("session", KEY.user, undefined);
    return { ok: true, returnTo };
  } catch (err) {
    return { ok: false, returnTo, message: err.message };
  }
}

/** The signed-in person's name and picture, cached for this tab. */
async function loadUser() {
  const cached = recall("session", KEY.user);
  if (cached) return cached;
  const t = token();
  if (!t) return null;
  const j = await larkJSON("GET", `${cfg().LARK_API_BASE}/authen/v1/user_info`, { bearer: t });
  if (Number(j.code) !== 0) {
    if ([20005, 99991668, 99991677].includes(Number(j.code))) ended();
    return null;
  }
  const u = j.data || {};
  const user = { name: u.name || u.en_name || "", avatar: u.avatar_thumb || u.avatar_url || "", email: u.email || "" };
  store("session", KEY.user, user);
  return user;
}
const user = () => recall("session", KEY.user);

/** Is this page's address a registered redirect URL? Lark's authorize page answers
 *  an unregistered one with an error page carrying "code":20029.
 *  Resolves null when fine (or when it can't tell), else a sentence. */
async function redirectProblem() {
  if (!/^https?:$/.test(location.protocol)) {
    return "Fetch is open as a file, so Lark can't send you back to it. Open it from its web address.";
  }
  const probe = `${cfg().LARK_API_BASE}/authen/v1/authorize?client_id=${encodeURIComponent(cfg().LARK_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(cfg().LARK_SCOPES)}`;
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

export {
  REDIRECT_URI, currentToken, token, hadSession, msLeft, endsAt, clearSession, ended,
  startLogin, finishLogin, loadUser, user, redirectProblem,
};
