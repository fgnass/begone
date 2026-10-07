import type { FromWorker, ToWorker } from './messages';

/** Owns the worker lifetime, including errors that cannot use its message protocol. */
export class WorkerClient {
  private worker: Worker | undefined;
  private create: () => Worker;
  private onMessage: (message: FromWorker) => void;
  private onFailure: (message: string) => void;

  constructor(create: () => Worker, onMessage: (message: FromWorker) => void, onFailure: (message: string) => void) {
    this.create = create;
    this.onMessage = onMessage;
    this.onFailure = onFailure;
  }

  send(message: ToWorker, transfer: Transferable[]) {
    try {
      if (!this.worker) {
        const worker = this.create();
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<FromWorker>) => {
          if (this.worker === worker) this.onMessage(event.data);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          if (this.worker === worker) this.failed(event.message || 'The image worker stopped unexpectedly.');
        };
        worker.onmessageerror = () => {
          if (this.worker === worker) this.failed('The image worker returned an unreadable message.');
        };
      }
      this.worker.postMessage(message, transfer);
      return true;
    } catch (error) {
      this.failed(String((error as Error)?.message ?? error));
      return false;
    }
  }

  private failed(message: string) {
    this.worker?.terminate();
    this.worker = undefined;
    this.onFailure(message);
  }
}
