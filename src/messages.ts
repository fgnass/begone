import type { Bounds } from './bounds';
import type { Hole } from './holes';

export type Backend = 'webgpu' | 'wasm';

export type ToWorker = {
  type: 'process';
  id: number;
  image: number;
  /** Changes when the brush strokes change. Same image and edit: the worker reuses its refined result. */
  edit: number;
  /** The decoded image. Sent only with the first request for an image; the worker keeps it. */
  bitmap?: ImageBitmap;
  shadow: boolean;
  /** How diffuse the shadow is, 0..1. */
  soft: number;
  /** Colour temperature of the shadow, -1..1. Undefined keeps the measured colour. */
  temperature?: number;
  /** Also make the holes part of the object (see holes.ts). Part of the edit like the strokes. */
  fillHoles: boolean;
  /** Also encode a PNG cropped to the visible pixels. */
  crop: boolean;
  /** Brush strokes at result size: red = restore, green = erase, alpha = coverage. */
  edits?: ImageBitmap;
} | {
  /** A small preview of the shadow settings, while a slider moves. Needs the refined result of `image` and `edit`. */
  type: 'preview';
  id: number;
  image: number;
  edit: number;
  soft: number;
  temperature?: number;
  /** Long side of the preview in pixels. */
  size: number;
};

export type Stage = 'download' | 'init' | 'infer' | 'refine' | 'encode';

export type FromWorker =
  | { type: 'progress'; id: number; stage: Stage; loaded?: number; total?: number; backend?: Backend }
  | { type: 'done'; id: number; blob: Blob; width: number; height: number; backend: Backend; holes: Hole[];
      /** The shadow that was found, if any, with its measured colour temperature (-1..1). */
      shadow?: { temperature: number };
      /** The visible pixels, if they do not fill the image. */
      bounds?: Bounds;
      /** The result cropped to the bounds, if the request asked for it. */
      cropped?: Blob }
  | { type: 'error'; id: number; message: string }
  /** The preview, or nothing if the refined result is not the one asked for. */
  | { type: 'preview'; id: number; image: number; bitmap?: ImageBitmap };
