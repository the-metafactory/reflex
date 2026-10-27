import { describe, expect, it } from "bun:test";
import { executionRunFinishedSubject } from "@the-metafactory/myelin/edge";
import { matches } from "../../src/sources/bus";
import { busBp, cfg, rig, TASK_SUBJECT } from "./bus-rig";
import { runFinishedEnvelope } from "../helpers";

describe("matcher", () => {
  it("property: match iff every where-entry strict-equals", () => {
    for (let i = 0; i < 200; i++) {
      const payload: Record<string, unknown> = { a: i % 3, b: `s${i % 2}`, c: i % 2 === 0 };
      const where: Record<string, string | number | boolean> = {};
      if (i % 4 !== 0) where.a = i % 5 === 0 ? (i % 3) : ((i % 3) + 1) % 3;
      if (i % 3 === 0) where.b = `s${i % 2}`;
      const expected = Object.entries(where).every(([k, v]) => payload[k] === v);
      expect(matches(where, payload)).toBe(expected);
    }
    expect(matches(undefined, { x: 1 })).toBe(true);
    expect(matches({ missing: 1 }, { x: 1 })).toBe(false); // absent ≠ equal
  });
});

describe("scenario 1+2: field-equals match fires; non-match ignored", () => {
  it("matching envelope fires: payload in snapshot, FRESH activation correlation on the row", async () => {
    const r = await rig([busBp("pilot-scan", TASK_SUBJECT, { flow: "review" })]);
    const corr = crypto.randomUUID();
    await r.publish(TASK_SUBJECT, { flow: "review", pr: 7 }, "tasks.review.completed", corr);
    const history = r.repo.historyFor({ blueprintId: "pilot-scan" });
    expect(history).toHaveLength(1);
    expect(history[0]!.outcome).toBe("fired");
    expect(history[0]!.impulse.payload).toEqual({ flow: "review", pr: 7 });
    // A Fired row carries the FRESH activation correlation (the run join
    // key, stamped by the pipeline) — deliberately NOT the source envelope's
    // correlation, which would conflate the inbound chain with the new run.
    expect(history[0]!.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(history[0]!.correlationId).not.toBe(corr);
    await r.close();
  });

  it("non-matching envelopes coalesce: no decision rows, ONE flushed counter write", async () => {
    const r = await rig([busBp("pilot-scan", TASK_SUBJECT, { flow: "review" })]);
    await r.publish(TASK_SUBJECT, { flow: "deploy" });
    await r.publish(TASK_SUBJECT, { flow: "deploy" });
    await r.publish(TASK_SUBJECT, { flow: "other" });
    expect(r.repo.historyFor({ blueprintId: "pilot-scan" })).toEqual([]);
    const day = new Date().toISOString().slice(0, 10);
    expect(r.repo.ignoredCount("pilot-scan", day)).toBe(0); // buffered, not yet written
    r.source.flushIgnored();
    expect(r.repo.ignoredCount("pilot-scan", day)).toBe(3); // coalesced single write
    await r.close();
  });
});

describe("scenario 3: run completion releases lock and re-presents", () => {
  it("buffered impulse re-presents on execution.run.finished", async () => {
    const r = await rig([busBp("locked", TASK_SUBJECT, undefined, { guards: { runLock: "buffer" } })]);
    await r.publish(TASK_SUBJECT, { n: 0 });
    const fired = r.repo.historyFor({ blueprintId: "locked" })[0]!;
    expect(fired.outcome).toBe("fired");

    await r.publish(TASK_SUBJECT, { n: 1 }); // run in flight → buffered
    expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.outcome).toBe("blocked");

    // Runner completion joins through the payload correlation.
    await r.publishEnvelope(executionRunFinishedSubject(cfg.principal, cfg.stack), runFinishedEnvelope(fired.correlationId!));
    await Bun.sleep(30);
    const latest = r.repo.historyFor({ blueprintId: "locked" })[0]!;
    expect(latest.outcome).toBe("fired");
    expect(latest.impulse.payload).toEqual({ n: 1 }); // the buffered one
    expect(r.repo.takeBufferedImpulse("locked")).toBeNull();
    await r.close();
  });
});

describe("scenario 5: self-cycle rejection", () => {
  it("blueprint on own fired subject is skipped loudly", async () => {
    const fired = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;
    const r = await rig([busBp("evil", fired), busBp("fine", TASK_SUBJECT)]);
    expect(r.source.active()).toEqual(["fine"]);
    await r.close();
  });
});

describe("duplicate-payload interplay (broker redelivery surrogate)", () => {
  // NOTE: this publishes the same payload twice — it proves the idempotency
  // guard absorbs duplicates at the evaluate boundary. True JetStream
  // redelivery (NAK/ack-timeout) is not exercised offline; the guard is the
  // defense either way because redelivered envelopes re-enter via the same
  // evaluate path with identical payloads.
  it("same payload twice → one fired + one idempotency block", async () => {
    const r = await rig([busBp("dup", TASK_SUBJECT)]);
    await r.publish(TASK_SUBJECT, { same: true });
    await r.publish(TASK_SUBJECT, { same: true });
    const outcomes = r.repo.historyFor({ blueprintId: "dup" }).map((h) => h.outcome).sort();
    expect(outcomes).toEqual(["blocked", "fired"]);
    await r.close();
  });
});

describe("hot-reload sync", () => {
  it("orphan-free after a 50-step deterministic mutation sweep (add/remove/change)", async () => {
    const r = await rig([busBp("a")]);
    let pool = ["a"];
    for (let i = 0; i < 50; i++) {
      if (i % 3 === 0) pool.push(`bp-${i}`);
      else if (i % 3 === 1 && pool.length > 1) pool = pool.slice(0, -1);
      const set = pool.map((id, idx) =>
        busBp(id, idx === 0 && i % 3 === 2 ? `${TASK_SUBJECT}.v${i}` : TASK_SUBJECT),
      );
      r.store.swap(set);
      await r.source.sync();
      expect(r.source.active()).toEqual(pool.slice().sort());
    }
    await r.close();
  });
});

describe("stop vs queued sync race", () => {
  it("a sync queued before stop cannot resubscribe after teardown", async () => {
    const r = await rig([busBp("racer")]);
    const queued = r.source.sync(); // queued behind nothing, but unawaited
    await r.source.stop();
    await queued;
    expect(r.source.active()).toEqual([]);
    await r.bus.close();
  });
});
