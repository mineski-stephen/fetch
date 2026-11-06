// PDF compression engine. Pure logic, no DOM: it runs in a Web Worker (js/worker.js)
// and gets its JPEG codec injected, so it can also be driven from a test harness.
//
// The defaults reproduce Sejda PDF Desktop's "Compress" output, measured on real files
// (see README, "How it matches Sejda"):
//   - every photo-like image is re-encoded as JPEG, IJG quality 65, 4:2:0, baseline
//   - an image shown at more than 144 PPI is first scaled down to 144 PPI, measured on
//     its displayed height: newH = round(2 * shownHeightPt), newW = round(W * newH / H)
//   - the re-encoded image is used only when it is smaller than the original stream
//   - soft masks (transparency) are never touched
//   - the document structure tree (accessibility tags) is dropped
//   - objects are packed into compressed object streams with a cross-reference stream
// On top of that, and lossless: identical streams (repeated photos, fonts, ICC profiles)
// are stored once, uncompressed streams are deflated, and unreachable objects are dropped.

import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFRef, PDFStream,
  PDFString, PDFHexString, PDFBool, PDFStreamWriter, decodePDFRawStream, ParseSpeeds,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";

export const DEFAULTS = Object.freeze({
  quality: 65,           // JPEG quality, 1-100 (Sejda: 65)
  ppi: 144,              // scale down images shown sharper than this (Sejda: 144); 0 = never
  minImageBytes: 40000,  // leave smaller image streams alone (Sejda: every image under
                         // 39,284 B kept, every one over 41,929 B converted, in the samples)
  stripExtras: true,     // drop accessibility tags, page thumbnails and editor-private data
  dedupe: true,          // store identical images, fonts and profiles once
});

const MAX_PIXELS = 80e6;   // larger images are left alone (a decoded copy would need > 320 MB)

// ---------------------------------------------------------------------------------------
// Names
const N = (s) => PDFName.of(s);
const K = {
  Type: N("Type"), Subtype: N("Subtype"), Image: N("Image"), Form: N("Form"), XObject: N("XObject"),
  Resources: N("Resources"), Contents: N("Contents"), Kids: N("Kids"), Pages: N("Pages"),
  Matrix: N("Matrix"), Width: N("Width"), Height: N("Height"), BitsPerComponent: N("BitsPerComponent"),
  ColorSpace: N("ColorSpace"), Filter: N("Filter"), DecodeParms: N("DecodeParms"), DP: N("DP"),
  Decode: N("Decode"), SMask: N("SMask"), Mask: N("Mask"), ImageMask: N("ImageMask"), Matte: N("Matte"),
  SMaskInData: N("SMaskInData"), OC: N("OC"), Length: N("Length"), Metadata: N("Metadata"),
  StructTreeRoot: N("StructTreeRoot"), PieceInfo: N("PieceInfo"), Thumb: N("Thumb"), Version: N("Version"),
  N: N("N"), Alternate: N("Alternate"), Predictor: N("Predictor"), Colors: N("Colors"), Columns: N("Columns"),
  FlateDecode: N("FlateDecode"), Fl: N("Fl"), LZWDecode: N("LZWDecode"), LZW: N("LZW"),
  ASCII85Decode: N("ASCII85Decode"), A85: N("A85"), ASCIIHexDecode: N("ASCIIHexDecode"), AHx: N("AHx"),
  RunLengthDecode: N("RunLengthDecode"), RL: N("RL"), DCTDecode: N("DCTDecode"), DCT: N("DCT"),
  JPXDecode: N("JPXDecode"), JBIG2Decode: N("JBIG2Decode"), CCITTFaxDecode: N("CCITTFaxDecode"), CCF: N("CCF"),
  Crypt: N("Crypt"),
  DeviceRGB: N("DeviceRGB"), RGB: N("RGB"), DeviceGray: N("DeviceGray"), G: N("G"),
  DeviceCMYK: N("DeviceCMYK"), CMYK: N("CMYK"), ICCBased: N("ICCBased"), Indexed: N("Indexed"), I: N("I"),
  CalRGB: N("CalRGB"), CalGray: N("CalGray"),
};
// Abbreviated filter names (inline-image style) occasionally appear in stream dicts too.
const FILTER_ALIAS = new Map([
  [K.Fl, K.FlateDecode], [K.LZW, K.LZWDecode], [K.A85, K.ASCII85Decode], [K.AHx, K.ASCIIHexDecode],
  [K.RL, K.RunLengthDecode], [K.DCT, K.DCTDecode], [K.CCF, K.CCITTFaxDecode],
]);
const GENERIC_FILTERS = new Set([K.FlateDecode, K.LZWDecode, K.ASCII85Decode, K.ASCIIHexDecode, K.RunLengthDecode]);

