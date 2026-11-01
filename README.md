# Reflex

The activation runtime of the metafactory ecosystem. Reflex evaluates **Activation Blueprints** against **Impulses** (schedules, bus events, webhooks, manual fires) and — after policy, approval, and guard checks — emits **Activation Events** that start Execution Runs in Pulse.

Reflex initiates work; it never orchestrates it.

> Formerly `the-metafactory/cue` — renamed 2026-06-10. The domain vocabulary lives in `meta-factory/CONTEXT.md`; "cue" is retired everywhere.

## Design

- [Reflex v0 design](docs/design-reflex-v0.md) — architecture, decision pipeline, wire protocol, CLI
- Feature graph: [blueprint.yaml](blueprint.yaml) (R-100…R-110)

## Configuration

An Activation Blueprint may declare `serves: {goal: "G1", node: "the-metafactory/soma#781"}` beside `target`; either ID may be supplied alone. The strict object requires at least one ID, each 1–200 characters without whitespace or control characters. Use goal IDs only; goal text stays in soma-home. Every `reflex.activation.fired` envelope carries the declaration as `payload.serves`, beside `payload.target` and outside the Activation Payload (`payload.payload`), for the runner to consume. Omitting `serves` leaves it absent from the fired payload.

The daemon (`reflex-daemon`) and the CLI (`reflex`) read a YAML config file, overlaid by `REFLEX_*` env vars (env wins).

| Setting | Default | Meaning |
|---|---|---|
| `REFLEX_CONFIG` (env) | `~/.config/reflex/config.yaml` | Config file to read. Empty counts as unset. If it names a file that does not exist, the daemon and CLI exit non-zero naming the path; they never fall back to env-only config. |
| `state_dir` (config) | `$XDG_STATE_HOME/reflex`, else `~/.local/state/reflex` | Directory holding the daemon's `reflex.db`. A leading `~/` expands. |
| `nats.timeout_ms` / `REFLEX_NATS_TIMEOUT_MS` | `10000` | Positive integer milliseconds for stream management and JetStream publish acknowledgements (daemon and edge). |
| `--timeout <ms>` / `REFLEX_REQUEST_TIMEOUT_MS` | `15000` | CLI daemon request timeout in positive integer milliseconds. The flag overrides the environment variable. |

A CLI request timeout does not cancel daemon work: the request was sent and the
daemon may still act on it. Check `reflex history` or `reflex service logs` before
retrying a command such as `reflex fire`.

Daemon stream startup retries timeouts up to ten attempts, waiting 1, 2, 4, 8,
16, then 30 seconds between attempts. Only an explicit stream-not-found response
permits creation; existing streams stay unchanged. Other errors fail immediately.
Exhausted timeouts exit non-zero so the existing service supervisor can restart it.

### Two instances on one machine

Each instance needs its own config file, its own `stack`, and its own `state_dir`, so the two never share a config or a DB:

```yaml
# ~/.config/reflex/personal.yaml
principal: jc
stack: personal
state_dir: ~/.local/state/reflex-personal
activations_dir: /Users/jc/.config/reflex/personal-activations   # no ~/ expansion here
```

Only `state_dir` expands `~/`; give `activations_dir` and `watch_roots` absolute paths. Without its own `activations_dir`, the second instance loads the default instance's blueprints and fires them too.

```sh
reflex-daemon                                                     # default instance
REFLEX_CONFIG=~/.config/reflex/personal.yaml reflex-daemon        # personal instance
REFLEX_CONFIG=~/.config/reflex/personal.yaml reflex status        # CLI against the personal instance
```

The CLI never opens the DB; it reaches its daemon over the bus, addressed by the config's `principal` and `stack`.

### Running the second instance as a service

`reflex service` manages the default service. Add `--instance <name>` to manage a named one next to it:

```sh
reflex service install --instance personal --config ~/.config/reflex/personal.yaml
reflex service status --instance personal
reflex service logs --instance personal --follow
reflex service uninstall --instance personal
```

| | Default | `--instance personal` |
|---|---|---|
| launchd label | `ai.meta-factory.reflex` | `ai.meta-factory.reflex.personal` |
| plist | `~/Library/LaunchAgents/ai.meta-factory.reflex.plist` | `~/Library/LaunchAgents/ai.meta-factory.reflex.personal.plist` |
| systemd unit | `reflex.service` | `reflex-personal.service` |
| logs (macOS) | `~/.config/reflex/logs/` | `~/.config/reflex/logs/personal/` |
| `REFLEX_CONFIG` in the unit | not set | the `--config` path, made absolute |

