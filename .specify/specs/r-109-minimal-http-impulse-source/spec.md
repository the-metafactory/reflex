# Specification: R-109 Minimal HTTP Impulse Source

## Context

> Autonomous spec from `docs/design-reflex-v0.md` §4 + structure decision 12 (minimal http in v0) + grill decision 15 (kind name `http`, "webhook" banned). 2026-06-10.

## Problem Statement

**Core Problem:** External systems that cannot publish to the bus (GitHub, monitoring SaaS, shell scripts on other hosts) need a way to produce External Impulses. v0 ships the deliberately minimal version: a localhost HTTP listener with one auto-generated endpoint per http-kind blueprint, bearer-token auth only. Public exposure, signatures, and richer auth are explicitly later.

**Urgency:** Lowest-priority impulse source in the graph (priority 6) — but cheap, and unlocks direct GitHub→Reflex experiments via a local tunnel.

## Users & Stakeholders

**Primary:** Operators wiring external HTTP callers. **Secondary:** Pipeline (impulse consumer); security posture of the host (listener must stay localhost-bound in v0).

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | `Bun.serve` listener, bind `127.0.0.1` only, port from config (`http.port`, default 7717); started only if ≥1 http-kind blueprint is loaded | Decision 12 |
| FR-2 | Route per blueprint: `POST /hook/{blueprint-id}` exists iff an http-kind blueprint with that id is loaded; hot-reload adds/removes routes | Design §4 |
| FR-3 | Auth: `Authorization: Bearer <token>` compared (constant-time) against the env var named by the blueprint's `token_env`; missing env var at load → R-102 validation error | R-102 FR-2 |
| FR-4 | Request body (JSON, ≤256KB) becomes the impulse payload: `{kind: http, blueprint_id, payload: body, received_at}` → `pipeline.evaluate()` | Design §4 |
| FR-5 | Response contract: 202 `{decision_id, outcome}` after evaluation; 401 bad/missing token; 404 unknown blueprint id; 405 non-POST; 413 oversize; 415 non-JSON content type; 422 unparseable JSON; 500 only on internal failure (logged) | HTTP semantics |
| FR-6 | Response NEVER leaks blueprint existence to unauthenticated callers: 401 returned before 404 evaluation (auth first, always) | Security |
| FR-7 | Per-blueprint rate limit (default 60/min, config `http.rate_limit`) → 429 with Retry-After; protects the pipeline from runaway external callers | Safety |
| FR-8 | Access log line per request (method, path, status, duration, source ip) at info; tokens never logged | Security |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Request → 202 latency | < 50ms p99 (includes pipeline evaluation) |
| NFR-2 | Listener footprint | zero listeners when no http blueprints loaded |
| NFR-3 | Offline tests | full route/auth/limit matrix via fetch against ephemeral port |
| NFR-4 | Token comparison | constant-time; no early-exit string compare |

## Acceptance Scenarios

**Scenario 1: Valid call produces a decision**
**Given** http blueprint `gh-ping` with `token_env: GH_PING_TOKEN` set
**When** `POST /hook/gh-ping` arrives with the correct bearer token and JSON body `{"ref":"main"}`
**Then** response is 202 with `{decision_id, outcome}`
**And** the decision's impulse snapshot carries `kind: http` and the body as payload

**Scenario 2: Auth precedes existence**
**Given** no blueprint named `nope`
**When** `POST /hook/nope` arrives without a token
**Then** response is 401 (not 404) and no log line reveals whether `nope` exists

**Scenario 3: Pipeline verdicts pass through honestly**
**Given** `gh-ping` has an active cooldown
**When** a valid call arrives
**Then** response is 202 with `outcome: blocked` and reason `cooldown` — HTTP accepted the impulse; the pipeline decided

**Scenario 4: Hot-reload rewires routes**
**Given** a running listener serving `/hook/a`
**When** config removes blueprint `a` and adds http blueprint `b`
**Then** `/hook/a` returns 404 (authenticated) and `/hook/b` serves — without listener restart

**Scenario 5: Rate limit bites**
**Given** limit 60/min
**When** 61 valid calls arrive within a minute
**Then** call 61 gets 429 with Retry-After and no impulse is produced for it

## Edge Cases & Failure Modes

| Scenario | Expected Behavior |
|----------|-------------------|
| `token_env` env var unset at load | R-102 validation error names blueprint + var; listener never serves an unauthenticatable route |
| Two http blueprints, one removed mid-flight request | In-flight request completes against old set (atomic swap semantics) |
| Body exactly at 256KB boundary | Accepted; 256KB+1 → 413 |
| Non-localhost bind attempted via config | Validation error: v0 listener is localhost-only by policy; config value rejected |
| Port already in use | Startup error names port + config key; daemon exits non-zero (fail fast, R-101 policy) |
| Same token for two blueprints | Allowed but logged as a warning at load (shared blast radius) |

## Success Criteria

**Definition of Done:**
- [ ] Full response-code matrix proven (200-series, 401, 404, 405, 413, 415, 422, 429) via fetch tests
- [ ] Auth-before-existence proven (scenario 2)
- [ ] Constant-time compare verified (implementation review + timing-safe primitive used)
- [ ] Hot-reload route rewiring proven without listener restart
- [ ] Zero-listener-when-unused proven
- [ ] Tokens absent from all log output (grep gate on test logs)
- [ ] `bun test` offline green

## Scope

### In Scope
Localhost listener lifecycle, per-blueprint routes, bearer auth, body→impulse, response contract, rate limiting, access logging.

### Explicitly Out of Scope
- Public exposure, TLS, reverse-proxy guidance (post-v0)
- Provider signatures (GitHub HMAC etc.) — "webhook auto-gen" richness deferred
- Auth schemes beyond bearer token
- Request replay protection beyond the pipeline's idempotency guard

## Assumptions

- Operators needing external reachability use their own tunnel (cloudflared/tailscale) in v0
- 256KB body cap adequate for v0 callers

## Open Questions

- [ ] None blocking.
