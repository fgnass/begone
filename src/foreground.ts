// Foreground colour estimation ("blur fusion", Forte & Pitié, ICIP 2021),
// the same method BiRefNet's reference code uses in refine_foreground().
//
// At soft edges (hair, fur, motion blur) a pixel is a mix of foreground and
// background. If we only set alpha, the old background colour still shows as
// a halo. This step estimates the pure foreground colour for every pixel.

/** Reused across blur passes. Stores only rows needed by the sliding window. */
export class BlurWorkspace {
  rows = new Float32Array(0);
  sums = new Float64Array(0);
}

/** Normalised box blur. Source and destination must be different arrays. */
export function boxBlur(src: ArrayLike<number>, dst: Float32Array, w: number, h: number, r: number, scratch = new BlurWorkspace()) {
  // Horizontal pass into dst. The vertical pass replaces these values in place.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let count = 0;
    for (let x = 0; x < Math.min(r, w); x++) {
      sum += src[row + x];
      count++;
    }
    for (let x = 0; x < w; x++) {
      const add = x + r;
      if (add < w) {
        sum += src[row + add];
        count++;
      }
      const sub = x - r - 1;
      if (sub >= 0) {
        sum -= src[row + sub];
        count--;
      }
      dst[row + x] = sum / count;
    }
  }

  // Preserve outgoing horizontal rows in a ring before overwriting them.
  const ringHeight = Math.min(r + 1, h);
  if (scratch.rows.length < ringHeight * w) scratch.rows = new Float32Array(ringHeight * w);
  if (scratch.sums.length < w) scratch.sums = new Float64Array(w);
  const { rows, sums } = scratch;
  sums.fill(0, 0, w);
  let count = Math.min(r, h);
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < w; x++) sums[x] += dst[y * w + x];
  }
  for (let y = 0; y < h; y++) {
    const add = y + r;
    const sub = y - r - 1;
    if (add < h) count++;
    if (sub >= 0) count--;
    const ring = (y % ringHeight) * w;
    for (let x = 0; x < w; x++) {
      if (add < h) sums[x] += dst[add * w + x];
      // sub and y share a ring slot: read the outgoing row before replacing it.
      if (sub >= 0) sums[x] -= rows[ring + x];
      rows[ring + x] = dst[y * w + x];
      dst[y * w + x] = sums[x] / count;
    }
  }
}

const R1 = 90;
const R2 = 6;
const TILE_SIZE = 512;
const HALO = R1 + R2;

class ForegroundWorkspace {
  alpha: Float32Array;
  rgba: Uint8ClampedArray;
  buffers: Float32Array[];
  blur = new BlurWorkspace();

  constructor(pixels: number) {
    this.alpha = new Float32Array(pixels);
    this.rgba = new Uint8ClampedArray(pixels * 4);
    this.buffers = Array.from({ length: 7 }, () => new Float32Array(pixels));
  }
}

/**
 * Runs blur fusion on tiles with a 96-pixel halo. Both blur passes can reach
 * that far, so the core has the same neighbours as a full-image calculation.
 * Input colours stay untouched until every tile has finished.
 */
export function refineForeground(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number, tileSize = TILE_SIZE) {
  const tw = Math.min(w, tileSize + 2 * HALO);
  const th = Math.min(h, tileSize + 2 * HALO);
  const scratch = new ForegroundWorkspace(tw * th);
  const output = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y += tileSize) {
    for (let x = 0; x < w; x += tileSize) {
      const right = Math.min(w, x + tileSize);
      const bottom = Math.min(h, y + tileSize);
      const x0 = Math.max(0, x - HALO);
      const y0 = Math.max(0, y - HALO);
      const x1 = Math.min(w, right + HALO);
      const y1 = Math.min(h, bottom + HALO);
      const width = x1 - x0;
      const height = y1 - y0;
      const pixels = width * height;
      const tile = scratch.rgba.subarray(0, pixels * 4);
      const a = scratch.alpha.subarray(0, pixels);
      for (let row = y0; row < y1; row++) {
        const offset = (row - y0) * width;
        a.set(alpha.subarray(row * w + x0, row * w + x1), offset);
        tile.set(rgba.subarray((row * w + x0) * 4, (row * w + x1) * 4), offset * 4);
      }
      refineTile(tile, a, width, height, scratch);
      for (let row = y; row < bottom; row++) {
        const offset = ((row - y0) * width + x - x0) * 4;
        output.set(tile.subarray(offset, offset + (right - x) * 4), (row * w + x) * 4);
      }
    }
  }
  rgba.set(output);
}

/**
 * Writes the estimated foreground colours into `rgba` (in place) and sets its
 * alpha channel from `alpha` (0..1). Works one colour channel at a time
 * using the shared tile workspace.
 */
function refineTile(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number, scratch: ForegroundWorkspace) {
  const n = w * h;
  const eps = 1e-5;
  const a = alpha;
  const [ba1, ba2, img, buf1, buf2, buf3, f] = scratch.buffers.map((buffer) => buffer.subarray(0, n));
  boxBlur(a, ba1, w, h, R1, scratch.blur);
  boxBlur(a, ba2, w, h, R2, scratch.blur);

  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) img[i] = rgba[i * 4 + c] / 255;

    // Pass 1 (r1): F = B = image
    for (let i = 0; i < n; i++) buf1[i] = img[i] * a[i];
    boxBlur(buf1, buf2, w, h, R1, scratch.blur); // buf2 = blur(I*a)
    boxBlur(img, buf3, w, h, R1, scratch.blur); // buf3 = blur(I)
    for (let i = 0; i < n; i++) {
      const ai = a[i];
      const bF = buf2[i] / (ba1[i] + eps);
      // blur(I*(1-a)) == blur(I) - blur(I*a), because the blur is linear
      const bB = (buf3[i] - buf2[i]) / (1 - ba1[i] + eps);
      const v = bF + ai * (img[i] - ai * bF - (1 - ai) * bB);
      f[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      buf3[i] = bB; // keep blurred background for pass 2
    }

    // Pass 2 (r2): F = result of pass 1, B = blurred background of pass 1
    for (let i = 0; i < n; i++) buf1[i] = f[i] * a[i];
    boxBlur(buf1, buf2, w, h, R2, scratch.blur); // buf2 = blur(F*a)
    for (let i = 0; i < n; i++) buf1[i] = buf3[i] * (1 - a[i]);
    boxBlur(buf1, buf3, w, h, R2, scratch.blur); // buf3 = blur(B*(1-a))
    for (let i = 0; i < n; i++) {
      const ai = a[i];
      const bF = buf2[i] / (ba2[i] + eps);
      const bB = buf3[i] / (1 - ba2[i] + eps);
      const v = bF + ai * (img[i] - ai * bF - (1 - ai) * bB);
      rgba[i * 4 + c] = (v < 0 ? 0 : v > 1 ? 1 : v) * 255;
    }
  }
  for (let i = 0; i < n; i++) rgba[i * 4 + 3] = a[i] * 255;
}