`install --instance` needs `--config` naming an existing, valid config that sets `state_dir` (read as the unit will: the file alone, no `REFLEX_*` overlay); without `state_dir` the two daemons would share one `reflex.db`. Instance names match `^[a-z0-9][a-z0-9-]{0,31}$`; any other name fails before a file or `launchctl` is touched. Every verb with `--instance` acts on that service only.

## Scheduled routines

`reflex routine` sends requests to the configured Reflex instance; the daemon owns the files. Configure a read-only target discovery command before adding routines:

```yaml
routine_target_command: [cortex, reflex, targets, --config, /absolute/stack/cortex.yaml, --json]
routine_target_timeout_ms: 10000
```

Cortex loads its normal composed configuration and returns only `{"targets":["@principal/process"]}`. Reflex executes the configured argv without a shell, caps each output stream at 64KiB and refuses nonzero exits, timeouts, malformed JSON and unknown targets before writing. Do not put credentials in command arguments. An absent command disables routine creation without changing existing activations.

```sh
reflex routine add --id weekly-review --schedule "0 17 * * 5" --timezone Europe/Zurich --target @principal/process --payload '{}' --json
reflex routine list --json
reflex test weekly-review --json
reflex routine set-policy weekly-review auto
reflex routine set-policy weekly-review approve
reflex routine remove weekly-review
```

New routines default to `approve`, mapped at the CLI boundary to the canonical activation policy `approval`; each scheduled fire waits for approval. JSON responses use `approval`. Only an explicit `auto` promotion permits automatic firing. Removal and demotion to `approve` remain available during discovery outages. `routine list` includes schedule, timezone, policy, target and the last recorded decision; Dry Runs do not create history.

`routines_dir` defaults to `<activations_dir>/routines`, making separate activation directories keep separate routines. The daemon watches this additional directory and reloads additions, policy changes and removals. Only regular activation files carrying the generated-routine marker can be removed or changed with these verbs. Existing hand-written activations keep their behavior.

For an already composed flow, add `--flow-file /path/to/flow.yaml`. The CLI transmits its contents; Reflex stores a marked copy at `<routines_dir>/flows/<id>.yaml` and supplies that absolute path as `payload.flow`. Do not also supply `payload.flow`. Reflex checks the flow document's basic shape and preserves its original YAML bytes after the ownership marker, including Pulse's sovereignty and residency annotations. It validates the activation with its loader and Dry Run, installs the flow before committing the activation, and rolls back a newly created flow if activation installation fails. It removes only its own marked flow alongside its activation. Pulse remains responsible for composition, whole-flow validation and execution. Flow storage alone does not execute anything.

Routine mutations coordinate across owner instances through per-routine `<routines_dir>/.<id>.write-lock` files. A competing owner write refuses while that lock is held. An interrupted writer leaves its lock in place; an operator must verify that writer has stopped before removing the stale lock. Revision checks protect updates through the owner interfaces. Direct filesystem editing is outside that coordination protocol.

`routine list --json` includes every scheduled activation in the configured discovery roots, including external and disabled definitions. External definitions are read-only. `routine inspect <id> --json` returns a revision and a redacted flow view when an inspection command is configured:

```yaml
routine_flow_contract_command: [pulse, routine-contract]
```

The command receives `{yaml, patches}` on stdin and returns `{view, yaml?}`. Pulse owns the editable field schema, redaction and validation. Unclassified values stay hidden. A missing command leaves inspection and editing unavailable; it does not hide the routine from inventory.

`routine update <id> --revision <sha256> --patches '<json array>' --json` applies only schema-declared parameter patches to a generated, regular, owner-marked flow. A patch has a `path` array and a scalar `value`, for example `{"path":["actions",0,"retry","attempts"],"value":3}`. The revision covers activation and flow bytes. Updates serialize with existing routine writes, recheck the revision after validation and atomically replace only the flow. Schedule, policy and activation payload stay unchanged. Editing performs no Dry Run or execution. After a changed revision, refresh before retrying.

## Boundaries

| Reflex does | Reflex does not |
|---|---|
| Evaluate activation rules | Orchestrate runs (Pulse) |
| Record every Activation Decision | Inspect target blueprint internals |
| Enforce activation guards (cooldown, run lock, idempotency) | Enforce Runtime Policy (Spawn) |
| Emit `mf.{net}.reflex.activation.fired.*` | Cancel running executions (Cortex) |

## Stack

TypeScript + Bun · NATS JetStream (CloudEvents v1.0, DD-68) · SQLite + Drizzle · zod
