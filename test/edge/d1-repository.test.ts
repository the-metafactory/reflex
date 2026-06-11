import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { D1Repository } from "../../src/store/d1-repository";
import { ConflictError } from "../../src/store/repository";
import { createD1Shim } from "./d1-shim";

const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");
const NOW = "2026-06-10T12:00:00Z";
const IMPULSE = { kind: "manual" as const, payload: { x: 1 }, receivedAt: "2026-06-10T10:00:00Z" };
const ACTOR = { type: "operator" as const, id: "jc" };

function repo(): { r: D1Repository; close: () => void } {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return { r: new D1Repository(createD1Shim(sqlite)), close: () => sqlite.close() };
}

describe("D1Repository — decisions", () => {
  it("records and lists history newest-first", async () => {
    const { r, close } = repo();
    await r.recordDecision({ blueprintId: "bp", outcome: "fired", impulse: IMPULSE });
    await r.recordDecision({ blueprintId: "bp", outcome: "blocked", impulse: IMPULSE, guardBlockReason: "cooldown" });
    const history = await r.historyFor({ blueprintId: "bp" });
    expect(history.length).toBe(2);
    expect(history[0]!.outcome).toBe("blocked");
    expect(history[1]!.outcome).toBe("fired");
    expect(history[0]!.impulse).toEqual(IMPULSE);
    close();
  });
});

describe("D1Repository — resolveMatched CAS", () => {
  async function matchedDecision(r: D1Repository): Promise<string> {
    const d = await r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
    await r.createApproval(d.id, "2026-06-10T13:00:00Z");
    return d.id;
  }

  it("first resolver wins, second gets ConflictError with current state", async () => {
    const { r, close } = repo();
    const id = await matchedDecision(r);
    const resolution = await r.resolveMatched(id, { kind: "deny", resolutionOutcome: "denied", actor: ACTOR, now: NOW });
    expect(resolution.outcome).toBe("denied");
    expect(resolution.resolutionOf).toBe(id);
    let conflict: ConflictError | null = null;
    try {
      await r.resolveMatched(id, { kind: "approve", resolutionOutcome: "fired", actor: ACTOR, now: NOW });
    } catch (error) {
      conflict = error as ConflictError;
    }
    expect(conflict).toBeInstanceOf(ConflictError);
    expect(conflict!.currentState).toBe("denied");
    close();
  });

  it("losing resolver inserts NO resolution row (conditional insert held)", async () => {
    const { r, close } = repo();
    const id = await matchedDecision(r);
    await r.resolveMatched(id, { kind: "expire", resolutionOutcome: "expired", now: NOW });
    await r.resolveMatched(id, { kind: "deny", resolutionOutcome: "denied", actor: ACTOR, now: NOW }).catch(() => null);
    const history = await r.historyFor({ blueprintId: "bp" });
    // matched + exactly ONE resolution row — the losing batch's insert must not apply.
    expect(history.length).toBe(2);
    close();
  });

  it("approveWaiting CAS: second approver conflicts", async () => {
    const { r, close } = repo();
    const id = await matchedDecision(r);
    await r.approveWaiting(id, ACTOR, NOW);
    expect((await r.getApproval(id))?.state).toBe("approved");
    await expect(r.approveWaiting(id, ACTOR, NOW)).rejects.toBeInstanceOf(ConflictError);
    close();
  });

  it("sweepExpiredApprovals expires due waiting approvals", async () => {
    const { r, close } = repo();
    const d = await r.recordDecision({ blueprintId: "bp", outcome: "matched", impulse: IMPULSE });
    await r.createApproval(d.id, "2026-06-10T11:00:00Z"); // already past NOW
    const swept = await r.sweepExpiredApprovals(NOW);
    expect(swept.map((s) => s.decisionId)).toEqual([d.id]);
    expect((await r.getApproval(d.id))?.state).toBe("expired");
    close();
  });
});

describe("D1Repository — run lock CAS", () => {
  it("claims only when free; loser learns the holder", async () => {
    const { r, close } = repo();
    expect(await r.acquireRunLock("bp", "corr-1", NOW)).toEqual({ acquired: true });
    expect(await r.acquireRunLock("bp", "corr-2", NOW)).toEqual({ acquired: false, holder: "corr-1" });
    close();
  });

  it("release is holder-scoped", async () => {
    const { r, close } = repo();
    await r.acquireRunLock("bp", "corr-1", NOW);
    expect(await r.releaseRunLock("bp", "wrong")).toBe(false);
    expect(await r.releaseRunLock("bp", "corr-1")).toBe(true);
    expect(await r.acquireRunLock("bp", "corr-2", NOW)).toEqual({ acquired: true });
    close();
  });
});

describe("D1Repository — buffered impulse single-take", () => {
  it("second taker gets null", async () => {
    const { r, close } = repo();
    await r.putBufferedImpulse("bp", IMPULSE, "blocked-1");
    const first = await r.takeBufferedImpulse("bp");
    expect(first?.impulse).toEqual(IMPULSE);
    expect(first?.bufferedByDecisionId).toBe("blocked-1");
    expect(await r.takeBufferedImpulse("bp")).toBeNull();
    close();
  });

  it("newest replaces older (depth 1)", async () => {
    const { r, close } = repo();
    await r.putBufferedImpulse("bp", IMPULSE, "blocked-1");
    const newer = { ...IMPULSE, payload: { x: 2 } };
    await r.putBufferedImpulse("bp", newer, "blocked-2");
    const taken = await r.takeBufferedImpulse("bp");
    expect(taken?.impulse).toEqual(newer);
    expect(taken?.bufferedByDecisionId).toBe("blocked-2");
    close();
  });
});

describe("D1Repository — idempotency keys", () => {
  it("valid strictly before expiresAt; sweep deletes at the boundary", async () => {
    const { r, close } = repo();
    await r.putIdempotencyKey("bp", "k", "2026-06-10T12:00:00Z");
    expect(await r.hasIdempotencyKey("bp", "k", "2026-06-10T11:59:59Z")).toBe(true);
    expect(await r.hasIdempotencyKey("bp", "k", "2026-06-10T12:00:00Z")).toBe(false);
    expect(await r.sweepIdempotencyKeys("2026-06-10T12:00:00Z")).toBe(1);
    close();
  });

  it("keys are blueprint-scoped", async () => {
    const { r, close } = repo();
    await r.putIdempotencyKey("bp-a", "k", "2026-06-10T13:00:00Z");
    expect(await r.hasIdempotencyKey("bp-b", "k", NOW)).toBe(false);
    close();
  });
});

describe("D1Repository — counters + fired events", () => {
  it("coalesced ignored counter adds", async () => {
    const { r, close } = repo();
    await r.bumpIgnored("bp", "2026-06-10");
    await r.bumpIgnoredBy("bp", "2026-06-10", 4);
    expect(await r.ignoredCount("bp", "2026-06-10")).toBe(5);
    close();
  });

  it("fired event lookup by correlation", async () => {
    const { r, close } = repo();
    await r.recordFiredEvent({
      decisionId: "d1",
      envelopeId: null,
      correlationId: "corr-9",
      subject: "s",
      publishedAt: NOW,
    });
    expect((await r.findFiredByCorrelation("corr-9"))?.decisionId).toBe("d1");
    expect(await r.findFiredByCorrelation("nope")).toBeNull();
    close();
  });
});
