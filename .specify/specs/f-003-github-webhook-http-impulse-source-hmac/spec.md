# Specification: F-003 — GitHub-webhook HTTP impulse source (HMAC)

> Tracked in the-metafactory/reflex#23. Interview folded onto the open design forks; problem/context carried from the reflex GitHub-watch design discussion.

## Problem Statement

**Core problem.** Reflex should watch GitHub repos for new PRs/Issues with **nothing on the operator's laptop in the loop**. The leanest fully-serverless path is GitHub → `reflex-edge` directly: a GitHub webhook POSTs to the always-on Worker and fires a blueprint. But the edge HTTP impulse source (`EdgeHttpSource`, `src/edge/http.ts`) authenticates with a **Bearer token only** (`token_env` → `Authorization: Bearer`), while GitHub signs the raw body with **HMAC-SHA256** in `X-Hub-Signature-256`. There is no Bearer to send — GitHub cannot authenticate to reflex today. Reflex also has no way to filter the single webhook stream (GitHub delivers ALL subscribed event types to one URL) down to e.g. `pull_request`/`opened`.

**Urgency.** This is the unblocker for laptop-free GitHub activation. The alternative (cortex `grove-webhook-proxy` → bus) is not laptop-free today — its `local.jc.github.*` bus publish runs in the cortex *runtime*, not a Worker, and reflex consuming on edge would still need reflex#19. Option A (this feature) avoids the bus, cortex runtime, clawbox, and #19 entirely.

**Impact if unsolved.** No laptop-free GitHub watching; reflex can only be driven by Bearer-auth callers it controls.

## Users & Stakeholders

**Primary user.** The principal (jc) declaring GitHub-watch Activation Blueprints (PR-opened, issue-opened) on repos they admin.
**Operators.** Whoever sets the webhook + the HMAC secret. Technical level: expert; internal infra.

## Current State

- `EdgeHttpSource` (`src/edge/http.ts`): route `POST /impulse/{blueprint-id}`, **Bearer-only** auth-before-existence (`bearerOf`, `constantTimeEquals`), bounded body read (256 KB, raw bytes), 202 with pipeline verdict. `when.http = { token_env? }` (`activation/types.ts`, `schema.ts`).
- No payload/header matcher on the http source (bus-kind has flat field-equals `where`; http does not).
- Reflex has an idempotency-key guard (`deriveIdempotencyKey`, hash of blueprint id + canonical payload).

## Solution Overview

Add a **GitHub-HMAC auth mode** + a **`where` matcher** to the edge HTTP impulse source. One always-on Worker handles the whole cycle.

