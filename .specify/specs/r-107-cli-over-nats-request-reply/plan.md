# Plan: R-107 CLI over NATS Request/Reply

**Spec:** `spec.md` (80%) · **Date:** 2026-06-10 · **Decision 7:** one protocol — CLI is a thin NATS client; Cortex later issues identical commands.

## Architecture

```
src/
  cmd/
    protocol.ts     # versioned request/response JSON shapes {v:1, ...} + subject helper (FR-2, FR-3)
    router.ts       # daemon-side: subscribeReplyable per command → CommandHandlers/status (FR-2, FR-9)
  cli/
    client.ts       # request() over a short-lived ReflexBus; timeout → typed transport error (FR-2, FR-6)
    render.ts       # human tables + --json mode + exit-code mapping (FR-7, FR-8, FR-11)
    main.ts         # commander program: 9 subcommands (FR-1, FR-4, FR-5)
  bin/reflex.ts     # CLI entry
  daemon.ts         # starts CommandRouter; daemon instance id in status (edge: duplicate daemons)
test/cmd/router.test.ts  test/cli/render.test.ts  test/cli/e2e.test.ts (InMemory end-to-end CLI core)
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | commander program `reflex` with status/list/fire/approve/deny/pending/history/test/validate; help + one example per command |
| FR-2 | Subjects: `local.{principal}.{stack}.reflex.cmd.{command}` (myelin-aligned literal with alignment validated in tests); daemon router `subscribeReplyable` per command; CLI `bus.request(input, subject)` |
| FR-3 | `protocol.ts`: `CmdRequest {v: 1, args}` / `CmdResponse {v: 1, ok, data?, error?}` — handler `HandlerResult` passes through verbatim; unknown future `v` → warning + raw JSON (FR edge) |
| FR-4 | `validate`: local `validatePaths` only — no bus construction at all (code path proves NFR: works with NATS down) |
| FR-5 | `test <blueprint-id>`: router calls `pipeline.evaluateDry` with a manual impulse (or `--impulse file` JSON); renders verdict distinctly ("would fire", "would block: …") |
| FR-6 | CLI timeout default 3000ms (`--timeout`); timeout/connect failure → exit 2 with daemon-unreachable hint naming subject + NATS url; auth-style errors distinguished by message |
| FR-7 | `--json` on every command: single JSON document on stdout, no tables/logs |
| FR-8 | Exit codes: 0 ok; 1 domain error (handler `ok:false`, validate failures); 2 transport (timeout/conn). Mapped in one function, matrix-tested |
| FR-9 | `status` response: daemon version (package.json), instanceId (uuid per start), uptime, blueprint counts by kind, waiting count, bus metrics, next 3 ticks |
| FR-10 | `history [--blueprint --since --limit]`: router → `repo.historyFor`; rendered newest-first, server limit 200 |
| FR-11 | Output strings audited: command verb `pending` allowed; table headers say "Matched Decisions awaiting approval"; vocabulary grep gate extended to src/cli + src/cmd |
| NFR-1/2 | Round-trip measured in e2e test (InMemory) < 300ms; cold start not separately asserted (bun startup, no meaningful gate offline) — documented |
| NFR-3 | `bun test` offline: router+client over InMemory transport end-to-end; no NATS |
| NFR-4 | Help assertions: every command's `--help` contains "Example:" |

## Data Flow

```
reflex CLI (bin/reflex.ts → cli/main.ts)
  ├─ validate ──► activation/validate-cli (local, no bus)
  └─ others ───► cli/client.request(subject, {v:1,args}) ── NATS req/reply ──► cmd/router (daemon)
                                                                  └─► CommandHandlers / pipeline.evaluateDry / repo.historyFor / status snapshot
```

## Data Model (protocol v1)

```ts
type CmdRequest = { v: 1; args: Record<string, unknown>; actor: ReflexActor };
type CmdResponse = { v: 1; ok: boolean; data?: unknown; error?: { code: string; message: string; currentState?: string } };
// error.code: handler codes (not-found|conflict|invalid-input|internal) — exit 1; transport failures never produce a CmdResponse — exit 2.
```

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| Daemon down | request timeout | exit 2 + hint (subject, url, "is reflex-daemon running?") | none |
| NATS down | connect error | exit 2 + creds/url hint (distinct message from timeout) | none |
| Unknown subcommand/flag | commander | usage error exit 1 | none |
| Malformed --input | local JSON.parse | exit 1 before any request | none |
| Response v newer than CLI | version check | warning + raw JSON, exit 0 | none |
| Two daemons one bus | request/reply first-responder | status shows instanceId — operator detects duplicates | observability only |
| Router handler throws | subscribeReplyable containment (R-101) + HandlerResult internal mapping | requester times out OR gets internal error; daemon alive | one request |
| Huge history | server limit 200 + `--limit` | truncation noted in output | none |

## Test Assertions (verifiability)

- `router.test.ts`: each command subject answers over InMemory; fire→fired data shape; approve conflict passes `currentState` through; unknown command subject → no subscription (nothing to assert — commands enumerated); status contains instanceId + blueprint counts; history respects limit.
- `cli/e2e.test.ts` (CLI core functions against live router, InMemory): runCommand("fire", …) exit 0 + decision id on stdout; runCommand("pending") renders canonical header text; timeout path (no router) → exit 2 + hint; `--json` parses via JSON.parse for every command (matrix).
- `render.test.ts`: exit-code mapping matrix {ok→0, handler error→1, transport→2}; banned-vocabulary grep over all render strings; response v=2 → warning + raw passthrough.
- Live check at verify: `reflex status` against running daemon on real NATS (manual evidence, like R-105 milestone).

## Constitutional Compliance (commitments, verified at done gate)

CLI-First — this IS the CLI ✓; Library-First — protocol/router/client exported module-level (root opaque); Test-First — RED per task; Deterministic — fixed subjects, versioned protocol; Code Before Prompts.

## Implementation Order (→ tasks.md)

T-1 protocol + subjects → T-2 daemon router (status/history/test included) → T-3 CLI client + exit mapping → T-4 commander program + render → T-5 e2e matrix + gates + live evidence.

## Dependencies / Risks

All deps merged. Risk: request/reply reply-path shape (proven in R-101 tests). Cold-start NFR un-gated offline — noted honestly.
