/**
 * A queue the agent pushes stream chunks into and Trigger.dev's stream reads from. Pushing never waits, so a slow or
 * failing realtime stream can never slow down or fail the model call that feeds it.
 */
export class ChunkQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake?.();
  }

  /** No more items will come; the reader finishes once it has drained what is queued. */
  end(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
      }
    }
  }
}
