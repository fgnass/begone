// Shadow extraction for product photos on a plain background.
//
// The model puts shadows into the background, so they are removed with it.
// This step finds them again: it fits a smooth "clean plate" (the background
// without the object and without shadows) and treats every pixel that is
// darker than that plate as a shadow layer with partial alpha. The colour of
// the layer is measured too: a shadow that is less dark in blue than in red
// is a cool shadow, and the layer gets a dark blue instead of black.
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
 * done again. The three colour channels are then fitted with the same cells,
 * for the colour of the shadow. Returns the plates, or undefined if the
 * background is not plain.
 */
function fitPlate(rgba: Uint8ClampedArray, lum: Float32Array, alpha: Float32Array, w: number, h: number) {
  const cell = Math.max(8, Math.round(Math.max(w, h) / 96));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const us: number[] = [];
  const vs: number[] = [];
  const vals: number[] = [];
  const chans: [number[], number[], number[]] = [[], [], []];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      let total = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) {
          total++;
          const i = y * w + x;
          if (alpha[i] < BG_ALPHA) {
            sum += lum[i];
            r += rgba[i * 4];
            g += rgba[i * 4 + 1];
            b += rgba[i * 4 + 2];
            count++;
          }
        }
      }
      if (count < total * 0.75) continue;
      us.push((((gx + 0.5) * cell) / w) * 2 - 1);
      vs.push((((gy + 0.5) * cell) / h) * 2 - 1);
      vals.push(sum / count);
      chans[0].push(r / count / 255);
      chans[1].push(g / count / 255);
      chans[2].push(b / count / 255);
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
  const channels = chans.map((c) => fit(u, v, Float64Array.from(c), weights));
  if (!channels.every((c) => !!c)) return;
  return { coef, rms, channels: channels as Float64Array[] };
}

export type Rgb = [number, number, number];

export type Shadow = {
  /** Shadow alpha (0..1) for every pixel. */
  mask: Float32Array;
  /** Colour of the shadow layer as measured, 0..1 per channel. Black is neutral. */
  color: Rgb;
  /** Colour temperature of the measured shadow, -1 (cold) .. 1 (warm). */
  temperature: number;
  /** Half the long side of the object, in pixels. Sets blur sizes. */
  extent: number;
};

/** Below this share of the object area, there is no shadow worth keeping. */
const MIN_SHADOW_AREA = 0.02;

/**
 * Finds the shadow, or returns undefined if the background is not plain or
 * there is no shadow. `rgba` is the original image, `alpha` the object alpha
 * from the model.
 */
export function extractShadow(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number): Shadow | undefined {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);

  const plate = fitPlate(rgba, lum, alpha, w, h);
  if (!plate) return;

  // Object bounding box, to limit shadows to the area around the object.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let objectArea = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.5) {
        objectArea++;
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
  // noise or plate error, so they are cut off. At the same time, measure the
  // colour of the shadow layer: the colour that, under the plate with the
  // shadow alpha, gives the real shadow pixel. Black means a neutral shadow.
  const cut = Math.min(0.08, Math.max(0.02, 3 * plate.rms));
  const t = new Float64Array(10);
  const colorSum = [0, 0, 0];
  let colorWeight = 0;
  for (let y = 0; y < h; y++) {
    const v = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (alpha[i] >= BG_ALPHA) continue;
      const u = ((x + 0.5) / w) * 2 - 1;
      const p = evaluate(plate.coef, u, v, t);
      const ratio = s[i] / Math.max(p, 1e-3);
      const d = 1 - ratio;
      valid[i] = 1;
      const strength = d > cut ? (d - cut) / (1 - cut) : 0;
      lum[i] = strength;
      if (strength > 0.2) {
        for (let c = 0; c < 3; c++) {
          const pc = Math.max(evaluate(plate.channels[c], u, v, t), 1e-3);
          colorSum[c] += (strength * (rgba[i * 4 + c] / 255 / pc - ratio)) / d;
        }
        colorWeight += strength;
      }
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
  let area = 0;
  for (let i = 0; i < n; i++) {
    lum[i] *= blurredValid[i];
    area += lum[i];
  }
  if (area < MIN_SHADOW_AREA * objectArea || !colorWeight) return;

  const color = colorSum.map((c) => Math.min(1, Math.max(0, c / colorWeight))) as Rgb;
  const temperature = colorTemperature(color);
  console.info(`Shadow colour: ${color.map((c) => c.toFixed(2)).join(' ')}, temperature ${temperature.toFixed(2)}`);
  return { mask: lum, color, temperature, extent: (Math.max(x1 - x0, y1 - y0) + 1) / 2 };
}

