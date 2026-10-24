import { createEnvelope } from "@the-metafactory/myelin";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import type { EnvelopePublishInput } from "@the-metafactory/myelin";
import type { ReflexStreamManager } from "../src/bus/stream";
import type { ReflexConfig } from "../src/config/schema";
import type { ActivationBlueprint } from "../src/activation/types";

/** Shared schedule-kind blueprint fixture for scheduler/heartbeat tests. */
export function scheduleBlueprint(id: string, schedule = "* * * * *", timezone?: string): ActivationBlueprint {
  return {
    id,
    target: `@jc/${id}`,
    kind: "schedule",
    when: { schedule, ...(timezone ? { timezone } : {}) },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: {},
    sourceFile: "/tmp/x.yaml",
  };
}

export function testConfig(overrides: Partial<ReflexConfig> = {}): ReflexConfig {
  return {
    principal: "jc",
    stack: "default",
    nats: { url: "nats://127.0.0.1:4222", creds: "/tmp/nonexistent.creds", insecure: false },
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

/** Narrow manager fixture shared by stream and daemon startup tests. */
export function fakeTransport(
  info: ReflexStreamManager["streams"]["info"],
  add: ReflexStreamManager["streams"]["add"],
) {
  return { getStreamManager: async () => ({ streams: { info, add } }) };
}
