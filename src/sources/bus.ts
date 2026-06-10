import { subjectMatchesPattern } from "@the-metafactory/myelin";
import type { BlueprintStore } from "../activation/store";
import type { ActivationBlueprint, BusWhen } from "../activation/types";
import type { ReflexBus } from "../bus";
import type { ReflexConfig } from "../config/schema";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";
import type { Repository } from "../store/repository";
import { runOutcomeSubject, terminalOutcomeOf } from "./run-outcome";

/** Pipeline slice the bus source needs — injectable for tests. */
export interface BusSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
  onRunCompleted(correlationId: string, outcome: string): Promise<unknown>;
}

interface ActiveSubscription {
  signature: string;
  unsubscribe: () => Promise<void>;
}

/**
 * External Impulse source for bus-kind blueprints (design §4): one durable
 * subscription per blueprint, flat field-equals matching, plus the
 * run-outcome consumer that releases Run Locks and re-presents Buffered
 * Impulses (the bus half of the guard lifecycle — pipeline half is R-104).
 */
export class BusSource {
  private subscriptions = new Map<string, ActiveSubscription>();
  private outcomeSub: { unsubscribe: () => Promise<void> } | null = null;
  private missingFieldWarned = new Set<string>();
  /** Ignored counts buffer (sage R-108): non-matches coalesce in memory —
   * the hot bus callback never does a synchronous DB write per envelope. */
  private ignoredBuffer = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** The daemon's own fired-subject prefix — blueprints must not subscribe to it (cycle guard). */
  private readonly ownFiredSubject: string;

  constructor(
    private readonly cfg: Pick<ReflexConfig, "principal" | "stack">,
    private readonly store: BlueprintStore,
    private readonly bus: ReflexBus,
    private readonly sink: BusSink,
    private readonly repo: Repository,
  ) {
    this.ownFiredSubject = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;
  }

  async start(): Promise<void> {
    await this.sync();
    this.flushTimer = setInterval(() => this.flushIgnored(), 5_000);
    this.outcomeSub = await this.bus.subscribe(runOutcomeSubject(this.cfg), async (envelope) => {
      const outcome = terminalOutcomeOf(envelope.type);
      if (!outcome || !envelope.correlation_id) return;
      await this.sink.onRunCompleted(envelope.correlation_id, outcome);
    });
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.flushIgnored();
    for (const sub of this.subscriptions.values()) await sub.unsubscribe();
    this.subscriptions.clear();
    if (this.outcomeSub) await this.outcomeSub.unsubscribe();
    this.outcomeSub = null;
  }

  /** Reconcile subscriptions with the live blueprint set (hot-reload). */
  async sync(): Promise<void> {
    const blueprints = new Map(
      this.store
        .byKind("bus")
        .filter((b) => this.cycleGuard(b))
        .map((b) => [b.id, b]),
    );
    for (const [id, sub] of this.subscriptions) {
      const blueprint = blueprints.get(id);
      if (!blueprint || signatureOf(blueprint) !== sub.signature) {
        await sub.unsubscribe();
        this.subscriptions.delete(id);
      }
    }
    for (const [id, blueprint] of blueprints) {
      if (!this.subscriptions.has(id)) {
        try {
          this.subscriptions.set(id, await this.subscribeFor(blueprint));
        } catch (error) {
          console.error(`[reflex-bus-source] cannot subscribe for ${id}: ${(error as Error).message}`);
        }
      }
    }
  }

  /** Subscribed blueprint ids — orphan-free invariant surface for tests/status. */
  active(): string[] {
    return [...this.subscriptions.keys()].sort();
  }

  private cycleGuard(blueprint: ActivationBlueprint): boolean {
    const subject = (blueprint.when as BusWhen).bus.subject;
    // A blueprint listening to the daemon's own Activation Events would
    // re-activate on its own firings — an implicit feedback loop. Skipped
    // loudly; the blueprint is inert until the subject changes (spec FR-7).
    if (
      subjectMatchesPattern(this.ownFiredSubject, subject) ||
      subjectMatchesPattern(subject, this.ownFiredSubject)
    ) {
      console.error(
        `[reflex-bus-source] blueprint ${blueprint.id} subscribes to Reflex's own fired subject ` +
          `(${subject} ↔ ${this.ownFiredSubject}) — cycle rejected, blueprint inert`,
      );
      return false;
    }
    return true;
  }

  private async subscribeFor(blueprint: ActivationBlueprint): Promise<ActiveSubscription> {
    const when = (blueprint.when as BusWhen).bus;
    const subscription = await this.bus.subscribe(
      when.subject,
      async (envelope) => {
        if (!matches(when.where, envelope.payload)) {
          if (when.where && this.shouldWarnMissing(blueprint.id, when.where, envelope.payload)) {
            console.debug(`[reflex-bus-source] ${blueprint.id}: where-field absent from payload — never matches`);
          }
          this.ignoredBuffer.set(blueprint.id, (this.ignoredBuffer.get(blueprint.id) ?? 0) + 1);
          return;
        }
        const impulse: Impulse = {
          kind: "bus",
          blueprintId: blueprint.id,
          payload: envelope.payload,
          receivedAt: new Date().toISOString(),
          actor: { type: "system", id: "reflex-bus" },
          sourceEnvelope: { id: envelope.id, type: envelope.type, correlationId: envelope.correlation_id },
        };
        await this.sink.evaluate(impulse);
      },
      { durableName: `reflex-bus-${blueprint.id}`, deliverPolicy: "new", ackPolicy: "explicit" },
    );
    return { signature: signatureOf(blueprint), unsubscribe: () => subscription.unsubscribe() };
  }

  /** Coalesced flush of buffered ignored counts (one write per blueprint/day). */
  flushIgnored(): void {
    if (this.ignoredBuffer.size === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    for (const [blueprintId, count] of this.ignoredBuffer) {
      try {
        this.repo.bumpIgnoredBy(blueprintId, day, count);
      } catch (error) {
        console.error(`[reflex-bus-source] ignored-counter flush failed for ${blueprintId}: ${(error as Error).message}`);
      }
    }
    this.ignoredBuffer.clear();
  }

  private shouldWarnMissing(
    blueprintId: string,
    where: Record<string, string | number | boolean>,
    payload: Record<string, unknown>,
  ): boolean {
    const missing = Object.keys(where).some((k) => !(k in payload));
    if (!missing || this.missingFieldWarned.has(blueprintId)) return false;
    this.missingFieldWarned.add(blueprintId);
    return true;
  }
}

/** Flat field-equals (decision 10): ALL where-entries strict-equal top-level payload fields. */
export function matches(
  where: Record<string, string | number | boolean> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => payload[key] === value);
}

function signatureOf(blueprint: ActivationBlueprint): string {
  const when = (blueprint.when as BusWhen).bus;
  return `${when.subject}|${JSON.stringify(when.where ?? {})}`;
}
