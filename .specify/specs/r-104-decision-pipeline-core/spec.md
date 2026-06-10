# Specification: R-104 Decision Pipeline Core

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §3 + `CONTEXT.md` + `meta-factory/CONTEXT.md` Activation taxonomy + ADR-0001 + grill decisions 16–18, 21. 2026-06-10.

## Problem Statement

**Core Problem:** The heart of Reflex does not exist: take an Impulse, evaluate matching Activation Blueprints, walk the pipeline (Decision → Policy → Approval gate → Guards → Activation Event), record everything, publish the event. All impulse sources (R-105/106/108/109) feed this one path; Pulse consumes its output.

**Urgency:** Center of the feature graph — R-105 through R-110 all depend on it.

## Users & Stakeholders

**Primary:** Impulse sources (callers) and Pulse (consumer of `reflex.activation.fired`). **Secondary:** Miner + operators (decision audit events + SQLite trail); approval flow (R-106) operates on Matched Decisions this pipeline parks.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | `evaluate(impulse: Impulse): Promise<DecisionResult>` — single entry point for all Impulse Kinds; selects candidate blueprints (by kind + selector match), produces exactly one Activation Decision per matching blueprint evaluation | Design §3 |
| FR-2 | Six outcomes per upstream taxonomy: Ignored (condition no match — counter only), Matched (policy=approval, parked), Blocked (guard), Fired (event emitted), Denied / Expired (resolution rows via R-106 interfaces). Matched is the only non-terminal outcome | Grill 16, ADR-0001 |
| FR-3 | Policy gate: `auto` → continue to guards; `approval` → record Matched + create `approvals(waiting)` row with `expires_at = now + approval_timeout`; `disabled` → Ignored with reason `disabled` | Design §3 |
| FR-4 | Guard order (deterministic): idempotency key → cooldown → run lock. First violation records Blocked with `guard_block_reason`; later guards not evaluated | Determinism for audit |
| FR-5 | Run Lock modes: `skip` → Blocked; `buffer` → Blocked + impulse stored as the Buffered Impulse (depth 1, newest wins) | Grill 18 |
| FR-6 | Lock release interface `onRunCompleted(correlation_id, outcome)`: clears `run_lock_holder`, then if a Buffered Impulse exists, re-presents it as a fresh evaluation (all guards re-run; new decision links via `resolution_of`-style `caused_by` to the buffering Blocked Decision) | Grill 18; called by R-108 |
| FR-7 | Fired path: build Activation Event envelope (`reflex.activation.fired`, target Execution Blueprint ref, Activation Payload = blueprint `payload:` merged with impulse payload, Idempotency Key, decision link, fresh `correlation_id`), persist `fired_events`, publish via R-101 bus; cooldown timestamp + run lock set ONLY after successful persist | Design §3/§7 |
| FR-8 | Decision audit publish: Matched/Blocked/Denied/Expired/Fired also emit `reflex.activation.decision.{outcome}` envelopes (Ignored not published) | Design §7 |
| FR-9 | Dry-run mode `evaluate(impulse, {dry: true})` returns a Dry Run Verdict: predicted outcome + reasons; ZERO writes (no decision row, no guard mutation, no counters), ZERO publishes | Grill 21 |
| FR-10 | Approval-resolution hooks consumed by R-106: `resolveMatched(decisionId, approve\|deny\|expire, reason, actor)` — on approve: guards re-checked, then fire path; on guard violation at this point: Blocked row linked to the matched row | Design §3 |
| FR-11 | Fail closed: storage write failure → no fire, no guard mutation, CRITICAL log (per R-103 disk-full policy) | R-103 FR alignment |
| FR-12 | Pipeline is transport-agnostic: depends on R-101 bus interface + R-103 repository only; fully testable on InMemory transport + temp DB | Testability |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Evaluation latency (impulse → decision recorded) | < 25ms p99 with 100 blueprints loaded |
| NFR-2 | Concurrency safety | parallel impulses for one blueprint serialize through guard check (no double-fire under race) |
| NFR-3 | Determinism | same impulse + same state → same outcome; guard order fixed |
| NFR-4 | Offline tests | `bun test` green with zero infrastructure |

