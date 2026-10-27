import { createEnvelope } from "@the-metafactory/myelin";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import type { EnvelopePublishInput } from "@the-metafactory/myelin";
import { createExecutionRunFinished } from "@the-metafactory/myelin/edge";
import type { RunOutcome } from "@the-metafactory/myelin/edge";
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

export interface RunFinishedOverrides {
  ref?: string;
  started_at?: string;
  ended_at?: string;
}

/** A valid execution.run.finished envelope for the default test config; the overrides vary the run's ref and timestamps. */
export function runFinishedEnvelope(
  correlationId: string,
  outcome: RunOutcome = "succeeded",
  producer = "cortex",
  overrides: RunFinishedOverrides = {},
): MyelinEnvelope {
  const cfg = testConfig();
  const finished = createExecutionRunFinished({
    source: `${cfg.principal}.${cfg.stack}.${producer}`,
    principal: cfg.principal,
    stack: cfg.stack,
    sovereignty: cfg.sovereignty,
    payload: {
      run_id: crypto.randomUUID(),
      producer,
      ran: { kind: "flow", ref: overrides.ref ?? "@jc/locked" },
      outcome,
      started_at: overrides.started_at ?? "2026-06-10T12:00:00.000Z",
      ended_at: overrides.ended_at ?? "2026-06-10T12:01:00.000Z",
      correlation_id: correlationId,
    },
  });
  return createEnvelope({ ...finished.input, sovereignty: cfg.sovereignty });
}