// ---------------------------------------------------------------------------------------
// Public entry point

/**
 * Compress a PDF.
 * @param {Uint8Array} input   the PDF file
 * @param {object} options     see DEFAULTS
 * @param {object} hooks
 *   encodeJpeg(source, width, height, quality) -> Promise<Uint8Array>   (required)
 *       source is { kind: "jpeg", bytes } or { kind: "pixels", rgba, width, height }
 *   progress({ stage, done, total })                                    (optional)
 *   isCancelled() -> boolean                                             (optional)
 * @returns {Promise<{ bytes: Uint8Array, report: object }>}
 */
export async function compressPdf(input, options = {}, hooks = {}) {
  const opts = { ...DEFAULTS, ...options };
  const progress = hooks.progress || (() => {});
  const checkCancel = () => { if (hooks.isCancelled && hooks.isCancelled()) throw new CancelledError(); };
  const t0 = now();
  const report = {
    inputBytes: input.length, outputBytes: 0, pages: 0, ms: 0, unchanged: false,
    images: { total: 0, reencoded: 0, downsampled: 0, keptOriginal: 0, skipped: 0, skipReasons: {} },
    imageBytesBefore: 0, imageBytesAfter: 0, merged: 0, deflated: 0, removedObjects: 0,
  };

  progress({ stage: "read" });
  let doc;
  try {
    doc = await PDFDocument.load(input, {
      ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest, throwOnInvalidObject: false,
    });
  } catch (err) {
    throw new PdfError("unreadable", "This file couldn't be read as a PDF.", err);
  }
  if (doc.isEncrypted) throw new PdfError("encrypted", "This PDF is password-protected or locked.");
  const ctx = doc.context;
  const catalog = ctx.lookup(ctx.trailerInfo.Root);
  if (!(catalog instanceof PDFDict)) throw new PdfError("unreadable", "This PDF has no document catalog.");
  checkCancel();

  // 1. Lossless clean-up first, so later steps see one copy of each image.
  if (opts.stripExtras) stripExtras(ctx, catalog);
  if (opts.dedupe) report.merged = dedupeStreams(ctx);
  checkCancel();

  // 2. Where is each image shown, and how big?
  progress({ stage: "scan" });
  const { shown, pages } = measureImages(ctx, catalog);
  report.pages = pages;
  checkCancel();

  // 3. Re-encode images.
  const candidates = findCandidateImages(ctx);
  report.images.total = candidates.length;
  let done = 0;
  progress({ stage: "images", done, total: candidates.length });
  const skip = (reason) => {
    report.images.skipped++;
    report.images.skipReasons[reason] = (report.images.skipReasons[reason] || 0) + 1;
  };
  await pool(candidates, 2, async ([ref, stream]) => {
    checkCancel();
    try {
      await recompressImage(ctx, ref, stream, shown.get(ref), opts, hooks, report, skip);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      skip("couldn't be decoded");
    }
    done++;
    progress({ stage: "images", done, total: candidates.length });
  });
  checkCancel();

  // 4. Lossless: deflate streams stored without compression; drop what nothing uses.
  progress({ stage: "write" });
  report.deflated = await deflateRawStreams(ctx);
  report.removedObjects = collectGarbage(ctx);
  renumber(ctx);
  const ver = catalog.get(K.Version);
  if (ver instanceof PDFName && parseFloat(ver.decodeText()) < 1.5) catalog.delete(K.Version);
  checkCancel();

  // 5. Write with object streams + cross-reference stream (PDF 1.5+).
  let bytes = await PDFStreamWriter.forContext(ctx, Infinity, true, 100).serializeToBuffer();
  if (bytes.length >= input.length) {   // nothing to gain: hand back the original
    bytes = input;
    report.unchanged = true;
  }
  report.outputBytes = bytes.length;
  report.ms = Math.round(now() - t0);
  return { bytes, report };
}

export class PdfError extends Error {
  constructor(code, message, cause) { super(message); this.code = code; this.cause = cause; }
}
export class CancelledError extends Error {
  constructor() { super("Cancelled"); this.code = "cancelled"; }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

async function pool(items, size, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

// ---------------------------------------------------------------------------------------
// Image selection and re-encoding

function findCandidateImages(ctx) {
  const images = [];
  const masks = new Set();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.lookup(K.Subtype) !== K.Image) continue;
    images.push([ref, obj]);
    const sm = obj.dict.get(K.SMask);
    if (sm instanceof PDFRef) masks.add(sm);
    const m = obj.dict.get(K.Mask);
    if (m instanceof PDFRef) masks.add(m);
  }
  // Soft masks and stencil masks stay exactly as they are (Sejda leaves them too).
  return images.filter(([ref]) => !masks.has(ref));
}

