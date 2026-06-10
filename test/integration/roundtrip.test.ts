import { describe, expect, it } from "bun:test";
import { NATSTransport, validateEnvelope } from "@the-metafactory/myelin";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import { createReflexBus } from "../../src/bus";
import { ensureReflexStream } from "../../src/bus/stream";
import { testConfig } from "../helpers";
import { NATS_URL, natsReachable, requireWhenExplicit, skipNotice } from "./_guard";

const up = await natsReachable();
if (!up) skipNotice("roundtrip");
requireWhenExplicit(up, "roundtrip");

const cfg = testConfig({ principal: "jc", stack: "itest" });
const FIRED_SUBJECT = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;

describe.skipIf(!up)("integration: publish round-trip", () => {
  it("fired envelope reaches a durable consumer and validates", async () => {
    const transport = new NATSTransport({ servers: NATS_URL, name: "reflex-itest", streamName: "REFLEX" });
    const bus = createReflexBus(cfg, { transport });
    await ensureReflexStream(transport, cfg);

    const received: MyelinEnvelope[] = [];
    await bus.subscribe(
      FIRED_SUBJECT,
      async (envelope) => {
        received.push(envelope);
      },
      { deliverPolicy: "new", ackPolicy: "explicit" }, // ephemeral: durables accumulate on shared JetStream (sage finding)
    );

    const correlationId = crypto.randomUUID();
    await bus.publishFired({
      target: "@jc/itest",
      payload: { run: 1 },
      idempotencyKey: "itest-1",
      decisionId: "dec-itest",
      correlationId,
      actor: { type: "system", id: "reflex-itest" },
    });

    const deadline = Date.now() + 2000;
    while (received.length === 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(received).toHaveLength(1);
    expect(validateEnvelope(received[0]!).valid).toBe(true);
    expect(received[0]!.correlation_id).toBe(correlationId);
    expect(received[0]!.type).toBe("reflex.activation.fired");
    await bus.close();
  }, 10_000);
});
