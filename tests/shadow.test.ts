import test from 'node:test';
import assert from 'node:assert/strict';
import { composeShadow, extractShadow } from '../src/shadow';

function studio(background = 240) {
  const w = 128;
  const h = 128;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const object = x >= 48 && x < 80 && y >= 48 && y < 80;
      const colour = object ? 100 : background;
      rgba.set([colour, colour, colour, 255], i * 4);
      alpha[i] = object ? 1 : 0;
    }
  }
  return { rgba, alpha, w, h };
}

test('a plain plate adds no shadow; a nearby dark patch becomes a soft shadow', () => {
  const { rgba, alpha, w, h } = studio();
  const clean = extractShadow(rgba, alpha, w, h)!;
  assert.ok(clean);
  assert.ok(clean.every((value) => Math.abs(value) < 1e-5));
  for (let y = 80; y < 94; y++) for (let x = 52; x < 84; x++) rgba.set([145, 145, 145, 255], (y * w + x) * 4);
  const shadow = extractShadow(rgba, alpha, w, h)!;
  assert.ok(shadow);
  assert.ok(shadow[84 * w + 64] > 0.1);
  assert.equal(shadow[0], 0);
  assert.ok(shadow.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
});

test('dark and non-plain backgrounds skip shadow extraction', () => {
  const dark = studio(30);
  assert.equal(extractShadow(dark.rgba, dark.alpha, dark.w, dark.h), undefined);
  const textured = studio();
  for (let y = 0; y < textured.h; y++) for (let x = 0; x < textured.w; x++) {
    const i = y * textured.w + x;
    if (textured.alpha[i]) continue;
    const c = 180 + 65 * Math.sin(x / 9) * Math.cos(y / 11);
    textured.rgba.set([c, c, c, 255], i * 4);
  }
  assert.equal(extractShadow(textured.rgba, textured.alpha, textured.w, textured.h), undefined);
});

test('shadow composition preserves opaque colours and uses straight alpha at soft edges', () => {
  const rgba = new Uint8ClampedArray([200, 100, 50, 255, 180, 90, 45, 128, 255, 255, 255, 0]);
  composeShadow(rgba, new Float32Array([0.5, 0.5, 0.25]));
  assert.deepEqual([...rgba.slice(0, 4)], [200, 100, 50, 255]);
  const alpha = 128 / 255;
  const out = alpha + 0.5 * (1 - alpha);
  const expected = new Uint8ClampedArray([180 * alpha / out, 90 * alpha / out, 45 * alpha / out, out * 255]);
  assert.deepEqual(rgba.slice(4, 8), expected);
  assert.deepEqual([...rgba.slice(8)], [0, 0, 0, 64]);
});