## Acceptance Scenarios

**Scenario 1: Auto-fire happy path**
**Given** blueprint `daily` (policy auto, no guards) and a matching schedule impulse
**When** the pipeline evaluates it
**Then** a Fired decision row exists, a `reflex.activation.fired` envelope is published carrying target + payload + idempotency key + decision link
**And** the envelope passes myelin validation

**Scenario 2: Approval parks, approve fires**
**Given** blueprint `gate` (policy approval, timeout 1h) and a matching impulse
**When** evaluated
**Then** outcome is Matched and an approvals row waits with the right expiry
**When** `resolveMatched(id, approve, operator)` is called
**Then** guards re-run, a Fired row links the matched row, the event publishes

**Scenario 3: Cooldown blocks with named reason**
**Given** blueprint fired 10 minutes ago with `cooldown: 6h`
**When** a new impulse matches
**Then** outcome is Blocked with `guard_block_reason: cooldown` and no event publishes

**Scenario 4: Buffer holds newest, re-presents once**
**Given** blueprint with `run_lock: buffer` and an in-flight run
**When** two impulses arrive during the run
**Then** two Blocked rows record, the Buffered Impulse holds only the second
**When** `onRunCompleted` fires
**Then** exactly one fresh evaluation runs with all guards and fires (or blocks honestly)

**Scenario 5: Dry run mutates nothing**
**Given** blueprint with an active cooldown
**When** `evaluate(impulse, {dry: true})` runs
**Then** the verdict reports "would block: cooldown until T"
**And** decisions count, guard_state, counters, and the bus are all byte-identical to before

**Scenario 6: Double-fire race prevented**
**Given** policy auto, `run_lock: skip`
**When** two identical impulses evaluate concurrently
**Then** exactly one Fired and one Blocked decision result (never two Fired)

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Impulse matches zero blueprints | No decision rows; debug log only |
| Blueprint disabled mid-wait (hot-reload) | Matched resolves Expired reason `blueprint-removed` (R-102 FR-6 path) |
| Approve after expiry sweep already ran | `resolveMatched` returns conflict error; CLI shows "already expired" |
| Idempotency duplicate within window | Blocked reason `idempotency`; key TTL from window config |
| Publish fails after decision persisted (NATS down) | Fired row stands (truth: we committed); envelope rides R-101 bounded queue; queue drop is logged against the decision id |
| Guard check passes but persist fails | No event published, no guard state mutated — fail closed |
| `onRunCompleted` for unknown correlation_id | Ignored with warning (run not started by us or already cleared) |

## Success Criteria

**Definition of Done:**
- [ ] All six scenarios green as tests (InMemory transport + temp SQLite)
- [ ] Outcome taxonomy exhaustively covered: every outcome producible by a test fixture
- [ ] Guard order + first-violation-wins proven
- [ ] Race test (scenario 6) green under repetition (100 iterations)
- [ ] Dry-run zero-mutation proven byte-level (DB snapshot compare)
- [ ] Decision audit envelopes published for all non-ignored outcomes
- [ ] `bun test` offline green

## Scope

### In Scope
Evaluation engine, policy gate, guard engine, fire path, decision/audit persistence + publishing, buffer re-presentation, dry-run verdicts, resolution hooks.

### Explicitly Out of Scope
- Cron scheduling (R-105), CLI commands (R-106/107), bus subscriptions + run-outcome consumption (R-108), HTTP listener (R-109)
- Multi-rule blueprints; composed conditions
- Cancel semantics (boundary violation, rejected)

## Assumptions

- R-102 provides the live blueprint set via an interface (`getBlueprints(kind?)`)
- R-103 repository operations are atomic per call
- Approval timeout sweep cadence: R-106 owns the timer, calls `resolveMatched(…expire…)`

## Open Questions

- [ ] Idempotency window default (proposal: 10min, per DD-71 Stage-4 dedup precedent) — confirm in PLAN.
