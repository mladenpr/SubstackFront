'use strict';

// A minimal PNG reader, so the icon tests can assert on actual pixels without
// adding a dependency. Handles what scripts/make-icons.py writes: 8-bit,
// non-interlaced, RGB or RGBA.

const fs = require('node:fs');
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPES = { 0: 'grayscale', 2: 'rgb', 3: 'palette', 4: 'grayscale+alpha', 6: 'rgba' };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undo the per-scanline filters PNG applies before compression. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;

      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);

      out[y * stride + x] = value & 0xff;
    }
  }

  return out;
}

/**
 * Read a PNG into { width, height, colorType, pixels, at(x, y) }.
 * at() returns [r, g, b, a], with a = 255 for images without an alpha channel.
 */
function readPng(file) {
  const data = fs.readFileSync(file);
  if (!data.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${file} is not a PNG`);
  }

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const bitDepth = data[24];
  const colorType = data[25];
  const interlace = data[28];

  const idat = [];
  let offset = 8;
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(data.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += length + 12;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `${file}: only 8-bit non-interlaced RGB/RGBA is supported ` +
      `(got depth ${bitDepth}, ${COLOR_TYPES[colorType]}, interlace ${interlace})`
    );
  }

  const bpp = colorType === 6 ? 4 : 3;
  const pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, bpp);

  return {
    width,
    height,
    colorType,
    colorTypeName: COLOR_TYPES[colorType],
    hasAlpha: colorType === 6,
    bytes: data.length,
    at(x, y) {
      const i = (y * width + x) * bpp;
      return [pixels[i], pixels[i + 1], pixels[i + 2], bpp === 4 ? pixels[i + 3] : 255];
    },
    /** Every pixel, as [r, g, b, a]. */
    all() {
      const out = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) out.push(this.at(x, y));
      }
      return out;
    }
  };
}

module.exports = { readPng, COLOR_TYPES };
