/**
 * Bounded FIFO ring buffer for publishes that fail while the transport is
 * disconnected (spec FR-8). Overflow drops the OLDEST item — activation is
 * time-sensitive; the newest signal wins. Dropping is loud at the call site
 * (caller logs + counts); the SQLite decision rows remain the audit truth.
 */
export interface FlushResult {
  flushed: number;
}

export class BoundedPublishQueue<T> {
  private items: T[] = [];
  private dropped = 0;
  private flushing = false;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`queue limit must be >= 1, got ${limit}`);
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Returns the dropped item when the buffer overflowed, else null. */
  enqueue(item: T): T | null {
    this.items.push(item);
    if (this.items.length > this.limit) {
      this.dropped += 1;
      return this.items.shift() ?? null;
    }
    return null;
  }

  peekAll(): readonly T[] {
    return this.items;
  }

  /**
   * Flush FIFO. On a publish failure the failing item is RETAINED at the
   * head and the flush aborts — next flush retries from there, order
   * preserved, nothing published twice. Only one flush runs at a time.
   */
  async flush(publish: (item: T) => Promise<void>): Promise<FlushResult> {
    if (this.flushing) return { flushed: 0 };
    this.flushing = true;
    let flushed = 0;
    try {
      while (this.items.length > 0) {
        const head = this.items[0] as T;
        try {
          await publish(head);
        } catch {
          break;
        }
        this.items.shift();
        flushed += 1;
      }
    } finally {
      this.flushing = false;
    }
    return { flushed };
  }
}
