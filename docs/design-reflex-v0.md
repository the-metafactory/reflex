# Reflex v0 — Design

**Date:** 2026-06-10 (language pass: same day, grill session)
**Status:** Decided — interactive design session + domain-language grill (JC + Ivy)
**Supersedes:** cue repo issue #1 spec sketch (this repo was `the-metafactory/cue` until 2026-06-10)
**Domain model:** `meta-factory/CONTEXT.md` (Activation section) + `reflex/CONTEXT.md` (Reflex-local terms) — this doc uses that vocabulary verbatim
**Decisions referenced:** DD-62 (standalone activation artifacts), DD-67 (NATS + JetStream), DD-68 (CloudEvents envelope), DD-70 (subject hierarchy), DD-72 (NATS accounts from day one)

---

## 1. What Reflex Is

Reflex is the **activation runtime** of the metafactory ecosystem. It evaluates **Activation Blueprints** against **Impulses** and, when a rule fires, emits an **Activation Event** that starts an **Execution Run** in Pulse.

Hard boundaries (from CONTEXT.md, non-negotiable):

- Reflex **initiates** an Execution Run but does not orchestrate it (Pulse does).
- Reflex does not inspect the internal steps of the target Execution Blueprint.
- Reflex does not enforce Runtime Policy (Spawn does).
- A Reflex **Dry Run** emits no Activation Events.
- Every run Reflex starts is an **Activated Run** — there is no guard-bypass path. A **Manual Run** is a run started outside Reflex entirely.

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

**Naming principle (grill session): friendly surface, canonical core.** Operator-facing surfaces (CLI verbs, config keywords like `when:`) may use approachable words; every identifier beneath them (code, wire, storage, prose) uses the canonical domain term. `reflex/CONTEXT.md` records each mapping. "Trigger", "event"/"webhook" (as impulse names), "overlap", and "pending" (outside the CLI verb) are banned vocabulary.

## 3. Architecture