async function recompressImage(ctx, ref, stream, shownAt, opts, hooks, report, skip) {
  const d = stream.dict;
  if (stream.contents.length < opts.minImageBytes) {   // small already: logos, icons, flat art
    report.images.keptOriginal++;
    return;
  }
  const src = await readImage(ctx, stream);
  if (src.skip) return skip(src.skip);

  const W = src.width, H = src.height;
  let w = W, h = H;
  if (shownAt && opts.ppi > 0) {
    // Scale by the displayed height, exactly as Sejda does (see the header comment).
    const targetH = Math.round(f32((shownAt.h * opts.ppi) / 72));
    if (targetH >= 1 && targetH < H) {
      h = targetH;
      w = Math.max(1, Math.round((W * h) / H));
    }
  }

  const jpeg = await hooks.encodeJpeg(src, w, h, opts.quality);
  const before = stream.contents.length;
  report.imageBytesBefore += before;
  if (!jpeg || jpeg.length >= before) {   // not smaller: keep the original stream untouched
    report.images.keptOriginal++;
    report.imageBytesAfter += before;
    return;
  }

  const nd = ctx.obj({
    Type: "XObject", Subtype: "Image", Width: w, Height: h,
    ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode",
  });
  for (const key of [K.SMask, K.OC, K.Metadata]) {
    const v = d.get(key);
    if (v !== undefined) nd.set(key, v);
  }
  const mask = d.get(K.Mask);   // a stencil-mask stream still applies at any resolution
  if (mask instanceof PDFRef) nd.set(K.Mask, mask);
  ctx.assign(ref, PDFRawStream.of(nd, jpeg));

  report.images.reencoded++;
  if (w !== W || h !== H) report.images.downsampled++;
  report.imageBytesAfter += jpeg.length;
}

/** Decode an image XObject into something the codec can take, or { skip: reason }. */
async function readImage(ctx, stream) {
  const d = stream.dict;
  if (isTrue(d.lookup(K.ImageMask))) return { skip: "stencil mask" };
  const W = num(d.lookup(K.Width)), H = num(d.lookup(K.Height));
  if (!(W > 0 && H > 0)) return { skip: "no size" };
  if (W * H > MAX_PIXELS) return { skip: "too large to process" };
  if (d.lookup(K.Mask) instanceof PDFArray) return { skip: "color-key transparency" };
  const smask = d.lookup(K.SMask);
  if (smask instanceof PDFStream && smask.dict.has(K.Matte)) return { skip: "pre-blended transparency" };

  const { filters, parms } = filterChain(d);
  const last = filters[filters.length - 1];
  if (filters.includes(K.JPXDecode)) return { skip: "JPEG 2000" };
  if (filters.includes(K.JBIG2Decode) || filters.includes(K.CCITTFaxDecode)) return { skip: "black-and-white scan" };
  if (filters.includes(K.Crypt)) return { skip: "encrypted" };

  const cs = resolveColorSpace(ctx, d.lookup(K.ColorSpace));
  const decode = numArray(d.lookup(K.Decode));

  if (last === K.DCTDecode) {
    if (filters.slice(0, -1).some((f) => !GENERIC_FILTERS.has(f))) return { skip: "unsupported filter" };
    const bytes = await decodeChain(ctx, stream.contents, filters.slice(0, -1), parms);
    const info = jpegInfo(bytes);
    if (!info) return { skip: "damaged JPEG" };
    if (info.comps !== 1 && info.comps !== 3) return { skip: "CMYK" };
    if (decode && decode[0] > decode[1]) return { skip: "inverted colors" };
    if (cs && cs.kind === "cmyk") return { skip: "CMYK" };
    if (!cs || cs.kind === "indexed") return { skip: "unsupported color space" };   // Lab, spot colors…
    return { kind: "jpeg", bytes: stripExif(bytes), width: info.width || W, height: info.height || H };
  }

  if (filters.some((f) => !GENERIC_FILTERS.has(f))) return { skip: "unsupported filter" };
  if (!cs) return { skip: "unsupported color space" };
  if (cs.kind === "cmyk") return { skip: "CMYK" };
  const bpc = num(d.lookup(K.BitsPerComponent)) || 8;
  if (![1, 2, 4, 8, 16].includes(bpc)) return { skip: "unsupported bit depth" };
  if (bpc === 1) return { skip: "black-and-white" };   // line art and scans: JPEG would blur them

  const data = await decodeChain(ctx, stream.contents, filters, parms);
  const rgba = toRGBA(data, W, H, bpc, cs, decode);
  if (!rgba) return { skip: "damaged image data" };
  return { kind: "pixels", rgba, width: W, height: H };
}