// The slider range is a warm grey to a cool grey: a small tint on the grey
// of the measured shadow. The tints have almost no luma, so the density of
// the shadow stays as in the photo.
const WARM_TINT: Rgb = [0.07, 0.01, -0.05];
const COLD_TINT: Rgb = [-0.05, 0, 0.07];

// Colour temperature of a shadow layer colour: how much warmer (red) than
// cool (blue) it is, in units of the slider range. A shadow more colourful
// than the range (the blue shadow of sunlight on a clear day) sits at an end.
const TEMPERATURE_SCALE = WARM_TINT[0] - WARM_TINT[2];

const colorTemperature = (color: Rgb) => Math.min(1, Math.max(-1, (color[0] - color[2]) / TEMPERATURE_SCALE));

/** Near the measured colour, the slider fades from it into the grey range over this distance. */
const BLEND = 0.3;

/** The grey of the measured shadow with the tint of a temperature. */
function tinted(shadow: Shadow, t: number): Rgb {
  const [r, g, b] = shadow.color;
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const tint = t >= 0 ? WARM_TINT : COLD_TINT;
  return tint.map((c) => grey + Math.abs(t) * c) as Rgb;
}

/**
 * The shadow layer colour (0..255) for a temperature setting. Without a
 * setting, this is the measured colour. With one, it is the warm or cool
 * grey of the range; close to the measured temperature, it blends from the
 * measured colour into the range, so that the slider has no jump.
 */
export function shadowColor(shadow: Shadow, temperature?: number): Rgb {
  if (temperature === undefined) return shadow.color.map((c) => Math.round(c * 255)) as Rgb;
  const t = Math.min(1, Math.max(-1, temperature));
  const k = Math.min(1, Math.abs(t - shadow.temperature) / BLEND);
  const target = tinted(shadow, t);
  return shadow.color.map((c, i) => Math.round(Math.min(1, Math.max(0, c + (target[i] - c) * k)) * 255)) as Rgb;
}

/**
 * Returns the shadow mask of a more diffuse light: blurred and lighter. With
 * `soft` 0 the mask is returned as it is. `rgba` holds the object alpha. The
 * mask is empty under the object, so a plain blur would lighten the shadow
 * at the contact edge and the object would seem to glow. The blur therefore
 * leaves object pixels out of the average (normalised convolution): the
 * contact edge stays dark, and the lit side stays clear.
 */
export function softenShadow(shadow: Shadow, soft: number, w: number, h: number, rgba: Uint8ClampedArray) {
  soft = Math.min(1, Math.max(0, soft));
  const { mask } = shadow;
  if (soft <= 0) return mask;
  const n = mask.length;
  const radius = Math.max(1, Math.round(soft * 0.1 * shadow.extent));
  const weight = new Float32Array(n);
  const value = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    weight[i] = 1 - rgba[i * 4 + 3] / 255;
    value[i] = mask[i] * weight[i];
  }
  const tmp = new Float32Array(n);
  const scratch = new BlurWorkspace();
  // Two box blurs approximate a Gaussian. The second pass goes back into the input.
  boxBlur(value, tmp, w, h, radius, scratch);
  boxBlur(tmp, value, w, h, radius, scratch);
  boxBlur(weight, tmp, w, h, radius, scratch);
  boxBlur(tmp, weight, w, h, radius, scratch);
  const k = 1 - 0.45 * soft;
  for (let i = 0; i < n; i++) value[i] = weight[i] > 1e-3 ? Math.min(1, Math.max(0, (value[i] / weight[i]) * k)) : 0;
  return value;
}

/**
 * Puts the object (refined colours and alpha in `rgba`) over a shadow layer
 * of one colour (0..255), black by default. `rgba` has straight alpha, so the
 * colour of a pixel that is partly object and partly shadow is the mix of
 * both, weighted by their shares.
 */
export function composeShadow(rgba: Uint8ClampedArray, shadow: Float32Array, color: Rgb = [0, 0, 0]) {
  for (let i = 0; i < shadow.length; i++) {
    const sh = shadow[i];
    if (!sh) continue;
    const a = rgba[i * 4 + 3] / 255;
    const out = a + sh * (1 - a);
    const k = a / out;
    const m = (sh * (1 - a)) / out;
    rgba[i * 4] = rgba[i * 4] * k + color[0] * m;
    rgba[i * 4 + 1] = rgba[i * 4 + 1] * k + color[1] * m;
    rgba[i * 4 + 2] = rgba[i * 4 + 2] * k + color[2] * m;
    rgba[i * 4 + 3] = out * 255;
  }
}
