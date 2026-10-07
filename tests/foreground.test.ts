import test from 'node:test';
import assert from 'node:assert/strict';
import { BlurWorkspace, boxBlur, refineForeground } from '../src/foreground';

// Independent direct average; no sliding-window or ring-buffer logic.
function average(src: Float32Array, w: number, h: number, r: number) {
  return Float32Array.from(src, (_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    let sum = 0;
    let count = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
        sum += src[yy * w + xx];
        count++;
      }
    }
    return sum / count;
  });
}

test('box blur matches direct averages, including tiny images and reused workspaces', () => {
  const scratch = new BlurWorkspace();
  for (const [w, h] of [[11, 9], [1, 8], [7, 1], [1, 1], [3, 4]]) {
    const src = Float32Array.from({ length: w * h }, (_, i) => (i * 37 % 101) / 100);
    for (const r of [0, 1, 2, 6, 90]) {
      const actual = new Float32Array(src.length);
      boxBlur(src, actual, w, h, r, scratch);
      const expected = average(src, w, h, r);
      for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${w}×${h}, radius ${r}, pixel ${i}`);
    }
  }
});

test('tiled refinement has no seams and matches a full-image pass', () => {
  const w = 385;
  const h = 273;
  const alpha = Float32Array.from({ length: w * h }, (_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return Math.max(0, Math.min(1, (100 - Math.hypot(x - 190, y - 135)) / 12));
  });
  const input = Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 17 + Math.floor(i / (w * 4)) * 23) % 256);
  const full = input.slice();
  const tiled = input.slice();
  refineForeground(full, alpha, w, h, Math.max(w, h));
  refineForeground(tiled, alpha, w, h, 64);
  let maxDifference = 0;
  for (let i = 0; i < full.length; i++) maxDifference = Math.max(maxDifference, Math.abs(full[i] - tiled[i]));
  assert.ok(maxDifference <= 1, `maximum channel difference ${maxDifference}`);
});

test('refinement preserves opaque colours and writes the requested alpha', () => {
  const w = 37;
  const h = 29;
  const opaque = Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => i % 4 === 3 ? 255 : i * 31 % 256);
  const expected = opaque.slice();
  refineForeground(opaque, new Float32Array(w * h).fill(1), w, h, 8);
  assert.deepEqual(opaque, expected);
  const alpha = Float32Array.from({ length: w * h }, (_, i) => (i % 101) / 100);
  refineForeground(opaque, alpha, w, h, 8);
  const rounded = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) rounded[i] = alpha[i] * 255;
  for (let i = 0; i < alpha.length; i++) assert.equal(opaque[i * 4 + 3], rounded[i]);
});
