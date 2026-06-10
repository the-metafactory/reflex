# Tasks: R-106 Manual Fire + Approval Flow

Branch: `spec/r-106-manual-approval` · TDD per task.

## T-1: HandlerResult + fire handler
- not-found with nearest-id hint; invalid-input; full-pipeline delegation (no bypass — cooldown test).

## T-2: approve/deny handlers
- ConflictError → typed conflict result with currentState; post-approval blocked carries guard reason.

## T-3: pending handler
- listWaiting → wire shape, newest-first, impulse summary.

## T-4: Lifecycle tests + daemon exposure
- fake-clock sweep (timeout reason), concurrent approve||deny race, actor round-trip, perf <100ms; handlers on ReflexDaemon (internal interface).

## Done gate
- Spec scenarios 1–5 named; vocabulary grep; `specflow validate R-106`.
