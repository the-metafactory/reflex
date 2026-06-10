import { Cron } from "croner";
import type { BlueprintStore } from "../activation/store";
import type { ActivationBlueprint } from "../activation/types";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";

/** The slice of Pipeline the scheduler needs — injectable for tests. */
export interface ImpulseSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
}

export interface ScheduleStatus {
  blueprintId: string;
  nextTick: string | null;
  lastTick: string | null;
  lastOutcome: string | null;
}

interface Job {
  cron: Cron;
  /** Signature for change detection: cron expression + timezone. */
  signature: string;
  lastTick: string | null;
  lastOutcome: string | null;
}

/**
 * Internal Impulse source for schedule-kind blueprints (design §4): one
 * croner job per blueprint, tick → Impulse → pipeline. The scheduler ALWAYS
 * submits — concurrency/throttling belongs to the blueprint's Activation
 * Guards, never to the scheduler (spec FR-5). No backfill: missed ticks
 * while down are logged at start, never replayed (spec FR-4).
 */
export class ScheduleSource {
  private jobs = new Map<string, Job>();

  constructor(
    private readonly store: BlueprintStore,
    private readonly sink: ImpulseSink,
  ) {}

  start(): void {
    this.sync();
    for (const [id, job] of this.jobs) {
      const prev = job.cron.previousRun();
      const next = job.cron.nextRun();
      console.info(
        `[reflex-schedule] ${id}: next tick ${next?.toISOString() ?? "never"}` +
          (prev ? ` (most recent scheduled tick ${prev.toISOString()} NOT backfilled)` : ""),
      );
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }

  /**
   * Reconcile jobs with the live blueprint set (hot-reload, spec FR-3):
   * added → create, removed → stop, cron/timezone changed → replace.
   * Invariant: job keys == schedule-blueprint ids after every sync.
   */
  sync(): void {
    const blueprints = new Map(this.store.byKind("schedule").map((b) => [b.id, b]));
    for (const [id, job] of this.jobs) {
      const blueprint = blueprints.get(id);
      if (!blueprint || signatureOf(blueprint) !== job.signature) {
        job.cron.stop();
        this.jobs.delete(id);
      }
    }
    for (const [id, blueprint] of blueprints) {
      if (!this.jobs.has(id)) {
        this.jobs.set(id, this.createJob(blueprint));
      }
    }
  }

  status(): ScheduleStatus[] {
    return [...this.jobs.entries()].map(([blueprintId, job]) => ({
      blueprintId,
      nextTick: job.cron.nextRun()?.toISOString() ?? null,
      lastTick: job.lastTick,
      lastOutcome: job.lastOutcome,
    }));
  }

  private createJob(blueprint: ActivationBlueprint): Job {
    if (!("schedule" in blueprint.when)) {
      throw new Error(`blueprint ${blueprint.id} is not schedule-kind`); // guarded by byKind
    }
    const { schedule, timezone } = blueprint.when;
    const job: Job = { cron: null as never, signature: signatureOf(blueprint), lastTick: null, lastOutcome: null };
    job.cron = new Cron(schedule, { timezone, protect: false }, (self: Cron) => {
      const scheduledFor = self.currentRun()?.toISOString() ?? new Date().toISOString();
      job.lastTick = scheduledFor;
      const impulse: Impulse = {
        kind: "schedule",
        blueprintId: blueprint.id,
        payload: { scheduled_for: scheduledFor },
        receivedAt: new Date().toISOString(),
        actor: { type: "system", id: "reflex-scheduler" },
      };
      // Fire-and-forget: the scheduler never blocks on evaluation; one bad
      // blueprint cannot stop the scheduler (spec edge).
      void this.sink
        .evaluate(impulse)
        .then((result) => {
          job.lastOutcome = result.outcome;
        })
        .catch((error: Error) => {
          job.lastOutcome = "error";
          console.error(`[reflex-schedule] evaluate failed for ${blueprint.id}: ${error.message}`);
        });
    });
    return job;
  }
}

function signatureOf(blueprint: ActivationBlueprint): string {
  if (!("schedule" in blueprint.when)) return "";
  return `${blueprint.when.schedule}|${blueprint.when.timezone ?? ""}`;
}
