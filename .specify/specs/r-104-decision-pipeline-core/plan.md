# Plan: R-104 Decision Pipeline Core

**Spec:** `spec.md` (80%) · **Date:** 2026-06-10 · **Doctrine:** ADR-0001; CONTEXT.md decision taxonomy (six outcomes, Matched sole non-terminal)

## Architecture

```
src/
  pipeline/
    impulse.ts       # Impulse type (kind, blueprintId?, payload, receivedAt, actor) + selection (FR-1)
    evaluate.ts      # Pipeline class: evaluate(), evaluateDry(), resolveMatched(), onRunCompleted() (FR-1..FR-10)
    guards.ts        # guard chain: idempotency → cooldown → run lock (FR-4, FR-5) — pure decisions over Repository state
    fire.ts          # fire path: persist-then-publish, correlation stamping, cooldown/lock engagement (FR-7)
    verdict.ts       # DryRunVerdict type (FR-9)
test/pipeline/
  evaluate.test.ts  guards.test.ts  fire.test.ts  approval.test.ts  buffer.test.ts  dry.test.ts  race.test.ts
```

Composition root: `new Pipeline({ store: BlueprintStore, repo: Repository, bus: ReflexBus, cfg })` — all three prior features injected; fully testable with InMemory bus + `:memory:` repo.

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `Pipeline.evaluate(impulse)`: candidate selection — `manual`/`http` impulses carry `blueprintId` (direct); `schedule` carries `blueprintId` (scheduler knows); `bus` impulses match by subject+where (R-108 pre-filters, passes blueprintId). One Activation Decision per matching blueprint evaluation |
| FR-2 | Outcome enum from `Repository.DecisionOutcome`; Ignored → `repo.bumpIgnored` only (counter, no row, not published); all others → decision row + audit envelope |
| FR-3 | Policy gate in `evaluate`: `disabled` → ignored (reason recorded in counter only); `approval` → matched row + `repo.createApproval(id, now+approvalTimeoutMs)` + `pendingApproval` result; `auto` → guard chain |
| FR-4 | `guards.ts` `checkGuards(bp, impulse, repo, now)`: order idempotency → cooldown → run lock; first violation returns `{blocked, reason}`; deterministic, unit-tested in isolation |
| FR-5 | Run Lock modes from blueprint guards: `skip` → Blocked(run-lock); `buffer` → Blocked(run-lock-buffered) + `repo.putBufferedImpulse(bp.id, impulse, blockedDecisionId)` |
| FR-6 | `onRunCompleted(correlationId, outcome)`: `repo.findFiredByCorrelation` → blueprint; `repo.releaseRunLock`; `repo.takeBufferedImpulse` → if present, fresh `evaluate()` with `causationId = bufferedByDecisionId` |
| FR-7 | `fire.ts`: order is (1) record Fired decision row, (2) engage cooldown + acquire run lock, (3) `repo.recordFiredEvent`, (4) `bus.publishFired` (queue-backed, never throws). Persist-then-publish: a crash after (1) leaves truth in DB; publish failure rides R-101 outage queue |
| FR-8 | Audit publish via `bus.publishDecision` for matched/blocked/fired/denied/expired with `decisionId`, reason, actor, correlation |
| FR-9 | `evaluateDry(impulse)`: same guard chain run against CURRENT state via read-only repo calls, returns `DryRunVerdict {wouldOutcome, reasons[]}` — zero writes asserted byte-level in tests (DB snapshot compare), zero publishes (bus spy) |
| FR-10 | `resolveMatched(decisionId, action, actor)`: approve → `repo.resolveMatched(kind: approve)` THEN guard re-check; guard violation post-approval → Blocked row linked via `resolutionOf`… actually: guards re-checked FIRST (read-only), then CAS resolve to fired + fire path; deny/expire → CAS resolve. ConflictError surfaces verbatim (R-106/R-107 render it) |
| FR-11 | Fail closed: `StorageError` aborts before any guard mutation or publish (fire path step order guarantees this) |
| FR-12 | No myelin imports in `src/pipeline/` except types via `src/bus` facade; architectural grep test extends gates |
| NFR-1 | Perf test: 100 blueprints loaded, evaluate p99 < 25ms (timing loop) |
| NFR-2 | Same-blueprint serialization: per-blueprint promise chain (`Map<string, Promise>`) — concurrent `evaluate` calls for one blueprint queue; cross-blueprint stays parallel. Race test: N concurrent identical impulses → exactly one Fired |
| NFR-3 | Guard order fixed; `now` injected (`nowFn` option) — deterministic tests, no wall-clock in logic |
| NFR-4 | All tests offline (InMemory bus + `:memory:` repo) |

