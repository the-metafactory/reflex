# Specification: R-105 Schedule Impulse Source (cron)

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §4 + grill decision 15. 2026-06-10.

## Problem Statement

**Core Problem:** Schedule-kind blueprints (`when: { schedule: "0 7 * * *", timezone: … }`) need an Internal Impulse producer: a scheduler that ticks each blueprint's cron expression in its timezone and feeds the pipeline. First runnable daemon milestone — after this feature, a schedule rule fires a real Activation Event onto the bus.

**Urgency:** First user-visible value; unblocks R-110 example F_PR_STATS.

## Users & Stakeholders

**Primary:** Operators declaring scheduled activations. **Secondary:** Pipeline (R-104) receiving impulses; `reflex status` (R-107) showing next-fire times.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | For every schedule-kind blueprint in the live set, maintain one croner job; tick → build Internal Impulse `{kind: schedule, blueprint_id, scheduled_for, fired_at}` → `pipeline.evaluate()` | Design §4 |
| FR-2 | Timezone per blueprint (`timezone:`, default daemon-local, IANA names); DST transitions follow croner semantics | Design §5 sketch |
| FR-3 | Hot-reload integration: blueprint added → job created; removed → job cancelled; cron/timezone changed → job replaced. No orphan jobs after swap | R-102 FR-5 |
| FR-4 | No catch-up/backfill in v0: ticks missed while the daemon was down are NOT replayed; on start, log per blueprint the most recent missed tick (if any) and the next planned tick | Simplicity; activation is time-sensitive |
| FR-5 | Overlapping tick protection: if a tick's evaluation has not returned before the next tick (pathological cron like `* * * * * *`), the scheduler still submits — concurrency is governed by the blueprint's guards, not by the scheduler | Boundary: guards own concurrency |
| FR-6 | Scheduler state surface for R-107: per blueprint `{next_tick, last_tick, last_outcome}` | `reflex status`/`list` |
| FR-7 | Seconds-resolution cron accepted (croner 6-field) but documented as discouraged; standard 5-field is canonical | Operator UX |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Tick dispatch jitter (scheduled vs evaluate() called) | < 250ms p99 under 100 jobs |
| NFR-2 | Job churn on hot-reload | full swap of 100 jobs < 200ms |
| NFR-3 | Zero NATS dependency | scheduler testable with stub pipeline |
| NFR-4 | Clock discipline | uses system clock once per tick; no drift accumulation (croner absolute scheduling) |

## Acceptance Scenarios

**Scenario 1: Tick produces an Activation Event end-to-end**
**Given** a running daemon with blueprint `pr-stats-daily` (`schedule: "* * * * *"`, policy auto)
**When** the next minute boundary passes
**Then** the pipeline records a Fired decision whose impulse snapshot carries `kind: schedule` and `scheduled_for` on the minute
**And** a `reflex.activation.fired` envelope appears on the bus

**Scenario 2: Timezone honored**
**Given** blueprint with `schedule: "0 7 * * *"`, `timezone: Europe/Zurich`
**When** the scheduler computes next_tick
**Then** next_tick equals 07:00 Europe/Zurich expressed in UTC (DST-correct on both sides of a transition)

**Scenario 3: Hot-reload replaces job cleanly**
**Given** a running job for cron `0 7 * * *`
**When** config changes to `0 9 * * *`
**Then** the old job no longer ticks, the new next_tick is 09:00, and exactly one job exists for the blueprint

**Scenario 4: No backfill after downtime**
**Given** a daily 07:00 blueprint and the daemon was down 06:00–08:00
**When** the daemon starts at 08:00
**Then** no impulse is produced for the missed 07:00 tick
**And** the startup log names the missed tick and the next planned one

**Scenario 5: Guards, not scheduler, throttle pathological crons**
**Given** blueprint with seconds-cron `*/1 * * * * *` and `cooldown: 1m`
**When** 60 ticks elapse
**Then** at most one Fired decision exists and the rest are Blocked (cooldown) — scheduler submitted all ticks

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Invalid IANA timezone | Caught at R-102 validation (shared validator); scheduler never sees it |
| Cron that never fires again (past-bounded) | Job created; `next_tick: none` surfaced in status |
| System clock jumps backward (NTP) | croner absolute times: no double-tick; log warning when detected |
| evaluate() throws | Scheduler catches, logs with blueprint id, continues ticking (one bad blueprint cannot stop the scheduler) |
| 0 schedule blueprints | Scheduler idles cleanly, no busy loop |

## Success Criteria

**Definition of Done:**
- [ ] All five scenarios green (fake-clock tests for 1/2/4; real-time integration smoke for 1)
- [ ] Orphan-job check: after 50 random hot-reload mutations, job count equals schedule-blueprint count
- [ ] Status surface exposes next/last tick per blueprint
- [ ] `bun test` offline green
- [ ] **Daemon milestone:** demo script proves schedule → Fired → envelope on local NATS (first end-to-end activation)

## Scope

### In Scope
Croner job management, timezone handling, hot-reload sync, no-backfill policy, status surface, tick→impulse→pipeline wiring.

### Explicitly Out of Scope
- Catch-up/backfill semantics (post-v0 if proven need)
- State-condition polling (deferred impulse kind)
- Cron validation UX (R-102 owns validation)

## Assumptions

- croner library (design §9); fake-clock testing via croner's injectable time or bun test clock control

## Open Questions

- [ ] None blocking.
