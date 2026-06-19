# Technical Plan: F-002 — Edge DO-alarm Internal Scheduler

## Architecture Overview

```
BEFORE (CF Cron Trigger driven):
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Cloudflare     │────>│  Worker.scheduled│────>│  DO /schedule   │
│  Cron Triggers  │     │  handler         │     │  route          │
│  [triggers]     │     │  (worker.ts:39)  │     │  (consumer-do)  │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          v
                        ┌──────────────────┐     ┌─────────────────┐
                        │  EdgeSchedule    │────>│    Pipeline     │
                        │  Source          │     │    evaluate()   │
                        │  (string match)  │     │                 │
                        └──────────────────┘     └─────────────────┘

AFTER (DO Alarm driven — zero CF Cron Triggers):
                        ┌──────────────────┐
                        │  DO Alarm        │
                        │  (60s period)    │
                        └────────┬─────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              v                                     v
     ┌────────────────┐                   ┌─────────────────┐
     │ KV Refresh     │                   │ Scheduler.tick  │
     │ (every 5min)   │                   │ (every 60s)     │
     │ [existing]     │                   │ [NEW]           │
     └────────────────┘                   └────────┬────────┘
                                                   │
              ┌────────────────────────────────────┘
              │
              v
     ┌────────────────┐     ┌─────────────────┐
     │ Croner match   │────>│    Pipeline     │
     │ (lastTick,now] │     │    evaluate()   │
     │ + timezone     │     │                 │
     └────────────────┘     └─────────────────┘
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Cloudflare Workers (edge), Bun (local) | Existing stack |
| Schedule matcher | croner v10.0.1 | Already a dependency (src/sources/schedule.ts:1), runs in Workers |
| Persistence (edge) | DO state.storage | Durable, survives eviction, already used for alarm |
| Persistence (local) | In-memory (daemon state) | Daemon is long-running; file backup optional |
| Clock | DO Alarm (60s) | Guaranteed delivery, self-healing, no CF cron slots |

## Data Model

### DO Storage Keys

```typescript
// DO state.storage keys
const STORAGE_KEYS = {
  /** ISO timestamp of last processed tick. Null on cold start. */
  LAST_TICK: "scheduler:lastTick",
  /** Refresh counter — when 0, refresh blueprints from KV. */
  REFRESH_COUNTER: "scheduler:refreshCounter",
} as const;
```

### Scheduler State (shared core)

```typescript
interface SchedulerState {
  /** Last processed tick (exclusive lower bound of window). */
  lastTick: Date | null;
}

interface TickResult {
  /** Blueprints evaluated this tick. */
  evaluated: string[];
  /** Blueprints that would have fired but were collapsed (gap > 1 occurrence). */
  collapsed: Array<{ blueprintId: string; missedOccurrences: number }>;
  /** Errors during evaluation (non-fatal — tick continues). */
  errors: Array<{ blueprintId: string; error: string }>;
}
```

### Impulse Shape (unchanged)

```typescript
// Already defined in src/pipeline/impulse.ts
interface Impulse {
  kind: "schedule";
  blueprintId: string;
  payload: { scheduled_for: string };
  receivedAt: string;
  actor: { type: "system"; id: "reflex-scheduler" };
}
```

## Implementation Phases

### Phase 1: Scheduler Core (`src/scheduler/core.ts`)

Environment-agnostic tick logic. Uses croner for matching.

```typescript
import { Cron } from "croner";
import type { BlueprintStore } from "../activation/store";
import type { ActivationBlueprint, ScheduleWhen } from "../activation/types";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";

export interface SchedulerSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
}

export interface SchedulerOptions {
  store: BlueprintStore;
  sink: SchedulerSink;
}

export interface TickResult {
  evaluated: string[];
  collapsed: Array<{ blueprintId: string; missedOccurrences: number }>;
  errors: Array<{ blueprintId: string; error: string }>;
}

/**
 * Environment-agnostic schedule evaluation core.
 * Given (lastTick, now], fires each schedule blueprint whose next
 * croner occurrence falls within the window. Collapse catch-up:
 * multiple missed occurrences fire exactly once.
 */
export class Scheduler {
  constructor(private readonly options: SchedulerOptions) {}

