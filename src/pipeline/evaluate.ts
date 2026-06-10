import type { ActivationBlueprint } from "../activation/types";
import type { BlueprintStore } from "../activation/store";
import type { ReflexBus } from "../bus";
import type { ReflexActor } from "../bus/envelopes";
import type { Repository } from "../store/repository";
import { checkGuards } from "./guards";
import { IDEMPOTENCY_WINDOW_MS, type EvaluateResult, type Impulse } from "./impulse";
import type { DryRunVerdict } from "./verdict";

export interface PipelineOptions {
  store: BlueprintStore;
  repo: Repository;
  bus: ReflexBus;
  /** Injected clock for determinism (NFR-3). Default: real time. */
  nowFn?: () => string;
}

/**
 * The decision pipeline (design §3): Impulse → rule evaluation → Activation
 * Decision → Policy → (Approval) → Guards → Activation Event. Decisions are
 * immutable (ADR-0001); the fire path is persist-then-publish — the decision
 * row is the truth, the wire catches up via the R-101 outage queue.
 */
export class Pipeline {
  private readonly store: BlueprintStore;
  private readonly repo: Repository;
  private readonly bus: ReflexBus;
  private readonly nowFn: () => string;
  /** Per-blueprint serialization: concurrent evaluations for ONE blueprint queue (NFR-2). */
  private chains = new Map<string, Promise<unknown>>();

  constructor(options: PipelineOptions) {
    this.store = options.store;
    this.repo = options.repo;
    this.bus = options.bus;
    this.nowFn = options.nowFn ?? (() => new Date().toISOString());
  }

  evaluate(impulse: Impulse): Promise<EvaluateResult> {
    return this.serialized(impulse.blueprintId, () => this.evaluateInner(impulse));
  }

  private async evaluateInner(impulse: Impulse): Promise<EvaluateResult> {
    const now = this.nowFn();
    const blueprint = this.store.get(impulse.blueprintId);
    if (!blueprint || blueprint.kind !== impulse.kind) {
      // No-match ignores are counted too — every ignored evaluation is
      // visible in counters (sage R-104 cycle-2 finding).
      this.repo.bumpIgnored(impulse.blueprintId, now.slice(0, 10));
      return { outcome: "ignored", reason: "no-match" };
    }
    if (blueprint.policy === "disabled") {
      this.repo.bumpIgnored(blueprint.id, now.slice(0, 10));
      return { outcome: "ignored", reason: "disabled" };
    }

    if (blueprint.policy === "approval") {
      const decision = this.repo.recordDecision({
        blueprintId: blueprint.id,
        outcome: "matched",
        impulse: snapshot(impulse),
        correlationId: impulse.sourceEnvelope?.correlationId,
      });
      const expiresAt = new Date(Date.parse(now) + blueprint.approvalTimeoutMs).toISOString();
      this.repo.createApproval(decision.id, expiresAt);
      await this.bus.publishDecision({
        outcome: "matched",
        blueprintId: blueprint.id,
        decisionId: decision.id,
        actor: impulse.actor,
      });
      return { outcome: "matched", decisionId: decision.id, expiresAt };
    }

    // policy: auto → guards → fire
    return this.guardsAndFire(blueprint, impulse, now, undefined);
  }

