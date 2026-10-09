import test from 'node:test';
import assert from 'node:assert/strict';
import { fillHoles, findHoles } from '../src/holes';

const w = 200;
const h = 200;

/** A solid square with a transparent hole, and a soft rim at the top of the hole. */
function ring() {
  const alpha = new Float32Array(w * h);
  for (let y = 40; y < 160; y++) for (let x = 40; x < 160; x++) alpha[y * w + x] = 1;
  for (let y = 80; y < 120; y++) for (let x = 80; x < 120; x++) alpha[y * w + x] = 0;
  for (let x = 79; x < 121; x++) alpha[79 * w + x] = 0.7;
  return alpha;
}

test('fillHoles restores exactly the marked hole and leaves the background', () => {
  const alpha = ring();
  assert.equal(findHoles(alpha, undefined, w, h).length, 1);
  assert.equal(fillHoles(alpha, undefined, w, h), 1);
  for (let y = 79; y <= 120; y++) for (let x = 79; x <= 120; x++) assert.equal(alpha[y * w + x], 1);
  assert.equal(alpha[20 * w + 20], 0);
  assert.equal(alpha[39 * w + 100], 0);
  assert.deepEqual(findHoles(alpha, undefined, w, h), []);
});

test('an erased area is not a hole and is not filled', () => {
  const alpha = ring();
  const erase = new Float32Array(w * h);
  for (let y = 80; y < 120; y++) for (let x = 80; x < 120; x++) erase[y * w + x] = 1;
  assert.deepEqual(findHoles(alpha, erase, w, h), []);
  assert.equal(fillHoles(alpha, erase, w, h), 0);
  assert.equal(alpha[100 * w + 100], 0);
});
