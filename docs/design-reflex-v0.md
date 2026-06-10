# Reflex v0 — Design

**Date:** 2026-06-10
**Status:** Decided — interactive design session (JC + Ivy)
**Supersedes:** cue repo issue #1 spec sketch (this repo was `the-metafactory/cue` until 2026-06-10)
**Domain model:** `meta-factory/CONTEXT.md` (Activation section) — this doc implements that vocabulary verbatim
**Decisions referenced:** DD-62 (standalone activation artifacts), DD-67 (NATS + JetStream), DD-68 (CloudEvents envelope), DD-70 (subject hierarchy), DD-72 (NATS accounts from day one)

---

## 1. What Reflex Is

Reflex is the **activation runtime** of the metafactory ecosystem. It evaluates **Activation Blueprints** against **Impulses** and, when a rule fires, emits an **Activation Event** that starts an **Execution Run** in Pulse.

Hard boundaries (from CONTEXT.md, non-negotiable):

- Reflex **initiates** an Execution Run but does not orchestrate it (Pulse does).
- Reflex does not inspect the internal steps of the target Execution Blueprint.
- Reflex does not enforce Runtime Policy (Spawn does).
- A Reflex **Dry Run** emits no Activation Events.

## 2. Naming — the Cue Rename

"Cue" is retired everywhere: project name, wire subjects, CLI, config files, code identifiers. The project/runtime is **Reflex**; the domain type is **Activation Blueprint** (CONTEXT.md flagged ambiguity, resolved 2026-04).

| Old (cue-era) | New (Reflex) |
|---|---|
| `mf.{net}.cue.>` | `mf.{net}.reflex.activation.>` |
| `cue.fired` event type | `reflex.activation.fired` |
| `cue.yaml` sidecar | `reflex.yaml` sidecar |
| `cue` CLI | `reflex` CLI |
| `CueSubscriber` (Pulse P-501) | `ActivationSubscriber` (paired pulse issue) |

Wire rename happens **now, before any code exists** — one-time spec churn instead of permanent vocabulary split. A paired pulse issue updates P-501.

## 3. Architecture

```
IMPULSE SOURCES                 REFLEX DAEMON                          DOWNSTREAM
───────────────                ───────────────                        ──────────
Scheduler (cron)   ─┐
CLI manual fire    ─┤   Impulse → Rule Evaluation
NATS event sub     ─┤              │
Webhook (HTTP)     ─┘              ▼
                        Activation Decision  (every evaluation recorded:
                        ignored | matched | blocked | fired)
                                   │
                        Activation Policy    (auto-fire | approval | disabled)
                                   │
                        Activation Approval  (CLI approve/deny, TTL expiry)
                                   │
                        Activation Guards    (cooldown, run lock, idempotency)
                                   │
                        Activation Event ──► mf.{net}.reflex.activation.fired.{target}
                                                        │
                                             Pulse consumes, starts Execution Run
```

The full pipeline ships in v0 — including approval. Decision records are first-class from day one because the decision model shapes storage; retrofitting an audit trail is the expensive path.

### Decision pipeline semantics

1. An **Impulse** arrives (internal: scheduler tick; external: NATS event, webhook, CLI fire).
2. Each **Activation Rule** whose impulse selector matches is evaluated → produces exactly one **Activation Decision**.
3. Outcomes:
   - **Ignored** — condition did not match. Recorded (counted, sampled) for observability.
   - **Matched** — condition matched; **Activation Policy** says `approval`. Decision waits.
   - **Blocked** — condition matched, policy allowed, but an **Activation Guard** prevented firing (cooldown active, run lock held, duplicate idempotency key).
   - **Fired** — guards passed; **Activation Event** emitted.
