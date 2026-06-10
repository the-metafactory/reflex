# Tasks: R-101 Myelin Transport Integration

Branch: `spec/r-101-myelin-transport` · TDD: every task RED → GREEN → full suite → BLUE → commit.

## T-1: Project scaffold
- package.json (name `@the-metafactory/reflex`, scripts: `test`, `test:integration`, `typecheck`), tsconfig (bun, strict), myelin git-pin dep, zod, yaml.
- ISC: `bun test` runs (0 tests) cleanly; `bunx tsc --noEmit` clean; `bun install` resolves myelin.
- Test: trivial import test `test/scaffold.test.ts` importing myelin transport types.
- Covers: NFR-1 plumbing.

## T-2: Config schema + loader
- `src/config/schema.ts` + `src/config/load.ts`. File + env overlay (env wins), sovereignty defaults, queue limit default 1000.
- Tests `test/config.test.ts`: file only / env only / both (env wins) / invalid → zod error naming field / missing both principal sources → error.
- Covers: FR-6, scenario 2 groundwork.

## T-3: Envelope builders
- `src/bus/envelopes.ts`: `buildActivationFired`, `buildActivationDecision`, `ReflexActor`, type/source constants.
- Tests `test/envelopes.test.ts`: built inputs produce envelopes passing myelin `validateEnvelope` via an InMemory `EnvelopeTransport`; correlation/causation/actor round-trip; derived subject passes `validateSubjectEnvelopeAlignment`.
- Covers: FR-2, FR-3, FR-4; scenario 1 (InMemory twin).

## T-4: ReflexBus facade + metrics
- `src/bus/index.ts` (`createReflexBus`), `src/bus/metrics.ts` (metricsMiddleware + counters), handler-error containment.
- Tests `test/bus.test.ts`: publish/subscribe round-trip InMemory; request/reply round-trip; metrics counters increment; handler throw → contained + counted; nats-type with bogus creds path → throw names path (requireAuth) — scenario 2.
- Covers: FR-1, FR-7, FR-9, FR-10.

## T-5: Bounded publish queue
- `src/bus/queue.ts`: ring buffer, drop-oldest, flush-on-recover, FIFO, head-retry on partial flush failure.
- Tests `test/queue.test.ts`: fill to limit / overflow drops oldest + counts / flush order / partial-failure head retention — scenario 4.
- Covers: FR-8.

## T-6: Stream ensure
- `src/bus/stream.ts`: `ensureReflexStream(bus, cfg)` via myelin `ensureStream`; subject wildcard from myelin helpers.
- Tests: unit (config mapping, InMemory no-op) + `test/integration/stream.test.ts` (create, then idempotent re-run) — scenario 3.
- Covers: FR-5.

## T-7: Integration suite + round-trip demo
- `test/integration/_guard.ts` (probe 127.0.0.1:4222, skip with notice), `roundtrip.test.ts` (publish fired envelope → durable consumer receives, validates, correlation intact), reconnect resume test (<5s).
- Covers: scenarios 1, 5; NFR-2, NFR-3.

## Done gate (feature)
- All spec Definition-of-Done boxes checkable with evidence; vocabulary grep gate green; `specflow validate R-101` shows all artifacts.
