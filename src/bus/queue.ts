/**
 * Bounded FIFO buffer for publishes that fail while the transport is
 * disconnected (spec FR-8). Overflow drops the OLDEST item — activation is
 * time-sensitive; the newest signal wins. Dropping is loud at the call site
 * (caller logs + counts); the SQLite decision rows remain the audit truth.
 *
 * Head-index design (sage R-101 review): drops and flushes advance a head
 * pointer instead of Array.shift(), so per-item work stays O(1) under the
 * exact failure mode this queue absorbs; the backing array compacts once
 * per flush, not once per item.
 */
export interface FlushResult {
  flushed: number;
}

export class BoundedPublishQueue<T> {
  private items: T[] = [];
  private head = 0;
  private dropped = 0;
  private flushing = false;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`queue limit must be >= 1, got ${limit}`);
  }

  get size(): number {
    return this.items.length - this.head;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Returns the dropped item when the buffer overflowed, else null. */
  enqueue(item: T): T | null {
    this.items.push(item);
    let droppedItem: T | null = null;
    if (this.size > this.limit) {
      droppedItem = this.items[this.head] ?? null;
      this.head += 1;
      this.dropped += 1;
    }
    this.compactIfWorthwhile();
    return droppedItem;
  }

  peekAll(): readonly T[] {
    return this.items.slice(this.head);
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
      while (this.head < this.items.length) {
        const next = this.items[this.head] as T;
        try {
          await publish(next);
        } catch {
          break;
        }
        this.head += 1;
        flushed += 1;
      }
    } finally {
      this.compact();
      this.flushing = false;
    }
    return { flushed };
  }

  /** Reclaim consumed slots once per flush (and on large drop runs). */
  private compact(): void {
    if (this.head > 0) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  private compactIfWorthwhile(): void {
    if (this.head > this.limit) {
      this.compact();
    }
  }
}
