# Tasks: R-104 Decision Pipeline Core

Branch: `spec/r-104-decision-pipeline` · TDD per task.

## T-1: Impulse + result types
- `src/pipeline/impulse.ts`, `verdict.ts`: Impulse, EvaluateResult, GuardReason, DryRunVerdict; canonical idempotency key derivation (sha256, stable JSON).
- Tests: key stable across property order; distinct payloads → distinct keys.
- Covers: FR-1 types, data model.

## T-2: Guard chain (pure over Repository)
- `src/pipeline/guards.ts`: checkGuards order idempotency → cooldown → run lock (skip|buffer modes); read-only variant for dry-run.
- Tests `guards.test.ts`: order, each guard isolated, buffer signal distinct from skip.
- Covers: FR-4, FR-5 (decision side).

## T-3: Fire path
- `src/pipeline/fire.ts`: persist Fired row → engage cooldown + CAS lock → recordFiredEvent → publishFired; correlation stamping.
- Tests `fire.test.ts`: spy sequence order; publish failure leaves DB truth + queued envelope.
- Covers: FR-7, FR-11.

## T-4: evaluate() — policy gate + wiring
- `src/pipeline/evaluate.ts`: selection, disabled/approval/auto branches, audit publishes, per-blueprint serialization.
- Tests `evaluate.test.ts`: scenarios 1 + disabled; ignored→counter only.
- Covers: FR-1, FR-2, FR-3, FR-8, NFR-2 (structure).

## T-5: Approval resolution
- `resolveMatched(decisionId, approve|deny, actor)`: guard re-check → CAS → fire/deny; ConflictError pass-through.
- Tests `approval.test.ts`: scenario 2, deny, conflict.
- Covers: FR-10.

## T-6: Buffer re-presentation + onRunCompleted
- `onRunCompleted(correlationId, outcome)`: lock release, take buffered, fresh evaluate with causation link.
- Tests `buffer.test.ts`: scenario 4 incl. meanwhile-cooldown honest block; unknown correlation warn no-op.
- Covers: FR-6.

## T-7: Dry run
- `evaluateDry`: read-only chain → DryRunVerdict; zero mutation.
- Tests `dry.test.ts`: scenario 5 byte-level (DB snapshot + bus count).
- Covers: FR-9.

## T-8: Race, perf, architecture gates + exports
- `race.test.ts` (scenario 6, 100 rounds); perf NFR-1; gates.test extension (no raw myelin/drizzle imports in src/pipeline/); `src/index.ts` exports.
- Covers: NFR-1..4, FR-12.

## Done gate
- All seven spec scenarios named in tests; vocabulary grep clean; `specflow validate R-104`.