4. **Activation Approval**: `reflex approve <decision-id>` converts Matched → guard check → Fired. `reflex deny <decision-id>` terminates it. Per-rule `approval_timeout` (default `1h`) expires a pending Matched decision to terminal state `expired`. Single-operator trust in v0 — anyone with NATS creds for the network can approve.
5. The Activation Event carries: target Execution Blueprint reference, **Activation Payload** (shaped toward the target's Run Contract), **Idempotency Key**, and a link back to the Activation Decision.

### Guards (v0 set)

| Guard | Behavior |
|---|---|
| **Cooldown** | `cooldown: 15m` — rule cannot fire again within window; violation → Blocked decision |
| **Run Lock** | At most one in-flight run per rule. Overlap policy: `skip` (drop, Blocked), `buffer` (hold newest, fire when current run completes), `allow` (no lock) |
| **Idempotency Key** | Derived `hash(rule_id + payload-identity-fields)`; duplicate within window → Blocked |

`cancel` overlap policy is **rejected** — stopping a running execution is a Cortex Control Command / Pulse concern; Reflex initiating a cancel would violate its boundary.

Buffer requires Reflex to observe run completion: Reflex subscribes to `mf.{net}.pulse.run.>` outcome events (P-503) and matches on the correlation id it stamped into the Activation Event.

## 4. Trigger Types (v0)

| Type | Impulse source | Notes |
|---|---|---|
| `schedule` | Internal scheduler | Cron expression + timezone. Internal Impulse. |
| `manual` | CLI `reflex fire <rule>` | Programmatic activation; payload via `--input`. |
| `event` | NATS subscription | Subject pattern (e.g. `mf.{net}.grove.agent.task.completed`) + flat field-equals conditions on CloudEvents `data`. No expression language in v0. |
| `webhook` | Minimal HTTP listener | Localhost endpoint auto-generated per webhook rule (`POST /hook/{rule-id}`), bearer-token auth only. Windmill pattern, deliberately minimal. |

Deferred: state triggers (condition polling), intent triggers, composed/boolean triggers — earn them through proven need (per cue-architecture.md).

## 5. Configuration

Two surfaces, both live from day one, merged at load:

1. **Sidecar:** `reflex.yaml` next to a `flow.yaml` — that flow's Activation Blueprint(s). Ergonomic, co-located.
2. **Central:** `~/.config/reflex/activations/*.yaml` — blueprints fully decoupled from flow location (pure late binding, cross-target rules).

**Precedence:** none — surfaces are merged; a duplicate rule `id` across any loaded file is a **load error** (fail loud, no silent shadowing).

**Hot-reload is mandatory:** daemon watches configured roots + the central dir; a change atomically swaps the rule set. In-flight decisions are unaffected; pending approvals for a removed rule are expired with reason `rule-removed`.

### Sketch — `reflex.yaml`

```yaml
schema: metafactory/activation/v1
activations:
  - id: pr-stats-daily
    target: "@jc/f-pr-stats"          # Execution Blueprint ref
    trigger:
      type: schedule
      cron: "0 7 * * *"
      timezone: Europe/Zurich
    policy: auto                       # auto | approval | disabled
    guards:
      cooldown: 6h
      overlap: skip                    # skip | buffer | allow
    payload:
      mode: daily

  - id: pilot-scan
    target: "@jc/pilot-scan"
    trigger:
      type: event
      subject: "mf.{net}.grove.agent.task.completed"
      where:
        flow: "review"                 # flat field-equals on CloudEvents data
    policy: approval
    approval_timeout: 1h
    guards:
      overlap: buffer
```

## 6. Storage

**SQLite + Drizzle**, single file (`~/.local/state/reflex/reflex.db`).

Tables (v0): `decisions` (every evaluation outcome + timestamps + impulse snapshot), `approvals` (pending/approved/denied/expired), `guard_state` (cooldown expiries, run locks, idempotency keys with TTL), `fired_events` (emitted Activation Events + correlation ids, for `reflex history` and buffer matching).

Ignored decisions are recorded as counters per rule (not full rows) to keep the table from drowning in scheduler ticks.

## 7. Wire Protocol

All envelopes CloudEvents v1.0 per DD-68 (`mf*` extensions, `mfnetworkid` required). NATS accounts + per-component creds per DD-72 (`~/.config/nats/creds/reflex.creds`).

**Publishes:**

| Subject | Type | When |
|---|---|---|
| `mf.{net}.reflex.activation.fired.{target}` | `reflex.activation.fired` | Fired decision commits to starting a run |
| `mf.{net}.reflex.activation.decision.{outcome}` | `reflex.activation.decision` | Matched/Blocked/expired decisions (audit, Miner provenance; Ignored not published) |

**Consumes:**

| Subject | Why |
|---|---|
| Per-rule event subjects | Event trigger matching |
| `mf.{net}.pulse.run.>` | Run outcomes for buffer overlap + run-lock release |
| `mf.{net}.reflex.cmd.>` | CLI request/reply (below) |

**Dry Run:** `reflex test <rule> [--impulse file.json]` evaluates the full pipeline, records a decision flagged `dry_run`, emits **nothing**.

## 8. CLI

CLI talks to the daemon over **NATS request/reply** on `mf.{net}.reflex.cmd.*` — no second protocol; Cortex can later issue identical commands remotely.

```
reflex status                      # daemon health, rule count, pending approvals
reflex list [--target|--type]      # loaded activation rules
reflex fire <rule> [--input json]  # manual trigger
reflex approve <decision-id>
reflex deny <decision-id>
reflex pending                     # matched decisions awaiting approval
reflex history [--rule|--since]    # decision/fire history
reflex test <rule>                 # dry run
reflex validate [path]             # load + schema-check config without daemon
```

`add`/`remove` from the old spec are dropped — config is files; editing YAML + hot-reload IS add/remove.

## 9. Stack

TypeScript + Bun. Dependencies: `@nats-io/transport-node` + `@nats-io/jetstream` (via transport abstraction, DD-69 pattern), `drizzle-orm` + SQLite, `zod` for config/envelope validation, `croner` (or equivalent) for cron. Tests run with `InMemoryTransport` — `bun test` needs no live NATS (P-501 NFR-4 precedent).

## 10. Out of Scope (v0)

- State / intent / composed trigger types
- Activation Blueprints as published registry artifacts (config is local files; registry packaging is a later iteration aligned with DD-62 Phase 1/2)
- Multi-approver / role-based approval (Cortex territory)
- Cross-network activation routing (Stage 4, S-025)
- Webhook auth beyond bearer token; public webhook exposure
- Cancel overlap policy (boundary violation)
- Federation specifics (subject namespace `mf.{operator}.reflex.>` reserved now; leaf-node config later)

## 11. Paired Work

- **pulse:** update P-501 — consume `mf.{net}.reflex.activation.fired.>`, rename `CueSubscriber` → `ActivationSubscriber`, event type `reflex.activation.fired` (issue filed from this session)
- **meta-factory:** DD-67/70/71 examples mention `cue.fired` — annotate with rename note on next DD pass (no decision change, naming only)

## 12. Design Session Decisions (2026-06-10)

| # | Decision | Rejected alternatives |
|---|---|---|
| 1 | Full wire rename to `mf.{net}.reflex.activation.>` now | Keep `cue.fired` legacy wire name; component-neutral `mf.{net}.activation.>` |
| 2 | GH repo `cue` renamed to `reflex` (history + issue #1 preserved) | Fresh repo |
| 3 | Full decision pipeline incl. approval in v0 | Minimal fire path; decisions-without-approval |
| 4 | Triggers: schedule + manual + event (+ minimal webhook) | Schedule+manual only; state triggers |
| 5 | Config: sidecar `reflex.yaml` AND central dir, merged, dup id = error | Sidecar-only; central-only |
| 6 | SQLite + Drizzle for all daemon state | JSONL + memory; JetStream KV |
| 7 | CLI over NATS request/reply | Unix socket; direct DB |
| 8 | Approval TTL expiry (default 1h), CLI approve/deny | Wait forever; expiry + re-match collapse |
| 9 | Overlap: skip + buffer + allow; cancel rejected | All four; skip+allow only |
| 10 | Event match: subject pattern + flat field-equals | Subject only; JSONPath/CEL |
| 11 | Pulse P-501 issue filed immediately | Defer until pulse work resumes |