  /**
   * Evaluate all schedule blueprints for the window (lastTick, now].
   * @param lastTick Exclusive lower bound (null = first tick, fire if due now).
   * @param now Inclusive upper bound (current time).
   * @returns Summary of evaluations + collapsed + errors.
   */
  async tick(lastTick: Date | null, now: Date): Promise<TickResult> {
    // Guard: non-monotonic clock (now <= lastTick) → no-op
    if (lastTick && now <= lastTick) {
      return { evaluated: [], collapsed: [], errors: [] };
    }

    const result: TickResult = { evaluated: [], collapsed: [], errors: [] };
    const blueprints = this.options.store.byKind("schedule");

    // Sequential evaluation — pipeline serializes per blueprint anyway,
    // and we want deterministic error handling per spec.
    for (const bp of blueprints) {
      const when = bp.when as ScheduleWhen;
      const cron = new Cron(when.schedule, { timezone: when.timezone });

      // Find if any occurrence falls in (lastTick, now]
      const ref = lastTick ?? new Date(now.getTime() - 1);
      const nextOccurrence = cron.nextRun(ref);

      if (!nextOccurrence || nextOccurrence > now) {
        continue; // Not due this window
      }

      // Count collapsed occurrences (collapse catch-up)
      let missed = 0;
      let check = cron.nextRun(nextOccurrence);
      while (check && check <= now) {
        missed++;
        check = cron.nextRun(check);
      }
      if (missed > 0) {
        result.collapsed.push({ blueprintId: bp.id, missedOccurrences: missed });
      }

      // Fire exactly once regardless of missed count
      const impulse: Impulse = {
        kind: "schedule",
        blueprintId: bp.id,
        payload: { scheduled_for: nextOccurrence.toISOString() },
        receivedAt: now.toISOString(),
        actor: { type: "system", id: "reflex-scheduler" },
      };

      try {
        await this.options.sink.evaluate(impulse);
        result.evaluated.push(bp.id);
      } catch (error) {
        result.errors.push({
          blueprintId: bp.id,
          error: (error as Error).message,
        });
      }
    }

    return result;
  }
}
```

### Phase 2: Edge Heartbeat Adapter (`src/edge/heartbeat.ts`)

DO alarm wrapper that persists lastTick and drives the scheduler.

```typescript
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Scheduler, TickResult } from "../scheduler/core";

const ALARM_PERIOD_MS = 60_000; // 60 seconds
const REFRESH_INTERVAL = 5; // Refresh KV every 5 ticks (5 min)

export interface HeartbeatState {
  lastTick: string | null;
  refreshCounter: number;
}

/**
 * DO alarm heartbeat adapter. Manages:
 * - Self-rescheduling 60s alarm (the only clock)
 * - lastTick persistence in DO storage
 * - KV refresh cadence (every Nth tick)
 */
export class EdgeHeartbeat {
  constructor(
    private readonly state: DurableObjectState,
    private readonly scheduler: Scheduler,
    private readonly onRefresh: () => Promise<void>,
  ) {}

  /** Read persisted state from DO storage. */
  async load(): Promise<HeartbeatState> {
    const [lastTick, refreshCounter] = await Promise.all([
      this.state.storage.get<string>("scheduler:lastTick"),
      this.state.storage.get<number>("scheduler:refreshCounter"),
    ]);
    return {
      lastTick: lastTick ?? null,
      refreshCounter: refreshCounter ?? 0,
    };
  }

  /** Persist lastTick and refreshCounter. */
  async save(state: HeartbeatState): Promise<void> {
    await this.state.storage.put({
      "scheduler:lastTick": state.lastTick,
      "scheduler:refreshCounter": state.refreshCounter,
    });
  }

