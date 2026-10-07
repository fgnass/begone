import { registerSW } from 'virtual:pwa-register';
import type { Bounds } from './bounds';
import { createBrush, type BrushMode } from './brush';
import type { Hole } from './holes';
import type { FromWorker, Stage } from './messages';
import { EditorState, type Request } from './editor-state';
import { WorkerClient } from './worker-client';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const fileInput = $<HTMLInputElement>('#file');
const frame = $('#frame');
// Holds the images and their overlays. When cropped, it is larger than the frame.
const view = $('#view');
const sizer = $<HTMLCanvasElement>('#sizer');
const original = $<HTMLImageElement>('#original');
let result = $<HTMLImageElement>('#result');
const status = $('#status');
const statusFill = $('#status .fill');
const statusLabel = $('#status .label');
const retryButton = $<HTMLButtonElement>('#retry');
const nameEl = $('#name');
const dims = $('#dims');
const hint = $('#hint');
const download = $<HTMLAnchorElement>('#download');
const compare = $<HTMLButtonElement>('#compare');
const copy = $<HTMLButtonElement>('#copy');
const shadowButton = $<HTMLButtonElement>('#shadow');
const cropButton = $<HTMLButtonElement>('#crop');
const restoreButton = $<HTMLButtonElement>('#restore');
const eraseButton = $<HTMLButtonElement>('#erase');
const brushSize = $<HTMLInputElement>('#brush-size');
const undoButton = $<HTMLButtonElement>('#undo');

registerSW({ immediate: true });

const worker = new WorkerClient(
  () => new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: new URLSearchParams(location.search).has('wasm') ? 'wasm' : 'begone',
  }),
  handleWorkerMessage,
  (message) => {
    editor.fail();
    renderState();
    showError(`Error: ${message}`, editor.file ? processImage : undefined);
  },
);

// Theme: light, dark or checkerboard. It is also the preview background.

type Theme = 'light' | 'dark' | 'checker';
const THEME_COLORS: Record<Theme, string> = { light: '#F5F5F5', dark: '#1E1E1E', checker: '#F5F5F5' };

function setTheme(theme: Theme, save = true) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')!.setAttribute('content', THEME_COLORS[theme]);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-set-theme]')) {
    b.setAttribute('aria-pressed', String(b.dataset.setTheme === theme));
  }
  if (save) {
    try {
      localStorage.setItem('bg-theme', theme);
    } catch {
      // Storage not available
    }
  }
}

setTheme((document.documentElement.dataset.theme as Theme) || 'light', false);
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-set-theme]')) {
  b.addEventListener('click', () => setTheme(b.dataset.setTheme as Theme));
}

// App state

const STAGE_LABELS: Record<Stage, string> = {
  download: 'Loading model (first time only)',
  init: 'Starting model',
  infer: 'Removing background',
  refine: 'Refining edges',
  encode: 'Creating PNG',
};
// The steps that run for every image. Download and start-up happen only once.
const STAGE_STEPS: Partial<Record<Stage, number>> = { infer: 1, refine: 2, encode: 3 };

function stageText(stage: Stage) {
  const step = STAGE_STEPS[stage];
  return step ? `${STAGE_LABELS[stage]} · ${step} of 3` : STAGE_LABELS[stage];
}

const editor = new EditorState();
// The preview always holds the full image, so that brush strokes and hole
// marks line up with the original. Cropping only changes the visible part.
// The export may be cropped.
let resultUrl: string | undefined;
let exportUrl: string | undefined;
let exportBlob: Blob | undefined;
let urls: string[] = [];
let baseName = 'image';

function renderState() {
  // An update keeps the previous preview and brushes available.
  const state = editor.hasResult ? 'done' : editor.phase === 'updating' ? 'working' : editor.phase;
  document.body.classList.remove('empty', 'working', 'done', 'failed');
  document.body.classList.add(state);
  updateControls();
}

/** The controls reflect editor state, including edits still being processed. */
function updateControls() {
  compare.disabled = !editor.hasResult;
  copy.disabled = !editor.canExport;
  download.setAttribute('aria-disabled', String(!editor.canExport));
  if (editor.canExport && exportUrl) download.href = exportUrl;
  else download.removeAttribute('href');
  shadowButton.disabled = cropButton.disabled = editor.phase === 'working';
  if (editor.phase !== 'updating') busyOption = undefined;
  for (const button of [shadowButton, cropButton]) button.setAttribute('aria-busy', String(button === busyOption));
  updateBrushButtons();
}

