import test from 'node:test';
import assert from 'node:assert/strict';
import { downscaleMask, downscaleRgba, previewScale } from '../src/preview';

test('previewScale shrinks the long side and never enlarges', () => {
  assert.equal(previewScale(2000, 1000, 500), 0.25);
  assert.equal(previewScale(300, 400, 1000), 1);
});

test('downscaleRgba averages blocks and weights colours by alpha', () => {
  // 4×2 image: left half red and opaque, right half transparent with a black colour.
  const src = new Uint8ClampedArray(4 * 2 * 4);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
    if (x < 2) src.set([255, 0, 0, 255], (y * 4 + x) * 4);
  }
  const out = downscaleRgba(src, 4, 2, 2, 1);
  assert.deepEqual([...out], [255, 0, 0, 255, 0, 0, 0, 0]);
  // A block that is half opaque red and half transparent black stays red at half alpha.
  const mixed = downscaleRgba(src, 4, 2, 1, 1);
  assert.deepEqual([...mixed], [255, 0, 0, 128]);
});

test('downscaleMask averages blocks, also with uneven block sizes', () => {
  const src = Float32Array.from([1, 1, 0, 0, 0, 1, 1, 1, 0, 0]);
  const out = downscaleMask(src, 5, 2, 2, 1);
  // Blocks are columns 0..1 and 2..4.
  assert.equal(out[0], 1);
  assert.ok(Math.abs(out[1] - 1 / 6) < 1e-6);
});
