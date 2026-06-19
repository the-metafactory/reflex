# Specification: F-002 — Internal heartbeat scheduler (DO-alarm on edge, timer/launchd on local)

> Tracked in the-metafactory/reflex#20. Generated from an interview on the open design forks; problem/context carried from the reflex#15 edge deploy session.

## Problem Statement

**Core problem.** Reflex's edge runtime delegates the schedule clock to Cloudflare Cron Triggers: every distinct `when.schedule` expression must be declared in `wrangler.toml [triggers].crons`, Cloudflare fires each expression, and `EdgeScheduleSource` (`src/edge/schedule.ts:56`) maps the fired expression back to blueprints by **string equality**. This couples scheduling to CF infrastructure and breaks in three ways observed live:

1. **Cron-trigger budget.** Cloudflare caps cron triggers at **5 per account** (`code 10072`). Each distinct expression burns a slot shared across ALL workers on the account. Deploying reflex with a 2nd cron failed — the account was already at the cap (counterscale, arbol-scuol-*, …).
2. **Registered ≠ executed.** A single `*/5 * * * *` registered within the limit but **never executed** across 6 ticks / ~30 min (tail saw 0 invocations, 0 Decision rows). CF free-plan crons are best-effort; high-frequency edge crons are unreliable.
3. **Authoring coupling + drift.** A blueprint whose expression isn't in `wrangler.toml` silently never ticks (only `unmatchedExpressions` hints). Adding a schedule blueprint needs a `wrangler.toml` edit + redeploy. Edge ignores blueprint `timezone` (UTC only).

**Urgency.** Blocking: scheduled Activation Blueprints are effectively unusable on edge today, and the account cron cap means the current design cannot scale past a handful of distinct expressions ecosystem-wide.

**Impact if unsolved.** Schedule-kind activations (a core reflex Impulse Kind, R-105) don't work in production on edge; the daily `0 7` and any future schedule are at the mercy of the shared 5-cron cap and CF best-effort execution.

## Users & Stakeholders

**Primary user.** Blueprint authors (the principal, jc) who declare schedule-kind Activation Blueprints and expect them to fire on time without touching infrastructure or competing for a global cron budget.

**Operators.** Whoever deploys reflex (edge Worker + local daemon) — they should not have to manage `wrangler.toml [triggers]` per expression, nor free account-wide cron slots.

**Technical level.** Expert; internal infrastructure component.

## Current State

- **Edge:** `EdgeScheduleSource` (`src/edge/schedule.ts`) maps `event.cron` → blueprints by string equality; driven by CF Cron Triggers via the Worker `scheduled` handler (`src/edge/worker.ts:39`) forwarding to the DO `/schedule` route. The `ReflexConsumer` DO already runs a **5-min alarm** for KV blueprint refresh (`src/edge/consumer-do.ts`).
- **Local daemon (Mac/Linux):** R-105 `ScheduleSource` runs croner timers in-process; the long-running daemon IS the clock. Service controls via launchd/systemd (R-111).
- **Shared:** the decision pipeline (R-104), guards (cooldown, run-lock, idempotency), and blueprint store are environment-agnostic — only the Impulse *source* differs per environment.

## Solution Overview

Move scheduling **into reflex**. Factor out a single environment-agnostic core and feed it an environment-specific heartbeat:

- **`Scheduler.tick(now)` core** — given the current time, evaluate every schedule-kind blueprint with **croner** (the matcher R-105 already uses); fire each blueprint whose next occurrence falls in the half-open window `(lastTick, now]`. Persist `lastTick`. Honors blueprint `timezone`.
- **Edge heartbeat adapter** — a **self-rescheduling Durable Object alarm** (period 60s) is the sole clock. **Zero** CF cron triggers. Durable across DO eviction (guaranteed delivery, retried), self-healing (sets its own next alarm). Unifies with the existing refresh alarm.
- **Local heartbeat adapter** — the daemon's in-process timer continues to drive `tick(now)` (preferred; the daemon is already long-running). An **every-minute launchd/cron job** calling a `reflex tick` path is the documented alternative for environments wanting an external heartbeat.

`EdgeScheduleSource`'s per-expression CF-cron mapping is **removed**; `wrangler.toml [triggers]` becomes empty.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | A `Scheduler.tick(now)` core evaluates ALL schedule-kind blueprints and fires each whose next croner occurrence ∈ `(lastTick, now]`, routing each as a `schedule` Impulse through the existing pipeline (R-104). | #20 |
| FR-2 | On edge, a self-rescheduling DO alarm (default 60s) is the only clock; the deployment uses **zero** CF cron triggers (`wrangler.toml [triggers]` empty). | Heartbeat decision |
| FR-3 | The DO alarm unifies scheduling with the existing KV blueprint refresh: each tick refreshes blueprints (every Nth tick, default every 5 min) and runs `tick(now)`. | Current alarm |
| FR-4 | `lastTick` is persisted in DO storage (edge) / daemon state (local) so the window survives restart/eviction and no tick is silently lost. | Catch-up decision |
| FR-5 | **Collapse catch-up:** when a gap spans multiple occurrences of a blueprint, it fires **exactly once** that tick, regardless of how many occurrences were missed. | Catch-up decision |
| FR-6 | Croner honors each blueprint's `timezone` (IANA); absent timezone defaults to UTC. Fixes the edge UTC-only gap. | #20 |
| FR-7 | Local daemon keeps a working trigger path: the in-process timer drives `tick(now)`; an every-minute launchd/cron `reflex tick` is a documented alternative. | Migration answer |
| FR-8 | Adding/removing a schedule blueprint requires NO `wrangler.toml` change or redeploy on edge — it is picked up on the next blueprint refresh. | #20 |
| FR-9 | `EdgeScheduleSource`'s expression→blueprint string-match mapping and `unmatchedExpressions` are removed; no schedule behavior depends on `wrangler.toml [triggers]`. | Migration: replace |

