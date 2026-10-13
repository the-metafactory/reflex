# Reflex MVP Execution Plan — R-101…R-110

**Date:** 2026-06-10 · **Mode:** autonomous (operator not watching; no questions)
**Inputs:** 10 gated specs (`.specify/specs/*/spec.md`, all ≥80%), `docs/design-reflex-v0.md`, `CONTEXT.md`, ADR-0001
**Process:** SpecFlow SDD (PLAN → TASKS → IMPLEMENT via ISC/TDD loop → COMPLETE) per feature, then sage review over the bus, merge when clean.

## Feature Order (dependency-driven, strictly sequential)

| # | Feature | Why this position |
|---|---------|-------------------|
| 1 | R-101 Myelin transport integration | Root — everything publishes/subscribes through it |
| 2 | R-102 Config loader + hot-reload | Pipeline needs the blueprint set |
| 3 | R-103 SQLite storage | Pipeline needs the repository (no deps; sits here so R-104 lands next) |
| 4 | R-104 Decision pipeline core | Center of the graph |
| 5 | R-105 Schedule impulse source | First end-to-end daemon milestone |
| 6 | R-106 Manual fire + approval flow | Handlers the CLI wires |
| 7 | R-107 CLI over NATS request/reply | Wires R-106 handlers + status surfaces |
| 8 | R-108 Bus impulse source + run outcomes | Completes guard lifecycle |
| 9 | R-109 Minimal http impulse source | Independent leaf |
| 10 | R-110 Examples + demo | MVP acceptance evidence |

## Per-Feature Cycle (the SOP — run verbatim for each R-N)

### 1. PLAN
- Author `.specify/specs/<slug>/plan.md`: spec traceability (every FR/NFR → approach), architecture (module paths under `src/`), data model, failure modes, test mapping, constitutional checklist (CLI-first, library-first, test-first, deterministic, code-before-prompts).
- Gate: `specflow eval run --rubric plan-quality --file <plan.md>` ≥ 80%. Iterate until pass. (Headless `specflow plan` is NOT used — it hangs on stdin; author directly, same as the spec phase.)

### 2. TASKS
- Author `.specify/specs/<slug>/tasks.md`: ordered tasks T-N.1…, each 15–60 min, each mapping to FRs and acceptance scenarios, each with named test file.

### 3. BRANCH
```bash
git checkout main && git pull && git checkout -b spec/<r-n>-<short>
```
Never commit feature code to main.

### 4. IMPLEMENT — ISC loop per task
For each task: RED (failing test first) → GREEN (minimal impl) → full `bun test` → BLUE (refactor) → commit `spec(R-N): T-X — <desc>`. All tests green at every commit.

### 5. FEATURE GATES (all must pass before PR)
```bash
bun test                      # green, offline
bunx tsc --noEmit             # zero errors
grep -rniE '\btrigger\b|\boverlap\b|\bwebhook\b|\bcue\b' src/ examples/ && exit 1 || true   # vocabulary gate
specflow validate R-N         # spec.md + plan.md + tasks.md present
```
Acceptance scenarios from spec.md each covered by a named test (map in tasks.md checked off).

### 6. PR
```bash
git push -u origin <branch>
gh pr create --title "R-N: <name>" --body "<scenarios covered + gates output>. Closes spec R-N."
```

### 7. SAGE REVIEW (over the bus — never bypass NATS)
Preflight once per session:
```bash
tail -n 80 ~/.config/cortex/logs/cortex-meta-factory.log | grep -E 'review consumer (ready|DORMANT)' | tail -1
# DORMANT → brew services stop nats-server && launchctl kickstart -k gui/$(id -u)/ai.meta-factory.cortex.meta-factory
```
Dispatch:
```bash
SAGE_STACK=default sage dispatch the-metafactory/reflex#<PR> --org jc --post --wait 300
```
- Exit 0 = approved/commented; exit 1 = changes-requested (valid verdict); ≥2 = infra error (fix, retry once, then log + park).
- Self-approve downgrade: an "approved" verdict shows as COMMENTED on GitHub — bus `result_summary` is authoritative.
- Duplicate posts (cortex#422): second identical review = same cycle, do not re-triage.

### 8. TRIAGE + FIX
- Blockers + important findings: fix on the branch, commit, push, re-dispatch (step 7). Repeat until verdict has 0 blockers / 0 important.
- Minor/nit findings: apply if <10 min each; otherwise file as reflex issues labeled `from-review`, reference in PR.
- Max 3 review cycles per PR; if still not clean, file remaining findings as issues, note in PR body, and merge ONLY if blockers are zero — non-zero blockers after 3 cycles → park PR open, record in plan-state, move to next feature.

### 9. MERGE + CLOSE OUT
```bash
gh pr merge <PR> --squash --delete-branch
git checkout main && git pull
```
- `specflow complete R-N` (Doctorow gate: evidence, no placeholders; test-ratio ≥0.3)
- blueprint.yaml: `status: planned → done` for R-N; commit to main with the merge pull.
- Append one line to `docs/plan-state.md`: feature, PR#, verdict cycles, deferred issues.

## Cross-Cutting Rules

- **State file `docs/plan-state.md`** is the resume anchor: current feature, step, PR#, open findings. Update at every step boundary. After context compaction: read it + `specflow status`, resume at recorded step.
- **Project scaffold** (once, during R-101): `bun init` layout, `package.json` scripts (`test`, `test:integration`, `typecheck`), `tsconfig`, myelin git-pin, drizzle config placeholder.
- **Integration tests** (`bun test:integration`): require local `nats-server -js`; auto-skip with notice when absent. Run before PR for R-101, R-105, R-108, R-110; offline suite is the gate elsewhere.
- **No scope creep:** anything not in the feature's spec FRs → issue, not code.
- **Execution reporting contract (R-108):** consume myelin's validated `execution.run.finished` envelope on the configured principal/stack subject; release Run Locks using `payload.correlation_id` (Vigil Q23/Q34).

## What NOT To Do

- Do not claim a gate passed without the command output in the transcript.
- Do not skip RED (test-first) because the implementation "is obvious".
- Do not merge with a non-zero blocker count, ever.
- Do not call sage directly or bypass the NATS dispatch path (known failure pattern 2026-05-18).
- Do not use `--org metafactory` on dispatch — laptop cortex subscribes `local.jc.*`; wrong org = silent timeout.
- Do not edit `main` directly; do not rebase a branch under active review.
- Do not stop to ask the operator anything; pick the spec-faithful option, log the decision in plan-state, continue.

## Done Definition (MVP)

All 10 features merged (or explicitly parked with open PR + issues), `specflow status` shows complete, `examples/demo.sh` runs clean against local NATS, blueprint.yaml all `done`.
