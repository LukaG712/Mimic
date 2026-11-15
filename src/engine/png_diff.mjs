/**
 * Zero-dependency PNG pixel diffing utility (uses Node built-in zlib).
 * Supports 8-bit RGB (colorType 2) and RGBA (colorType 6) PNGs emitted by Chrome CDP.
 */

import fs from 'fs';
import zlib from 'zlib';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([lenBuf, combined, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer) {
  if (!buffer || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(width * height * 4);

  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const val = raw[rowStart + 1 + x];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;

      if (filter === 0) row[x] = val;
      else if (filter === 1) row[x] = (val + a) & 0xff;
      else if (filter === 2) row[x] = (val + b) & 0xff;
      else if (filter === 3) row[x] = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) row[x] = (val + paethPredictor(a, b, c)) & 0xff;
      else throw new Error(`Unsupported PNG filter type ${filter}`);
    }

    for (let px = 0; px < width; px++) {
      const srcIdx = px * bpp;
      const dstIdx = (y * width + px) * 4;
      rgba[dstIdx] = row[srcIdx];
      rgba[dstIdx + 1] = row[srcIdx + 1];
      rgba[dstIdx + 2] = row[srcIdx + 2];
      rgba[dstIdx + 3] = bpp === 4 ? row[srcIdx + 3] : 255;
    }

    prevRow = row;
  }

  return { width, height, data: rgba };
}

export function encodeRgbaPng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter 0
    rgba.copy(raw, dst + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Compares two PNG files and returns diff metrics.
 * Optionally writes a visual diff image highlighting mismatched pixels in red.
 */
export function comparePngFiles(baselinePath, currentPath, options = {}) {
  const threshold = options.threshold ?? 16; // per-channel tolerance (0-255)
  const imgA = decodePng(fs.readFileSync(baselinePath));
  const imgB = decodePng(fs.readFileSync(currentPath));

  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);
  const totalPixels = Math.max(imgA.width * imgA.height, imgB.width * imgB.height);
  const dimensionMismatch = imgA.width !== imgB.width || imgA.height !== imgB.height;

  let mismatchedPixels = dimensionMismatch
    ? Math.abs(imgA.width * imgA.height - imgB.width * imgB.height)
    : 0;

  const diffBuf = options.diffOutputPath ? Buffer.alloc(width * height * 4) : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idxA = (y * imgA.width + x) * 4;
      const idxB = (y * imgB.width + x) * 4;
      const dr = Math.abs(imgA.data[idxA] - imgB.data[idxB]);
      const dg = Math.abs(imgA.data[idxA + 1] - imgB.data[idxB + 1]);
      const db = Math.abs(imgA.data[idxA + 2] - imgB.data[idxB + 2]);
      const isDiff = dr > threshold || dg > threshold || db > threshold;

      if (isDiff) {
        mismatchedPixels++;
        if (diffBuf) {
          const dIdx = (y * width + x) * 4;
          diffBuf[dIdx] = 239;
          diffBuf[dIdx + 1] = 68;
          diffBuf[dIdx + 2] = 68;
          diffBuf[dIdx + 3] = 255;
        }
      } else if (diffBuf) {
        const dIdx = (y * width + x) * 4;
        diffBuf[dIdx] = imgB.data[idxB] >> 1;
        diffBuf[dIdx + 1] = imgB.data[idxB + 1] >> 1;
        diffBuf[dIdx + 2] = imgB.data[idxB + 2] >> 1;
        diffBuf[dIdx + 3] = 255;
      }
    }
  }

  if (options.diffOutputPath && diffBuf && width > 0 && height > 0) {
    fs.writeFileSync(options.diffOutputPath, encodeRgbaPng(width, height, diffBuf));
  }

  const diffPercent = totalPixels > 0
    ? Number(((mismatchedPixels / totalPixels) * 100).toFixed(2))
    : 0;

  return {
    totalPixels,
    mismatchedPixels,
    diffPercent,
    dimensionMismatch,
    baselineSize: `${imgA.width}x${imgA.height}`,
    currentSize: `${imgB.width}x${imgB.height}`
  };
}