function setStatus(text: string, fraction?: number) {
  status.hidden = false;
  status.classList.remove('error');
  retryButton.hidden = true;
  status.classList.toggle('indeterminate', fraction === undefined);
  statusFill.style.width = fraction === undefined ? '' : `${Math.round(fraction * 100)}%`;
  statusLabel.textContent = text;
}

let retry: (() => void) | undefined;

function showError(text: string, onRetry?: () => void) {
  setStatus(text);
  status.classList.add('error');
  retry = onRetry;
  retryButton.hidden = !onRetry;
}

/** An obsolete failure starts the newest edits instead of replacing their status. */
function fail(request: Request, text: string, canRetry = true) {
  if (!editor.isCurrent(request)) {
    finishObsolete(request);
    return;
  }
  editor.fail();
  renderState();
  showError(text, canRetry ? processImage : undefined);
}

function finishObsolete(request: Request) {
  if (editor.finish(request.id)) void processImage();
}

retryButton.addEventListener('click', () => {
  status.hidden = true;
  retry?.();
});

const mb = (n: number) => (n / 1e6).toFixed(0);

function handleWorkerMessage(msg: FromWorker) {
  const request = editor.active;
  if (!request || request.id !== msg.id) return;
  if (msg.type === 'progress') {
    if (request.quiet || !editor.isCurrent(request)) return;
    if (msg.stage === 'download' && msg.total) {
      setStatus(`${STAGE_LABELS.download} ${mb(msg.loaded!)} / ${mb(msg.total)} MB`, msg.loaded! / msg.total);
    } else {
      setStatus(stageText(msg.stage));
    }
  } else if (msg.type === 'done') {
    void showResult(request, msg);
  } else {
    fail(request, `Error: ${msg.message}`);
  }
}

function resetView() {
  resultUrl = exportUrl = undefined;
  exportBlob = undefined;
  brush.reset();
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  document.body.classList.remove('compare');
  compare.setAttribute('aria-pressed', 'false');
  result.hidden = true;
  status.hidden = true;
  hintClosed = hintUsed = false;
  showHoles([]);
  bounds = undefined;
  showCrop();
  dims.textContent = '';
  fileInput.value = '';
}

function objectUrl(blob: Blob) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

async function handleFile(file: Blob, name = (file as File).name || 'clipboard.png') {
  if (!file.type.startsWith('image/')) return;
  editor.open(file);
  resetView();
  baseName = name.replace(/\.[^.]+$/, '') || 'image';
  nameEl.textContent = name;

  frame.hidden = false;
  original.src = objectUrl(file);
  await processImage();
}

/** Sends an immutable request snapshot; later edits get their own revision. */
async function processImage() {
  const request = editor.begin();
  if (!request) return;
  const file = editor.file!;
  const shadow = keepShadow;
  const crop = cropped;
  renderState();
  if (!request.quiet) {
    result.hidden = true;
    showHoles([]);
    setStatus(stageText('infer'));
  } else {
    // A retry clears the previous error while keeping the preview visible.
    status.hidden = true;
  }

  let bitmap: ImageBitmap | undefined;
  let edits: ImageBitmap | undefined;
  try {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      fail(request, 'Your browser cannot read this image format.', false);
      return;
    }
    if (!editor.isCurrent(request)) {
      bitmap.close();
      finishObsolete(request);
      return;
    }
    // Read synchronously with the strokes, so that both match.
    const edit = brushEdit;
    const strokes = await brush.edits();
    edits = strokes.bitmap;
    if (!editor.isCurrent(request)) {
      bitmap.close();
      edits?.close();
      finishObsolete(request);
      return;
    }
    request.strokes = strokes.count;
    if (!request.quiet) dims.textContent = `${bitmap.width} × ${bitmap.height}`;
    const transfer = edits ? [bitmap, edits] : [bitmap];
    if (!worker.send({ type: 'process', id: request.id, image: request.image, edit, bitmap, shadow, crop, edits }, transfer)) {
      bitmap.close();
      edits?.close();
    }
  } catch (err) {
    console.error(err);
    bitmap?.close();
    edits?.close();
    fail(request, `Error: ${(err as Error)?.message ?? err}`);
  }
}

