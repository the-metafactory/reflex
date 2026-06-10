# Specification: R-108 Bus Impulse Source (Subscription + Matcher)

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §4/§7 + structure decision 10 + grill decisions 15, 18. Myelin envelopes/subjects per R-101 revision. 2026-06-10.

## Problem Statement

**Core Problem:** Bus-kind blueprints (`when: { bus: { subject, where } }`) need an External Impulse producer: subscribe to the declared subjects on the myelin bus, match envelopes against flat field-equals conditions, and feed the pipeline. Additionally, Reflex must consume run-outcome events to release Run Locks and re-present Buffered Impulses — without this, `run_lock` guards never release.

**Urgency:** Unblocks the Pilot-scan example (R-110) and completes the guard lifecycle started in R-104.

## Users & Stakeholders

**Primary:** Operators declaring event-driven activations. **Secondary:** Pipeline (impulse consumer + `onRunCompleted` callee); Pulse (its run-outcome events are consumed here — cross-component contract per pulse#27 thread).

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | For each bus-kind blueprint, maintain one durable subscription on its declared subject (myelin-derived namespace; wildcard subjects permitted) | Design §4 |
| FR-2 | Matcher: envelope passes when ALL `where:` entries equal the corresponding top-level field in the envelope payload (flat field-equals; string/number/bool; no expression language in v0) | Decision 10 |
| FR-3 | Matching envelope → External Impulse `{kind: bus, blueprint_id, payload: envelope payload, source_envelope: {id, type, correlation_id}}` → `pipeline.evaluate()`; non-matching → Ignored counter via pipeline | Design §4 |
| FR-4 | Run-outcome consumption: durable subscription on the run-lifecycle subjects Pulse publishes; terminal outcomes (succeeded/failed/cancelled/blocked) for a `correlation_id` Reflex stamped → `pipeline.onRunCompleted(correlation_id, outcome)` | Design §3, grill 18 |
| FR-5 | Subscriptions follow hot-reload: blueprint added/removed/subject-changed → subscription created/drained/replaced; zero orphan subscriptions after swap | R-102 FR-5 |
| FR-6 | Inbound envelopes validated (myelin `validateEnvelope`) before matching; invalid → rejected + counted, never crash (R-101 FR-9 path) | R-101 |
| FR-7 | Self-ignore: envelopes published by this Reflex instance (own activation/decision events) are never treated as bus impulses unless a blueprint explicitly subscribes to them — no implicit feedback loops; direct self-reference (blueprint subscribing to its own fired subject) is rejected at load with a cycle warning | Safety |
| FR-8 | Durable consumer position: after daemon restart, matching resumes from last acknowledged envelope (no missed events while down, no reprocessing of acked ones) | JetStream durability |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Match + dispatch latency (envelope received → evaluate() called) | < 15ms p99 |
| NFR-2 | Subscription churn on hot-reload | 100 blueprints swap < 1s |
| NFR-3 | Offline tests | matcher + lifecycle fully tested on InMemoryTransport |
| NFR-4 | Backpressure | slow pipeline NAKs (myelin NAK/backoff) rather than buffering unbounded in memory |

## Acceptance Scenarios

**Scenario 1: Field-equals match fires**
**Given** blueprint `pilot-scan` with `bus: { subject: <task-completed subject>, where: { flow: review } }` and policy approval
**When** an envelope with payload `{flow: "review", …}` arrives on that subject
**Then** a Matched Decision records with the envelope payload in the impulse snapshot

**Scenario 2: Non-matching field is ignored**
**Given** the same blueprint
**When** an envelope with `{flow: "deploy"}` arrives
**Then** no decision row appears and the blueprint's Ignored counter increments

**Scenario 3: Run completion releases the lock and re-presents**
**Given** blueprint with `run_lock: buffer`, an in-flight run with correlation `c1`, and a Buffered Impulse held
**When** a terminal run-outcome envelope for `c1` arrives
**Then** the Run Lock clears, the Buffered Impulse re-presents, and exactly one fresh decision records

**Scenario 4: Restart loses nothing**
**Given** a durable subscription and the daemon stopped
**When** three matching envelopes are published during downtime and the daemon restarts
**Then** all three are evaluated exactly once (positions resume, acks respected)

**Scenario 5: Self-subscription rejected**
**Given** a blueprint whose `bus.subject` equals its own fired-event subject
**When** config loads
**Then** load fails with a cycle error naming the blueprint

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| `where:` references field absent from payload | No match (absent ≠ equal); debug log notes the missing field once per blueprint |
| Nested field in `where:` (`a.b`) | Validation error at R-102: flat fields only in v0, error says so |
| Run outcome for unknown correlation_id | Forwarded to pipeline; warning logged there (R-104 edge) |
| Duplicate delivery (JetStream redelivery) | evaluate() reached at-least-once; double-fire prevented by idempotency guard (R-104) — documented interplay |
| Wildcard subject matching huge traffic | NAK backpressure + match-rate metric; operator sees it in `reflex status` |
| Pulse not yet publishing run outcomes | Locks held until timeout? NO — v0: lock holds indefinitely, `reflex status` surfaces stale locks (age); documented operational note pending pulse#27 |

## Success Criteria

**Definition of Done:**
- [ ] All five scenarios green on InMemoryTransport; scenario 4 additionally on live NATS integration
- [ ] Matcher property test: random payloads × random where-maps — match iff all fields equal
- [ ] Orphan-subscription check after random hot-reload mutations
- [ ] At-least-once + idempotency interplay test (forced redelivery → one Fired)
- [ ] Stale-lock visibility in status surface
- [ ] `bun test` offline green

## Scope

### In Scope
Per-blueprint subscriptions, flat field-equals matcher, bus→impulse construction, run-outcome consumption + lock release wiring, hot-reload sync, self-cycle rejection.

### Explicitly Out of Scope
- Expression languages (JSONPath/CEL — rejected for v0, decision 10)
- Cross-network subjects (federation later)
- Pulse's side of run-outcome publishing (pulse#27)

## Assumptions

- Pulse run-outcome subjects/types resolved in PLAN against myelin lifecycle vocabulary + pulse#27 (P-503)
- Run Lock stale-age threshold for status display: 24h default

## Open Questions

- [ ] Exact run-outcome subject filter — depends on pulse#27 resolution; stub behind an interface so only the subject string changes.
