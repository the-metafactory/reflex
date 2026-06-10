# Plan: R-103 SQLite Storage (Drizzle)

**Spec:** `spec.md` (88%) · **Date:** 2026-06-10 · **Doctrine:** ADR-0001 — decisions are immutable; waiting state lives elsewhere.

## Architecture

```
src/
  store/
    db.ts            # openDb(path): bun:sqlite + drizzle, WAL, migration gate (FR-1, FR-8)
    schema.ts        # drizzle tables: decisions, approvals, guard_state, fired_events, ignored_counters (FR-2..FR-7)
    repository.ts    # typed ops — the ONLY module issuing queries (FR-9)
    paths.ts         # XDG_STATE_HOME resolution → ~/.local/state/reflex/reflex.db
drizzle/             # generated SQL migrations (committed)
drizzle.config.ts
test/store/
  repository.test.ts  restart.test.ts  append-only.test.ts  counters.test.ts
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `db.ts`: `Database(path, {create: true})`, `PRAGMA journal_mode=WAL`, drizzle `bun-sqlite` driver; `paths.ts` honors `XDG_STATE_HOME`, default `~/.local/state/reflex/reflex.db`; `:memory:` accepted for tests |
| FR-2 | `decisions` table: `id` TEXT PK (ULID via Bun's `Bun.randomUUIDv7()`-style monotonic id — actual: crypto.randomUUID + created_at ordering), `blueprint_id`, `outcome` CHECK in six values, `impulse` JSON (kind, payload, received_at), `guard_block_reason` nullable, `resolution_of` nullable FK→decisions.id, `correlation_id` nullable, `created_at`. NO update statement exists for `outcome` anywhere |
| FR-3 | `repository.resolveMatched(matchedId, outcome, …)`: single transaction — INSERT new decision row (`resolution_of: matchedId`) + UPDATE `approvals.state` via compare-and-set `WHERE decision_id=? AND state='waiting'`; 0 rows updated → `ConflictError` carrying the actual current state |
| FR-4 | `approvals`: `decision_id` PK FK, `state` CHECK (waiting/approved/denied/expired), `reason` nullable (timeout/blueprint-removed/operator), `actor` JSON nullable, `expires_at`, `decided_at` nullable |
| FR-5 | `guard_state`: `blueprint_id` PK, `cooldown_until` nullable, `run_lock_holder` nullable (correlation_id), `buffered_impulse` JSON nullable (UNIQUE by PK = depth 1 by construction; upsert replaces = newest wins); `idempotency_keys` (key PK, blueprint_id, expires_at) |
| FR-6 | `fired_events`: decision_id PK FK, envelope_id, correlation_id (indexed — buffer matching), subject, published_at |
| FR-7 | `ignored_counters`: (blueprint_id, day) PK, count — `bumpIgnored` upsert `count = count + 1` |
| FR-8 | drizzle-kit migrations committed under `drizzle/`; `openDb` runs `migrate()` before returning; failure → throw naming the migration file; daemon caller exits non-zero |
| FR-9 | `repository.ts` exports: `recordDecision`, `resolveMatched`, `listWaiting`, `sweepExpiredApprovals`, `expireForBlueprint`, `setCooldown`, `acquireRunLock`/`releaseRunLock`, `putBufferedImpulse`/`takeBufferedImpulse`, `putIdempotencyKey`/`hasIdempotencyKey`/`sweepIdempotencyKeys`, `recordFiredEvent`, `historyFor`, `bumpIgnored`. Architectural test greps for `db.` access outside `src/store/` |
| FR-10 | All timestamps stored as ISO-8601 UTC TEXT; durations as INTEGER ms; one `nowIso()` util — no `new Date()` scattered in queries |
| NFR-1/2 | Perf test: 1000 decision inserts < 5s wall (5ms p99 proxy); history query on 10k-row fixture < 20ms |
| NFR-3 | Counter design (FR-7) asserted: 1440 ignored bumps → 1 row |
| NFR-4 | WAL + transaction-per-operation; kill-between-ops test: insert decision, simulate crash before event record — DB reopens consistent, `fired_events` absent, decision present (publish reconciliation is R-104's job) |

## Data Model (drizzle, abridged)

```ts
decisions: { id: text pk, blueprintId: text notNull, outcome: text notNull /* CHECK six */, 
             impulse: text notNull /*json*/, guardBlockReason: text, resolutionOf: text /*fk*/,
             correlationId: text, createdAt: text notNull }
