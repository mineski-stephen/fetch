/*
 * Large PDFs are made smaller in the browser before they're sent, with Squeeze's engine
 * (tech/pdf-compress, copied unedited into squeeze/; check:shell compares the copies). Photos are
 * re-encoded as JPEG quality 65 at 144 PPI, the same as Sejda's Compress, so they look the same;
 * text, vectors and page count don't change. A 40 MB sales kit typically comes out at 3-5 MB, so it:
 *   - uploads in seconds instead of minutes,
 *   - fits the extraction service's upload limit and Lark's 10 MB attachment limit, and
 *   - costs the extraction service nothing (the work happens on this computer).
 *
 * It only ever helps: a PDF that can't be read, takes too long, or comes out less than 10% smaller
 * is sent as it was. Each PDF is compressed in its own Web Worker, so the page stays responsive and
 * Cancel can stop it at once.
 */
import { RULES } from "./config.js";

const MIN_SAVING = 0.1;          // keep the smaller copy only if it saves at least this much
const TIME_LIMIT_MS = 120000;    // per PDF; past this the original is sent

const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");

/** Will this file be compressed before sending? (PDFs over RULES.compressPdfOverMb.) */
export const willCompress = (file) => isPdf(file) && file.size > RULES.compressPdfOverMb * 1048576;

/** Compress one PDF. Resolves { file, before, after, ms } with the smaller File (same name), or
 *  null when the original should be sent instead. cancel() stops it (resolves null). */
export function compressPdf(file, { onProgress } = {}) {
  let worker = null, timer = null, settle;
  const promise = new Promise((resolve) => {
    const started = performance.now();
    settle = (value) => {
      clearTimeout(timer);
      if (worker) { worker.terminate(); worker = null; }
      settle = () => {};
      resolve(value);
    };
    (async () => {
      let bytes;
      try { bytes = await file.arrayBuffer(); } catch (_) { return settle(null); }
      try {
        worker = new Worker(new URL(`../squeeze/js/worker.js?v=${window.APP_BUILD || ""}`, import.meta.url), { type: "module" });
      } catch (_) { return settle(null); }   // no module workers in this browser
      timer = setTimeout(() => settle(null), TIME_LIMIT_MS);
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === "progress") onProgress?.(m);
        else if (m.type === "done") {
          const after = m.bytes.byteLength;
          if (m.report?.unchanged || after > file.size * (1 - MIN_SAVING)) return settle(null);
          const small = new File([m.bytes], file.name, { type: "application/pdf", lastModified: file.lastModified });
          settle({ file: small, before: file.size, after, ms: Math.round(performance.now() - started) });
        } else if (m.type === "error") settle(null);   // locked or damaged: Gemini may still read the original
      };
      worker.onerror = (e) => { e?.preventDefault?.(); settle(null); };
      worker.postMessage({ type: "compress", bytes, options: {} }, [bytes]);
    })();
  });
  return { promise, cancel: () => settle(null) };
}

/**
 * Compress every file that needs it, one at a time. Returns { promise, cancel }; the promise
 * resolves { files, saved: [{ name, before, after }] } with each file replaced by its smaller copy
 * where that worked (same order). Hooks: onFile(index, count, file) as each starts, onProgress(p)
 * with Squeeze's { stage, done, total }.
 */
export function compressAll(files, { onFile, onProgress } = {}) {
  let current = null, cancelled = false;
  const promise = (async () => {
    const out = [...files], saved = [];
    const todo = files.map((f, i) => [f, i]).filter(([f]) => willCompress(f));
    for (let n = 0; n < todo.length && !cancelled; n++) {
      const [file, i] = todo[n];
      onFile?.(n, todo.length, file);
      current = compressPdf(file, { onProgress });
      const r = await current.promise;
      if (r && !cancelled) { out[i] = r.file; saved.push({ name: file.name, before: r.before, after: r.after }); }
    }
    return { files: out, saved };
  })();
  return { promise, cancel: () => { cancelled = true; current?.cancel(); } };
}