### Non-Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| NFR-1 | Resolution = heartbeat period; default 60s (minute granularity, matching cron's floor). Period is a single constant/config. | Period decision |
| NFR-2 | Exactly-once per tick at window boundaries: the half-open `(lastTick, now]` interval fires a blueprint due exactly at a boundary once (no double-fire, no skip). Existing run-lock / cooldown / idempotency guards still apply. | #20 |
| NFR-3 | A single heartbeat scales to unbounded schedule blueprints with no additional CF cron-trigger consumption. | #20 |
| NFR-4 | Cost: 60s alarm ≈ 1440 invocations/day — negligible; no measurable D1/KV pressure beyond the existing refresh. | #20 |
| NFR-5 | Core logic is environment-agnostic and shares the croner path with R-105 (no edge/local scheduling divergence). | Architecture |

## User Experience

- **Discovery:** author writes a schedule-kind blueprint (`when.schedule`, optional `timezone`) and deploys it to KV (edge) or drops it in the activations dir (local). No infra step.
- **Happy path:** within one heartbeat (≤60s) of an occurrence, the blueprint fires through the pipeline to a `fired` Decision (policy auto) or a Matched Decision (approval).
- **Observability:** `/status` (internal) reports active schedule blueprints, `lastTick`, and the heartbeat period (replacing `scheduleExpressions`/`unmatchedExpressions`).
- **Error handling:** a tick failure is logged and does not advance `lastTick` past unprocessed time (next tick retries the window); the heartbeat always re-arms.

## Edge Cases & Failure Modes

| Scenario | Expected behavior |
|----------|-------------------|
| DO evicted / restarted | Alarm is durable; on next fire `(lastTick, now]` covers the gap (collapse). |
| Long outage (hours) | Each due blueprint fires once (collapse) — no burst proportional to gap. |
| Tick handler throws mid-evaluation | `lastTick` not advanced past unprocessed window; error logged; alarm re-armed; next tick retries. |
| Clock skew / non-monotonic `now` | `now <= lastTick` → no-op tick (never fire backwards); guarded. |
| Blueprint added between ticks | Picked up on next refresh; first eligible occurrence after its load fires. |
| DST transition | Croner timezone handling; an occurrence skipped/duplicated by DST follows croner semantics, documented. |
| Two overlapping ticks (alarm + manual) | `tick(now)` is single-flight; `lastTick` CAS so concurrent ticks don't double-fire. |
| Heartbeat period change | Resolution changes; `lastTick` window math unaffected (time-based, not count-based). |

## Success Criteria

**Definition of done.**
- Edge deploy registers **0 CF cron triggers**; scheduled blueprints fire within ≤1 heartbeat, persisted as Decisions in D1.
- `EdgeScheduleSource` string-match path removed; `wrangler.toml [triggers]` empty.
- Local daemon scheduling unchanged in behavior (timer-driven), with a documented every-minute launchd/cron alternative.
- Collapse catch-up + exactly-once boundary verified by tests (unit on `tick(now)` windows, including gap/outage, boundary, backward-clock, DST).
- Timezone honored on edge.

**Success metric.** A schedule-kind blueprint fires reliably on edge across ≥10 consecutive ticks with no CF cron trigger and no missed/duplicated fires.

**MVP.** `Scheduler.tick(now)` core + DO-alarm heartbeat (edge) + collapse catch-up + lastTick persistence + tests. Local stays on the existing daemon timer (no new local heartbeat required for MVP; launchd/cron alternative documented).

## Scope

### In scope
- `Scheduler.tick(now)` core (croner eval, `(lastTick, now]` window, collapse, timezone).
- Edge DO-alarm heartbeat (60s), unified with KV refresh; `lastTick` in DO storage.
- Removal of `EdgeScheduleSource` expression-mapping + `wrangler.toml [triggers]`.
- `/status` reporting update.
- Tests for window/catch-up/boundary/DST/backward-clock.

### Explicitly out of scope
- Sub-minute scheduling (cron floor is 1 min).
- The reflex→pulse execution bridge / email delivery (separate work).
- Bus-kind subscription gap (tracked in #19).
- Changing the local daemon's existing croner scheduler beyond routing it through the shared core.

## Open Questions
- [x] Blueprint refresh cadence within the unified alarm: every tick vs every Nth (default: every 5 min as today)?
  Run every 60s
- [ ] Should the optional external every-minute launchd/cron path land in MVP or as a follow-up doc?
- [ ] `/status` exact shape for `lastTick` + heartbeat period.

## Assumptions
- Cloudflare DO alarms deliver reliably at ~60s cadence and survive eviction (documented platform guarantee).
- Croner is already a dependency (R-105) and runs in the Workers bundle (no Node built-ins) — to be verified during PLAN.
- The local daemon remains long-running; an external heartbeat is an alternative, not a requirement.

---
*Interview: open design forks (heartbeat source, period, catch-up, migration). Phases folded: problem/users/context carried from reflex#20 + the edge-deploy session.*
