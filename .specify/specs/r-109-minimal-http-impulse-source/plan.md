# Plan: R-109 Minimal HTTP Impulse Source

**Spec:** `spec.md` (84%) · **Date:** 2026-06-11 · Deliberately minimal (decision 12): localhost, bearer-token, nothing else.

## Architecture

```
src/sources/http.ts   # HttpSource: Bun.serve lifecycle, POST /hook/{blueprint-id}, auth, rate limit
test/sources/http.test.ts
```
Daemon: start HttpSource after BusSource; hot-reload route rewiring via store snapshot reads (no listener restart). Config gains `http.port` (default 7717) + `http.rate_limit` (default 60/min) on the daemon config schema.

## Data Flow

```
external caller ── POST 127.0.0.1:7717/hook/{id} (Bearer token) ──► HttpSource
  auth (constant-time vs env named by blueprint token_env) → body (JSON ≤256KB) →
  Impulse{kind: http} → pipeline.evaluate → 202 {decision_id, outcome}
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `Bun.serve({hostname: "127.0.0.1", port})`; started by daemon ONLY when ≥1 http-kind blueprint loaded; stopped when count drops to 0 (reload hook) |
| FR-2 | Route resolution reads `store.get(id)` per request (live set — hot-reload needs no rewiring at all; atomic swap covers it) |
| FR-3 | Auth: `Bearer <token>` vs `process.env[token_env]` via `crypto.timingSafeEqual` on equal-length buffers (length mismatch → fail without compare); blueprint without token_env → 503 misconfigured (validated at R-102 as optional — daemon refuses route if env unset, logged at sync) |
| FR-4 | Body: content-type application/json required, ≤256KB (Content-Length + actual read cap), JSON.parse → Impulse{kind: http, payload: body, actor: {type: system, id: http:{blueprintId}}} |
| FR-5 | Responses: 202 {decision_id, outcome, reason?}; 401 (auth, FIRST); 404 unknown id (authenticated only); 405 non-POST; 413 oversize; 415 wrong content type; 422 bad JSON; 429 rate; 500 internal (logged) |
| FR-6 | Auth precedes existence: token compared against the blueprint's token IF the blueprint exists, else against a random ephemeral token (constant-shape work) — unauthenticated callers always see 401, never 404 |
| FR-7 | Token-bucket per blueprint: capacity = rate_limit/min, refill continuous; 429 + Retry-After (seconds to next token) |
| FR-8 | Access log per request: method path status duration ip; token never logged (no header echo anywhere) |
| NFR-1 | 202 latency test < 50ms p99 over 30 requests (InMemory pipeline) |
| NFR-2 | Zero listeners when no http blueprints: daemon-level conditional + reload stop |
| NFR-3 | Tests via fetch against ephemeral port (port: 0) |
| NFR-4 | timingSafeEqual (node:crypto) — no early-exit compare |

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| token_env unset at runtime | route check | 503 + one-time sync-side error log | that blueprint's route |
| port in use | Bun.serve throw at start | daemon fail-fast (assembly cleanup, R-105 pattern) | startup |
| pipeline throws | try/catch | 500, logged, no impulse leak | one request |
| blueprint removed mid-request | snapshot read at request start | request completes against old set semantics (store.get returns undefined after swap → 404 for NEW requests) | none |
| body stream lies about length | actual read cap enforced | 413 | one request |
| same token two blueprints | sync-side warning (shared blast radius) | allowed, logged | observability |

## Test Assertions

- Full response-code matrix: 202/401/404/405/413/415/422/429/503 — one fetch test each.
- Auth-before-existence: unknown id without token → 401; unknown id WITH a valid-shaped token → 404 (authenticated against ephemeral random → still 401? NO: unknown blueprint has no token to validate → 401 always for unknown ids; test asserts 401 both ways — existence never leaks unauthenticated, and unknown ids are indistinguishable from bad tokens).
- Constant-time: implementation uses timingSafeEqual (asserted by import/grep test, not timing measurement).
- Rate limit: capacity+1 burst → last is 429 with Retry-After; token refill after window allows again (fake-ish via small capacity).
- 202 carries pipeline verdict honestly: blueprint with cooldown → second call 202 {outcome: blocked, reason: cooldown}.
- Zero-listener: daemon with no http blueprints → port closed (fetch ECONNREFUSED); add http blueprint via reload → listener up.
- Token absent from logs: capture console output during auth\'d request, grep token value.

## Constitutional Compliance (commitments, verified at done gate)

Library-First — HttpSource module-level; Test-First — RED per task; Deterministic — injected clock not needed (token bucket uses monotonic now, tested with small windows); Code Before Prompts; CLI-First — n/a.

## Implementation Order (→ tasks.md)

T-1 HttpSource serve/auth/body/respond → T-2 rate limit → T-3 daemon wiring (conditional lifecycle) → T-4 matrix tests + gates.

## Dependencies / Risks

All merged. Risk: none material; Bun.serve stable.
