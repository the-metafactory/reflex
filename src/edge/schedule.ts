import type { BlueprintStore } from "../activation/store";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";

/** Pipeline slice the schedule source needs — injectable for tests. */
export interface ScheduleSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
}

/**
 * Cron Triggers schedule source (reflex#15) — the edge replacement for
 * R-105's croner jobs, exactly the delegation the original cues research
 * (2026-04) named: the platform owns the clock; Reflex owns the decision.
 *
 * A Workers `scheduled` event carries the cron EXPRESSION that fired
 * (`event.cron`) and the scheduled time. Mapping: every schedule-kind
 * blueprint whose `when.schedule` equals the fired expression gets one
 * schedule Impulse. wrangler.toml `[triggers].crons` must therefore list
 * each distinct expression used by schedule blueprints — a blueprint
 * whose expression is missing from wrangler.toml never ticks (surfaced
 * by `unmatchedExpressions`).
 *
 * Platform-inherited differences from R-105 (documented, accepted):
 * - timezone: Cron Triggers run in UTC; blueprint `timezone` is ignored
 *   on edge (loudly, once per blueprint set)
 * - no skippedTicks bookkeeping: invocations are platform-managed; the
 *   guards (idempotency window keyed on scheduled_for) make a duplicate
 *   delivery harmless
 * - no backfill, same as R-105 (missed ticks are never replayed)
 */
export class EdgeScheduleSource {
  constructor(
    private readonly store: BlueprintStore,
    private readonly sink: ScheduleSink,
  ) {}

  /** Schedule expressions blueprints use that the worker MUST declare in wrangler.toml. */
  expressions(): string[] {
    return [...new Set(this.store.byKind("schedule").map((b) => scheduleOf(b)))].sort();
  }

  /** Blueprint expressions NOT covered by the wrangler-declared cron list. */
  unmatchedExpressions(declaredCrons: string[]): string[] {
    const declared = new Set(declaredCrons);
    return this.expressions().filter((expr) => !declared.has(expr));
  }

  /**
   * Handle one Cron Trigger firing: evaluate every schedule blueprint
   * whose expression matches. Evaluations run sequentially — the pipeline
   * serializes per blueprint anyway, and a scheduled invocation has no
   * caller waiting on latency.
   */
  async onScheduled(event: { cron: string; scheduledTime: number }): Promise<EvaluateResult[]> {
    const scheduledFor = new Date(event.scheduledTime).toISOString();
    const results: EvaluateResult[] = [];
    const matched = this.store.byKind("schedule").filter((b) => scheduleOf(b) === event.cron);
    if (matched.length === 0) {
      // Expression equality is STRING equality — "*/5 * * * *" and an
      // enumerated equivalent never match. Silent non-scheduling is the
      // failure mode; be loud instead.
      console.warn(
        `[reflex-edge-schedule] trigger "${event.cron}" matched no schedule blueprint — ` +
          `blueprint expressions: [${this.expressions().join(", ")}] (string equality; use canonical forms)`,
      );
      return results;
    }
    for (const blueprint of matched) {
      if (timezoneOf(blueprint)) {
        console.warn(
          `[reflex-edge-schedule] ${blueprint.id}: timezone "${timezoneOf(blueprint)}" ignored — Cron Triggers fire in UTC`,
        );
      }
      const impulse: Impulse = {
        kind: "schedule",
        blueprintId: blueprint.id,
        payload: { scheduled_for: scheduledFor },
        receivedAt: new Date().toISOString(),
        actor: { type: "system", id: "reflex-scheduler" },
      };
      try {
        results.push(await this.sink.evaluate(impulse));
      } catch (error) {
        console.error(`[reflex-edge-schedule] evaluate failed for ${blueprint.id}: ${(error as Error).message}`);
      }
    }
    return results;
  }
}

function scheduleOf(blueprint: { when: unknown }): string {
  return "schedule" in (blueprint.when as Record<string, unknown>)
    ? ((blueprint.when as { schedule: string }).schedule)
    : "";
}

function timezoneOf(blueprint: { when: unknown }): string | undefined {
  return "timezone" in (blueprint.when as Record<string, unknown>)
    ? ((blueprint.when as { timezone?: string }).timezone)
    : undefined;
}