  /** Shared by auto path, post-approval path, and buffer re-presentation. */
  private async guardsAndFire(
    blueprint: ActivationBlueprint,
    impulse: Impulse,
    now: string,
    causationId: string | undefined,
  ): Promise<EvaluateResult> {
    const check = checkGuards(blueprint, impulse, this.repo, now);
    if (!check.pass) {
      const decision = this.repo.recordDecision({
        blueprintId: blueprint.id,
        outcome: "blocked",
        impulse: snapshot(impulse),
        guardBlockReason: check.reason,
        resolutionOf: causationId,
        correlationId: impulse.sourceEnvelope?.correlationId,
      });
      if (check.reason === "run-lock-buffered") {
        this.repo.putBufferedImpulse(blueprint.id, snapshot(impulse), decision.id);
      }
      await this.bus.publishDecision({
        outcome: "blocked",
        blueprintId: blueprint.id,
        decisionId: decision.id,
        reason: check.reason,
        actor: impulse.actor,
        causationId,
      });
      return { outcome: "blocked", decisionId: decision.id, reason: check.reason };
    }

    // FIRE PATH — order matters (plan FR-7, fail closed FR-11):
    // 1. persist the Fired Decision (the truth)
    const correlationId = crypto.randomUUID();
    const decision = this.repo.recordDecision({
      blueprintId: blueprint.id,
      outcome: "fired",
      impulse: snapshot(impulse),
      resolutionOf: causationId,
      correlationId,
    });
    // 2. engage guards
    this.repo.putIdempotencyKey(
      blueprint.id,
      check.idempotencyKey,
      new Date(Date.parse(now) + IDEMPOTENCY_WINDOW_MS).toISOString(),
    );
    if (blueprint.guards.cooldownMs !== undefined) {
      this.repo.setCooldown(blueprint.id, new Date(Date.parse(now) + blueprint.guards.cooldownMs).toISOString());
    }
    if (blueprint.guards.runLock !== undefined) {
      this.repo.acquireRunLock(blueprint.id, correlationId, now);
    }
    // 3. record the event row (history + buffer matching)
    this.repo.recordFiredEvent({
      decisionId: decision.id,
      // Honest null: myelin assigns the envelope id inside the transport and
      // does not expose it to publishers; correlation_id is the join key.
      // Populate when the bus surfaces envelope identity (future enhancement).
      envelopeId: null,
      correlationId,
      subject: "derived-by-bus",
      publishedAt: now,
    });
    // 4. publish (queue-backed — never throws; outage rides R-101 queue).
    // The two envelopes are independent — publish them concurrently.
    await Promise.all([
      this.bus.publishFired({
        target: blueprint.target,
        payload: { ...blueprint.payload, ...impulse.payload },
        idempotencyKey: check.idempotencyKey,
        decisionId: decision.id,
        correlationId,
        actor: impulse.actor,
        causationId,
      }),
      this.bus.publishDecision({
        outcome: "fired",
        blueprintId: blueprint.id,
        decisionId: decision.id,
        actor: impulse.actor,
        correlationId,
        causationId,
      }),
    ]);
    return { outcome: "fired", decisionId: decision.id, correlationId };
  }

  /**
   * Resolve a waiting Matched Decision (FR-10). approve → CAS to approved
   * FIRST (exactly one resolver wins; the approval state machine records the
   * operator's act), THEN the honest guards+fire path runs — a guard
   * violation after approval records a Blocked row linked to the matched
   * decision, so "approved but guard-blocked" is visible in the audit trail
   * exactly as it happened. deny → Denied. ConflictError propagates verbatim.
   */
  async resolveMatched(
    decisionId: string,
    action: "approve" | "deny",
    actor: ReflexActor,
  ): Promise<EvaluateResult | { outcome: "denied"; decisionId: string }> {
    const matched = this.repo.getDecision(decisionId);
    if (!matched) throw new Error(`Decision ${decisionId} not found`);

    if (action === "deny") {
      const now = this.nowFn();
      const resolution = this.repo.resolveMatched(decisionId, {
        kind: "deny",
        resolutionOutcome: "denied",
        actor,
        now,
      });
      await this.bus.publishDecision({
        outcome: "denied",
        blueprintId: matched.blueprintId,
        decisionId: resolution.id,
        actor,
        causationId: decisionId,
      });
      return { outcome: "denied", decisionId: resolution.id };
    }

    return this.serialized(matched.blueprintId, async () => {
      // Clock read INSIDE the serialized callback: an approve queued behind
      // same-blueprint work must use the instant it actually runs, not the
      // instant it was enqueued (sage R-104 cycle-3 finding).
      const now = this.nowFn();
      const blueprint = this.store.get(matched.blueprintId);
      if (!blueprint) {
        this.repo.resolveMatched(decisionId, {
          kind: "expire",
          resolutionOutcome: "expired",
          reason: "blueprint-removed",
          now,
        });
        return { outcome: "ignored" as const, reason: "no-match" as const } as EvaluateResult;
      }
      // CAS to approved first (exactly one resolver wins), then run the
      // honest guards+fire path — its Fired OR Blocked row links the matched
      // decision via causation (spec edge: cooldown engaged since match).
      this.repo.approveWaiting(decisionId, actor, now);
      const impulse = impulseFromSnapshot(matched.impulse, matched.blueprintId, actor);
      return this.guardsAndFire(blueprint, impulse, now, decisionId);
    });
  }

