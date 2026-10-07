import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrush } from '../src/brush';

// Only drawing calls are stubbed; pointer handlers and brush lifecycle are real.
function brushFixture() {
  const previous = globalThis.document;
  const canvas = {
    id: '', width: 100, height: 80, hidden: false,
    listeners: {} as Record<string, (event: any) => void>,
    getContext: () => ({ clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {} }),
    addEventListener(name: string, handler: (event: any) => void) { this.listeners[name] = handler; },
    setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  globalThis.document = { createElement: (tag: string) => tag === 'canvas' ? canvas : { style: {}, hidden: false } } as unknown as Document;
  const activity: boolean[] = [];
  let changes = 0;
  const result = { naturalWidth: 100, naturalHeight: 80, clientWidth: 100 } as HTMLImageElement;
  const frame = { append() {}, classList: { toggle() {} } } as unknown as HTMLElement;
  const brush = createBrush({ frame, result: () => result, onChange: () => changes++, onActivity: (value) => activity.push(value) });
  return {
    canvas, activity, brush, changes: () => changes,
    restore() { globalThis.document = previous; },
    start() { brush.setMode('restore'); canvas.listeners.pointerdown({ button: 0, pointerId: 1, clientX: 20, clientY: 20 }); },
  };
}

for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'switch-mode']) {
  test(`${end} ends a stroke and releases the export activity gate exactly once`, () => {
    const fixture = brushFixture();
    try {
      fixture.start();
      assert.deepEqual(fixture.activity, [true]);
      assert.equal(fixture.changes(), 0);
      if (end === 'switch-mode') fixture.brush.setMode(undefined);
      else fixture.canvas.listeners[end]({});
      fixture.canvas.listeners.pointerup({}); // duplicate pointer/capture events are harmless
      assert.deepEqual(fixture.activity, [true, false]);
      assert.equal(fixture.changes(), 1);
      assert.equal(fixture.brush.canUndo, true);
    } finally {
      fixture.restore();
    }
  });
}

test('reset releases an unfinished stroke without applying it to the new image', () => {
  const fixture = brushFixture();
  try {
    fixture.start();
    fixture.brush.reset();
    fixture.canvas.listeners.pointerup({});
    assert.deepEqual(fixture.activity, [true, false]);
    assert.equal(fixture.changes(), 0);
    assert.equal(fixture.brush.canUndo, false);
    assert.equal(fixture.brush.mode, undefined);
  } finally {
    fixture.restore();
  }
});
