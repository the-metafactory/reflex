import { describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import type { MyelinEnvelope } from "@the-metafactory/myelin/edge";
import { parseActivationDocument } from "../../src/activation/schema";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { createReflexBus } from "../../src/bus";
import { buildActivationFired } from "../../src/bus/envelopes";
import { Pipeline } from "../../src/pipeline/evaluate";
import type { Impulse } from "../../src/pipeline/impulse";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const SOURCE = "/tmp/serves/reflex.yaml";
const SERVES = { goal: "G1", node: "the-metafactory/soma#781" };
const cfg = testConfig();
const FIRED_SUBJECT = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;
const NOW = "2026-10-13T09:00:00.000Z";

function document(serves?: unknown, extra = ""): string {
  return `schema: metafactory/activation/v1
activations:
  - id: serves-test
    target: "@jc/serves-test"
    when: { manual: true }
    payload: { mode: daily }
${serves === undefined ? "" : `    serves: ${JSON.stringify(serves)}\n`}${extra}`;
}

function parse(serves?: unknown, extra = ""): ActivationBlueprint {
  return parseActivationDocument(document(serves, extra), SOURCE)[0]!;
}

function expectInvalid(serves: unknown, path: string, message?: string): void {
  let error: unknown;
  try {
    parse(serves);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(SOURCE);
  expect((error as Error).message).toContain(path);
  if (message) expect((error as Error).message).toContain(message);
}

describe("serves parsing", () => {
  for (const serves of [SERVES, { goal: SERVES.goal }, { node: SERVES.node }]) {
    it(`preserves ${Object.keys(serves).join(" and ")} only`, () => {
      expect(parse(serves).serves).toEqual(serves);
    });
  }

  it("omits the serves key when not declared", () => {
    expect(Object.hasOwn(parse(), "serves")).toBe(false);
  });

  it("rejects an empty serves object with its source and object path", () => {
    expectInvalid({}, "activations.0.serves", "at least one of goal or node is required");
  });

  it("rejects unknown serves keys", () => {
    expectInvalid({ goal: "G1", owner: "jc" }, "activations.0.serves", "owner");
  });

  for (const field of ["goal", "node"] as const) {
    it(`accepts a 200-character ${field} ID`, () => {
      const serves = { [field]: "x".repeat(200) };
      expect(parse(serves).serves).toEqual(serves);
    });

    it(`rejects empty, oversized, whitespace-containing and non-string ${field} IDs`, () => {
      for (const value of ["", "x".repeat(201), " G1", "G1 ", "G 1", "G\t1", "G\n1", "G\r1", "G\u00a01", "G\u20281", null, 1, true]) {
        expectInvalid({ ...SERVES, [field]: value }, `activations.0.serves.${field}`);
      }
    });

    it(`rejects every C0, DEL and C1 control character in ${field}`, () => {
      for (let code = 0; code <= 0x9f; code++) {
        if (code > 0x1f && code < 0x7f) continue;
        expectInvalid({ ...SERVES, [field]: `G${String.fromCharCode(code)}1` }, `activations.0.serves.${field}`);
      }
    });
  }

  it("rejects non-object serves values", () => {
    for (const value of [null, "G1", [SERVES]]) {
      expectInvalid(value, "activations.0.serves");
    }
  });
});

async function rig(blueprint: ActivationBlueprint) {
  const { db, close } = openDb(":memory:");
  const repo = new Repository(db);
  const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
  const pipeline = new Pipeline({ store: new BlueprintStore([blueprint]), repo, bus, nowFn: () => NOW });
  const fired: MyelinEnvelope[] = [];
  await bus.subscribe(FIRED_SUBJECT, async (envelope) => {
    fired.push(envelope);
  });
  return {
    pipeline,
    fired,
    close: async () => {
      await bus.close();
      close();
    },
  };
}

function impulse(n = 0): Impulse {
  return {
    kind: "manual",
    blueprintId: "serves-test",
    payload: { n },
    receivedAt: NOW,
    actor: { type: "operator", id: "jc" },
  };
}

function expectFired(envelope: MyelinEnvelope, serves: ActivationBlueprint["serves"], n: number): void {
  expect(envelope.type).toBe("reflex.activation.fired");
  expect(envelope.payload.target).toBe("@jc/serves-test");
  expect(envelope.payload.payload).toEqual({ mode: "daily", n });
  expect(Object.hasOwn(envelope.payload.payload as object, "serves")).toBe(false);
  if (serves === undefined) {
    expect(Object.hasOwn(envelope.payload, "serves")).toBe(false);
    expect(JSON.stringify(envelope.payload)).toBe(JSON.stringify({
      target: "@jc/serves-test",
      payload: { mode: "daily", n },
      idempotency_key: envelope.payload.idempotency_key,
      decision_id: envelope.payload.decision_id,
    }));
  } else {
    expect(envelope.payload.serves).toEqual(serves);
  }
}

describe("serves on published fired envelopes", () => {
  for (const serves of [SERVES, { goal: SERVES.goal }, { node: SERVES.node }, undefined]) {
    const label = serves === undefined ? "absent serves" : Object.keys(serves).join(" and ");

    it(`auto policy carries ${label}`, async () => {
      const r = await rig(parse(serves));
      try {
        expect((await r.pipeline.evaluate(impulse())).outcome).toBe("fired");
        expect(r.fired).toHaveLength(1);
        expectFired(r.fired[0]!, serves, 0);
      } finally {
        await r.close();
      }
    });

    it(`resolveMatched carries ${label}`, async () => {
      const r = await rig(parse(serves, "    policy: approval\n"));
      try {
        const matched = await r.pipeline.evaluate(impulse());
        expect(matched.outcome).toBe("matched");
        if (matched.outcome !== "matched") throw new Error("Expected Matched Decision");
        expect(r.fired).toHaveLength(0);
        const result = await r.pipeline.resolveMatched(matched.decisionId, "approve", { type: "operator", id: "jc" });
        expect(result.outcome).toBe("fired");
        expect(r.fired).toHaveLength(1);
        expectFired(r.fired[0]!, serves, 0);
      } finally {
        await r.close();
      }
    });

    it(`onRunCompleted re-presents the Buffered Impulse with ${label}`, async () => {
      const r = await rig(parse(serves, "    guards: { run_lock: buffer }\n"));
      try {
        const first = await r.pipeline.evaluate(impulse());
        expect(first.outcome).toBe("fired");
        if (first.outcome !== "fired") throw new Error("Expected Fired Decision");
        expectFired(r.fired[0]!, serves, 0);
        const blocked = await r.pipeline.evaluate(impulse(1));
        expect(blocked.outcome).toBe("blocked");
        if (blocked.outcome !== "blocked") throw new Error("Expected Blocked Decision");
        expect(blocked.reason).toBe("run-lock-buffered");
        expect(r.fired).toHaveLength(1);
        expect((await r.pipeline.onRunCompleted(first.correlationId, "succeeded"))?.outcome).toBe("fired");
        expect(r.fired).toHaveLength(2);
        expectFired(r.fired[1]!, serves, 1);
        expect(r.fired[1]!.extensions?.causation_id).toBe(blocked.decisionId);
        expect(await r.pipeline.onRunCompleted(first.correlationId, "succeeded")).toBeNull();
        expect(r.fired).toHaveLength(2);
      } finally {
        await r.close();
      }
    });
  }

  it("retains the legacy fired payload bytes without serves", () => {
    const input = buildActivationFired(cfg, {
      target: "@jc/serves-test",
      payload: { mode: "daily" },
      idempotencyKey: "k1",
      decisionId: "d1",
      correlationId: "00000000-0000-4000-8000-000000000001",
      actor: { type: "system", id: "reflex-test" },
    });
    expect(Object.hasOwn(input.payload, "serves")).toBe(false);
    expect(JSON.stringify(input.payload)).toBe('{"target":"@jc/serves-test","payload":{"mode":"daily"},"idempotency_key":"k1","decision_id":"d1"}');
  });
});