## Data Model

```ts
interface Impulse { kind: ImpulseKind; blueprintId: string; payload: Record<string, unknown>;
                    receivedAt: string; actor: ReflexActor; sourceEnvelope?: {id: string; type: string; correlationId?: string} }
type EvaluateResult =
  | { outcome: "ignored"; reason: "no-match" | "disabled" }
  | { outcome: "matched"; decisionId: string; expiresAt: string }
  | { outcome: "blocked"; decisionId: string; reason: GuardReason }
  | { outcome: "fired"; decisionId: string; correlationId: string };
type GuardReason = "idempotency" | "cooldown" | "run-lock" | "run-lock-buffered";
interface DryRunVerdict { wouldOutcome: DecisionOutcome; reasons: string[] }
```

Idempotency key: `sha256(blueprintId + canonicalJson(impulse.payload))`, window default 10min (DD-71 Stage-4 dedup precedent; config `idempotency_window` later if needed — constant for v0).

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| Storage write fails mid-pipeline | StorageError | abort before guard mutation/publish (fail closed); CRITICAL log | one evaluation |
| Publish fails after Fired persisted | bus queue (never throws) | envelope rides outage queue; queue drop logged with decision id | wire delay; DB truth intact |
| Crash between decision row and fired_events | restart | Fired row stands; correlation absent from fired_events → run-lock release for it is a warn no-op | one buffer re-presentation potentially skipped — logged |
| Approve races expiry sweep | repo CAS | one winner; loser ConflictError with actual state (R-103 proven) | none |
| onRunCompleted for unknown correlation | findFiredByCorrelation null | warn + ignore | none |
| Buffered re-presentation blocks again | normal guard chain | honest Blocked row linked via causation | none |
| Double-fire under concurrent impulses | per-blueprint serialization + idempotency + lock CAS | race test 100 iterations | none |
| Blueprint vanishes between match and approve | resolveMatched guard re-check reads live store; missing bp → expire reason blueprint-removed | consistent with R-102 hook | one decision |

## Test Assertions (verifiability)

- `evaluate.test.ts`: auto+no-guards → Fired row + envelope on bus spy with target/payload/idempotency_key/decision link (spec scenario 1); disabled → counter only, decisions table empty; ignored not published.
- `approval.test.ts`: approval policy → Matched + approvals row with `expiresAt = now+timeout` (scenario 2); approve → guard re-check → Fired linked row + publish; deny → Denied; approve-after-deny → ConflictError surfaced.
- `guards.test.ts`: order proven (idempotency violation reported even when cooldown also active); cooldown Blocked with reason (scenario 3); each guard isolated.
- `buffer.test.ts`: scenario 4 verbatim — two impulses during run → 2 Blocked rows, buffer holds 2nd; onRunCompleted → exactly one fresh decision with `caused_by`; meanwhile-cooldown → honest Blocked.
- `dry.test.ts`: scenario 5 — DB file hash + bus publish count identical before/after `evaluateDry`; verdict text names cooldown expiry.
- `race.test.ts`: scenario 6 — 100 rounds × 2 concurrent identical impulses → exactly 1 Fired + 1 Blocked each round.
- `fire.test.ts`: persist-then-publish order (spy sequence); publish failure → Fired row still present, queue holds envelope.

Framework: bun:test, fake `nowFn`, InMemory transport, `:memory:` DB.

## Constitutional Compliance (commitments, verified at done gate)

Library-First — Pipeline exported; Test-First — RED per task; Deterministic — injected clock, fixed guard order, per-blueprint serialization; CLI-First — n/a (R-107 surfaces); Code Before Prompts.

## Implementation Order (→ tasks.md)

T-1 Impulse + result types → T-2 guard chain (pure) → T-3 fire path → T-4 evaluate (policy gate + wiring) → T-5 approval resolution → T-6 buffer re-presentation + onRunCompleted → T-7 dry run → T-8 race/perf/architecture gates + exports.

## Dependencies / Risks

- Consumes R-101 bus facade, R-102 BlueprintStore, R-103 Repository — all merged. Risk: per-blueprint serialization map growth — pruned when chain settles (entry deleted on completion).
