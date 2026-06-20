# Technical Plan: GitHub-webhook HTTP impulse source (HMAC)

## Architecture Overview

```
                     GitHub Webhook POST
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  EdgeHttpSource (src/edge/http.ts)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 1. Route match: POST /impulse/{blueprint-id}               │  │
│  │ 2. Load blueprint → resolve auth mode                      │  │
│  │    ├─ mode: bearer    → verify Authorization header        │  │
│  │    └─ mode: github_hmac → verify X-Hub-Signature-256       │  │
│  │ 3. Auth BEFORE existence (401 for both bad sig & missing)  │  │
│  │ 4. Rate limit bucket                                       │  │
│  │ 5. Read + bound raw body (256 KB)                          │  │
│  │ 6. HMAC verify over raw bytes, THEN JSON parse             │  │
│  │ 7. Inject github_event, repository into payload            │  │
│  │ 8. Apply where filter (flat field-equals)                  │  │
│  │ 9. Derive idempotency key from X-GitHub-Delivery           │  │
│  │10. sink.evaluate(impulse) → Decision in D1                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│                      202 + verdict                               │
└──────────────────────────────────────────────────────────────────┘
```

**Key invariant**: Raw bytes read ONCE, used for HMAC verification, THEN parsed as JSON. No re-serialization.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| HMAC | `crypto.subtle.importKey` + `crypto.subtle.sign` | Web Crypto API, Node-free, available in workerd and Bun |
| Constant-time compare | XOR-accumulate over bytes | Existing pattern in `constantTimeEquals`, portable |
| Where matcher | `matches()` from `src/sources/bus.ts` | Reuse existing flat field-equals logic |
| Secrets | Worker secret bindings | Existing pattern, never committed |
| Schema | Zod | Project standard |

## Data Model

### Type Changes (`src/activation/types.ts`)

```typescript
/** Auth mode for HTTP impulse sources. */
export type HttpAuthMode = "bearer" | "github_hmac";

export interface HttpAuth {
  mode: HttpAuthMode;
  secret_env: string;
}

export interface HttpWhen {
  http: {
    /** @deprecated Use auth block. Shorthand for auth: { mode: "bearer", secret_env } */
    token_env?: string;
    /** Generic auth block — mutually exclusive with token_env. */
    auth?: HttpAuth;
    /** Flat field-equals filter (same as bus.where). */
    where?: Record<string, string | number | boolean>;
  };
}
```

### Schema Changes (`src/activation/schema.ts`)

```typescript
const httpAuthSchema = z.object({
  mode: z.enum(["bearer", "github_hmac"]),
  secret_env: z.string().min(1),
}).strict();

const httpSchema = z.object({
  token_env: z.string().min(1).optional(),
  auth: httpAuthSchema.optional(),
  where: flatWhere.optional(), // reuse existing flatWhere
}).strict().superRefine((http, ctx) => {
  // token_env and auth are mutually exclusive
  if (http.token_env && http.auth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "token_env and auth are mutually exclusive — use auth block",
    });
  }
  // At least one must be present
  if (!http.token_env && !http.auth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "http source requires either token_env or auth block",
    });
  }
});
```

### Impulse Payload Injection

For `github_hmac` mode, inject before matching and forwarding:

```typescript
interface GitHubInjectedPayload extends Record<string, unknown> {
  github_event: string;      // from X-GitHub-Event header
  repository?: string;       // from payload.repository.full_name
  // ... rest of GitHub payload
}
```

## API Contracts

### Blueprint YAML (new format)

```yaml
schema: metafactory/activation/v1
activations:
  - id: gh-pr-opened
    target: "@jc/handle-pr"
    when:
      http:
        auth:
          mode: github_hmac
          secret_env: GH_WEBHOOK_SECRET
        where:
          github_event: pull_request
          action: opened
          repository: "owner/repo"
    policy: auto
```

### Blueprint YAML (backward-compatible)

```yaml
# Still works: token_env shorthand
  - id: api-trigger
    when:
      http:
        token_env: API_TOKEN
```

### HTTP Response Contract