function filterChain(d) {
  const f = d.lookup(K.Filter);
  const p = d.lookup(K.DecodeParms) || d.lookup(K.DP);
  let filters = [];
  if (f instanceof PDFName) filters = [f];
  else if (f instanceof PDFArray) filters = f.asArray().map((x) => ctxLookup(d, x)).filter((x) => x instanceof PDFName);
  filters = filters.map((x) => FILTER_ALIAS.get(x) || x);
  let parms = [];
  if (p instanceof PDFDict) parms = [p];
  else if (p instanceof PDFArray) parms = p.asArray().map((x) => { const v = ctxLookup(d, x); return v instanceof PDFDict ? v : null; });
  return { filters, parms };
}
const ctxLookup = (dict, v) => (v instanceof PDFRef ? dict.context.lookup(v) : v);

function resolveColorSpace(ctx, cs, depth = 0) {
  if (depth > 4 || !cs) return null;
  if (cs instanceof PDFRef) cs = ctx.lookup(cs);
  if (cs instanceof PDFName) {
    if (cs === K.DeviceRGB || cs === K.RGB) return { kind: "rgb", n: 3 };
    if (cs === K.DeviceGray || cs === K.G) return { kind: "gray", n: 1 };
    if (cs === K.DeviceCMYK || cs === K.CMYK) return { kind: "cmyk", n: 4 };
    return null;
  }
  if (!(cs instanceof PDFArray) || cs.size() === 0) return null;
  const family = ctx.lookup(cs.get(0));
  if (family === K.ICCBased) {
    const prof = ctx.lookup(cs.get(1));
    if (!(prof instanceof PDFStream)) return null;
    const n = num(prof.dict.lookup(K.N));
    if (n === 1) return { kind: "gray", n: 1 };
    if (n === 3) return { kind: "rgb", n: 3 };
    if (n === 4) return { kind: "cmyk", n: 4 };
    return resolveColorSpace(ctx, prof.dict.lookup(K.Alternate), depth + 1);
  }
  if (family === K.CalRGB) return { kind: "rgb", n: 3 };
  if (family === K.CalGray) return { kind: "gray", n: 1 };
  if (family === K.Indexed || family === K.I) {
    const base = resolveColorSpace(ctx, cs.get(1), depth + 1);
    if (!base || base.kind === "indexed" || base.kind === "cmyk") return null;
    const hival = Math.max(0, Math.min(255, num(ctx.lookup(cs.get(2))) | 0));
    const lut = ctx.lookup(cs.get(3));
    let table = null;
    if (lut instanceof PDFString || lut instanceof PDFHexString) table = lut.asBytes();
    else if (lut instanceof PDFRawStream) { try { table = decodePDFRawStream(lut).decode(); } catch { table = null; } }
    if (!table) return null;
    const pal = new Uint8Array(256 * 3);
    for (let i = 0; i <= hival; i++) {
      if (base.kind === "gray") { const g = table[i] || 0; pal[i * 3] = pal[i * 3 + 1] = pal[i * 3 + 2] = g; }
      else { pal[i * 3] = table[i * 3] || 0; pal[i * 3 + 1] = table[i * 3 + 1] || 0; pal[i * 3 + 2] = table[i * 3 + 2] || 0; }
    }
    return { kind: "indexed", n: 1, hival, pal };
  }
  return null;   // Lab, Separation, DeviceN, Pattern: leave the image as it is
}

