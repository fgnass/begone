/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { contentBounds, cropRgba, type Bounds } from './bounds';
import { fetchSplit } from './fetch-split';
import { refineForeground } from './foreground';
import { findHoles } from './holes';
import { encodePng } from './png';
import { composeShadow, extractShadow } from './shadow';
import type { Backend, FromWorker, ToWorker } from './messages';

declare const self: DedicatedWorkerGlobalScope;

const BASE = import.meta.env.BASE_URL;
const MODEL_CACHE = 'models-v1';

// Limit full-image buffers; foreground refinement separately bounds its tile workspace.
const MAX_PIXELS = 4096 * 4096;

const MODELS = {
  webgpu: { url: `${BASE}models/birefnet-lite-1024-fp16.onnx`, size: 1024 },
  wasm: { url: `${BASE}models/birefnet-lite-512-fp32.onnx`, size: 512 },
} satisfies Record<Backend, unknown>;

// Load the ORT glue module as a separate file. Its WASM threads start new
// workers from that URL; without this they would start our own worker.
// The wasm binary itself is passed as bytes, see loadRuntime().
ort.env.wasm.wasmPaths = { mjs: ortMjs };
ort.env.logLevel = 'error';

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/** Picks WebGPU if the adapter can run the 1024 graph, else WASM with the 512 graph. */
async function detectBackend(): Promise<Backend> {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter && adapter.limits.maxStorageBuffersPerShaderStage >= 8) return 'webgpu';
  } catch {
    // WebGPU not available
  }
  return 'wasm';
}

/**
 * Returns the model bytes from Cache Storage, or downloads them with progress
 * and caches them. The cache is optional: if storage is not available or
 * full, the model is downloaded each time.
 */
async function loadModel(url: string, id: number): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await caches.open(MODEL_CACHE).catch((err) => console.warn('Model cache not available', err));
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const bytes = await fetchSplit(url, (loaded, total) => post({ type: 'progress', id, stage: 'download', loaded, total }));
  await cache
    ?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    .catch((err) => console.warn('Cannot cache the model', err));
  return bytes;
}

/** Loads the ORT wasm binary. It is too large for Cloudflare Pages in one piece. */
async function loadRuntime() {
  ort.env.wasm.wasmBinary ??= await fetchSplit(ortWasm);
}

let sessionPromise: Promise<{ session: ort.InferenceSession; backend: Backend }> | undefined;

async function createSession(backend: Backend, id: number) {
  const model = MODELS[backend];
  const [bytes] = await Promise.all([loadModel(model.url, id), loadRuntime()]);
  post({ type: 'progress', id, stage: 'init' });
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  });
  return { session, backend };
}

// Open the app with ?wasm to force the WASM path (for testing).
let forced: Backend | undefined = self.name === 'wasm' ? 'wasm' : undefined;

function getSession(id: number) {
  sessionPromise ??= (async () => {
    const backend = forced ?? (await detectBackend());
    try {
      return await createSession(backend, id);
    } catch (err) {
      if (backend === 'wasm') throw err;
      console.warn('WebGPU failed, falling back to WASM', err);
      forced = 'wasm';
      return createSession('wasm', id);
    }
  })();
  sessionPromise.catch(() => (sessionPromise = undefined));
  return sessionPromise;
}

async function predict(bitmap: ImageBitmap, id: number) {
  const { session, backend } = await getSession(id);
  const size = MODELS[backend].size;
  post({ type: 'progress', id, stage: 'infer', backend });
  const t0 = performance.now();
  try {
    const input = preprocess(bitmap, size);
    let output: ort.InferenceSession.OnnxValueMapType | undefined;
    try {
      output = await session.run({ [session.inputNames[0]]: input });
      const logits = output[session.outputNames[0]];
      // Own the data independently of ORT before disposing its tensors.
      const mask = Float32Array.from((await logits.getData()) as Float32Array);
      console.info(`Inference (${backend}, ${size}px): ${Math.round(performance.now() - t0)} ms`);
      return { mask, size, backend };
    } finally {
      input.dispose();
      if (output) for (const tensor of Object.values(output)) tensor.dispose();
    }
  } catch (err) {
    if (backend === 'wasm') throw err;
    // E.g. out of GPU memory on weak devices. Switch to WASM for good.
    console.warn('WebGPU inference failed, falling back to WASM', err);
    forced = 'wasm';
    sessionPromise = undefined;
    await session.release().catch((releaseError) => console.warn('Cannot release WebGPU session', releaseError));
    return predict(bitmap, id);
  }
}

