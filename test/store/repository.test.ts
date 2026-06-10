import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db";
import { ConflictError, Repository } from "../../src/store/repository";

function repo() {
  const { db, close } = openDb(":memory:");
  return { r: new Repository(db), close };
}

const IMPULSE = { kind: "manual" as const, payload: { x: 1 }, receivedAt: "2026-06-10T10:00:00Z" };

describe("decisions", () => {
  it("records and lists history newest-first", () => {
    const { r, close } = repo();
    const d1 = r.recordDecision({ blueprintId: "bp", outcome: "fired", impulse: IMPULSE });
    const d2 = r.recordDecision({ blueprintId: "bp", outcome: "blocked", impulse: IMPULSE, guardBlockReason: "cooldown" });
    const history = r.historyFor({ blueprintId: "bp" });
    expect(history.map((h) => h.id)).toEqual([d2.id, d1.id]);
    expect(history[0]!.guardBlockReason).toBe("cooldown");
    expect(history[1]!.impulse).toEqual(IMPULSE);
    close();
  });

  it("append-only: resolving a matched decision never updates the matched row", () => {
    const { r, close } = repo();
    const matched = r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
    r.createApproval(matched.id, "2026-06-10T11:00:00Z");
    const before = r.getDecision(matched.id)!;
    const resolution = r.resolveMatched(matched.id, {
      kind: "approve",
      actor: { type: "operator", id: "jc" },
      resolutionOutcome: "fired",
      now: "2026-06-10T10:30:00Z",
    });
    expect(r.getDecision(matched.id)).toEqual(before); // byte-identical
    expect(resolution.resolutionOf).toBe(matched.id);
    expect(resolution.outcome).toBe("fired");
    expect(r.getApproval(matched.id)!.state).toBe("approved");
    close();
  });
});

describe("approvals CAS", () => {
  it("exactly one of two concurrent resolutions wins", () => {
    const { r, close } = repo();
    const matched = r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
    r.createApproval(matched.id, "2026-06-10T11:00:00Z");
    r.resolveMatched(matched.id, { kind: "deny", actor: { type: "operator", id: "jc" }, resolutionOutcome: "denied", now: "2026-06-10T10:30:00Z" });
    try {
      r.resolveMatched(matched.id, { kind: "approve", actor: { type: "operator", id: "jc" }, resolutionOutcome: "fired", now: "2026-06-10T10:31:00Z" });
      expect.unreachable("second resolution must conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).currentState).toBe("denied");
    }
    close();
  });

  it("sweep expires only past-due waiting approvals", () => {
    const { r, close } = repo();
    const old = r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
    r.createApproval(old.id, "2026-06-10T09:00:00Z"); // past due
    const fresh = r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
    r.createApproval(fresh.id, "2026-06-10T23:00:00Z");
    const expired = r.sweepExpiredApprovals("2026-06-10T10:00:00Z");
    expect(expired.map((e) => e.decisionId)).toEqual([old.id]);
    expect(r.getApproval(old.id)!.state).toBe("expired");
    expect(r.getApproval(old.id)!.reason).toBe("timeout");
    expect(r.getApproval(fresh.id)!.state).toBe("waiting");
    expect(r.listWaiting().map((w) => w.decisionId)).toEqual([fresh.id]);
    close();
  });

  it("expireForBlueprint expires all waiting with blueprint-removed", () => {
    const { r, close } = repo();
    const m = r.recordDecision({ blueprintId: "gone", outcome: "matched", impulse: IMPULSE });
    r.createApproval(m.id, "2026-06-10T23:00:00Z");
    const expired = r.expireForBlueprint("gone", "2026-06-10T10:00:00Z");
    expect(expired).toHaveLength(1);
    expect(r.getApproval(m.id)!.reason).toBe("blueprint-removed");
    close();
  });
});

describe("guard state", () => {
  it("cooldown set/read", () => {
    const { r, close } = repo();
    r.setCooldown("bp", "2026-06-10T16:00:00Z");
    expect(r.getGuardState("bp")?.cooldownUntil).toBe("2026-06-10T16:00:00Z");
    close();
  });

  it("run lock acquire/release; second acquire returns the holder", () => {
    const { r, close } = repo();
    expect(r.acquireRunLock("bp", "corr-1", "2026-06-10T10:00:00Z")).toEqual({ acquired: true });
    expect(r.acquireRunLock("bp", "corr-2", "2026-06-10T10:01:00Z")).toEqual({ acquired: false, holder: "corr-1" });
    r.releaseRunLock("bp", "corr-1");
    expect(r.acquireRunLock("bp", "corr-2", "2026-06-10T10:02:00Z")).toEqual({ acquired: true });
    close();
  });

  it("buffered impulse depth-1: second put replaces; take clears atomically", () => {
    const { r, close } = repo();
    r.putBufferedImpulse("bp", { ...IMPULSE, payload: { n: 1 } });
    r.putBufferedImpulse("bp", { ...IMPULSE, payload: { n: 2 } });
    const taken = r.takeBufferedImpulse("bp");
    expect(taken?.payload).toEqual({ n: 2 });
    expect(r.takeBufferedImpulse("bp")).toBeNull();
    close();
  });

  it("idempotency keys: has until swept past TTL", () => {
    const { r, close } = repo();
    r.putIdempotencyKey("k1", "bp", "2026-06-10T10:10:00Z");
    expect(r.hasIdempotencyKey("k1")).toBe(true);
    r.sweepIdempotencyKeys("2026-06-10T10:20:00Z");
    expect(r.hasIdempotencyKey("k1")).toBe(false);
    close();
  });
});

describe("fired events + counters", () => {
  it("records fired events and finds by correlation", () => {
    const { r, close } = repo();
    const d = r.recordDecision({ blueprintId: "bp", outcome: "fired", impulse: IMPULSE });
    r.recordFiredEvent({ decisionId: d.id, envelopeId: "e1", correlationId: "c1", subject: "s", publishedAt: "2026-06-10T10:00:01Z" });
    expect(r.findFiredByCorrelation("c1")?.decisionId).toBe(d.id);
    expect(r.findFiredByCorrelation("nope")).toBeNull();
    close();
  });

  it("ignored counters aggregate without decision rows", () => {
    const { r, close } = repo();
    for (let i = 0; i < 100; i++) r.bumpIgnored("bp", "2026-06-10");
    expect(r.ignoredCount("bp", "2026-06-10")).toBe(100);
    expect(r.historyFor({ blueprintId: "bp" })).toEqual([]);
    close();
  });
});

describe("restart durability", () => {
  it("waiting approval, cooldown, and buffered impulse survive reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-repo-"));
    const path = join(dir, "reflex.db");
    {
      const { db, close } = openDb(path);
      const r = new Repository(db);
      const m = r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
      r.createApproval(m.id, "2026-06-10T23:00:00Z");
      r.setCooldown("bp", "2026-06-10T16:00:00Z");
      r.putBufferedImpulse("bp", IMPULSE);
      close();
    }
    const { db, close } = openDb(path);
    const r = new Repository(db);
    expect(r.listWaiting()).toHaveLength(1);
    expect(r.getGuardState("bp")?.cooldownUntil).toBe("2026-06-10T16:00:00Z");
    expect(r.takeBufferedImpulse("bp")).toEqual(IMPULSE);
    close();
  });
});
