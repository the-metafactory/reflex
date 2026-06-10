# Plan: R-108 Bus Impulse Source (Subscription + Matcher)

**Spec:** `spec.md` (80%) · **Date:** 2026-06-10 · **Completes the guard lifecycle**: run-outcome consumption releases Run Locks and re-presents Buffered Impulses (pipeline side shipped in R-104; this wires the bus side).

## Architecture

```
src/
  sources/
    bus.ts          # BusSource: per-blueprint subscriptions + matcher + run-outcome consumer (FR-1..FR-8)
    run-outcome.ts  # runOutcomeSubject(cfg) + terminal-outcome detection — the ONLY place the pulse contract lives (pulse#27 stub boundary)
  daemon.ts         # wires BusSource (start/stop/sync via watcher), stale-lock surface in status (router)
test/sources/bus.test.ts  test/sources/run-outcome.test.ts
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `BusSource.sync()`: one durable subscription per bus-kind blueprint (`durableName: reflex-bus-{blueprintId}`, deliverPolicy new, ackPolicy explicit) on its declared subject; wildcards permitted |
| FR-2 | `matches(where, payload)`: ALL entries strict-equal top-level payload fields (string/number/boolean); absent field = no match (debug-logged once per blueprint via Set) |
| FR-3 | Match → Impulse `{kind: bus, blueprintId, payload: envelope.payload, sourceEnvelope: {id, type, correlationId}}` → `pipeline.evaluate()`; non-match → `repo.bumpIgnored` via pipeline no-match path? NO — matcher pre-filters: non-matching envelopes increment a per-blueprint ignored counter directly (pipeline only sees matches; spec scenario 2) |
| FR-4 | `run-outcome.ts`: subscribes `runOutcomeSubject(cfg)` (default `local.{p}.{s}.pulse.run.>`); envelope types ending in terminal outcomes (`succeeded\|failed\|cancelled\|blocked`) with a `correlation_id` → `pipeline.onRunCompleted(correlationId, outcome)`. The subject + type-detection live in ONE module — pulse#27 resolution changes only this file |
| FR-5 | Hot-reload: watcher.onReload → `sync()` — added/removed/subject-changed subscriptions reconciled; orphan check = subscription keys equal bus-blueprint ids |
| FR-6 | Inbound validation = R-101 bus layer (already validates envelopes before handlers) |
| FR-7 | Self-cycle rejection: at sync, a blueprint whose subject pattern matches the daemon's own fired subject (`subjectMatchesPattern` from myelin) is SKIPPED with a loud error listing the cycle — no subscription created. (Load-time rejection would put bus knowledge in R-102's transport-free loader — boundary kept clean; sync-time is where subjects exist) |
| FR-8 | Durable consumers resume from last ack (JetStream; InMemory tests assert at-least-once dispatch; live durability covered by R-101 integration precedent) |
| NFR-1 | Match+dispatch perf test: 100 envelopes through matcher < 1.5s InMemory |
| NFR-2 | Sync churn: 100 blueprints swap < 1s |
| NFR-3 | All offline (InMemory) |
| NFR-4 | Backpressure = myelin NAK policy (bus layer); not re-implemented |

Stale-lock visibility (spec edge): router `status` gains `staleLocks: [{blueprintId, holder, since}]` for locks older than 24h — operators see locks that never released (pulse not yet publishing outcomes).

## Data Flow

```
external envelope ──► BusSource subscription ──► matcher (where field-equals)
                                                   ├─ match → Impulse{kind: bus} → pipeline.evaluate
                                                   └─ no match → ignored counter (per blueprint)
pulse run-outcome envelope ──► run-outcome consumer ──► pipeline.onRunCompleted(correlationId, outcome)
                                                          └─ lock release + Buffered Impulse re-presentation (R-104, proven)
```

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| evaluate throws on matched envelope | catch in handler wrapper | log + continue (bus layer containment) | one envelope |
| run outcome for unknown correlation | R-104 warn no-op (proven) | none needed | none |
| duplicate delivery (JetStream redelivery) | at-least-once reaches evaluate | idempotency guard blocks duplicate fire (R-104 proven; interplay test here) | none |
| blueprint subscribes own fired subject | sync-time pattern check | skipped + loud error naming the cycle | that blueprint inert |
| pulse never publishes outcomes | stale-lock age | status surfaces staleLocks >24h | observability |
| wildcard subject floods | per-blueprint match-rate via ignored counters | visible in counters; NAK backpressure upstream | bounded |
| subscription fails to arm (bad subject at runtime) | subscribe rejection at sync | error logged naming blueprint; other subscriptions unaffected | one blueprint |

## Test Assertions (verifiability)

- scenario 1: matching envelope (`where {flow: review}`) → Matched Decision with envelope payload + sourceEnvelope correlation in snapshot.
- scenario 2: non-matching (`flow: deploy`) → no decision row, ignored counter incremented.
- scenario 3: full lifecycle — fired with `run_lock: buffer`, 2nd envelope buffered, synthetic pulse outcome envelope for the stamped correlation → lock released, exactly one re-presented decision (InMemory end-to-end).
- scenario 5: self-subscription (subject == own fired subject, incl. wildcard overlap) → sync skips + error contains blueprint id; subscription count excludes it.
- matcher property test: 200 random (payload, where) pairs — match iff every where-entry strict-equals.
- redelivery interplay: same envelope dispatched twice → one Fired + one Blocked(idempotency).
- orphan-free sync after 50 random mutations; terminal-type detection table-driven in run-outcome.test.

## Constitutional Compliance (commitments, verified at done gate)

Library-First — BusSource module-level; Test-First — RED per task; Deterministic — matcher pure, injected pipeline; CLI-First — n/a (visibility via status); Code Before Prompts.

## Implementation Order (→ tasks.md)

T-1 matcher (pure) → T-2 BusSource subscriptions + sync + self-cycle guard → T-3 run-outcome module → T-4 daemon wiring + stale-lock status → T-5 lifecycle e2e + perf + gates.

## Dependencies / Risks

All deps merged. Risk: pulse#27 contract unknown — isolated to `run-outcome.ts` (subject string + type suffixes), interface stable.