/** Resizes the image to size×size and converts it to a normalised CHW tensor. */
function preprocess(bitmap: ImageBitmap, size: number) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const n = size * size;
  const tensor = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      tensor[c * n + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
    }
  }
  return new ort.Tensor('float32', tensor, [1, 3, size, size]);
}

/** Bilinear upscale of the size×size logits to w×h, with sigmoid applied. */
function upscaleMask(logits: Float32Array, size: number, w: number, h: number) {
  const mask = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i++) mask[i] = 1 / (1 + Math.exp(-logits[i]));

  const out = new Float32Array(w * h);
  const sx = size / w;
  const sy = size / h;
  const max = size - 1;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), max);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, max);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), max);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, max);
      const tx = fx - x0;
      const top = mask[y0 * size + x0] * (1 - tx) + mask[y0 * size + x1] * tx;
      const bottom = mask[y1 * size + x0] * (1 - tx) + mask[y1 * size + x1] * tx;
      out[y * w + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

// The mask of the last image. For each change, the main thread sends the same
// image again, and the model does not run again.
let last: { image: number; mask: Float32Array; size: number; backend: Backend } | undefined;

/**
 * Applies the brush strokes to the object alpha (in place). Returns the erase
 * coverage per pixel, because erased areas must also lose their shadow.
 */
function applyEdits(edits: ImageBitmap, alpha: Float32Array, w: number, h: number) {
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(edits, 0, 0, w, h);
  edits.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  const erase = new Float32Array(w * h);
  for (let i = 0; i < erase.length; i++) {
    const a = data[i * 4 + 3] / 255;
    if (!a) continue;
    // Straight alpha: red and green are the shares of restore and erase.
    const restore = (data[i * 4] / 255) * a;
    erase[i] = (data[i * 4 + 1] / 255) * a;
    alpha[i] = alpha[i] * (1 - a) + restore;
  }
  return erase;
}

/** Returns the alpha (0..1) of the source image, or undefined if it is opaque. */
function sourceAlpha(rgba: Uint8ClampedArray) {
  let src: Float32Array | undefined;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 255) continue;
    src ??= new Float32Array(rgba.length / 4).fill(1);
    src[i >> 2] = rgba[i] / 255;
  }
  return src;
}

/** Transparent source areas count as erased, so they are no holes. */
function holeErase(erase: Float32Array | undefined, src: Float32Array | undefined) {
  if (!src) return erase;
  const out = new Float32Array(src.length);
  for (let i = 0; i < out.length; i++) out[i] = 1 - (1 - (erase?.[i] ?? 0)) * src[i];
  return out;
}

/** Refines the mask and colours. The shadow is extracted, but not composed. */
function refine(mask: Float32Array, size: number, bitmap: ImageBitmap, edits?: ImageBitmap) {
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const alpha = upscaleMask(mask, size, w, h);
  // refineForeground() overwrites the alpha channel, so keep it.
  const src = sourceAlpha(data);
  const erase = edits && applyEdits(edits, alpha, w, h);
  const holes = findHoles(alpha, holeErase(erase, src), w, h);
  // Uses the original colours, so it must run before refineForeground().
  // It also runs when the shadow option is off, so that a later toggle does
  // not need the original colours again. For a background that is not plain,
  // it stops early.
  const shadow = extractShadow(data, alpha, w, h);
  // The object alpha is already erased. Erase the shadow too.
  if (shadow && erase) for (let i = 0; i < erase.length; i++) shadow[i] *= 1 - erase[i];
  refineForeground(data, alpha, w, h);
  return { w, h, data, shadow, src, holes };
}

