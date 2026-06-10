# Specification: R-110 Example Activation Blueprints

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §5/§10 + cue-era issue #1 acceptance criteria (three concrete examples) + R-110 blueprint entry. 2026-06-10.

## Problem Statement

**Core Problem:** The three concrete activation needs that motivated Reflex (F_PR_STATS daily report, Pilot 30-minute scan, F_TESTING on-demand run) have no committed expression. Examples serve triple duty: living documentation of the `metafactory/activation/v1` format, fixtures for the integration suite, and the acceptance demo proving the daemon does real work end-to-end.

**Urgency:** Closes the v0 loop — last node in the feature graph; the demo here is the MVP "done" evidence.

## Users & Stakeholders

**Primary:** Operators learning the format (examples ARE the tutorial in v0). **Secondary:** Integration suite (fixtures); the original three use-case owners.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | `examples/pr-stats-daily/reflex.yaml`: schedule kind (`0 7 * * *`, Europe/Zurich), policy auto, `cooldown: 6h`, `run_lock: skip`, payload `{mode: daily}`, target `@jc/f-pr-stats` | Issue #1, design §5 sketch |
| FR-2 | `examples/pilot-scan/reflex.yaml`: bus kind (task-completed subject, `where: {flow: review}`), policy approval, `approval_timeout: 1h`, `run_lock: buffer`, target `@jc/pilot-scan` | Issue #1, design §5 sketch |
| FR-3 | `examples/f-testing/reflex.yaml`: manual kind, policy auto, no guards, target `@jc/f-testing` — the `reflex fire f-testing` story | Issue #1 |
| FR-4 | Every example carries explanatory comments on every field — the file IS the doc; comments use canonical glossary terms only | Living docs |
| FR-5 | `examples/README.md`: walk-through per example — what fires it, what the decision flow looks like, the CLI commands to observe it (`status`, `pending`, `history`, `test`) | Operator tutorial |
| FR-6 | Integration suite loads all three via the real R-102 loader (no fixture duplication) and drives each end-to-end: schedule tick (fake clock) → Fired; bus envelope → Matched → approve → Fired; manual fire → Fired | Fixture duty |
| FR-7 | `reflex validate examples/` passes; CI runs it (vocabulary + schema drift gate for every future change) | Drift protection |
| FR-8 | Demo script `examples/demo.sh`: starts daemon against local NATS, fires the manual example, approves a staged pilot-scan match, prints history — the MVP acceptance walk | MVP evidence |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Example readability | a newcomer reproduces a working blueprint from examples alone (no other docs) |
| NFR-2 | Suite runtime | three end-to-end example tests < 10s offline (fake clock; InMemory bus) |
| NFR-3 | Zero banned vocabulary | grep gate: trigger, overlap, webhook, cue, pending(-as-noun) absent from examples/ |

## Acceptance Scenarios

**Scenario 1: Examples are valid by construction**
**Given** a clean checkout
**When** `reflex validate examples/` runs
**Then** exit 0 with three blueprints reported

**Scenario 2: Schedule example fires end-to-end**
**Given** the daemon loaded `pr-stats-daily` with a fake clock
**When** the clock crosses 07:00 Europe/Zurich
**Then** history shows a Fired decision and the bus carries one `reflex.activation.fired` envelope targeting `@jc/f-pr-stats`

**Scenario 3: Approval example exercises the full lifecycle**
**Given** the daemon loaded `pilot-scan`
**When** a matching task-completed envelope arrives and the operator approves the Matched Decision
**Then** the run fires with `run_lock: buffer` engaged
**And** a second envelope during the run becomes the Buffered Impulse, re-presenting after the run-outcome event

**Scenario 4: Manual example is the one-liner story**
**Given** the daemon loaded `f-testing`
**When** `reflex fire f-testing` runs
**Then** the CLI prints the Fired decision id and history confirms it

## Dependencies

| Dependency | What this feature needs from it |
|---|---|
| R-102 | Loader + `reflex validate` consume the example files directly |
| R-105 | Schedule example end-to-end test (fake-clock tick) |
| R-106 | Approval + manual-fire flows for pilot-scan and f-testing walks |
| R-108 | Bus match + Buffered Impulse re-presentation in the pilot-scan test |
| R-107 | CLI commands used by README walk-through and `demo.sh` |

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Examples drift from schema after a later change | CI `reflex validate examples/` fails the PR with the R-102 error block (file, field path, expected vs received) |
| Target Execution Blueprints don't exist yet in any registry | Fine in v0 — targets are opaque refs; the envelope carries them verbatim (Reflex never inspects targets) |
| Operator copies an example and forgets to change `id` | Duplicate-id load error (R-102) names both files — by design |
| `demo.sh` run without local NATS | Exits non-zero immediately with the R-101 fail-fast error and a hint to start `nats-server`; never half-runs |
| `demo.sh` run twice | Second run is clean: cooldowns from the first run surface as honest Blocked decisions in the printed history, demonstrating guard behavior rather than failing |
| Fake-clock test and real croner disagree on a cron boundary | Impossible by construction: tests use the same croner instance the daemon runs (R-102 FR-9 single-library rule) |
| Integration test leaves stale DB/stream state | Each test runs against a temp `XDG_STATE_HOME` and isolated InMemory bus; no shared state between scenarios |

## Success Criteria

**Definition of Done:**
- [ ] Three example dirs + README committed; comments on every field
- [ ] `reflex validate examples/` green in CI
- [ ] Three end-to-end integration tests green offline (fake clock + InMemory)
- [ ] `demo.sh` runs clean against local NATS and prints the three-decision history
- [ ] Vocabulary grep gate green
- [ ] Newcomer test: README walk-through contains every command needed, in order

## Scope

### In Scope
Three examples, README walk-through, integration fixtures wiring, demo script, CI validate step.

### Explicitly Out of Scope
- http-kind example (R-109 ships its own test fixtures; a fourth example lands when a real external caller exists)
- Registry publication of examples (DD-62 later phases)

## Assumptions

- R-105/106/108 interfaces stable by the time this lands (last in graph)
- Target refs `@jc/…` are placeholder-valid opaque strings

## Open Questions

- [ ] None blocking.
