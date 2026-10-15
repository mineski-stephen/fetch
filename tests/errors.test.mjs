import test from "node:test";
import assert from "node:assert/strict";
import { LarkError, AlreadyDone, WriteBlocked, describe, describeWrite, isDeadToken, isUncertain, DEAD_TOKEN_CODES,
  AUTH_MESSAGES, versionAtLeast, incompatible } from "../js/errors.js";

const coded = (code, msg = "msg", extra = {}) => new LarkError("Lark error", { status: 200, json: { code, msg }, ...extra });
const say = (err, ctx) => describe(err, { app: "Fetch", host: "lark-proxy-dwiw.onrender.com", ...ctx });

// Every code the standard lists (SKILL.md 5.5 and 4.6) has a message, and none is a raw code alone.
const LISTED = [91403, 1254302, 91402, 1254003, 1254040, 1254004, 1254041, 1254045, 1254006, 1254043,
  1254060, 1254061, 1254062, 1254063, 1254064, 1254065, 1254066, 1254067, 1254068, 1254290, 99991400, 1254291,
  99991679, 20003, 20004, 20065, 20049, 20071, 20010, 20001, 20002, 20063, 20029, ...DEAD_TOKEN_CODES];

test("every listed code has its own sentence", () => {
  for (const code of LISTED) {
    const text = say(coded(code, "reason"), { redirect: "http://127.0.0.1:9124/" });
    assert.ok(!text.startsWith("Lark said:"), `code ${code} fell through to the last resort: ${text}`);
    assert.ok(text.length > 20 && /[.)]$/.test(text), `code ${code}: ${text}`);
    assert.ok(!/\u2014/.test(text), "no em dashes");
    assert.ok(!/setup_lark_table|tools\//.test(text), `code ${code} names a script: ${text}`);
  }
});

test("the standard's wording", () => {
  assert.equal(say(coded(91403)), "Lark says your account can't open or edit this Base. Ask its owner for edit access.");
  assert.equal(say(coded(1254302)), "Your account isn't allowed to change this table (its permissions are restricted). Ask the Base owner.");
  assert.equal(say(coded(1254302), { deleting: true }), "Your account isn't allowed to delete rows. Mark it Done instead.");
  assert.equal(say(coded(91402)), "Fetch is pointed at a Base that doesn't exist. Tell the tool owner.");
  assert.equal(say(coded(1254004)), "Fetch is pointed at a table that doesn't exist. Tell the tool owner.");
  assert.equal(say(coded(1254045), {}), "A column Fetch needs doesn't exist: msg. Tell the tool owner.");
  assert.equal(say(coded(1254045, "x", { column: "Venue" })), "A column Fetch needs doesn't exist: Venue. Tell the tool owner.");
  assert.equal(say(coded(1254043)), "That row isn't in Lark any more. The list refreshed.");
  assert.equal(say(coded(1254062, "bad date")), "Lark didn't accept a value for a column (bad date).");
  assert.equal(say(coded(99991400)), "Lark is getting too many requests. Wait a moment and try again.");
  assert.equal(say(coded(1254291)), "Someone else is changing this table right now. Try again in a moment.");
  assert.equal(say(coded(1, "ConnectorSyncTable")), "This table is synced from elsewhere, so it's read-only in Lark.");
  assert.equal(say(coded(20029), { redirect: "http://127.0.0.1:9124/" }), "This address (http://127.0.0.1:9124/) isn't registered on the Lark app.");
});

test("a missing permission names what's missing", () => {
  const err = new LarkError("Lark error", { json: { code: 99991679, error: { permission_violations: [{ subject: "bitable:app" }] } } });
  assert.equal(say(err), "Your login is missing a permission Fetch needs (bitable:app). Log out, then log in again.");
  assert.equal(say(coded(99991679)), "Your login is missing a permission Fetch needs. Log out, then log in again.");
});