function applyEdits() {
  editor.edit();
  renderState();
  void processImage();
}

function revokeUrl(url: string) {
  URL.revokeObjectURL(url);
  urls = urls.filter((u) => u !== url);
}

async function showResult(request: Request, msg: Extract<FromWorker, { type: 'done' }>) {
  const { blob, width, height, holes } = msg;
  if (!editor.isCurrent(request)) {
    finishObsolete(request);
    return;
  }
  // Keep the export and resultUrl paired with the displayed image until decode finishes.
  const url = objectUrl(blob);
  const next = new Image();
  next.src = url;
  try {
    await next.decode();
    if (!editor.isCurrent(request)) {
      revokeUrl(url);
      finishObsolete(request);
      return;
    }
    // Insert the already-decoded element: no second asynchronous decode can
    // update brush or hole state after a newer image has been opened.
    next.id = 'result';
    next.alt = result.alt;
    result.replaceWith(next);
    result = next;
    const oldUrls = [resultUrl, exportUrl];
    resultUrl = url;
    exportUrl = msg.cropped ? objectUrl(msg.cropped) : url;
    exportBlob = msg.cropped ?? blob;
    for (const old of new Set(oldUrls)) if (old) revokeUrl(old);
    editor.commit(request);
    result.hidden = false;
    status.hidden = true;
    download.download = `${baseName}-nobg.png`;
    size = { w: width, h: height };
    bounds = msg.bounds;
    showCrop();
    brush.markApplied(request.strokes);
    showHoles(holes);
    renderState();
  } catch (err) {
    revokeUrl(url);
    fail(request, `Cannot display the result: ${(err as Error)?.message ?? err}`);
  }
}

// Holes: transparent areas inside the object. Mark them and explain the
// Restore brush. The marks follow each update, so they go away once filled.

// Closed: no hint and no marks. Used: the user picked the Restore brush, so
// the hint is not needed any more, but the marks show where to paint.
let hintClosed = false;
let hintUsed = false;
let holeMarks: HTMLElement[] = [];

function showHoles(holes: Hole[]) {
  holeMarks.forEach((m) => m.remove());
  holeMarks = [];
  const visible = holes.length > 0 && !hintClosed;
  hint.hidden = !visible || hintUsed;
  if (!visible) return;
  for (const h of holes) {
    const mark = document.createElement('span');
    mark.className = 'hole-mark';
    mark.style.left = `${h.x * 100}%`;
    mark.style.top = `${h.y * 100}%`;
    mark.style.width = `${h.w * 100}%`;
    mark.style.height = `${h.h * 100}%`;
    view.append(mark);
    holeMarks.push(mark);
  }
}

$('#hint-close').addEventListener('click', () => {
  hintClosed = true;
  showHoles([]);
});
$('#hint-restore').addEventListener('click', () => {
  hintUsed = true;
  hint.hidden = true;
  brush.setMode('restore');
  updateBrushButtons();
});

// Shadow option. The setting is kept, and a change applies to the current image.

// The option whose change is being applied. It shows that it is busy.
let busyOption: HTMLButtonElement | undefined;

let keepShadow = true;
try {
  keepShadow = localStorage.getItem('bg-shadow') !== 'off';
} catch {
  // Storage not available
}
shadowButton.setAttribute('aria-pressed', String(keepShadow));

shadowButton.addEventListener('click', () => {
  keepShadow = !keepShadow;
  shadowButton.setAttribute('aria-pressed', String(keepShadow));
  try {
    localStorage.setItem('bg-shadow', keepShadow ? 'on' : 'off');
  } catch {
    // Storage not available
  }
  if (editor.file) {
    busyOption = shadowButton;
    applyEdits();
  }
});

// Crop option: shows and exports only the visible pixels. The bounds come
// with each result, so they follow later edits, e.g. a shadow that is switched
// on. The setting is kept, and a change applies to the current image.

let cropped = false;
try {
  cropped = localStorage.getItem('bg-crop') === 'on';
} catch {
  // Storage not available
}
cropButton.setAttribute('aria-pressed', String(cropped));
let bounds: Bounds | undefined;
let size = { w: 0, h: 0 };