/** Unpack samples (1-16 bits, any supported color space, optional /Decode) into RGBA. */
function toRGBA(data, W, H, bpc, cs, decode) {
  const nc = cs.n;
  const rowBytes = Math.ceil((W * nc * bpc) / 8);
  if (data.length < rowBytes * Math.ceil(H / 2)) return null;   // badly truncated
  const out = new Uint8ClampedArray(W * H * 4);
  const maxV = (1 << bpc) - 1;

  // Per-component lookup tables from raw sample value to 0-255 (or palette index).
  const luts = [];
  if (bpc <= 8) {
    for (let c = 0; c < nc; c++) {
      const lut = new Uint8Array(maxV + 1);
      const dmin = decode ? decode[c * 2] : 0;
      const dmax = decode ? decode[c * 2 + 1] : cs.kind === "indexed" ? maxV : 1;
      for (let v = 0; v <= maxV; v++) {
        const x = dmin + (v * (dmax - dmin)) / maxV;
        lut[v] = cs.kind === "indexed" ? Math.max(0, Math.min(cs.hival, Math.round(x))) : Math.max(0, Math.min(255, Math.round(x * 255)));
      }
      luts.push(lut);
    }
  }
  const sample16 = (v, c) => {
    const dmin = decode ? decode[c * 2] : 0;
    const dmax = decode ? decode[c * 2 + 1] : cs.kind === "indexed" ? 65535 : 1;
    const x = dmin + (v * (dmax - dmin)) / 65535;
    return cs.kind === "indexed" ? Math.max(0, Math.min(cs.hival, Math.round(x))) : Math.max(0, Math.min(255, Math.round(x * 255)));
  };

  const pal = cs.pal;
  const comp = new Uint8Array(nc);
  let o = 0;
  for (let y = 0; y < H; y++) {
    const row = y * rowBytes;
    if (bpc === 8) {
      let p = row;
      if (nc === 3 && !pal) {
        const l0 = luts[0], l1 = luts[1], l2 = luts[2];
        for (let x = 0; x < W; x++, p += 3, o += 4) {
          out[o] = l0[data[p] | 0]; out[o + 1] = l1[data[p + 1] | 0]; out[o + 2] = l2[data[p + 2] | 0]; out[o + 3] = 255;
        }
      } else {
        const l0 = luts[0];
        for (let x = 0; x < W; x++, p++, o += 4) {
          const v = l0[data[p] | 0];
          if (pal) { out[o] = pal[v * 3]; out[o + 1] = pal[v * 3 + 1]; out[o + 2] = pal[v * 3 + 2]; }
          else { out[o] = out[o + 1] = out[o + 2] = v; }
          out[o + 3] = 255;
        }
      }
      continue;
    }
    let bit = row * 8;
    for (let x = 0; x < W; x++, o += 4) {
      for (let c = 0; c < nc; c++) {
        let v;
        if (bpc === 16) { const b = bit >> 3; v = sample16(((data[b] | 0) << 8) | (data[b + 1] | 0), c); }
        else { const b = data[bit >> 3] | 0; v = luts[c][(b >> (8 - bpc - (bit & 7))) & maxV]; }
        comp[c] = v;
        bit += bpc;
      }
      if (pal) { const v = comp[0]; out[o] = pal[v * 3]; out[o + 1] = pal[v * 3 + 1]; out[o + 2] = pal[v * 3 + 2]; }
      else if (nc === 3) { out[o] = comp[0]; out[o + 1] = comp[1]; out[o + 2] = comp[2]; }
      else { out[o] = out[o + 1] = out[o + 2] = comp[0]; }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Stream decoding

async function decodeChain(ctx, bytes, filters, parms) {
  let out = bytes;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i], p = parms[i] || null;
    if (f === K.FlateDecode) out = await inflate(ctx, out);
    else out = decodeWithPdfLib(ctx, out, f, p);
    if ((f === K.FlateDecode || f === K.LZWDecode) && p) out = unpredict(out, p);
  }
  return out;
}

function decodeWithPdfLib(ctx, bytes, filter, parms) {
  const dict = ctx.obj({ Filter: filter });
  if (parms) dict.set(K.DecodeParms, parms);
  return decodePDFRawStream(PDFRawStream.of(dict, bytes)).decode();
}

/** zlib inflate: the browser's native decoder, with pdf-lib's tolerant one as a fallback. */
async function inflate(ctx, bytes) {
  if (typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream("deflate");
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    } catch { /* corrupt or trailing junk: the fallback below recovers what it can */ }
  }
  return decodeWithPdfLib(ctx, bytes, K.FlateDecode, null);
}