| Condition | Status | Body |
|-----------|--------|------|
| Bad/missing signature | 401 | `{"error":"unauthorized"}` |
| Missing blueprint (after auth) | 404 | `{"error":"no http Activation Blueprint..."}` |
| where non-match | 202 | `{"outcome":"ignored","reason":"no-match"}` |
| Success | 202 | `{"outcome":"fired","decision_id":"..."}` |
| Body exceeds 256 KB | 413 | `{"error":"body exceeds..."}` |

## Implementation Phases

### Phase 1: Schema + Types (low risk)

1. Extend `HttpWhen` in `src/activation/types.ts` with `auth` and `where` fields
2. Add `httpAuthSchema` to `src/activation/schema.ts` with mutual-exclusion validation
3. Update `normalizeWhen()` to preserve new fields
4. Add tests for schema validation (valid, back-compat, mutual-exclusion error)

**Files**:
- `src/activation/types.ts`
- `src/activation/schema.ts`
- `test/activation/schema.test.ts`

### Phase 2: HMAC Verification Helper (isolated, testable)

1. Create `src/edge/hmac.ts` with:
   - `verifyGitHubSignature(rawBody: Uint8Array, secret: string, signature: string): Promise<boolean>`
   - Uses `crypto.subtle.importKey("raw", ..., {name: "HMAC", hash: "SHA-256"}, ...)`
   - Uses `crypto.subtle.sign("HMAC", key, rawBody)`
   - Constant-time compare result vs. extracted hex from `sha256=<hex>`
2. Unit tests with known GitHub signature vectors

**Files**:
- `src/edge/hmac.ts` (new)
- `test/edge/hmac.test.ts` (new)

### Phase 3: EdgeHttpSource Auth Refactor

1. Extract auth resolution: `resolveAuth(blueprint): { mode, secret } | null`
   - `token_env` → `{ mode: "bearer", secret }`
   - `auth` → `{ mode, secret }`
2. Refactor `authorize()` to dispatch by mode:
   - `bearer` → existing `bearerOf()` + constant-time compare
   - `github_hmac` → call `verifyGitHubSignature()` with raw body bytes
3. **Critical**: read body ONCE into `Uint8Array`, verify HMAC, THEN decode + parse
4. Update misconfig warning to cover both modes

**Files**:
- `src/edge/http.ts`
- `test/edge/edge-sources.test.ts`

### Phase 4: Where Filtering + Field Injection

1. Import `matches()` from `src/sources/bus.ts` (or extract to shared `src/lib/matches.ts`)
2. In `github_hmac` mode, after JSON parse:
   - Inject `github_event` from `X-GitHub-Event` header
   - Inject `repository` from `payload.repository?.full_name`
3. Apply `where` filter before evaluate
4. Non-match → return `202 { outcome: "ignored", reason: "no-match" }` (no Decision recorded, or ignored counter bump)

**Files**:
- `src/lib/matches.ts` (new, extracted from bus.ts)
- `src/sources/bus.ts` (import from lib)
- `src/edge/http.ts`
- `test/edge/edge-sources.test.ts`

### Phase 5: Idempotency Key Override

1. In `github_hmac` mode, extract `X-GitHub-Delivery` header
2. If present, use as idempotency key directly (skip `deriveIdempotencyKey`)
3. If absent, fall back to derived key (GitHub always sends it, but defensive)
4. Impulse gains optional `idempotencyKeyOverride?: string` field

**Files**:
- `src/pipeline/impulse.ts` (add override field)
- `src/pipeline/guards.ts` (use override if present)
- `src/edge/http.ts` (pass delivery id)
- `test/edge/edge-sources.test.ts`
- `test/pipeline/guards.test.ts`

### Phase 6: Daemon HttpSource Parity (if in scope)

Open question from spec: does local daemon `src/sources/http.ts` also get HMAC?

**If yes** (same phases 2-5 for that file), likely:
- Reuse `src/edge/hmac.ts` (but Bun can also use `crypto.subtle`)
- Same auth/where/injection logic

**If no** (edge-only MVP):
- Document that local http source remains Bearer-only
- Future work item

### Phase 7: Integration Test + Example Blueprint

1. Add example blueprint: `examples/github-pr-watch.yaml`
2. Integration test simulating GitHub POST with valid/invalid signatures
3. Test redelivery idempotency (same `X-GitHub-Delivery` → single fire)

**Files**:
- `examples/github-pr-watch.yaml` (new)
- `test/integration/github-webhook.test.ts` (new)

## File Structure

