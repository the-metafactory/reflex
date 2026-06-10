# Plan: R-105 Schedule Impulse Source (cron)

**Spec:** `spec.md` (84%) · **Date:** 2026-06-10 · **First end-to-end daemon milestone.**

## Architecture

```
src/
  sources/
    schedule.ts      # ScheduleSource — croner job per schedule-kind blueprint (FR-1..FR-7)
  daemon.ts          # startDaemon(cfg): wire config→store→watcher→repo→bus→pipeline→sources; SIGINT-clean
  bin/reflex-daemon.ts  # bun entry: loadConfig → fail-fast preconditions → startDaemon
test/sources/schedule.test.ts
test/daemon.test.ts
examples/dev/demo-schedule.yaml   # demo blueprint for the milestone walk
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `ScheduleSource.start()`: for each `store.byKind("schedule")` blueprint, `new Cron(expr, {timezone}, tick)`; tick builds `Impulse {kind: schedule, blueprintId, payload: {scheduled_for}, receivedAt, actor: {type: system, id: reflex-scheduler}}` → `pipeline.evaluate()` |
| FR-2 | `timezone` from `when.timezone` (IANA, validated at R-102); croner handles DST |
| FR-3 | Subscribes `store`-reload via `watcher.onReload`: diff current jobs vs schedule blueprints — added→create, removed→stop, changed (cron/timezone) → stop+create. Job map keyed by blueprint id; orphan check = map keys equal schedule-blueprint ids after sync |
| FR-4 | No backfill: croner schedules future ticks only by construction. On start, log per blueprint `previousRun` (croner `previousRun()` from pattern) when within the gap and `nextRun()` |
| FR-5 | Tick handler fire-and-forget into pipeline (`void evaluate().catch(log)`) — scheduler never blocks on evaluation; concurrency is the guards' job |
| FR-6 | `status()` per blueprint: `{nextTick, lastTick, lastOutcome}` — lastOutcome recorded from the evaluate result |
| FR-7 | croner accepts 5- and 6-field; README notes 5-field canonical (doc-only) |
| NFR-1 | Croner absolute scheduling; dispatch jitter test with 1s-resolution cron (integration-ish, bounded) |
| NFR-2 | Reload sync test: 100 schedule blueprints swap < 200ms |
| NFR-3 | ScheduleSource depends on Pipeline + BlueprintStore only — no NATS |
| NFR-4 | croner owns absolute times; no setInterval drift accumulation in our code |

Daemon (`startDaemon`): openDb → Repository → loadConfig surfaces → BlueprintStore + ActivationWatcher → createReflexBus → ensureReflexStream → Pipeline → ScheduleSource → approval sweep timer (30s, `repo.sweepExpiredApprovals(nowIso())` — R-106 will own richer lifecycle; the timer lands here so expiry works the moment matched decisions can exist) → store.onBlueprintsRemoved → `repo.expireForBlueprint`. Returns `{stop()}`; SIGINT/SIGTERM call stop (jobs stopped, watcher stopped, bus closed, db closed — in that order).

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| evaluate throws in tick | catch in tick wrapper | log with blueprint id; next tick unaffected | one tick |
| Invalid timezone reaches source | impossible: R-102 validates with same croner | n/a | n/a |
| Cron never fires again | croner `nextRun() === null` | status shows `nextTick: null`; job kept (config may change) | none |
| Reload storm | watcher debounce (R-102) + idempotent job diff | single resync | none |
| Daemon stop during in-flight evaluate | stop() stops jobs first; in-flight evaluate completes against closing resources — bus close drains, db close after | one evaluation may log a late error | bounded |
| Clock jump backwards | croner absolute times — no double tick | warn not needed (croner semantics) | none |

## Test Assertions (verifiability)

- `schedule.test.ts` (fake pipeline spy + real croner with seconds-cron for speed):
  - tick → spy receives Impulse with `kind: schedule`, correct blueprintId, `scheduled_for` set (scenario 1 structure, offline)
  - timezone: `nextRun` for `0 7 * * *` @ Europe/Zurich equals expected UTC instant on both sides of a DST boundary (computed via croner, asserted against Date arithmetic) (scenario 2)
  - reload sync: add/remove/change → job map matches; 50 random mutations → zero orphans (scenario 3 + spec orphan check)
  - guards-own-throttle: seconds-cron + spy pipeline asserting scheduler submits every tick (scenario 5 split: submission side here; cooldown side already proven in R-104)
  - evaluate throw → next tick still arrives (resilience)
- `daemon.test.ts`: startDaemon with memory transport + tmp DB + tmp config: starts, status reflects blueprints, stop() is clean (no leaked timers — process exits)
- Milestone (manual, verify.md): demo blueprint with `* * * * *` against live NATS → Fired decision + envelope observed

## Constitutional Compliance (commitments, verified at done gate)

CLI-First — daemon binary `bin/reflex-daemon.ts` runnable via bun; Library-First — ScheduleSource + startDaemon exported; Test-First — RED per task; Deterministic — croner absolute scheduling, injected pipeline; Code Before Prompts.

## Implementation Order (→ tasks.md)

T-1 ScheduleSource (jobs, tick→impulse) → T-2 reload sync → T-3 status surface → T-4 daemon wiring + sweep timer + signals → T-5 milestone demo + gates.

## Dependencies / Risks

R-101..R-104 merged. Risk: croner timezone edge cases — pinned by DST boundary test.
