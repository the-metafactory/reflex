import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Decision rows are append-only (ADR-0001): no code path updates `outcome`.
 * A Matched Decision resolves via a NEW row carrying `resolution_of` plus a
 * compare-and-set transition on `approvals.state`.
 */
export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    blueprintId: text("blueprint_id").notNull(),
    outcome: text("outcome").notNull(),
    /** JSON: { kind, payload, receivedAt } — the evaluated Impulse snapshot. */
    impulse: text("impulse").notNull(),
    guardBlockReason: text("guard_block_reason"),
    /** Decision id this row resolves (fired/denied/expired resolving a matched). */
    resolutionOf: text("resolution_of"),
    correlationId: text("correlation_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check(
      "decisions_outcome_check",
      sql`${t.outcome} IN ('ignored','matched','blocked','fired','denied','expired')`,
    ),
    index("decisions_blueprint_idx").on(t.blueprintId, t.createdAt),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    decisionId: text("decision_id").primaryKey(),
    state: text("state").notNull(),
    reason: text("reason"),
    /** JSON ReflexActor. */
    actor: text("actor"),
    expiresAt: text("expires_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    check("approvals_state_check", sql`${t.state} IN ('waiting','approved','denied','expired')`),
    index("approvals_state_idx").on(t.state, t.expiresAt),
  ],
);

export const guardState = sqliteTable("guard_state", {
  blueprintId: text("blueprint_id").primaryKey(),
  cooldownUntil: text("cooldown_until"),
  /** correlation_id of the in-flight run holding the Run Lock. */
  runLockHolder: text("run_lock_holder"),
  runLockSince: text("run_lock_since"),
  /** JSON Impulse — at most one per blueprint by PK construction (depth 1). */
  bufferedImpulse: text("buffered_impulse"),
  /** The Blocked Decision that buffered it — re-presentation links to it (CONTEXT.md). */
  bufferedByDecisionId: text("buffered_by_decision_id"),
});

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    /** Keys are scoped per blueprint — a key for one blueprint must never
     * suppress another blueprint's work (sage R-103 security finding). */
    blueprintId: text("blueprint_id").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blueprintId, t.key] }), index("idempotency_expiry_idx").on(t.expiresAt)],
);

export const firedEvents = sqliteTable(
  "fired_events",
  {
    decisionId: text("decision_id").primaryKey(),
    /** Myelin envelope id when known — the transport does not currently
     * expose it to publishers, so this is nullable (correlation_id joins). */
    envelopeId: text("envelope_id"),
    correlationId: text("correlation_id").notNull(),
    subject: text("subject").notNull(),
    publishedAt: text("published_at").notNull(),
  },
  (t) => [index("fired_correlation_idx").on(t.correlationId)],
);

export const ignoredCounters = sqliteTable(
  "ignored_counters",
  {
    blueprintId: text("blueprint_id").notNull(),
    day: text("day").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blueprintId, t.day] })],
);
