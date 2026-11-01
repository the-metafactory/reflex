import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { RoutineCommands } from "../../src/activation/routines";
import { changedScheduleText, scheduleProjection, storedSchedule } from "../../src/activation/routine-schedule";
import type { RoutineFlowContract } from "../../src/activation/routine-contract";

const actor = { type: "operator", id: "test" } as const;
const detail = z.object({ id: z.string(), revision: z.string(), writable: z.boolean(), current: z.object({ schedule: z.string(), timezone: z.string().nullable(), effectiveTimezone: z.string(), occurrences: z.array(z.string()) }) });
const preview = z.object({ revision: z.string(), proposedRevision: z.string() });
const flow = "name: F_TEST\nactions:\n  - retry:\n      attempts: 2\n      actions: [A_NOOP]\n";

async function fixture(withFlow = true) {
  const dir = await mkdtemp(join(tmpdir(), "reflex-schedule-"));
  const central = join(dir, "central"); const owned = join(dir, "routines");
  await mkdir(central); await mkdir(owned);
  let evaluated = 0;
  let hold: (() => Promise<void>) | undefined;
  const flowContract: RoutineFlowContract = async (text, patches) => {
    if (patches.length) await hold?.();
    const doc = parseDocument(text); for (const patch of patches) doc.setIn(patch.path, patch.value);
    return { view: { name: "F_TEST", steps: [] }, ...(patches.length ? { yaml: doc.toString() } : {}) };
  };
  const deps = { dir: owned, sources: { activationsDir: central, routinesDir: owned, watchRoots: [] }, knownTargets: async () => ["@test/noop"], lastDecision: () => null, flowContract,
    dryRun: async (): Promise<{ wouldOutcome: "matched"; reasons: string[] }> => { evaluated++; return { wouldOutcome: "matched", reasons: [] }; } };
  const commands = new RoutineCommands(deps);
  expect((await commands.execute("routine-add", { id: "schedule-test", schedule: "0 0 1 1 *", timezone: "UTC", target: "@test/noop", payload: { note: "keep" }, ...(withFlow ? { flow } : {}) }, actor)).ok).toBe(true);
  const file = join(owned, "schedule-test.yaml"); const flowFile = join(owned, "flows", "schedule-test.yaml");
  const inspect = async () => { const reply = await commands.execute("routine-schedule-inspect", { id: "schedule-test" }, actor); if (!reply.ok) throw new Error(reply.error.message); return detail.parse(reply.data); };
  return { dir, owned, commands, file, flowFile, inspect, fork: () => new RoutineCommands(deps), evaluated: () => evaluated, hold: (callback: () => Promise<void>) => { hold = callback; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("owner schedule preview and update", () => {
  it("patches only nominated scalar spans, preserving comments quoted payload and nondecimal values", () => {
    const text = "# reflex-generated-routine: v1\nschema: metafactory/activation/v1\nactivations:\n  - id: sample\n    when:\n      schedule: '0 8 * * *' # clock\n      timezone: UTC\n    payload: {hex: 0x10, note: 'keep  spaces'}\n";
    const next = changedScheduleText(text, { schedule: "0 9 * * *", timezone: "Europe/Zurich" });
    expect(next).toBe(text.replace("'0 8 * * *'", '"0 9 * * *"').replace("timezone: UTC", 'timezone: "Europe/Zurich"'));
    expect(changedScheduleText(text, storedSchedule(text))).toBe(text);
    const without = changedScheduleText(text, { schedule: "0 8 * * *", timezone: null });
    expect(without).toBe(text.replace("      timezone: UTC\n", ""));
    expect(storedSchedule(changedScheduleText(without, { schedule: "0 8 * * *", timezone: "UTC" })).timezone).toBe("UTC");
    const inline = "activations: [{id: sample, when: {timezone: UTC, schedule: '*/7 * * * * *'}}]\n";
    expect(storedSchedule(changedScheduleText(inline, { schedule: "*/7 * * * * *", timezone: null }))).toEqual({ schedule: "*/7 * * * * *", timezone: null });
  });

  it("uses the real clock parser for next-three preview, and preserves one-off and owner-local values", () => {
    expect(scheduleProjection({ schedule: "0 8 * * *", timezone: "UTC" }, Date.parse("2026-01-01T09:00:00Z")).occurrences).toEqual(["2026-01-02T08:00:00.000Z", "2026-01-03T08:00:00.000Z", "2026-01-04T08:00:00.000Z"]);
    const one = scheduleProjection({ schedule: "2030-01-01T08:00:00", timezone: null }, Date.parse("2026-01-01T00:00:00Z"));
    expect(one.schedule).toBe("2030-01-01T08:00:00"); expect(one.timezone).toBeNull(); expect(one.occurrences).toHaveLength(1);
    expect(() => scheduleProjection({ schedule: "invalid", timezone: "UTC" }, Date.now())).toThrow("schedule:");
    expect(() => scheduleProjection({ schedule: "0 8 * * *", timezone: "Invalid/Zone" }, Date.now())).toThrow("timezone:");
  });

  it("previews without writes or evaluation then CAS-updates only the schedule and leaves the flow and policy intact", async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.file, "utf8"); const flowBefore = await readFile(f.flowFile, "utf8"); const files = await readdir(f.owned);
      const current = await f.inspect(); const input = { id: current.id, revision: current.revision, schedule: "*/7 * * * * *", timezone: "Europe/Zurich" };
      const response = await f.commands.execute("routine-schedule-preview", input, actor);
      expect(response.ok).toBe(true); if (!response.ok) throw new Error(response.error.message);
      const planned = preview.parse(response.data);
      expect(await readFile(f.file, "utf8")).toBe(before); expect(await readdir(f.owned)).toEqual(files); expect(f.evaluated()).toBe(1);
      const changed = await f.commands.execute("routine-schedule-update", { ...input, proposedRevision: planned.proposedRevision }, actor);
      expect(changed.ok).toBe(true); if (!changed.ok) throw new Error(changed.error.message);
      expect(detail.parse(changed.data)).toMatchObject({ revision: planned.proposedRevision, current: { schedule: input.schedule, timezone: input.timezone } });
      expect(await readFile(f.flowFile, "utf8")).toBe(flowBefore); expect(await readFile(f.file, "utf8")).toContain("policy: approval"); expect(f.evaluated()).toBe(1);
      expect((await f.commands.execute("routine-update", { id: current.id, revision: current.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }, actor)).ok).toBe(false);
      expect((await f.commands.execute("routine-schedule-update", { ...input, proposedRevision: planned.proposedRevision }, actor)).ok).toBe(false);
    } finally { await f.cleanup(); }
  });

  it("edits owned definitions without a flow and retains a missing stored timezone on a custom expression", async () => {
    const f = await fixture(false);
    try {
      const original = (await readFile(f.file, "utf8")).replace(/^ +timezone: UTC\n/m, ""); await writeFile(f.file, original);
      const current = await f.inspect(); expect(current.writable).toBe(true); expect(current.current.timezone).toBeNull();
      const input = { id: current.id, revision: current.revision, schedule: "2030-01-01T08:00:00", timezone: null };
      const response = await f.commands.execute("routine-schedule-preview", input, actor); if (!response.ok) throw new Error(response.error.message);
      expect((await f.commands.execute("routine-schedule-update", { ...input, proposedRevision: preview.parse(response.data).proposedRevision }, actor)).ok).toBe(true);
      expect(await readFile(f.file, "utf8")).not.toContain("timezone:"); expect((await f.inspect()).current.schedule).toBe(input.schedule);
    } finally { await f.cleanup(); }
  });

  it("refuses aliases external ownership and a tampered preview without modifying the source", async () => {
    const f = await fixture();
    try {
      const original = await readFile(f.file, "utf8"); const current = await f.inspect();
      const input = { id: current.id, revision: current.revision, schedule: "0 8 * * *", timezone: "UTC", proposedRevision: "a".repeat(64) };
      expect((await f.commands.execute("routine-schedule-update", input, actor)).ok).toBe(false); expect(await readFile(f.file, "utf8")).toBe(original);
      await writeFile(f.file, original.replace("# reflex-generated-routine: v1\n", "")); expect((await f.inspect()).writable).toBe(false);
      const alias = original.replace("schedule: 0 0 1 1 *", "schedule: &clock 0 0 1 1 *").replace("note: keep", "note: *clock");
      await writeFile(f.file, alias); expect((await f.inspect()).writable).toBe(false);
      expect(await readFile(f.file, "utf8")).toBe(alias);
    } finally { await f.cleanup(); }
  });

  it("shares the filesystem lock with parameter writers across command instances", async () => {
    const f = await fixture(); let entered = () => {}; let release = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    let writing: ReturnType<RoutineCommands["execute"]> | undefined;
    try {
      const current = await f.inspect(); const input = { id: current.id, revision: current.revision, schedule: "0 8 * * *", timezone: "UTC" };
      const response = await f.commands.execute("routine-schedule-preview", input, actor); if (!response.ok) throw new Error(response.error.message);
      f.hold(async () => { entered(); await gate; });
      writing = f.commands.execute("routine-update", { id: current.id, revision: current.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }, actor);
      await ready;
      const other = f.fork(); const refused = await other.execute("routine-schedule-update", { ...input, proposedRevision: preview.parse(response.data).proposedRevision }, actor);
      expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("Another routine writer") } });
      release(); expect((await writing).ok).toBe(true);
      expect((await other.execute("routine-schedule-preview", input, actor)).ok).toBe(false);
    } finally { release(); await writing; await f.cleanup(); }
  });
});
