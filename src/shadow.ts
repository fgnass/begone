// Shadow extraction for product photos on a plain background.
//
// The model puts shadows into the background, so they are removed with it.
// This step finds them again: it fits a smooth "clean plate" (the background
// without the object and without shadows) and treats every pixel that is
// darker than that plate as a black shadow layer with partial alpha.
//
// This only works for plain, light backgrounds (studio shots, seamless paper).
// For other backgrounds the fit is poor, and the step returns no shadow.

import { boxBlur, BlurWorkspace } from './foreground';

/** Pixels with less object alpha than this are "background" for the fit. */
const BG_ALPHA = 0.05;
/** Above this RMS error of the plate fit, the background is not plain. */
const MAX_RMS = 0.03;
/** Below this luma, the background is too dark to show shadows. */
const MIN_LUMA = 0.25;

const luma = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** The 10 terms of a cubic polynomial in u, v. */
function terms(u: number, v: number, out: Float64Array) {
  out[0] = 1;
  out[1] = u;
  out[2] = v;
  out[3] = u * u;
  out[4] = u * v;
  out[5] = v * v;
  out[6] = u * u * u;
  out[7] = u * u * v;
  out[8] = u * v * v;
  out[9] = v * v * v;
}

/** Weighted least squares fit. Returns undefined if the system is singular. */
function fit(us: Float64Array, vs: Float64Array, vals: Float64Array, weights: Float64Array) {
  const k = 10;
  const m = new Float64Array(k * (k + 1)); // augmented normal matrix
  const t = new Float64Array(k);
  for (let i = 0; i < vals.length; i++) {
    const wi = weights[i];
    if (!wi) continue;
    terms(us[i], vs[i], t);
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) m[r * (k + 1) + c] += wi * t[r] * t[c];
      m[r * (k + 1) + k] += wi * t[r] * vals[i];
    }
  }
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(m[r * (k + 1) + col]) > Math.abs(m[pivot * (k + 1) + col])) pivot = r;
    }
    if (Math.abs(m[pivot * (k + 1) + col]) < 1e-12) return;
    if (pivot !== col) {
      for (let c = 0; c <= k; c++) {
        const tmp = m[col * (k + 1) + c];
        m[col * (k + 1) + c] = m[pivot * (k + 1) + c];
        m[pivot * (k + 1) + c] = tmp;
      }
    }
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = m[r * (k + 1) + col] / m[col * (k + 1) + col];
      if (f) for (let c = col; c <= k; c++) m[r * (k + 1) + c] -= f * m[col * (k + 1) + c];
    }
  }
  const coef = new Float64Array(k);
  for (let r = 0; r < k; r++) coef[r] = m[r * (k + 1) + k] / m[r * (k + 1) + r];
  return coef;
}

function evaluate(coef: Float64Array, u: number, v: number, t: Float64Array) {
  terms(u, v, t);
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += coef[i] * t[i];
  return sum;
}

/**
 * Fits the clean plate to the mean luma of background cells. Shadows are only
 * darker than the plate, so cells far below the fit are dropped and the fit is
 * done again. Returns the plate on a coarse grid, or undefined if the
 * background is not plain.
 */
function fitPlate(lum: Float32Array, alpha: Float32Array, w: number, h: number) {
  const cell = Math.max(8, Math.round(Math.max(w, h) / 96));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const us: number[] = [];
  const vs: number[] = [];
  const vals: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let count = 0;
      let total = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) {
          total++;
          const i = y * w + x;
          if (alpha[i] < BG_ALPHA) {
            sum += lum[i];
            count++;
          }
        }
      }
      if (count < total * 0.75) continue;
      us.push((((gx + 0.5) * cell) / w) * 2 - 1);
      vs.push((((gy + 0.5) * cell) / h) * 2 - 1);
      vals.push(sum / count);
    }
  }
  const n = vals.length;
  if (n < 30) return;
  const u = Float64Array.from(us);
  const v = Float64Array.from(vs);
  const val = Float64Array.from(vals);
  const weights = new Float64Array(n).fill(1);
  const t = new Float64Array(10);

  let coef: Float64Array | undefined;
  let rms = 0;
  for (let iter = 0; iter < 8; iter++) {
    coef = fit(u, v, val, weights);
    if (!coef) return;
    let sq = 0;
    let inliers = 0;
    for (let i = 0; i < n; i++) {
      if (!weights[i]) continue;
      const r = val[i] - evaluate(coef, u[i], v[i], t);
      sq += r * r;
      inliers++;
    }
    rms = Math.sqrt(sq / inliers);
    const tol = Math.max(0.01, 2 * rms);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const keep = val[i] - evaluate(coef, u[i], v[i], t) > -tol ? 1 : 0;
      if (keep !== weights[i]) changed = true;
      weights[i] = keep;
    }
    if (!changed) break;
  }
  let inliers = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    inliers += weights[i];
    mean += weights[i] * val[i];
  }
  mean /= inliers;
  console.info(`Shadow plate: rms ${rms.toFixed(4)}, inliers ${inliers}/${n}, luma ${mean.toFixed(2)}`);
  if (!coef || rms > MAX_RMS || inliers < n * 0.5 || mean < MIN_LUMA) return;
  return { coef, rms };
}

