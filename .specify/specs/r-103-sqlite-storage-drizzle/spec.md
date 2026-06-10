# Specification: R-103 SQLite Storage (Drizzle)

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §6 + ADR-0001 (immutable Activation Decisions) + grill decisions 16, 18, 21. 2026-06-10.

## Problem Statement

**Core Problem:** The daemon needs durable state: every Activation Decision (the audit trail Miner and operators rely on), the approval lifecycle, guard state (cooldowns, run locks, buffered impulses, idempotency keys), and fired-event records for `reflex history` and buffer re-presentation. Restart must lose nothing: pending approvals, active cooldowns, and the buffered impulse must survive.

**Urgency:** Blocks R-104 — the decision model shapes storage; retrofitting an audit trail later is the expensive path (design decision #3).

## Users & Stakeholders

**Primary:** Decision pipeline (R-104) and approval flow (R-106) as writers; CLI history/pending (R-107) as reader. **Secondary:** Operators inspecting `reflex.db` directly; Miner (via published decision events, not via this DB).

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Drizzle ORM over `bun:sqlite`, single DB file at `~/.local/state/reflex/reflex.db` (XDG_STATE_HOME respected), WAL mode | Design §6, stack prefs |
| FR-2 | `decisions` table: id (ULID), blueprint_id, outcome (`ignored\|matched\|blocked\|fired\|denied\|expired`), impulse snapshot (JSON: kind, payload, received_at), guard_block_reason?, resolution_of? (decision id this resolves — for fired/denied/expired rows resolving a matched row), correlation_id?, created_at. **No UPDATE path on outcome — append-only (ADR-0001)** | ADR-0001, grill 16 |
| FR-3 | Matched→terminal resolution modeled as a NEW row (`resolution_of` links it) plus `approvals` state transition — never an UPDATE of the matched row | ADR-0001 |
| FR-4 | `approvals` table: decision_id (the matched row), state (`waiting\|approved\|denied\|expired`), reason? (`timeout\|blueprint-removed\|operator`), actor?, expires_at, decided_at? | Design §6, R-106 |
| FR-5 | `guard_state` table: blueprint_id, cooldown_until?, run_lock_holder? (correlation_id of in-flight run), buffered_impulse? (JSON, max one per blueprint), idempotency keys (key, expires_at) | Design §6, grill 18 |
| FR-6 | `fired_events` table: decision_id, envelope_id, correlation_id, subject, published_at — feeds `reflex history` and run-outcome matching | Design §6 |
| FR-7 | `ignored_counters` table: blueprint_id, day, count — Ignored Decisions aggregate here, NOT as decision rows | Design §6 |
| FR-8 | Migrations via drizzle-kit, run automatically at daemon start; schema version recorded; refuse to start on failed migration | Operational safety |
| FR-9 | Repository module exposes typed operations only (recordDecision, resolveMatched, upsertGuardState, takeBufferedImpulse, sweepExpired…) — no raw SQL outside it | Maintainability |
| FR-10 | All timestamps UTC ISO-8601; durations stored as ms integers | Consistency |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Decision insert latency | < 5ms p99 |
| NFR-2 | History query (last 100 by blueprint) | < 20ms |
| NFR-3 | DB size discipline | scheduler ticks produce counter updates, not rows; 30 days of a 1-min schedule ≈ rows only for real matches |
| NFR-4 | Crash safety | WAL; daemon kill -9 between decision write and event publish leaves consistent DB (publish is retried/reconciled by R-104, not by storage) |

## Acceptance Scenarios

**Scenario 1: Decision rows are append-only**
**Given** a Matched Decision row exists
**When** the operator approves it and the pipeline fires
**Then** a new `fired` decision row is inserted with `resolution_of` = matched row id
**And** the matched row's outcome column is byte-identical to before (no UPDATE occurred)

**Scenario 2: Restart preserves waiting state**
**Given** a Matched Decision awaiting approval, an active cooldown, and a Buffered Impulse
**When** the daemon restarts
**Then** `reflex pending` still lists the Matched Decision
**And** the cooldown still blocks until its original expiry
**And** the Buffered Impulse is still held (exactly one)

**Scenario 3: Ignored evaluations never bloat the table**
**Given** a schedule blueprint whose rule ignores 1440 ticks/day
**When** a day passes
**Then** `decisions` gains zero ignored rows and `ignored_counters` shows the aggregate

**Scenario 4: Migration gate**
**Given** a DB at an older schema version
**When** the daemon starts
**Then** migrations run before any subsystem touches the DB; on migration failure the daemon exits non-zero naming the failed migration

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Second buffered impulse for same blueprint | Replaces existing (newest wins, depth 1) — enforced by unique constraint + upsert |
| Idempotency key expiry | `sweepExpired` purges past-TTL keys; sweep cadence owned by R-104 |
| DB file missing at start | Created + migrated from zero; not an error |
| DB locked by stray process | Startup error names the path + suggests checking for another daemon instance |
| Disk full on insert | Error propagates to pipeline; daemon logs CRITICAL and continues serving reads (decisions cannot be recorded → pipeline refuses to fire — fail closed) |
| Clock skew | All comparisons against DB-read monotonic-safe UTC now; no wall-clock arithmetic in SQL |

## Success Criteria

**Definition of Done:**
- [ ] All six tables created via migrations; drizzle-kit generate is clean
- [ ] Append-only proven: no code path issues UPDATE on `decisions.outcome` (grep + runtime test)
- [ ] Restart-preservation scenario green (test harness restarts repo layer)
- [ ] Buffered-impulse depth-1 constraint proven under concurrent upserts
- [ ] Fail-closed on insert failure proven (injected disk error → pipeline refuses fire)
- [ ] `bun test` offline green

## Scope

### In Scope
Schema, migrations, repository module, sweep operations, WAL config, XDG path resolution.

### Explicitly Out of Scope
- Outbox/replay for publishes (R-101 bounded queue is the v0 policy)
- Retention/pruning of old decisions (post-v0; table designed so DELETE by created_at works)
- Any NATS interaction

## Assumptions

- Single daemon process per DB file (run lock at OS level out of scope; DB lock error covers the accident case)
- ULIDs generated by the shared util from R-101

## Open Questions

- [ ] None blocking.
