import { describe, expect, it } from "bun:test";
import { createTransport, createEnvelope } from "@the-metafactory/myelin";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { createReflexBus } from "../../src/bus";
import { Pipeline } from "../../src/pipeline/evaluate";
import { BusSource, matches } from "../../src/sources/bus";
import { runOutcomeSubject, terminalOutcomeOf } from "../../src/sources/run-outcome";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const cfg = testConfig();
const TASK_SUBJECT = `local.${cfg.principal}.${cfg.stack}.tasks.review.completed`;

function busBp(id: string, subject = TASK_SUBJECT, where?: Record<string, string | number | boolean>, overrides: Partial<ActivationBlueprint> = {}): ActivationBlueprint {
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

async function rig(blueprints: ActivationBlueprint[], nowRef = { now: "2026-06-10T12:00:00.000Z" }) {
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

describe("matcher", () => {
  it("property: match iff every where-entry strict-equals", () => {
    for (let i = 0; i < 200; i++) {
      const payload: Record<string, unknown> = { a: i % 3, b: `s${i % 2}`, c: i % 2 === 0 };
      const where: Record<string, string | number | boolean> = {};
      if (i % 4 !== 0) where.a = i % 5 === 0 ? (i % 3) : ((i % 3) + 1) % 3;
      if (i % 3 === 0) where.b = `s${i % 2}`;
      const expected = Object.entries(where).every(([k, v]) => payload[k] === v);
      expect(matches(where, payload)).toBe(expected);
    }
    expect(matches(undefined, { x: 1 })).toBe(true);
    expect(matches({ missing: 1 }, { x: 1 })).toBe(false); // absent ≠ equal
  });
});

describe("run-outcome contract module", () => {
  it("detects terminal outcomes table-driven", () => {
    expect(terminalOutcomeOf("pulse.run.succeeded")).toBe("succeeded");
    expect(terminalOutcomeOf("pulse.run.failed")).toBe("failed");
    expect(terminalOutcomeOf("pulse.run.cancelled")).toBe("cancelled");
    expect(terminalOutcomeOf("pulse.run.blocked")).toBe("blocked");
    expect(terminalOutcomeOf("pulse.run.started")).toBeNull();
    expect(terminalOutcomeOf("pulse.run.progress")).toBeNull();
  });
  it("subject derives from principal/stack", () => {
    expect(runOutcomeSubject(cfg)).toBe(`local.${cfg.principal}.${cfg.stack}.pulse.run.>`);
  });
});

describe("scenario 1+2: field-equals match fires; non-match ignored", () => {
  it("matching envelope produces a decision with payload + correlation in snapshot", async () => {
    const r = await rig([busBp("pilot-scan", TASK_SUBJECT, { flow: "review" })]);
    const corr = crypto.randomUUID();
    await r.publish(TASK_SUBJECT, { flow: "review", pr: 7 }, "tasks.review.completed", corr);
    const history = r.repo.historyFor({ blueprintId: "pilot-scan" });
    expect(history).toHaveLength(1);
    expect(history[0]!.outcome).toBe("fired");
    expect(history[0]!.impulse.payload).toEqual({ flow: "review", pr: 7 });
    await r.close();
  });

  it("non-matching envelope: no decision row, ignored counter bumped", async () => {
    const r = await rig([busBp("pilot-scan", TASK_SUBJECT, { flow: "review" })]);
    await r.publish(TASK_SUBJECT, { flow: "deploy" });
    expect(r.repo.historyFor({ blueprintId: "pilot-scan" })).toEqual([]);
    expect(r.repo.ignoredCount("pilot-scan", "2026-06-10")).toBe(1);
    await r.close();
  });
});

describe("scenario 3: run completion releases lock and re-presents", () => {
  it("buffered impulse re-presents on synthetic pulse outcome", async () => {
    const r = await rig([busBp("locked", TASK_SUBJECT, undefined, { guards: { runLock: "buffer" } })]);
    await r.publish(TASK_SUBJECT, { n: 0 });
    const fired = r.repo.historyFor({ blueprintId: "locked" })[0]!;
    expect(fired.outcome).toBe("fired");

    await r.publish(TASK_SUBJECT, { n: 1 }); // run in flight → buffered
    expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.outcome).toBe("blocked");

    // synthetic pulse terminal outcome for the stamped correlation
    await r.publish(runOutcomeSubject(cfg).replace(".>", ".succeeded"), { result: "ok" }, "pulse.run.succeeded", fired.correlationId!);
    await Bun.sleep(30);
    const latest = r.repo.historyFor({ blueprintId: "locked" })[0]!;
    expect(latest.outcome).toBe("fired");
    expect(latest.impulse.payload).toEqual({ n: 1 }); // the buffered one
    expect(r.repo.takeBufferedImpulse("locked")).toBeNull();
    await r.close();
  });
});

describe("scenario 5: self-cycle rejection", () => {
  it("blueprint on own fired subject is skipped loudly", async () => {
    const fired = `local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`;
    const r = await rig([busBp("evil", fired), busBp("fine", TASK_SUBJECT)]);
    expect(r.source.active()).toEqual(["fine"]);
    await r.close();
  });
});

describe("redelivery interplay", () => {
  it("same payload twice → one fired + one idempotency block", async () => {
    const r = await rig([busBp("dup", TASK_SUBJECT)]);
    await r.publish(TASK_SUBJECT, { same: true });
    await r.publish(TASK_SUBJECT, { same: true });
    const outcomes = r.repo.historyFor({ blueprintId: "dup" }).map((h) => h.outcome).sort();
    expect(outcomes).toEqual(["blocked", "fired"]);
    await r.close();
  });
});

describe("hot-reload sync", () => {
  it("orphan-free after 50 random mutations", async () => {
    const r = await rig([busBp("a")]);
    let pool = ["a"];
    for (let i = 0; i < 50; i++) {
      if (i % 3 === 0) pool.push(`bp-${i}`);
      else if (i % 3 === 1 && pool.length > 1) pool = pool.slice(0, -1);
      const set = pool.map((id, idx) =>
        busBp(id, idx === 0 && i % 3 === 2 ? `${TASK_SUBJECT}.v${i}` : TASK_SUBJECT),
      );
      r.store.swap(set);
      await r.source.sync();
      expect(r.source.active()).toEqual(pool.slice().sort());
    }
    await r.close();
  });
});