/**
 * Returns the shadow alpha (0..1) for every pixel, or undefined if the
 * background is not plain. `rgba` is the original image, `alpha` the object
 * alpha from the model.
 */
export function extractShadow(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number) {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);

  const plate = fitPlate(lum, alpha, w, h);
  if (!plate) return;

  // Object bounding box, to limit shadows to the area around the object.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;

  const scratch = new BlurWorkspace();
  // Reused for object proximity after filling the shadow behind the object.
  const valid = new Uint8Array(n);
  const s = new Float32Array(n);
  const blurredValid = new Float32Array(n);

  // Reduce JPEG noise using only background pixels. Including the object's
  // dark colours would create a false shadow around an otherwise clean edge.
  for (let i = 0; i < n; i++) {
    valid[i] = alpha[i] < BG_ALPHA ? 1 : 0;
    lum[i] *= valid[i];
  }
  const noiseRadius = Math.max(1, Math.round(Math.max(w, h) / 800));
  boxBlur(lum, s, w, h, noiseRadius, scratch);
  boxBlur(valid, blurredValid, w, h, noiseRadius, scratch);
  for (let i = 0; i < n; i++) s[i] = blurredValid[i] ? s[i] / blurredValid[i] : 0;

  // Shadow strength: how much darker than the clean plate. Small values are
  // noise or plate error, so they are cut off.
  const cut = Math.min(0.08, Math.max(0.02, 3 * plate.rms));
  const t = new Float64Array(10);
  for (let y = 0; y < h; y++) {
    const v = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (alpha[i] >= BG_ALPHA) continue;
      const p = evaluate(plate.coef, ((x + 0.5) / w) * 2 - 1, v, t);
      const d = 1 - s[i] / Math.max(p, 1e-3);
      valid[i] = 1;
      lum[i] = d > cut ? (d - cut) / (1 - cut) : 0;
    }
  }

  // Fill the edge and interior of the object from nearby background pixels.
  // There the pixel colour is a mix with the object, so the ratio is wrong.
  for (let i = 0; i < n; i++) if (!valid[i]) lum[i] = 0;
  const r = Math.max(2, Math.round(Math.max(w, h) / 300));
  boxBlur(lum, s, w, h, r, scratch);
  boxBlur(valid, blurredValid, w, h, r, scratch);
  for (let i = 0; i < n; i++) {
    if (!valid[i]) lum[i] = blurredValid[i] > 1e-3 ? s[i] / blurredValid[i] : 0;
  }

  // Keep shadows only near the object, with a soft fall-off. This removes
  // dark corners (vignetting) that the plate does not fit exactly.
  const reach = Math.max(8, Math.round(0.35 * Math.max(x1 - x0, y1 - y0)));
  for (let i = 0; i < n; i++) valid[i] = alpha[i] > 0.5 ? 1 : 0;
  boxBlur(valid, s, w, h, reach, scratch);
  for (let i = 0; i < n; i++) valid[i] = s[i] > 1e-4 ? 1 : 0;
  boxBlur(valid, blurredValid, w, h, Math.round(reach / 2), scratch);
  for (let i = 0; i < n; i++) lum[i] *= blurredValid[i];

  return lum;
}

/**
 * Puts the object (refined colours and alpha in `rgba`) over a black shadow
 * layer. `rgba` has straight alpha, so the colour of a pixel that is partly
 * object and partly shadow is the object colour scaled by its share.
 */
export function composeShadow(rgba: Uint8ClampedArray, shadow: Float32Array) {
  for (let i = 0; i < shadow.length; i++) {
    const sh = shadow[i];
    if (!sh) continue;
    const a = rgba[i * 4 + 3] / 255;
    const out = a + sh * (1 - a);
    const k = a / out;
    rgba[i * 4] *= k;
    rgba[i * 4 + 1] *= k;
    rgba[i * 4 + 2] *= k;
    rgba[i * 4 + 3] = out * 255;
  }
}
