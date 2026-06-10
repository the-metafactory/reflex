# Tasks: R-108 Bus Impulse Source

Branch: `spec/r-108-bus-source` · TDD per task.

## T-1: Matcher (pure)
- matches(where, payload): strict-equal flat fields; property test 200 pairs.

## T-2: BusSource subscriptions + sync + self-cycle guard
- per-blueprint durable subs, hot-reload reconcile (orphan-free fuzz), own-fired-subject skip with loud error.

## T-3: Run-outcome module
- runOutcomeSubject(cfg), terminal-type detection (table-driven), onRunCompleted dispatch; pulse#27 isolated here.

## T-4: Daemon wiring + stale-lock status
- BusSource start/stop/sync in daemon; router status staleLocks (>24h).

## T-5: Lifecycle e2e + gates
- buffer re-presentation end-to-end via synthetic outcome envelope; redelivery-idempotency interplay; perf; vocab.

## Done gate
- Spec scenarios 1–5; `specflow validate R-108`.
