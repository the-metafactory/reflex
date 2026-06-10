import { describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { createReflexBus, type ReflexBus } from "../../src/bus";
import { Pipeline } from "../../src/pipeline/evaluate";
import type { Impulse } from "../../src/pipeline/impulse";
import { openDb } from "../../src/store/db";
import { ConflictError, Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const cfg = testConfig();
const T0 = "2026-06-10T12:00:00.000Z";

function bp(overrides: Partial<ActivationBlueprint> = {}): ActivationBlueprint {
  return {
    id: "bp",
    target: "@jc/target",
    kind: "manual",
    when: { manual: {} },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: { from: "blueprint" },
    sourceFile: "/tmp/x.yaml",
    ...overrides,
  };
}

function impulse(overrides: Partial<Impulse> = {}): Impulse {
  return {
    kind: "manual",
    blueprintId: "bp",
    payload: { n: 1 },
    receivedAt: T0,
    actor: { type: "operator", id: "jc" },
    ...overrides,
  };
}

function rig(blueprints: ActivationBlueprint[], nowRef = { now: T0 }) {
  const { db, close } = openDb(":memory:");
  const repo = new Repository(db);
  const store = new BlueprintStore(blueprints);
  const transport = createTransport({ type: "memory" });
  const bus = createReflexBus(cfg, { transport });
  const published: MyelinEnvelope[] = [];
  const FIRED = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;
  const DECISIONS = `local.${cfg.principal}.${cfg.stack}.reflex.activation.decision.*`;
  const ready = Promise.all([
    bus.subscribe(FIRED, async (e) => {
      published.push(e);
    }),
    bus.subscribe(DECISIONS, async (e) => {
      published.push(e);
    }),
  ]);
  const pipeline = new Pipeline({ store, repo, bus, nowFn: () => nowRef.now });
  const closeAll = async () => {
    await bus.close();
    await close();
  };
  return { pipeline, repo, store, bus, published, ready, close: closeAll, nowRef };
}

async function settle() {
  await Bun.sleep(15);
}

describe("scenario 1: auto-fire happy path", () => {
  it("fires, publishes a valid envelope with target/payload/key/decision link", async () => {
    const { pipeline, repo, published, ready, close } = rig([bp()]);
    await ready;
    const result = await pipeline.evaluate(impulse());
    await settle();
    expect(result.outcome).toBe("fired");
    if (result.outcome !== "fired") throw new Error("unreachable");
    const fired = published.find((e) => e.type === "reflex.activation.fired")!;
    expect(fired.payload.target).toBe("@jc/target");
    expect(fired.payload.payload).toEqual({ from: "blueprint", n: 1 });
    expect(fired.payload.decision_id).toBe(result.decisionId);
    expect(typeof fired.payload.idempotency_key).toBe("string");
    expect(fired.correlation_id).toBe(result.correlationId);
    expect(repo.getDecision(result.decisionId)!.outcome).toBe("fired");
    expect(published.some((e) => e.type === "reflex.activation.decision.fired")).toBe(true);
    await close();
  });

  it("disabled policy → counter only, no rows, nothing published", async () => {
    const { pipeline, repo, published, ready, close } = rig([bp({ policy: "disabled" })]);
    await ready;
    const result = await pipeline.evaluate(impulse());
    await settle();
    expect(result).toEqual({ outcome: "ignored", reason: "disabled" });
    expect(repo.historyFor({ blueprintId: "bp" })).toEqual([]);
    expect(repo.ignoredCount("bp", "2026-06-10")).toBe(1);
    expect(published).toEqual([]);
    await close();
  });
});

describe("scenario 2: approval parks, approve fires", () => {
  it("matched waits with correct expiry; approve re-runs guards and fires linked", async () => {
    const { pipeline, repo, published, ready, close } = rig([bp({ policy: "approval" })]);
    await ready;
    const matched = await pipeline.evaluate(impulse());
    expect(matched.outcome).toBe("matched");
    if (matched.outcome !== "matched") throw new Error("unreachable");
    expect(matched.expiresAt).toBe("2026-06-10T13:00:00.000Z");
    expect(repo.listWaiting()).toHaveLength(1);

    const resolved = await pipeline.resolveMatched(matched.decisionId, "approve", { type: "operator", id: "jc" });
    await settle();
    expect(resolved.outcome).toBe("fired");
    if (resolved.outcome !== "fired") throw new Error("unreachable");
    expect(repo.getDecision(resolved.decisionId)!.resolutionOf).toBe(matched.decisionId);
    expect(repo.getApproval(matched.decisionId)!.state).toBe("approved");
    expect(published.some((e) => e.type === "reflex.activation.fired")).toBe(true);
    await close();
  });

  it("deny is terminal; later approve conflicts naming the state", async () => {
    const { pipeline, repo, ready, close } = rig([bp({ policy: "approval" })]);
    await ready;
    const matched = await pipeline.evaluate(impulse());
    if (matched.outcome !== "matched") throw new Error("unreachable");
    const denied = await pipeline.resolveMatched(matched.decisionId, "deny", { type: "operator", id: "jc" });
    expect(denied.outcome).toBe("denied");
    expect(repo.getApproval(matched.decisionId)!.state).toBe("denied");
    await expect(
      pipeline.resolveMatched(matched.decisionId, "approve", { type: "operator", id: "jc" }),
    ).rejects.toThrow(ConflictError);
    await close();
  });

  it("approve after cooldown engaged → honest Blocked linked to matched", async () => {
    const { pipeline, repo, nowRef, ready, close } = rig([
      bp({ id: "gated", policy: "approval", guards: { cooldownMs: 3_600_000 } }),
    ]);
    await ready;
    const matched = await pipeline.evaluate(impulse({ blueprintId: "gated" }));
    if (matched.outcome !== "matched") throw new Error("unreachable");
    // cooldown engages meanwhile (e.g. via another fire path)
    repo.setCooldown("gated", "2026-06-10T18:00:00Z");
    nowRef.now = "2026-06-10T12:30:00.000Z";
    const resolved = await pipeline.resolveMatched(matched.decisionId, "approve", { type: "operator", id: "jc" });
    expect(resolved.outcome).toBe("blocked");
    if (resolved.outcome !== "blocked") throw new Error("unreachable");
    expect(resolved.reason).toBe("cooldown");
    expect(repo.getDecision(resolved.decisionId)!.resolutionOf).toBe(matched.decisionId);
    expect(repo.getApproval(matched.decisionId)!.state).toBe("approved");
    await close();
  });
});

describe("scenario 3: cooldown blocks with named reason", () => {
  it("second fire within cooldown is Blocked(cooldown), no event", async () => {
    const { pipeline, repo, published, ready, close, nowRef } = rig([bp({ guards: { cooldownMs: 6 * 3_600_000 } })]);
    await ready;
    const first = await pipeline.evaluate(impulse());
    expect(first.outcome).toBe("fired");
    nowRef.now = "2026-06-10T12:10:00.000Z";
    const second = await pipeline.evaluate(impulse({ payload: { n: 2 } }));
    await settle();
    expect(second.outcome).toBe("blocked");
    if (second.outcome !== "blocked") throw new Error("unreachable");
    expect(second.reason).toBe("cooldown");
    expect(repo.getDecision(second.decisionId)!.guardBlockReason).toBe("cooldown");
    expect(published.filter((e) => e.type === "reflex.activation.fired")).toHaveLength(1);
    await close();
  });
});

describe("scenario 4: buffer holds newest, re-presents once", () => {
  it("two impulses during run → 2 blocked, buffer holds 2nd, completion re-presents exactly one", async () => {
    const { pipeline, repo, ready, close, nowRef } = rig([bp({ guards: { runLock: "buffer" } })]);
    await ready;
    const fired = await pipeline.evaluate(impulse({ payload: { n: 0 } }));
    if (fired.outcome !== "fired") throw new Error("unreachable");

    nowRef.now = "2026-06-10T12:01:00.000Z";
    const b1 = await pipeline.evaluate(impulse({ payload: { n: 1 } }));
    nowRef.now = "2026-06-10T12:02:00.000Z";
    const b2 = await pipeline.evaluate(impulse({ payload: { n: 2 } }));
    expect(b1.outcome).toBe("blocked");
    expect(b2.outcome).toBe("blocked");

    nowRef.now = "2026-06-10T12:30:00.000Z";
    const represented = await pipeline.onRunCompleted(fired.correlationId, "succeeded");
    expect(represented?.outcome).toBe("fired");
    if (represented?.outcome !== "fired") throw new Error("unreachable");
    const row = repo.getDecision(represented.decisionId)!;
    expect(row.impulse.payload).toEqual({ n: 2 }); // newest won
    if (b2.outcome === "blocked") expect(row.resolutionOf).toBe(b2.decisionId); // causation link
    expect(repo.takeBufferedImpulse("bp")).toBeNull(); // re-presented once
    await close();
  });

  it("unknown correlation is a warn no-op", async () => {
    const { pipeline, ready, close } = rig([bp()]);
    await ready;
    expect(await pipeline.onRunCompleted(crypto.randomUUID(), "succeeded")).toBeNull();
    await close();
  });
});

describe("scenario 5: dry run mutates nothing", () => {
  it("verdict names the cooldown; state byte-identical", async () => {
    const { pipeline, repo, published, ready, close, nowRef } = rig([bp({ guards: { cooldownMs: 6 * 3_600_000 } })]);
    await ready;
    await pipeline.evaluate(impulse());
    await settle();
    nowRef.now = "2026-06-10T12:10:00.000Z";
    const rowsBefore = JSON.stringify(repo.historyFor({ blueprintId: "bp", limit: 1000 }));
    const guardBefore = JSON.stringify(repo.getGuardState("bp"));
    const publishedBefore = published.length;

    const verdict = pipeline.evaluateDry(impulse({ payload: { n: 9 } }));
    expect(verdict.wouldOutcome).toBe("blocked");
    expect(verdict.reasons[0]).toContain("cooldown until");

    await settle();
    expect(JSON.stringify(repo.historyFor({ blueprintId: "bp", limit: 1000 }))).toBe(rowsBefore);
    expect(JSON.stringify(repo.getGuardState("bp"))).toBe(guardBefore);
    expect(published.length).toBe(publishedBefore);
    await close();
  });
});

describe("scenario 6: double-fire race prevented", () => {
  it("100 rounds of 2 concurrent identical impulses → exactly one Fired each", async () => {
    for (let round = 0; round < 100; round++) {
      const { pipeline, ready, close } = rig([bp({ id: "race", guards: { runLock: "skip" } })]);
      await ready;
      const [a, b] = await Promise.all([
        pipeline.evaluate(impulse({ blueprintId: "race", payload: { round } })),
        pipeline.evaluate(impulse({ blueprintId: "race", payload: { round } })),
      ]);
      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["blocked", "fired"]);
      await close();
    }
  }, 30_000);
});

describe("fire path ordering", () => {
  it("publish failure leaves the Fired row + queues the envelope (persist-then-publish)", async () => {
    const failing = {
      publish: () => Promise.reject(new Error("down")),
      request: () => Promise.reject(new Error("down")),
      subscribe: () => Promise.resolve({ unsubscribe: async () => {} }),
      subscribeBestEffort: () => Promise.resolve({ unsubscribe: async () => {} }),
      close: async () => {},
    };
    const { db, close } = openDb(":memory:");
    const repo = new Repository(db);
    const store = new BlueprintStore([bp()]);
    const bus: ReflexBus = createReflexBus(cfg, { transport: failing as never, flushIntervalMs: 100_000 });
    const pipeline = new Pipeline({ store, repo, bus, nowFn: () => T0 });
    const result = await pipeline.evaluate(impulse());
    expect(result.outcome).toBe("fired"); // truth persisted despite wire down
    if (result.outcome !== "fired") throw new Error("unreachable");
    expect(repo.getDecision(result.decisionId)!.outcome).toBe("fired");
    expect(bus.metrics().queued).toBe(2); // fired + decision audit envelopes
    await bus.close();
    await close();
  });
});

describe("performance (NFR-1)", () => {
  it("evaluate stays under budget with 100 blueprints loaded", async () => {
    const blueprints = Array.from({ length: 100 }, (_, i) => bp({ id: `bp-${i}` }));
    const { pipeline, ready, close } = rig(blueprints);
    await ready;
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      await pipeline.evaluate(impulse({ blueprintId: `bp-${i}`, payload: { i } }));
    }
    const perCall = (performance.now() - start) / 50;
    expect(perCall).toBeLessThan(25);
    await close();
  });
});

describe("cycle-2 review fixes", () => {
  it("no-match ignores are counted", async () => {
    const { pipeline, repo, ready, close } = rig([bp()]);
    await ready;
    await pipeline.evaluate(impulse({ blueprintId: "ghost" }));
    expect(repo.ignoredCount("ghost", "2026-06-10")).toBe(1);
    await close();
  });

  it("orphaned buffer (blueprint removed) is discarded loudly, not silently", async () => {
    const { pipeline, repo, store, ready, close } = rig([bp({ guards: { runLock: "buffer" } })]);
    await ready;
    const fired = await pipeline.evaluate(impulse({ payload: { n: 0 } }));
    if (fired.outcome !== "fired") throw new Error("unreachable");
    await pipeline.evaluate(impulse({ payload: { n: 1 } })); // buffered
    store.swap([]); // blueprint removed via hot-reload
    const result = await pipeline.onRunCompleted(fired.correlationId, "succeeded");
    expect(result).toBeNull();
    expect(repo.takeBufferedImpulse("bp")).toBeNull(); // consumed (discarded), not leaked
    await close();
  });
});