async function deflate(bytes) {
  const cs = new CompressionStream("deflate");
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

/** Undo a PNG (10-15) or TIFF (2) predictor. */
function unpredict(data, parms) {
  const predictor = num(parms.lookup(K.Predictor)) || 1;
  if (predictor <= 1) return data;
  const colors = num(parms.lookup(K.Colors)) || 1;
  const bpc = num(parms.lookup(K.BitsPerComponent)) || 8;
  const columns = num(parms.lookup(K.Columns)) || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((columns * colors * bpc) / 8);

  if (predictor === 2) {
    if (bpc !== 8) throw new Error("TIFF predictor with " + bpc + " bits is not supported");
    const out = data.slice();
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes)
      for (let i = bpp; i < rowBytes; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }

  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (type) {
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: v = raw;
      }
      out[dst + i] = v & 255;
    }
    prev = out.subarray(dst, dst + rowBytes);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// JPEG helpers

/** Size and component count from the first SOF marker. */
export function jpegInfo(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
    }
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** Drop EXIF (APP1) segments: PDF viewers ignore EXIF rotation, browsers would apply it. */
function stripExif(b) {
  const parts = [b.subarray(0, 2)];
  let i = 2, changed = false;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break;
    if (m === 0xff) { i++; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1) changed = true;
    else parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!changed) return b;
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------------------
// Where each image is shown: walk page content streams (and nested forms) tracking the
// current transformation matrix, and keep the largest displayed size of every image.
//
// The arithmetic deliberately copies PDFBox (which Sejda is built on): 32-bit floats for
// operands and matrix products, and a form's matrix applied as Form x CTM. Sizes that land
// on exactly .5 pixel then round the same way Sejda's do (339.74998 in double precision is
// 339.75 in float, so an image Sejda makes 680 px tall would otherwise come out 679).

const OP_BUDGET = 5e6;   // stop measuring on pathological files (forms drawn millions of times)

function measureImages(ctx, catalog) {
  const shown = new Map();       // image ref -> { w, h } in points, largest seen
  const compiled = new Map();    // stream ref -> its q/Q/cm/Do operations
  const state = { budget: OP_BUDGET };
  const record = (ref, m) => {
    const w = scaleOf(m[0], m[1]), h = scaleOf(m[3], m[2]);
    const cur = shown.get(ref);
    if (!cur) shown.set(ref, { w, h });
    else { if (h > cur.h) cur.h = h; if (w > cur.w) cur.w = w; }
  };

  let pages = 0;
  const seen = new Set();
  const walk = (node, inheritedRes, depth) => {
    if (!(node instanceof PDFDict) || depth > 64) return;
    const res = node.lookup(K.Resources) instanceof PDFDict ? node.lookup(K.Resources) : inheritedRes;
    const kids = node.lookup(K.Kids);
    if (kids instanceof PDFArray) {
      for (const kidRef of kids.asArray()) {
        if (kidRef instanceof PDFRef) { if (seen.has(kidRef)) continue; seen.add(kidRef); }
        walk(ctx.lookup(kidRef), res, depth + 1);
      }
      return;
    }
    pages++;
    const content = pageContent(ctx, node.lookup(K.Contents));
    if (content) runOps(ctx, compileOps(content), res, IDENTITY, record, compiled, new Set(), state);
  };
  walk(catalog.lookup(K.Pages), null, 0);
  return { shown, pages };
}

const f32 = Math.fround;
const IDENTITY = [1, 0, 0, 1, 0, 0];
// PDF matrices act on row vectors, so "a, then b" is mul(a, b). Float32 like PDFBox.
const mul = (a, b) => [
  f32(f32(a[0] * b[0]) + f32(a[1] * b[2])), f32(f32(a[0] * b[1]) + f32(a[1] * b[3])),
  f32(f32(a[2] * b[0]) + f32(a[3] * b[2])), f32(f32(a[2] * b[1]) + f32(a[3] * b[3])),
  f32(f32(f32(a[4] * b[0]) + f32(a[5] * b[2])) + b[4]), f32(f32(f32(a[4] * b[1]) + f32(a[5] * b[3])) + b[5]),
];
// PDFBox Matrix.getScalingFactorX/Y, made sign-free.
const scaleOf = (main, skew) => (skew !== 0 ? f32(Math.sqrt(main * main + skew * skew)) : Math.abs(main));

function pageContent(ctx, contents) {
  const parts = [];
  const add = (s) => { const b = safeDecode(s); if (b) parts.push(b); };
  if (contents instanceof PDFRawStream) add(contents);
  else if (contents instanceof PDFArray) for (const r of contents.asArray()) { const s = ctx.lookup(r); if (s instanceof PDFRawStream) add(s); }
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}

function safeDecode(stream) {
  try { return decodePDFRawStream(stream).decode(); } catch { return null; }
}

/** Reduce a content stream to the operations that move images: q, Q, cm and Do. */
function compileOps(bytes) {
  const ops = [];
  walkOps(bytes, (op, args) => {
    if (op === "q" || op === "Q") ops.push(op);
    else if (op === "cm") {
      if (args.length >= 6) {
        const m = args.slice(-6).map((x) => (typeof x === "number" ? f32(x) : NaN));
        if (m.every(isFinite)) ops.push(m);
      }
    } else if (op === "Do") {
      const name = args[args.length - 1];
      if (typeof name === "string") ops.push({ name });
    }
  });
  return ops;
}

/** Replay operations from a starting CTM, reporting every image drawn and where. */
function runOps(ctx, ops, resources, start, emit, compiled, visiting, state) {
  let ctm = start;
  const stack = [];
  const xobjects = resources instanceof PDFDict ? resources.lookup(K.XObject) : undefined;
  for (const op of ops) {
    if (--state.budget < 0) return;
    if (op === "q") stack.push(ctm);
    else if (op === "Q") { if (stack.length) ctm = stack.pop(); }
    else if (Array.isArray(op)) ctm = mul(op, ctm);
    else {
      if (!(xobjects instanceof PDFDict)) continue;
      const ref = xobjects.get(PDFName.of(op.name));
      if (!(ref instanceof PDFRef)) continue;
      const xo = ctx.lookup(ref);
      if (!(xo instanceof PDFRawStream)) continue;
      const st = xo.dict.lookup(K.Subtype);
      if (st === K.Image) emit(ref, ctm);
      else if (st === K.Form && !visiting.has(ref) && visiting.size < 32) {
        let formOps = compiled.get(ref);
        if (!formOps) {
          const bytes = safeDecode(xo);
          formOps = bytes ? compileOps(bytes) : [];
          compiled.set(ref, formOps);
        }
        const own = xo.dict.lookup(K.Resources);
        const mx = numArray(xo.dict.lookup(K.Matrix));
        const formCtm = mx && mx.length === 6 ? mul(mx.map(f32), ctm) : ctm;
        visiting.add(ref);
        runOps(ctx, formOps, own instanceof PDFDict ? own : resources, formCtm, emit, compiled, visiting, state);
        visiting.delete(ref);
      }
    }
  }
}

// Content stream tokenizer: calls onOp(operator, operands). Operands keep numbers and names
// (names as their raw text without the slash); anything else is a null placeholder.
const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

function latin1(b, s, e) {
  let str = "";
  for (let i = s; i < e; i++) str += String.fromCharCode(b[i]);
  return str;
}

export function walkOps(b, onOp) {
  const n = b.length;
  const args = [];
  let depth = 0;   // inside [ ] or << >>: operands there are not tracked
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (WS[c]) { i++; continue; }
    if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }   // % comment
    if (c === 0x28) {   // ( literal string )
      let lvl = 1; i++;
      while (i < n && lvl > 0) {
        const d = b[i];
        if (d === 0x5c) i += 2;
        else { if (d === 0x28) lvl++; else if (d === 0x29) lvl--; i++; }
      }
      if (!depth) args.push(null);
      continue;
    }
    if (c === 0x3c) {   // << or <hex>
      if (b[i + 1] === 0x3c) { depth++; i += 2; continue; }
      while (i < n && b[i] !== 0x3e) i++;
      i++;
      if (!depth) args.push(null);
      continue;
    }
    if (c === 0x3e) { if (b[i + 1] === 0x3e) { i += 2; if (depth) depth--; if (!depth) args.push(null); } else i++; continue; }
    if (c === 0x5b) { depth++; i++; continue; }
    if (c === 0x5d) { i++; if (depth) depth--; if (!depth) args.push(null); continue; }
    if (c === 0x7b || c === 0x7d || c === 0x29) { i++; continue; }
    let j = i + 1;
    while (j < n && !WS[b[j]] && !DELIM[b[j]]) j++;
    if (c === 0x2f) { if (!depth) args.push(latin1(b, i + 1, j)); i = j; continue; }   // /Name
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (!depth) args.push(parseFloat(latin1(b, i, j)));
      i = j;
      continue;
    }
    if (!depth) {
      const op = latin1(b, i, j);
      if (op === "true" || op === "false" || op === "null") args.push(null);
      else if (op === "BI") { j = skipInlineImage(b, j); args.length = 0; }
      else { onOp(op, args); args.length = 0; }
    }
    i = j;
  }
}

