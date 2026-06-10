# Plan: R-101 Myelin Transport Integration

**Spec:** `spec.md` (86%) · **Date:** 2026-06-10 · **API verified against:** myelin `src/transport/*` at current main

## Architecture

```
src/
  config/
    schema.ts        # zod schema for reflex daemon config (FR-6)
    load.ts          # file (~/.config/reflex/config.yaml) + REFLEX_* env overrides
  bus/
    index.ts         # createReflexBus(cfg) → ReflexBus facade (FR-1)
    envelopes.ts     # buildActivationFired / buildActivationDecision inputs (FR-2, FR-4)
    queue.ts         # bounded publish ring buffer, 1000, drop-oldest (FR-8)
    stream.ts        # ensureReflexStream via NATSTransport.ensureStream (FR-5)
    metrics.ts       # counters via myelin metricsMiddleware + queue stats (FR-10)
  index.ts           # library exports (library-first; daemon binary lands R-105)
test/
  config.test.ts  envelopes.test.ts  queue.test.ts  bus.test.ts   # offline
  integration/stream.test.ts  integration/roundtrip.test.ts        # live NATS, auto-skip
```

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `ReflexBus` facade composes myelin `createTransport({type})` + `EnvelopeTransport` + `MiddlewareTransport(metricsMiddleware)`. Exposes `publishFired`, `publishDecision`, `subscribe`, `request`, `metrics()`, `close()`. No parallel abstraction: every method delegates to myelin types (`EnvelopePublisher`/`EnvelopeSubscriber`) |
| FR-2 | `envelopes.ts` constants: `REFLEX_SOURCE = "metafactory.reflex.activation"`, types `reflex.activation.fired` / `reflex.activation.decision.{outcome}`. Builders return `EnvelopePublishInput`; `EnvelopeTransport.prepareEnvelope` adds id/timestamp/sovereignty and validates. Default sovereignty `{classification: "local", …}` from config `networkSovereignty` block |
| FR-3 | Subjects never hand-built: `publish(input)` with NO explicit subject → myelin `deriveNatsSubject(envelope, stack)` (stack from config, laptop default `default`). Tests assert `validateSubjectEnvelopeAlignment` on derived subjects |
| FR-4 | `correlation_id` param on both builders; `extensions.causation_id` + `extensions.actor` typed in `ReflexActor` (`{type: "operator"\|"agent"\|"system", id}`) |
| FR-5 | `stream.ts` calls `NATSTransport.ensureStream(EnsureStreamConfig)` with stream `REFLEX`, subjects = derived Reflex prefix wildcard (computed from principal/stack via myelin subject helpers, not string-concat). Idempotency: second call is a no-op (myelin handles create-or-update) |
| FR-6 | `config/schema.ts`: `{principal, stack, nats: {url, creds}, sovereignty?, publish_queue_limit?}`. `load.ts`: read YAML if exists → overlay `REFLEX_PRINCIPAL/REFLEX_STACK/REFLEX_NATS_URL/REFLEX_NATS_CREDS` (env wins) → zod parse. Missing file + complete env = valid |
| FR-7 | Fail-fast: `NATSTransportOptions.requireAuth: true` always in `createReflexBus` for type `nats` (myelin#136 semantics: unset creds → throw; missing file → throw with ENOENT detail). Connect failure → error wrapped with actionable text (url, creds path, DD-72 pointer), caller exits non-zero |
| FR-8 | `queue.ts`: wrap `publish` — on rejection while transport reports disconnected, enqueue `{subject?, input}` in ring buffer (limit from config, default 1000); on reconnect (retry timer, 1s tick) flush FIFO; overflow drops oldest + `metrics.dropped++` + warn log with envelope type |
| FR-9 | Inbound: myelin `EnvelopeTransport.subscribe` already validates; our handler wrapper catches handler throws → log + `metrics.handlerErrors++`, never rethrow to transport |
| FR-10 | `metricsMiddleware` counters (published/received per subject) + queue stats (queued, dropped) + `lastPublishAt`; `ReflexBus.metrics()` returns plain object |
| NFR-1 | All unit tests on `createTransport({type:"memory"})`; `bun test` target <30s |
| NFR-2 | `test/integration/*` guarded: probe `nats://127.0.0.1:4222` with 500ms timeout → `test.skip` with notice when absent. Script `bun test:integration` |
| NFR-3/4 | Reconnect via myelin `reconnect: true`; integration test kills/restarts nats-server, asserts resume <5s. Latency: perf assertion in bus.test (100 publishes < 500ms InMemory) |
| NFR-5 | Wrapper line budget asserted by review, not test; facade delegates only |

## Data Model

No DB in this feature. Config type + `ReflexActor` + builder input types in `src/bus/envelopes.ts`.

**Envelope id format decision:** spec said ULID (DD-68 echo); myelin `createEnvelope` issues UUIDs. Follow myelin — ids are myelin's concern; deviation logged here, spec assumption updated. (Hand-rolling ids would fork the envelope contract.)

## Config Defaults (consolidated)

| Key | Default | Override |
|-----|---------|----------|
| `principal` | — required | `REFLEX_PRINCIPAL` |
| `stack` | `default` | `REFLEX_STACK` |
| `nats.url` | `nats://127.0.0.1:4222` (explicit IPv4 — IPv6 split gotcha) | `REFLEX_NATS_URL` |
| `nats.creds` | `~/.config/nats/creds/reflex.creds` | `REFLEX_NATS_CREDS` |
| `publish_queue_limit` | `1000` | `REFLEX_PUBLISH_QUEUE_LIMIT` |
| `sovereignty` | `{classification: local, data_residency: CH, max_hop: 0, frontier_ok: false, model_class: any}` | file only |

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| Bad creds path | requireAuth throw at first connect | none — startup aborts non-zero with path + DD-72 pointer | nothing partially running |
| JetStream off | `ensureStream` throws JetStreamApiError | none — abort with "enable JetStream (-js)" | startup only |
| Config file unreadable / partial YAML | zod parse at load, before any connection | none — abort naming file + field | startup only |
| Disconnect mid-run | publish rejection + transport status | queue absorbs ≤limit; 1s retry timer flushes FIFO on first successful publish | writes delayed; reads resume via myelin reconnect; SQLite (R-103) keeps truth |
| Queue overflow | ring buffer full | drop OLDEST (newest activation wins — activation is time-sensitive), warn log with envelope type + age, `dropped` counter | bounded memory; audit intact in DB |
| Queue flush partial failure | publish rejection mid-flush | failed item retained at head, flush aborts, next tick retries — FIFO order preserved, no duplicate publish of flushed items | ≤1 redundant retry per tick |
| Handler throws | try/catch in handler wrapper | log + `handlerErrors` counter; subscription stays alive; message ack behavior delegated to myelin NAK policy | one message |
| Cascade: disconnect DURING flush DURING new publishes | flush lock (single in-flight flush); new publishes append behind retained head | next tick resumes; order = arrival order | no interleaving corruption |

## Test Assertions (verifiability detail)

- `config.test.ts`: `expect(load({file, env}).nats.url).toBe(envValue)` (env wins); `expect(() => load(badYaml)).toThrow(/nats\.creds/)`; defaults table above asserted key-by-key.
- `envelopes.test.ts`: `expect(validateEnvelope(captured).valid).toBe(true)`; `expect(captured.type).toBe("reflex.activation.fired")`; `expect(captured.correlation_id).toBe(given)`; `expect(captured.extensions.actor).toEqual({type:"operator",id:"jc"})`; alignment: `expect(validateSubjectEnvelopeAlignment(derivedSubject, captured, "default").aligned).toBe(true)`.
- `bus.test.ts`: round-trip `expect(received[0].payload).toEqual(sent.payload)`; request/reply `expect(reply.correlation_id).toBe(req.correlation_id)`; bogus creds `expect(connect).rejects.toThrow(/reflex\.creds/)`; handler throw → `expect(metrics().handlerErrors).toBe(1)` and second message still delivered.
- `queue.test.ts`: overflow at limit 3 → `expect(dropped).toBe(1)` and flushed order `[2,3,4]`; partial flush failure → head retained, `expect(flushedAfterRecovery).toEqual([2,3,4])` exactly once each.
- `integration/stream.test.ts`: first run `expect(created).toBe(true)`; second run asserts stream config unchanged (`jsm.streams.info` deep-equal before/after).
- `integration/roundtrip.test.ts`: durable consumer receives within 2s; kill/restart nats-server → `expect(resumeMs).toBeLessThan(5000)`.

Framework: `bun:test` (describe/it/expect), no mocking library — fakes via myelin `InMemoryTransport` and a `FailingPublisher` test double.

## Constitutional Compliance

- **CLI-First:** n/a this feature (library); CLI lands R-107 — noted, not violated
- **Library-First:** `src/index.ts` exports the bus as a reusable module ✓
- **Test-First:** every task below starts RED ✓
- **Deterministic:** no randomness beyond ids delegated to myelin; queue FIFO ✓
- **Code Before Prompts:** all logic in TS ✓

## Test Mapping (spec acceptance scenarios)

| Scenario | Test |
|----------|------|
| 1 publish round-trip + validation | `integration/roundtrip.test.ts` + InMemory twin in `bus.test.ts` |
| 2 fail-fast missing creds | `bus.test.ts` (nats type, fake path, expect throw naming path) |
| 3 stream ensure idempotent | `integration/stream.test.ts` (twice, second no-op) |
| 4 outage queue + flush | `queue.test.ts` (injected failing publisher → recover) |
| 5 offline tests | the suite itself + skip-notice assertion in `integration/_guard.ts` |

## Implementation Order (→ tasks.md)

T-1 scaffold (package.json, tsconfig, myelin pin, scripts) → T-2 config → T-3 envelopes → T-4 bus facade + metrics → T-5 queue → T-6 stream ensure → T-7 integration suite + round-trip demo.

## Dependencies / Risks

- Myelin pinned to current main commit (same mechanism as cortex/grove). Risk: API drift on bump — integration suite is the regression gate.
- `Sovereignty` requires `data_residency`/`max_hop`/`frontier_ok`/`model_class`: defaults `{classification: local, data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any"}` in config schema (overridable).
