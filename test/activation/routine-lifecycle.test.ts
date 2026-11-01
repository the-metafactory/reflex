import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "@the-metafactory/myelin";
import { z } from "zod";
import { createReflexBus } from "../../src/bus";
import { startDaemon } from "../../src/daemon";
import { runCommand } from "../../src/cli/main";
import { changedPausedText, storedPaused } from "../../src/activation/routine-schedule";
import { parseActivationDocument } from "../../src/activation/schema";
import { BlueprintStore } from "../../src/activation/store";
import { ScheduleSource } from "../../src/sources/schedule";
import type { EvaluateResult } from "../../src/pipeline/impulse";
import { testConfig, scheduleBlueprint } from "../helpers";

const actor = { type: "operator", id: "test" } as const;
const detailSchema = z.object({ id: z.string(), revision: z.string(), writable: z.boolean(), reason: z.string(), runtimeConfirmed: z.boolean(), current: z.object({ paused: z.boolean(), policy: z.string(), schedule: z.string(), timezone: z.string().nullable() }) });
const previewSchema = z.object({ proposedRevision: z.string() });
const deferred = () => { let resolve = () => {}; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean | Promise<boolean>, ms = 3000) { const deadline = Date.now() + ms; while (!await check()) { if (Date.now() >= deadline) throw new Error("Lifecycle condition timed out"); await Bun.sleep(10); } }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "reflex-lifecycle-")); await mkdir(join(dir, "activations"));
  const cfg = testConfig({ principal: "test", stack: "pause-test", activationsDir: join(dir, "activations"), routinesDir: join(dir, "routines") });
  const transport = createTransport({ type: "memory" });
  const shared = { publish: transport.publish.bind(transport), request: transport.request.bind(transport), subscribe: transport.subscribe.bind(transport), subscribeBestEffort: transport.subscribeBestEffort.bind(transport), close: async () => {} };
  const makeBus = () => createReflexBus(cfg, { transport: shared });
  const daemon = await startDaemon(cfg, { dbPath: join(dir, "test.db"), bus: makeBus(), routineTargetLookup: async () => ["@test/noop"] });
  const raw = (argv: string[]) => runCommand([...argv, "--json"], { cfg, makeBus });
  const run = async (argv: string[]) => { const result = await raw(argv); if (result.exitCode !== 0) throw new Error(result.stdout || result.stderr); return JSON.parse(result.stdout); };
  const add = async (id: string, policy = "approve") => { await run(["routine", "add", "--id", id, "--schedule", "0 0 1 1 *", "--timezone", "UTC", "--target", "@test/noop", "--policy", policy, "--payload", "{}"]); await until(() => Boolean(daemon.store.get(id))); };
  const inspect = async (id: string) => detailSchema.parse(await run(["routine", "lifecycle", "inspect", id]));
  const prepare = async (id: string, paused: boolean) => { const current = await inspect(id); const args = [id, "--revision", current.revision, "--paused", String(paused)]; const planned = previewSchema.parse(await run(["routine", "lifecycle", "preview", ...args])); return { current, args: [...args, "--proposed-revision", planned.proposedRevision], revision: planned.proposedRevision }; };
  const change = async (id: string, paused: boolean) => { const prepared = await prepare(id, paused); return detailSchema.parse(await run(["routine", "lifecycle", "update", ...prepared.args])); };
  return { dir, cfg, daemon, makeBus, add, inspect, prepare, change, run, raw, close: async () => { await daemon.stop(); await transport.close(); await rm(dir, { recursive: true, force: true }); } };
}

