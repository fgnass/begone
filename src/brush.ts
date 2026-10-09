// Brush to fix the mask by hand. "Restore" makes an area part of the object,
// "Erase" makes it transparent (also its shadow).
//
// Strokes are kept as vectors in result pixels, so undo is cheap. For each
// update, all strokes are drawn into one edit image: red = restore,
// green = erase, alpha = coverage. The worker applies it to the model mask.
//
// "Fill holes" is an edit too, so that it is part of the same undo history.
// It has no shape here: the worker fills the holes it finds after the strokes.

export type BrushMode = 'restore' | 'erase';

type Stroke = { mode: BrushMode; size: number; points: [number, number][] } | { mode: 'holes' };

const EDIT_COLORS: Record<BrushMode, string> = { restore: '#f00', erase: '#0f0' };
const PREVIEW_COLORS: Record<BrushMode, string> = { restore: '#ff3ea5', erase: '#00a3ff' };

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, colors: Record<BrushMode, string>) {
  if (s.mode === 'holes') return;
  ctx.fillStyle = ctx.strokeStyle = colors[s.mode];
  ctx.lineWidth = s.size;
  ctx.lineCap = ctx.lineJoin = 'round';
  const [x0, y0] = s.points[0];
  if (s.points.length === 1) {
    ctx.beginPath();
    ctx.arc(x0, y0, s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
}

export function createBrush(opts: {
  frame: HTMLElement;
  result: () => HTMLImageElement;
  /** Called after a stroke or undo. The caller sends the edits to the worker. */
  onChange: () => void;
  onActivity: (drawing: boolean) => void;
}) {
  const { frame, result, onChange, onActivity } = opts;

  // Shows the strokes that are not in the result yet.
  const preview = document.createElement('canvas');
  preview.id = 'paint';
  preview.hidden = true;
  const cursor = document.createElement('div');
  cursor.id = 'brush-cursor';
  cursor.hidden = true;
  frame.append(preview, cursor);
  const pctx = preview.getContext('2d')!;

  let mode: BrushMode | undefined;
  let size = 40; // CSS pixels
  let strokes: Stroke[] = [];
  let applied = 0; // strokes[0..applied) are in the current result
  let current: Extract<Stroke, { size: number }> | undefined;

  /** Result pixels per CSS pixel. */
  const scale = () => result().naturalWidth / result().clientWidth;

  function redraw() {
    pctx.clearRect(0, 0, preview.width, preview.height);
    for (const s of strokes.slice(applied)) drawStroke(pctx, s, PREVIEW_COLORS);
    if (current) drawStroke(pctx, current, PREVIEW_COLORS);
  }

  function point(e: PointerEvent): [number, number] {
    const r = preview.getBoundingClientRect();
    const k = scale();
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }

  function moveCursor(e: PointerEvent) {
    // The preview covers the frame, and its box also works when the frame has display: contents.
    const r = preview.getBoundingClientRect();
    cursor.style.width = cursor.style.height = `${size}px`;
    cursor.style.transform = `translate(${e.clientX - r.left - size / 2}px, ${e.clientY - r.top - size / 2}px)`;
  }

  preview.addEventListener('pointerdown', (e) => {
    if (!mode || current || e.button !== 0) return;
    preview.setPointerCapture(e.pointerId);
    current = { mode, size: size * scale(), points: [point(e)] };
    onActivity(true);
    redraw();
  });
  preview.addEventListener('pointermove', (e) => {
    moveCursor(e);
    cursor.hidden = false;
    if (!current) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) current.points.push(point(ev));
    redraw();
  });
  const end = () => {
    if (!current) return;
    strokes.push(current);
    current = undefined;
    onActivity(false);
    redraw();
    onChange();
  };
  preview.addEventListener('pointerup', end);
  preview.addEventListener('pointercancel', end);
  preview.addEventListener('lostpointercapture', end);
  preview.addEventListener('pointerleave', () => (cursor.hidden = true));

  return {
    get mode() {
      return mode;
    },
    get size() {
      return size;
    },
    get canUndo() {
      return strokes.length > 0;
    },

    setMode(m: BrushMode | undefined) {
      if (current && m !== mode) end();
      mode = m;
      preview.hidden = !m;
      if (!m) cursor.hidden = true;
      frame.classList.toggle('painting', !!m);
    },

    setSize(px: number) {
      size = Math.min(300, Math.max(4, px));
      cursor.style.width = cursor.style.height = `${size}px`;
    },

    /** Fills all holes that the result marks. An edit like a stroke, so undo takes it back. */
    fillHoles() {
      if (current) end();
      strokes.push({ mode: 'holes' });
      onChange();
    },

    undo() {
      if (!strokes.length) return;
      strokes.pop();
      applied = Math.min(applied, strokes.length);
      redraw();
      onChange();
    },

    /** Forgets all strokes, e.g. for a new image. */
    reset() {
      strokes = [];
      applied = 0;
      current = undefined;
      onActivity(false);
      redraw();
      this.setMode(undefined);
    },

    /**
     * Draws all strokes into an edit image of the result size. Returns the
     * image, whether holes are to be filled, and the edit count it holds,
     * for markApplied().
     */
    async edits() {
      const count = strokes.length;
      const fillHoles = strokes.some((s) => s.mode === 'holes');
      if (!strokes.some((s) => s.mode !== 'holes')) return { bitmap: undefined, fillHoles, count };
      const canvas = new OffscreenCanvas(result().naturalWidth, result().naturalHeight);
      const ctx = canvas.getContext('2d')! as unknown as CanvasRenderingContext2D;
      for (const s of strokes) drawStroke(ctx, s, EDIT_COLORS);
      return { bitmap: canvas.transferToImageBitmap(), fillHoles, count };
    },

    /** Call when a result with the first `count` strokes is shown. */
    markApplied(count: number) {
      if (preview.width !== result().naturalWidth || preview.height !== result().naturalHeight) {
        preview.width = result().naturalWidth;
        preview.height = result().naturalHeight;
      }
      applied = Math.min(count, strokes.length);
      redraw();
    },
  };
}
