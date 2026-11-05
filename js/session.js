/* The Lark login shared by every Mineski tool on one site.

   Fetch, Polaris and Suppliers log in through the same Lark app and are published on the same
   origin (https://mineski-stephen.github.io/<tool>/), so they share the browser's localStorage.
   The login lives there under one key: log in to any of them and you're logged in to all, with
   one timer (the expiry is stored with the token). Every other open tab, of any of the tools,
   hears about a change (logged in, renewed, logged out, ended) through the "storage" event.

   This file only stores and announces. Each tool's js/auth.js decides what a change means for
   its screen. The login in progress (PKCE state and verifier) is NOT here: it stays in the tab
   that started it (sessionStorage), so a login finishes where it began.

   Shared file: copied unedited into each tool's js/ from design-ref/mineski-systems-design/assets/
   (check:shell compares them). No imports, so it also runs in Node tests. */

// Preview mode (?preview on a local page, tests/preview-shim.js sets window.MINESKI_PREVIEW)
// keeps its fake login under its own keys, so it never replaces a real one.
const PREFIX = typeof window !== "undefined" && window.MINESKI_PREVIEW ? "mineski.preview.auth." : "mineski.auth.";
export const KEY = { token: `${PREFIX}token`, user: `${PREFIX}user` };
const GRACE_MS = 30000;   // a token with less than this left counts as ended for new work

// Storage that never throws (private mode, blocked site data): the page works without it.
function get(area, key) {
  try { return JSON.parse(globalThis[`${area}Storage`].getItem(key)); } catch (_) { return null; }
}
function set(area, key, value) {
  try {
    const s = globalThis[`${area}Storage`];
    if (value === undefined || value === null) s.removeItem(key); else s.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) { return false; }
}

const isToken = (t) => !!(t && typeof t.access_token === "string" && t.access_token && Number.isFinite(t.expires_at));
/** Still good for new work (more than 30 s left)? */
export const isLive = (t, now = Date.now()) => isToken(t) && t.expires_at > now + GRACE_MS;

/** The stored login {access_token, scope, expires_at}, expired or not (the clock decides), or null. */
export function readToken() {
  const t = get("local", KEY.token);
  return isToken(t) ? t : null;
}
/** Store a new login for every tool. False when the browser blocks storage. Write (or clear) the
 *  person first: other tabs read the person when this change reaches them. */
export const writeToken = (t) => set("local", KEY.token, t);
/** The signed-in person's cached name and picture {name, avatar, email}, or null. */
export const readUser = () => get("local", KEY.user);
/** Cache the name and picture (undefined forgets it). */
export const writeUser = (u) => set("local", KEY.user, u);
/** Forget the login: every tool, every tab. */
export function clear() {
  set("local", KEY.token, undefined);
  set("local", KEY.user, undefined);
}

/** One-time move of a login a tool kept in this tab before logins were shared (sessionStorage
 *  "<tool>.auth.token" and ".user"). It's taken only while it's still live and lasts longer than
 *  the shared one; the old keys go either way. Call once, before reading the login. */
export function adopt(tool) {
  const oldKey = `${tool}.auth.token`, oldUserKey = `${tool}.auth.user`;
  const old = get("session", oldKey), oldUser = get("session", oldUserKey);
  if (old === null && oldUser === null) return false;
  const cur = readToken();
  const take = isLive(old) && (!isLive(cur) || old.expires_at > cur.expires_at);
  if (take) {
    writeUser(oldUser || undefined);   // never keep a name that may belong to another account
    writeToken(old);                   // after the name (see writeToken)
  }
  set("session", oldKey, undefined);
  set("session", oldUserKey, undefined);
  return take;
}

/** fn(token or null) runs when another tab, of any tool, changes the login: logs in, renews,
 *  logs out, or the login ends. A change made in this tab doesn't fire it. Returns unsubscribe. */
export function onChange(fn) {
  if (typeof addEventListener !== "function") return () => {};
  const handler = (e) => {
    if (e.key !== KEY.token && e.key !== null) return;   // null: the site's storage was cleared
    fn(readToken());
  };
  addEventListener("storage", handler);
  return () => removeEventListener("storage", handler);
}
