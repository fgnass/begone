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
  /** Also encode a PNG cropped to the visible pixels. */
  crop: boolean;
  /** Brush strokes at result size: red = restore, green = erase, alpha = coverage. */
  edits?: ImageBitmap;
};

export type Stage = 'download' | 'init' | 'infer' | 'refine' | 'encode';

export type FromWorker =
  | { type: 'progress'; id: number; stage: Stage; loaded?: number; total?: number; backend?: Backend }
  | { type: 'done'; id: number; blob: Blob; width: number; height: number; backend: Backend; holes: Hole[];
      /** The visible pixels, if they do not fill the image. */
      bounds?: Bounds;
      /** The result cropped to the bounds, if the request asked for it. */
      cropped?: Blob }
  | { type: 'error'; id: number; message: string };
