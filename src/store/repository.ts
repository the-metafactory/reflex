import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { ReflexActor } from "../bus/envelopes";
import type { ReflexDb } from "./db";
import { approvals, decisions, firedEvents, guardState, idempotencyKeys, ignoredCounters } from "./schema";

/** Outcomes recorded in the decision log (six, per upstream taxonomy). */
export type DecisionOutcome = "ignored" | "matched" | "blocked" | "fired" | "denied" | "expired";

export interface ImpulseSnapshot {
  kind: "schedule" | "manual" | "bus" | "http";
  payload: Record<string, unknown>;
  receivedAt: string;
}

export interface DecisionRow {
  id: string;
  blueprintId: string;
  outcome: DecisionOutcome;
  impulse: ImpulseSnapshot;
  guardBlockReason: string | null;
  resolutionOf: string | null;
  correlationId: string | null;
  createdAt: string;
}

export interface ApprovalRow {
  decisionId: string;
  state: "waiting" | "approved" | "denied" | "expired";
  reason: string | null;
  actor: ReflexActor | null;
  expiresAt: string;
  decidedAt: string | null;
}

export class ConflictError extends Error {
  constructor(
    readonly decisionId: string,
    readonly currentState: string,
  ) {
    super(`Decision ${decisionId} is not waiting — current approval state: ${currentState}`);
    this.name = "ConflictError";
  }
}

