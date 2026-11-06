// Compression worker: keeps the page responsive while the engine runs, and supplies the
// browser's own image codec (createImageBitmap to decode and scale, OffscreenCanvas to
// encode). Chrome, Edge and Firefox encode JPEG with libjpeg-turbo at IJG quality = q,
// 4:2:0 chroma: the same settings Sejda uses, so the output matches it closely.
//
// Messages in:  { type: "compress", bytes: ArrayBuffer, options }
// Messages out: { type: "progress", stage, done, total }
//               { type: "done", bytes: ArrayBuffer, report }
//               { type: "error", code, message }

const version = new URL(self.location.href).searchParams.get("v");
const engineReady = import("./engine.js" + (version ? "?v=" + version : ""));

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== "compress") return;
  try {
    const { compressPdf } = await engineReady;
    const { bytes, report } = await compressPdf(new Uint8Array(msg.bytes), msg.options || {}, {
      encodeJpeg,
      progress: (p) => self.postMessage({ type: "progress", ...p }),
    });
    const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    self.postMessage({ type: "done", bytes: buf, report }, [buf]);
  } catch (err) {
    self.postMessage({ type: "error", code: (err && err.code) || "failed", message: (err && err.message) || String(err) });
  }
};

async function encodeJpeg(src, width, height, quality) {
  const opts = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
  if (src.width !== width || src.height !== height) Object.assign(opts, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  const input = src.kind === "jpeg"
    ? new Blob([src.bytes], { type: "image/jpeg" })
    : new ImageData(src.rgba, src.width, src.height);
  const bitmap = await createImageBitmap(input, opts);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext("2d");
    if (bitmap.width !== width || bitmap.height !== height) {   // the browser ignored the resize options
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
    }
    g.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
