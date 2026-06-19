import { Cron } from "croner";
import type { BlueprintStore } from "../activation/store";
import type { ScheduleWhen } from "../activation/types";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";

/** Pipeline slice the scheduler needs — injectable for tests (mirrors the other sources). */
export interface SchedulerSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
}

export interface SchedulerOptions {
  store: BlueprintStore;
  sink: SchedulerSink;
}

export interface TickResult {
  /** Blueprint ids that fired this tick (one Impulse each). */
  evaluated: string[];
  /** Blueprints whose window held >1 occurrence — fired once anyway (collapse). */
  collapsed: Array<{ blueprintId: string; missedOccurrences: number }>;
  /** Per-blueprint evaluation errors — non-fatal; the tick continues. */
  errors: Array<{ blueprintId: string; error: string }>;
}

/** Cap on the collapse-count loop so a long outage over a frequent cron can't
 *  spin unboundedly — the count is for observability only; firing is once. */
const MAX_COLLAPSE_COUNT = 10_000;

/**
 * Environment-agnostic schedule evaluation core (F-002, reflex#20).
 *
 * Replaces the per-expression Cloudflare Cron Trigger mapping
 * (EdgeScheduleSource): instead of CF firing each declared expression, a
 * heartbeat calls `tick(lastTick, now)` and reflex itself decides which
 * schedule-kind blueprints are due. One heartbeat drives any number of
 * blueprints — zero CF cron-trigger budget.
 *
 * Determinism: given (lastTick, now) and the blueprint set, the fired set is
 * a pure function of croner's `nextRun`. Time is injected, never read here.
 */
export class Scheduler {
  constructor(private readonly options: SchedulerOptions) {}

  /**
   * Evaluate all schedule-kind blueprints for the half-open window
   * `(lastTick, now]`. A blueprint fires iff its next occurrence strictly
   * after `lastTick` is `<= now`. Collapse catch-up: multiple occurrences in
   * the window fire EXACTLY ONCE (no burst after an outage).
   *
   * @param lastTick exclusive lower bound; `null` on cold start (no backfill).
   * @param now inclusive upper bound (injected current time).
   */
  async tick(lastTick: Date | null, now: Date): Promise<TickResult> {
    const result: TickResult = { evaluated: [], collapsed: [], errors: [] };

    // Backward / non-monotonic clock: never fire into the past.
    if (lastTick && now.getTime() <= lastTick.getTime()) return result;

    // Cold start does NOT backfill: treat the window as the instant before
    // `now` (matches the local daemon R-105 "most recent tick NOT backfilled").
    const from = lastTick ?? new Date(now.getTime() - 1);

    for (const blueprint of this.options.store.byKind("schedule")) {
      const when = blueprint.when as ScheduleWhen;
      let firstDue: Date | null;
      try {
        // No handler → inert query object; never schedules a timer.
        const cron = new Cron(when.schedule, { timezone: when.timezone });
        firstDue = cron.nextRun(from);
        if (!firstDue || firstDue.getTime() > now.getTime()) continue; // not due this window

        // Count additional occurrences in the window (observability only).
        let missed = 0;
        let probe: Date | null = cron.nextRun(firstDue);
        while (probe && probe.getTime() <= now.getTime() && missed < MAX_COLLAPSE_COUNT) {
          missed++;
          probe = cron.nextRun(probe);
        }
        if (missed > 0) result.collapsed.push({ blueprintId: blueprint.id, missedOccurrences: missed });
      } catch (error) {
        // A bad cron expression should never have loaded (schema validates),
        // but never let one blueprint break the whole tick.
        result.errors.push({ blueprintId: blueprint.id, error: (error as Error).message });
        continue;
      }

      const impulse: Impulse = {
        kind: "schedule",
        blueprintId: blueprint.id,
        payload: { scheduled_for: firstDue.toISOString() },
        receivedAt: now.toISOString(),
        actor: { type: "system", id: "reflex-scheduler" },
      };

      try {
        await this.options.sink.evaluate(impulse);
        result.evaluated.push(blueprint.id);
      } catch (error) {
        result.errors.push({ blueprintId: blueprint.id, error: (error as Error).message });
      }
    }

    return result;
  }
}