type Refined = ReturnType<typeof refine>;

/** Returns a new buffer with the shadow (if wanted) and the source transparency. */
function compose(r: Refined, shadow: boolean) {
  const data = r.data.slice();
  if (shadow && r.shadow) composeShadow(data, r.shadow);
  // Keep the transparency of the source image. Apply it once to the result,
  // so that object and shadow together never have more alpha than the source.
  if (r.src) for (let i = 0; i < r.src.length; i++) data[i * 4 + 3] *= r.src[i];
  return data;
}

type Output = { blob: Blob; bounds?: Bounds; cropped?: Blob };

// The refined result of the last image and brush edits. When only the shadow
// or crop option changes, refinement does not run again. The PNGs are kept
// for each shadow state, so toggling back is immediate.
let refined: (Refined & { image: number; edit: number; outputs: Map<boolean, Output> }) | undefined;

// The decoded image. The main thread sends it once per image, so that a
// change does not decode the file again.
let source: { image: number; bitmap: ImageBitmap } | undefined;

async function process(id: number, image: number, edit: number, shadow: boolean, crop: boolean, edits?: ImageBitmap) {
  if (source?.image !== image) throw new Error('The image is not loaded. Open it again.');
  const { bitmap } = source;
  if (last?.image !== image) last = { image, ...(await predict(bitmap, id)) };
  const { mask, size, backend } = last;

  const t1 = performance.now();
  if (refined?.image !== image || refined.edit !== edit) {
    post({ type: 'progress', id, stage: 'refine' });
    // Release the old buffers before new ones are allocated.
    refined = undefined;
    refined = { image, edit, ...refine(mask, size, bitmap, edits), outputs: new Map() };
  }
  const r = refined;
  const { w, h } = r;
  // Without a shadow, both states give the same result.
  const key = shadow && !!r.shadow;
  let out = r.outputs.get(key);
  if (!out || (crop && out.bounds && !out.cropped)) {
    post({ type: 'progress', id, stage: 'encode' });
    const data = compose(r, key);
    if (!out) {
      const content = contentBounds(data, w, h);
      const bounds = content && (content.w < w || content.h < h) ? content : undefined;
      out = { bounds, blob: await encodePng(data, w, h) };
      r.outputs.set(key, out);
    }
    if (crop && out.bounds) out.cropped = await encodePng(cropRgba(data, w, out.bounds), out.bounds.w, out.bounds.h);
  }
  console.info(`Refine + encode (${w}×${h}): ${Math.round(performance.now() - t1)} ms`);
  const { blob, bounds } = out;
  post({ type: 'done', id, blob, width: w, height: h, backend, holes: r.holes, bounds, cropped: crop ? out.cropped : undefined });
}

function postError(err: unknown, id: number) {
  console.error(err);
  post({ type: 'error', id, message: String((err as Error)?.message ?? err) });
}

type ProcessRequest = Extract<ToWorker, { type: 'process' }>;

// Requests run one at a time. A newer request replaces a waiting one, because
// the main thread only shows the newest result. A replaced request gets no
// answer.
let waiting: ProcessRequest | undefined;
let running = false;

async function enqueue(req: ProcessRequest) {
  waiting?.edits?.close();
  waiting = req;
  if (running) return;
  running = true;
  while (waiting) {
    const { id, image, edit, shadow, crop, edits } = waiting;
    waiting = undefined;
    try {
      await process(id, image, edit, shadow, crop, edits);
    } catch (err) {
      postError(err, id);
    } finally {
      edits?.close();
    }
  }
  running = false;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  // Keep the image even if a newer request replaces this one.
  if (msg.bitmap) {
    source?.bitmap.close();
    source = { image: msg.image, bitmap: msg.bitmap };
  }
  void enqueue(msg);
};
