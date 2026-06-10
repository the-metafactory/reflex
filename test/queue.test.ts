import { describe, expect, it } from "bun:test";
import { BoundedPublishQueue } from "../src/bus/queue";

type Item = { n: number };

function collector() {
  const flushed: Item[] = [];
  let failNext = false;
  return {
    flushed,
    setFailNext() {
      failNext = true;
    },
    async publish(item: Item) {
      if (failNext) {
        failNext = false;
        throw new Error("still down");
      }
      flushed.push(item);
    },
  };
}

describe("BoundedPublishQueue", () => {
  it("holds items up to the limit", () => {
    const q = new BoundedPublishQueue<Item>(3);
    q.enqueue({ n: 1 });
    q.enqueue({ n: 2 });
    q.enqueue({ n: 3 });
    expect(q.size).toBe(3);
    expect(q.droppedCount).toBe(0);
  });

  it("drops the OLDEST on overflow and counts it", () => {
    const q = new BoundedPublishQueue<Item>(3);
    for (const n of [1, 2, 3, 4]) q.enqueue({ n });
    expect(q.size).toBe(3);
    expect(q.droppedCount).toBe(1);
    expect(q.peekAll().map((i) => i.n)).toEqual([2, 3, 4]);
  });

  it("flushes FIFO and empties", async () => {
    const q = new BoundedPublishQueue<Item>(10);
    for (const n of [1, 2, 3]) q.enqueue({ n });
    const sink = collector();
    const result = await q.flush(sink.publish.bind(sink));
    expect(result.flushed).toBe(3);
    expect(sink.flushed.map((i) => i.n)).toEqual([1, 2, 3]);
    expect(q.size).toBe(0);
  });

  it("retains the failing head and preserves order for the next flush", async () => {
    const q = new BoundedPublishQueue<Item>(10);
    for (const n of [1, 2, 3]) q.enqueue({ n });
    const sink = collector();
    sink.setFailNext(); // item 1 fails
    const first = await q.flush(sink.publish.bind(sink));
    expect(first.flushed).toBe(0);
    expect(q.size).toBe(3);
    const second = await q.flush(sink.publish.bind(sink));
    expect(second.flushed).toBe(3);
    expect(sink.flushed.map((i) => i.n)).toEqual([1, 2, 3]);
  });

  it("only one flush runs at a time", async () => {
    const q = new BoundedPublishQueue<Item>(10);
    for (const n of [1, 2]) q.enqueue({ n });
    let inFlight = 0;
    let maxInFlight = 0;
    const publish = async (_: Item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
    };
    await Promise.all([q.flush(publish), q.flush(publish)]);
    expect(maxInFlight).toBe(1);
  });
});
