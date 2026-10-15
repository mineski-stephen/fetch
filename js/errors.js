/*
 * Errors as facts, and one function that turns them into sentences.
 * Pure functions: no DOM, no network.
 *
 * Network code throws LarkError(message, { network, status, json, raw, uncertain, deadToken }).
 * The words come later, at display time, from describe(). Never a raw code alone, and
 * never developer instructions (script names, file names) for the people using the page.
 */

export class LarkError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

/** A change that no longer applies: already in Lark, or changed there since the page loaded it.
 *  Nothing was written. */
export class AlreadyDone extends Error {
  constructor(message, detail, extra = {}) { super(message); this.name = "AlreadyDone"; this.detail = detail || ""; Object.assign(this, extra); }
}

/** Saving is switched off because the table doesn't match what the page expects (or the
 *  login can't write). `problems` are plain sentences. */
export class WriteBlocked extends Error {
  constructor(problems, message) {
    super(message || "Saving is switched off right now.");
    this.name = "WriteBlocked";
    this.problems = problems;
  }
}

/** Lark codes meaning the login itself is no good (expired, revoked, malformed). One shared set. */
export const DEAD_TOKEN_CODES = [20005, 99991661, 99991663, 99991668, 99991671, 99991677];
export const isDeadToken = (err) => !!(err && (err.deadToken || (err.json && DEAD_TOKEN_CODES.includes(Number(err.json.code))))); 
/** Did a write possibly land? (a network error or timeout after the request left) */
export const isUncertain = (err) => !!(err && err.uncertain);

/** Login messages (the code exchange, and the redirect back from Lark). */
export const AUTH_MESSAGES = {
  20001: "The connection service couldn't complete the login. Try again; if it keeps happening, tell the admin.",
  20002: "The connection service couldn't complete the login. Try again; if it keeps happening, tell the admin.",
  20063: "The connection service couldn't complete the login. Try again; if it keeps happening, tell the admin.",
  20003: "That login code expired or was already used. Log in again.",
  20004: "That login code expired or was already used. Log in again.",
  20065: "That login code expired or was already used. Log in again.",
  20049: "The login check failed, probably because it started in another tab. Log in again here.",
  20071: "Lark sent the login back to a different address. Log in again from this page.",
  20010: "Your Lark account isn't allowed to use this app yet. Ask the app admin to add you.",
};

/** Turn a failure into one plain sentence: what happened, and what to do.
 *  ctx: { app, host (the Lark proxy), blocked: [hosts], redirect (this page's address), deleting } */
export function describe(err, ctx = {}) {
  const app = ctx.app || "Fetch";
  if (!err) return "Something went wrong. Try again.";
  if (err.name === "AlreadyDone" || err.name === "WriteBlocked") return err.message;
  if (err.deadToken) return "Your login has ended. Log in again.";
  if (ctx.blocked && ctx.blocked.length) {
    return `Your browser is blocking ${ctx.blocked.join(" and ")}, probably an ad blocker or privacy extension. ` +
           "Allow that site (or pause the blocker on this page), then reload.";
  }
  if (err.outdated) return `${err.message} Ask the admin to redeploy it.`;
  if (err.uncertain) return `${app} couldn't confirm the save. Refresh before trying again.`;
  if (err.notFound) return "That row isn't in Lark any more. The list refreshed.";
  if (err.network) {
    return `${app} can't reach its connection service${ctx.host ? ` (${ctx.host})` : ""}. ` +
           "It may still be waking up; try again in a moment.";
  }
  const j = err.json || {};
  const code = Number(j.code);
  if (j.code === undefined && j.error === "not found") {
    return "The connection service doesn't support logging in yet. Ask the admin to update it.";
  }
  if (AUTH_MESSAGES[code]) return AUTH_MESSAGES[code];
  if (code === 20029) return `This address (${ctx.redirect || "this page"}) isn't registered on the Lark app.`;
  if (DEAD_TOKEN_CODES.includes(code)) return "Your login has ended. Log in again.";
  switch (code) {
    case 99991679: {
      const subjects = [].concat(((j.error || {}).permission_violations || []).map((p) => p.subject)).filter(Boolean);
      return `Your login is missing a permission ${app} needs${subjects.length ? ` (${subjects.join(", ")})` : ""}. Log out, then log in again.`;
    }
    case 413: return j.msg || "That file is too large for the connection service.";
    case 91403: return "Lark says your account can't open or edit this Base. Ask its owner for edit access.";
    case 1254302: return ctx.deleting
      ? "Your account isn't allowed to delete rows. Mark it Done instead."
      : "Your account isn't allowed to change this table (its permissions are restricted). Ask the Base owner.";
    case 91402: case 1254003: case 1254040: return `${app} is pointed at a Base that doesn't exist. Tell the tool owner.`;
    case 1254004: case 1254041: return `${app} is pointed at a table that doesn't exist. Tell the tool owner.`;
    case 1254045: return `A column ${app} needs doesn't exist: ${err.column || j.msg || "unknown"}. Tell the tool owner.`;
    case 1254006: case 1254043: return "That row isn't in Lark any more. The list refreshed.";
    case 1254291: return "Someone else is changing this table right now. Try again in a moment.";
    case 1254290: case 99991400: return "Lark is getting too many requests. Wait a moment and try again.";
  }
  if (code >= 1254060 && code <= 1254068) return `Lark didn't accept a value for a column (${j.msg || "no reason given"}).`;
  if (/syncTable|ConnectorSyncTable/i.test(j.msg || "")) return "This table is synced from elsewhere, so it's read-only in Lark.";
  if (err.raw !== undefined) return `The connection service answered with an error (HTTP ${err.status}). Try again in a moment.`;
  if (err.json) {
    const msg = j.error_description || j.msg || j.error || err.message;
    return `Lark said: ${msg}${Number.isNaN(code) ? "" : ` (code ${code})`}`;
  }
  return err.message || "Something went wrong. Try again.";
}

/** The words for a write that failed: "Nothing was written." only when Lark actually answered
 *  with an error; when the request may have landed, say so and ask for a refresh first. */
export function describeWrite(err, ctx = {}) {
  const why = describe(err, ctx);
  if (!err || err.name === "AlreadyDone" || err.name === "WriteBlocked" || err.uncertain || err.deadToken) return why;
  if (err.network || (ctx.blocked && ctx.blocked.length)) return why;
  return `Nothing was written. ${why}`;
}

// ---- service versions -------------------------------------------------------------
/** True when version `a` is at least `b` (dotted numbers; anything missing counts as 0). */
export function versionAtLeast(a, b) {
  const x = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const y = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

/** Does what a service's GET / reported fit what the page needs?
 *  def: { min, headers }. Returns "" when fine, else the reason, e.g. "v1.3.0, needs 1.4.0".
 *  A service that doesn't report a version or its CORS headers (yet) is given the benefit of the doubt. */
export function incompatible(info, def) {
  const version = String((info && info.version) || "");
  if (def.min && version && !versionAtLeast(version, def.min)) return `v${version}, needs ${def.min}`;
  const allowed = info && info.cors && Array.isArray(info.cors.allow_headers) ? info.cors.allow_headers.map((h) => h.toLowerCase()) : null;
  if (allowed) {
    const lacking = (def.headers || []).filter((h) => !allowed.includes(h.toLowerCase()));
    if (lacking.length) return `${version ? `v${version}, ` : ""}doesn't allow ${lacking.join(", ")}`;
  }
  return "";
}
