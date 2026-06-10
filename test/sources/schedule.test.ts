import { describe, expect, it } from "bun:test";
import { Cron } from "croner";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import type { EvaluateResult, Impulse } from "../../src/pipeline/impulse";
import { ScheduleSource } from "../../src/sources/schedule";

function scheduleBp(id: string, cron: string, timezone?: string): ActivationBlueprint {
  return {
    id,
    target: `@jc/${id}`,
    kind: "schedule",
    when: { schedule: cron, ...(timezone ? { timezone } : {}) },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: {},
    sourceFile: "/tmp/x.yaml",
  };
}

function sink(behavior?: (impulse: Impulse) => Promise<EvaluateResult>) {
  const impulses: Impulse[] = [];
  return {
    impulses,
    evaluate(impulse: Impulse): Promise<EvaluateResult> {
      impulses.push(impulse);
      return behavior
        ? behavior(impulse)
        : Promise.resolve({ outcome: "fired", decisionId: "d", correlationId: "c" } as EvaluateResult);
    },
  };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(20);
}

describe("ScheduleSource", () => {
  it("tick produces a schedule impulse with scheduled_for and system actor", async () => {
    const store = new BlueprintStore([scheduleBp("fast", "* * * * * *")]); // every second
    const spy = sink();
    const source = new ScheduleSource(store, spy);
    source.start();
    await until(() => spy.impulses.length >= 1);
    source.stop();
    const impulse = spy.impulses[0]!;
    expect(impulse.kind).toBe("schedule");
    expect(impulse.blueprintId).toBe("fast");
    expect(typeof impulse.payload.scheduled_for).toBe("string");
    expect(impulse.actor).toEqual({ type: "system", id: "reflex-scheduler" });
  });

  it("scheduler keeps submitting every tick — guards own throttling", async () => {
    const store = new BlueprintStore([scheduleBp("burst", "* * * * * *")]);
    const spy = sink(() =>
      Promise.resolve({ outcome: "blocked", decisionId: "d", reason: "cooldown" } as EvaluateResult),
    );
    const source = new ScheduleSource(store, spy);
    source.start();
    await until(() => spy.impulses.length >= 2, 4000);
    source.stop();
    expect(spy.impulses.length).toBeGreaterThanOrEqual(2); // submitted despite blocks
  });

  it("an evaluate that rejects does not stop subsequent ticks", async () => {
    const store = new BlueprintStore([scheduleBp("flaky", "* * * * * *")]);
    let calls = 0;
    const spy = sink(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ outcome: "fired", decisionId: "d", correlationId: "c" } as EvaluateResult);
    });
    const source = new ScheduleSource(store, spy);
    source.start();
    await until(() => calls >= 2, 4000);
    source.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(source.status()).toEqual([]); // stopped clears
  });

  it("reload sync: add, remove, change — zero orphans after 50 random mutations", () => {
    const store = new BlueprintStore([scheduleBp("a", "0 7 * * *")]);
    const source = new ScheduleSource(store, sink());
    source.start();
    let pool = ["a"];
    for (let i = 0; i < 50; i++) {
      const mutation = i % 3;
      if (mutation === 0) pool.push(`bp-${i}`);
      else if (mutation === 1 && pool.length > 1) pool = pool.slice(0, -1);
      // mutation 2: change cron of first element (signature change)
      const minute = i % 60;
      const set = pool.map((id, idx) => scheduleBp(id, idx === 0 && mutation === 2 ? `${minute} 7 * * *` : "0 7 * * *"));
      store.swap(set);
      source.sync();
      const jobIds = source
        .status()
        .map((s) => s.blueprintId)
        .sort();
      expect(jobIds).toEqual(pool.slice().sort());
    }
    source.stop();
  });

  it("cron change replaces the job (next tick moves)", () => {
    const store = new BlueprintStore([scheduleBp("mv", "0 7 * * *", "Europe/Zurich")]);
    const source = new ScheduleSource(store, sink());
    source.start();
    const before = source.status()[0]!.nextTick;
    store.swap([scheduleBp("mv", "0 9 * * *", "Europe/Zurich")]);
    source.sync();
    const after = source.status()[0]!.nextTick;
    expect(after).not.toBe(before);
    source.stop();
  });

  it("timezone is DST-correct on both sides of the spring transition", () => {
    // Europe/Zurich DST 2026: switches +01:00 → +02:00 on 2026-03-29.
    const winterNext = new Cron("0 7 * * *", { timezone: "Europe/Zurich" }).nextRun(new Date("2026-03-27T00:00:00Z"));
    const summerNext = new Cron("0 7 * * *", { timezone: "Europe/Zurich" }).nextRun(new Date("2026-03-30T00:00:00Z"));
    expect(winterNext?.toISOString()).toBe("2026-03-27T06:00:00.000Z"); // 07:00 CET = 06:00Z
    expect(summerNext?.toISOString()).toBe("2026-03-30T05:00:00.000Z"); // 07:00 CEST = 05:00Z
  });

  it("never-again cron shows nextTick null and is kept", () => {
    // Feb 30 never exists.
    const store = new BlueprintStore([scheduleBp("never", "0 0 30 2 *")]);
    const source = new ScheduleSource(store, sink());
    source.start();
    expect(source.status()).toEqual([
      { blueprintId: "never", nextTick: null, lastTick: null, lastOutcome: null },
    ]);
    source.stop();
  });

  it("resyncs 100 blueprints under budget", () => {
    const store = new BlueprintStore(Array.from({ length: 100 }, (_, i) => scheduleBp(`bp-${i}`, `${i % 60} 7 * * *`)));
    const source = new ScheduleSource(store, sink());
    const start = performance.now();
    source.sync();
    const elapsed = performance.now() - start;
    expect(source.status()).toHaveLength(100);
    expect(elapsed).toBeLessThan(200);
    source.stop();
  });
});
