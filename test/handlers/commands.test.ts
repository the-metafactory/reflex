import { describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { createReflexBus } from "../../src/bus";
import { CommandHandlers } from "../../src/handlers/commands";
import { Pipeline } from "../../src/pipeline/evaluate";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const OPERATOR = { type: "operator" as const, id: "jc" };

function bp(overrides: Partial<ActivationBlueprint> = {}): ActivationBlueprint {
  return {
    id: "f-testing",
    target: "@jc/f-testing",
    kind: "manual",
    when: { manual: {} },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: {},
    sourceFile: "/tmp/x.yaml",
    ...overrides,
  };
}

function rig(blueprints: ActivationBlueprint[], nowRef = { now: "2026-06-10T12:00:00.000Z" }) {
  const { db, close } = openDb(":memory:");
  const repo = new Repository(db);
  const store = new BlueprintStore(blueprints);
  const bus = createReflexBus(testConfig(), { transport: createTransport({ type: "memory" }) });
  const pipeline = new Pipeline({ store, repo, bus, nowFn: () => nowRef.now });
  const handlers = new CommandHandlers(store, pipeline, repo);
  return { handlers, repo, nowRef, close: async () => { await bus.close(); close(); } };
}

describe("fire", () => {
  it("scenario 1: manual fire goes through the WHOLE pipeline — cooldown blocks it", async () => {
    const { handlers, nowRef, close } = rig([bp({ guards: { cooldownMs: 6 * 3_600_000 } })]);
    const first = await handlers.fire("f-testing", {}, OPERATOR);
    expect(first.ok && first.data.outcome).toBe("fired");
    nowRef.now = "2026-06-10T13:00:00.000Z"; // 1h later, cooldown 6h
    const second = await handlers.fire("f-testing", { again: true }, OPERATOR);
    expect(second.ok && second.data.outcome).toBe("blocked");
    if (second.ok) expect(second.data.reason).toBe("cooldown");
    await close();
  });

  it("unknown blueprint → not-found with nearest hint", async () => {
    const { handlers, close } = rig([bp({ id: "f-testing" }), bp({ id: "f-test-suite" })]);
    const result = await handlers.fire("f-test", {}, OPERATOR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
      expect(result.error.message).toContain("f-test-suite");
    }
    await close();
  });

  it("non-object input → invalid-input before any impulse", async () => {
    const { handlers, repo, close } = rig([bp()]);
    const result = await handlers.fire("f-testing", [1, 2] as never, OPERATOR);
    expect(!result.ok && result.error.code).toBe("invalid-input");
    expect(repo.historyFor({ blueprintId: "f-testing" })).toEqual([]);
    await close();
  });
});

describe("approve / deny", () => {
  it("scenario 2: approve converts and fires; actor round-trips", async () => {
    const { handlers, repo, close } = rig([bp({ id: "gate", policy: "approval" })]);
    const matched = await handlers.fire("gate", { req: 1 }, OPERATOR);
    if (!(matched.ok && matched.data.outcome === "matched" && matched.data.decisionId)) throw new Error("setup");
    const approved = await handlers.approve(matched.data.decisionId, OPERATOR);
    expect(approved.ok && approved.data.outcome).toBe("fired");
    expect(repo.getApproval(matched.data.decisionId)!.actor).toEqual(OPERATOR);
    await close();
  });

  it("scenario 3: deny terminal; approve-after-deny → conflict naming denied", async () => {
    const { handlers, close } = rig([bp({ id: "gate", policy: "approval" })]);
    const matched = await handlers.fire("gate", {}, OPERATOR);
    if (!(matched.ok && matched.data.decisionId)) throw new Error("setup");
    const denied = await handlers.deny(matched.data.decisionId, OPERATOR);
    expect(denied.ok && denied.data.outcome).toBe("denied");
    const late = await handlers.approve(matched.data.decisionId, OPERATOR);
    expect(!late.ok && late.error.code).toBe("conflict");
    if (!late.ok) expect(late.error.currentState).toBe("denied");
    await close();
  });

  it("approve on unknown decision → not-found", async () => {
    const { handlers, close } = rig([bp()]);
    const result = await handlers.approve(crypto.randomUUID(), OPERATOR);
    expect(!result.ok && result.error.code).toBe("not-found");
    await close();
  });

  it("scenario 5: concurrent approve||deny → exactly one ok, loser names final state", async () => {
    const { handlers, close } = rig([bp({ id: "gate", policy: "approval" })]);
    const matched = await handlers.fire("gate", {}, OPERATOR);
    if (!(matched.ok && matched.data.decisionId)) throw new Error("setup");
    const [a, d] = await Promise.all([
      handlers.approve(matched.data.decisionId, OPERATOR),
      handlers.deny(matched.data.decisionId, OPERATOR),
    ]);
    const oks = [a, d].filter((r) => r.ok);
    const conflicts = [a, d].filter((r) => !r.ok && r.error.code === "conflict");
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    await close();
  });
});

describe("pending + sweep", () => {
  it("pending lists Matched Decisions newest-first with summaries; sweep empties on timeout", async () => {
    const { handlers, repo, nowRef, close } = rig([bp({ id: "gate", policy: "approval", approvalTimeoutMs: 60_000 })]);
    const m1 = await handlers.fire("gate", { a: 1 }, OPERATOR);
    nowRef.now = "2026-06-10T12:00:30.000Z";
    if (!(m1.ok && m1.data.decisionId)) throw new Error("setup");

    const list = handlers.pending();
    expect(list.ok && list.data).toHaveLength(1);
    if (list.ok) {
      expect(list.data[0]!.blueprintId).toBe("gate");
      expect(list.data[0]!.impulseSummary).toContain("manual");
      expect(list.data[0]!.impulseSummary).toContain("a");
    }

    // scenario 4: fake-clock sweep past expiry
    repo.sweepExpiredApprovals("2026-06-10T12:02:00.000Z");
    expect(repo.getApproval(m1.data.decisionId)!.state).toBe("expired");
    expect(repo.getApproval(m1.data.decisionId)!.reason).toBe("timeout");
    const after = handlers.pending();
    expect(after.ok && after.data).toEqual([]);
    await close();
  });
});

describe("performance", () => {
  it("fire handler round trip under budget", async () => {
    const { handlers, close } = rig([bp()]);
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      await handlers.fire("f-testing", { i }, OPERATOR);
    }
    expect((performance.now() - start) / 20).toBeLessThan(100);
    await close();
  });
});
