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

## Boundaries

| Reflex does | Reflex does not |
|---|---|
| Evaluate activation rules | Orchestrate runs (Pulse) |
| Record every Activation Decision | Inspect target blueprint internals |
| Enforce activation guards (cooldown, run lock, idempotency) | Enforce Runtime Policy (Spawn) |
| Emit `mf.{net}.reflex.activation.fired.*` | Cancel running executions (Cortex) |

## Stack

TypeScript + Bun · NATS JetStream (CloudEvents v1.0, DD-68) · SQLite + Drizzle · zod
