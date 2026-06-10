# Tasks: R-105 Schedule Impulse Source

Branch: `spec/r-105-schedule-source` · TDD per task.

## T-1: ScheduleSource core
- croner job per schedule blueprint; tick → Impulse → pipeline (fire-and-forget, error-contained).
- Tests: tick impulse shape; evaluate-throw resilience; seconds-cron submission count.

## T-2: Hot-reload sync
- onReload diff: add/remove/change; orphan-free invariant.
- Tests: mutations incl. 50-random fuzz; cron-change replaces job.

## T-3: Status surface
- nextTick/lastTick/lastOutcome per blueprint.
- Tests: populated after tick; null nextTick for never-again crons.

## T-4: Daemon wiring
- startDaemon (config→db→store→watcher→bus→stream→pipeline→schedule→sweep timer→removal hook), SIGINT/SIGTERM clean stop; bin entry.
- Tests: lifecycle with memory transport + tmp resources; clean stop.

## T-5: Milestone + gates
- DST boundary test; perf (100-blueprint resync <200ms); exports; live demo evidence into verify.md.

## Done gate
- Spec scenarios 1–5 covered (4 offline + milestone live); vocabulary grep; `specflow validate R-105`.
