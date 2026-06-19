import { describe, expect, it } from "bun:test";
import { BlueprintStore } from "../../src/activation/store";
import type { EvaluateResult, Impulse } from "../../src/pipeline/impulse";
import { Scheduler } from "../../src/scheduler/core";
import { scheduleBlueprint as scheduleBp } from "../helpers";

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

const D = (iso: string) => new Date(iso);

describe("Scheduler.tick", () => {
  it("fires a blueprint whose next occurrence is in (lastTick, now]", async () => {
    const store = new BlueprintStore([scheduleBp("daily", "0 7 * * *")]);
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-18T06:59:00Z"),
      D("2026-06-18T07:00:30Z"),
    );
    expect(result.evaluated).toEqual(["daily"]);
    expect(spy.impulses).toHaveLength(1);
    expect(spy.impulses[0]!.kind).toBe("schedule");
    expect(spy.impulses[0]!.payload.scheduled_for).toBe("2026-06-18T07:00:00.000Z");
    expect(spy.impulses[0]!.actor).toEqual({ type: "system", id: "reflex-scheduler" });
  });

  it("does not fire when the next occurrence is after now", async () => {
    const store = new BlueprintStore([scheduleBp("daily", "0 7 * * *")]);
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-18T07:00:30Z"),
      D("2026-06-18T07:01:00Z"),
    );
    expect(result.evaluated).toEqual([]);
    expect(spy.impulses).toHaveLength(0);
  });

  it("does not fire when the occurrence is before lastTick (none in window)", async () => {
    const store = new BlueprintStore([scheduleBp("daily", "0 7 * * *")]);
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-18T07:30:00Z"),
      D("2026-06-18T07:45:00Z"),
    );
    expect(result.evaluated).toEqual([]);
    expect(spy.impulses).toHaveLength(0);
  });

  it("collapse: a window spanning 3 occurrences fires once with missedOccurrences=2", async () => {
    const store = new BlueprintStore([scheduleBp("min", "* * * * *")]); // every minute
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-18T07:00:00Z"),
      D("2026-06-18T07:03:00Z"), // occurrences: 07:01, 07:02, 07:03
    );
    expect(result.evaluated).toEqual(["min"]); // fired exactly once
    expect(spy.impulses).toHaveLength(1);
    expect(result.collapsed).toEqual([{ blueprintId: "min", missedOccurrences: 2 }]);
    // fires the FIRST due occurrence
    expect(spy.impulses[0]!.payload.scheduled_for).toBe("2026-06-18T07:01:00.000Z");
  });

  it("respects blueprint timezone (Europe/Zurich summer = 07:00 local → 05:00Z)", async () => {
    const store = new BlueprintStore([scheduleBp("zh", "0 7 * * *", "Europe/Zurich")]);
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-30T04:59:00Z"),
      D("2026-06-30T05:00:30Z"), // 07:00 CEST = 05:00Z falls in window
    );
    expect(result.evaluated).toEqual(["zh"]);
    expect(spy.impulses[0]!.payload.scheduled_for).toBe("2026-06-30T05:00:00.000Z");
  });

  it("backward / non-monotonic clock (now <= lastTick) is a no-op", async () => {
    const store = new BlueprintStore([scheduleBp("min", "* * * * *")]);
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-18T07:05:00Z"),
      D("2026-06-18T07:04:00Z"),
    );
    expect(result).toEqual({ evaluated: [], collapsed: [], errors: [] });
    expect(spy.impulses).toHaveLength(0);
  });

  it("cold start (lastTick=null) fires an occurrence landing exactly at now (no backfill otherwise)", async () => {
    const store = new BlueprintStore([scheduleBp("daily", "0 7 * * *")]);
    const spy = sink();
    const result = await new Scheduler({ store, sink: spy }).tick(null, D("2026-06-18T07:00:00Z"));
    expect(result.evaluated).toEqual(["daily"]);
    expect(spy.impulses[0]!.payload.scheduled_for).toBe("2026-06-18T07:00:00.000Z");
  });

  it("exactly-once at the boundary: occurrence == now fires once, next tick does not re-fire", async () => {
    const store = new BlueprintStore([scheduleBp("daily", "0 7 * * *")]);
    const spy = sink();
    const scheduler = new Scheduler({ store, sink: spy });
    const first = await scheduler.tick(D("2026-06-18T06:59:00Z"), D("2026-06-18T07:00:00Z"));
    expect(first.evaluated).toEqual(["daily"]);
    expect(first.collapsed).toEqual([]);
    // advance lastTick to the boundary — must NOT re-fire the same occurrence
    const second = await scheduler.tick(D("2026-06-18T07:00:00Z"), D("2026-06-18T07:00:30Z"));
    expect(second.evaluated).toEqual([]);
    expect(spy.impulses).toHaveLength(1);
  });

  it("an evaluation error isolates to its blueprint and the tick continues", async () => {
    const store = new BlueprintStore([scheduleBp("a", "0 7 * * *"), scheduleBp("b", "0 7 * * *")]);
    const spy = sink((impulse) =>
      impulse.blueprintId === "a"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ outcome: "fired", decisionId: "d", correlationId: "c" } as EvaluateResult),
    );
    const result = await new Scheduler({ store, sink: spy }).tick(
      D("2026-06-18T06:59:00Z"),
      D("2026-06-18T07:00:30Z"),
    );
    expect(result.errors).toEqual([{ blueprintId: "a", error: "boom" }]);
    expect(result.evaluated).toEqual(["b"]);
  });
});