approvals: { decisionId: text pk fk, state: text notNull, reason: text, actor: text /*json*/,
             expiresAt: text notNull, decidedAt: text }
guard_state: { blueprintId: text pk, cooldownUntil: text, runLockHolder: text, bufferedImpulse: text /*json*/ }
idempotency_keys: { key: text pk, blueprintId: text notNull, expiresAt: text notNull }
fired_events: { decisionId: text pk fk, envelopeId: text notNull, correlationId: text notNull, 
                subject: text notNull, publishedAt: text notNull }
ignored_counters: { blueprintId: text, day: text, count: integer notNull, pk(blueprintId, day) }
```

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| Migration fails | migrate() throw at open | daemon exits non-zero naming migration | startup only |
| DB file locked (second daemon) | SQLITE_BUSY at open | error names path + "another reflex instance?" | startup only |
| Disk full on insert | SQLITE_FULL propagates | repository rethrows typed `StorageError`; pipeline fails closed (no fire without recorded decision) | one evaluation |
| Crash between decision insert and fired_events insert | restart consistency test | decision stands (truth), fired_events absent; R-104 reconciles publish state | one event |
| Concurrent resolveMatched (approve vs sweep) | CAS `WHERE state='waiting'` | exactly one wins; loser gets ConflictError with current state | none |
| Buffered impulse race (two writers) | PK upsert atomicity | last write wins = newest wins (by design) | none |
| Clock regression | ISO compare on stored strings only; sweep uses `<= nowIso()` | a backwards clock delays expiry, never double-fires | bounded delay |

## Test Assertions (verifiability)

- `append-only.test.ts`: grep-gate — no `UPDATE` targeting `decisions` outside migrations (`grep -r "update(decisions" src/` = 0); runtime: after resolveMatched, matched row `outcome` unchanged (byte compare), new row has `resolutionOf` set.
- `repository.test.ts`: `resolveMatched` CAS — two concurrent calls, exactly one `{ok}`, loser `ConflictError{current: "approved"}`; `takeBufferedImpulse` returns + clears atomically (second call null); `hasIdempotencyKey` false after `sweepIdempotencyKeys` past TTL.
- `restart.test.ts`: write waiting approval + cooldown + buffered impulse → close → reopen → all three read back identical.
- `counters.test.ts`: 1440 `bumpIgnored` → one row, count 1440; decisions table rowcount 0.
- Perf: 1000 inserts timed; 10k-row history < 20ms (generated fixture).

Framework: `bun:test`, real SQLite files in `mkdtemp` dirs (WAL behavior is file-backed; `:memory:` only where persistence is irrelevant).

## Constitutional Compliance (commitments, verified at done gate)

Library-First — repository exported via `src/index.ts`; Test-First — RED per task; Deterministic — CAS transitions, single `nowIso()`; CLI-First — n/a (storage layer; surfaces via R-107); Code Before Prompts.

## Implementation Order (→ tasks.md)

T-1 paths + db open + WAL + migration gate → T-2 schema + generated migration → T-3 decisions + append-only discipline → T-4 approvals CAS lifecycle → T-5 guard_state + idempotency → T-6 fired_events + history + counters → T-7 restart/perf/architectural tests + exports.

## Dependencies / Risks

- `drizzle-orm` + `drizzle-kit` added. Risk: drizzle bun-sqlite driver maturity — fallback is raw `bun:sqlite` prepared statements behind the same repository surface (interface unchanged).
