# Reflex on Cloudflare Workers (iteration 3, reflex#15)

The pipeline core (evaluate / guards / six-outcome taxonomy) is unchanged —
the edge deployment swaps adapters at the same seams the local daemon uses:

| Local (daemon) | Edge |
|---|---|
| bun:sqlite `Repository` | `D1Repository` (`src/store/d1-repository.ts`) — same schema, CAS via `meta.changes` + batch |
| NATS TCP (`buildNatsTransport`) | myelin `WebSocketTransport` (`@the-metafactory/myelin/transport/websocket`) held by the Durable Object |
| croner `ScheduleSource` (R-105) | Cron Triggers → `CronSource` (`src/edge/cron.ts`) |
| `Bun.serve` `HttpSource` (R-109) | Workers fetch → `EdgeHttpSource` (`src/edge/http.ts`) |
| config files + fs.watch (R-102) | KV documents → `loadBlueprintsFromKV` + DO alarm refresh |
| launchd/systemd (R-111) | platform-managed |

## Topology

ONE `ReflexConsumer` Durable Object instance is the single-writer evaluation
host. The stateless Worker forwards impulse HTTP traffic and Cron Trigger
firings into it, so per-blueprint serialization holds deployment-wide exactly
like the local daemon process; D1 CAS additionally guards at the storage
layer. The DO holds the bus connection (durable subscriptions for bus-kind
blueprints + the pulse run-outcome consumer) and refreshes blueprints from KV
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
#    wrangler.toml [triggers].crons — GET /status reports drift
#    (cronExpressions vs your declared list).

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
- **Bundle carries dead `@nats-io/transport-node` code**: the myelin root
  barrel re-exports `NATSTransport` (CJS dep — not tree-shakeable). It never
  executes on edge (the WS transport is injected), `nodejs_compat` satisfies
  its module-load imports, and the bundle stays well under limits (~290 KB
  gzip). A myelin follow-up for edge-safe envelope/middleware subpaths would
  remove it.

## Verification status

Everything testable without a Cloudflare account is tested under `bun test`
(`test/edge/`): D1 CAS semantics against a D1 shim over bun:sqlite, HTTP
auth-before-existence parity, cron expression mapping, KV loading with
pagination + duplicate-id errors. `wrangler deploy --dry-run` proves the
bundle. **Not yet exercised live**: workerd runtime, real D1, the WS
connection from a DO — first live exercise is gated on DD-122 follow-ups.