```
IMPULSE SOURCES                 REFLEX DAEMON                          DOWNSTREAM
───────────────                ───────────────                        ──────────
schedule (cron)    ─┐
manual (CLI fire)  ─┤   Impulse → Rule Evaluation
bus (NATS sub)     ─┤              │
http (listener)    ─┘              ▼
                        Activation Decision  (every real evaluation recorded:
                        ignored | matched | blocked | fired | denied | expired)
                                   │
                        Activation Policy    (auto | approval | disabled)
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

1. An **Impulse** arrives from an **Impulse Source** (`schedule`, `manual`, `bus`, `http`).
2. Each **Activation Blueprint** whose rule's impulse selector matches is evaluated → produces exactly one **Activation Decision**. Decisions are **immutable** — a verdict of one evaluation, never mutated into a different outcome later.
3. Outcomes (six, per upstream taxonomy):
   - **Ignored Decision** — condition did not match. Recorded as per-blueprint counters for observability.
   - **Matched Decision** — condition matched; **Activation Policy** says `approval`. **The only non-terminal outcome** — it resolves to Fired, Denied, or Expired.
   - **Blocked Decision** — condition matched, policy allowed, but an **Activation Guard** prevented firing (cooldown active, run lock held, duplicate idempotency key). Strictly a guard outcome.
   - **Fired Decision** — guards passed; **Activation Event** emitted.
   - **Denied Decision** — a Matched Decision terminally refused by an **Approver**.
   - **Expired Decision** — a Matched Decision whose approval window lapsed (per-blueprint `approval_timeout`, default `1h`).
4. **Activation Approval**: `reflex approve <decision-id>` converts Matched → guard check → Fired. `reflex deny <decision-id>` produces a Denied Decision. Single-operator trust in v0 — anyone with NATS creds for the network is an Approver.
5. The Activation Event carries: target Execution Blueprint reference, **Activation Payload** (shaped toward the target's Run Contract), **Idempotency Key**, and a link back to the Activation Decision.

### Guards (v0 set)

| Guard | Behavior |
|---|---|
| **Cooldown** | `cooldown: 15m` — blueprint cannot fire again within window; violation → Blocked Decision |
| **Run Lock** | At most one in-flight run per blueprint. Conflict mode: `skip` (conflicting impulse → Blocked Decision) or `buffer` (conflicting impulse becomes the **Buffered Impulse**). **No Run Lock declared = concurrent runs allowed.** |
| **Idempotency Key** | Derived `hash(blueprint_id + payload-identity-fields)`; duplicate within window → Blocked Decision |

A `cancel` conflict mode is **rejected** — stopping a running execution is a Cortex Control Command / Pulse concern; Reflex initiating a cancel would violate its boundary.

**Buffered Impulse semantics:** depth 1, newest replaces older. The buffering evaluation itself records a terminal Blocked Decision. When the run-outcome event releases the lock, the held impulse is **re-presented**: a fresh Activation Decision is produced, **all guards re-run** (a meanwhile-engaged cooldown blocks it too), and the new decision links to the Blocked Decision that buffered it. Buffer requires Reflex to observe run completion: it subscribes to `mf.{net}.pulse.run.>` outcome events (P-503) and matches on the correlation id it stamped into the Activation Event.

## 4. Impulse Sources (v0)

One **When Block** (`when:`) per blueprint declares its **Impulse Source**. Canonical **Impulse Kinds**:

| Kind | Impulse | Notes |
|---|---|---|
| `schedule` | Internal Impulse from the daemon's scheduler | Cron expression + timezone. |
| `manual` | Impulse produced by `reflex fire <blueprint-id>` | Payload via `--input`. Goes through the full pipeline — never starts a run directly. |
| `bus` | External Impulse from a NATS subscription | Subject pattern (e.g. `mf.{net}.grove.agent.task.completed`) + flat field-equals conditions on CloudEvents `data`. No expression language in v0. |
| `http` | External Impulse from the daemon's HTTP listener | Localhost endpoint auto-generated per `http` blueprint (`POST /hook/{blueprint-id}`), bearer-token auth only. Windmill pattern, deliberately minimal. |

Deferred: state-condition impulses (polling), intent impulses, composed/boolean rules — earn them through proven need (per cue-architecture.md).

## 5. Configuration

Two surfaces, both live from day one, merged at load:

1. **Sidecar:** `reflex.yaml` next to a `flow.yaml` — that flow's Activation Blueprint(s). Ergonomic, co-located.
2. **Central:** `~/.config/reflex/activations/*.yaml` — blueprints fully decoupled from flow location (pure late binding, cross-target rules).

**One configuration entry = one Activation Blueprint** (exactly one implicit Activation Rule in v0; multi-rule blueprints are a later extension inside the same entry). `id:` names the blueprint.

**Precedence:** none — surfaces are merged; a duplicate blueprint `id` across any loaded file is a **load error** (fail loud, no silent shadowing).

**Hot-reload is mandatory:** daemon watches configured roots + the central dir; a change atomically swaps the blueprint set. In-flight decisions are unaffected; Matched Decisions for a removed blueprint become Expired Decisions with reason `blueprint-removed`.

### Sketch — `reflex.yaml`

```yaml
schema: metafactory/activation/v1
activations:
  - id: pr-stats-daily
    target: "@jc/f-pr-stats"          # Execution Blueprint ref
    when:
      schedule: "0 7 * * *"
      timezone: Europe/Zurich
    policy: auto                       # auto | approval | disabled
    guards:
      cooldown: 6h
      run_lock: skip                   # skip | buffer; omit = concurrent allowed
    payload:
      mode: daily

  - id: pilot-scan
    target: "@jc/pilot-scan"
    when:
      bus:
        subject: "mf.{net}.grove.agent.task.completed"
        where: { flow: review }        # flat field-equals on CloudEvents data
    policy: approval
    approval_timeout: 1h
    guards:
      run_lock: buffer
```

## 6. Storage

**SQLite + Drizzle**, single file (`~/.local/state/reflex/reflex.db`).

Tables (v0): `decisions` (every real evaluation outcome + timestamps + impulse snapshot; immutable rows), `approvals` (matched/approved/denied/expired lifecycle), `guard_state` (cooldown expiries, run locks, buffered impulses, idempotency keys with TTL), `fired_events` (emitted Activation Events + correlation ids, for `reflex history` and buffer re-presentation).

Ignored Decisions are recorded as counters per blueprint (not full rows) to keep the table from drowning in scheduler ticks. **Dry Run Verdicts are not stored in decision history** (see §7).

## 7. Wire Protocol

**Revised 2026-06-10 (decision 22): Reflex rides myelin.** The original framing (CloudEvents v1.0 per DD-68, literal `mf.{net}.reflex.activation.>` subjects per DD-70) is superseded — those DDs were decided 2026-04 but never implemented; the ecosystem converged on `@the-metafactory/myelin` instead (cortex, grove, sage, and pilot all ship on it). All Reflex events are **MyelinEnvelope**s; subjects are derived via myelin `deriveNatsSubject(envelope)` under the myelin namespace (`local.{principal}.{stack}.{domain}.{entity}.{action}`), never hand-built. NATS accounts + per-component creds per DD-72 (`~/.config/nats/creds/reflex.creds`) still apply.

**Publishes (envelope types):**

| Type | When |
|---|---|
| `reflex.activation.fired` | Fired Decision commits to starting a run — carries target Execution Blueprint ref, Activation Payload, Idempotency Key, decision link, fresh `correlation_id` |
| `reflex.activation.decision.{outcome}` | Matched/Blocked/Denied/Expired decisions (audit, Miner provenance; Ignored not published) |

Tracing rides myelin first-class `correlation_id`; causation + actor identity ride `extensions.causation_id` / `extensions.actor`. Sovereignty classification `local` by default; envelopes unsigned in v0 (matching pulse demo-bus practice).

**Consumes:**

| Subscription | Why |
|---|---|
| Per-blueprint `bus` subjects (myelin-derived) | Bus impulse matching |
| Pulse run-lifecycle subjects | Run outcomes for Run Lock release + Buffered Impulse re-presentation |
| Reflex command subjects | CLI request/reply (below) |

**Dry Run:** `reflex test <blueprint-id> [--impulse file.json]` evaluates the full pipeline and reports a **Dry Run Verdict** — the predicted decision outcome ("would fire", "would block: cooldown until 18:00"). A Dry Run Verdict mutates no guard state, emits no events, and is not part of decision history. Activation Decisions record only real evaluations.

## 8. CLI

CLI talks to the daemon over **NATS request/reply** on `mf.{net}.reflex.cmd.*` — no second protocol; Cortex can later issue identical commands remotely.

```
reflex status                          # daemon health, blueprint count, matched-awaiting-approval count
reflex list [--target|--kind]          # loaded activation blueprints
reflex fire <blueprint-id> [--input]   # produce a manual impulse (full pipeline — no bypass)
reflex approve <decision-id>
reflex deny <decision-id>
reflex pending                         # Matched Decisions awaiting approval (friendly verb; canonical term is Matched)
reflex history [--blueprint|--since]   # decision/fire history
reflex test <blueprint-id>             # dry run → Dry Run Verdict
reflex validate [path]                 # load + schema-check config without daemon
```

`add`/`remove` from the old spec are dropped — config is files; editing YAML + hot-reload IS add/remove.

## 9. Stack

TypeScript + Bun. Dependencies: `@nats-io/transport-node` + `@nats-io/jetstream` (via transport abstraction, DD-69 pattern), `drizzle-orm` + SQLite, `zod` for config/envelope validation, `croner` (or equivalent) for cron. Tests run with `InMemoryTransport` — `bun test` needs no live NATS (P-501 NFR-4 precedent).

## 10. Out of Scope (v0)

- State / intent / composed impulse kinds
- Activation Blueprints as published registry artifacts (config is local files; registry packaging is a later iteration aligned with DD-62 Phase 1/2)
- Multi-approver / role-based approval (Cortex territory)
- Cross-network activation routing (Stage 4, S-025)
- HTTP impulse auth beyond bearer token; public endpoint exposure
- `cancel` run-lock mode (boundary violation)
- Guard-bypass / `--force` fire (deliberately absent; forcing past guards = direct Pulse/Cortex invocation, visible in audit as a Manual Run)
- Federation specifics (subject namespace `mf.{operator}.reflex.>` reserved now; leaf-node config later)

## 11. Paired Work

- **pulse:** update P-501 — consume `mf.{net}.reflex.activation.fired.>`, rename `CueSubscriber` → `ActivationSubscriber`, event type `reflex.activation.fired` (pulse#27)
- **meta-factory:** CONTEXT.md amended (grill session 2026-06-10): Decision taxonomy extended with **Denied Decision** + **Expired Decision**; Matched declared the only non-terminal outcome. DD-67/70/71 examples mention `cue.fired` — annotate with rename note on next DD pass (naming only)

## 12. Design Session Decisions

### Structure session (2026-06-10, morning)

| # | Decision | Rejected alternatives |
|---|---|---|
| 1 | Full wire rename to `mf.{net}.reflex.activation.>` now | Keep `cue.fired` legacy wire name; component-neutral `mf.{net}.activation.>` |
| 2 | GH repo `cue` renamed to `reflex` (history + issue #1 preserved) | Fresh repo |
| 3 | Full decision pipeline incl. approval in v0 | Minimal fire path; decisions-without-approval |
| 4 | Impulse kinds: schedule + manual + bus (+ minimal http) | Schedule+manual only; state impulses |
| 5 | Config: sidecar `reflex.yaml` AND central dir, merged, dup id = error | Sidecar-only; central-only |
| 6 | SQLite + Drizzle for all daemon state | JSONL + memory; JetStream KV |
| 7 | CLI over NATS request/reply | Unix socket; direct DB |
| 8 | Approval TTL expiry (default 1h), CLI approve/deny | Wait forever; expiry + re-match collapse |
| 9 | Run Lock modes skip + buffer; cancel rejected | All four Temporal modes; skip-only |
| 10 | Bus match: subject pattern + flat field-equals | Subject only; JSONPath/CEL |
| 11 | Pulse P-501 issue filed immediately | Defer until pulse work resumes |
| 12 | Minimal http impulse in v0 (localhost, bearer token) | Defer to v1 |

### Language grill (2026-06-10, afternoon) — see `reflex/CONTEXT.md`

| # | Decision | Rejected alternatives |
|---|---|---|
| 13 | One config entry = one Activation Blueprint (one implicit rule in v0) | Entry = rule, file = blueprint |
| 14 | Config keyword `when:` (friendly surface); "trigger" banned | `impulse:` (canonical key); `source:` (CloudEvents collision) |
| 15 | Impulse Kinds: `schedule \| manual \| bus \| http` | `event` (banned upstream); `webhook` (banned upstream) |
| 16 | Upstream taxonomy extended: Denied + Expired Decisions; Matched only non-terminal | Fold into Blocked with reasons; Reflex-local sub-states |
| 17 | `reflex fire` produces a manual Impulse; every Reflex-started run is an Activated Run; no bypass | `--force` guard bypass; fire-as-Manual-Run |
| 18 | Buffer holds a **Buffered Impulse**; decisions immutable; re-presentation = fresh decision, all guards re-run | Non-terminal Blocked Decision converting to Fired |
| 19 | `reflex pending` kept as friendly CLI verb; "pending" banned elsewhere | `reflex matched`; `reflex approvals` |
| 20 | Config key `run_lock: skip \| buffer`, absence = concurrent allowed; "overlap" banned | `overlap:` with `allow` value |
| 21 | Dry Run produces a **Dry Run Verdict** — not an Activation Decision, no guard mutation, not in history | Flagged dry decisions in the audit log |

### Spec session (2026-06-10, evening)

| # | Decision | Rejected alternatives |
|---|---|---|
| 22 | Wire = **myelin**: `@the-metafactory/myelin` git-pinned for transport, MyelinEnvelope, derived subjects, request-reply. DD-68 CloudEvents + DD-70 literal `mf.*` subjects superseded (never implemented; cortex/grove/sage/pilot all on myelin). Operator-directed, codebase-verified | Reflex-local transport build (interview answer, reversed same day); CloudEvents per DD-68 |
