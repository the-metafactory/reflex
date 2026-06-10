# Specification: R-107 CLI over NATS Request/Reply

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §8 + structure-session decision 7 + grill decision 19 (friendly surface, canonical core). Uses myelin request-reply (R-101 revision). 2026-06-10.

## Problem Statement

**Core Problem:** Operators need a command surface for the daemon: status, list, fire, approve/deny, pending, history, test, validate. Decision 7: CLI talks to the daemon over NATS request/reply — one protocol, dogfoods the bus, and Cortex can later issue identical commands remotely. No unix socket, no direct DB access from the CLI (except `validate`, which is daemon-less by design).

**Urgency:** Operability gate — without it the daemon is a black box; needed before R-110 examples are demonstrable.

## Users & Stakeholders

**Primary:** The operator at the terminal. **Secondary:** Cortex (future remote caller of the same command subjects); R-106 handlers (the CLI is their transport).

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | `reflex` binary (Bun, commander.js) with subcommands: `status`, `list [--target --kind]`, `fire <blueprint-id> [--input json]`, `approve <decision-id>`, `deny <decision-id>`, `pending`, `history [--blueprint --since]`, `test <blueprint-id> [--impulse file]`, `validate [path]` | Design §8 |
| FR-2 | Transport: myelin request-reply on per-command subjects derived under the Reflex command namespace; daemon registers one handler per command | Decision 7, R-101 |
| FR-3 | Request/response payloads are versioned JSON (`{v: 1, …}`); responses carry `{ok, data}` or `{ok: false, error: {code, message, hint?}}` | Cortex forward-compat |
| FR-4 | `validate` runs entirely local (R-102 validator) — works with no daemon and no NATS | Design §8 |
| FR-5 | `test` returns the Dry Run Verdict verbatim (predicted outcome + reasons) and renders it distinctly from real decisions ("would fire", "would block: cooldown until …") | Grill 21 |
| FR-6 | Daemon-down behavior: request timeout (3s default, `--timeout` flag) → exit 2 with hint ("daemon not reachable on <subject> — is reflex-daemon running? check NATS at <url>") | Operator UX |
| FR-7 | Output: human tables by default; `--json` on every command emits the raw response data for scripting | Scripting |
| FR-8 | Exit codes: 0 success; 1 domain error (unknown id, conflict, validation failure); 2 transport/daemon unreachable | Scripting |
| FR-9 | `status` renders: daemon version, uptime, blueprint count by kind, waiting Matched count, bus metrics (R-101 FR-10), next 3 scheduled ticks (R-105 FR-6) | Design §8 |
| FR-10 | `history` renders decision rows (outcome, blueprint, time, reason, actor) newest-first, default limit 50 | Design §8 |
| FR-11 | Vocabulary discipline: command verb `pending` is the friendly surface; all output text says "Matched Decisions awaiting approval" — code identifiers use canonical terms | Grill 19 |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Command round trip (daemon up, local NATS) | < 300ms p95 |
| NFR-2 | CLI cold start (Bun) | < 150ms to argument error |
| NFR-3 | Offline tests | command handlers + rendering tested against stub transport; no NATS in `bun test` |
| NFR-4 | Help quality | every command has `--help` with one usage example |

## Acceptance Scenarios

**Scenario 1: Status round trip**
**Given** a running daemon with 3 blueprints and 1 waiting Matched Decision
**When** `reflex status` runs
**Then** output shows blueprint counts, "1 Matched Decision awaiting approval", and bus metrics, exit 0

**Scenario 2: Fire returns the decision verdict**
**Given** blueprint `f-testing` (policy auto, no guards)
**When** `reflex fire f-testing --input '{"suite":"smoke"}'` runs
**Then** output shows the Fired decision id and exit 0
**And** `reflex history --blueprint f-testing` lists that decision first

**Scenario 3: Daemon down is a clear exit-2**
**Given** no daemon running
**When** `reflex pending` runs
**Then** after ≤3s it exits 2 with the unreachable hint naming the command subject

**Scenario 4: JSON mode is script-safe**
**Given** a running daemon
**When** `reflex list --json` runs
**Then** stdout is a single JSON document (no tables, no log lines) parseable by `jq`

**Scenario 5: validate needs nothing running**
**Given** NATS stopped and no daemon
**When** `reflex validate ./examples` runs against one bad file
**Then** exit 1 with the R-102 error block; no network attempted

**Scenario 6: Conflict surfaces the real state**
**Given** decision `d1` already denied
**When** `reflex approve d1` runs
**Then** exit 1 with error code `conflict` and message naming the denied state

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| Unknown subcommand / flag | commander usage error, exit 1, help hint |
| `--input` not valid JSON | local error before any request, exit 1 |
| Response `v` newer than CLI understands | Render warning + raw JSON fallback, exit 0 |
| Two daemons on one bus (misconfig) | request/reply returns first responder; `status` shows daemon instance id so the operator can detect duplicates |
| Large history (--since 30d) | server-side limit + `--limit` flag; truncation noted in output |
| Creds valid for CLI but daemon absent vs creds invalid | distinguishable: auth error (exit 2, creds hint) vs timeout (exit 2, daemon hint) |

## Success Criteria

**Definition of Done:**
- [ ] All six scenarios green (stub transport for 1/2/4/6; real NATS integration for 3; offline for 5)
- [ ] Exit-code contract proven across every command (matrix test)
- [ ] `--json` output parseable on every command (jq round-trip test)
- [ ] Help text + example present for all 9 commands
- [ ] Vocabulary check: no banned terms in output strings (grep gate: trigger, overlap, webhook, cue)
- [ ] `bun test` offline green

## Scope

### In Scope
CLI binary, command parsing, request/reply client + daemon-side command router, response schema v1, rendering (tables + JSON), exit codes, timeouts.

### Explicitly Out of Scope
- The command business logic (R-106 handlers; R-104 dry-run; R-102 validate — this feature wires and renders)
- Cortex integration (same subjects, later consumer)
- Shell completions, man pages (post-v0)

## Assumptions

- Single daemon per network in v0; instance id in status covers accidental duplicates
- commander.js per stack preferences

## Open Questions

- [ ] None blocking.
