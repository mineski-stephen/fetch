/* The login shared by the Mineski tools (js/session.js, a copy of the systems design's
   assets/session.js): storage, the one-time move of a per-tab login, and change events.
   Offline, with in-memory storage. Run: npm test */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as session from "../js/session.js";

class Memory {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const put = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const events = new EventTarget();
put("addEventListener", events.addEventListener.bind(events));
put("removeEventListener", events.removeEventListener.bind(events));
const fire = (key) => { const e = new Event("storage"); e.key = key; events.dispatchEvent(e); };

let local, sess;
beforeEach(() => { put("localStorage", local = new Memory()); put("sessionStorage", sess = new Memory()); });

const HOUR = 3600000;
const login = (msLeft, access = "u-token") => ({ access_token: access, scope: "bitable:app", expires_at: Date.now() + msLeft });

test("one key for every tool, outside preview mode", () => {
  assert.deepEqual(session.KEY, { token: "mineski.auth.token", user: "mineski.auth.user" });
});

test("a stored login comes back as stored, and only a well-formed one counts", () => {
  assert.equal(session.readToken(), null);
  const t = login(HOUR);
  assert.equal(session.writeToken(t), true);
  assert.deepEqual(session.readToken(), t);
  local.setItem(session.KEY.token, JSON.stringify({ access_token: "", expires_at: Date.now() + HOUR }));
  assert.equal(session.readToken(), null, "an empty token");
  local.setItem(session.KEY.token, JSON.stringify({ access_token: "x" }));
  assert.equal(session.readToken(), null, "no expiry");
  local.setItem(session.KEY.token, "{not json");
  assert.equal(session.readToken(), null, "garbage");
});

test("live means more than 30 seconds left", () => {
  assert.equal(session.isLive(login(HOUR)), true);
  assert.equal(session.isLive(login(31000)), true);
  assert.equal(session.isLive(login(29000)), false);
  assert.equal(session.isLive(login(-1000)), false);
  assert.equal(session.isLive(null), false);
});

test("clear forgets the login and the person", () => {
  session.writeToken(login(HOUR));
  session.writeUser({ name: "Ana", avatar: "", email: "ana@example.com" });
  assert.equal(session.readUser().name, "Ana");
  session.clear();
  assert.equal(session.readToken(), null);
  assert.equal(session.readUser(), null);
  assert.equal(local.m.size, 0);
});

test("blocked storage reads as logged out and says the write failed", () => {
  put("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } });
  assert.equal(session.readToken(), null);
  assert.equal(session.writeToken(login(HOUR)), false);
  assert.doesNotThrow(() => session.clear());
});

test("adopt: a live per-tab login moves to the shared one, with its person", () => {
  const t = login(HOUR, "old-tab");
  sess.setItem("fetch.auth.token", JSON.stringify(t));
  sess.setItem("fetch.auth.user", JSON.stringify({ name: "Ana" }));
  assert.equal(session.adopt("fetch"), true);
  assert.deepEqual(session.readToken(), t);
  assert.equal(session.readUser().name, "Ana");
  assert.equal(sess.m.size, 0, "the old keys are gone");
});

test("adopt: a shared login that lasts longer is kept", () => {
  const shared = login(2 * HOUR, "shared");
  session.writeToken(shared);
  session.writeUser({ name: "Ben" });
  sess.setItem("polaris.auth.token", JSON.stringify(login(HOUR, "old-tab")));
  sess.setItem("polaris.auth.user", JSON.stringify({ name: "Ana" }));
  assert.equal(session.adopt("polaris"), false);
  assert.equal(session.readToken().access_token, "shared");
  assert.equal(session.readUser().name, "Ben");
  assert.equal(sess.m.size, 0);
});

test("adopt: an ended per-tab login is dropped, and never takes a name along", () => {
  sess.setItem("suppliers.auth.token", JSON.stringify(login(10000)));
  sess.setItem("suppliers.auth.user", JSON.stringify({ name: "Ana" }));
  assert.equal(session.adopt("suppliers"), false);
  assert.equal(session.readToken(), null);
  assert.equal(session.readUser(), null);
  assert.equal(sess.m.size, 0);
});

test("adopt: a live per-tab login without a name clears a name that may be someone else's", () => {
  session.writeToken(login(20000, "ending"));
  session.writeUser({ name: "Ben" });
  sess.setItem("fetch.auth.token", JSON.stringify(login(HOUR, "old-tab")));
  assert.equal(session.adopt("fetch"), true);
  assert.equal(session.readToken().access_token, "old-tab");
  assert.equal(session.readUser(), null);
});

test("adopt writes the person before the login, so other tabs never pair the new login with an old name", () => {
  const order = [];
  const watched = new Memory();
  watched.setItem = (k, v) => { order.push(k); Memory.prototype.setItem.call(watched, k, v); };
  watched.removeItem = (k) => { order.push(k); Memory.prototype.removeItem.call(watched, k); };
  put("localStorage", watched);
  sess.setItem("fetch.auth.token", JSON.stringify(login(HOUR, "old-tab")));
  sess.setItem("fetch.auth.user", JSON.stringify({ name: "Ana" }));
  session.adopt("fetch");
  assert.deepEqual(order, [session.KEY.user, session.KEY.token]);
});

test("adopt: nothing to move changes nothing", () => {
  session.writeToken(login(HOUR, "shared"));
  sess.setItem("fetch.auth.pending", JSON.stringify({ state: "s" }));
  assert.equal(session.adopt("fetch"), false);
  assert.equal(session.readToken().access_token, "shared");
  assert.equal(sess.m.size, 1, "a login in progress stays in its tab");
});

test("onChange: hears the login key and a full clear, not other keys, until unsubscribed", () => {
  const seen = [];
  const off = session.onChange((t) => seen.push(t && t.access_token));
  session.writeToken(login(HOUR, "from-another-tab"));
  fire(session.KEY.token);
  fire(session.KEY.user);
  fire("polaris.settings");
  session.clear();
  fire(null);
  off();
  fire(session.KEY.token);
  assert.deepEqual(seen, ["from-another-tab", null]);
});