```
src/
├── activation/
│   ├── types.ts          # HttpWhen extended with auth + where
│   └── schema.ts         # httpAuthSchema, mutual-exclusion
├── edge/
│   ├── hmac.ts           # NEW: verifyGitHubSignature()
│   └── http.ts           # Auth dispatch, where filter, field injection
├── lib/
│   └── matches.ts        # NEW: extracted flat field-equals matcher
├── pipeline/
│   ├── impulse.ts        # idempotencyKeyOverride field
│   └── guards.ts         # Use override key
└── sources/
    ├── bus.ts            # Import matches from lib
    └── http.ts           # (optional) parity if in scope

test/
├── edge/
│   ├── edge-sources.test.ts  # Extended with HMAC tests
│   └── hmac.test.ts          # NEW: HMAC verification unit tests
├── pipeline/
│   └── guards.test.ts        # Override key tests
└── integration/
    └── github-webhook.test.ts # NEW: end-to-end simulation

examples/
└── github-pr-watch.yaml      # NEW: example blueprint
```

## Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| `crypto.subtle` | Built-in | Web Crypto API, available in workerd + Bun |
| Worker secret bindings | Runtime | `wrangler secret put <name>` |
| GitHub webhook setup | External | Operator creates webhook on repo |

**No new npm packages.** Bundle stays Node-free.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| HMAC timing leak | High | Low | Constant-time compare already implemented; reuse pattern |
| Raw bytes mutated before verify | High | Low | Single read path; verify before decode |
| `where` field name collision with GitHub payload | Medium | Medium | Injected fields documented; top-level only |
| Missing `X-GitHub-Delivery` | Low | Very Low | GitHub always sends; fallback to derived key |
| Bundle size regression | Low | Low | `crypto.subtle` is built-in, no new deps |
| Daemon parity scope creep | Medium | Medium | Decide in Open Questions before Phase 6 |

## Open Questions Resolution Needed

1. **Daemon parity**: Does `src/sources/http.ts` (Bun.serve) get HMAC in this feature, or edge-only for MVP?
   - **Recommendation**: Edge-only MVP. Daemon http source remains Bearer-only. Document as future work.
   
2. **where nested matches**: Spec says "top-level only for v1". Confirm no dot-path syntax (e.g., `repository.owner.login`).
   - **Recommendation**: Confirm top-level only. Injected `repository` field flattens the common case.

## Verification Criteria

From spec's Definition of Done:

- [ ] Real GitHub webhook → reflex-edge fires Decision in D1 on PR-opened **with laptop offline**
- [ ] Tampered body → 401
- [ ] Redelivery (same `X-GitHub-Delivery`) → single fire
- [ ] Bearer blueprints unchanged
- [ ] Bundle Node-free (`nodejs_compat` OFF)
- [ ] No bus/cron/#19 dependency

## Example Test Case

```typescript
// test/edge/edge-sources.test.ts
describe("github_hmac auth mode", () => {
  const secret = "webhook-secret";
  
  async function signPayload(body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return "sha256=" + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  it("valid HMAC signature fires", async () => {
    const body = JSON.stringify({ action: "opened", repository: { full_name: "o/r" } });
    const sig = await signPayload(body);
    const source = new EdgeHttpSource(
      new BlueprintStore([bp({ when: { http: { auth: { mode: "github_hmac", secret_env: "GH" }, where: { github_event: "pull_request" } } } })]),
      sink(),
      { GH: secret }
    );
    const response = await source.handle(post("/impulse/bp", {
      headers: { "x-hub-signature-256": sig, "x-github-event": "pull_request", "content-type": "application/json" },
      body,
    }));
    expect(response.status).toBe(202);
    expect((await response.json()).outcome).toBe("fired");
  });

  it("invalid signature is 401", async () => {
    const source = new EdgeHttpSource(
      new BlueprintStore([bp({ when: { http: { auth: { mode: "github_hmac", secret_env: "GH" } } } })]),
      sink(),
      { GH: secret }
    );
    const response = await source.handle(post("/impulse/bp", {
      headers: { "x-hub-signature-256": "sha256=bad", "x-github-event": "push", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
  });
});
```

---

*Plan ready for implementation. Phases 1-5 are the MVP; Phase 6 depends on daemon parity decision; Phase 7 is validation.*

## Constitutional Compliance

