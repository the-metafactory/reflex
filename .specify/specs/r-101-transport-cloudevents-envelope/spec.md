# Specification: R-101 Myelin Transport Integration

## Context

> Interview 2026-06-10 (2 rounds) + autonomous revision after operator direction to reuse myelin. Sources: `docs/design-reflex-v0.md` §7/§9, `@the-metafactory/myelin` v0.4.x (transport layer, envelope, subjects, request-reply), DD-72 (NATS accounts), `myelin/specs/namespace.md`. **Supersedes** the earlier CloudEvents/DD-68 framing of this feature: cortex, grove, sage, and pilot all ship on myelin envelopes; myelin is the de-facto ecosystem wire standard.

## Problem Statement

**Core Problem:** Every downstream Reflex feature (decision pipeline R-104, CLI R-107, bus impulses R-108) needs publish/subscribe, request/reply, and a validated envelope. Building a reflex-local transport (original plan) would duplicate `@the-metafactory/myelin`, which already provides `NATSTransport` (incl. `ensureStream`, NAK/backoff, dead-letter, credentials handling), `InMemoryTransport`, request-reply, `MyelinEnvelope` validation, and subject derivation — and is already consumed by cortex, grove, sage, and pilot.

**Urgency:** Blocking — root of the Reflex feature graph.

**Decision:** Reflex consumes myelin (git-pinned dependency, same pattern as cortex/grove). No reflex-local transport implementation.

## Users & Stakeholders

