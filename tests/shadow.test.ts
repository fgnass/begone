import test from 'node:test';
import assert from 'node:assert/strict';
import { composeShadow, extractShadow, shadowColor, softenShadow } from '../src/shadow';

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

test('a plain plate has no shadow; a nearby dark patch becomes a soft neutral shadow', () => {
  const { rgba, alpha, w, h } = studio();
  assert.equal(extractShadow(rgba, alpha, w, h), undefined);
  for (let y = 80; y < 94; y++) for (let x = 52; x < 84; x++) rgba.set([145, 145, 145, 255], (y * w + x) * 4);
  const shadow = extractShadow(rgba, alpha, w, h)!;
  assert.ok(shadow);
  assert.ok(shadow.mask[84 * w + 64] > 0.1);
  assert.equal(shadow.mask[0], 0);
  assert.ok(shadow.mask.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.equal(shadow.extent, 16);
  assert.ok(Math.abs(shadow.temperature) < 0.1, `grey shadow is neutral: ${shadow.temperature}`);
  assert.ok(shadow.color.every((c) => c < 0.05), `neutral shadow layer is black: ${shadow.color}`);
});

test('the colour of the shadow is measured, and the temperature slider shifts it', () => {
  const { rgba, alpha, w, h } = studio();
  // A bluish shadow: blue is less dark than red.
  for (let y = 80; y < 94; y++) for (let x = 52; x < 84; x++) rgba.set([130, 140, 165, 255], (y * w + x) * 4);
  const shadow = extractShadow(rgba, alpha, w, h)!;
  assert.ok(shadow);
  assert.ok(shadow.color[2] > shadow.color[0] + 0.05, `blue layer colour: ${shadow.color}`);
  assert.ok(shadow.temperature < -0.3, `cool: ${shadow.temperature}`);
  const measured = shadowColor(shadow);
  assert.deepEqual(measured, shadowColor(shadow, shadow.temperature));
  assert.ok(measured[2] > measured[0]);
  // The range is grey with a small tint: the warm end is a warm grey, not orange.
  const warm = shadowColor(shadow, 1);
  assert.ok(warm[0] > warm[2] && warm[0] - warm[2] <= 32, `warm grey: ${warm}`);
  assert.ok(warm[0] > measured[0] && warm[2] < measured[2], `warmer than the photo: ${warm} vs ${measured}`);
  // Half way through the blend, the colour is between the photo and the range.
  const near = shadowColor(shadow, shadow.temperature + 0.15);
  assert.ok(near[2] < measured[2] && near[2] > warm[2], `blend: ${near}`);
  // A neutral shadow gets equal warm and cool tints, both with about the same luma.
  const neutral = { ...shadow, color: [0.1, 0.1, 0.1] as const, temperature: 0 };
  const warmGrey = shadowColor(neutral as typeof shadow, 1);
  const coolGrey = shadowColor(neutral as typeof shadow, -1);
  assert.ok(warmGrey[0] > warmGrey[2] && coolGrey[2] > coolGrey[0]);
  const lumaOf = (rgb: readonly number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  assert.ok(Math.abs(lumaOf(warmGrey) - lumaOf(coolGrey)) < 10, `same density: ${warmGrey} vs ${coolGrey}`);
  assert.ok([...warm, ...warmGrey, ...coolGrey].every((v) => v >= 0 && v <= 255));
});

test('a diffuse shadow is lighter and wider, but stays dark at the object and clear elsewhere', () => {
  const { rgba, alpha, w, h } = studio();
  for (let y = 80; y < 94; y++) for (let x = 52; x < 84; x++) rgba.set([145, 145, 145, 255], (y * w + x) * 4);
  const shadow = extractShadow(rgba, alpha, w, h)!;
  // The object alpha as the worker's result buffer holds it.
  const result = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) result[i * 4 + 3] = alpha[i] * 255;
  assert.equal(softenShadow(shadow, 0, w, h, result), shadow.mask);
  const soft = softenShadow(shadow, 1, w, h, result);
  const centre = 87 * w + 68;
  assert.ok(soft[centre] < shadow.mask[centre] * 0.8, 'the centre is lighter');
  const beyond = 97 * w + 68;
  assert.ok(soft[beyond] > shadow.mask[beyond], 'the edge spreads');
  assert.ok(soft.every((v) => v >= 0 && v <= 1));
  const contact = 80 * w + 68;
  assert.ok(soft[contact] >= shadow.mask[contact] * 0.5, `contact edge stays dark: ${soft[contact]} vs ${shadow.mask[contact]}`);
  assert.equal(soft[40 * w + 20], 0, 'no shadow away from the object');
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
  const tinted = new Uint8ClampedArray([255, 255, 255, 0]);
  composeShadow(tinted, new Float32Array([0.5]), [26, 34, 82]);
  assert.deepEqual([...tinted], [26, 34, 82, 128]);
});
