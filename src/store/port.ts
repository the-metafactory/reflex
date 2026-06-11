import type { ReflexActor } from "../bus/envelopes";
import type { ApprovalRow, DecisionOutcome, DecisionRow, ImpulseSnapshot } from "./repository";

/**
 * A value that may arrive synchronously (bun:sqlite Repository) or as a
 * promise (D1Repository on Cloudflare — D1 has no sync API). Callers MUST
 * `await` every port method; awaiting a plain value is a no-op.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * The storage surface the pipeline, guards, and impulse sources consume
 * (reflex#15). The sync `Repository` class satisfies this interface
 * structurally — `T` is assignable to `Awaitable<T>` — so the local
 * bun:sqlite driver needs no changes. `D1Repository` implements the
 * async side for Cloudflare Workers.
 *
 * Methods the daemon/CLI use beyond the pipeline (sweeps, history,
 * approvals listing) are included so an edge runtime can serve the same
 * command surface.
 */
export interface RepositoryPort {
  // decisions
  recordDecision(input: {
    blueprintId: string;
    outcome: DecisionOutcome;
    impulse: ImpulseSnapshot;
    guardBlockReason?: string;
    resolutionOf?: string;
    correlationId?: string;
  }): Awaitable<DecisionRow>;
  getDecision(id: string): Awaitable<DecisionRow | null>;
  historyFor(filter: { blueprintId?: string; limit?: number }): Awaitable<DecisionRow[]>;

  // approvals
  createApproval(decisionId: string, expiresAt: string): Awaitable<void>;
  getApproval(decisionId: string): Awaitable<ApprovalRow | null>;
  listWaiting(): Awaitable<Array<ApprovalRow & { decision: DecisionRow }>>;
  resolveMatched(
    matchedId: string,
    input: {
      kind: "approve" | "deny" | "expire";
      resolutionOutcome: "fired" | "denied" | "expired";
      actor?: ReflexActor;
      reason?: string;
      now: string;
    },
  ): Awaitable<DecisionRow>;
  approveWaiting(decisionId: string, actor: ReflexActor, now: string): Awaitable<void>;
  sweepExpiredApprovals(now: string, limit?: number): Awaitable<Array<{ decisionId: string }>>;
  expireForBlueprint(blueprintId: string, now: string): Awaitable<Array<{ decisionId: string }>>;

  // guard state
  staleLocks(now: string, maxAgeMs: number): Awaitable<Array<{ blueprintId: string; holder: string; since: string }>>;
  getGuardState(blueprintId: string): Awaitable<{
    blueprintId: string;
    cooldownUntil: string | null;
    runLockHolder: string | null;
    runLockSince: string | null;
    bufferedImpulse: string | null;
    bufferedByDecisionId: string | null;
  } | null>;
  setCooldown(blueprintId: string, until: string): Awaitable<void>;
  acquireRunLock(
    blueprintId: string,
    correlationId: string,
    now: string,
  ): Awaitable<{ acquired: true } | { acquired: false; holder: string }>;
  releaseRunLock(blueprintId: string, correlationId: string): Awaitable<boolean>;
  putBufferedImpulse(blueprintId: string, impulse: ImpulseSnapshot, bufferedByDecisionId: string): Awaitable<void>;
  takeBufferedImpulse(
    blueprintId: string,
  ): Awaitable<{ impulse: ImpulseSnapshot; bufferedByDecisionId: string | null } | null>;
  putIdempotencyKey(blueprintId: string, key: string, expiresAt: string): Awaitable<void>;
  hasIdempotencyKey(blueprintId: string, key: string, now: string): Awaitable<boolean>;
  sweepIdempotencyKeys(now: string): Awaitable<number>;

  // fired events + counters
  recordFiredEvent(input: {
    decisionId: string;
    envelopeId: string | null;
    correlationId: string;
    subject: string;
    publishedAt: string;
  }): Awaitable<void>;
  findFiredByCorrelation(
    correlationId: string,
  ): Awaitable<{ decisionId: string; correlationId: string } | null>;
  bumpIgnored(blueprintId: string, day: string): Awaitable<void>;
  bumpIgnoredBy(blueprintId: string, day: string, count: number): Awaitable<void>;
  ignoredCount(blueprintId: string, day: string): Awaitable<number>;
}