function showCrop() {
  cropButton.setAttribute('aria-pressed', String(cropped));
  const b = cropped ? bounds : undefined;
  frame.classList.toggle('cropped', !!b);
  dims.textContent = b ? `${b.w} × ${b.h}` : size.w ? `${size.w} × ${size.h}` : '';
  if (!b) return;
  sizer.width = b.w;
  sizer.height = b.h;
  view.style.left = `${(-b.x / b.w) * 100}%`;
  view.style.top = `${(-b.y / b.h) * 100}%`;
  view.style.width = `${(size.w / b.w) * 100}%`;
  view.style.height = `${(size.h / b.h) * 100}%`;
}

cropButton.addEventListener('click', () => {
  cropped = !cropped;
  try {
    localStorage.setItem('bg-crop', cropped ? 'on' : 'off');
  } catch {
    // Storage not available
  }
  showCrop();
  if (editor.file) {
    busyOption = cropButton;
    applyEdits();
  }
});

// Brush to fix the mask by hand

// Counts stroke changes. The worker reuses its refined result while it stays
// the same, e.g. when only the shadow or crop option changes.
let brushEdit = 0;

const brush = createBrush({
  frame: view,
  result: () => result,
  onChange: () => {
    brushEdit++;
    applyEdits();
  },
  onActivity: (drawing) => {
    editor.drawing = drawing;
    updateControls();
  },
});
brush.setSize(Number(brushSize.value));

function updateBrushButtons() {
  const ready = editor.hasResult;
  restoreButton.disabled = eraseButton.disabled = !ready;
  restoreButton.setAttribute('aria-pressed', String(brush.mode === 'restore'));
  eraseButton.setAttribute('aria-pressed', String(brush.mode === 'erase'));
  brushSize.disabled = !ready || !brush.mode;
  undoButton.disabled = !ready || !brush.canUndo;
}

function toggleBrush(mode: BrushMode | undefined) {
  brush.setMode(brush.mode === mode ? undefined : mode);
  updateBrushButtons();
}

updateControls();

restoreButton.addEventListener('click', () => toggleBrush('restore'));
eraseButton.addEventListener('click', () => toggleBrush('erase'));
undoButton.addEventListener('click', () => brush.undo());
brushSize.addEventListener('input', () => brush.setSize(Number(brushSize.value)));

window.addEventListener('keydown', (e) => {
  if (!editor.hasResult) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    brush.undo();
  } else if (e.metaKey || e.ctrlKey || e.altKey) {
    return;
  } else if (e.key === 'b') {
    toggleBrush('restore');
  } else if (e.key === 'e') {
    toggleBrush('erase');
  } else if (e.key === 'Escape') {
    toggleBrush(undefined);
  } else if (e.key === '[' || e.key === ']') {
    brush.setSize(brush.size * (e.key === '[' ? 0.8 : 1.25));
    brushSize.value = String(Math.round(brush.size));
  }
});

$('#open').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

compare.addEventListener('click', () => {
  if (!editor.hasResult) return;
  const on = document.body.classList.toggle('compare');
  compare.setAttribute('aria-pressed', String(on));
});

copy.addEventListener('click', async () => {
  if (!editor.canExport || !exportBlob) return;
  let label = 'Copied';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob })]);
    copy.classList.add('copied');
  } catch {
    label = 'Copying is not possible in this browser';
  }
  copy.title = label;
  copy.setAttribute('aria-label', label);
  setTimeout(() => {
    copy.classList.remove('copied');
    copy.title = 'Copy to clipboard';
    copy.setAttribute('aria-label', 'Copy to clipboard');
  }, 1500);
});

download.addEventListener('click', (event) => {
  if (!editor.canExport) event.preventDefault();
});

// Drag and drop anywhere on the page
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (file) handleFile(file);
});

// Paste from clipboard
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) handleFile(file, file.name || 'clipboard.png');
});

// "Open with" from the OS when installed (file_handlers in the manifest)
if ('launchQueue' in window) {
  (window as any).launchQueue.setConsumer(async (params: { files: FileSystemFileHandle[] }) => {
    const handle = params.files[0];
    if (handle) handleFile(await handle.getFile());
  });
}
