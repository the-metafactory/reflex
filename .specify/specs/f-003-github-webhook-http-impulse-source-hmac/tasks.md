# Implementation Tasks: GitHub-webhook HTTP impulse source (HMAC)

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☑ | auth block + where on when.http (types + schema + refine); schema tests |
| T-2.1 | ☑ | verifyGithubSignature (Web Crypto, constant-time, raw bytes) |
| T-3.1 | ☑ | mode-aware async authorize (bearer/github_hmac), auth-before-existence |
| T-3.2 | ☑ | inject github_event/repository/github_delivery + full payload |
| T-3.3 | ☑ | where filter reuses bus matches() → Ignored on no-match |
| T-3.4 | ☑ | github_delivery in payload → idempotency dedup |
| T-4.1 | ☑ | Bearer back-compat (62 edge/activation tests green) |
| T-4.2 | ☑ | examples/github-pr-opened + docs/edge.md section |
| T-5.1 | ☑ | bundle Node-free; crypto.subtle bundled |
| T-5.2 | ☑ | live: deployed worker, valid sig → 202 matched in D1; tampered → 401 |

---

## Group 1: Schema

### T-1.1: `auth` block + `where` on `when.http` [T]
- **Files:** `src/activation/types.ts`, `src/activation/schema.ts`
- **Test:** `test/activation/schema.test.ts` (or existing schema tests)
- **Description:**
  - `types.ts`: `type HttpAuthMode = "bearer" | "github_hmac"`; `interface HttpAuth { mode: HttpAuthMode; secret_env: string }`; extend `HttpWhen.http` with `auth?: HttpAuth` and `where?: Record<string,string|number|boolean>`; keep `token_env?` (deprecated Bearer shorthand).
  - `schema.ts`: `httpAuthSchema` (`mode` enum + `secret_env` min 1); add `auth: httpAuthSchema.optional()` and `where: flatWhere` (reuse existing `flatWhere`) to the http object; `superRefine`: `token_env` XOR `auth` (exactly one), error if both/neither.

**Acceptance:** schema accepts `auth:{mode:github_hmac,secret_env}` + `where`; rejects both-token_env-and-auth; `token_env`-only still valid; types compile.

---

## Group 2: HMAC

### T-2.1: GitHub HMAC verify helper (Web Crypto) [T]
- **File:** `src/edge/http.ts`
- **Test:** `test/edge/http.test.ts` (or `edge-sources.test.ts`)
- **Description:** `verifyGithubSignature(rawBody: string|Uint8Array, secret: string, header: string|null): Promise<boolean>` —
  `crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"])` → `sign` over the **exact raw bytes** → hex → compare `sha256=<hex>` to the header **constant-time** (reuse `constantTimeEquals`). Missing/malformed header → false. No Node built-ins.

**Test cases:** valid sig → true; tampered body → false; wrong secret → false; missing header → false; raw-byte exactness (whitespace-significant body).

---

## Group 3: Source wiring (`EdgeHttpSource`)

### T-3.1: Resolve auth mode + verify [T]
- **File:** `src/edge/http.ts`
- **Description:** Resolve per-blueprint auth: `token_env` → bearer; `auth` → its mode. `bearer` keeps the existing path. `github_hmac`: read the bounded **raw body once**, verify via T-2.1 against `secrets[secret_env]`. Auth-before-existence parity (R-109): fail/missing sig or unset secret → `401`, logged-once for misconfig. Bearer and github_hmac mutually exclusive (schema-guaranteed).

**Acceptance:** github_hmac good sig → proceeds; bad/missing → 401; unset secret → 401 (logged once); Bearer unchanged.

### T-3.2: Inject top-level fields + forward full payload [T]
- **File:** `src/edge/http.ts`
- **Description:** In github_hmac mode, parse the verified raw body as JSON and build the impulse payload = full GitHub object **plus** injected top-level `github_event` (from `X-GitHub-Event`) and `repository` (`payload.repository?.full_name`). `kind:"http"`, attributed to the blueprint.

**Acceptance:** payload carries full GitHub JSON + `github_event` + `repository`; missing `repository` → field absent/undefined (no throw).

### T-3.3: `where` filtering [T]
- **File:** `src/edge/http.ts` (reuse `matches` from `src/sources/bus.ts`)
- **Description:** If `when.http.where` is set, apply flat field-equals (shared `matches()`); non-match → Ignored Decision (no fire), 202 with ignored outcome; absent `where` → fire on every authenticated delivery.

**Acceptance:** `where:{github_event:pull_request,action:opened}` fires only on matching deliveries; non-match → ignored, not fired.

### T-3.4: `X-GitHub-Delivery` idempotency [T]
- **File:** `src/edge/http.ts`
- **Description:** In github_hmac mode, use `X-GitHub-Delivery` as the idempotency key feeding the existing guard, so a redelivered webhook fires once.

**Acceptance:** same delivery id twice → one fire (second is idempotency-blocked).

---

## Group 4: Back-compat + example

### T-4.1: Bearer back-compat preserved [T]
- **File:** `src/edge/http.ts`
- **Description:** `token_env` continues to behave exactly as today (Bearer auth, rate limit, body bounds, 202). Existing edge http tests stay green.

**Acceptance:** all pre-existing `EdgeHttpSource` Bearer tests pass unchanged.

### T-4.2: Example GitHub-watch blueprint + docs
- **Files:** `examples/github-pr-opened/reflex.yaml`, `docs/edge.md` (GitHub-webhook setup section)
- **Description:** Example http-kind + `auth:{mode:github_hmac,secret_env:GITHUB_WEBHOOK_SECRET}` + `where:{github_event:pull_request,action:opened}`. Docs: GitHub webhook URL `/impulse/<id>`, `wrangler secret put`, event selection.

---

## Group 5: Verification

### T-5.1: Bundle Node-free
- **Description:** `wrangler deploy --dry-run --outdir` → grep `node:fs/net/os/path/tls` = 0; `crypto.subtle` used, no Node crypto; `nodejs_compat` OFF.

### T-5.2: Live e2e — laptop-free GitHub fire
- **Description:** Real GitHub webhook on a test repo → reflex-edge fires a Decision in D1 on PR-opened **with the laptop offline**; tampered body → 401; redelivery → single fire. 0 bus/cron/#19 dependency. Clean up the test blueprint + rows.

---

## Execution Order

```
T-1.1 (schema) → T-2.1 (hmac helper) → T-3.1 (auth resolve+verify)
  → T-3.2 (inject+payload) → T-3.3 (where) → T-3.4 (idempotency)
  → T-4.1 (bearer compat, verified continuously) → T-4.2 (example+docs)
  → T-5.1 (bundle) → T-5.2 (live e2e)
```

## Estimated Effort

| Group | Tasks | Complexity |
|-------|-------|------------|
| 1 Schema | T-1.1 | Low — additive zod + types |
| 2 HMAC | T-2.1 | Medium — Web Crypto + constant-time + raw-byte tests |
| 3 Source | T-3.1–T-3.4 | Medium — auth branch, inject, where, idempotency |
| 4 Compat+example | T-4.1, T-4.2 | Low |
| 5 Verify | T-5.1, T-5.2 | Low–Medium (live webhook) |

**Total: 10 tasks.**
