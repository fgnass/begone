// Small copies of the result for live previews of the shadow settings.
//
// While a slider moves, the full result would need a PNG for every step. The
// preview works on a copy at display size: the same shadow code runs on far
// fewer pixels, and the result is a bitmap, not a PNG.

/** The scale that brings the long side of w×h down to `size` pixels. Never above 1. */
export function previewScale(w: number, h: number, size: number) {
  return Math.min(1, size / Math.max(w, h));
}

/** The source pixel range [from, to) of an output row or column. */
function span(o: number, outSize: number, inSize: number): [number, number] {
  const from = Math.floor((o * inSize) / outSize);
  const to = Math.max(from + 1, Math.floor(((o + 1) * inSize) / outSize));
  return [from, Math.min(inSize, to)];
}

/**
 * Area-average downscale of a straight-alpha image. Colours are weighted by
 * alpha, so transparent pixels (whose colour is meaningless) do not darken
 * the edges of the object.
 */
export function downscaleRgba(src: Uint8ClampedArray, w: number, h: number, pw: number, ph: number) {
  const out = new Uint8ClampedArray(pw * ph * 4);
  for (let oy = 0; oy < ph; oy++) {
    const [y0, y1] = span(oy, ph, h);
    for (let ox = 0; ox < pw; ox++) {
      const [x0, x1] = span(ox, pw, w);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const alpha = src[i + 3];
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (oy * pw + ox) * 4;
      if (a) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a / ((y1 - y0) * (x1 - x0));
      }
    }
  }
  return out;
}

/** Area-average downscale of a float mask. */
export function downscaleMask(src: Float32Array, w: number, h: number, pw: number, ph: number) {
  const out = new Float32Array(pw * ph);
  for (let oy = 0; oy < ph; oy++) {
    const [y0, y1] = span(oy, ph, h);
    for (let ox = 0; ox < pw; ox++) {
      const [x0, x1] = span(ox, pw, w);
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += src[y * w + x];
      out[oy * pw + ox] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}