**Primary:** Reflex's own subsystems (decision pipeline, CLI handler, impulse sources).
**Secondary:** Pulse (subscribes to Reflex activation subjects — pulse#27 must be updated from the CloudEvents framing); Miner (decision audit events); other myelin peers on the principal's stack.

## Current State

Greenfield repo (design docs + blueprint only). Myelin v0.4.x available at `github.com/the-metafactory/myelin` (git-pinned in cortex `f5ec865…`, grove `2cdf3b0…`). No transport code exists in pulse (P-500 unimplemented — verified). NATS account credentials per DD-72 at `~/.config/nats/creds/reflex.creds`.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Add `@the-metafactory/myelin` as git-pinned dependency; create `src/bus/` wrapper exposing exactly the operations Reflex needs (publish envelope, subscribe, request/reply, close) — no parallel abstraction layer | Operator direction; cortex/grove precedent |
| FR-2 | All Reflex events are `MyelinEnvelope`s: `type` `reflex.activation.fired` and `reflex.activation.decision.{outcome}`, `source` identifying this Reflex instance per myelin source rules, `sovereignty.classification: "local"` by default | Myelin types.ts; design doc §7 |
| FR-3 | Subjects derived via myelin `deriveNatsSubject(envelope)` — never hand-built strings. The literal `mf.{net}.reflex.activation.>` hierarchy from the design doc is superseded; consumption wildcards documented from the derived form | Pilot precedent (`publish-review-request.ts`) |
| FR-4 | Decision↔event↔run tracing: `correlation_id` (myelin first-class) carries the activation chain; causation and actor identity ride `extensions.causation_id` / `extensions.actor` (`{type: operator\|agent\|system, id}`) | Interview Q3, remapped from mf* fields |
| FR-5 | Daemon startup ensures the Reflex JetStream stream idempotently via myelin `NATSTransport.ensureStream` (subjects = derived Reflex subject prefix wildcard) | Interview Q2 |
| FR-6 | Configuration: `~/.config/reflex/config.yaml` (`principal`/network identity, `nats.url`, `nats.creds`) with `REFLEX_*` env overrides (env wins) | Interview round 2 |
| FR-7 | Startup failure: NATS unreachable, creds missing/invalid, or JetStream disabled → actionable error naming the failing precondition, exit non-zero (fail fast) | Interview Q4 |
| FR-8 | Mid-run disconnect: rely on myelin/NATS client reconnect; outbound publishes during disconnect queue in a bounded ring buffer (1000), overflow drops oldest with loud log + dropped counter | Interview Q4 + round 2 |
| FR-9 | Inbound envelope validation via myelin `validateEnvelope`; malformed → reject before handler callback, log, count — never crash the subscriber | Myelin envelope module |
| FR-10 | Bus metrics: published, received, reconnects, queued, dropped, last-publish-at — polling interface consumed later by `reflex status` (R-107) | P-501 precedent |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | `bun test` fully offline via myelin `InMemoryTransport` | < 30s, zero external processes |
| NFR-2 | `bun test:integration` against local `nats-server` (auto-skip with notice when absent) | stream ensure, publish round-trip, reconnect resume |
| NFR-3 | Reconnect after partition | < 5s to resume |
| NFR-4 | Envelope build + publish overhead | < 5ms p99 local |
| NFR-5 | Wrapper discipline: `src/bus/` re-exposes myelin; adds no second abstraction | wrapper ≤ ~150 lines |

## Acceptance Scenarios

**Scenario 1: Publish an Activation Event**
**Given** the daemon is connected to local NATS with valid reflex creds
**When** a `reflex.activation.fired` envelope is published through `src/bus/`
**Then** a durable JetStream consumer on the derived Reflex subject receives it
**And** the received envelope passes `validateEnvelope` and `validateSubjectEnvelopeAlignment`
**And** `correlation_id` round-trips unchanged

**Scenario 2: Fail fast on missing credentials**
**Given** `nats.creds` points to a non-existent file
**When** the daemon starts
**Then** it exits non-zero before serving anything
**And** the error names the missing path and the DD-72 provisioning step

**Scenario 3: Stream provisioning is idempotent**
**Given** the Reflex stream does not exist
**When** the daemon starts twice in succession
**Then** the first start creates the stream via `ensureStream` and the second start changes nothing

**Scenario 4: Survive a NATS outage**
**Given** the daemon is running and publishing
**When** NATS becomes unreachable for 30s and then returns
**Then** publishes during the outage queue in the bounded buffer (max 1000, oldest dropped + logged)
**And** queued publishes flush in order within 5s of reconnect
**And** durable consumers resume from their last acknowledged position

**Scenario 5: Tests run without infrastructure**
**Given** a checkout with no NATS server running
**When** `bun test` runs
**Then** the full unit suite passes in under 30s using `InMemoryTransport`
**And** `bun test:integration` reports a skip notice instead of failing

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Creds file configured but missing | Startup error names path + DD-72 provisioning step; exit non-zero |
| NATS up, JetStream disabled | `ensureStream` failure surfaced with "enable JetStream" guidance; exit non-zero |
| Stream exists with drifted config | Idempotent update via `ensureStream`; on rejection, error names the drift |
| Disconnect during publish burst | Ring buffer absorbs ≤1000; oldest dropped, logged, counted; SQLite decision rows (R-103) remain audit truth |
| Reconnect after long outage | Queued publishes flushed in order; durable consumers resume position |
| Inbound envelope fails `validateEnvelope` | Rejected before handler; metric incremented; no crash |
| Myelin pin needs bump (upstream fix) | Pin is a single package.json hash change; integration suite is the regression gate |
| Subject/envelope misalignment | `validateSubjectEnvelopeAlignment` (myelin) asserted in tests for every published type |

## Success Criteria

**Definition of Done:**
- [ ] `@the-metafactory/myelin` git-pinned; `src/bus/` wrapper compiles and exposes publish/subscribe/request-reply/close
- [ ] Reflex envelope builders produce `MyelinEnvelope`s that pass `validateEnvelope` + `validateSubjectEnvelopeAlignment` for both event types
- [ ] Stream-ensure runs twice = no-op (idempotency test)
- [ ] Config precedence (file < env) proven by tests
- [ ] Fail-fast startup paths proven by tests (missing creds, no NATS, no JetStream)
- [ ] Bounded-queue disconnect behavior proven via InMemory fault injection
- [ ] `bun test` green offline; `bun test:integration` green with local nats-server
- [ ] Round-trip demo: publish `reflex.activation.fired` envelope, durable consumer receives + validates

**Minimum Viable Version:** the full FR list — this feature IS the foundation; nothing here is optional.

## Scope

### In Scope
Myelin dependency + `src/bus/` wrapper, envelope builders for the two Reflex event types, subject derivation, stream ensure, config loading, fail-fast/reconnect policy, metrics counters, unit + integration suites.

### Explicitly Out of Scope
- Building any transport implementation (myelin owns it)
- CloudEvents/DD-68 envelope (superseded by myelin in ecosystem practice)
- Envelope signing chains (`signed_by`) — Reflex publishes unsigned on the local bus in v0, matching pulse demo-bus practice
- Sovereignty classifications beyond `local` (federation later)
- Decision pipeline, impulse sources, CLI commands (R-104+)

## Assumptions

- Myelin v0.4.x API (transport, envelope, subjects, request-reply) is stable enough to pin; bumps handled per-pin
- Local `nats-server` with JetStream for integration tests; creds provisioning documented in README if absent
- Bun + TypeScript per design doc §9

## Open Questions

- [ ] Exact myelin `source` string + subject segments for Reflex (resolve in PLAN against `myelin/specs/namespace.md` — `{domain}` likely `reflex`)

---
*Interview: 2026-06-10, 2 rounds, 7 questions. Revised same day for myelin reuse (operator direction).*
