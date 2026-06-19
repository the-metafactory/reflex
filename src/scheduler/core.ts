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

/** Bounded fan-out for per-blueprint pipeline evaluation (parity with the
 *  deleted EdgeScheduleSource chunking) — one slow blueprint must not stall
 *  the others in the same tick. */
const MAX_EVAL_CONCURRENCY = 5;

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

    // Phase 1 (sync): croner matching — which blueprints are due, and how many
    // occurrences collapsed. No awaits here, so this is cheap and ordered.
    const due: Array<{ id: string; impulse: Impulse }> = [];
    for (const blueprint of this.options.store.byKind("schedule")) {
      const when = blueprint.when as ScheduleWhen;
      try {
        // No handler → inert query object; never schedules a timer.
        const cron = new Cron(when.schedule, { timezone: when.timezone });
        const firstDue = cron.nextRun(from);
        if (!firstDue || firstDue.getTime() > now.getTime()) continue; // not due this window

        // Count additional occurrences in the window (observability only).
        let missed = 0;
        let probe: Date | null = cron.nextRun(firstDue);
        while (probe && probe.getTime() <= now.getTime() && missed < MAX_COLLAPSE_COUNT) {
          missed++;
          probe = cron.nextRun(probe);
        }
        if (missed > 0) result.collapsed.push({ blueprintId: blueprint.id, missedOccurrences: missed });

        due.push({
          id: blueprint.id,
          impulse: {
            kind: "schedule",
            blueprintId: blueprint.id,
            payload: { scheduled_for: firstDue.toISOString() },
            receivedAt: now.toISOString(),
            actor: { type: "system", id: "reflex-scheduler" },
          },
        });
      } catch (error) {
        // A bad cron expression should never have loaded (schema validates),
        // but never let one blueprint break the whole tick.
        result.errors.push({ blueprintId: blueprint.id, error: (error as Error).message });
      }
    }

    // Phase 2: evaluate due blueprints with BOUNDED PARALLELISM (parity with the
    // deleted edge path) — distinct blueprints are independent (the pipeline
    // serializes per blueprint internally), so one slow blueprint must not delay
    // the others in the window. Results are collected in `due` order so
    // `evaluated`/`errors` stay deterministic.
    for (let i = 0; i < due.length; i += MAX_EVAL_CONCURRENCY) {
      const chunk = due.slice(i, i + MAX_EVAL_CONCURRENCY);
      const settled = await Promise.allSettled(chunk.map((d) => this.options.sink.evaluate(d.impulse)));
      settled.forEach((outcome, j) => {
        const { id } = chunk[j]!;
        if (outcome.status === "fulfilled") result.evaluated.push(id);
        else result.errors.push({ blueprintId: id, error: (outcome.reason as Error).message });
      });
    }

    return result;
  }
}
