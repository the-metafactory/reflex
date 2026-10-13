import { createTransport, createEnvelope } from "@the-metafactory/myelin";
import { createExecutionRunFinished } from "@the-metafactory/myelin/edge";
import type { MyelinEnvelope, RunOutcome } from "@the-metafactory/myelin/edge";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { createReflexBus } from "../../src/bus";
import { Pipeline } from "../../src/pipeline/evaluate";
import { BusSource } from "../../src/sources/bus";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

export const cfg = testConfig();
export const TASK_SUBJECT = `local.${cfg.principal}.${cfg.stack}.tasks.review.completed`;

export function busBp(id: string, subject = TASK_SUBJECT, where?: Record<string, string | number | boolean>, overrides: Partial<ActivationBlueprint> = {}): ActivationBlueprint {
  return {
    id,
    target: `@jc/${id}`,
    kind: "bus",
    when: { bus: { subject, ...(where ? { where } : {}) } },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: {},
    sourceFile: "/tmp/x.yaml",
    ...overrides,
  };
}

export async function rig(blueprints: ActivationBlueprint[], nowRef = { now: "2026-06-10T12:00:00.000Z" }) {
  const { db, close } = openDb(":memory:");
  const repo = new Repository(db);
  const store = new BlueprintStore(blueprints);
  const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
  const pipeline = new Pipeline({ store, repo, bus, nowFn: () => nowRef.now });
  const source = new BusSource(cfg, store, bus, pipeline, repo);
  await source.start();
  return {
    repo,
    store,
    bus,
    source,
    nowRef,
    publishEnvelope: async (subject: string, envelope: MyelinEnvelope) => {
      await bus.raw.publish(subject, envelope);
      await Bun.sleep(20);
    },
    publish: async (subject: string, payload: Record<string, unknown>, type = "tasks.review.completed", correlationId?: string) => {
      const envelope = createEnvelope({
        source: `${cfg.principal}.tasks.review`,
        type,
        payload,
        correlation_id: correlationId,
        sovereignty: cfg.sovereignty,
      });
      await bus.raw.publish(subject, envelope);
      await Bun.sleep(20);
    },
    close: async () => {
      await source.stop();
      await bus.close();
      close();
    },
  };
}

export function runFinishedEnvelope(correlationId: string, outcome: RunOutcome = "succeeded", producer = "cortex") {
  const event = createExecutionRunFinished({
    source: `${cfg.principal}.${cfg.stack}.${producer}`,
    principal: cfg.principal,
    stack: cfg.stack,
    sovereignty: cfg.sovereignty,
    payload: {
      run_id: crypto.randomUUID(),
      producer,
      ran: { kind: "flow", ref: "@jc/locked" },
      outcome,
      started_at: "2026-06-10T12:00:00.000Z",
      ended_at: "2026-06-10T12:01:00.000Z",
      correlation_id: correlationId,
    },
  });
  return createEnvelope({ ...event.input, sovereignty: cfg.sovereignty });
}