1. **Generic auth block.** `when.http.auth = { mode: "bearer" | "github_hmac", secret_env }`. `mode: "github_hmac"` verifies `X-Hub-Signature-256` = `sha256=<hex>` against `HMAC_SHA256(secret, rawBody)` (constant-time, over the exact received bytes before JSON parse) using the Worker secret binding named by `secret_env`. **Back-compat:** the existing `token_env` stays valid as a Bearer shorthand (`token_env: X` ≡ `auth: { mode: bearer, secret_env: X }`).
2. **Header/payload filtering.** Add an optional `where` (flat field-equals, the same matcher `src/sources/bus.ts` uses) to `when.http`. In `github_hmac` mode the source injects two top-level fields into the impulse payload before matching — `github_event` (from `X-GitHub-Event`) and `repository` (the payload's `repository.full_name`) — so `where: { github_event: pull_request, action: opened, repository: "owner/repo" }` works despite GitHub's nested payload.
3. **Idempotency.** Use `X-GitHub-Delivery` (delivery UUID) as the idempotency key for HMAC-mode impulses (feeds the existing guard) so GitHub's at-least-once redelivery fires once.
4. **Payload.** Forward the full GitHub JSON payload plus the injected top-level `github_event` + `repository` fields.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | `when.http.auth = { mode, secret_env }` is accepted; `mode: github_hmac` verifies `X-Hub-Signature-256` (`sha256=<hex>` = `HMAC_SHA256(secret_env value, raw body)`), constant-time, over the exact bytes received before JSON parse. | Auth-shape decision |
| FR-2 | `token_env` remains valid as a Bearer shorthand (`≡ auth:{mode:bearer, secret_env}`); existing Bearer blueprints are unchanged. Bearer and github_hmac are mutually exclusive per blueprint. | Back-compat |
| FR-3 | Auth-before-existence parity (R-109): a request that fails HMAC (or is missing the signature) gets `401`, indistinguishable from a missing/misconfigured blueprint. | `http.ts` parity |
| FR-4 | In github_hmac mode the source injects top-level `github_event` (from `X-GitHub-Event`) and `repository` (`payload.repository.full_name`) into the impulse payload before matching and forwards them downstream. | Filtering + payload |
| FR-5 | Optional `when.http.where` (flat field-equals over top-level payload fields, reusing the bus matcher) filters which deliveries fire; absent `where` = fire on every authenticated delivery. A non-match is an Ignored Decision (no fire), counted like bus ignores. | Filtering decision |
| FR-6 | The impulse payload is the full GitHub JSON plus injected `github_event` + `repository`; `kind: "http"`, attributed to the blueprint. | Payload decision |
| FR-7 | `X-GitHub-Delivery` is used as the idempotency key in github_hmac mode so redelivered webhooks fire once. | Dedup decision |
| FR-8 | The existing Bearer path (auth, rate limit, body bounds, 202 verdict) is behaviorally unchanged. | Back-compat |

### Non-Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| NFR-1 | HMAC uses Web Crypto (`crypto.subtle`), no Node built-ins — bundle stays Node-free (`nodejs_compat` OFF). | Edge constraint |
| NFR-2 | Constant-time signature compare (no early-exit on mismatch). | Security |
| NFR-3 | HMAC is computed over the EXACT raw request bytes (read once, bounded 256 KB), then JSON-parsed from the same bytes — never re-serialize before verifying. | Security |
| NFR-4 | Self-contained in `reflex-edge`: no bus, no cortex runtime, no reflex#19, no CF cron. | Laptop-free goal |
| NFR-5 | Secrets come from Worker secret bindings (never committed); a missing/unset `secret_env` → 401 (route disabled), logged once (parity with the Bearer misconfig path). | `http.ts` parity |

## User Experience

- **Setup:** operator creates a GitHub webhook on the repo → URL `https://reflex-edge…/impulse/<blueprint-id>`, content-type JSON, a shared secret; `wrangler secret put <secret_env>` with the same secret; selects the events (PRs, Issues).
- **Happy path:** PR opened → GitHub POSTs → HMAC verified → `where` matches → `fired`/`matched` Decision in D1 → Activation Event (auto policy) for Pulse. All on Cloudflare; laptop offline.
- **Errors:** bad/missing signature → 401; non-matching event → 202 Ignored; redelivery → idempotent no-op.

## Edge Cases & Failure Modes

| Scenario | Expected behavior |
|----------|-------------------|
| Bad/missing `X-Hub-Signature-256` | 401, indistinguishable from missing blueprint (auth-before-existence) |
| Secret binding unset | 401 (route disabled), logged once |
| GitHub redelivery (same `X-GitHub-Delivery`) | fires once (idempotency key) |
| Event type not matched by `where` | 202 Ignored Decision, no fire |
| Body exceeds 256 KB | 413 (existing bound) — HMAC not attempted on truncated bytes |
| Payload missing `repository` (e.g. `ping`) | `repository` injected as absent/undefined; `where` on it simply won't match |
| `action`-less GitHub event (push/ping) | `where` on `action` won't match; `github_event` still matchable |
| Bearer blueprint hit with a GitHub signature (or vice-versa) | mode is fixed per blueprint; wrong-mode request fails auth → 401 |

## Success Criteria

**Definition of done.** A real GitHub webhook on a test repo → reflex-edge fires a Decision in D1 on PR-opened **with the operator's laptop offline**; a tampered body → 401; a redelivery → single fire; Bearer blueprints still work; bundle Node-free; no bus/cron/#19 dependency.

**MVP.** github_hmac auth mode + `where` filtering + injected fields + delivery-id idempotency on the edge http source, with unit tests + a live webhook e2e.

## Scope

### In scope
- Generic `when.http.auth` + `github_hmac` HMAC verification (Web Crypto) in `EdgeHttpSource`.
- `token_env` Bearer back-compat.
- `where` flat field-equals on http (reuse bus matcher) + injected `github_event`/`repository`.
- `X-GitHub-Delivery` idempotency.
- Schema (`activation/schema.ts`, `types.ts`) + tests + an example GitHub-watch blueprint.

### Explicitly out of scope
- The cortex/bus path (Option B) and reflex#19.
- A polling fallback.
- Executing anything in response (the Pulse flow that the fired event targets).
- Non-GitHub HMAC providers (the `auth` block is general but only `bearer`/`github_hmac` modes ship here).

## Open Questions
- [ ] Does the local daemon's `Bun.serve` http source (R-109) also get the `auth`/`where`/HMAC additions, or edge-only for MVP?
- [ ] `where` semantics for nested matches beyond the two injected fields — top-level only for v1?

## Assumptions
- GitHub sends `X-Hub-Signature-256` (sha256) — the modern signature; `X-Hub-Signature` (sha1) is not supported.
- `crypto.subtle` HMAC is available in workerd (it is) and on Bun (for tests).
- Repos to watch are admin-accessible to set the webhook + secret.

---
*Interview: auth shape (generic block), filtering (`where` + injected fields), idempotency (delivery id), payload (full + injected). Problem/context carried from reflex#23 + the GitHub-watch design discussion.*
