# Plan: R-106 Manual Fire + Approval Flow

**Spec:** `spec.md` (82%) · **Date:** 2026-06-10 · **Note:** much of the lifecycle (CAS resolution, sweep, blueprint-removed expiry) shipped inside R-103/R-104/R-105 — this feature adds the transport-agnostic OPERATOR HANDLERS and closes the spec's scenarios end-to-end.

## Architecture

```
src/
  handlers/
    commands.ts     # CommandHandlers: fire/approve/deny/pending — transport-agnostic (FR-1..FR-4, FR-6)
                    # typed results incl. conflict {code, currentState} for R-107 rendering
  daemon.ts         # gains handlers + exposes them on ReflexDaemon (internal)
test/handlers/commands.test.ts
```

R-107 wires these to NATS request/reply; handlers never parse CLI args or touch transport.

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `fire(blueprintId, input, actor)`: validate blueprint exists (error lists nearest ids by prefix distance) → Impulse `{kind: manual, payload: input, actor}` → `pipeline.evaluate()` → `{decisionId?, outcome, reason?}` synchronously |
| FR-2 | No special treatment by construction — fire calls the same `evaluate()`; test: manual fire into active cooldown → blocked (already proven R-104 scenario; re-asserted via handler) |
| FR-3 | `approve(decisionId, actor)`: validates waiting via repo, delegates `pipeline.resolveMatched(approve)`; result includes post-approval outcome (fired \| blocked+guard reason); `ConflictError` → typed `{error: "conflict", currentState}` (not a throw — handlers return values for the wire) |
| FR-4 | `deny(decisionId, actor)`: delegates; idempotent-conflict same shape |
| FR-5 | Sweep: ALREADY in daemon (R-105: startup + 30s interval); this feature adds the missing test — fake-clock sweep via `repo.sweepExpiredApprovals(now)` asserting Expired reason timeout + `expireForBlueprint` reason blueprint-removed (R-102 hook proven in daemon test) |
| FR-6 | `pending()`: `repo.listWaiting()` mapped to wire shape `{decisionId, blueprintId, matchedAt, expiresAt, impulseSummary}` newest-first |
| FR-7 | Actor recorded + audit envelope published — both already in pipeline paths; handler tests assert actor round-trip into approvals row + decision envelope |
| FR-8 | Race safety = R-103 CAS (proven); handler-level test: approve+deny concurrently → one ok, one conflict naming final state |
| NFR-1 | Handler overhead test: fire round trip (InMemory) < 100ms |
| NFR-2 | Sweep accuracy covered by interval=30s default + startup sweep (R-105) — asserted via fake-clock repo test |
| NFR-3 | All tests offline (InMemory bus + :memory: DB) |

## Data Flow

```
operator (R-107 CLI, later Cortex)
   │ transport (NOT this feature)
   ▼
CommandHandlers ── fire ───► Pipeline.evaluate ──► Repository (decisions/guards) ──► ReflexBus (envelopes)
   │                 │
   ├─ approve/deny ──► Pipeline.resolveMatched ──► Repository CAS (approvals) ──► fire path / denied row
   └─ pending ───────► Repository.listWaiting (read-only join approvals×decisions)
```

Handlers hold references injected at daemon assembly: `{store, pipeline, repo}` — no transport, no config. Underlying models are FROZEN contracts from merged features: `decisions`/`approvals`/`guard_state` schema (R-103 `src/store/schema.ts`, drizzle/0000 migration), `Impulse`/`EvaluateResult` (R-104 `src/pipeline/impulse.ts`). This plan adds NO schema or pipeline changes — done = handlers + tests only (the spec's FR-5 sweep/expiry FRs were delivered by R-103/R-105 and are re-verified here, not rebuilt).

## Data Model (this feature's wire contracts — consumed verbatim by R-107)

```ts
type HandlerResult<T> = { ok: true; data: T }
  | { ok: false; error: { code: "not-found" | "conflict" | "invalid-input" | "internal"; message: string; currentState?: string } };
// "internal": storage/pipeline failures surfaced as typed results — R-107 must render it (exit 1).

fire(blueprintId: string, input: Record<string, unknown>, actor: ReflexActor)
  → HandlerResult<{ decisionId?: string; outcome: "ignored"|"matched"|"blocked"|"fired"; reason?: string; correlationId?: string; expiresAt?: string }>
approve(decisionId: string, actor: ReflexActor)
  → HandlerResult<{ outcome: "fired"|"blocked"|"ignored"; decisionId?: string; reason?: string }>
deny(decisionId: string, actor: ReflexActor)
  → HandlerResult<{ outcome: "denied"; decisionId: string }>
listWaiting()   // CLI verb `pending` maps here at the R-107 surface
  → HandlerResult<Array<{ decisionId: string; blueprintId: string; matchedAt: string; expiresAt: string; impulseSummary: string }>>
```

Stack: Bun 1.3.x, drizzle-orm 0.4x (locked in bun.lock), myelin pin f5ec865 — unchanged by this feature.

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| fire on unknown blueprint | store lookup | not-found error with nearest-id hint | none |
| approve on resolved decision | repo CAS | conflict result with actual state | none |
| approve races sweep | CAS (R-103) | one winner; loser conflict | none |
| malformed input payload | handler boundary (object check) | invalid-input error before impulse | none |
| blueprint removed while waiting | R-102→daemon hook | Expired(blueprint-removed) — daemon test exists (R-105) | one decision |
| pipeline.evaluate throws (StorageError, disk full) | handler try/catch | typed `{error: {code: "storage"}}`-style internal error mapped to message; nothing fired (R-104 fail-closed proven) | one command |
| DB locked/closed mid-command | StorageError propagation | same internal-error mapping; daemon health unaffected (next command independent) | one command |
| Bus down during fire | R-101 outage queue | fire returns ok (decision row is truth); envelopes queue — handler result notes nothing, by design (wire catches up) | wire delay only |
| Recovery-fails case (sweep raced + conflict storm) | R-103 sweep swallows ConflictError only | non-conflict errors propagate to daemon log; sweep retries next interval | bounded to one interval |

## Test Assertions (verifiability)

- scenario 1: fire into cooldown → `{ok: true, data: {outcome: blocked, reason: cooldown}}` — no bypass.
- scenario 2: approve waiting → guards re-run → fired linked; approvals row actor = operator (round-trip).
- scenario 3: deny terminal; approve-after-deny → `{ok: false, error: {code: conflict, currentState: denied}}`.
- scenario 4: fake-clock `sweepExpiredApprovals` at expiry+1 → Expired(timeout); pending() empty after.
- scenario 5: concurrent approve||deny → exactly one ok (Promise.all over handlers).
- pending(): two waiting → newest-first, impulseSummary contains kind + payload keys.
- fire unknown id → not-found error message contains the nearest loaded id.
- perf: fire handler < 100ms p99 over 20 iterations (InMemory).

## Constitutional Compliance (commitments, verified at done gate)

Library-First — handlers exported module-level (root stays opaque per R-105 review); Test-First — RED per task; Deterministic — injected clock via pipeline nowFn; CLI-First — R-107 is the surface; Code Before Prompts.

## Implementation Order (→ tasks.md)

T-1 HandlerResult + fire → T-2 approve/deny (conflict mapping) → T-3 pending + summaries → T-4 sweep/race/perf tests + daemon exposure.

## Dependencies / Risks

All deps merged. Risk: none material — thin layer over proven primitives.
