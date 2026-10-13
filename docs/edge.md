# Reflex on Cloudflare Workers (iteration 3, reflex#15)

The pipeline core (evaluate / guards / six-outcome taxonomy) is unchanged —
the edge deployment swaps adapters at the same seams the local daemon uses:

| Local (daemon) | Edge |
|---|---|
| bun:sqlite `Repository` | `D1Repository` (`src/store/d1-repository.ts`) — same schema, CAS via `meta.changes` + batch |
| NATS TCP (`buildNatsTransport`) | myelin `WebSocketTransport` (`@the-metafactory/myelin/transport/websocket`) held by the Durable Object |
| croner `ScheduleSource` (R-105) | Cron Triggers → `EdgeScheduleSource` (`src/edge/schedule.ts`) |
| `Bun.serve` `HttpSource` (R-109) | Workers fetch → `EdgeHttpSource` (`src/edge/http.ts`) |
| config files + fs.watch (R-102) | KV documents → `loadBlueprintsFromKV` + DO alarm refresh |
| launchd/systemd (R-111) | platform-managed |

## Topology

ONE `ReflexConsumer` Durable Object instance is the single-writer evaluation
host. The stateless Worker forwards impulse HTTP traffic and Cron Trigger
firings into it, so per-blueprint serialization holds deployment-wide exactly
like the local daemon process; D1 CAS additionally guards at the storage
layer. The DO holds the bus connection (durable subscriptions for bus-kind
blueprints + the `execution.run.finished` consumer) and refreshes blueprints from KV
every 5 minutes via alarm.

## Deploy gates (DD-122 — read before any production traffic)

`local`-classified envelopes may be evaluated on principal-owned cloud
tenancy **iff**:

1. this deployment is declared in the sovereignty policy
   (`trusted_substrates` — schema work tracked in meta-factory after DD-122),
2. the Activation-Payload at-rest rule is decided (declared residency
   acceptance vs principal-key encryption). Decision rows in D1 carry full
   impulse payloads — the edge equivalent of the 0600-file finding (R-103).

Until both: dev/preview traffic only.

## Setup

```bash
# 1. resources
wrangler d1 create reflex
wrangler kv namespace create REFLEX_BLUEPRINTS
#    → paste ids into wrangler.toml

# 2. schema (drizzle/ SQL is the migration source for BOTH drivers)
wrangler d1 migrations apply reflex --remote

# 3. secrets
wrangler secret put REFLEX_NATS_CREDS        # inline .creds CONTENT
wrangler secret put <TOKEN_BINDING>          # one per http blueprint token_env

# 4. blueprints (same YAML documents the local daemon reads)
wrangler kv key put --binding REFLEX_BLUEPRINTS activation/pr-stats.yaml --path ./reflex.yaml

# 5. crons: every schedule-blueprint expression MUST be listed in
#    wrangler.toml [triggers].crons — the DO /status route (internal)
#    reports drift (scheduleExpressions vs your declared list).

wrangler deploy
```

## Platform-inherited differences (accepted, v0)

- **HTTP rate limit is per-isolate**, not global — Cloudflare may run many
  isolates, so the effective limit is N×configured. Abuse brake, not quota.
- **Cron Triggers fire in UTC**; blueprint `timezone` is ignored on edge
  (warned loudly). Express UTC schedules in blueprints meant for edge.
- **No hibernation**: the DO keeps a live WS connection with alarm
  keep-alive. Hibernation needs DO-native WebSockets — incompatible with a
  client library's socket. Revisit post-v0.
- **token_env names a secret BINDING** on the Worker, not a process env var.
- **Blueprint staleness window** = alarm period (5 min) + KV propagation
  (eventually consistent, up to ~60s) — nothing in Reflex assumes fresher.
- **DO eviction (deploy/restart) drops in-memory subscriptions** until the
  next event wakes the DO and re-subscribes. JetStream durable consumers
  are EXPECTED to resume from the ack floor on resubscribe (bounding the
  damage to delayed redelivery) — that resumption is part of the live
  verification scope below, not proven by this PR.