describe("canonical routine pause", () => {
  it("changes only paused metadata for block/inline YAML and retains the schedule-only semantic guard", () => {
    for (const text of ["schema: metafactory/activation/v1\nactivations:\n  - id: sample\n    target: '@test/noop'\n    when: {schedule: '0 8 * * *', timezone: UTC}\n    policy: approval\n    payload: {hex: 0x10, note: 'keep  spaces'}\n    # keep trailing comment\n", "activations: [{id: sample, when: {schedule: '0 8 * * *'}, policy: auto}]\n"]) {
      const paused = changedPausedText(text, true); expect(storedPaused(paused)).toBe(true);
      expect(storedPaused(changedPausedText(paused, false))).toBe(false);
      expect(paused).toContain("schedule: '0 8 * * *'"); expect(paused).toContain(text.includes("policy: auto") ? "policy: auto" : "policy: approval");
    }
    expect(() => changedPausedText("activations: [{id: sample, when: {schedule: &clock '0 8 * * *'}, payload: {value: *clock}}]", true)).toThrow("Shared YAML");
  });

  it("persists pause/resume with CAS while preserving handling policy and existing approval resolution", async () => {
    const f = await fixture();
    try {
      await f.add("approval"); const before = await readFile(join(f.cfg.routinesDir ?? "", "approval.yaml"), "utf8");
      const matched = await f.daemon.pipeline.evaluate({ kind: "schedule", blueprintId: "approval", payload: { scheduled_for: "2030-01-01T00:00:00Z" }, receivedAt: new Date().toISOString(), actor });
      expect(matched.outcome).toBe("matched"); if (matched.outcome !== "matched") throw new Error("Expected approval");
      const prepared = await f.prepare("approval", true); const paused = detailSchema.parse(await f.run(["routine", "lifecycle", "update", ...prepared.args]));
      expect(paused).toMatchObject({ revision: prepared.revision, current: { paused: true, policy: "approval", schedule: "0 0 1 1 *", timezone: "UTC" } });
      expect(f.daemon.store.get("approval")?.paused).toBe(true); expect(f.daemon.scheduleStatus().some((s) => s.blueprintId === "approval")).toBe(false);
      expect(await f.daemon.pipeline.evaluate({ kind: "schedule", blueprintId: "approval", payload: {}, receivedAt: new Date().toISOString(), actor })).toEqual({ outcome: "ignored", reason: "paused" });
      expect(f.daemon.repo.getApproval(matched.decisionId)?.state).toBe("waiting");
      expect((await f.daemon.pipeline.resolveMatched(matched.decisionId, "approve", actor)).outcome).toBe("fired");
      expect(f.daemon.store.get("approval")?.paused).toBe(true);
      await f.run(["routine", "set-policy", "approval", "auto"]); await until(() => f.daemon.store.get("approval")?.policy === "auto");
      expect((await f.inspect("approval")).current).toMatchObject({ paused: true, policy: "auto" });
      const stale = await f.raw(["routine", "lifecycle", "update", ...prepared.args]); expect(stale.exitCode).toBe(1);
      const resumed = await f.change("approval", false); expect(resumed.current).toMatchObject({ paused: false, policy: "auto", schedule: "0 0 1 1 *", timezone: "UTC" });
      const stored = await readFile(join(f.cfg.routinesDir ?? "", "approval.yaml"), "utf8");
      expect(parseActivationDocument(stored, "test")[0]).toMatchObject({ paused: false, policy: "auto", payload: {} });
      expect(before.replace("policy: approval", "policy: auto").trim()).toBe(stored.replace(/\n +paused: false/, "").trim());
    } finally { await f.close(); }
  }, 15000);

  it("keeps schedule edits paused and restores canonical pause and waiting approvals after restart", async () => {
    const f = await fixture(); let restarted: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      await f.add("persistent");
      const matched = await f.daemon.pipeline.evaluate({ kind: "schedule", blueprintId: "persistent", payload: {}, receivedAt: new Date().toISOString(), actor });
      if (matched.outcome !== "matched") throw new Error("Expected pending approval");
      await f.change("persistent", true);
      const current = await f.inspect("persistent");
      const args = ["persistent", "--revision", current.revision, "--schedule", "0 1 1 1 *", "--timezone", "Europe/Zurich"];
      const preview = z.object({ proposedRevision: z.string() }).parse(await f.run(["routine", "schedule", "preview", ...args]));
      await f.run(["routine", "schedule", "update", ...args, "--proposed-revision", preview.proposedRevision]);
      await until(() => { const blueprint = f.daemon.store.get("persistent"); return Boolean(blueprint && "schedule" in blueprint.when && blueprint.when.schedule === "0 1 1 1 *"); });
      expect((await f.inspect("persistent")).current).toMatchObject({ paused: true, schedule: "0 1 1 1 *", timezone: "Europe/Zurich", policy: "approval" });
      await f.daemon.stop();
      restarted = await startDaemon(f.cfg, { dbPath: join(f.dir, "test.db"), bus: f.makeBus(), routineTargetLookup: async () => ["@test/noop"] });
      expect(restarted.store.get("persistent")?.paused).toBe(true); expect(restarted.scheduleStatus()).toEqual([]);
      expect(restarted.repo.getApproval(matched.decisionId)?.state).toBe("waiting");
      expect(await restarted.pipeline.evaluate({ kind: "schedule", blueprintId: "persistent", payload: {}, receivedAt: new Date().toISOString(), actor })).toEqual({ outcome: "ignored", reason: "paused" });
    } finally { await restarted?.stop(); await f.close(); }
  }, 15000);

  it("preserves owner-default timezone and pause across both handling policy changes", async () => {
    const f = await fixture();
    try {
      await f.add("default-zone"); await f.change("default-zone", true);
      const current = await f.inspect("default-zone");
      const args = ["default-zone", "--revision", current.revision, "--schedule", current.current.schedule, "--owner-timezone"];
      const preview = z.object({ proposedRevision: z.string() }).parse(await f.run(["routine", "schedule", "preview", ...args]));
      await f.run(["routine", "schedule", "update", ...args, "--proposed-revision", preview.proposedRevision]);
      for (const policy of ["auto", "approve"]) {
        await f.run(["routine", "set-policy", "default-zone", policy]);
        await until(() => f.daemon.store.get("default-zone")?.policy === (policy === "approve" ? "approval" : policy));
        expect((await f.inspect("default-zone")).current).toMatchObject({ paused: true, timezone: null, policy: policy === "approve" ? "approval" : policy });
        expect(f.daemon.scheduleStatus()).toEqual([]);
      }
    } finally { await f.close(); }
  }, 15000);

  it("does not block unrelated lifecycle changes or reloads while A waits behind active work; queued impulses use paused state", async () => {
    const f = await fixture(); const active = deferred(); const entered = deferred(); const queued = deferred(); let work: Promise<void> | undefined; let pauseA: Promise<unknown> | undefined;
    try {
      await f.add("a"); await f.add("b"); const a = await f.prepare("a", true);
      work = f.daemon.pipeline.serializeChange("a", async () => { entered.resolve(); await active.promise; }); await entered.promise;
      const original = f.daemon.pipeline.serializeChange.bind(f.daemon.pipeline);
      f.daemon.pipeline.serializeChange = <T>(id: string, operation: () => Promise<T>): Promise<T> => { if (id === "a") queued.resolve(); return original(id, operation); };
      pauseA = f.run(["routine", "lifecycle", "update", ...a.args]); await queued.promise;
      const late = f.daemon.pipeline.evaluate({ kind: "schedule", blueprintId: "a", payload: {}, receivedAt: new Date().toISOString(), actor });
      expect((await f.change("b", true)).current.paused).toBe(true);
      const file = join(f.cfg.routinesDir ?? "", "b.yaml"); await writeFile(file, (await readFile(file, "utf8")).replace("target:", "name: Refreshed\n    target:"));
      await until(() => f.daemon.store.get("b")?.name === "Refreshed"); expect(f.daemon.store.get("a")?.paused).not.toBe(true);
      active.resolve(); await work; await pauseA; expect(await late).toEqual({ outcome: "ignored", reason: "paused" });
      await Bun.sleep(250); expect(f.daemon.store.get("a")?.paused).toBe(true);
    } finally { active.resolve(); await work; await pauseA; await f.close(); }
  }, 15000);

  it("waits for an already captured old reload before acknowledging pause, preventing a stale swap from reactivating it", async () => {
    const f = await fixture(); const captured = deferred(); const release = deferred(); let pausing: Promise<unknown> | undefined;
    try {
      await f.add("a"); const prepared = await f.prepare("a", true);
      const reader: unknown = Reflect.get(f.daemon.watcher, "readCorpus"); if (typeof reader !== "function") throw new Error("Watcher read seam unavailable");
      let first = true;
      Object.defineProperty(f.daemon.watcher, "readCorpus", { value: async () => {
        const corpus: unknown = await Reflect.apply(reader, f.daemon.watcher, []);
        if (first) { first = false; captured.resolve(); await release.promise; }
        return corpus;
      } });
      const reload: unknown = Reflect.get(f.daemon.watcher, "reload"); if (typeof reload !== "function") throw new Error("Watcher reload seam unavailable");
      await writeFile(join(f.cfg.activationsDir, "other.yaml"), "schema: metafactory/activation/v1\nactivations:\n  - id: other\n    target: '@test/noop'\n    when: {schedule: '0 0 1 1 *', timezone: UTC}\n");
      const reloading: unknown = Reflect.apply(reload, f.daemon.watcher, []); await captured.promise;
      let acknowledged = false; const admitted = deferred();
      const serialize = f.daemon.pipeline.serializeChange.bind(f.daemon.pipeline);
      f.daemon.pipeline.serializeChange = <T>(id: string, operation: () => Promise<T>): Promise<T> => { admitted.resolve(); return serialize(id, operation); };
      pausing = f.run(["routine", "lifecycle", "update", ...prepared.args]).then((value) => { acknowledged = true; return value; });
      await admitted.promise; await Bun.sleep(30); expect(acknowledged).toBe(false);
      release.resolve(); await reloading; await pausing;
      expect(f.daemon.store.get("a")?.paused).toBe(true); expect(f.daemon.scheduleStatus().some((item) => item.blueprintId === "a")).toBe(false);
      await Reflect.apply(reload, f.daemon.watcher, []); expect(f.daemon.store.get("a")?.paused).toBe(true);
    } finally { release.resolve(); await pausing; await f.close(); }
  }, 15000);

  it("reports an unconfirmed runtime after a committed rename and confirms only after actual reload convergence", async () => {
    const f = await fixture();
    try {
      await f.add("runtime"); const planned = await f.prepare("runtime", true); await f.daemon.watcher.stop();
      const sync = f.daemon.schedule.sync.bind(f.daemon.schedule); let fail = true;
      f.daemon.schedule.sync = () => { if (fail) { fail = false; throw new Error("runtime commit failed after rename"); } sync(); };
      const result = await f.raw(["routine", "lifecycle", "update", ...planned.args]); expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("write-uncertain");
      const uncertain = await f.inspect("runtime"); expect(uncertain).toMatchObject({ revision: planned.revision, runtimeConfirmed: false, current: { paused: true } });
      const uncertainList = z.array(z.object({ id: z.string(), runtimeConfirmed: z.boolean() })).parse(await f.run(["routine", "list"]));
      expect(uncertainList.find((row) => row.id === "runtime")?.runtimeConfirmed).toBe(false);
      const calendarArgs = ["routine", "occurrences", "--principal", "test", "--stack", "pause-test", "--start", "2030-01-01T00:00:00Z", "--end", "2030-01-02T00:00:00Z", "--timezone", "UTC"];
      const calendarSchema = z.object({ occurrences: z.array(z.object({ routineId: z.string(), lifecycle: z.string() })), counts: z.object({ active: z.number() }) });
      const pendingCalendar = calendarSchema.parse(await f.run(calendarArgs));
      expect(pendingCalendar.occurrences.find((entry) => entry.routineId === "runtime")?.lifecycle).toBe("unconfirmed"); expect(pendingCalendar.counts.active).toBe(0);
      const reload: unknown = Reflect.get(f.daemon.watcher, "reload"); if (typeof reload !== "function") throw new Error("Watcher reload seam unavailable");
      await Reflect.apply(reload, f.daemon.watcher, []);
      expect(await f.inspect("runtime")).toMatchObject({ revision: planned.revision, runtimeConfirmed: true, current: { paused: true } });
      expect(calendarSchema.parse(await f.run(calendarArgs)).occurrences.find((entry) => entry.routineId === "runtime")?.lifecycle).toBe("paused");
    } finally { await f.close(); }
  }, 15000);

  it("rejects any explicit pause metadata on non-scheduled when blocks", () => {
    for (const paused of [true, false]) for (const when of ["manual: {}", "bus: {subject: 'local.test.default.events.>'}"]) {
      expect(() => parseActivationDocument(`schema: metafactory/activation/v1\nactivations:\n  - id: other\n    target: '@test/noop'\n    when: {${when}}\n    paused: ${paused}\n`, "test")).toThrow("paused is supported only");
    }
  });

  it("does not silently resume legacy disabled definitions or edit external ownership", async () => {
    const f = await fixture();
    try {
      await f.add("disabled"); const file = join(f.cfg.routinesDir ?? "", "disabled.yaml"); await writeFile(file, (await readFile(file, "utf8")).replace("policy: approval", "policy: disabled"));
      expect(await f.inspect("disabled")).toMatchObject({ writable: false, current: { policy: "disabled", paused: false } });
      await f.add("external"); const external = join(f.cfg.routinesDir ?? "", "external.yaml"); await writeFile(external, (await readFile(external, "utf8")).replace("# reflex-generated-routine: v1\n", ""));
      expect((await f.inspect("external")).writable).toBe(false);
    } finally { await f.close(); }
  }, 15000);

  it("real scheduler emits no ticks while paused and does not cancel already submitted work", async () => {
    const blueprint = scheduleBlueprint("clock", "* * * * * *", "UTC"); const store = new BlueprintStore([{ ...blueprint, paused: true }]); const completed = deferred(); let calls = 0; let settled = false;
    const scheduler = new ScheduleSource(store, { evaluate: async (): Promise<EvaluateResult> => { calls++; await completed.promise; settled = true; return { outcome: "ignored", reason: "paused" }; } });
    try {
      scheduler.start(); await Bun.sleep(1050); expect(calls).toBe(0);
      store.swap([{ ...blueprint, paused: false }]); scheduler.sync(); await until(() => calls === 1);
      store.swap([{ ...blueprint, paused: true }]); scheduler.sync(); expect(settled).toBe(false);
      completed.resolve(); await until(() => settled); await Bun.sleep(1050); expect(calls).toBe(1); expect(scheduler.status()).toEqual([]);
    } finally { completed.resolve(); scheduler.stop(); }
  });
});
