import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '../src/editor-state';

const image = () => new Blob(['image'], { type: 'image/png' });

function readyEditor() {
  const editor = new EditorState();
  editor.open(image());
  assert.equal(editor.commit(editor.begin()!), true);
  return editor;
}

test('exports wait for the latest edit, including edits arriving during a request', () => {
  const editor = readyEditor();
  assert.equal(editor.canExport, true);
  editor.edit();
  assert.equal(editor.canExport, false);
  const first = editor.begin()!;
  editor.edit(); // undo or another stroke while the first edit is processing
  assert.equal(editor.begin(), undefined);
  assert.equal(editor.commit(first), false);
  assert.equal(editor.finish(first.id), true);
  const latest = editor.begin()!;
  assert.equal(editor.canExport, false);
  assert.equal(editor.commit(latest), true);
  assert.equal(editor.canExport, true);
});

test('an edit arriving during image decode prevents the decoded result from committing', async () => {
  const editor = readyEditor();
  editor.edit();
  const request = editor.begin()!;
  let decoded!: () => void;
  const decoding = new Promise<void>((resolve) => { decoded = resolve; });
  const commit = decoding.then(() => editor.commit(request));
  editor.edit();
  decoded();
  assert.equal(await commit, false);
  assert.equal(editor.displayed?.revision, 0);
  assert.equal(editor.canExport, false);
});

test('a previous image cannot commit or finish a newer image request', () => {
  const editor = new EditorState();
  editor.open(image());
  const previous = editor.begin()!;
  editor.open(image());
  const current = editor.begin()!;
  assert.equal(editor.commit(previous), false);
  assert.equal(editor.finish(previous.id), false);
  assert.equal(editor.active, current);
  assert.equal(editor.commit(current), true);
});

test('drawing disables export and defers processing until the stroke ends', () => {
  const editor = readyEditor();
  editor.drawing = true;
  assert.equal(editor.canExport, false);
  editor.edit();
  assert.equal(editor.begin(), undefined);
  editor.drawing = false;
  assert.equal(editor.commit(editor.begin()!), true);
  assert.equal(editor.canExport, true);
});

test('failure clears the request and retry retains the image and edits', () => {
  const editor = readyEditor();
  editor.edit();
  const previous = editor.begin()!;
  editor.fail();
  assert.equal(editor.active, undefined);
  assert.equal(editor.phase, 'failed');
  assert.equal(editor.hasResult, true);
  assert.equal(editor.canExport, false);
  const retry = editor.begin()!;
  assert.equal(retry.image, previous.image);
  assert.equal(retry.revision, previous.revision);
  assert.ok(retry.id > previous.id);
  assert.equal(editor.commit(retry), true);
});
