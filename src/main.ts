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
const shadowGroup = $('#shadow-group');
const shadowTempButton = $<HTMLButtonElement>('#shadow-temp-button');
const shadowTempPanel = $('#shadow-temp-panel');
const shadowSoftButton = $<HTMLButtonElement>('#shadow-soft-button');
const shadowSoftPanel = $('#shadow-soft-panel');
const shadowTemp = $<HTMLInputElement>('#shadow-temp');
const shadowOriginal = $<HTMLOptionElement>('#shadow-original');
const shadowSoft = $<HTMLInputElement>('#shadow-soft');
const previewCanvas = $<HTMLCanvasElement>('#preview');
const restoreButton = $<HTMLButtonElement>('#restore');
const eraseButton = $<HTMLButtonElement>('#erase');
const brushSize = $<HTMLInputElement>('#brush-size');
const brushSizePanel = $('#brush-size-panel');
const undoButton = $<HTMLButtonElement>('#undo');

registerSW({ immediate: true });

// Sliders sit in small panels above their buttons. One is open at a time.
// The brush size panel belongs to the active brush button; the shadow
// panels have a button of their own, which also opens and closes them.

type Pop = { readonly button: HTMLButtonElement; panel: HTMLElement; toggles: boolean };

const brushPop: Pop = {
  get button() {
    return brush.mode === 'erase' ? eraseButton : restoreButton;
  },
  panel: brushSizePanel,
  toggles: false,
};
const pops: Pop[] = [
  brushPop,
  { button: shadowTempButton, panel: shadowTempPanel, toggles: true },
  { button: shadowSoftButton, panel: shadowSoftPanel, toggles: true },
];

function openPop(open: Pop | undefined) {
  for (const pop of pops) {
    const on = pop === open;
    pop.panel.hidden = !on;
    pop.button.setAttribute('aria-expanded', String(on));
    if (pop.toggles) pop.button.setAttribute('aria-pressed', String(on));
  }
  if (open === brushPop) {
    // Centre the panel over the active brush button.
    const button = brushPop.button;
    brushPop.panel.style.left = `${button.offsetLeft + button.offsetWidth / 2}px`;
  }
}

/** A panel whose button got disabled closes. */
function closeDisabledPops() {
  for (const pop of pops) if (pop.button.disabled && !pop.panel.hidden) openPop(undefined);
}

for (const pop of pops) {
  if (pop.toggles) pop.button.addEventListener('click', () => openPop(pop.panel.hidden ? pop : undefined));
}
// A click outside the open panel and its button closes it.
window.addEventListener('pointerdown', (e) => {
  const target = e.target as Node | null;
  const open = pops.find((pop) => !pop.panel.hidden);
  if (!open || !target || open.panel.contains(target) || open.button.contains(target)) return;
  openPop(undefined);
});

// The image that the worker holds. Other requests for it send no bitmap, so
// that a change does not decode the file again.
let workerImage: number | undefined;

const worker = new WorkerClient(
  () => new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: new URLSearchParams(location.search).has('wasm') ? 'wasm' : 'begone',
  }),
  handleWorkerMessage,
  (message) => {
    workerImage = undefined;
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
  shadowTempButton.disabled = shadowSoftButton.disabled = shadowButton.disabled || !keepShadow;
  closeDisabledPops();
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
  if (msg.type === 'preview') {
    showPreview(msg);
    return;
  }
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
    // A retry sends the image again, in case the worker lost it.
    workerImage = undefined;
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
  shadowFound = undefined;
  shadowTemperature = undefined;
  showShadowControls();
  endPreview();
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
  const soft = shadowSoftness;
  const temperature = shadowTemperature;
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
    if (workerImage !== request.image) {
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
    }
    // Read synchronously with the strokes, so that both match.
    const edit = brushEdit;
    const strokes = await brush.edits();
    edits = strokes.bitmap;
    const fillHoles = strokes.fillHoles;
    if (!editor.isCurrent(request)) {
      bitmap?.close();
      edits?.close();
      finishObsolete(request);
      return;
    }
    request.strokes = strokes.count;
    if (bitmap && !request.quiet) dims.textContent = `${bitmap.width} × ${bitmap.height}`;
    const transfer = [bitmap, edits].filter((b) => !!b);
    const message = { type: 'process' as const, id: request.id, image: request.image, edit, bitmap, shadow, soft, temperature, crop, fillHoles, edits };
    if (worker.send(message, transfer)) {
      if (bitmap) workerImage = request.image;
    } else {
      bitmap?.close();
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
    shadowFound = msg.shadow;
    showShadowControls();
    endPreview();
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
$('#hint-fill').addEventListener('click', () => brush.fillHoles());
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
  changeShadow(true);
  updateControls();
});

// Shadow settings: colour temperature and softness. The worker reports
// whether the image has a shadow and the measured temperature of its colour.
// Without a shadow, the whole group is hidden. The softness is kept; the
// temperature belongs to one image and starts at the measured colour.