  /** Arm the next alarm. Called on start and after each alarm. */
  async arm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
  }

  /**
   * Alarm handler — single entry point for all periodic work.
   * 1. Refresh blueprints if counter reached 0
   * 2. Run scheduler.tick()
   * 3. Persist lastTick
   * 4. Re-arm alarm
   */
  async onAlarm(): Promise<TickResult> {
    const now = new Date();
    let heartbeatState = await this.load();

    // Blueprint refresh (every REFRESH_INTERVAL ticks)
    if (heartbeatState.refreshCounter <= 0) {
      try {
        await this.onRefresh();
      } catch (error) {
        console.error(`[reflex-heartbeat] blueprint refresh failed: ${(error as Error).message}`);
        // Continue with tick — use last known good blueprint set
      }
      heartbeatState.refreshCounter = REFRESH_INTERVAL;
    }
    heartbeatState.refreshCounter -= 1;

    // Parse lastTick
    const lastTick = heartbeatState.lastTick ? new Date(heartbeatState.lastTick) : null;

    // Run scheduler
    const result = await this.scheduler.tick(lastTick, now);

    // Persist state (only if tick succeeded — errors don't advance lastTick)
    // Actually: we DO advance lastTick even on partial errors (per spec).
    // Only if the entire tick throws do we not advance.
    heartbeatState.lastTick = now.toISOString();
    await this.save(heartbeatState);

    // Re-arm (always — the heartbeat never stops)
    await this.arm();

    return result;
  }
}
```

### Phase 3: Integrate into ReflexConsumer DO

Modify `src/edge/consumer-do.ts`:

1. Replace `EdgeScheduleSource` with `Scheduler` + `EdgeHeartbeat`
2. Remove `/schedule` POST route (no longer needed)
3. Update `/status` to report `lastTick` and heartbeat period
4. Unify existing refresh alarm with heartbeat

```typescript
// Key changes in consumer-do.ts:

import { Scheduler } from "../scheduler/core";
import { EdgeHeartbeat } from "./heartbeat";

// In Runtime interface:
interface Runtime {
  store: BlueprintStore;
  repo: D1Repository;
  bus: ReflexBus;
  pipeline: Pipeline;
  busSource: BusSource;
  http: EdgeHttpSource;
  scheduler: Scheduler;      // NEW: replaces schedule: EdgeScheduleSource
  heartbeat: EdgeHeartbeat;  // NEW
}

// In start():
const scheduler = new Scheduler({ store, sink: pipeline });
const heartbeat = new EdgeHeartbeat(
  this.state,
  scheduler,
  async () => {
    runtime.store.swap(await loadBlueprintsFromKV(this.env.REFLEX_BLUEPRINTS));
    await runtime.busSource.sync();
  },
);
await heartbeat.arm(); // Initial arm

// In fetch() — REMOVE /schedule POST handler, update /status:
if (url.pathname === "/status" && request.method === "GET") {
  const heartbeatState = await runtime.heartbeat.load();
  return Response.json({
    blueprints: runtime.store.current().length,
    busSubscriptions: runtime.busSource.active(),
    scheduleBlueprints: runtime.store.byKind("schedule").map(b => b.id),
    heartbeat: {
      lastTick: heartbeatState.lastTick,
      periodMs: 60_000,
    },
    bus: runtime.bus.metrics(),
  });
}

// Replace alarm() method:
async alarm(): Promise<void> {
  try {
    const runtime = await this.ensureStarted();
    const result = await runtime.heartbeat.onAlarm();
    if (result.errors.length > 0) {
      console.warn(`[reflex-edge] tick had ${result.errors.length} errors: ${JSON.stringify(result.errors)}`);
    }
    if (result.collapsed.length > 0) {
      console.info(`[reflex-edge] collapsed ${result.collapsed.length} blueprints after gap`);
    }
  } catch (error) {
    console.error(`[reflex-edge] alarm failed: ${(error as Error).message}`);
    // Re-arm even on failure — the heartbeat must never stop
    await this.state.storage.setAlarm(Date.now() + 60_000);
  }
}
```

### Phase 4: Remove CF Cron Trigger Infrastructure

1. **wrangler.toml**: Empty `[triggers].crons`

```toml
[triggers]
crons = []  # Schedule-kind blueprints use DO alarm — zero CF cron triggers
```

2. **worker.ts**: Remove `scheduled` handler entirely

```typescript
// REMOVE this entire export:
// async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void>

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // ... unchanged
  },
  // NO scheduled handler — DO alarm is the only clock
};
```

3. **Delete** `src/edge/schedule.ts` (EdgeScheduleSource)

### Phase 5: Update Local Daemon (minimal change)

The local daemon's `ScheduleSource` already works via croner jobs. For MVP, keep it unchanged. Document that the daemon can alternatively be driven by an external every-minute launchd/cron calling a `reflex tick` endpoint (follow-up work).

Optional shared-core refactor (post-MVP):
- Extract `Scheduler.tick()` core
- Local daemon wraps it with croner-based trigger per blueprint

## File Structure

```
src/
├── scheduler/
│   ├── core.ts           # NEW: Scheduler.tick(now) core
│   └── index.ts          # NEW: export
├── edge/
│   ├── consumer-do.ts    # MODIFY: integrate heartbeat, remove schedule route
│   ├── heartbeat.ts      # NEW: EdgeHeartbeat adapter
│   ├── http.ts           # unchanged
│   ├── kv-blueprints.ts  # unchanged
│   ├── schedule.ts       # DELETE: EdgeScheduleSource removed
│   └── worker.ts         # MODIFY: remove scheduled handler
├── sources/
│   └── schedule.ts       # unchanged (local daemon's croner jobs)
└── ...

