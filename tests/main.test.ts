import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { EditorState } from '../src/editor-state';
import { WorkerClient } from '../src/worker-client';

class Classes {
  values = new Set<string>();
  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
  toggle(name: string, force = !this.contains(name)) { force ? this.add(name) : this.remove(name); return force; }
}

class Element {
  id = '';
  alt = '';
  src = '';
  href: string | undefined;
  hidden = false;
  disabled = false;
  value = '40';
  textContent = '';
  naturalWidth = 100;
  naturalHeight = 80;
  clientWidth = 100;
  classList = new Classes();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, (event?: any) => any> = {};
  addEventListener(name: string, callback: (event: any) => any) { this.listeners[name] = callback; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; if (name === 'href') this.href = undefined; }
  append() {}
  remove() {}
  replaceWith(next: Element) {}
}

function app() {
  const elements = new Map<string, Element>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  const decoding: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const workers: any[] = [];
  let strokes = 0;
  let applied = -1;
  let brushOptions: any;
  let clipboardWrites = 0;
  const revoked: string[] = [];
  let urlSequence = 0;
  class MockURL extends URL {
    static createObjectURL() { return `blob:test-${++urlSequence}`; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  const context = vm.createContext({
    EditorState, WorkerClient, Blob, URLSearchParams, URL: MockURL, location: { search: '' },
    registerSW() {},
    document: {
      body: { classList: new Classes() }, documentElement: { dataset: {} },
      querySelector: element, querySelectorAll: () => [], createElement: () => new Element(),
    },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { async write() { clipboardWrites++; } } },
    ClipboardItem: class {}, setTimeout() {}, console,
    Image: class extends Element {
      decode() { return new Promise<void>((resolve, reject) => { decoding.push({ resolve, reject }); }); }
    },
    Worker: class {
      onmessage: any;
      onerror: any;
      onmessageerror: any;
      terminated = false;
      messages: any[] = [];
      constructor() { workers.push(this); }
      postMessage(message: any) { this.messages.push(message); }
      terminate() { this.terminated = true; }
    },
    createImageBitmap: async () => ({ width: 100, height: 80, close() {} }),
    createBrush(options: any) {
      brushOptions = options;
      return {
        mode: undefined, size: 40, get canUndo() { return strokes > 0; },
        setMode() {}, setSize() {}, undo() { strokes--; options.onChange(); },
        reset() { strokes = 0; options.onActivity(false); },
        edits: async () => ({ bitmap: undefined, count: strokes }),
        markApplied(count: number) { applied = count; },
      };
    },
  });
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace("new URL('./worker.ts', import.meta.url)", "'worker.js'");
  vm.runInContext(stripTypeScriptTypes(source), context);
  return {
    element, decoding, workers, revoked,
    state: () => vm.runInContext('editor', context) as EditorState,
    preview: () => vm.runInContext('result.src', context) as string,
    applied: () => applied,
    clipboardWrites: () => clipboardWrites,
    async open() {
      context.file = new Blob(['image'], { type: 'image/png' });
      await vm.runInContext("handleFile(file, 'test.png')", context);
    },
    edit() { strokes++; brushOptions.onChange(); },
    lastRequest: () => workers.at(-1).messages.at(-1),
    done(extra: Record<string, unknown> = {}) {
      const worker = workers.at(-1);
      const request = worker.messages.at(-1);
      worker.onmessage({ data: { type: 'done', id: request.id, blob: new Blob(['png']), width: 100, height: 80, holes: [], ...extra } });
    },
    flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
  };
}

test('UI cannot export pending edits and ignores edits superseded during PNG decode', async () => {
  const ui = app();
  await ui.open();
  ui.done();
  assert.equal(ui.element('#copy').disabled, true);
  ui.decoding[0].resolve();
  await ui.flush();
  const originalPreview = ui.preview();
  assert.equal(ui.element('#copy').disabled, false);
  ui.edit();
  assert.equal(ui.element('#copy').disabled, true);
  assert.equal(ui.element('#download').href, undefined);
  await ui.element('#copy').listeners.click();
  let prevented = false;
  ui.element('#download').listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(ui.clipboardWrites(), 0);
  await ui.flush();
  ui.done();
  ui.edit(); // another stroke while the first result is decoding
  ui.decoding[1].resolve();
  await ui.flush();
  assert.equal(ui.preview(), originalPreview);
  assert.equal(ui.applied(), 0);
  assert.equal(ui.element('#copy').disabled, true);
  ui.done();
  ui.decoding[2].resolve();
  await ui.flush();
  assert.notEqual(ui.preview(), originalPreview);
  assert.equal(ui.applied(), 2);
  assert.equal(ui.element('#copy').disabled, false);
  assert.equal(ui.element('#download').href, ui.preview());
});

test('option changes keep the edit number and show a busy state until the result is shown', async () => {
  const ui = app();
  await ui.open();
  ui.done();
  ui.decoding[0].resolve();
  await ui.flush();
  const first = ui.lastRequest().edit;
  ui.element('#shadow').listeners.click();
  await ui.flush();
  assert.equal(ui.lastRequest().edit, first);
  assert.equal(ui.element('#shadow').attrs['aria-busy'], 'true');
  assert.equal(ui.element('#crop').attrs['aria-busy'], 'false');
  ui.done();
  ui.decoding[1].resolve();
  await ui.flush();
  assert.equal(ui.element('#shadow').attrs['aria-busy'], 'false');
  ui.edit();
  await ui.flush();
  assert.notEqual(ui.lastRequest().edit, first);
  assert.equal(ui.element('#shadow').attrs['aria-busy'], 'false');
});

test('opening another image during decode prevents the previous image from appearing', async () => {
  const ui = app();
  await ui.open();
  ui.done();
  await ui.open();
  const current = ui.state().active;
  ui.decoding[0].resolve();
  await ui.flush();
  assert.equal(ui.state().active, current);
  assert.equal(ui.state().hasResult, false);
  assert.equal(ui.element('#copy').disabled, true);
  ui.done();
  ui.decoding[1].resolve();
  await ui.flush();
  assert.equal(ui.state().canExport, true);
});

test('worker script failure exits working state and retry creates a new worker', async () => {
  const ui = app();
  await ui.open();
  const first = ui.workers[0];
  first.onerror({ message: 'Script failed to load', preventDefault() {} });
  assert.equal(ui.state().phase, 'failed');
  assert.equal(ui.state().active, undefined);
  assert.equal(ui.element('#retry').hidden, false);
  assert.equal(ui.element('#shadow').disabled, false);
  ui.element('#retry').listeners.click();
  await ui.flush();
  assert.equal(ui.workers.length, 2);
  assert.equal(first.terminated, true);
  ui.done();
  ui.decoding[0].resolve();
  await ui.flush();
  assert.equal(ui.state().canExport, true);
});

test('PNG decoding failure reports an error and keeps exports disabled', async () => {
  const ui = app();
  await ui.open();
  ui.done();
  ui.decoding[0].reject(new Error('Invalid PNG'));
  await ui.flush();
  assert.equal(ui.state().phase, 'failed');
  assert.equal(ui.element('#retry').hidden, false);
  assert.equal(ui.element('#copy').disabled, true);
});

test('crop shows and exports the bounds and follows new bounds', async () => {
  const ui = app();
  let decoded = 0;
  const finish = async (extra: Record<string, unknown> = {}) => {
    ui.done(extra);
    ui.decoding[decoded++].resolve();
    await ui.flush();
  };
  const frame = ui.element('#frame');
  const view = ui.element('#view');
  await ui.open();
  assert.equal(ui.lastRequest().crop, false);
  await finish({ bounds: { x: 10, y: 20, w: 50, h: 40 } });
  assert.equal(frame.classList.contains('cropped'), false);

  ui.element('#crop').listeners.click();
  assert.equal(ui.element('#crop').attrs['aria-pressed'], 'true');
  assert.equal(frame.classList.contains('cropped'), true);
  assert.equal(view.style.left, '-20%');
  assert.equal(view.style.width, '200%');
  assert.equal(ui.element('#dims').textContent, '50 × 40');
  await ui.flush();
  assert.equal(ui.lastRequest().crop, true);
  await finish({ bounds: { x: 10, y: 20, w: 50, h: 40 }, cropped: new Blob(['cropped']) });
  assert.notEqual(ui.element('#download').href, ui.preview());

  // A shadow makes the visible area larger.
  ui.element('#shadow').listeners.click();
  await ui.flush();
  assert.equal(ui.lastRequest().crop, true);
  await finish({ bounds: { x: 0, y: 20, w: 100, h: 60 }, cropped: new Blob(['larger']) });
  assert.equal(view.style.left, '0%');
  assert.equal(ui.element('#dims').textContent, '100 × 60');

  ui.element('#crop').listeners.click();
  assert.equal(frame.classList.contains('cropped'), false);
  assert.equal(ui.element('#dims').textContent, '100 × 80');
  await ui.flush();
  assert.equal(ui.lastRequest().crop, false);
  await finish({ bounds: { x: 0, y: 20, w: 100, h: 60 } });
  assert.equal(ui.element('#download').href, ui.preview());
});