let shadowFound: { temperature: number } | undefined;
let shadowTemperature: number | undefined;
let shadowSoftness = 0;
try {
  shadowSoftness = Math.min(1, Math.max(0, Number(localStorage.getItem('bg-shadow-soft')) || 0));
} catch {
  // Storage not available
}
shadowSoft.value = String(Math.round(shadowSoftness * 100));

function showShadowControls() {
  shadowGroup.hidden = !shadowFound;
  if (!shadowFound) {
    closeDisabledPops();
    return;
  }
  const original = Math.round(shadowFound.temperature * 100);
  shadowOriginal.value = String(original);
  // While the slider is in use, its value is the newest one; a result for an
  // older value must not move it back.
  if (document.activeElement !== shadowTemp) {
    shadowTemp.value = String(shadowTemperature === undefined ? original : Math.round(shadowTemperature * 100));
  }
  updateControls();
}

/**
 * A change of a setting applies to the current image. The toggle shows that
 * it is busy; the sliders do not, because a busy sign that starts and stops
 * with every step of a slider only flickers.
 */
function changeShadow(busy: boolean) {
  if (!editor.file) return;
  busyOption = busy ? shadowButton : undefined;
  applyEdits();
}

// While a slider moves, the worker renders small previews without a PNG,
// and a canvas shows them over the result. The result itself is made once,
// when the slider is released. Until then, the edit counts as pending, so
// that no stale PNG is exported.

// Only one preview request runs at a time. A move while one runs is sent
// when the answer arrives, with the newest values.
let previewId = 0;
let previewBusy = false;
let previewAgain = false;
let previewing = false;

function requestPreview() {
  if (!editor.file || !shadowFound || !editor.hasResult) return;
  if (previewBusy) {
    previewAgain = true;
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const size = Math.min(1536, Math.round(Math.max(result.clientWidth, result.clientHeight) * dpr) || 1024);
  const message = {
    type: 'preview' as const, id: ++previewId, image: editor.image, edit: brushEdit,
    soft: shadowSoftness, temperature: shadowTemperature, size,
  };
  previewBusy = worker.send(message, []);
}

function showPreview(msg: Extract<FromWorker, { type: 'preview' }>) {
  previewBusy = false;
  const { bitmap } = msg;
  // The newest preview is shown even if a newer value waits: it is closer
  // than what is on screen. Stale is only a preview for another image, or
  // one that arrives after the result is already shown.
  if (bitmap && previewing && msg.image === editor.image && msg.id === previewId) {
    if (previewCanvas.width !== bitmap.width || previewCanvas.height !== bitmap.height) {
      previewCanvas.width = bitmap.width;
      previewCanvas.height = bitmap.height;
    }
    const ctx = previewCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    previewCanvas.hidden = false;
    frame.classList.add('previewing');
  }
  bitmap?.close();
  if (previewAgain) {
    previewAgain = false;
    requestPreview();
  }
}

/** The result is current again: the preview is not needed. */
function endPreview() {
  previewing = false;
  previewAgain = false;
  previewCanvas.hidden = true;
  frame.classList.remove('previewing');
}

/** A slider moved: the current result is out of date, and a preview shows the new value. */
function moveShadow() {
  if (!editor.file) return;
  previewing = true;
  editor.edit();
  renderState();
  requestPreview();
}

shadowTemp.addEventListener('input', () => {
  const value = Number(shadowTemp.value) / 100;
  // Close to the measured colour means the measured colour.
  shadowTemperature = shadowFound && Math.abs(value - shadowFound.temperature) < 0.03 ? undefined : value;
  moveShadow();
});
shadowSoft.addEventListener('input', () => {
  shadowSoftness = Number(shadowSoft.value) / 100;
  try {
    localStorage.setItem('bg-shadow-soft', String(shadowSoftness));
  } catch {
    // Storage not available
  }
  moveShadow();
});
// Released: make the real result.
for (const slider of [shadowTemp, shadowSoft]) slider.addEventListener('change', () => changeShadow(false));

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
  closeDisabledPops();
  if (!brush.mode && !brushSizePanel.hidden) openPop(undefined);
  undoButton.disabled = !ready || !brush.canUndo;
}

/** Turns a brush on or off. A click on its button also shows the size slider. */
function toggleBrush(mode: BrushMode | undefined, showSize = false) {
  brush.setMode(brush.mode === mode ? undefined : mode);
  updateBrushButtons();
  if (showSize && brush.mode) openPop(brushPop);
}

updateControls();

restoreButton.addEventListener('click', () => toggleBrush('restore', true));
eraseButton.addEventListener('click', () => toggleBrush('erase', true));
undoButton.addEventListener('click', () => brush.undo());
brushSize.addEventListener('input', () => brush.setSize(Number(brushSize.value)));

// About dialog. A click outside the card closes it.

const about = $<HTMLDialogElement>('#about');
$('#about-open').addEventListener('click', () => about.showModal());
about.addEventListener('click', (e) => {
  if (e.target === about) about.close();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pops.some((pop) => !pop.panel.hidden)) {
    openPop(undefined);
    return;
  }
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
