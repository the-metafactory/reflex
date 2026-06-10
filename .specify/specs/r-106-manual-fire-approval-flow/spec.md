# Specification: R-106 Manual Fire + Approval Flow

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §3/§8 + grill decisions 16–17 + upstream taxonomy (Denied/Expired Decisions, Approver). 2026-06-10.

## Problem Statement

**Core Problem:** Two human-facing halves of the pipeline are missing: (1) producing a `manual`-kind Impulse from an operator command (`reflex fire`) that goes through the FULL pipeline — no bypass exists by design; (2) the approval lifecycle that resolves Matched Decisions: approve → fire, deny → Denied Decision, timeout sweep → Expired Decision.

**Urgency:** Approval is in the v0 critical path (design decision #3: full pipeline including approval); manual fire is needed for R-110's F_TESTING example and day-1 operability.

## Users & Stakeholders

**Primary:** The operator (single-operator trust in v0 — anyone with the network's NATS creds is an Approver). **Secondary:** Pipeline (R-104 resolution hooks); CLI transport (R-107 carries these commands); audit consumers.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Daemon-side `fire` handler: builds Impulse `{kind: manual, blueprint_id, payload: parsed --input JSON, actor: {type: operator, id}}` → `pipeline.evaluate()`; returns the resulting decision (id + outcome + reason) synchronously to the caller | Grill 17 |
| FR-2 | Manual impulses receive NO special treatment: policy and all guards apply; a manual fire into a held Run Lock blocks/buffers exactly like any impulse | Grill 17 (no bypass) |
| FR-3 | `approve <decision-id>` handler: validates the decision is a waiting Matched Decision, then `pipeline.resolveMatched(id, approve, actor)`; response includes final outcome (fired, or blocked-at-approval with guard reason) | Design §3 FR-10 |
| FR-4 | `deny <decision-id>` handler: resolves to Denied Decision with `actor`; idempotent error if already resolved | Upstream taxonomy |
| FR-5 | Expiry sweep: interval timer (30s) resolves all `approvals.waiting` rows past `expires_at` to Expired Decisions reason `timeout`; also exposes `expireForBlueprint(blueprint_id, reason: blueprint-removed)` consumed by R-102 hot-reload | Design §3, R-102 FR-6 |
| FR-6 | `pending` handler: lists waiting Matched Decisions (id, blueprint, matched_at, expires_at, impulse summary) — newest first | Design §8 |
| FR-7 | All resolutions record `actor` and publish the corresponding `reflex.activation.decision.{outcome}` audit envelope (via R-104) | Audit completeness |
| FR-8 | Race safety: approve vs sweep vs deny on the same decision — exactly one wins (storage-level conditional transition), losers get a conflict result naming the actual final state | Correctness |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | fire command round trip (handler side) | < 100ms p99 excluding transport |
| NFR-2 | Sweep accuracy | a decision expires within 60s of its `expires_at` (30s interval + margin) |
| NFR-3 | Offline testability | full lifecycle testable with stub transport + temp DB |

## Acceptance Scenarios

**Scenario 1: Manual fire goes through the whole pipeline**
**Given** blueprint `f-testing` (policy auto, `cooldown: 6h`) last fired 1h ago
**When** the operator fires it manually
**Then** the response reports Blocked with reason `cooldown` and the block is recorded — the manual path bypassed nothing

**Scenario 2: Approve converts and fires**
**Given** a waiting Matched Decision for blueprint `gate`
**When** `approve <id>` arrives
**Then** guards re-run, a Fired decision links the matched row, the Activation Event publishes
**And** the approvals row reads `approved` with the operator as actor

**Scenario 3: Deny is terminal**
**Given** the same waiting Matched Decision
**When** `deny <id>` arrives
**Then** a Denied Decision resolution records with actor
**And** a later `approve <id>` returns a conflict naming the denied state

**Scenario 4: Timeout sweep expires honestly**
**Given** a Matched Decision with `approval_timeout: 1m`
**When** 2 minutes pass with no operator action
**Then** the sweep resolves it to an Expired Decision reason `timeout`
**And** `pending` no longer lists it

**Scenario 5: Approve/sweep race has one winner**
**Given** a Matched Decision exactly at its expiry instant
**When** approve and the sweep execute concurrently
**Then** exactly one resolution row exists; the loser receives a conflict result

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| fire on unknown blueprint id | Error listing nearest matching loaded ids |
| fire with malformed `--input` JSON | Error before any impulse is produced |
| approve on a Fired/Denied/Expired id | Conflict error naming current state |
| approve passes policy but cooldown engaged since match | Blocked row linked to matched row; operator sees guard reason (per R-104 FR-10) |
| Daemon restart with sweep due | Sweep runs at startup before interval begins — no immortal waiting rows |
| Blueprint removed while decision waiting | Expired reason `blueprint-removed` (R-102 integration) |

## Success Criteria

**Definition of Done:**
- [ ] All five scenarios green (fake clock for sweep tests)
- [ ] Race test: 100 concurrent approve/deny/sweep rounds → exactly one resolution each
- [ ] Conflict responses name the actual final state in every losing path
- [ ] Audit envelope published for every resolution outcome
- [ ] Startup sweep proven (restart test with past-due waiting row)
- [ ] `bun test` offline green

## Scope

### In Scope
fire/approve/deny/pending daemon handlers, expiry sweep, blueprint-removed expiry interface, race-safe resolution, actor recording.

### Explicitly Out of Scope
- CLI argument parsing + NATS request/reply transport (R-107 — handlers here are transport-agnostic functions)
- Multi-approver, roles, Cortex approval UI
- Notification of pending approvals (post-v0; Grove relay territory)

## Assumptions

- Actor identity in v0 = `{type: operator, id: <network creds user or $USER>}` — refined when Cortex arrives
- R-103 provides conditional state transition for approvals (compare-and-set)

## Open Questions

- [ ] None blocking.