function skipInlineImage(b, i) {
  const n = b.length;
  // find the ID keyword that ends the inline image dictionary
  for (; i + 2 < n; i++) {
    if (b[i] === 0x49 && b[i + 1] === 0x44 && (WS[b[i - 1]] || DELIM[b[i - 1]]) && WS[b[i + 2]]) { i += 3; break; }
  }
  // the data runs until a whitespace-delimited EI
  for (; i + 1 < n; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && WS[b[i - 1]] && (i + 2 >= n || WS[b[i + 2]] || DELIM[b[i + 2]])) return i + 2;
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// Lossless clean-up

function stripExtras(ctx, catalog) {
  catalog.delete(K.StructTreeRoot);   // accessibility tags (Sejda drops them too)
  catalog.delete(K.PieceInfo);
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!d) continue;
    const type = d.get(K.Type);
    if (type === N("Page")) { d.delete(K.Thumb); d.delete(K.PieceInfo); }
    else if (d.get(K.Subtype) === K.Form) d.delete(K.PieceInfo);
  }
}

/** Store byte-identical streams once and point every reference at the survivor. */
function dedupeStreams(ctx) {
  let merged = 0;
  for (let pass = 0; pass < 4; pass++) {
    const groups = new Map();
    const remap = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const key = obj.contents.length + "|" + dictKey(obj.dict);
      const list = groups.get(key);
      if (!list) { groups.set(key, [[ref, obj]]); continue; }
      const twin = list.find(([, o]) => sameBytes(o.contents, obj.contents));
      if (twin) remap.set(ref, twin[0]);
      else list.push([ref, obj]);
    }
    if (!remap.size) break;
    rewriteRefs(ctx, remap);
    for (const ref of remap.keys()) ctx.delete(ref);
    merged += remap.size;
  }
  return merged;
}