- **Bundle is fully Node-free** (myelin#190): all myelin imports on the
  edge graph go through `@the-metafactory/myelin/edge`, and
  `ensureReflexStream` duck-types the transport instead of
  `instanceof NATSTransport`. The wrangler bundle greps clean for
  transport-node/node:fs/node:net/node:os, `nodejs_compat` is OFF
  (regressions fail loudly at build), and the bundle dropped ~295 KB raw /
  ~57 KB gzip.

## Verification status — honest scope

What the test suite proves: **structure + sync parity + SQL logic**. 25 edge
tests under `bun test` (`test/edge/`): D1Repository CAS/batch/single-take
logic against a D1 shim over bun:sqlite, HTTP auth-before-existence parity,
cron mapping incl. zero-match warning, KV loading with pagination +
duplicate-id errors. `wrangler deploy --dry-run` proves the worker
**compiles and bundles** — not that it instantiates or runs.

What is NOT yet verified (live-runtime items, blocked on DD-122 follow-ups
before any meaningful traffic exists to test with):

- workerd instantiation (dormant transport-node module-load under
  `nodejs_compat`)
- real D1: concurrent CAS under contention, read-replica staleness
  (resolveMatched's pre-read can spuriously miss a fresh decision on a
  replica — pin via Sessions API or retry; noted in code), error taxonomy
- the WS connection lifecycle from a DO (reconnect, eviction, alarm retry)
- await-interleaving inside the DO: per-blueprint serialization
  (Pipeline.chains) and BusSource's single-flight sync guard the known
  cross-await invariants, but this is analyzed, not load-tested.

## GitHub webhooks (F-003) — watch repos for PRs/Issues, laptop-free

The edge HTTP impulse source supports a **GitHub-HMAC** auth mode so a GitHub
webhook can drive reflex directly — the whole cycle on Cloudflare, nothing on
the operator's machine.

Blueprint (`when.http`):

```yaml
when:
  http:
    auth:
      mode: github_hmac
      secret_env: GITHUB_WEBHOOK_SECRET   # Worker secret BINDING name
    where:
      github_event: pull_request          # X-GitHub-Event header
      action: opened                      # flat top-level payload field
```

- **Auth:** `auth: { mode: bearer | github_hmac, secret_env }`. `github_hmac`
  verifies `X-Hub-Signature-256` = `HMAC_SHA256(secret, rawBody)` (Web Crypto,
  constant-time, over the exact received bytes). `token_env` remains the Bearer
  shorthand; `token_env` and `auth` are mutually exclusive.
- **Filtering:** optional `where` (flat field-equals, same matcher as bus). In
  `github_hmac` mode the source injects three top-level payload fields before
  matching/forwarding: `github_event` (from `X-GitHub-Event`), `repository`
  (the payload's `repository.full_name`), and `github_delivery` (from
  `X-GitHub-Delivery`). A non-match returns a 202 `{ignored, no-match}`
  response (no fire, no Decision recorded).
- **Idempotency:** there is no explicit delivery-id key override. The pipeline's
  idempotency key is the hash of the blueprint id + the canonical payload, and
  `github_delivery` is part of that payload — so a GitHub *redelivery* (which
  reuses the same delivery GUID and body) hashes identically and dedups to a
  single fire. Two genuinely distinct deliveries hash differently and both fire.

Setup:

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET     # the webhook's shared secret
# GitHub repo → Settings → Webhooks → Add webhook:
#   Payload URL:  https://<reflex-edge-host>/impulse/<blueprint-id>
#   Content type: application/json
#   Secret:       <same value>
#   Events:       Pull requests / Issues
```

A bad/missing signature → 401 (indistinguishable from a missing blueprint —
auth precedes existence). See `examples/github-pr-opened/`.
