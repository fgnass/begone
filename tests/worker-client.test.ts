import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerClient } from '../src/worker-client';
import type { ToWorker } from '../src/messages';

class FakeWorker {
  onmessage: any;
  onerror: any;
  onmessageerror: any;
  terminated = false;
  messages: unknown[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
const request = { type: 'process', id: 1 } as ToWorker;

for (const event of ['error', 'messageerror']) {
  test(`worker ${event} clears the failed worker and retry creates a fresh one`, () => {
    const workers: FakeWorker[] = [];
    const failures: string[] = [];
    const messages: unknown[] = [];
    const client = new WorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    }, (message) => messages.push(message), (message) => failures.push(message));
    assert.equal(client.send(request, []), true);
    const first = workers[0];
    if (event === 'error') first.onerror({ message: 'Script failed to load', preventDefault() {} });
    else first.onmessageerror();
    assert.equal(first.terminated, true);
    assert.equal(failures.length, 1);
    assert.equal(client.send(request, []), true);
    assert.equal(workers.length, 2);
    first.onmessage({ data: { type: 'done', id: 1 } });
    first.onerror({ message: 'late error', preventDefault() {} });
    assert.equal(messages.length, 0);
    assert.equal(failures.length, 1);
    workers[1].onmessage({ data: { type: 'progress', id: 1, stage: 'infer' } });
    assert.equal(messages.length, 1);
  });
}

test('worker constructor errors are reported and can be retried', () => {
  let attempts = 0;
  const failures: string[] = [];
  const client = new WorkerClient(() => {
    if (++attempts === 1) throw new Error('Worker unavailable');
    return new FakeWorker() as unknown as Worker;
  }, () => {}, (message) => failures.push(message));
  assert.equal(client.send(request, []), false);
  assert.deepEqual(failures, ['Worker unavailable']);
  assert.equal(client.send(request, []), true);
});

test('postMessage failure terminates the worker and reports the error', () => {
  const worker = new FakeWorker();
  worker.postMessage = () => { throw new Error('Cannot transfer bitmap'); };
  const failures: string[] = [];
  const client = new WorkerClient(() => worker as unknown as Worker, () => {}, (message) => failures.push(message));
  assert.equal(client.send(request, []), false);
  assert.equal(worker.terminated, true);
  assert.deepEqual(failures, ['Cannot transfer bitmap']);
});
