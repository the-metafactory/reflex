import { describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus } from "../../src/bus";
import { Pipeline } from "../../src/pipeline/evaluate";
import { parseActivationDocument } from "../../src/activation/schema";
import { BlueprintStore } from "../../src/activation/store";
import { routineHistory } from "../../src/activation/history";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const scope = { principal: "test", stack: "default" };
const actor = { type: "operator" as const, id: "test" };
const at = "2026-11-01T00:00:00.000Z";
const document = `schema: metafactory/activation/v1
activations:
  - id: fixture
    name: Historical routine
    target: '@test/pulse-flow'
    when: {schedule: '0 9 * * *', timezone: UTC}
    policy: approval
`;

describe("routine owner history", () => {
  it("keeps exact pipeline decision and dispatch IDs, approval states and historical name after removal", async () => {
    const { db, close } = openDb(":memory:");
    const repo = new Repository(db);
    const store = new BlueprintStore(parseActivationDocument(document, "/tmp/test.yaml"));
    const bus = createReflexBus(testConfig(), { transport: createTransport({ type: "memory" }) });
    const pipeline = new Pipeline({ store, repo, bus, nowFn: () => at });
    try {
      const matched = await pipeline.evaluate({ kind: "schedule", blueprintId: "fixture", receivedAt: at, payload: { secret: "must-not-leak" }, actor });
      if (matched.outcome !== "matched") throw new Error("Expected approval");
      const pending = routineHistory(repo, scope, store, { ...scope });
      expect(pending.records[0]).toMatchObject({ decision: "matched", correlationId: null, approval: { state: "waiting" }, routineName: "Historical routine" });
      const fired = await pipeline.resolveMatched(matched.decisionId, "approve", actor);
      if (fired.outcome !== "fired") throw new Error("Expected dispatch");
      store.swap([]);
      const records = routineHistory(repo, scope, store, { ...scope, routineId: "fixture" }).records;
      expect(records.find((r) => r.decisionId === fired.decisionId)).toMatchObject({ routineName: "Historical routine", nameSource: "recorded", definitionPresent: false, correlationId: fired.correlationId, resolutionOf: matched.decisionId, target: "@test/pulse-flow" });
      expect(JSON.stringify(records)).not.toContain("must-not-leak");
      expect(routineHistory(repo, scope, store, { ...scope, decisionId: fired.decisionId }).records).toHaveLength(1);
    } finally { await bus.close(); close(); }
  });

  it("paginates same-millisecond IDs without duplicates and rejects foreign or malformed cursors", () => {
    const { db, close } = openDb(":memory:");
    const repo = new Repository(db);
    const store = new BlueprintStore([]);
    try {
      for (let i = 0; i < 7; i++) repo.recordDecision({ blueprintId: "fixture", outcome: "denied", impulse: { kind: "schedule", payload: {}, receivedAt: at } });
      repo.recordDecision({ blueprintId: "other", outcome: "fired", impulse: { kind: "manual", payload: {}, receivedAt: at } });
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = routineHistory(repo, scope, store, { ...scope, limit: 2, ...(cursor ? { cursor } : {}) });
        for (const row of page.records) { expect(seen.has(row.decisionId)).toBe(false); seen.add(row.decisionId); }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen.size).toBe(7);
      const first = routineHistory(repo, scope, store, { ...scope, limit: 2 });
      for (const args of [{ ...scope, principal: "foreign" }, { ...scope, stack: "foreign" }, { ...scope, limit: 101 }, { ...scope, cursor: "bad" }, { ...scope, routineId: "other", cursor: first.nextCursor }]) expect(() => routineHistory(repo, scope, store, args)).toThrow();
    } finally { close(); }
  });
});
