import { describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus } from "../src/bus";
import { ACTIVATION_FIRED_TYPE } from "../src/bus/envelopes";
import { testConfig } from "./helpers";

const cfg = testConfig();

function memoryBus() {
  const transport = createTransport({ type: "memory" });
  return createReflexBus(cfg, { transport });
}

const FIRED_SUBJECT = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;

function firedInput(overrides: Record<string, unknown> = {}) {
  return {
    target: "@jc/f-pr-stats",
    payload: { mode: "daily" },
    idempotencyKey: "k1",
    decisionId: "dec-1",
    correlationId: crypto.randomUUID(),
    actor: { type: "system" as const, id: "reflex-test" },
    ...overrides,
  };
}

describe("ReflexBus", () => {
  it("publishes a fired envelope a subscriber receives on the derived subject", async () => {
    const bus = memoryBus();
    const received: unknown[] = [];
    await bus.subscribe(FIRED_SUBJECT, async (envelope) => {
      received.push(envelope);
    });
    const input = firedInput();
    await bus.publishFired(input);
    await Bun.sleep(10);
    expect(received).toHaveLength(1);
    const envelope = received[0] as { type: string; payload: { target: string }; correlation_id: string };
    expect(envelope.type).toBe(ACTIVATION_FIRED_TYPE);
    expect(envelope.payload.target).toBe("@jc/f-pr-stats");
    expect(envelope.correlation_id).toBe(input.correlationId as string);
    await bus.close();
  });

  it("publishes decision audit envelopes per outcome", async () => {
    const bus = memoryBus();
    const received: Array<{ type: string }> = [];
    await bus.subscribe(`local.${cfg.principal}.${cfg.stack}.reflex.activation.decision.blocked`, async (e) => {
      received.push(e as { type: string });
    });
    await bus.publishDecision({
      outcome: "blocked",
      blueprintId: "pilot-scan",
      decisionId: "dec-2",
      reason: "cooldown",
    });
    await Bun.sleep(10);
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("reflex.activation.decision.blocked");
    await bus.close();
  });

  it("request/reply round-trips with matching correlation", async () => {
    const bus = memoryBus();
    const cmdSubject = `local.${cfg.principal}.${cfg.stack}.reflex.cmd.status`;
    await bus.subscribeReplyable(cmdSubject, async (envelope) => ({
      source: `${cfg.principal}.reflex.activation`,
      type: "reflex.cmd.status.reply",
      payload: { ok: true, echo: envelope.payload },
    }));
    const reply = await bus.request(
      { source: `${cfg.principal}.reflex.activation`, type: "reflex.cmd.status", payload: { q: 1 }, timeoutMs: 1000 },
      cmdSubject,
    );
    expect(reply.payload.ok).toBe(true);
    await bus.close();
  });

  it("counts published and received in metrics", async () => {
    const bus = memoryBus();
    await bus.subscribe(FIRED_SUBJECT, async () => {});
    await bus.publishFired(firedInput());
    await Bun.sleep(10);
    const m = bus.metrics();
    expect(m.published).toBe(1);
    expect(m.received).toBe(1);
    expect(m.lastPublishAt).not.toBeNull();
    await bus.close();
  });

  it("contains handler errors and keeps the subscription alive", async () => {
    const bus = memoryBus();
    let calls = 0;
    await bus.subscribe(FIRED_SUBJECT, async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    });
    await bus.publishFired(firedInput());
    await bus.publishFired(firedInput());
    await Bun.sleep(10);
    expect(calls).toBe(2);
    expect(bus.metrics().handlerErrors).toBe(1);
    await bus.close();
  });

  it("queues publishes during an outage and flushes on recovery", async () => {
    const inner = createTransport({ type: "memory" });
    let down = false;
    const flaky = {
      publish: (subject: string, envelope: never) => {
        if (down) return Promise.reject(new Error("connection lost"));
        return inner.publish(subject, envelope);
      },
      request: inner.request.bind(inner),
      subscribe: inner.subscribe.bind(inner),
      subscribeBestEffort: inner.subscribeBestEffort.bind(inner),
      close: inner.close.bind(inner),
    };
    const bus = createReflexBus(cfg, { transport: flaky as never, flushIntervalMs: 20 });
    const received: unknown[] = [];
    await bus.subscribe(FIRED_SUBJECT, async (e) => {
      received.push(e);
    });

    down = true;
    await bus.publishFired(firedInput()); // must NOT reject
    await bus.publishFired(firedInput());
    expect(bus.metrics().queued).toBe(2);
    expect(received).toHaveLength(0);

    down = false;
    await Bun.sleep(80); // flush timer fires
    expect(bus.metrics().queued).toBe(0);
    expect(received).toHaveLength(2);
    await bus.close();
  });

  it("drops oldest beyond the queue limit and counts it", async () => {
    const failing = {
      publish: () => Promise.reject(new Error("down")),
      request: () => Promise.reject(new Error("down")),
      subscribe: () => Promise.resolve({ unsubscribe: async () => {} }),
      subscribeBestEffort: () => Promise.resolve({ unsubscribe: async () => {} }),
      close: async () => {},
    };
    const bus = createReflexBus(testConfig({ publishQueueLimit: 2 }), {
      transport: failing as never,
      flushIntervalMs: 100_000,
    });
    for (let i = 0; i < 3; i++) await bus.publishFired(firedInput());
    expect(bus.metrics().queued).toBe(2);
    expect(bus.metrics().dropped).toBe(1);
    await bus.close();
  });

  it("fails fast on nats transport with missing creds file", () => {
    expect(() =>
      createReflexBus(testConfig({ nats: { url: "nats://127.0.0.1:4222", creds: "/tmp/definitely-missing.creds" } })),
    ).toThrow(/definitely-missing\.creds/);
  });
});