export class StorageError extends Error {
  constructor(operation: string, cause: Error) {
    super(`Storage failure during ${operation}: ${cause.message}`);
    this.name = "StorageError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The ONLY module issuing queries (spec FR-9). Decision rows are append-only
 * (ADR-0001) — there is deliberately no UPDATE path for `decisions.outcome`;
 * Matched resolution = new row + CAS on approvals.
 */
export class Repository {
  constructor(private readonly db: ReflexDb) {}

  // ── decisions ────────────────────────────────────────────────────────────

  recordDecision(input: {
    blueprintId: string;
    outcome: DecisionOutcome;
    impulse: ImpulseSnapshot;
    guardBlockReason?: string;
    resolutionOf?: string;
    correlationId?: string;
  }): DecisionRow {
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
      this.db.insert(decisions).values(row).run();
    } catch (error) {
      throw new StorageError("recordDecision", error as Error);
    }
    return { ...row, outcome: input.outcome, impulse: input.impulse };
  }

  getDecision(id: string): DecisionRow | null {
    const row = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    return row ? hydrateDecision(row) : null;
  }

  historyFor(filter: { blueprintId?: string; limit?: number }): DecisionRow[] {
    const base = this.db.select().from(decisions);
    const rows = (
      filter.blueprintId ? base.where(eq(decisions.blueprintId, filter.blueprintId)) : base
    )
      // rowid tiebreak: same-millisecond createdAt must order by insertion,
      // not by random UUID (flake found in CI: two inserts, one ms).
      .orderBy(desc(decisions.createdAt), desc(sql`rowid`))
      .limit(filter.limit ?? 50)
      .all();
    return rows.map(hydrateDecision);
  }

  // ── approvals ────────────────────────────────────────────────────────────

  createApproval(decisionId: string, expiresAt: string): void {
    this.db.insert(approvals).values({ decisionId, state: "waiting", expiresAt }).run();
  }

  getApproval(decisionId: string): ApprovalRow | null {
    const row = this.db.select().from(approvals).where(eq(approvals.decisionId, decisionId)).get();
    return row ? hydrateApproval(row) : null;
  }

  listWaiting(): Array<ApprovalRow & { decision: DecisionRow }> {
    const rows = this.db
      .select()
      .from(approvals)
      .innerJoin(decisions, eq(approvals.decisionId, decisions.id))
      .where(eq(approvals.state, "waiting"))
      .orderBy(desc(decisions.createdAt))
      .all();
    return rows.map((r) => ({ ...hydrateApproval(r.approvals), decision: hydrateDecision(r.decisions) }));
  }

  /**
   * Resolve a Matched Decision: transaction = CAS the approvals row
   * (WHERE state='waiting') + INSERT the resolution decision row. Exactly
   * one concurrent resolver wins; losers get ConflictError carrying the
   * actual current state.
   */
  resolveMatched(
    matchedId: string,
    input: {
      kind: "approve" | "deny" | "expire";
      resolutionOutcome: "fired" | "denied" | "expired";
      actor?: ReflexActor;
      reason?: string;
      now: string;
    },
  ): DecisionRow {
    const stateFor = { approve: "approved", deny: "denied", expire: "expired" } as const;
    return this.db.transaction((tx) => {
      tx.update(approvals)
        .set({
          state: stateFor[input.kind],
          reason: input.reason ?? (input.kind === "expire" ? "timeout" : "operator"),
          actor: input.actor ? JSON.stringify(input.actor) : null,
          decidedAt: input.now,
        })
        .where(and(eq(approvals.decisionId, matchedId), eq(approvals.state, "waiting")))
        .run();
      // bun-sqlite driver's run() returns void — read the change count
      // from the connection (same tx, so changes() is this UPDATE's).
      const [casChanges] = (tx.get<[number]>(sql`SELECT changes()`) ?? [0]) as [number];
      if (casChanges === 0) {
        const current = this.getApproval(matchedId);
        throw new ConflictError(matchedId, current?.state ?? "missing");
      }
      const matched = tx.select().from(decisions).where(eq(decisions.id, matchedId)).get();
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
      tx.insert(decisions).values(row).run();
      return hydrateDecision(row);
    });
  }

  /** Bounded per call (default 500) so a huge timeout backlog cannot stall one sweep tick. */
  /**
   * CAS waiting→approved WITHOUT inserting a resolution row: after an
   * approval the pipeline re-runs guards and records the honest outcome
   * (Fired or Blocked) itself, linked to the matched decision. Deny/expire
   * keep using resolveMatched (their resolution row IS the outcome).
   */
  approveWaiting(decisionId: string, actor: ReflexActor, now: string): void {
    this.db
      .update(approvals)
      .set({ state: "approved", reason: "operator", actor: JSON.stringify(actor), decidedAt: now })
      .where(and(eq(approvals.decisionId, decisionId), eq(approvals.state, "waiting")))
      .run();
    const [changed] = (this.db.get<[number]>(sql`SELECT changes()`) ?? [0]) as [number];
    if (changed === 0) {
      const current = this.getApproval(decisionId);
      throw new ConflictError(decisionId, current?.state ?? "missing");
    }
  }

  sweepExpiredApprovals(now: string, limit = 500): Array<{ decisionId: string }> {
    const due = this.db
      .select({ decisionId: approvals.decisionId })
      .from(approvals)
      .where(and(eq(approvals.state, "waiting"), lte(approvals.expiresAt, now)))
      .limit(limit)
      .all();
    this.expireWaiting(due.map((d) => d.decisionId), "timeout", now);
    return due;
  }

  /** Shared expiry path for both sweep flavors (sage R-103 dedup finding). */
  private expireWaiting(decisionIds: string[], reason: "timeout" | "blueprint-removed", now: string): void {
    for (const decisionId of decisionIds) {
      try {
        this.resolveMatched(decisionId, { kind: "expire", resolutionOutcome: "expired", reason, now });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error; // raced an approve/deny — fine
      }
    }
  }

  expireForBlueprint(blueprintId: string, now: string): Array<{ decisionId: string }> {
    const waiting = this.db
      .select({ decisionId: approvals.decisionId, blueprintId: decisions.blueprintId })
      .from(approvals)
      .innerJoin(decisions, eq(approvals.decisionId, decisions.id))
      .where(and(eq(approvals.state, "waiting"), eq(decisions.blueprintId, blueprintId)))
      .all();
    this.expireWaiting(waiting.map((w) => w.decisionId), "blueprint-removed", now);
    return waiting.map(({ decisionId }) => ({ decisionId }));
  }

  // ── guard state ──────────────────────────────────────────────────────────

  getGuardState(blueprintId: string) {
    return this.db.select().from(guardState).where(eq(guardState.blueprintId, blueprintId)).get() ?? null;
  }

  setCooldown(blueprintId: string, until: string): void {
    this.db
      .insert(guardState)
      .values({ blueprintId, cooldownUntil: until })
      .onConflictDoUpdate({ target: guardState.blueprintId, set: { cooldownUntil: until } })
      .run();
  }

  /**
   * CAS acquire: the upsert only claims when run_lock_holder IS NULL — a
   * holder appearing between any read and this write can never be
   * overwritten (sage R-103 cycle-3 finding). changes() decides the verdict.
   */
  acquireRunLock(
    blueprintId: string,
    correlationId: string,
    now: string,
  ): { acquired: true } | { acquired: false; holder: string } {
    return this.db.transaction((tx) => {
      tx.run(sql`
        INSERT INTO guard_state (blueprint_id, run_lock_holder, run_lock_since)
        VALUES (${blueprintId}, ${correlationId}, ${now})
        ON CONFLICT(blueprint_id) DO UPDATE
          SET run_lock_holder = excluded.run_lock_holder,
              run_lock_since = excluded.run_lock_since
          WHERE guard_state.run_lock_holder IS NULL
      `);
      const [claimed] = (tx.get<[number]>(sql`SELECT changes()`) ?? [0]) as [number];
      if (claimed > 0) return { acquired: true as const };
      const current = tx.select().from(guardState).where(eq(guardState.blueprintId, blueprintId)).get();
      return { acquired: false as const, holder: current?.runLockHolder ?? "unknown" };
    });
  }

  releaseRunLock(blueprintId: string, correlationId: string): boolean {
    this.db
      .update(guardState)
      .set({ runLockHolder: null, runLockSince: null })
      .where(and(eq(guardState.blueprintId, blueprintId), eq(guardState.runLockHolder, correlationId)))
      .run();
    const [released] = (this.db.get<[number]>(sql`SELECT changes()`) ?? [0]) as [number];
    return released > 0;
  }

  putBufferedImpulse(blueprintId: string, impulse: ImpulseSnapshot, bufferedByDecisionId: string): void {
    // Depth 1 by PK construction: newest replaces older (grill decision 18).
    // The buffering Blocked Decision id rides along — re-presentation links
    // the fresh decision to it (CONTEXT.md relationship).
    const json = JSON.stringify(impulse);
    this.db
      .insert(guardState)
      .values({ blueprintId, bufferedImpulse: json, bufferedByDecisionId })
      .onConflictDoUpdate({
        target: guardState.blueprintId,
        set: { bufferedImpulse: json, bufferedByDecisionId },
      })
      .run();
  }

  /**
   * Single-taker take: the clearing UPDATE is conditioned on the buffered
   * value still being present and changes() gates the return — two takers
   * can never both receive the impulse (sage R-103 cycle-3 finding).
   */
  takeBufferedImpulse(blueprintId: string): { impulse: ImpulseSnapshot; bufferedByDecisionId: string | null } | null {
    return this.db.transaction((tx) => {
      const row = tx.select().from(guardState).where(eq(guardState.blueprintId, blueprintId)).get();
      if (!row?.bufferedImpulse) return null;
      tx.run(sql`
        UPDATE guard_state
        SET buffered_impulse = NULL, buffered_by_decision_id = NULL
        WHERE blueprint_id = ${blueprintId} AND buffered_impulse IS NOT NULL
      `);
      const [cleared] = (tx.get<[number]>(sql`SELECT changes()`) ?? [0]) as [number];
      if (cleared === 0) return null; // another taker won
      return {
        impulse: JSON.parse(row.bufferedImpulse) as ImpulseSnapshot,
        bufferedByDecisionId: row.bufferedByDecisionId,
      };
    });
  }

  putIdempotencyKey(blueprintId: string, key: string, expiresAt: string): void {
    this.db
      .insert(idempotencyKeys)
      .values({ key, blueprintId, expiresAt })
      .onConflictDoUpdate({ target: [idempotencyKeys.blueprintId, idempotencyKeys.key], set: { expiresAt } })
      .run();
  }

  /**
   * TTL is enforced HERE, not by sweep timing: an expired key never matches
   * even if the sweeper hasn't run yet. Scoped per blueprint — a key for one
   * blueprint never suppresses another's work. Boundary: a key is valid
   * strictly BEFORE expiresAt; the sweep deletes at lte(expiresAt, now) —
   * same boundary, no immortal rows (sage R-103 cycle-2 findings).
   */
  hasIdempotencyKey(blueprintId: string, key: string, now: string): boolean {
    const row = this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.blueprintId, blueprintId), eq(idempotencyKeys.key, key)))
      .get();
    return row !== undefined && row.expiresAt > now;
  }

  sweepIdempotencyKeys(now: string): number {
    this.db.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, now)).run();
    const [swept] = (this.db.get<[number]>(sql`SELECT changes()`) ?? [0]) as [number];
    return swept;
  }

  // ── fired events + counters ──────────────────────────────────────────────

  recordFiredEvent(input: {
    decisionId: string;
    envelopeId: string;
    correlationId: string;
    subject: string;
    publishedAt: string;
  }): void {
    this.db.insert(firedEvents).values(input).run();
  }

  findFiredByCorrelation(correlationId: string) {
    return this.db.select().from(firedEvents).where(eq(firedEvents.correlationId, correlationId)).get() ?? null;
  }

  bumpIgnored(blueprintId: string, day: string): void {
    this.db
      .insert(ignoredCounters)
      .values({ blueprintId, day, count: 1 })
      .onConflictDoUpdate({
        target: [ignoredCounters.blueprintId, ignoredCounters.day],
        set: { count: sql`${ignoredCounters.count} + 1` },
      })
      .run();
  }

  ignoredCount(blueprintId: string, day: string): number {
    const row = this.db
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
