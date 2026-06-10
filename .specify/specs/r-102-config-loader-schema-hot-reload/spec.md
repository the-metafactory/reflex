# Specification: R-102 Config Loader + Schema + Hot-Reload

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §5 + `CONTEXT.md` glossary (When Block, Impulse Kind) + grill decisions 13–15, 20. 2026-06-10.

## Problem Statement

**Core Problem:** Activation Blueprints are declared in YAML across two surfaces (sidecar `reflex.yaml` files next to flows, central `~/.config/reflex/activations/*.yaml`). The daemon needs a validated, merged, hot-reloadable in-memory blueprint set; operators need `reflex validate` to check files without a running daemon.

**Urgency:** Blocks R-104 (pipeline evaluates blueprints) — second node in the dependency graph.

## Users & Stakeholders

**Primary:** Operators authoring `reflex.yaml` files. **Secondary:** the decision pipeline (R-104) consuming the loaded blueprint set; hot-reload behavior interacts with the approvals lifecycle (R-106).

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Zod schema for `metafactory/activation/v1`: entry = one Activation Blueprint with `id`, `target`, `when:` (When Block), `policy` (`auto\|approval\|disabled`), optional `approval_timeout` (duration, default 1h), optional `guards:` (`cooldown` duration, `run_lock: skip\|buffer`), optional `payload:` map | Design §5, grill 13/20 |
| FR-2 | When Block accepts exactly one Impulse Kind: `schedule` (cron string + optional `timezone`), `manual` (no fields), `bus` (`subject`, optional flat `where:` field-equals map), `http` (optional `token_env` naming the env var holding the bearer token) | Grill 14/15 |
| FR-3 | Loader merges both surfaces: configured sidecar roots (glob `**/reflex.yaml`) + central dir; surface order is irrelevant | Design §5 |
| FR-4 | Duplicate blueprint `id` across any loaded files → load error naming both file paths; daemon refuses the new set (keeps serving the previous valid set when hot-reloading; refuses to start on first load) | Grill Q1 consequence |
| FR-5 | Hot-reload: file watcher on all surfaces; a change parses + validates the FULL new set, then atomically swaps it; in-flight evaluations finish against the old set | Design §5 |
| FR-6 | On reload, blueprints removed from config: their Matched Decisions resolve to Expired Decisions with reason `blueprint-removed` (via R-106 lifecycle interface) | Design §5 |
| FR-7 | `reflex validate [path]` runs the same parse+validate daemon-less; exit 0 clean / exit 1 with one error block per offending file | Design §8 |
| FR-8 | Schema errors are actionable: file path, YAML line (where derivable), field path, expected vs received | Operator UX |
| FR-9 | Durations (`cooldown`, `approval_timeout`) accept `30s\|15m\|6h\|2d` form; cron strings validated via the same library R-105 executes (croner) — validation and execution cannot disagree | Consistency |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Reload latency (change on disk → new set live) | < 500ms for 100 blueprints |
| NFR-2 | Validation throughput | 100 files < 1s |
| NFR-3 | Watcher robustness | editor atomic-rename writes (vim, VS Code) detected reliably |
| NFR-4 | Zero NATS dependency in this module | loader + validate run fully offline |

## Acceptance Scenarios

**Scenario 1: Valid merged load**
**Given** one sidecar `reflex.yaml` with blueprint `a` and a central file with blueprint `b`
**When** the daemon starts
**Then** the loaded set contains exactly `a` and `b`, each with normalized guards/policy defaults applied

**Scenario 2: Duplicate id rejected loudly**
**Given** blueprint id `daily` defined in a sidecar AND a central file
**When** the daemon starts
**Then** startup fails with an error naming both file paths and the colliding id

**Scenario 3: Hot-reload swaps atomically**
**Given** a running daemon with blueprint `a` (cron `0 7 * * *`)
**When** the file changes `a`'s cron to `0 9 * * *`
**Then** within 500ms the live set serves the new cron
**And** no evaluation observes a half-updated blueprint

**Scenario 4: Bad edit keeps last good set**
**Given** a running daemon with a valid set
**When** a file is saved with invalid YAML
**Then** the daemon logs the validation error, keeps serving the previous set
**And** a subsequent valid save swaps normally

**Scenario 5: Removed blueprint expires its waiting decisions**
**Given** blueprint `gate` has a Matched Decision awaiting approval
**When** `gate` is deleted from config and the set hot-reloads
**Then** the Matched Decision resolves to an Expired Decision with reason `blueprint-removed`

**Scenario 6: Daemon-less validation**
**Given** no daemon is running
**When** `reflex validate ./flows` runs against files containing one bad field
**Then** exit code is 1 and the output names file, field path, expected vs received

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Empty `activations:` list in a file | Valid; contributes zero blueprints; logged at debug |
| Unknown top-level or entry key | Validation error (strict schema) — typos must not silently no-op |
| Two Impulse Kinds in one When Block | Validation error: exactly one kind per blueprint in v0 |
| `run_lock` present with invalid value | Error lists allowed values `skip\|buffer`; "allow" explicitly suggests removing the key |
| Watcher event storm (git checkout) | Debounce (200ms); single revalidation of final state |
| Central dir absent | Treated as empty surface, not an error |
| Sidecar root configured but missing | Startup warning naming the path; daemon continues with remaining surfaces |

## Success Criteria

**Definition of Done:**
- [ ] Zod schema rejects every malformed fixture and accepts all three R-110 examples
- [ ] Merge + duplicate-id error proven by tests (both directions: start + reload)
- [ ] Atomic swap proven: concurrent reads during reload never see mixed state
- [ ] Last-good-set retention on invalid reload proven
- [ ] `blueprint-removed` expiry hook invoked (integration with approvals stub)
- [ ] `reflex validate` exit codes + error format proven on fixture corpus
- [ ] `bun test` offline green

## Scope

### In Scope
Schema, two-surface loader, merge + dup detection, hot-reload watcher, last-good-set policy, `reflex validate`, error formatting, duration/cron validation.

### Explicitly Out of Scope
- Registry-published Activation Blueprints (DD-62 later phases)
- Multi-rule blueprints (v0: one implicit Activation Rule per entry)
- Schema migrations/versioning beyond `metafactory/activation/v1`
- Evaluating blueprints (R-104); executing cron (R-105)

## Assumptions

- Sidecar roots come from R-101's config file (`reflex.config.yaml` `watch_roots:`)
- Bun's `fs.watch` (or chokidar fallback) adequate for both surfaces

## Open Questions

- [ ] None blocking.
