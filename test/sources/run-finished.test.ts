import { describe, expect, it, spyOn } from "bun:test";
import { executionRunFinishedSubject, type MyelinEnvelope } from "@the-metafactory/myelin/edge";
import { readRunFinished, runOutcomeSubject } from "../../src/sources/run-outcome";
import { busBp, cfg, rig, TASK_SUBJECT } from "./bus-rig";
import { runFinishedEnvelope } from "../helpers";

const SUBJECT = executionRunFinishedSubject(cfg.principal, cfg.stack);
const OUTCOMES = ["succeeded", "failed", "cancelled", "blocked"] as const;

/** A rig with one locked blueprint: the first impulse fired and holds the lock, the second hit it. */
async function lockedRig(runLock: "buffer" | "skip") {
  const r = await rig([busBp("locked", TASK_SUBJECT, undefined, { guards: { runLock } })]);
  try {
    await r.publish(TASK_SUBJECT, { n: 0 });
    const first = r.repo.historyFor({ blueprintId: "locked" })[0]!;
    await r.publish(TASK_SUBJECT, { n: 1 });
    return {
      r,
      first,
      before: r.repo.getGuardState("locked"),
      history: r.repo.historyFor({ blueprintId: "locked" }),
    };
  } catch (error) {
    await r.close();
    throw error;
  }
}

describe("execution.run.finished contract", () => {
  it("derives the subject from the configured principal and stack", () => {
    expect(runOutcomeSubject({ principal: "ivy", stack: "work" })).toBe("local.ivy.work.execution.run.finished");
  });

  it("reads non-UUID correlations from the payload with no envelope correlation", () => {
    const envelope = runFinishedEnvelope("t1");
    expect(envelope.correlation_id).toBeUndefined();
    expect(readRunFinished(envelope)).toEqual({ valid: true, correlationId: "t1", outcome: "succeeded" });
  });

  for (const outcome of OUTCOMES) {
    it(`${outcome}: releases the buffer and re-presents exactly once`, async () => {
      const { r, first, history: blockedHistory } = await lockedRig("buffer");
      try {
        const blocked = blockedHistory[0]!;
        expect(blocked.outcome).toBe("blocked");
        expect(blocked.guardBlockReason).toBe("run-lock-buffered");
        expect(r.repo.getGuardState("locked")?.bufferedImpulse).toBeTruthy();

        const finished = runFinishedEnvelope(first.correlationId!, outcome);
        // Payload correlation is authoritative even when the UUID envelope join is omitted.
        delete finished.correlation_id;
        await r.publishEnvelope(SUBJECT, finished);
        const history = r.repo.historyFor({ blueprintId: "locked" });
        expect(history).toHaveLength(3);
        const represented = history[0]!;
        expect(represented.outcome).toBe("fired");
        expect(represented.impulse.payload).toEqual({ n: 1 });
        expect(represented.correlationId).not.toBe(first.correlationId);
        expect(r.repo.getGuardState("locked")?.runLockHolder).toBe(represented.correlationId);
        expect(r.repo.getGuardState("locked")?.bufferedImpulse).toBeNull();
        await r.publishEnvelope(SUBJECT, finished);
        expect(r.repo.historyFor({ blueprintId: "locked" })).toEqual(history);
        expect(r.repo.getGuardState("locked")?.runLockHolder).toBe(represented.correlationId);
      } finally {
        await r.close();
      }
    });

    it(`${outcome}: releases a skip lock so the next impulse fires`, async () => {
      const { r, first } = await lockedRig("skip");
      try {
        expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.guardBlockReason).toBe("run-lock");
        await r.publishEnvelope(SUBJECT, runFinishedEnvelope(first.correlationId!, outcome));
        expect(r.repo.getGuardState("locked")?.runLockHolder).toBeNull();
        await r.publish(TASK_SUBJECT, { n: 2 });
        expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.outcome).toBe("fired");
      } finally {
        await r.close();
      }
    });
  }

  it("unrelated ranger, soma and cortex runs preserve locks and buffers without warning", async () => {
    const { r, before, history } = await lockedRig("buffer");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    try {
      for (const producer of ["ranger", "soma", "cortex"]) {
        await r.publishEnvelope(SUBJECT, runFinishedEnvelope("t1", "succeeded", producer));
        await r.publishEnvelope(SUBJECT, runFinishedEnvelope(crypto.randomUUID(), "succeeded", producer));
      }
      expect(r.repo.getGuardState("locked")).toEqual(before);
      expect(r.repo.historyFor({ blueprintId: "locked" })).toEqual(history);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
      await r.close();
    }
  });

  const malformed: { label: string; field: string; mutate: (envelope: MyelinEnvelope) => void }[] = [
    { label: "non-terminal outcome", field: "payload.outcome", mutate: (e) => { e.payload.outcome = "running"; } },
    { label: "mismatched envelope correlation", field: "correlation_id", mutate: (e) => { e.correlation_id = crypto.randomUUID(); } },
    { label: "empty payload correlation", field: "payload.correlation_id", mutate: (e) => { e.payload.correlation_id = ""; } },
    { label: "wrong envelope type", field: "type", mutate: (e) => { e.type = "execution.run.started"; } },
    { label: "missing duration", field: "economics.actual.duration_ms", mutate: (e) => { delete e.economics; } },
  ];
  for (const { label, field, mutate } of malformed) {
    it(`rejects ${label}, warns once and keeps consuming`, async () => {
      const { r, first, before, history } = await lockedRig("buffer");
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        const invalid = runFinishedEnvelope(first.correlationId!);
        mutate(invalid);
        const validation = readRunFinished(invalid);
        expect(validation.valid).toBe(false);
        if (validation.valid) throw new Error("expected rejection");
        expect(validation.errors.some((e) => e.field === field)).toBe(true);
        await r.publishEnvelope(SUBJECT, invalid);
        expect(r.repo.getGuardState("locked")).toEqual(before);
        expect(r.repo.historyFor({ blueprintId: "locked" })).toEqual(history);
        expect(warn).toHaveBeenCalledTimes(1);
        const warning = String(warn.mock.calls[0]![0]);
        expect(warning).toContain(invalid.id);
        expect(warning).toContain(field);
        for (const e of validation.errors) expect(warning).toContain(e.message);
        expect(error).not.toHaveBeenCalled();
        expect(r.bus.metrics().handlerErrors).toBe(0);
        await r.publishEnvelope(SUBJECT, runFinishedEnvelope(first.correlationId!));
        expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.outcome).toBe("fired");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        error.mockRestore();
        await r.close();
      }
    });
  }

  it("legacy pulse outcomes and other stacks cannot release the lock", async () => {
    const { r, first, before, history } = await lockedRig("buffer");
    try {
      await r.publish(`local.${cfg.principal}.${cfg.stack}.pulse.run.succeeded`, {}, "pulse.run.succeeded", first.correlationId!);
      await r.publishEnvelope(executionRunFinishedSubject(cfg.principal, "other"), runFinishedEnvelope(first.correlationId!));
      expect(r.repo.getGuardState("locked")).toEqual(before);
      expect(r.repo.historyFor({ blueprintId: "locked" })).toEqual(history);
    } finally {
      await r.close();
    }
  });
});
