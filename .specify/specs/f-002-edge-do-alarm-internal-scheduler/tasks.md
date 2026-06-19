# Implementation Tasks: Edge DO-alarm internal scheduler

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☑ | `src/scheduler/core.ts` + `index.ts` types |
| T-1.2 | ☑ | `Scheduler.tick()`; 9 unit tests green |
| T-2.1 | ☑ | `src/edge/heartbeat.ts` EdgeHeartbeat |
| T-2.2 | ☑ | `onAlarm()`; 4 tests green |
| T-3.1 | ☑ | wired into ReflexConsumer DO |
| T-3.2 | ☑ | removed `/schedule` POST route |
| T-3.3 | ☑ | `/status` → scheduleBlueprints + heartbeat |
| T-4.1 | ☑ | removed `scheduled` handler (worker.ts) |
| T-4.2 | ☑ | `wrangler.toml [triggers].crons = []` |
| T-4.3 | ☑ | deleted `src/edge/schedule.ts` |
| T-4.4 | ☑ | edge-sources tests updated; suite green (236) |
| T-5.1 | ☑ | bundle Node-free (dry-run grep clean) |
| T-5.2 | ☑ | live: crons=[], DO-alarm fired */1 schedule → 5 Matched Decisions ~60s apart, 0 CF crons |

---

## Group 1: Scheduler Core

### T-1.1: Create Scheduler types and interfaces [T]
- **File:** `src/scheduler/core.ts`
- **Test:** `test/scheduler/core.test.ts`
- **Dependencies:** none
- **Description:** Define `SchedulerState`, `TickResult`, `SchedulerSink`, and `SchedulerOptions` interfaces. Export module via `src/scheduler/index.ts`.

**Acceptance:**
- Interfaces match technical plan exactly
- Export barrel file created
- Types compile with no errors

---

### T-1.2: Implement Scheduler.tick() core [T]
- **File:** `src/scheduler/core.ts`
- **Test:** `test/scheduler/core.test.ts`
- **Dependencies:** T-1.1
- **Description:** Pure `tick(lastTick, now)` that evaluates schedule-kind blueprints using croner. Implements:
  - `(lastTick, now]` half-open window
  - Collapse catch-up (multiple missed occurrences → fire once)
  - Blueprint timezone via croner `{ timezone }`
  - Backward clock guard (`now <= lastTick` → no-op)
  - Cold start (`lastTick = null` → fire if due at now)
  - Per-blueprint error isolation (continue to next on failure)

**Test cases (9 total):**
1. fires blueprint whose next occurrence is in (lastTick, now]
2. does not fire blueprint whose next occurrence is after now
3. does not fire blueprint whose next occurrence is before lastTick
4. collapse: gap spanning 3 occurrences fires exactly once with missedOccurrences=2
5. respects blueprint timezone (Europe/Zurich DST)
6. backward clock (now <= lastTick) is no-op
7. null lastTick (cold start) fires if due at now
8. exactly-once at boundary: occurrence exactly at now fires once
9. evaluation error continues to next blueprint

---

## Group 2: Edge Heartbeat Adapter

### T-2.1: Create EdgeHeartbeat adapter [T]
- **File:** `src/edge/heartbeat.ts`
- **Test:** `test/edge/heartbeat.test.ts`
- **Dependencies:** T-1.2
- **Description:** DO alarm wrapper managing:
  - `load()` / `save()` for `lastTick` and `refreshCounter` in DO storage
  - `arm()` schedules next alarm at `Date.now() + 60_000`
  - Refresh cadence constant `REFRESH_INTERVAL = 5` (5 min)
  - Alarm period constant `ALARM_PERIOD_MS = 60_000`

**Acceptance:**
- Storage keys: `scheduler:lastTick`, `scheduler:refreshCounter`
- HeartbeatState interface defined
- Methods typed for DurableObjectState

---

### T-2.2: Implement EdgeHeartbeat.onAlarm() [T] [P with T-2.1 tests]
- **File:** `src/edge/heartbeat.ts`
- **Test:** `test/edge/heartbeat.test.ts`
- **Dependencies:** T-2.1
- **Description:** Alarm handler orchestrating:
  1. Load state from storage
  2. Refresh blueprints if `refreshCounter <= 0` (reset to 5)
  3. Decrement refreshCounter
  4. Call `scheduler.tick(lastTick, now)`
  5. Persist updated state
  6. Re-arm alarm (always — never stops)

**Test cases (4 total):**
1. persists lastTick across alarm fires
2. refreshes blueprints every 5 ticks
3. re-arms alarm even on partial failure
4. survives DO eviction (state restored from storage)

---

## Group 3: DO Integration

### T-3.1: Wire Scheduler + EdgeHeartbeat into ReflexConsumer DO
- **File:** `src/edge/consumer-do.ts`
- **Test:** `test/edge/edge-sources.test.ts` (modify existing)
- **Dependencies:** T-2.2
- **Description:** 
  - Add `scheduler: Scheduler` and `heartbeat: EdgeHeartbeat` to Runtime interface
  - In `start()`: instantiate Scheduler with store+pipeline sink, instantiate EdgeHeartbeat with state+scheduler+refresh callback
  - Call `heartbeat.arm()` for initial arm
  - Replace `alarm()` method body to call `runtime.heartbeat.onAlarm()`
  - Add error catch that re-arms even on failure

