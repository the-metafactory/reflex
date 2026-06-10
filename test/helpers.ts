import { createEnvelope } from "@the-metafactory/myelin";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import type { EnvelopePublishInput } from "@the-metafactory/myelin";
import type { ReflexConfig } from "../src/config/schema";

export function testConfig(overrides: Partial<ReflexConfig> = {}): ReflexConfig {
  return {
    principal: "jc",
    stack: "default",
    nats: { url: "nats://127.0.0.1:4222", creds: "/tmp/nonexistent.creds" },
    publishQueueLimit: 1000,
    watchRoots: [],
    activationsDir: "/tmp/reflex-test-activations",
    sovereignty: {
      classification: "local",
      data_residency: "CH",
      max_hop: 0,
      frontier_ok: false,
      model_class: "any",
    },
    ...overrides,
  };
}

/** Materialize an EnvelopePublishInput into a full MyelinEnvelope the way EnvelopeTransport would. */
export function makeEnvelope(cfg: ReflexConfig, input: EnvelopePublishInput): MyelinEnvelope {
  return createEnvelope({
    source: input.source,
    type: input.type,
    payload: input.payload,
    correlation_id: input.correlation_id,
    extensions: input.extensions,
    sovereignty: { ...cfg.sovereignty, ...(input.sovereignty ?? {}) },
  });
}
