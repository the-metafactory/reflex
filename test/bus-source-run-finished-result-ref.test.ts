import { describe, expect, it, spyOn } from "bun:test";
import { executionRunFinishedSubject, type MyelinEnvelope } from "@the-metafactory/myelin/edge";
import { busBp, cfg, rig, TASK_SUBJECT } from "./sources/bus-rig";
import { runFinishedEnvelope } from "./helpers";

const SUBJECT = executionRunFinishedSubject(cfg.principal, cfg.stack);

// Received wire data, deliberately independent of the pinned producer builder:
// an older Myelin must reach the consumer and expose its unknown-field rejection.
function currentEnvelope(correlationId: string): MyelinEnvelope {
  const envelope = runFinishedEnvelope(correlationId);
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      serves: { goal: "G0", node: "the-metafactory/reflex#49" },
      state: { subject: "watch", value: "on-track" },
      detail_ref: "cortex:run/run-49",
      result_ref: "soma:results/run-49.md",
      proposal_refs: ["soma:proposals/run-49-a.md", "soma:proposals/run-49-b.md"],
    },
  };
}

describe("bus source accepts current execution.run.finished wire", () => {
  for (const fields of ["result_ref", "proposal_refs", "both"] as const) {
    it(`${fields}: releases only the matching skip lock and lets the next impulse fire`, async () => {
      const r = await rig([
        busBp("locked", TASK_SUBJECT, undefined, { guards: { runLock: "skip" } }),
        busBp("other", TASK_SUBJECT, undefined, { guards: { runLock: "skip" } }),
      ]);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await r.publish(TASK_SUBJECT, { n: 0 });
        const first = r.repo.historyFor({ blueprintId: "locked" })[0]!;
        const other = r.repo.getGuardState("other");
        expect(first.outcome).toBe("fired");
        expect(r.repo.getGuardState("locked")?.runLockHolder).toBe(first.correlationId);
        expect(other?.runLockHolder).toBeTruthy();
        await r.publish(TASK_SUBJECT, { n: 1 });
        expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.guardBlockReason).toBe("run-lock");

        const finished = currentEnvelope(first.correlationId!);
        if (fields === "result_ref") delete finished.payload.proposal_refs;
        if (fields === "proposal_refs") delete finished.payload.result_ref;
        await r.publishEnvelope(SUBJECT, finished);

        expect(r.repo.getGuardState("locked")?.runLockHolder).toBeNull();
        expect(r.repo.getGuardState("other")).toEqual(other);
        expect(warn).not.toHaveBeenCalled();
        await r.publish(TASK_SUBJECT, { n: 2 });
        const next = r.repo.historyFor({ blueprintId: "locked" })[0]!;
        expect(next.outcome).toBe("fired");
        expect(next.correlationId).not.toBe(first.correlationId);
      } finally {
        warn.mockRestore();
        await r.close();
      }
    });
  }

  it("releases a buffer lock and re-presents the buffered impulse exactly once", async () => {
    const r = await rig([busBp("locked", TASK_SUBJECT, undefined, { guards: { runLock: "buffer" } })]);
    try {
      await r.publish(TASK_SUBJECT, { n: 0 });
      const first = r.repo.historyFor({ blueprintId: "locked" })[0]!;
      await r.publish(TASK_SUBJECT, { n: 1 });
      expect(r.repo.historyFor({ blueprintId: "locked" })[0]!.guardBlockReason).toBe("run-lock-buffered");
      const finished = currentEnvelope(first.correlationId!);
      await r.publishEnvelope(SUBJECT, finished);
      const history = r.repo.historyFor({ blueprintId: "locked" });
      expect(history).toHaveLength(3);
      expect(history[0]!.outcome).toBe("fired");
      expect(history[0]!.impulse.payload).toEqual({ n: 1 });
      expect(r.repo.getGuardState("locked")?.runLockHolder).toBe(history[0]!.correlationId);
      expect(r.repo.getGuardState("locked")?.bufferedImpulse).toBeNull();
      await r.publishEnvelope(SUBJECT, finished);
      expect(r.repo.historyFor({ blueprintId: "locked" })).toEqual(history);
      expect(r.repo.getGuardState("locked")?.runLockHolder).toBe(history[0]!.correlationId);
    } finally {
      await r.close();
    }
  });

  const malformed: { label: string; field: string; mutate: (e: MyelinEnvelope) => void }[] = [
    { label: "missing run ID", field: "payload.run_id", mutate: (e) => { delete e.payload.run_id; } },
    { label: "wrong outcome type", field: "payload.outcome", mutate: (e) => { e.payload.outcome = 42; } },
    { label: "wrong result ref type", field: "payload.result_ref", mutate: (e) => { e.payload.result_ref = 42; } },
    { label: "wrong proposal refs type", field: "payload.proposal_refs", mutate: (e) => { e.payload.proposal_refs = "soma:proposals/run-49.md"; } },
    { label: "wrong proposal ref entry type", field: "payload.proposal_refs[0]", mutate: (e) => { e.payload.proposal_refs = [42]; } },
    { label: "unknown field", field: "payload.unrecognized", mutate: (e) => { e.payload.unrecognized = true; } },
  ];
  for (const { label, field, mutate } of malformed) {
    it(`rejects and logs ${label} without releasing the lock`, async () => {
      const r = await rig([busBp("locked", TASK_SUBJECT, undefined, { guards: { runLock: "skip" } })]);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await r.publish(TASK_SUBJECT, { n: 0 });
        const first = r.repo.historyFor({ blueprintId: "locked" })[0]!;
        const before = r.repo.getGuardState("locked");
        const history = r.repo.historyFor({ blueprintId: "locked" });
        const invalid = currentEnvelope(first.correlationId!);
        mutate(invalid);
        await r.publishEnvelope(SUBJECT, invalid);

        expect(r.repo.getGuardState("locked")).toEqual(before);
        expect(r.repo.historyFor({ blueprintId: "locked" })).toEqual(history);
        expect(warn).toHaveBeenCalledTimes(1);
        const warning = String(warn.mock.calls[0]![0]);
        expect(warning).toContain("[reflex-bus-source] invalid execution.run.finished envelope");
        expect(warning).toContain(invalid.id);
        expect(warning).toContain(field);
        expect(r.bus.metrics().handlerErrors).toBe(0);

        await r.publishEnvelope(SUBJECT, currentEnvelope(first.correlationId!));
        expect(r.repo.getGuardState("locked")?.runLockHolder).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        await r.close();
      }
    });
  }
});
