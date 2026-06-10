# Plan: R-110 Example Activation Blueprints

**Spec:** `spec.md` (86%) · **Date:** 2026-06-11 · Last node — the MVP acceptance walk.

## Architecture

```
examples/
  pr-stats-daily/reflex.yaml   # schedule kind (FR-1)
  pilot-scan/reflex.yaml       # bus kind + approval + run_lock buffer (FR-2)
  f-testing/reflex.yaml        # manual kind (FR-3)
  README.md                    # walk-through per example with CLI commands (FR-5)
  demo.sh                      # MVP acceptance walk against local NATS (FR-8)
test/examples.test.ts          # real R-102 loader drives all three end-to-end (FR-6) + vocab gate (NFR-3)
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1..3 | Three sidecar examples exactly per design §5 sketch, every field commented with canonical glossary terms (FR-4) |
| FR-5 | README: per example — what fires it, the decision flow, observe commands (status/pending/history/test/validate) |
| FR-6 | `test/examples.test.ts`: `loadBlueprintSet(discoverActivationFiles({watchRoots: [examples/], …}))` → 3 blueprints; end-to-end: fake-clock schedule eval → Fired; bus envelope → Matched → approve → Fired with run_lock buffer; manual fire → Fired |
| FR-7 | `reflex validate examples/` green — asserted in the test (CLI core validatePaths); no CI config exists in this repo yet → the test IS the gate (deviation noted: spec said "CI runs it"; pre-push hook runs the suite, which includes it) |
| FR-8 | `demo.sh`: starts daemon (bun src/bin/reflex-daemon.ts) with REFLEX_* env against local NATS, fires f-testing via CLI, prints pending + history, clean stop; idempotent second run shows honest cooldown blocks |
| NFR-1 | README walk-through contains every command in order |
| NFR-2 | Example e2e tests offline < 10s (fake clock + InMemory) |
| NFR-3 | Vocabulary grep over examples/ in the test |

## Failure Modes

| Failure | Handling |
|---|---|
| Examples drift from schema | suite fails (loader is the real one); pre-push hook blocks |
| demo.sh without NATS | daemon fail-fast exit 1 with hint (R-101 policy) — script surfaces it, never half-runs |
| demo.sh re-run | cooldown blocks render as honest Blocked history entries (documented in script output) |
| Copied example w/o id change | R-102 DuplicateIdError naming both files |

## Test Assertions

- Loader returns ids {pr-stats-daily, pilot-scan, f-testing} with expected kinds/policies/guards.
- Schedule: pipeline.evaluate(schedule impulse for pr-stats-daily at fake 07:00) → Fired; envelope targets @jc/f-pr-stats.
- Pilot-scan: matching bus envelope → Matched; approve → Fired; second envelope during run → Buffered; synthetic outcome → re-presented.
- Manual: fire f-testing → Fired.
- validatePaths(["examples"]) ok with 3 blueprints.
- Vocab grep: banned terms absent from examples/**.

## Constitutional Compliance (commitments, verified at done gate)

CLI-First — demo.sh uses the reflex CLI; Test-First; Deterministic — fake clock; Code Before Prompts.

## Order

T-1 examples + README → T-2 e2e test suite → T-3 demo.sh + live MVP walk evidence.