- [x] **CLI-First:** no new CLI; the surface is the existing `POST /impulse/<id>` webhook + `/status`. Setup is `wrangler secret put <secret_env>` + a GitHub webhook config.
- [x] **Library-First:** HMAC verification + the `github_hmac` branch live as small, injectable helpers in `EdgeHttpSource`; the flat-field matcher is reused from `src/sources/bus.ts` (`matches`), not re-implemented.
- [x] **Test-First:** unit tests for HMAC (good/bad/missing sig, raw-byte exactness), `where` filtering, injected-field shape, delivery-id idempotency, and Bearer back-compat are authored before wiring.
- [x] **Deterministic:** verification + matching are pure functions of (raw body, headers, secret, blueprint); no randomness, time only via the existing rate-limit bucket.
- [x] **Code Before Prompts:** entirely deterministic code; no prompt surface.

## Failure Mode Analysis

### How this code can fail

| Failure Mode | Trigger | Detection | Degradation | Recovery |
|--------------|---------|-----------|-------------|----------|
| Signature bypass | HMAC computed over re-serialized (not raw) bytes | unit test pins raw-byte exactness | would accept tampered bodies | verify over the exact bounded raw read, before JSON.parse |
| Timing oracle | early-exit string compare | code review | leaks signature info | constant-time compare (reuse `constantTimeEquals`) |
| crypto.subtle unavailable | runtime without Web Crypto | build/test | HMAC throws → 401 | workerd + Bun both provide it; bundle grep stays Node-free |
| Secret unset | `secret_env` binding missing | logged once | route disabled (401) | parity with Bearer misconfig path |
| Redelivery storm | GitHub at-least-once | idempotency key (delivery id) | duplicate fires | dedup on `X-GitHub-Delivery` |
| Oversize body | >256 KB payload | existing bound | 413 before HMAC | unchanged bound |

### Assumptions that could break

| Assumption | Invalidated by | Detection |
|------------|----------------|-----------|
| GitHub sends `X-Hub-Signature-256` (sha256) | GitHub deprecates/changes header | live e2e + a sig-missing test → 401 |
| `repository.full_name` present | non-repo events (ping) | `where` on repository simply won't match; test covers ping |
| `crypto.subtle` HMAC parity workerd↔Bun | runtime divergence | same vectors tested on Bun + verified live on workerd |

### Blast Radius

- **Files touched:** ~4 (`src/edge/http.ts`, `src/activation/schema.ts`, `src/activation/types.ts`, example blueprint) + tests.
- **Systems affected:** the edge HTTP impulse surface only. Bearer path, bus, schedule, D1 schema unchanged.
- **Rollback:** revert the commit; `auth`/`where` are additive (Bearer `token_env` untouched), so no migration.

## Longevity Assessment

### Maintainability

| Indicator | Status | Notes |
|-----------|--------|-------|
| Readable in 6 months? | Yes | small auth branch + reused matcher |
| Testable without manual runs? | Yes | pure HMAC/match units; live e2e for the platform leg |
| "Why" captured? | Yes | spec + #23 record the laptop-free rationale + the Option A/B trade |

### Evolution vectors

| What might change | Preparation | Impact |
|-------------------|-------------|--------|
| New auth provider (GitLab HMAC, generic) | `auth.mode` enum is the seam | Low |
| Nested `where` matching | matcher isolated (shared with bus) | Medium |
| Local daemon parity (R-109 `Bun.serve`) | same `auth`/`where` schema | Low (tracked follow-up) |
| Signature alg change (sha512) | `mode`/verify isolated | Low |

### Deletion criteria

- [ ] Superseded by a bus-native GitHub path (Option B) once reflex#19 + a CF-side publisher land.
- [ ] `github_hmac` mode removed if reflex drops direct-webhook ingestion.

## Estimated Complexity

- **New files:** 0 (helpers added to `src/edge/http.ts`) + 1 example blueprint
- **Modified files:** ~3 (`http.ts`, `schema.ts`, `types.ts`)
- **Test files:** ~1 new/expanded (`test/edge/http.test.ts` or `edge-sources.test.ts`)
- **Estimated tasks:** ~8
- **Debt score:** 2/5 — additive, no new deps (Web Crypto built-in), no schema migration (Bearer untouched), reuses the bus matcher.
