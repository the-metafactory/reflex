import { describe, expect, it } from "bun:test";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { BlueprintStore } from "../../src/activation/store";
import type { EvaluateResult, Impulse } from "../../src/pipeline/impulse";
import { Scheduler } from "../../src/scheduler/core";
import { EdgeHeartbeat, REFRESH_EVERY_TICKS } from "../../src/edge/heartbeat";
import { scheduleBlueprint as scheduleBp } from "../helpers";

/** In-memory DurableObjectState storage shim; records setAlarm calls. */
function fakeState() {
  const map = new Map<string, unknown>();
  let armCount = 0;
  let lastAlarm: number | null = null;
  const storage = {
    get: async (k: string) => map.get(k),
    put: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    setAlarm: async (ts: number) => {
      armCount += 1;
      lastAlarm = ts;
    },
  };
  return {
    state: { storage } as unknown as DurableObjectState,
    armCount: () => armCount,
    lastAlarm: () => lastAlarm,
  };
}

function okSink() {
  const impulses: Impulse[] = [];
  return {
    impulses,
    evaluate: (i: Impulse): Promise<EvaluateResult> => {
      impulses.push(i);
      return Promise.resolve({ outcome: "fired", decisionId: "d", correlationId: "c" } as EvaluateResult);
    },
  };
}

const D = (iso: string) => new Date(iso);

describe("EdgeHeartbeat", () => {
  it("persists lastTick across alarm fires", async () => {
    const { state } = fakeState();
    const hb = new EdgeHeartbeat(state, new Scheduler({ store: new BlueprintStore([]), sink: okSink() }), async () => {});
    await hb.onAlarm(D("2026-06-18T07:00:00Z"));
    expect((await hb.load()).lastTick).toBe("2026-06-18T07:00:00.000Z");
    await hb.onAlarm(D("2026-06-18T07:01:00Z"));
    expect((await hb.load()).lastTick).toBe("2026-06-18T07:01:00.000Z");
  });

  it("refreshes blueprints on the first tick and again every REFRESH_EVERY_TICKS", async () => {
    const { state } = fakeState();
    let refreshes = 0;
    const hb = new EdgeHeartbeat(
      state,
      new Scheduler({ store: new BlueprintStore([]), sink: okSink() }),
      async () => {
        refreshes += 1;
      },
    );
    for (let i = 0; i < REFRESH_EVERY_TICKS; i++) {
      await hb.onAlarm(D(`2026-06-18T07:0${i}:00Z`));
    }
    expect(refreshes).toBe(1); // only the first tick of the cycle refreshed
    await hb.onAlarm(D("2026-06-18T07:05:00Z")); // start of next cycle
    expect(refreshes).toBe(2);
  });

  it("re-arms the alarm every tick, including when evaluation has per-blueprint errors", async () => {
    const { state, armCount } = fakeState();
    const store = new BlueprintStore([scheduleBp("a")]);
    const rejectingSink = {
      evaluate: (): Promise<EvaluateResult> => Promise.reject(new Error("boom")),
    };
    const hb = new EdgeHeartbeat(state, new Scheduler({ store, sink: rejectingSink }), async () => {});
    const result = await hb.onAlarm(D("2026-06-18T07:01:00Z")); // cold start fires the occurrence at now
    expect(result.errors).toEqual([{ blueprintId: "a", error: "boom" }]);
    expect(armCount()).toBe(1); // armed despite the eval error
    expect((await hb.load()).lastTick).toBe("2026-06-18T07:01:00.000Z"); // advanced (occurrence spent)
  });

  it("survives DO eviction: a fresh instance over the same storage resumes lastTick", async () => {
    const fs = fakeState();
    const mk = () =>
      new EdgeHeartbeat(fs.state, new Scheduler({ store: new BlueprintStore([]), sink: okSink() }), async () => {});
    await mk().onAlarm(D("2026-06-18T07:00:00Z"));
    // eviction → brand new heartbeat object, same durable storage
    const revived = mk();
    expect((await revived.load()).lastTick).toBe("2026-06-18T07:00:00.000Z");
  });
});
