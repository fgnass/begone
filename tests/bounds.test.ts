import test from 'node:test';
import assert from 'node:assert/strict';
import { contentBounds, cropRgba } from '../src/bounds';

function image(w: number, h: number, opaque: [number, number][]) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (const [x, y] of opaque) rgba.set([x, y, 7, 1], (y * w + x) * 4);
  return rgba;
}

test('contentBounds finds the smallest rectangle with visible pixels', () => {
  const rgba = image(10, 8, [[3, 2], [7, 4], [5, 6]]);
  assert.deepEqual(contentBounds(rgba, 10, 8), { x: 3, y: 2, w: 5, h: 5 });
});

test('contentBounds covers the full image and returns undefined for empty images', () => {
  assert.deepEqual(contentBounds(image(4, 3, [[0, 0], [3, 2]]), 4, 3), { x: 0, y: 0, w: 4, h: 3 });
  assert.equal(contentBounds(image(4, 3, []), 4, 3), undefined);
});

test('cropRgba copies the pixels inside the bounds', () => {
  const rgba = image(10, 8, [[3, 2], [7, 4], [5, 6]]);
  const bounds = contentBounds(rgba, 10, 8)!;
  const out = cropRgba(rgba, 10, bounds);
  assert.equal(out.length, 5 * 5 * 4);
  assert.deepEqual([...out.subarray(0, 4)], [3, 2, 7, 1]);
  assert.deepEqual([...out.subarray((2 * 5 + 4) * 4, (2 * 5 + 4) * 4 + 4)], [7, 4, 7, 1]);
  assert.deepEqual([...out.subarray((4 * 5 + 2) * 4, (4 * 5 + 2) * 4 + 4)], [5, 6, 7, 1]);
  assert.equal(out.filter((_, i) => i % 4 === 3).reduce((a, b) => a + b), 3);
});
