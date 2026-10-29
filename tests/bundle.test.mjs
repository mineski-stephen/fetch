import test from "node:test";
import assert from "node:assert/strict";
import { pack, encode, decode, isBundle, NAME } from "../js/bundle.js";

const DRAFT = {
  clientToken: "tok-1", createdAt: 1, sources: ["RFP.pdf", "Budget.docx", "Typed / pasted text"],
  original: { venue: "SMX Manila", kpis: ["50,000 reach"] },
  evidence: [{ field: "venue", source: 1, page: 2, quote: "Venue: SMX Manila" }],
  meta: { sources: [{ name: "RFP.pdf", kind: "pdf", has_blobs: true, extra: "dropped" }, { name: "Budget.docx", kind: "docx" }],
          typed_text_chars: 12, usage: { output_tokens: 900 } },
  model: { venue: "edited" }, nextSteps: ["x"],
};
const KEPT = { texts: [null, "Budget: PHP 2,000,000"], typed: "Brief by chat" };

test("pack keeps what the viewer needs and says which attachment each source is", () => {
  const b = pack(DRAFT, KEPT, [{ name: "RFP.pdf", token: "f1" }, { name: "Brief text.txt", token: "f3" }]);
  assert.deepEqual(b.files, { "RFP.pdf": "f1" });
  assert.deepEqual(b.meta, { sources: [{ name: "RFP.pdf", kind: "pdf", has_blobs: true, text_truncated: false },
    { name: "Budget.docx", kind: "docx", has_blobs: false, text_truncated: false }], typed_text_chars: 12 });
  assert.equal(b.model, undefined, "the brief itself is in its own columns");
  assert.deepEqual(b.texts, [null, "Budget: PHP 2,000,000"]);
  assert.equal(b.typed, "Brief by chat");
});

test("encode and decode round-trip, gzipped and smaller", async () => {
  const big = { ...KEPT, texts: [null, "Budget line. ".repeat(4000)] };
  const file = await encode(pack(DRAFT, big));
  assert.equal(file.name, NAME);
  assert.ok(isBundle(file));
  assert.ok(file.size < 2000, `${file.size} bytes`);
  const back = await decode(file);
  assert.equal(back.clientToken, "tok-1");
  assert.deepEqual(back.evidence, DRAFT.evidence);
  assert.equal(back.texts[1], big.texts[1]);
});

test("decode refuses other files and newer versions, and reads plain JSON too", async () => {
  await assert.rejects(decode(new Blob(["{\"a\":1}"])), /isn't a Fetch sources file/);
  await assert.rejects(decode(new Blob([JSON.stringify({ kind: "fetch.sources", v: 9 })])), /newer Fetch/);
  const b = await decode(new Blob([JSON.stringify({ kind: "fetch.sources", v: 1 })]));
  assert.deepEqual([b.evidence, b.texts, b.typed, b.files], [[], [], "", {}]);
  assert.ok(!isBundle({ name: "RFP.pdf" }));
});