function dictKey(dict) {
  let s = "";
  for (const [k, v] of dict.entries()) if (k !== K.Length) s += k.toString() + " " + v.toString() + "\n";
  return s;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rewriteRefs(ctx, remap) {
  const done = new WeakSet();   // never rewrite a shared container twice
  const fix = (obj) => {
    if (!obj || typeof obj !== "object" || done.has(obj)) return;
    done.add(obj);
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) {
        if (v instanceof PDFRef) { const t = remap.get(v); if (t) obj.set(k, t); }
        else fix(v);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        if (v instanceof PDFRef) { const t = remap.get(v); if (t) obj.set(i, t); }
        else fix(v);
      }
    } else if (obj instanceof PDFStream) fix(obj.dict);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
}

/** Deflate streams stored without any filter (content, fonts, leftovers), when it helps. */
async function deflateRawStreams(ctx) {
  if (typeof CompressionStream === "undefined") return 0;
  let count = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.has(K.Filter) || d.has(K.DecodeParms) || d.get(K.Type) === K.Metadata) continue;
    if (obj.contents.length < 64) continue;
    const packed = await deflate(obj.contents);
    if (packed.length + 20 >= obj.contents.length) continue;
    const nd = ctx.obj({});
    for (const [k, v] of d.entries()) nd.set(k, v);
    nd.set(K.Filter, K.FlateDecode);
    ctx.assign(ref, PDFRawStream.of(nd, packed));
    count++;
  }
  return count;
}

/** Delete every object that can't be reached from the trailer. */
function collectGarbage(ctx) {
  const live = new Set();
  const todo = [];
  const visit = (obj) => {
    if (obj instanceof PDFRef) { if (!live.has(obj)) { live.add(obj); todo.push(obj); } }
    else if (obj instanceof PDFDict) { for (const [, v] of obj.entries()) visit(v); }
    else if (obj instanceof PDFArray) { for (const v of obj.asArray()) visit(v); }
    else if (obj instanceof PDFStream) visit(obj.dict);
  };
  const t = ctx.trailerInfo;
  for (const r of [t.Root, t.Info, t.Encrypt]) if (r) visit(r);
  while (todo.length) visit(ctx.lookup(todo.pop()));
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!live.has(ref)) { ctx.delete(ref); removed++; }
  return removed;
}

/** Number the surviving objects 1..n, generation 0, so the cross-reference table has no gaps. */
function renumber(ctx) {
  const entries = ctx.enumerateIndirectObjects();
  const remap = new Map();
  entries.forEach(([ref], i) => remap.set(ref, PDFRef.of(i + 1, 0)));
  rewriteRefs(ctx, remap);
  ctx.indirectObjects.clear();
  for (const [ref, obj] of entries) ctx.indirectObjects.set(remap.get(ref), obj);
  ctx.largestObjectNumber = entries.length;
  const t = ctx.trailerInfo;
  for (const key of ["Root", "Info", "Encrypt"]) if (t[key] instanceof PDFRef) t[key] = remap.get(t[key]) || t[key];
}

// ---------------------------------------------------------------------------------------
// Small helpers

function num(v) { return v instanceof PDFNumber ? v.asNumber() : typeof v === "number" ? v : 0; }
function isTrue(v) { return v instanceof PDFBool ? v.asBoolean() : false; }
function numArray(v) {
  if (!(v instanceof PDFArray)) return null;
  const a = v.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
  return a.every(isFinite) ? a : null;
}
