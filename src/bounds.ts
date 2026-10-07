export type Bounds = { x: number; y: number; w: number; h: number };

/** Returns the smallest rectangle that holds all pixels with alpha > 0, or undefined if all pixels are transparent. */
export function contentBounds(rgba: Uint8ClampedArray, w: number, h: number): Bounds | undefined {
  let left = w;
  let right = -1;
  let top = h;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let first = -1;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4 + 3]) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    if (top > y) top = y;
    bottom = y;
    if (left > first) left = first;
    // Search the last pixel only right of the current bounds.
    for (let x = w - 1; x > right; x--) {
      if (rgba[row + x * 4 + 3]) {
        right = x;
        break;
      }
    }
  }
  if (bottom < 0) return undefined;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Copies the pixels inside the bounds to a new buffer. */
export function cropRgba(rgba: Uint8ClampedArray, w: number, b: Bounds) {
  const out = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) {
    const start = ((b.y + y) * w + b.x) * 4;
    out.set(rgba.subarray(start, start + b.w * 4), y * b.w * 4);
  }
  return out;
}
