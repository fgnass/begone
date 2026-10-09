// Finds holes in the cut-out: transparent areas that the object encloses on
// all sides. Often the model dropped a part of the object there (a bag, a
// light shirt), but it can also be real background, e.g. between an arm and
// the body. The app points them out and offers to restore them, by hand with
// the brush or all at once with fillHoles().

/** A hole's bounding box, as fractions of the image size. */
export type Hole = { x: number; y: number; w: number; h: number };

const GRID = 256; // cells on the long side
const MAX_HOLES = 5;

type Component = { mark: number; size: number; minX: number; minY: number; maxX: number; maxY: number };

/**
 * Finds the enclosed areas on a coarse grid. Returns the grid, with the cells
 * of each hole marked with the hole's `mark`, and the holes by size.
 */
function analyse(alpha: Float32Array, erase: Float32Array | undefined, w: number, h: number) {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / GRID));
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);
  const n = gw * gh;

  // 0 = object, 1 = empty, 2 = empty and reached from the image border
  const cells = new Uint8Array(n);
  const cellAlpha = new Float32Array(n);
  let objectCells = 0;
  for (let gy = 0; gy < gh; gy++) {
    const y = Math.min(h - 1, gy * step + (step >> 1));
    for (let gx = 0; gx < gw; gx++) {
      const i = y * w + Math.min(w - 1, gx * step + (step >> 1));
      const empty = alpha[i] < 0.5 && !(erase && erase[i] > 0.5);
      cells[gy * gw + gx] = empty ? 1 : 0;
      cellAlpha[gy * gw + gx] = alpha[i];
      if (alpha[i] >= 0.5) objectCells++;
    }
  }
  const none = { step, gw, gh, cells, holes: [] as Component[] };
  if (!objectCells) return none;

  const queue = new Int32Array(n);

  /**
   * Flood-fills the empty cells connected to `start` and marks them with
   * `mark`. Also counts how much of the object around the area is solid.
   */
  function fill(start: number, mark: number) {
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    cells[start] = mark;
    let minX = gw, minY = gh, maxX = 0, maxY = 0;
    let rim = 0;
    let solid = 0;
    const visit = (j: number) => {
      if (cells[j] === 1) {
        cells[j] = mark;
        queue[tail++] = j;
      } else if (cells[j] === 0) {
        rim++;
        if (cellAlpha[j] > 0.95) solid++;
      }
    };
    while (head < tail) {
      const i = queue[head++];
      const x = i % gw;
      const y = (i - x) / gw;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) visit(i - 1);
      if (x < gw - 1) visit(i + 1);
      if (y > 0) visit(i - gw);
      if (y < gh - 1) visit(i + gw);
    }
    return { size: tail, solidRim: rim ? solid / rim : 0, minX, minY, maxX, maxY };
  }

  // Everything empty that touches the border is real background.
  for (let x = 0; x < gw; x++) {
    if (cells[x] === 1) fill(x, 2);
    const b = (gh - 1) * gw + x;
    if (cells[b] === 1) fill(b, 2);
  }
  for (let y = 0; y < gh; y++) {
    if (cells[y * gw] === 1) fill(y * gw, 2);
    const r = y * gw + gw - 1;
    if (cells[r] === 1) fill(r, 2);
  }

  // What is left are enclosed areas. Ignore specks, areas that are large
  // compared to the object (most likely meant to be empty), and areas with a
  // soft rim: gaps between strands of hair or fur show real background.
  const minSize = Math.max(12, n * 0.0005);
  const maxSize = objectCells * 0.25;
  // Measured: gaps in hair ~0.05–0.15, a hole in a solid object ~0.8.
  const minSolidRim = 0.6;
  const holes: Component[] = [];
  let mark = 3;
  for (let i = 0; i < n; i++) {
    if (cells[i] !== 1) continue;
    const r = fill(i, mark);
    if (r.size < minSize || r.size > maxSize || r.solidRim < minSolidRim) continue;
    holes.push({ mark, ...r });
    // Marks are bytes; more enclosed areas than that are specks anyway.
    if (mark < 255) mark++;
  }
  return { ...none, holes: holes.sort((a, b) => b.size - a.size).slice(0, MAX_HOLES) };
}

/**
 * `alpha` is the object alpha (0..1). Pixels with `erase` > 0.5 were erased
 * on purpose and do not count as holes.
 */
export function findHoles(alpha: Float32Array, erase: Float32Array | undefined, w: number, h: number): Hole[] {
  const { step, holes } = analyse(alpha, erase, w, h);
  return holes.map((r) => ({
    x: (r.minX * step) / w,
    y: (r.minY * step) / h,
    w: Math.min(1, ((r.maxX + 1) * step) / w) - (r.minX * step) / w,
    h: Math.min(1, ((r.maxY + 1) * step) / h) - (r.minY * step) / h,
  }));
}

/**
 * Makes the holes that findHoles() would report part of the object, in
 * place. The fill is exact to the pixel: it floods the transparent pixels
 * from the hole's cells, inside the hole's box with one cell of margin, and
 * then grows by one pixel so that the soft rim of the hole closes too.
 * Returns the number of holes filled.
 */
export function fillHoles(alpha: Float32Array, erase: Float32Array | undefined, w: number, h: number) {
  const { step, gw, cells, holes } = analyse(alpha, erase, w, h);
  const empty = (i: number) => alpha[i] < 0.5 && !(erase && erase[i] > 0.5);
  for (const hole of holes) {
    const x0 = Math.max(0, (hole.minX - 1) * step);
    const y0 = Math.max(0, (hole.minY - 1) * step);
    const x1 = Math.min(w, (hole.maxX + 2) * step);
    const y1 = Math.min(h, (hole.maxY + 2) * step);
    const bw = x1 - x0;
    const bh = y1 - y0;
    const filled = new Uint8Array(bw * bh);
    const queue = new Int32Array(bw * bh);
    let tail = 0;
    const push = (x: number, y: number) => {
      const j = (y - y0) * bw + (x - x0);
      if (filled[j] || !empty(y * w + x)) return;
      filled[j] = 1;
      queue[tail++] = j;
    };
    // Seeds: every transparent pixel in the hole's cells.
    for (let gy = hole.minY; gy <= hole.maxY; gy++) {
      for (let gx = hole.minX; gx <= hole.maxX; gx++) {
        if (cells[gy * gw + gx] !== hole.mark) continue;
        for (let y = gy * step; y < Math.min(h, (gy + 1) * step); y++) {
          for (let x = gx * step; x < Math.min(w, (gx + 1) * step); x++) push(x, y);
        }
      }
    }
    for (let head = 0; head < tail; head++) {
      const j = queue[head];
      const x = x0 + (j % bw);
      const y = y0 + (j - (j % bw)) / bw;
      if (x > x0) push(x - 1, y);
      if (x < x1 - 1) push(x + 1, y);
      if (y > y0) push(x, y - 1);
      if (y < y1 - 1) push(x, y + 1);
    }
    for (let head = 0; head < tail; head++) {
      const j = queue[head];
      const x = x0 + (j % bw);
      const y = y0 + (j - (j % bw)) / bw;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) alpha[yy * w + xx] = 1;
        }
      }
    }
  }
  return holes.length;
}