**Breaking changes:** Runtime interface changes (internal only)

---

### T-3.2: Remove /schedule POST route
- **File:** `src/edge/consumer-do.ts`
- **Test:** `test/edge/edge-sources.test.ts` (remove related tests)
- **Dependencies:** T-3.1
- **Description:** Delete the `/schedule` POST handler from `fetch()`. Route is obsolete — DO alarm replaces CF cron trigger.

---

### T-3.3: Update /status response shape
- **File:** `src/edge/consumer-do.ts`
- **Test:** `test/edge/edge-sources.test.ts`
- **Dependencies:** T-3.1
- **Description:** Replace `scheduleExpressions` / `unmatchedExpressions` with:
```typescript
heartbeat: {
  lastTick: string | null;
  periodMs: 60_000;
}
```
Keep `scheduleBlueprints` as array of blueprint IDs.

---

## Group 4: Cleanup & Removal

### T-4.1: Remove scheduled handler from worker.ts [P with T-4.2]
- **File:** `src/edge/worker.ts`
- **Dependencies:** T-3.2
- **Description:** Delete the `scheduled(controller, env, ctx)` export. The Worker no longer needs a `scheduled` handler — DO alarm is the only clock.

---

### T-4.2: Empty wrangler.toml crons [P with T-4.1]
- **File:** `wrangler.toml`
- **Dependencies:** T-3.2
- **Description:** Set `[triggers].crons = []` with comment explaining DO alarm is used.

```toml
[triggers]
crons = []  # Schedule-kind blueprints use DO alarm — zero CF cron triggers
```

---

### T-4.3: Delete EdgeScheduleSource
- **File:** `src/edge/schedule.ts` (DELETE)
- **Dependencies:** T-4.1
- **Description:** Remove `src/edge/schedule.ts` entirely. The expression→blueprint string-match mapping is replaced by Scheduler.tick() core.

---

### T-4.4: Update edge-sources tests
- **File:** `test/edge/edge-sources.test.ts`
- **Dependencies:** T-4.3
- **Description:** Remove all `EdgeScheduleSource` tests. Add tests for new `/status` shape if not covered in T-3.3.

---

## Group 5: Verification

### T-5.1: Bundle verification
- **File:** (none — verification task)
- **Dependencies:** T-4.3
- **Description:** Run `bun run build && grep -rE 'node:|require\(' dist/` — expect 0 hits. Confirms croner runs without Node built-ins in Workers bundle.

---

### T-5.2: E2E verification — deploy + 10 ticks
- **File:** (none — verification task)
- **Dependencies:** T-5.1
- **Description:** 
  1. Deploy to preview environment
  2. Create schedule blueprint (e.g., `*/1 * * * *`)
  3. Observe ≥10 consecutive alarm fires via `wrangler tail`
  4. Verify Decision rows created in D1
  5. Confirm `code 10072` (cron cap) does NOT occur

**Success criteria:**
- Zero CF cron triggers consumed
- Schedule blueprint fires within 60s of occurrence
- Timezone honored on edge

---

## Execution Order

```
T-1.1 (types, no deps)
  │
  └─► T-1.2 (core tick logic)
        │
        └─► T-2.1 (heartbeat adapter)
              │
              ├─► T-2.2 (onAlarm handler) [can parallelize tests with T-2.1]
              │
              └─► T-3.1 (wire into DO)
                    │
                    ├─► T-3.2 (remove /schedule route)
                    │     │
                    │     └─► T-4.1 (remove scheduled handler)  ──┐
                    │                                              ├─► T-4.3 (delete EdgeScheduleSource)
                    │     └─► T-4.2 (empty wrangler crons) ───────┘         │
                    │                                                        │
                    └─► T-3.3 (update /status)                               │
                                                                             │
                                                               T-4.4 (update tests) ◄─┘
                                                                             │
                                                               T-5.1 (bundle verify) ◄─┘
                                                                             │
                                                               T-5.2 (E2E verify) ◄─┘
```

## Parallelization Notes

- **T-4.1 + T-4.2:** Independent cleanup, can run simultaneously
- **T-2.1 tests + T-2.2 implementation:** Write tests for T-2.1 while implementing T-2.2
- **T-3.2 + T-3.3:** Both modify consumer-do but different sections — can sequence quickly or do together

## Estimated Effort

| Group | Tasks | Complexity |
|-------|-------|------------|
| 1: Scheduler Core | T-1.1, T-1.2 | Medium — ~100 LOC + 9 unit tests |
| 2: Heartbeat | T-2.1, T-2.2 | Medium — ~80 LOC + 4 tests |
| 3: DO Integration | T-3.1, T-3.2, T-3.3 | Medium — wiring + route changes |
| 4: Cleanup | T-4.1–T-4.4 | Low — deletions, config |
| 5: Verification | T-5.1, T-5.2 | Low — commands, observation |

**Total: 13 tasks, 4 parallelizable**
