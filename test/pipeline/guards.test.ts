import { describe, expect, it } from "bun:test";
import type { ActivationBlueprint } from "../../src/activation/types";
import { checkGuards } from "../../src/pipeline/guards";
import { deriveIdempotencyKey, type Impulse } from "../../src/pipeline/impulse";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";

const NOW = "2026-06-10T12:00:00Z";

function bp(guards: ActivationBlueprint["guards"]): ActivationBlueprint {
  return {
    id: "bp",
    target: "@jc/x",
    kind: "manual",
    when: { manual: {} },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards,
    payload: {},
    sourceFile: "/tmp/x.yaml",
  };
}

function impulse(payload: Record<string, unknown> = { n: 1 }): Impulse {
  return { kind: "manual", blueprintId: "bp", payload, receivedAt: NOW, actor: { type: "operator", id: "jc" } };
}

function repo() {
  const { db, close } = openDb(":memory:");
  return { r: new Repository(db), close };
}

describe("checkGuards", () => {
  it("passes with no guards configured and no state", async () => {
    const { r, close } = repo();
    const result = await checkGuards(bp({}), impulse(), r, NOW);
    expect(result.pass).toBe(true);
    close();
  });

  it("idempotency wins over cooldown (fixed order)", async () => {
    const { r, close } = repo();
    const key = await deriveIdempotencyKey("bp", { n: 1 });
    r.putIdempotencyKey("bp", key, "2026-06-10T12:30:00Z");
    r.setCooldown("bp", "2026-06-10T18:00:00Z");
    const result = await checkGuards(bp({ cooldownMs: 60_000 }), impulse(), r, NOW);
    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("idempotency");
    close();
  });

  it("cooldown blocks with expiry detail", async () => {
    const { r, close } = repo();
    r.setCooldown("bp", "2026-06-10T18:00:00Z");
    const result = await checkGuards(bp({ cooldownMs: 60_000 }), impulse(), r, NOW);
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toBe("cooldown");
      expect(result.detail).toContain("2026-06-10T18:00:00Z");
    }
    close();
  });

  it("cooldown state is ignored when blueprint declares no cooldown guard", async () => {
    const { r, close } = repo();
    r.setCooldown("bp", "2026-06-10T18:00:00Z");
    expect((await checkGuards(bp({}), impulse(), r, NOW)).pass).toBe(true);
    close();
  });

  it("run lock skip vs buffer produce distinct reasons", async () => {
    const { r, close } = repo();
    r.acquireRunLock("bp", "corr-1", NOW);
    const skip = await checkGuards(bp({ runLock: "skip" }), impulse(), r, NOW);
    const buffer = await checkGuards(bp({ runLock: "buffer" }), impulse(), r, NOW);
    expect(!skip.pass && skip.reason).toBe("run-lock");
    expect(!buffer.pass && buffer.reason).toBe("run-lock-buffered");
    close();
  });

  it("is read-only: checking never mutates guard state", async () => {
    const { r, close } = repo();
    await checkGuards(bp({ cooldownMs: 60_000, runLock: "skip" }), impulse(), r, NOW);
    expect(r.getGuardState("bp")).toBeNull();
    expect(r.hasIdempotencyKey("bp", await deriveIdempotencyKey("bp", { n: 1 }), NOW)).toBe(false);
    close();
  });
});
