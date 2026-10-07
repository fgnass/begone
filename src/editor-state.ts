/** The DOM reflects this state; request and export decisions never read CSS classes. */
export type Request = {
  readonly id: number;
  readonly image: number;
  readonly revision: number;
  readonly quiet: boolean;
  strokes: number;
};

export class EditorState {
  file: Blob | undefined;
  image = 0;
  revision = 0;
  phase: 'empty' | 'working' | 'updating' | 'done' | 'failed' = 'empty';
  active: Request | undefined;
  displayed: { image: number; revision: number } | undefined;
  drawing = false;
  private sequence = 0;

  get hasResult() {
    return this.displayed?.image === this.image;
  }

  get canExport() {
    return this.phase === 'done' && !this.active && !this.drawing &&
      this.hasResult && this.displayed?.revision === this.revision;
  }

  open(file: Blob) {
    this.file = file;
    this.image++;
    this.revision = 0;
    this.active = this.displayed = undefined;
    this.drawing = false;
    this.phase = 'working';
  }

  edit() {
    if (!this.file) return;
    this.revision++;
    this.phase = this.hasResult ? 'updating' : 'working';
  }

  begin(): Request | undefined {
    if (!this.file || this.active || this.drawing) return;
    const request = { id: ++this.sequence, image: this.image, revision: this.revision, quiet: this.hasResult, strokes: 0 };
    this.active = request;
    this.phase = request.quiet ? 'updating' : 'working';
    return request;
  }

  isCurrent(request: Request) {
    return this.active?.id === request.id && request.image === this.image && request.revision === this.revision;
  }

  /** Ends an obsolete request. Returns whether the newest edits need processing. */
  finish(id: number) {
    if (this.active?.id !== id) return false;
    const changed = this.active.revision !== this.revision;
    this.active = undefined;
    return changed;
  }

  commit(request: Request) {
    if (!this.isCurrent(request)) return false;
    this.displayed = { image: request.image, revision: request.revision };
    this.active = undefined;
    this.phase = 'done';
    return true;
  }

  fail() {
    this.active = undefined;
    this.phase = this.file ? 'failed' : 'empty';
  }
}
