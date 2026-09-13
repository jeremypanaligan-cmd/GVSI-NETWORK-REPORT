/* ------------------------------------------------------------------
   GVSI NetPulse — icon optimizer

   The PWA icons were shipped straight out of a design tool: 512x512 RGBA at
   ~87 KB each, one of them byte-for-byte duplicated as the Apple touch icon,
   for 202 KB in the precache — more than every .js and .css file combined.

   There is no ImageMagick / pngquant / sharp on the build machine and this
   project has no build step, so this is a self-contained encoder built on
   Node's zlib only. It reports candidate sizes and can write the result.

     node tools/optimize-icons.js --measure     # sizes only, nothing written
     node tools/optimize-icons.js               # write the optimized icons

   What it does, and why each step matters:

     • Downscale with a premultiplied box filter. Resizing straight RGBA
       pulls the colour of fully-transparent pixels into the visible edge,
       which shows up as a dark fringe around the logo.
     • Quantize RGB with median cut while keeping 8-bit alpha. The source has
       ~3700 unique colours, most of them imperceptible noise along the
       gradient; collapsing them is where the bytes are. Alpha is left alone
       because PNG-8 can only express ONE transparent index and these icons
       have anti-aliased edges (187 distinct alpha values) — paletting them
       would harden the edges.
     • Re-encode with per-row adaptive filtering plus zlib level 9. The
       original used a single filter choice for the whole image.

   The output is still PNG (color type 6); only the pixel count and the
   colour precision change. Regenerate with this file, not by hand.
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

/* ---------------- PNG decode ---------------- */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let offset = 8;
  let ihdr = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) {
    throw new Error('only 8-bit non-interlaced PNGs are supported');
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error('unsupported colour type ' + ihdr.color);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.width * channels;
  const out = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = Buffer.alloc(stride);

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }

    cur.copy(out, y * stride);
    prev = cur;
  }

  // Normalise to RGBA so the rest of the pipeline has one shape to handle.
  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, n = ihdr.width * ihdr.height; i < n; i++) {
    const s = i * channels, d = i * 4;
    if (ihdr.color === 6) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3];
    } else if (ihdr.color === 2) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255;
    } else if (ihdr.color === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255;
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1];
    }
  }

  return { width: ihdr.width, height: ihdr.height, data: rgba };
}

/* ---------------- downscale ---------------- */

// Box filter over premultiplied colour. Averaging un-premultiplied RGBA would
// weight the (often black) fully-transparent pixels as if they were visible.
function downscale(img, dstW, dstH) {
  const { width: srcW, height: srcH, data: src } = img;
  if (dstW === srcW && dstH === srcH) return img;

  const dst = Buffer.alloc(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * srcW + sx) * 4;
          const alpha = src[s + 3] / 255;
          r += src[s] * alpha;
          g += src[s + 1] * alpha;
          b += src[s + 2] * alpha;
          a += src[s + 3];
          n++;
        }
      }

      const d = (y * dstW + x) * 4;
      const alphaSum = a / n;
      if (alphaSum > 0) {
        const scale = 255 / a;
        dst[d] = Math.round(r * scale);
        dst[d + 1] = Math.round(g * scale);
        dst[d + 2] = Math.round(b * scale);
      }
      dst[d + 3] = Math.round(alphaSum);
    }
  }

  return { width: dstW, height: dstH, data: dst };
}

/* ---------------- colour quantization (median cut) ---------------- */

// Colour histogram of the visible pixels only: a transparent pixel's RGB is
// meaningless and would otherwise dominate a cluster.
function colourHistogram(img) {
  const { data } = img;
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  return hist;
}

function medianCut(hist, maxColours) {
  const entries = [];
  for (const [key, count] of hist) {
    entries.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, count });
  }

  if (entries.length <= maxColours) {
    return entries.map((e) => [e.r, e.g, e.b]);
  }

  let boxes = [entries];

  while (boxes.length < maxColours) {
    // Split the box with the widest colour span; a box of one pixel can't split.
    let target = -1, targetSpan = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (const e of box) {
        if (e.r < rMin) rMin = e.r; if (e.r > rMax) rMax = e.r;
        if (e.g < gMin) gMin = e.g; if (e.g > gMax) gMax = e.g;
        if (e.b < bMin) bMin = e.b; if (e.b > bMax) bMax = e.b;
      }
      const span = Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
      if (span > targetSpan) { targetSpan = span; target = i; }
    }
    if (target < 0) break;

    const box = boxes[target];
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const e of box) {
      if (e.r < rMin) rMin = e.r; if (e.r > rMax) rMax = e.r;
      if (e.g < gMin) gMin = e.g; if (e.g > gMax) gMax = e.g;
      if (e.b < bMin) bMin = e.b; if (e.b > bMax) bMax = e.b;
    }
    const spans = [rMax - rMin, gMax - gMin, bMax - bMin];
    const axis = spans.indexOf(Math.max(...spans));
    const prop = ['r', 'g', 'b'][axis];

    box.sort((x, y) => x[prop] - y[prop]);

    // Split at the weighted median so both halves carry similar pixel mass.
    const total = box.reduce((sum, e) => sum + e.count, 0);
    let acc = 0, cut = 0;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].count;
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    if (cut <= 0 || cut >= box.length) cut = box.length >> 1;

    boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
  }

  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of box) {
      r += e.r * e.count; g += e.g * e.count; b += e.b * e.count; n += e.count;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function quantize(img, maxColours) {
  const palette = medianCut(colourHistogram(img), maxColours);
  const cache = new Map();
  const out = Buffer.from(img.data);

  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    let best = cache.get(key);
    if (best === undefined) {
      best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const dr = out[i] - palette[p][0];
        const dg = out[i + 1] - palette[p][1];
        const db = out[i + 2] - palette[p][2];
        const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      cache.set(key, best);
    }
    out[i] = palette[best][0];
    out[i + 1] = palette[best][1];
    out[i + 2] = palette[best][2];
  }

  return out;
}

