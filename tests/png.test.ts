import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../src/png';

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Decode the PNG independently: verify chunks and reverse its row filters.
async function decode(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed: Buffer[] = [];
  const types: string[] = [];
  let width = 0;
  let height = 0;
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    assert.equal(bytes.readUInt32BE(offset + 8 + size), crc32(bytes.subarray(offset + 4, offset + 8 + size)));
    types.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]);
    }
    if (type === 'IDAT') compressed.push(data);
    offset += size + 12;
  }
  assert.deepEqual(types, ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= 4 ? pixels[i - 4] : 0;
      const above = y ? pixels[i - stride] : 0;
      const corner = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const prediction = left + above - corner;
      const distances = [left, above, corner].map((v) => Math.abs(prediction - v));
      const nearest = Math.min(...distances);
      const predictor = [left, above, corner][distances.indexOf(nearest)];
      pixels[i] = raw[y * (stride + 1) + 1 + x] + predictor;
    }
  }
  return { width, height, pixels };
}

test('PNG round trip preserves exact RGB at partial alpha and validates every chunk', async () => {
  const w = 8;
  const h = 4;
  const alphas = [0, 1, 2, 64, 127, 128, 254, 255];
  const input = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) input.set([i * 53 % 256, (i * 97 + 11) % 256, (i * 7 + 243) % 256, alphas[i % alphas.length]], i * 4);
  const expected = input.slice();
  for (let i = 0; i < w * h; i++) if (!expected[i * 4 + 3]) expected.fill(0, i * 4, i * 4 + 3);
  const blob = await encodePng(input, w, h);
  assert.equal(blob.type, 'image/png');
  const decoded = await decode(blob);
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.deepEqual([...decoded.pixels], [...expected]);
});

test('a single pixel PNG is valid', async () => {
  const input = new Uint8ClampedArray([213, 71, 39, 1]);
  const decoded = await decode(await encodePng(input, 1, 1));
  assert.deepEqual([...decoded.pixels], [...input]);
});
