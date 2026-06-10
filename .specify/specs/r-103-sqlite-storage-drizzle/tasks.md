# Tasks: R-103 SQLite Storage (Drizzle)

Branch: `spec/r-103-sqlite-storage` · TDD per task.

## T-1: DB open + paths + migration gate
- `src/store/paths.ts` (XDG resolution), `src/store/db.ts` (WAL, create, migrate-or-throw).
- Tests: tmp-dir create; XDG override; migration-failure throw names file.
- Covers: FR-1, FR-8.

## T-2: Drizzle schema + first migration
- `src/store/schema.ts`, `drizzle.config.ts`, generated migration committed.
- Tests: open fresh DB → all 6 tables exist (sqlite_master assert); outcome CHECK rejects 7th value.
- Covers: FR-2 structure, FR-4..FR-7 structure.

## T-3: Decision recording (append-only)
- `recordDecision`, `historyFor`; impulse snapshot JSON round-trip.
- Tests: append-only grep gate + byte-compare after later resolution; history ordering newest-first.
- Covers: FR-2, FR-9 (partial), NFR-2.

## T-4: Approvals CAS lifecycle
- `resolveMatched` (transaction: insert resolution row + CAS approvals), `listWaiting`, `sweepExpiredApprovals`, `expireForBlueprint`.
- Tests: concurrent resolve race (one winner, typed ConflictError with current state); sweep expires only past-due; blueprint-removed reason recorded.
- Covers: FR-3, FR-4.

## T-5: Guard state + idempotency keys
- `setCooldown`, `acquireRunLock`/`releaseRunLock`, `putBufferedImpulse`/`takeBufferedImpulse`, idempotency put/has/sweep.
- Tests: buffered depth-1 (second put replaces); take clears atomically; acquire on held lock returns holder; sweep TTL.
- Covers: FR-5.

## T-6: Fired events + counters
- `recordFiredEvent`, correlation index lookup, `bumpIgnored`.
- Tests: correlation lookup for buffer matching; 1440 bumps → 1 row.
- Covers: FR-6, FR-7, NFR-3.

## T-7: Restart, perf, architecture gates + exports
- restart.test (waiting+cooldown+buffer survive reopen); perf (1000 inserts, 10k history); grep gate (no db access outside src/store/); `src/index.ts` exports.
- Covers: FR-9, FR-10, NFR-1, NFR-4.

## Done gate
- Spec scenarios 1–4 named in tests; ADR-0001 grep gate green; `specflow validate R-103`.