  /**
   * Run Lock release + Buffered Impulse re-presentation (FR-6). Called by
   * R-108 when a terminal run outcome arrives for a correlation we stamped.
   */
  async onRunCompleted(correlationId: string, _outcome: string): Promise<EvaluateResult | null> {
    const fired = this.repo.findFiredByCorrelation(correlationId);
    if (!fired) {
      console.warn(`[reflex-pipeline] run outcome for unknown correlation ${correlationId} — ignoring`);
      return null;
    }
    const decision = this.repo.getDecision(fired.decisionId);
    if (!decision) return null;
    const blueprintId = decision.blueprintId;
    this.repo.releaseRunLock(blueprintId, correlationId);
    // Blueprint checked BEFORE consuming the buffer: a hot-reload-removed
    // blueprint must not silently swallow the impulse (sage cycle-2 finding)
    // — the orphaned buffer is discarded LOUDLY.
    const blueprint = this.store.get(blueprintId);
    if (!blueprint) {
      const orphan = this.repo.takeBufferedImpulse(blueprintId);
      if (orphan) {
        console.warn(
          `[reflex-pipeline] discarding Buffered Impulse for removed blueprint ${blueprintId} ` +
            `(buffered by decision ${orphan.bufferedByDecisionId ?? "unknown"})`,
        );
      }
      return null;
    }
    const buffered = this.repo.takeBufferedImpulse(blueprintId);
    if (!buffered) return null;
    const impulse = impulseFromSnapshot(buffered.impulse, blueprintId, { type: "system", id: "reflex-buffer" });
    return this.serialized(blueprintId, () =>
      this.guardsAndFire(blueprint, impulse, this.nowFn(), buffered.bufferedByDecisionId ?? undefined),
    );
  }

  /** Dry Run Verdict (FR-9): full prediction, zero writes, zero publishes. */
  evaluateDry(impulse: Impulse): DryRunVerdict {
    const now = this.nowFn();
    const blueprint = this.store.get(impulse.blueprintId);
    if (!blueprint || blueprint.kind !== impulse.kind) {
      return { wouldOutcome: "ignored", reasons: ["no blueprint matches this impulse"] };
    }
    if (blueprint.policy === "disabled") {
      return { wouldOutcome: "ignored", reasons: ["policy is disabled"] };
    }
    if (blueprint.policy === "approval") {
      return { wouldOutcome: "matched", reasons: [`would wait for approval (timeout ${blueprint.approvalTimeoutMs}ms)`] };
    }
    const check = checkGuards(blueprint, impulse, this.repo, now);
    if (!check.pass) {
      return { wouldOutcome: "blocked", reasons: [`would block: ${check.detail}`] };
    }
    return { wouldOutcome: "fired", reasons: [`would fire at target ${blueprint.target}`] };
  }

  private serialized<T>(blueprintId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(blueprintId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // The stored chain tail swallows rejections — the CALLER of `next` owns
    // the error; the queue link must never surface as an unhandled rejection.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(
      blueprintId,
      tail.finally(() => {
        if (this.chains.get(blueprintId) === tail) this.chains.delete(blueprintId);
      }),
    );
    return next;
  }
}

function snapshot(impulse: Impulse) {
  return { kind: impulse.kind, payload: impulse.payload, receivedAt: impulse.receivedAt };
}

function impulseFromSnapshot(
  snap: { kind: Impulse["kind"]; payload: Record<string, unknown>; receivedAt: string },
  blueprintId: string,
  actor: ReflexActor,
): Impulse {
  return { kind: snap.kind, blueprintId, payload: snap.payload, receivedAt: snap.receivedAt, actor };
}
