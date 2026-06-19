import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Scheduler, TickResult } from "../scheduler/core";

/** Heartbeat cadence — the edge stand-in for the local daemon's croner timers. */
export const ALARM_PERIOD_MS = 60_000;
/** Refresh blueprints from KV every Nth tick (5 ticks × 60s = 5 min, matching the
 *  previous DO refresh cadence). Schedule evaluation runs EVERY tick. */
export const REFRESH_EVERY_TICKS = 5;

const KEY_LAST_TICK = "scheduler:lastTick";
const KEY_REFRESH_COUNTER = "scheduler:refreshCounter";

export interface HeartbeatState {
  /** ISO timestamp of the last processed tick (exclusive window lower bound). */
  lastTick: string | null;
  /** Ticks remaining before the next KV refresh. */
  refreshCounter: number;
}

/**
 * Edge heartbeat adapter (F-002, reflex#20). A self-rescheduling Durable
 * Object alarm is the ONLY clock — zero Cloudflare Cron Triggers. Self-healing:
 * each fire arms the next. This relies on the Cloudflare DO Alarms contract
 * (alarms are documented as guaranteed-delivery and retried, surviving
 * eviction) — that durability is an external platform property, not enforced
 * here. Unifies schedule evaluation with the DO's KV blueprint-refresh cadence.
 */
export class EdgeHeartbeat {
  constructor(
    private readonly state: DurableObjectState,
    private readonly scheduler: Scheduler,
    /** Refresh the blueprint set (KV reload + bus resubscribe) — runs every Nth tick. */
    private readonly onRefresh: () => Promise<void>,
  ) {}

  async load(): Promise<HeartbeatState> {
    const [lastTick, refreshCounter] = await Promise.all([
      this.state.storage.get<string>(KEY_LAST_TICK),
      this.state.storage.get<number>(KEY_REFRESH_COUNTER),
    ]);
    return { lastTick: lastTick ?? null, refreshCounter: refreshCounter ?? 0 };
  }

  private async save(state: HeartbeatState): Promise<void> {
    await this.state.storage.put({
      [KEY_LAST_TICK]: state.lastTick,
      [KEY_REFRESH_COUNTER]: state.refreshCounter,
    });
  }

  /** Arm the next alarm. Called on startup and at the end of every alarm. */
  async arm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
  }

  /**
   * One heartbeat: refresh blueprints on cadence, evaluate due schedules over
   * `(lastTick, now]`, persist `lastTick`, re-arm. `now` is injectable for
   * deterministic tests. Always re-arms — the heartbeat never stops.
   */
  async onAlarm(now: Date = new Date()): Promise<TickResult> {
    const heartbeat = await this.load();

    if (heartbeat.refreshCounter <= 0) {
      try {
        await this.onRefresh();
      } catch (error) {
        // Continue with whatever blueprint set is already in memory and keep
        // the heartbeat running. NOTE: this does not guarantee schedules are
        // current — if the very first refresh fails the set may be empty, and
        // a later failure leaves a stale set until the next successful refresh.
        console.error(`[reflex-heartbeat] blueprint refresh failed (using in-memory set): ${(error as Error).message}`);
      }
      heartbeat.refreshCounter = REFRESH_EVERY_TICKS;
    }
    heartbeat.refreshCounter -= 1;

    const lastTick = heartbeat.lastTick ? new Date(heartbeat.lastTick) : null;
    let result: TickResult;
    try {
      result = await this.scheduler.tick(lastTick, now);
      // Advance only on a returned tick (per-blueprint errors are inside
      // TickResult and do NOT block advancement — those occurrences are spent).
      heartbeat.lastTick = now.toISOString();
      await this.save(heartbeat);
    } finally {
      // Always re-arm, even if tick() threw (then lastTick is NOT advanced and
      // the next alarm retries the same window).
      await this.arm();
    }
    return result;
  }
}