/* ---------------- PNG encode ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
};

// Standard "minimum sum of absolute differences" heuristic: try every filter on
// the row and keep the one whose filtered bytes are closest to zero, which is
// what deflate then compresses best.
function filterRow(line, prev, bpp) {
  const stride = line.length;
  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const raw = line[i];
    candidates[0][i] = raw;
    candidates[1][i] = (raw - a) & 255;
    candidates[2][i] = (raw - b) & 255;
    candidates[3][i] = (raw - ((a + b) >> 1)) & 255;
    candidates[4][i] = (raw - paeth(a, b, c)) & 255;
  }

  let best = 0, bestScore = Infinity;
  for (let f = 0; f < 5; f++) {
    let score = 0;
    for (let i = 0; i < stride; i++) {
      const v = candidates[f][i];
      score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) { bestScore = score; best = f; }
  }

  return { filter: best, data: candidates[best] };
}

function encodePng(img) {
  const { width, height, data } = img;
  const bpp = 4;
  const stride = width * bpp;

  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = data.subarray(y * stride, (y + 1) * stride);
    const filtered = filterRow(line, prev, bpp);
    rows.push(Buffer.from([filtered.filter]), filtered.data);
    prev = line;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: truecolour + alpha
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter method
  ihdr[12] = 0;   // no interlace

  const deflated = zlib.deflateSync(Buffer.concat(rows), { level: 9, memLevel: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- what we ship ---------------- */

// `colours: null` keeps the source colours and only re-encodes.
const TARGETS = [
  { file: 'icon-512.png',       size: 512, colours: 128 },
  { file: 'icon-192.png',       size: 192, colours: 128 },
  // Apple's own touch icon size. The shipped file was a second copy of the
  // 512 — same md5 — so those 87 KB bought nothing.
  { file: 'apple-touch-icon.png', size: 180, colours: 128, source: 'icon-512.png' }
];

function build(target) {
  const source = path.join(ROOT, target.source || target.file);
  const original = fs.readFileSync(source);
  const decoded = decodePng(original);
  const scaled = downscale(decoded, target.size, target.size);
  const pixels = target.colours === null ? scaled.data : quantize(scaled, target.colours);
  const png = encodePng({ width: target.size, height: target.size, data: pixels });
  return { original: original.length, png, decoded, scaled };
}

function main() {
  const measureOnly = process.argv.includes('--measure');

  // Build every output BEFORE writing any of them. The Apple icon is derived from
  // icon-512.png, and an earlier version wrote as it went — so it re-quantized the
  // already-quantized 512 and then reported the smaller file as its own "before".
  const results = TARGETS.map((target) => Object.assign({ target }, build(target)));

  let originalTotal = 0, optimizedTotal = 0;

  for (const { target, original, png } of results) {
    originalTotal += original;
    optimizedTotal += png.length;
    const pct = original ? Math.round((1 - png.length / original) * 100) : 0;
    console.log(
      target.file.padEnd(22) +
      String(target.size + 'x' + target.size).padEnd(10) +
      String(target.colours === null ? 'src' : target.colours + ' colours').padEnd(14) +
      (original / 1024).toFixed(1).padStart(7) + ' KB -> ' +
      (png.length / 1024).toFixed(1).padStart(6) + ' KB  (-' + pct + '%)' +
      (measureOnly ? '' : '  written')
    );

    if (!measureOnly) fs.writeFileSync(path.join(ROOT, target.file), png);
  }

  console.log('-'.repeat(74));
  console.log('precache total (' + results.length + ' icons): ' + (originalTotal / 1024).toFixed(1) +
    ' KB -> ' + (optimizedTotal / 1024).toFixed(1) + ' KB  (-' +
    Math.round((1 - optimizedTotal / originalTotal) * 100) + '%)');
}

if (require.main === module) main();

module.exports = { decodePng, downscale, quantize, encodePng, build, TARGETS };
