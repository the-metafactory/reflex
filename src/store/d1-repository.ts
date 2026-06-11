import { and, desc, eq, lte, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReflexActor } from "../bus/envelopes";
import type { RepositoryPort } from "./port";
import {
  ConflictError,
  StorageError,
  type ApprovalRow,
  type DecisionOutcome,
  type DecisionRow,
  type ImpulseSnapshot,
} from "./repository";
import * as schema from "./schema";

const { approvals, decisions, firedEvents, guardState, idempotencyKeys, ignoredCounters } = schema;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * RepositoryPort over Cloudflare D1 (reflex#15). Same schema, same decision
 * taxonomy, same append-only discipline as the bun:sqlite Repository — but
 * D1 is async-only and has NO interactive transactions, so every
 * compare-and-set the sync driver did inside `transaction()` is rebuilt on
 * D1 primitives:
 *
 * - single-statement CAS → conditional UPDATE/UPSERT, verdict from
 *   `meta.changes` on the raw D1 result
 * - multi-statement atomicity (resolveMatched) → `d1.batch()` (one implicit
 *   transaction) with the dependent INSERT guarded by `(SELECT changes())`
 *   so it applies only when the CAS in the previous statement won
 * - single-taker take → value-conditioned UPDATE (clear only the exact
 *   JSON that was read), `meta.changes` gates the return
 *
 * Tested against a D1Database shim over bun:sqlite (test/edge/d1-shim.ts);
 * live D1 behavior is exercised at deploy time (DEFERRED-VERIFY, DD-122
 * production gates apply first).
 */
export class D1Repository implements RepositoryPort {
  private readonly db: DrizzleD1Database<typeof schema>;

  constructor(private readonly d1: D1Database) {
    this.db = drizzle(d1, { schema });
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async recordDecision(input: {
    blueprintId: string;
    outcome: DecisionOutcome;
    impulse: ImpulseSnapshot;
    guardBlockReason?: string;
    resolutionOf?: string;
    correlationId?: string;
  }): Promise<DecisionRow> {
    const row = {
      id: crypto.randomUUID(),
      blueprintId: input.blueprintId,
      outcome: input.outcome,
      impulse: JSON.stringify(input.impulse),
      guardBlockReason: input.guardBlockReason ?? null,
      resolutionOf: input.resolutionOf ?? null,
      correlationId: input.correlationId ?? null,
      createdAt: nowIso(),
    };
    try {
      await this.db.insert(decisions).values(row);
    } catch (error) {
      throw new StorageError("recordDecision", error as Error);
    }
    return { ...row, outcome: input.outcome, impulse: input.impulse };
  }

  async getDecision(id: string): Promise<DecisionRow | null> {
    const row = await this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    return row ? hydrateDecision(row) : null;
  }

  async historyFor(filter: { blueprintId?: string; limit?: number }): Promise<DecisionRow[]> {
    const base = this.db.select().from(decisions);
    const rows = await (
      filter.blueprintId ? base.where(eq(decisions.blueprintId, filter.blueprintId)) : base
    )
      // Same rowid tiebreak as the sync driver: same-millisecond createdAt
      // orders by insertion, not by random UUID.
      .orderBy(desc(decisions.createdAt), desc(sql`rowid`))
      .limit(filter.limit ?? 50)
      .all();
    return rows.map(hydrateDecision);
  }

  // ── approvals ────────────────────────────────────────────────────────────

  async createApproval(decisionId: string, expiresAt: string): Promise<void> {
    await this.db.insert(approvals).values({ decisionId, state: "waiting", expiresAt });
  }

  async getApproval(decisionId: string): Promise<ApprovalRow | null> {
    const row = await this.db.select().from(approvals).where(eq(approvals.decisionId, decisionId)).get();
    return row ? hydrateApproval(row) : null;
  }

  async listWaiting(): Promise<Array<ApprovalRow & { decision: DecisionRow }>> {
    const rows = await this.db
      .select()
      .from(approvals)
      .innerJoin(decisions, eq(approvals.decisionId, decisions.id))
      .where(eq(approvals.state, "waiting"))
      .orderBy(desc(decisions.createdAt))
      .all();
    return rows.map((r) => ({ ...hydrateApproval(r.approvals), decision: hydrateDecision(r.decisions) }));
  }

  /**
   * CAS + dependent INSERT in ONE d1.batch (implicit transaction). The
   * INSERT is guarded by `(SELECT changes()) > 0`, so it applies only when
   * the approvals CAS in the immediately preceding statement actually
   * transitioned a `waiting` row. Exactly one concurrent resolver wins;
   * losers get ConflictError carrying the actual current state.
   */
  async resolveMatched(
    matchedId: string,
    input: {
      kind: "approve" | "deny" | "expire";
      resolutionOutcome: "fired" | "denied" | "expired";
      actor?: ReflexActor;
      reason?: string;
      now: string;
    },
  ): Promise<DecisionRow> {
    const stateFor = { approve: "approved", deny: "denied", expire: "expired" } as const;
    // Decision rows are append-only/immutable — reading the matched row
    // before the batch cannot race anything. CAVEAT (DD-122 verification
    // item): with D1 read replication enabled this read may hit a stale
    // replica and MISS a just-created decision, surfacing a spurious
    // "decision-missing" conflict. Writes always hit primary, so the CAS
    // itself stays sound. If replication is enabled, pin reads via the D1
    // Sessions API or retry the read once on miss.
    const matched = await this.db.select().from(decisions).where(eq(decisions.id, matchedId)).get();
    if (!matched) throw new ConflictError(matchedId, "decision-missing");

    const row = {
      id: crypto.randomUUID(),
      blueprintId: matched.blueprintId,
      outcome: input.resolutionOutcome,
      impulse: matched.impulse,
      guardBlockReason: null,
      resolutionOf: matchedId,
      correlationId: matched.correlationId,
      createdAt: input.now,
    };
    const results = await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE approvals SET state = ?, reason = ?, actor = ?, decided_at = ?
           WHERE decision_id = ? AND state = 'waiting'`,
        )
        .bind(
          stateFor[input.kind],
          input.reason ?? (input.kind === "expire" ? "timeout" : "operator"),
          input.actor ? JSON.stringify(input.actor) : null,
          input.now,
          matchedId,
        ),
      this.d1
        .prepare(
          `INSERT INTO decisions
             (id, blueprint_id, outcome, impulse, guard_block_reason, resolution_of, correlation_id, created_at)
           SELECT ?, ?, ?, ?, NULL, ?, ?, ?
           WHERE (SELECT changes()) > 0`,
        )
        .bind(row.id, row.blueprintId, row.outcome, row.impulse, row.resolutionOf, row.correlationId, row.createdAt),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      const current = await this.getApproval(matchedId);
      throw new ConflictError(matchedId, current?.state ?? "missing");
    }
    return hydrateDecision(row);
  }

  async approveWaiting(decisionId: string, actor: ReflexActor, now: string): Promise<void> {
    const result = await this.d1
      .prepare(
        `UPDATE approvals SET state = 'approved', reason = 'operator', actor = ?, decided_at = ?
         WHERE decision_id = ? AND state = 'waiting'`,
      )
      .bind(JSON.stringify(actor), now, decisionId)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      const current = await this.getApproval(decisionId);
      throw new ConflictError(decisionId, current?.state ?? "missing");
    }
  }

  async sweepExpiredApprovals(now: string, limit = 500): Promise<Array<{ decisionId: string }>> {
    const due = await this.db
      .select({ decisionId: approvals.decisionId })
      .from(approvals)
      .where(and(eq(approvals.state, "waiting"), lte(approvals.expiresAt, now)))
      .limit(limit)
      .all();
    await this.expireWaiting(due.map((d) => d.decisionId), "timeout", now);
    return due;
  }

  /**
   * Bounded-parallel chunks (sage reflex#16 perf finding): a 500-row sweep
   * as strictly sequential D1 round-trips creates avoidable tail latency.
   * Each resolveMatched stays individually atomic (its own batch); chunks
   * just overlap the network round-trips.
   */
  private async expireWaiting(
    decisionIds: string[],
    reason: "timeout" | "blueprint-removed",
    now: string,
  ): Promise<void> {
    const CHUNK = 10;
    for (let i = 0; i < decisionIds.length; i += CHUNK) {
      await Promise.all(
        decisionIds.slice(i, i + CHUNK).map(async (decisionId) => {
          try {
            await this.resolveMatched(decisionId, { kind: "expire", resolutionOutcome: "expired", reason, now });
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error; // raced an approve/deny — fine
          }
        }),
      );
    }
  }

  async expireForBlueprint(blueprintId: string, now: string): Promise<Array<{ decisionId: string }>> {
    const waiting = await this.db
      .select({ decisionId: approvals.decisionId })
      .from(approvals)
      .innerJoin(decisions, eq(approvals.decisionId, decisions.id))
      .where(and(eq(approvals.state, "waiting"), eq(decisions.blueprintId, blueprintId)))
      .all();
    await this.expireWaiting(waiting.map((w) => w.decisionId), "blueprint-removed", now);
    return waiting.map(({ decisionId }) => ({ decisionId }));
  }

  // ── guard state ──────────────────────────────────────────────────────────

  async staleLocks(
    now: string,
    maxAgeMs: number,
  ): Promise<Array<{ blueprintId: string; holder: string; since: string }>> {
    const cutoff = new Date(Date.parse(now) - maxAgeMs).toISOString();
    const rows = await this.db
      .select()
      .from(guardState)
      .where(and(sql`${guardState.runLockHolder} IS NOT NULL`, lte(guardState.runLockSince, cutoff)))
      .all();
    return rows.map((r) => ({ blueprintId: r.blueprintId, holder: r.runLockHolder!, since: r.runLockSince! }));
  }

  async getGuardState(blueprintId: string) {
    return (await this.db.select().from(guardState).where(eq(guardState.blueprintId, blueprintId)).get()) ?? null;
  }

  async setCooldown(blueprintId: string, until: string): Promise<void> {
    await this.db
      .insert(guardState)
      .values({ blueprintId, cooldownUntil: until })
      .onConflictDoUpdate({ target: guardState.blueprintId, set: { cooldownUntil: until } });
  }

  /** Same CAS as the sync driver: the upsert claims only when holder IS NULL. */
  async acquireRunLock(
    blueprintId: string,
    correlationId: string,
    now: string,
  ): Promise<{ acquired: true } | { acquired: false; holder: string }> {
    const result = await this.d1
      .prepare(
        `INSERT INTO guard_state (blueprint_id, run_lock_holder, run_lock_since)
         VALUES (?, ?, ?)
         ON CONFLICT(blueprint_id) DO UPDATE
           SET run_lock_holder = excluded.run_lock_holder,
               run_lock_since = excluded.run_lock_since
           WHERE guard_state.run_lock_holder IS NULL`,
      )
      .bind(blueprintId, correlationId, now)
      .run();
    if ((result.meta.changes ?? 0) > 0) return { acquired: true as const };
    const current = await this.getGuardState(blueprintId);
    return { acquired: false as const, holder: current?.runLockHolder ?? "unknown" };
  }

  async releaseRunLock(blueprintId: string, correlationId: string): Promise<boolean> {
    const result = await this.d1
      .prepare(
        `UPDATE guard_state SET run_lock_holder = NULL, run_lock_since = NULL
         WHERE blueprint_id = ? AND run_lock_holder = ?`,
      )
      .bind(blueprintId, correlationId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async putBufferedImpulse(
    blueprintId: string,
    impulse: ImpulseSnapshot,
    bufferedByDecisionId: string,
  ): Promise<void> {
    const json = JSON.stringify(impulse);
    await this.db
      .insert(guardState)
      .values({ blueprintId, bufferedImpulse: json, bufferedByDecisionId })
      .onConflictDoUpdate({
        target: guardState.blueprintId,
        set: { bufferedImpulse: json, bufferedByDecisionId },
      });
  }

  /**
   * Single-taker without a transaction: clear ONLY the exact JSON value
   * that was read (value-conditioned CAS). A concurrent taker or a newer
   * buffered impulse makes `meta.changes` 0 → this caller gets null.
   * The UPDATE is a single atomic statement, so two takers cannot both
   * see changes=1; a stale-replica read fails in the SAFE direction
   * (reads a value that is already gone → UPDATE matches 0 rows → null).
   */
  async takeBufferedImpulse(
    blueprintId: string,
  ): Promise<{ impulse: ImpulseSnapshot; bufferedByDecisionId: string | null } | null> {
    const row = await this.db.select().from(guardState).where(eq(guardState.blueprintId, blueprintId)).get();
    if (!row?.bufferedImpulse) return null;
    const result = await this.d1
      .prepare(
        `UPDATE guard_state SET buffered_impulse = NULL, buffered_by_decision_id = NULL
         WHERE blueprint_id = ? AND buffered_impulse = ?`,
      )
      .bind(blueprintId, row.bufferedImpulse)
      .run();
    if ((result.meta.changes ?? 0) === 0) return null; // another taker won (or buffer replaced)
    return {
      impulse: JSON.parse(row.bufferedImpulse) as ImpulseSnapshot,
      bufferedByDecisionId: row.bufferedByDecisionId,
    };
  }

  async putIdempotencyKey(blueprintId: string, key: string, expiresAt: string): Promise<void> {
    await this.db
      .insert(idempotencyKeys)
      .values({ key, blueprintId, expiresAt })
      .onConflictDoUpdate({ target: [idempotencyKeys.blueprintId, idempotencyKeys.key], set: { expiresAt } });
  }

  async hasIdempotencyKey(blueprintId: string, key: string, now: string): Promise<boolean> {
    const row = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.blueprintId, blueprintId), eq(idempotencyKeys.key, key)))
      .get();
    // Numeric compare — mixed ISO millisecond forms must not flip validity.
    return row !== undefined && Date.parse(row.expiresAt) > Date.parse(now);
  }

  async sweepIdempotencyKeys(now: string): Promise<number> {
    const result = await this.d1
      .prepare(`DELETE FROM idempotency_keys WHERE expires_at <= ?`)
      .bind(now)
      .run();
    return result.meta.changes ?? 0;
  }

  // ── fired events + counters ──────────────────────────────────────────────

  async recordFiredEvent(input: {
    decisionId: string;
    envelopeId: string | null;
    correlationId: string;
    subject: string;
    publishedAt: string;
  }): Promise<void> {
    await this.db.insert(firedEvents).values(input);
  }

  async findFiredByCorrelation(correlationId: string) {
    return (
      (await this.db.select().from(firedEvents).where(eq(firedEvents.correlationId, correlationId)).get()) ?? null
    );
  }

  async bumpIgnored(blueprintId: string, day: string): Promise<void> {
    await this.bumpIgnoredBy(blueprintId, day, 1);
  }

  async bumpIgnoredBy(blueprintId: string, day: string, count: number): Promise<void> {
    if (count <= 0) return;
    await this.db
      .insert(ignoredCounters)
      .values({ blueprintId, day, count })
      .onConflictDoUpdate({
        target: [ignoredCounters.blueprintId, ignoredCounters.day],
        set: { count: sql`${ignoredCounters.count} + ${count}` },
      });
  }

  async ignoredCount(blueprintId: string, day: string): Promise<number> {
    const row = await this.db
      .select()
      .from(ignoredCounters)
      .where(and(eq(ignoredCounters.blueprintId, blueprintId), eq(ignoredCounters.day, day)))
      .get();
    return row?.count ?? 0;
  }
}

function hydrateDecision(row: typeof decisions.$inferSelect): DecisionRow {
  return {
    ...row,
    outcome: row.outcome as DecisionOutcome,
    impulse: JSON.parse(row.impulse) as ImpulseSnapshot,
  };
}

function hydrateApproval(row: typeof approvals.$inferSelect): ApprovalRow {
  return {
    ...row,
    state: row.state as ApprovalRow["state"],
    actor: row.actor ? (JSON.parse(row.actor) as ReflexActor) : null,
  };
}