test("dead-token codes end the login", () => {
  for (const code of [20005, 99991661, 99991663, 99991668, 99991671, 99991677]) {
    assert.equal(isDeadToken(coded(code)), true);
    assert.equal(say(coded(code)), "Your login has ended. Log in again.");
  }
  assert.equal(isDeadToken(coded(91403)), false);
  assert.equal(isDeadToken(new LarkError("x", { deadToken: true })), true);
});

test("network facts: unreachable, blocked, uncertain", () => {
  const net = new LarkError("fetch failed", { network: true });
  assert.equal(say(net), "Fetch can't reach its connection service (lark-proxy-dwiw.onrender.com). It may still be waking up; try again in a moment.");
  assert.match(say(net, { blocked: ["a.onrender.com", "b.onrender.com"] }), /blocking a\.onrender\.com and b\.onrender\.com, probably an ad blocker/);
  const lost = new LarkError("no answer in time", { network: true, uncertain: true });
  assert.equal(isUncertain(lost), true);
  assert.equal(say(lost), "Fetch couldn't confirm the save. Refresh before trying again.");
});

test("a proxy answer that isn't JSON, and unknown codes", () => {
  assert.equal(say(new LarkError("HTTP 502, not JSON", { status: 502, raw: "<html>" })),
    "The connection service answered with an error (HTTP 502). Try again in a moment.");
  assert.equal(say(coded(777777, "something odd")), "Lark said: something odd (code 777777)");
  assert.equal(say(new LarkError("x", { json: { error: "not found" } })),
    "The connection service doesn't support logging in yet. Ask the admin to update it.");
  assert.equal(say(null), "Something went wrong. Try again.");
});

test("the login table covers its codes", () => {
  for (const code of [20001, 20002, 20063, 20003, 20004, 20065, 20049, 20071, 20010]) assert.ok(AUTH_MESSAGES[code], String(code));
});

test("writes: 'Nothing was written.' only when Lark answered with an error", () => {
  assert.equal(describeWrite(coded(91403), { app: "Fetch" }), "Nothing was written. Lark says your account can't open or edit this Base. Ask its owner for edit access.");
  assert.equal(describeWrite(new LarkError("t", { network: true, uncertain: true }), { app: "Fetch" }), "Fetch couldn't confirm the save. Refresh before trying again.");
  assert.doesNotMatch(describeWrite(new LarkError("t", { network: true }), { app: "Fetch" }), /Nothing was written/);
  const changed = new AlreadyDone("“Tranche 2” changed in Lark since you opened it. Nothing was written.");
  assert.equal(describeWrite(changed), changed.message);
  const blocked = new WriteBlocked(["Column “Done” is missing."]);
  assert.equal(describeWrite(blocked), blocked.message);
});

test("service versions", () => {
  assert.equal(versionAtLeast("1.4.0", "1.4.0"), true);
  assert.equal(versionAtLeast("1.10.0", "1.9.9"), true);
  assert.equal(versionAtLeast("1.3.0", "1.4.0"), false);
  assert.equal(versionAtLeast("2", "1.9"), true);
  const def = { min: "1.4.0", headers: ["Authorization", "X-Gemini-Api-Key"] };
  assert.equal(incompatible({ version: "1.4.0" }, def), "");
  assert.equal(incompatible({ version: "1.3.0" }, def), "v1.3.0, needs 1.4.0");
  assert.equal(incompatible({}, def), "", "a service that reports no version gets the benefit of the doubt");
  assert.equal(incompatible({ version: "1.5.0", cors: { allow_headers: ["Content-Type", "authorization"] } }, def),
    "v1.5.0, doesn't allow X-Gemini-Api-Key");
  assert.equal(incompatible({ version: "1.5.0", cors: { allow_headers: ["Content-Type", "Authorization", "X-Gemini-Api-Key"] } }, def), "");
  assert.equal(incompatible({ version: "0.1" }, { min: "", headers: [] }), "");
});