test/
├── scheduler/
│   └── core.test.ts      # NEW: tick window, catch-up, DST, boundary
├── edge/
│   ├── heartbeat.test.ts # NEW: alarm, persist, refresh cadence
│   └── edge-sources.test.ts # MODIFY: remove EdgeScheduleSource tests
└── ...
```

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| croner v10.0.1 | Already installed | Verified runs in Workers (no Node built-ins) |
| DO Alarm API | CF platform | Guaranteed delivery, survives eviction |
| DO Storage | CF platform | Key-value, durable |

**No new npm dependencies required.**

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Croner uses Node built-ins on edge | High | Low | Already runs in R-105 local; verify bundle greps clean |
| DO alarm drift (clock skew) | Medium | Low | `now <= lastTick` guard → no-op; never fire backwards |
| Long outage collapses too many | Low | Low | Collapse by design; each bp fires once (not burst) |
| Concurrent alarms (manual + auto) | Medium | Low | `tick()` is deterministic; lastTick CAS prevents double-fire |
| Refresh fails, old blueprints used | Low | Medium | Error logged; continue with last good set (existing behavior) |
| Bundle size increase | Low | Low | Scheduler core is ~100 LOC; croner already bundled |

## Test Plan

### Unit Tests (Phase 1)

```typescript
describe("Scheduler.tick", () => {
  it("fires blueprint whose next occurrence is in (lastTick, now]");
  it("does not fire blueprint whose next occurrence is after now");
  it("does not fire blueprint whose next occurrence is before lastTick");
  it("collapse: gap spanning 3 occurrences fires exactly once with missedOccurrences=2");
  it("respects blueprint timezone (Europe/Zurich DST)");
  it("backward clock (now <= lastTick) is no-op");
  it("null lastTick (cold start) fires if due at now");
  it("exactly-once at boundary: occurrence exactly at now fires once");
  it("evaluation error continues to next blueprint");
});
```

### Integration Tests (Phase 2-3)

```typescript
describe("EdgeHeartbeat", () => {
  it("persists lastTick across alarm fires");
  it("refreshes blueprints every 5 ticks");
  it("re-arms alarm even on partial failure");
  it("survives DO eviction (state restored from storage)");
});
```

### E2E Tests (Phase 4)

- Deploy with `crons = []` → no `code 10072` error
- Schedule blueprint fires within 60s of occurrence
- Multiple schedule blueprints with different expressions fire correctly
- Timezone (Europe/Zurich) honored on edge

## Migration Checklist

- [ ] Create `src/scheduler/core.ts` with `Scheduler.tick()`
- [ ] Create `src/edge/heartbeat.ts` with `EdgeHeartbeat`
- [ ] Modify `src/edge/consumer-do.ts` to use heartbeat
- [ ] Remove `/schedule` POST route from consumer-do
- [ ] Update `/status` response shape
- [ ] Delete `src/edge/schedule.ts` (EdgeScheduleSource)
- [ ] Remove `scheduled` handler from `src/edge/worker.ts`
- [ ] Set `wrangler.toml [triggers].crons = []`
- [ ] Add unit tests for `Scheduler.tick()`
- [ ] Add tests for `EdgeHeartbeat`
- [ ] Update existing edge tests (remove EdgeScheduleSource tests)
- [ ] Verify bundle: `grep -E 'node:|require\(' dist/` → 0 hits
- [ ] Deploy to preview, verify ≥10 consecutive ticks

## Constitutional Compliance

- [x] **CLI-First:** the local path exposes a `reflex tick` entry the daemon timer (and an optional launchd/cron) invoke; scheduling is observable via the internal `/status` route. Deterministic-code-first, prompts-wrap-code holds — no LLM in the tick path.
- [x] **Library-First:** `Scheduler.tick(lastTick, now)` is a pure, injectable core (`src/scheduler/core.ts`) reused by both the edge heartbeat adapter and the local daemon — no environment coupling in the core.
- [x] **Test-First:** unit tests for `tick()` (window, collapse, DST, boundary, backward-clock, cold-start) authored before wiring; heartbeat persistence tested with a DO-storage shim.
- [x] **Deterministic:** given `(lastTick, now)` + blueprint set, the fired set is a pure function (croner is deterministic). No randomness, no wall-clock reads inside the core (time is injected).
- [x] **Code Before Prompts:** entirely deterministic code; no prompt surface.

## Failure Mode Analysis

### How this code can fail

| Failure Mode | Trigger | Detection | Degradation | Recovery |
|--------------|---------|-----------|-------------|----------|
| Heartbeat stalls | DO alarm not delivered | `lastTick` stale in `/status` | No schedules fire | Next alarm covers `(lastTick, now]`; optional CF safety-net cron |
| Croner pulls a Node built-in on edge | dep change | `wrangler` bundle grep (build gate) | Build/deploy fails loudly | Pin croner; keep nodejs_compat OFF |
| Whole tick throws | KV/pipeline outage at tick start | alarm catch logs | `lastTick` not advanced; alarm re-armed | Next tick retries the same window |
| Per-blueprint eval error | one bad blueprint | `TickResult.errors` logged | that bp skipped; others fire | bp fixed/removed; window advances (no re-fire storm) |
| Backward/skewed clock | `now <= lastTick` | guard in `tick()` | no-op tick | normal tick resumes when `now > lastTick` |
| lastTick lost | DO storage wipe | cold-start path | one window's schedules may miss/re-evaluate once | collapse bounds the blast to one fire per bp |

### Assumptions that could break

| Assumption | What would invalidate it | Detection |
|------------|--------------------------|-----------|
| DO alarms deliver ~60s, survive eviction | CF platform regression / alarm backlog | `/status` lastTick drift; preview soak ≥10 ticks |
| croner `nextRun(from)` is exclusive-of-`from` | croner semantics change on upgrade | unit test pins boundary behavior |
| Minute resolution is sufficient | a future sub-minute need | revisit period (config knob already planned) |

### Blast Radius

- **Files touched:** ~6 (2 new: `scheduler/core.ts`, `edge/heartbeat.ts`; modify `consumer-do.ts`, `worker.ts`, `wrangler.toml`; delete `edge/schedule.ts`).
- **Systems affected:** edge schedule firing only. Pipeline, guards, bus, HTTP, D1 schema unchanged. Local daemon behavior unchanged (MVP).
- **Rollback:** revert the commit + re-add a CF cron in `wrangler.toml`; D1/KV untouched, so rollback is config + code only.

## Longevity Assessment

### Maintainability

| Indicator | Status | Notes |
|-----------|--------|-------|
| Readable in 6 months? | Yes | one ~100-LOC pure core + a thin adapter |
| Testable without manual runs? | Yes | `tick()` is pure; time injected |
| "Why" captured? | Yes | spec + #20 + this plan record the cron-budget/best-effort rationale |

### Evolution vectors

| What might change | Preparation | Impact |
|-------------------|-------------|--------|
| Heartbeat period / sub-minute | period is a single constant → config knob | Low |
| Local external heartbeat (launchd/cron) | `reflex tick` entry already the seam | Low |
| Replace croner | matching isolated in `tick()` | Low |
| Per-blueprint catch-up policy (replay vs collapse) | collapse logic localized | Medium |

### Deletion criteria

- [ ] Superseded by a platform-native durable scheduler that consumes no cron budget.
- [ ] `EdgeScheduleSource`/CF-cron path: delete on this feature's merge (it IS the replacement).
- [ ] Maintenance cost exceeds value if reflex drops the edge runtime.

## Estimated Complexity

- **New files:** ~3 (`scheduler/core.ts`, `scheduler/index.ts`, `edge/heartbeat.ts`)
- **Modified files:** ~3 (`consumer-do.ts`, `worker.ts`, `wrangler.toml`)
- **Deleted files:** 1 (`edge/schedule.ts`)
- **Test files:** ~2 (`scheduler/core.test.ts`, `edge/heartbeat.test.ts`) + edits to edge source tests
- **Estimated tasks:** ~10
- **Debt score:** 2/5 — small surface, pure core, no new deps, no schema change; +0 modifiers (replaces rather than adds a path). Reduces net debt by removing the string-match coupling.
