# F-002 — Internal heartbeat scheduler: implementation notes

Tracked in the-metafactory/reflex#20. Replaces the Cloudflare Cron Trigger
delegation with reflex's own schedule clock.

## What changed

Reflex now owns scheduling. A pure core decides which schedule-kind
blueprints are due; environment-specific heartbeats drive it.

- **`src/scheduler/core.ts`** (new) — `Scheduler.tick(lastTick, now)`: for each
  schedule blueprint, `new Cron(expr, { timezone }).nextRun(lastTick)`; fire iff
  `<= now`. Half-open window `(lastTick, now]`, **collapse** catch-up (multiple
  missed occurrences fire once), backward-clock guard, cold-start = no backfill,
  per-blueprint error isolation. Pure + time-injected → deterministic.
- **`src/edge/heartbeat.ts`** (new) — `EdgeHeartbeat`: a self-rescheduling DO
  alarm (60s) is the only clock on edge. Persists `lastTick`/`refreshCounter`
  in DO storage; refreshes blueprints from KV every 5th tick; re-arms in a
  `finally` so the clock never stops.
- **`src/edge/consumer-do.ts`** (modified) — wires `Scheduler` + `EdgeHeartbeat`;
  `alarm()` now runs the heartbeat; removed the internal `POST /schedule` route;
  `/status` now reports `scheduleBlueprints` + `heartbeat.{lastTick,periodMs}`.
- **`src/edge/worker.ts`** (modified) — removed the `scheduled` handler entirely.
- **`src/edge/schedule.ts`** (deleted) — `EdgeScheduleSource` string-match path gone.
- **`wrangler.toml`** — `[triggers].crons = []` (zero CF cron triggers).
- Local daemon (`src/sources/schedule.ts`, R-105) — unchanged for MVP.

## Why

Cloudflare caps cron triggers at **5 per account** (`code 10072`), shared across
all workers; and free-plan crons proved best-effort (a registered `*/5` never
fired across 30 min). Reflex's previous design needed one CF cron per distinct
expression. The DO alarm consumes **zero** cron triggers, is durable across
eviction, self-heals, catches up missed ticks, and honors blueprint timezone
(the old edge path was UTC-only).

## Operational note — bootstrap (IMPORTANT)

A DO-alarm-only scheduler self-sustains *once armed* (alarms survive eviction
and re-wake the DO), but **something must arm the first alarm** after a brand-new
deploy. Arming happens in the DO's `start()`, which runs on the first event that
instantiates the DO. In practice:

- A redeploy evicts the DO but its **pending alarm persists** — when it fires,
  the new `alarm()` handler runs and arms the 60s heartbeat (bootstraps within
  ≤ the old alarm's remaining time).
- To bootstrap **immediately** (or for a first-ever deploy with no prior alarm),
  send one request to the worker — even a `401` `POST /impulse/<anything>` runs
  `start()` and arms the alarm.

Recommendation: include a one-line "kick" (`curl -X POST .../impulse/_bootstrap`)
in the deploy step. The optional single CF safety-net cron from the spec remains
available if external arming is ever wanted, but is not used here.

## Verification

- **Unit:** `test/scheduler/core.test.ts` (9) — window, collapse (missed=2),
  timezone (Europe/Zurich), backward-clock no-op, cold-start, exactly-once
  boundary, error isolation. `test/edge/heartbeat.test.ts` (4) — persistence,
  refresh cadence, re-arm-on-error, eviction recovery.
- **Suite:** full `bun test` green (236), `tsc --noEmit` clean.
- **Bundle:** `wrangler deploy --dry-run` — Node-free (0 `node:fs/net/os/path/tls`,
  0 `transport-node`); croner bundles as CJS with no Node built-ins; `nodejs_compat`
  stays OFF.
- **Live e2e:** deploy with `crons = []` (no `10072`), bootstrap kick, a `* * * * *`
  schedule blueprint fires once per minute purely from the DO alarm → Matched
  Decisions in remote D1. Zero CF cron triggers consumed.

## Follow-ups

- Route the local daemon through the shared `Scheduler.tick` core (post-MVP).
- Optional external `reflex tick` launchd/cron heartbeat for local (doc).
- `/status` is internal-only; no external surface change.
