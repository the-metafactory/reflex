# F-003 — GitHub-webhook HTTP impulse source (HMAC): implementation notes

Tracked in the-metafactory/reflex#23. Lets reflex watch GitHub repos for new
PRs/Issues with nothing on the operator's laptop in the loop.

## What changed

- **`src/activation/types.ts`** — `HttpAuthMode = "bearer" | "github_hmac"`;
  `HttpAuth { mode, secret_env }`; `HttpWhen.http` gains `auth?` and `where?`;
  `token_env?` kept as the Bearer shorthand.
- **`src/activation/schema.ts`** — `httpAuthSchema` + `httpWhenSchema`
  (`auth` + `where` reusing `flatWhere`); `superRefine`: `token_env` XOR `auth`
  (exactly one). `normalizeWhen` carries the new fields through.
- **`src/edge/http.ts`** — `EdgeHttpSource`:
  - reads the raw body **once** (bounded 256 KB); `github_hmac` verifies
    `X-Hub-Signature-256` = `HMAC_SHA256(secret, rawBytes)` via Web Crypto
    (`crypto.subtle.importKey/sign`), constant-time hex compare, over the EXACT
    bytes (JSON parsed from the same bytes).
  - `authorize()` is mode-aware (`bearer` | `github_hmac`), async, and keeps
    auth-before-existence: bad/missing credential or unset secret → 401.
  - `github_hmac` injects top-level `github_event` (header), `repository`
    (`repository.full_name`), `github_delivery` (header) before matching/forwarding.
  - optional `where` (reuses `matches` from `src/sources/bus.ts`); non-match →
    Ignored Decision (202), not a fire.
  - `github_delivery` rides in the payload → the pipeline idempotency key dedups
    GitHub's at-least-once redelivery.
  - Bearer path unchanged.
- **`examples/github-pr-opened/reflex.yaml`** + **`docs/edge.md`** — GitHub-watch
  example + setup.

## Why direct (Option A), not the cortex bus

The cortex `grove-webhook-proxy`/`cortex-api` receive GitHub deliveries on
Cloudflare but publish `local.jc.github.*` to the bus from the cortex *runtime*
(no NATS creds in the Worker), and reflex consuming on edge would still need
reflex#19. Direct GitHub → reflex-edge is self-contained: no bus, no cortex
runtime, no #19, no clawbox, no CF cron.

## Setup (operator)

```
wrangler secret put GITHUB_WEBHOOK_SECRET     # the delivery's shared secret
# GitHub repo → Settings → Webhooks → Add:
#   Payload URL:  https://<reflex-edge-host>/impulse/<blueprint-id>
#   Content type: application/json
#   Secret:       <same value>
#   Events:       Pull requests / Issues
```

## Verification

- **Unit:** `test/edge/edge-sources.test.ts` github_hmac block (valid sig fires +
  injected fields; tampered/missing/wrong-secret/unset → 401; where non-match →
  ignored) + `test/activation/schema.test.ts` (auth block accepted, mutual
  exclusivity, bad mode). Full suite green; tsc clean.
- **Bundle:** dry-run Node-free (`crypto.subtle` bundled; 0 `node:*`/transport-node;
  `nodejs_compat` OFF).
- **Live e2e:** a self-signed GitHub-shaped delivery against the deployed worker
  → 202 Matched Decision in remote D1; tampered body → 401. Configuring a real
  repo webhook + the operator's laptop offline is the final operator step.

## Follow-ups

- Local daemon `Bun.serve` http source (R-109) `auth`/`where`/HMAC parity (edge-only for MVP).
- Nested `where` matching beyond the two injected fields (top-level only in v1).
