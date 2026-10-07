// Minimal RGBA PNG encoder.
//
// canvas.convertToBlob() stores pixels premultiplied, which destroys colour
// precision in semi-transparent pixels (exactly the hair and edge pixels we
// care about). Encoding the straight-alpha buffer ourselves keeps them exact.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies the Paeth filter to every row. Fully transparent pixels are zeroed first so they compress well. */
function filter(rgba: Uint8ClampedArray, w: number, h: number) {
  const stride = w * 4;
  const out = new Uint8Array((stride + 1) * h);
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 0) rgba[i - 3] = rgba[i - 2] = rgba[i - 1] = 0;
  }
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const prev = row - stride;
    const o = y * (stride + 1);
    out[o] = 4; // Paeth
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[row + x - 4] : 0;
      const b = y > 0 ? rgba[prev + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[prev + x - 4] : 0;
      out[o + 1 + x] = rgba[row + x] - paeth(a, b, c);
    }
  }
  return out;
}

export async function encodePng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = filter(rgba, w, h);
  const compressed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
  // sRGB chunk: createImageBitmap() already converted the pixels to sRGB.
  const srgb = new Uint8Array([0]);
  return new Blob(
    [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('sRGB', srgb),
      chunk('IDAT', compressed),
      chunk('IEND', new Uint8Array(0)),
    ],
    { type: 'image/png' },
  );
}
