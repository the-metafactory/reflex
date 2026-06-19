# F-002 — End-to-end verification

Feature: Internal heartbeat scheduler (DO-alarm on edge). Proves reflex fires
schedule blueprints from its own clock with **zero Cloudflare Cron Triggers**.

## Pre-Verification Checklist

- [x] `spec.md`, `plan.md`, `tasks.md`, `docs.md` present
- [x] `bunx tsc --noEmit` clean
- [x] Full `bun test` suite green (236 pass / 0 fail)
- [x] Feature branch `spec/F-002-edge-do-alarm-internal-scheduler`
- [x] `wrangler.toml [triggers].crons = []` (no CF cron triggers)
- [x] Bundle dry-run builds (croner on the edge graph)

## Smoke Test Results

```
$ bun test test/scheduler/core.test.ts   → 9 pass / 0 fail
$ bun test test/edge/heartbeat.test.ts    → 4 pass / 0 fail
$ bun test                                 → 236 pass / 0 fail
$ bunx tsc --noEmit                        → exit 0 (clean)
$ bunx wrangler deploy --dry-run           → bundles OK; deploy shows NO `schedule:` line (0 crons)
```

## Browser Verification

N/A — F-002 is an internal edge-runtime scheduler with no UI surface. No
browser-facing component; verification is via the API surface, D1 state, and
the bus.

## API Verification

HTTP contract unchanged and working alongside the new scheduler:

```
$ curl -s -X POST .../impulse/_bootstrap (no/invalid token)  → 401 unauthorized
  (doubles as the DO bootstrap kick: instantiates the DO + arms the alarm)
```

Internal `/status` (worker allowlists only `/impulse/*`) now returns
`scheduleBlueprints` + `heartbeat.{lastTick, periodMs}` (replacing the removed
`scheduleExpressions`/`unmatchedExpressions`). Schedule firing is observed via
D1 Decision rows (the pipeline's canonical output).

## Edge Case Verification

Covered by unit tests (`test/scheduler/core.test.ts`):

- [x] Collapse: window spanning 3 occurrences → fires once, `missedOccurrences=2`
- [x] Timezone: Europe/Zurich summer 07:00 local → 05:00Z fires in window
- [x] Backward/non-monotonic clock (`now <= lastTick`) → no-op
- [x] Cold start (`lastTick=null`) → no backfill (fires only an occurrence at now)
- [x] Exactly-once at boundary: occurrence == now fires once; next tick no re-fire
- [x] Per-blueprint evaluation error isolates; tick continues
- [x] Heartbeat: lastTick persistence, refresh-every-5-ticks, re-arm-on-error,
      DO-eviction recovery (`test/edge/heartbeat.test.ts`)

## Live edge e2e — DO alarm fires a schedule, 0 CF cron triggers

Deployed the branch with `crons = []` (version `e6eac49a`); uploaded a
`* * * * *` (approval-policy) schedule blueprint to KV; bootstrapped the DO with
one `POST /impulse/_` (HTTP 401); polled remote D1:

```
kick @ 12:35:49Z (HTTP 401)
remote D1 decisions WHERE blueprint_id='e2e-sched-min':
  {'outcome':'matched','t':'2026-06-19 12:36:27'}
  {'outcome':'matched','t':'2026-06-19 12:37:27'}
  {'outcome':'matched','t':'2026-06-19 12:38:28'}
  {'outcome':'matched','t':'2026-06-19 12:39:28'}
  {'outcome':'matched','t':'2026-06-19 12:40:28'}
```

Five Matched Decisions ~60s apart, produced purely by the self-rescheduling DO
alarm — no Cloudflare Cron Trigger. Cleanup: e2e blueprint + 5 Decisions/approvals
removed; KV back to the 3 examples; 0 e2e rows left.

## Bundle is Node-free (croner now on edge graph)

```
$ grep -roE 'node:(fs|net|os|path|tls)|transport-node' /tmp/reflex-bundle/*.js
  → (empty — 0 hits)
```

`nodejs_compat` OFF; croner bundles as CJS, no Node built-ins.

## Test Coverage Summary

- New source: `src/scheduler/core.ts`, `src/scheduler/index.ts`, `src/edge/heartbeat.ts`
- New tests: `test/scheduler/core.test.ts` (9), `test/edge/heartbeat.test.ts` (4)
- Test-file ratio for the feature's new code: 2 test files / 3 source files = 0.67 (≥ 0.3)
- Full suite: 236 pass / 0 fail

## Verification Summary

All acceptance criteria met. Schedule firing on edge no longer consumes the
account's 5-cron budget, is durable across DO eviction, honors blueprint
timezone, and fires within one heartbeat — proven by unit tests, a Node-free
bundle, and a live 5-tick e2e against remote D1 with zero CF cron triggers.

## Sign-off

- [x] Implemented per plan, all 13 tasks complete
- [x] Verified live on the edge runtime
- [x] Operational note (bootstrap kick) documented in `docs.md`
- Pending: PR review + merge (branch not merged to main)
## Doctorow Gate Verification - 2026-06-19T12:48:29.949Z

- [x] **Failure Test**: Confirmed [AI-evaluated]
  - Reasoning: AI evaluation unavailable — passed by default
- [x] **Assumption Test**: Confirmed [AI-evaluated]
  - Reasoning: AI evaluation unavailable — passed by default
- [x] **Rollback Test**: Confirmed [AI-evaluated]
  - Reasoning: AI evaluation unavailable — passed by default
- [x] **Technical Debt**: Confirmed [AI-evaluated]
  - Reasoning: AI evaluation unavailable — passed by default

> Note on the Doctorow Gate block below: it was auto-appended by `specflow
> complete`. The four checks ran with AI evaluation **unavailable** and were
> "passed by default" — they record that the gate did not run, NOT an
> independent confirmation. The substantive verification is sections 1–3 above
> (unit tests, Node-free bundle, live 5-tick e2e).
