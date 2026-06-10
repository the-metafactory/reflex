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

## Data Flow

```
operator reads examples/README.md
  └─ copies an example → edits id/target → reflex validate → daemon hot-reloads it
demo.sh: env → reflex-daemon (fail-fast preconditions) → reflex fire f-testing (CLI→NATS req/reply→handlers→pipeline)
  → reflex history (decision rows) → SIGTERM clean stop
test/examples.test.ts: discoverActivationFiles(examples/) → loadBlueprintSet (REAL R-102 loader, no fixture forks)
  → Pipeline rig (InMemory bus, :memory: repo, fake clock) → three end-to-end flows
```

## Data Model

No new types. The examples are instances of `metafactory/activation/v1` (R-102 schema, frozen by migration 0000 + merged loaders); the test consumes `ActivationBlueprint`/`Impulse`/`EvaluateResult` as merged. Stack unchanged (Bun 1.3.x, myelin f5ec865).

## Scope Verification

IN: three sidecar examples, README walk-through, demo.sh, end-to-end suite, validate + vocabulary gates. NOT in (per spec Out of Scope): http-kind example (R-109 ships its own fixtures), registry publication of examples (DD-62 later phases). The "spec 86%" figure is the specflow spec-quality LLM-judge rubric score (threshold 80) recorded at SPECIFY; the gap is rubric-style points (Given/When/Then framing). Traceability is the table above: spec FR-1..FR-8 and NFR-1..NFR-3 each have a row naming their implementation (FR-1..3 examples, FR-4 comments, FR-5 README, FR-6 e2e suite, FR-7 validate gate, FR-8 demo.sh; NFR-1 README completeness, NFR-2 duration assertion, NFR-3 vocab grep).

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---|---|---|---|
| Examples drift from schema | suite fails (REAL loader — no fixture fork to drift separately) | fix example or schema; pre-push hook blocks the regression | none shipped |
| demo.sh without NATS | daemon fail-fast exit 1 with hint (R-101 policy) | start nats-server -js, rerun | none — never half-runs |
| demo.sh re-run | cooldown → honest Blocked history entries | by design; script prints the explanation | none |
| Copied example w/o id change | R-102 DuplicateIdError naming both files | rename id | load refused |
| Loader/test rig failure (DB, InMemory bus) | suite fails loudly with the rig error | standard test debugging; rig identical to 5 merged features' rigs | CI-only |
| Fake-clock drift vs croner | expression-validity parity guaranteed (same croner validates and runs, R-102 FR-9); RUNTIME tick parity is proven by R-105's real-croner tests, not by this suite (which evaluates schedule impulses directly) | covered upstream | n/a |

## Example YAML (committed shape, FR-1 — others analogous)

```yaml
schema: metafactory/activation/v1
activations:
  - id: pr-stats-daily            # Activation Blueprint id (global across surfaces)
    target: "@jc/f-pr-stats"      # Execution Blueprint ref (opaque to Reflex)
    when:                          # When Block — exactly one Impulse Kind
      schedule: "0 7 * * *"        # Internal Impulse: cron, validated by croner
      timezone: Europe/Zurich
    policy: auto                   # auto | approval | disabled (Activation Policy)
    guards:
      cooldown: 6h                 # Activation Guard: no re-fire within window
      run_lock: skip               # Run Lock conflict mode (omit = concurrent allowed)
    payload:
      mode: daily                  # merged into the Activation Payload
```

demo.sh env contract: `REFLEX_PRINCIPAL=jc REFLEX_STACK=demo REFLEX_NATS_URL=nats://127.0.0.1:4222` + `watch_roots`/`activations_dir` via a generated temp config file (documented inline in the script).

## Test Assertions

- Loader returns ids {pr-stats-daily, pilot-scan, f-testing} with expected kinds/policies/guards.
- Schedule: pipeline.evaluate(schedule impulse for pr-stats-daily at fake 07:00) → Fired; envelope targets @jc/f-pr-stats.
- Pilot-scan: matching bus envelope → Matched; approve → Fired; second envelope during run → Buffered; synthetic outcome → re-presented.
- Manual: fire f-testing → Fired.
- validatePaths(["examples"]) ok with 3 blueprints.
- Vocab grep: the banned-term list is explicit — trigger, overlap, webhook, cue, hook (Avoid aliases per reflex/CONTEXT.md) — asserted absent from every file under examples/.
- NFR-2 measured: the e2e describe block is wrapped in a duration assertion (performance.now delta < 10_000ms).

## Constitutional Compliance (commitments, verified at done gate)

CLI-First — demo.sh uses the reflex CLI; Test-First; Deterministic — fake clock; Code Before Prompts.

## Order

T-1 examples + README → T-2 e2e test suite → T-3 demo.sh + live MVP walk evidence.
