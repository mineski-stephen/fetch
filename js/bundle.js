/*
 * What "Check sources" and "Brief files" need after a brief is filed, as one file in
 * the row's "Fetch Files" column: the quotes (evidence), the brief as extracted (so
 * edited list items still find their quote), which source is which, the text Fetch
 * converted from Office files and e-mails, and the typed text. The source files
 * themselves are already in the Attachments column; `files` says which one each is.
 *
 * Gzipped JSON, usually a few KB (the converted text, when there is any, is most of it).
 * No DOM; CompressionStream is built into browsers and Node 18+.
 */

export const NAME = "fetch-sources.json.gz";
export const KIND = "fetch.sources";
export const VERSION = 1;

/** Is this attachment a sources file? */
export const isBundle = (a) => !!a && /^fetch-sources.*\.json\.gz$/i.test(a.name || "");

/**
 * The bundle of a draft. `kept`: its files in memory ({ texts, typed }); `attached`: the
 * row's attachments as uploaded ([{ token, name }]), to say which file each source is.
 */
export function pack(draft, kept, attached = []) {
  const sources = (draft.meta?.sources || []).map((s) => ({
    name: s.name, kind: s.kind, has_blobs: !!s.has_blobs, text_truncated: !!s.text_truncated }));
  const files = {};
  for (const s of sources) {
    const a = attached.find((x) => x.name === s.name && x.token);
    if (a) files[s.name] = a.token;
  }
  return {
    kind: KIND, v: VERSION, createdAt: draft.createdAt || Date.now(), clientToken: draft.clientToken,
    original: draft.original, evidence: draft.evidence || [],
    meta: { sources, typed_text_chars: draft.meta?.typed_text_chars || 0 },
    sources: draft.sources || [], files,
    texts: Array.isArray(kept?.texts) ? kept.texts.map((t) => (typeof t === "string" ? t : null)) : [],
    typed: kept?.typed || "",
  };
}

async function pipe(data, stream) {
  return new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer();
}

/** The bundle as a gzipped file, ready to upload. */
export async function encode(bundle) {
  const gz = await pipe(JSON.stringify(bundle), new CompressionStream("gzip"));
  return new File([gz], NAME, { type: "application/gzip" });
}

/**
 * A downloaded sources file back to a bundle, in the shape the viewer takes for a draft
 * ({ original, evidence, meta, sources, clientToken } plus texts, typed, files).
 * Throws if it isn't one Fetch can read.
 */
export async function decode(blob) {
  const raw = await blob.arrayBuffer();
  const gzipped = new Uint8Array(raw.slice(0, 2));
  const text = new TextDecoder().decode(gzipped[0] === 0x1f && gzipped[1] === 0x8b
    ? await pipe(raw, new DecompressionStream("gzip")) : raw);
  const b = JSON.parse(text);
  if (!b || b.kind !== KIND) throw new Error("This isn't a Fetch sources file.");
  if (Number(b.v) > VERSION) throw new Error("These sources were saved by a newer Fetch. Reload the page.");
  return {
    ...b,
    evidence: Array.isArray(b.evidence) ? b.evidence : [],
    meta: { sources: Array.isArray(b.meta?.sources) ? b.meta.sources : [], typed_text_chars: b.meta?.typed_text_chars || 0 },
    sources: Array.isArray(b.sources) ? b.sources : [],
    texts: Array.isArray(b.texts) ? b.texts : [],
    typed: typeof b.typed === "string" ? b.typed : "",
    files: b.files && typeof b.files === "object" ? b.files : {},
  };
}
