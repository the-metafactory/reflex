import { z } from "zod";
import { createTransport } from "@the-metafactory/myelin";
import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink, symlink, chmod, rename, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineCommands } from "../../src/activation/routines";
import { BlueprintStore, loadBlueprintSet } from "../../src/activation/store";
import { discoverActivationFiles } from "../../src/activation/sources";
import { ScheduleSource } from "../../src/sources/schedule";
import { ActivationWatcher } from "../../src/activation/watcher";
import { Pipeline } from "../../src/pipeline/evaluate";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { createReflexBus } from "../../src/bus";
import { testConfig } from "../helpers";

const actor = { type: "operator", id: "test" } as const;
const input = { id: "routine-test", schedule: "0 0 1 1 *", timezone: "Europe/Zurich", target: "@jc/noop", payload: {} };

async function fixture(knownTargets: () => Promise<readonly string[]> = async () => ["@jc/noop"]) {
  const dir = await mkdtemp(join(tmpdir(), "reflex-routines-"));
  const central = join(dir, "activations");
  const routinesDir = join(dir, "routines");
  await mkdir(central);
  await mkdir(routinesDir);
  const sources = { watchRoots: [], activationsDir: central, routinesDir };
  const store = new BlueprintStore([]);
  const watcher = new ActivationWatcher(store, sources, { debounceMs: 10, rescanIntervalMs: 30 });
  const { db, close } = openDb(join(dir, "test.db"));
  const repo = new Repository(db);
  const bus = createReflexBus(testConfig(), { transport: createTransport({ type: "memory" }) });
  const pipeline = new Pipeline({ store, repo, bus });
  const schedule = new ScheduleSource(store, pipeline);
  store.onBlueprintsRemoved((ids) => { for (const id of ids) repo.expireForBlueprint(id, new Date().toISOString()); });
  const routines = new RoutineCommands({
    dir: routinesDir, sources, knownTargets,
    removalTargets: async () => [{ target: input.target, flowRoot: join(routinesDir, "flows") }],
    removalApplied: (id) => !store.get(id) && !schedule.status().some((job) => job.blueprintId === id) && !repo.listWaiting().some((row) => row.decision.blueprintId === id),
    commitRemoval: (id, write) => pipeline.serializeChange(id, () => watcher.serializeMutation(async () => { try { await write(); } finally { if (!await Bun.file(join(routinesDir, `${id}.yaml`)).exists()) { store.swap(store.current().filter((b) => b.id !== id)); schedule.sync(); } } })),
    dryRun: (blueprint, actor) => pipeline.evaluateBlueprintDry(blueprint, {
      blueprintId: blueprint.id, kind: blueprint.kind, payload: blueprint.payload, actor, receivedAt: new Date().toISOString(),
    }),
    lastDecision: (id) => repo.historyFor({ blueprintId: id, limit: 1 })[0] ?? null,
  });
  await watcher.start();
  return { dir, central, routinesDir, sources, store, routines, repo, pipeline, schedule,
    cleanup: async () => { schedule.stop(); await watcher.stop(); await bus.close(); close(); await rm(dir, { recursive: true, force: true }); } };
}

async function remove(routines: RoutineCommands, id: string) {
  const detail = await routines.execute("routine-removal-inspect", { id }, actor);
  if (!detail.ok) return detail;
  const parsed = z.object({ revision: z.string() }).parse(detail.data);
  return routines.execute("routine-remove", { id, revision: parsed.revision, requestId: crypto.randomUUID() }, actor);
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}

describe("Reflex-owned routines with real loader and Dry Run", () => {
  it("refuses unrevisioned deletion and a stale confirmation without touching owned files", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      expect(await f.routines.execute("routine-remove", { id: input.id }, actor)).toMatchObject({ ok: false });
      expect(await f.routines.execute("routine-remove", { id: input.id, revision: "a".repeat(64), requestId: crypto.randomUUID() }, actor)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await Bun.file(join(f.routinesDir, `${input.id}.yaml`)).exists()).toBe(true);
      expect(await Bun.file(join(f.routinesDir, "flows", `${input.id}.yaml`)).exists()).toBe(true);
    } finally { await f.cleanup(); }
  });

  it.each([false, true])("commits active/paused removal before returning and prevents pending approval dispatch: %s", async (paused) => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", input, actor);
      await until(() => f.store.get(input.id) !== undefined);
      const result = await f.pipeline.evaluate({ blueprintId: input.id, kind: "schedule", payload: {}, actor, receivedAt: new Date().toISOString() });
      expect(result.outcome).toBe("matched");
      if (paused) {
        const file = join(f.routinesDir, `${input.id}.yaml`);
        await writeFile(file, (await readFile(file, "utf8")).replace("    policy:", "    paused: true\n    policy:"));
        await f.store.swap(await loadBlueprintSet(await discoverActivationFiles(f.sources)));
      }
      f.schedule.sync();
      expect((await remove(f.routines, input.id)).ok).toBe(true);
      expect(f.store.get(input.id)).toBeUndefined(); expect(f.schedule.status()).toEqual([]); expect(f.repo.listWaiting()).toEqual([]);
      if (result.outcome === "matched") {
        const resolved = await f.pipeline.resolveMatched(result.decisionId, "approve", actor).catch((error: unknown) => error);
        expect(resolved).not.toMatchObject({ outcome: "fired" });
      }
      expect(f.repo.historyFor({ blueprintId: input.id, limit: 10 }).length).toBeGreaterThan(0);
    } finally { await f.cleanup(); }
  });

  it("reconciles partial cleanup only for its durable exact intent and refuses a recreated routine", async () => {
    const f = await fixture(); const flows = join(f.routinesDir, "flows");
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      await until(() => f.store.get(input.id) !== undefined);
      const detail = await f.routines.execute("routine-removal-inspect", { id: input.id }, actor);
      if (!detail.ok) throw new Error("inspect failed");
      const intent = { id: input.id, revision: z.object({ revision: z.string() }).parse(detail.data).revision, requestId: crypto.randomUUID() };
      await chmod(flows, 0o500);
      expect(await f.routines.execute("routine-remove", intent, actor)).toMatchObject({ ok: false, error: { code: "write-uncertain" } });
      expect(f.store.get(input.id)).toBeUndefined();
      expect(await Bun.file(join(f.routinesDir, `${input.id}.yaml`)).exists()).toBe(false);
      expect(await Bun.file(join(flows, `${input.id}.yaml`)).exists()).toBe(true);
      expect(await f.routines.execute("routine-removal-status", intent, actor)).toMatchObject({ ok: true, data: { status: "pending" } });
      await chmod(flows, 0o700);
      expect(await f.routines.execute("routine-removal-reconcile", intent, actor)).toMatchObject({ ok: true, data: { status: "removed" } });
      expect(await f.routines.execute("routine-removal-reconcile", { ...intent, requestId: crypto.randomUUID() }, actor)).toMatchObject({ ok: false });
      await f.routines.execute("routine-add", { ...input, flow: "name: F_NEW\nactions: [A_EXTRACT_URLS]" }, actor);
      expect(await f.routines.execute("routine-removal-reconcile", intent, actor)).toMatchObject({ ok: false, error: { code: "write-uncertain", message: expect.stringContaining("replacement") } });
      expect(await Bun.file(join(f.routinesDir, `${input.id}.yaml`)).exists()).toBe(true);
      expect(await readFile(join(flows, `${input.id}.yaml`), "utf8")).toContain("F_NEW");
    } finally { await chmod(flows, 0o700).catch(() => undefined); await f.cleanup(); }
  });

  it.each(["wrong-root", "unknown", "failure"])("refuses deletion when target lifetime discovery is %s", async (mode) => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      const commands = new RoutineCommands({ dir: f.routinesDir, sources: f.sources, knownTargets: async () => [input.target], lastDecision: () => null,
        dryRun: async () => ({ wouldOutcome: "matched", reasons: [] }), removalApplied: () => true, commitRemoval: async (_id, write) => { await write(); },
        removalTargets: () => mode === "failure" ? Promise.reject(new Error("Unavailable")) : Promise.resolve(mode === "unknown" ? [] : [{ target: input.target, flowRoot: f.central }]),
      });
      const detail = await commands.execute("routine-removal-inspect", { id: input.id }, actor);
      expect(detail).toMatchObject({ ok: true, data: { writable: false, reason: expect.stringContaining("safe input lifetime") } });
      expect((await remove(commands, input.id)).ok).toBe(false);
      expect(await Bun.file(join(f.routinesDir, `${input.id}.yaml`)).exists()).toBe(true);
    } finally { await f.cleanup(); }
  });

  it.each(["definition", "flow", "symlink"])("preserves an external replacement captured during atomic %s staging", async (kind) => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      const file = kind !== "flow" ? join(f.routinesDir, `${input.id}.yaml`) : join(f.routinesDir, "flows", `${input.id}.yaml`);
      const foreign = `foreign ${kind} bytes`;
      const commands = new RoutineCommands({ dir: f.routinesDir, sources: f.sources, knownTargets: async () => [input.target], lastDecision: () => null,
        dryRun: async () => ({ wouldOutcome: "matched", reasons: [] }), removalApplied: () => true, commitRemoval: async (_id, write) => { await write(); },
        removalTargets: async () => [{ target: input.target, flowRoot: join(f.routinesDir, "flows") }],
        stageRemoval: async (source, staged) => {
          if (source === file) { await writeFile(`${source}.replacement`, foreign); if (kind === "symlink") { await unlink(source); await symlink(`${source}.replacement`, source); } else await rename(`${source}.replacement`, source); }
          await rename(source, staged);
        },
      });
      expect(await remove(commands, input.id)).toMatchObject({ ok: false, error: { code: "write-uncertain", message: expect.stringContaining("restored and preserved") } });
      expect(await readFile(file, "utf8")).toBe(foreign);
    } finally { await f.cleanup(); }
  });

  it("recovers a staged owned resource after a begun-write interruption", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      const dependencies = { dir: f.routinesDir, sources: f.sources, knownTargets: async () => [input.target], lastDecision: () => null,
        dryRun: async () => ({ wouldOutcome: "matched" as const, reasons: [] }), removalApplied: () => true, commitRemoval: async (_id: string, write: () => Promise<void>) => { await write(); },
        removalTargets: async () => [{ target: input.target, flowRoot: join(f.routinesDir, "flows") }],
      };
      const commands = new RoutineCommands({ ...dependencies, stageRemoval: async (source, staged) => { await rename(source, staged); throw new Error("Interrupted after staging"); } });
      const detail = await commands.execute("routine-removal-inspect", { id: input.id }, actor); if (!detail.ok) throw new Error("inspect failed");
      const intent = { id: input.id, revision: z.object({ revision: z.string() }).parse(detail.data).revision, requestId: crypto.randomUUID() };
      expect(await commands.execute("routine-remove", intent, actor)).toMatchObject({ ok: false, error: { code: "write-uncertain" } });
      expect(await commands.execute("routine-removal-status", intent, actor)).toMatchObject({ ok: true, data: { status: "pending" } });
      const restarted = new RoutineCommands(dependencies);
      expect(await restarted.execute("routine-removal-reconcile", intent, actor)).toMatchObject({ ok: true, data: { status: "removed" } });
      expect((await readdir(join(f.routinesDir, ".removals"))).filter((name) => name.endsWith(".removing"))).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("retains both foreign resources when restoration cannot overwrite a replacement", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", input, actor);
      const file = join(f.routinesDir, `${input.id}.yaml`); let preserved = "";
      const commands = new RoutineCommands({ dir: f.routinesDir, sources: f.sources, knownTargets: async () => [input.target], lastDecision: () => null,
        dryRun: async () => ({ wouldOutcome: "matched", reasons: [] }), removalApplied: () => true, commitRemoval: async (_id, write) => { await write(); },
        removalTargets: async () => [{ target: input.target, flowRoot: join(f.routinesDir, "flows") }],
        stageRemoval: async (source, staged) => {
          await writeFile(`${source}.replacement`, "first foreign bytes"); await rename(`${source}.replacement`, source); await rename(source, staged);
          preserved = staged; await writeFile(source, "second foreign bytes");
        },
      });
      expect(await remove(commands, input.id)).toMatchObject({ ok: false, error: { code: "write-uncertain", message: expect.stringContaining("restoration cannot overwrite") } });
      expect(await readFile(file, "utf8")).toBe("second foreign bytes"); expect(await readFile(preserved, "utf8")).toBe("first foreign bytes");
    } finally { await f.cleanup(); }
  });

  it("does not confirm absence through missing or replaced owned flow storage", async () => {
    const f = await fixture(); const flows = join(f.routinesDir, "flows"); const moved = `${flows}-moved`;
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      const result = await remove(f.routines, input.id); if (!result.ok) throw new Error("remove failed");
      const { status: _status, ...intent } = z.object({ id: z.string(), revision: z.string(), requestId: z.string(), status: z.string() }).parse(result.data);
      await rename(flows, moved);
      expect(await f.routines.execute("routine-removal-status", intent, actor)).toMatchObject({ ok: false });
      await mkdir(flows);
      expect(await f.routines.execute("routine-removal-status", intent, actor)).toMatchObject({ ok: false, error: { message: expect.stringContaining("storage identity changed") } });
      await rm(flows, { recursive: true }); await symlink(moved, flows);
      expect(await f.routines.execute("routine-removal-status", intent, actor)).toMatchObject({ ok: false });
    } finally { await f.cleanup(); }
  });

  it("refuses byte-identical recreation even when inode reuse is simulated in the old receipt", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", input, actor);
      const file = join(f.routinesDir, `${input.id}.yaml`); const original = await readFile(file, "utf8");
      const result = await remove(f.routines, input.id); if (!result.ok) throw new Error("remove failed");
      const { status: _status, ...intent } = z.object({ id: z.string(), revision: z.string(), requestId: z.string(), status: z.string() }).parse(result.data);
      await Bun.sleep(2); await f.routines.execute("routine-add", input, actor); expect(await readFile(file, "utf8")).toBe(original);
      const receiptFile = join(f.routinesDir, ".removals", `${input.id}-${intent.requestId}.json`);
      const receipt = z.object({ definition: z.object({ ino: z.string(), dev: z.string(), birthtimeNs: z.string() }).passthrough() }).passthrough().parse(JSON.parse(await readFile(receiptFile, "utf8")));
      const recreated = await lstat(file, { bigint: true }); expect(recreated.birthtimeNs.toString()).not.toBe(receipt.definition.birthtimeNs);
      receipt.definition.ino = recreated.ino.toString(); receipt.definition.dev = recreated.dev.toString(); await writeFile(receiptFile, JSON.stringify(receipt));
      expect(await f.routines.execute("routine-removal-reconcile", intent, actor)).toMatchObject({ ok: false, error: { message: expect.stringContaining("replacement") } });
      expect(await readFile(file, "utf8")).toBe(original);
    } finally { await f.cleanup(); }
  });

  it("deletes a no-flow routine without precreating flow storage", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", input, actor);
      expect(await Bun.file(join(f.routinesDir, "flows")).exists()).toBe(false);
      expect(await remove(f.routines, input.id)).toMatchObject({ ok: true, data: { status: "removed" } });
    } finally { await f.cleanup(); }
  });

  it("refuses symlinked owned flows before mutation and distinguishes prewrite validation refusal", async () => {
    const f = await fixture();
    try {
      expect(await f.routines.execute("routine-add", { ...input, target: "@jc/missing" }, actor)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      const flowFile = join(f.routinesDir, "flows", `${input.id}.yaml`);
      const outside = join(f.dir, "manual-flow.yaml");
      const text = await readFile(flowFile, "utf8");
      await writeFile(outside, text);
      await unlink(flowFile);
      await symlink(outside, flowFile);
      expect(await remove(f.routines, input.id)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await readFile(outside, "utf8")).toBe(text);
      expect(await Bun.file(join(f.routinesDir, `${input.id}.yaml`)).exists()).toBe(true);
    } finally { await f.cleanup(); }
  });
  it("adds approve by default, hot reloads, changes policy and removes", async () => {
    const f = await fixture();
    try {
      expect((await f.routines.execute("routine-add", { ...input, servesGoal: "G5" }, actor)).ok).toBe(true);
      await until(() => f.store.get(input.id) !== undefined);
      expect(f.store.get(input.id)?.policy).toBe("approval");
      expect(f.store.get(input.id)?.serves).toEqual({ goal: "G5" });
      const loaded = await loadBlueprintSet(await discoverActivationFiles(f.sources));
      expect(loaded.map((b) => b.id)).toEqual([input.id]);
      const listing = await f.routines.execute("routine-list", {}, actor);
      expect(listing).toMatchObject({ ok: true, data: [{ id: input.id, policy: "approval", target: input.target, lastDecision: null }] });
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "auto" }, actor)).ok).toBe(true);
      await until(() => f.store.get(input.id)?.policy === "auto");
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "approval" }, actor)).ok).toBe(true);
      await until(() => f.store.get(input.id)?.policy === "approval");
      expect((await remove(f.routines, input.id)).ok).toBe(true);
      await until(() => f.store.get(input.id) === undefined);
      expect((await readdir(f.routinesDir)).sort()).toEqual([".removals"]);
      expect(f.repo.historyFor({ limit: 10 })).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it.each([
    { schedule: "invalid expression" }, { timezone: "Invalid/Zone" }, { target: "@jc/unknown" },
    { id: "../../escape" }, { payload: [] }, { policy: "disabled" }, { servesGoal: "bad" },
  ])("refuses invalid input without writing %j", async (invalid) => {
    const f = await fixture();
    try {
      expect((await f.routines.execute("routine-add", { ...input, ...invalid }, actor)).ok).toBe(false);
      expect((await readdir(f.routinesDir)).sort()).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("refuses duplicate ids across every source and concurrent additions", async () => {
    const f = await fixture();
    try {
      const first = await f.routines.execute("routine-add", input, actor);
      expect(first.ok).toBe(true);
      const before = await readFile(join(f.routinesDir, `${input.id}.yaml`), "utf8");
      expect((await f.routines.execute("routine-add", input, actor)).ok).toBe(false);
      expect(await readFile(join(f.routinesDir, `${input.id}.yaml`), "utf8")).toBe(before);
      const results = await Promise.all([1, 2].map(() => f.routines.execute("routine-add", { ...input, id: "concurrent" }, actor)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      await writeFile(join(f.central, "manual.yaml"), before.replace(input.id, "manual-routine"));
      expect((await f.routines.execute("routine-add", { ...input, id: "manual-routine" }, actor)).ok).toBe(false);
    } finally { await f.cleanup(); }
  });

  it("refuses hand-written removals and policy changes", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", input, actor);
      const file = join(f.routinesDir, `${input.id}.yaml`);
      const text = await readFile(file, "utf8");
      await writeFile(file, text.slice(text.indexOf("\n") + 1));
      expect((await remove(f.routines, input.id)).ok).toBe(false);
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "auto" }, actor)).ok).toBe(false);
      expect(await readFile(file, "utf8")).toBe(text.slice(text.indexOf("\n") + 1));
    } finally { await f.cleanup(); }
  });


  it("lists the most recent real decision and refuses blocked auto promotion without changing approval", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", input, actor);
      await until(() => f.store.get(input.id) !== undefined);
      await f.pipeline.evaluate({ blueprintId: input.id, kind: "schedule", payload: {}, actor, receivedAt: new Date().toISOString() });
      expect(await f.routines.execute("routine-list", {}, actor)).toMatchObject({ ok: true, data: [{ lastDecision: { outcome: "matched" } }] });
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "auto" }, actor)).ok).toBe(true);
      const { deriveIdempotencyKey } = await import("../../src/pipeline/impulse");
      await f.repo.putIdempotencyKey(input.id, await deriveIdempotencyKey(input.id, {}), new Date(Date.now() + 60000).toISOString());
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "approval" }, actor)).ok).toBe(true);
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "auto" }, actor)).ok).toBe(false);
      expect(await readFile(join(f.routinesDir, `${input.id}.yaml`), "utf8")).toContain("policy: approval");
    } finally { await f.cleanup(); }
  });

  it("keeps removal and demotion available during target discovery outage", async () => {
    let down = false;
    const f = await fixture(async () => { if (down) throw new Error("source unavailable"); return [input.target]; });
    try {
      expect((await f.routines.execute("routine-add", { ...input, policy: "auto" }, actor)).ok).toBe(true);
      down = true;
      expect((await f.routines.execute("routine-add", { ...input, id: "other" }, actor)).ok).toBe(false);
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "approval" }, actor)).ok).toBe(true);
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "auto" }, actor)).ok).toBe(false);
      expect((await remove(f.routines, input.id)).ok).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("owns supplied flow storage through policy updates and removal", async () => {
    const f = await fixture();
    try {
      const flow = "name: F_TEST\nactions:\n  - A_EXTRACT_URLS # sovereignty: D, residency: CH\ninput: {text: example}\n";
      const result = await f.routines.execute("routine-add", { ...input, flow }, actor);
      expect(result.ok).toBe(true);
      const path = join(f.routinesDir, "flows", `${input.id}.yaml`);
      expect(await readFile(path, "utf8")).toBe(`# reflex-generated-flow: ${input.id} v1\n` + flow);
      await until(() => f.store.get(input.id) !== undefined);
      expect(f.store.get(input.id)?.payload.flow).toBe(path);
      expect((await f.routines.execute("routine-set-policy", { id: input.id, policy: "auto" }, actor)).ok).toBe(true);
      expect((await remove(f.routines, input.id)).ok).toBe(true);
      expect(await readdir(join(f.routinesDir, "flows"))).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("rejects malformed flow and conflicting paths before writing and preserves unowned flows", async () => {
    const f = await fixture();
    try {
      expect((await f.routines.execute("routine-add", { ...input, flow: "bad: yaml" }, actor)).ok).toBe(false);
      expect((await readdir(f.routinesDir)).sort()).toEqual([]);
      const flow = "name: F_TEST\nactions: [A_EXTRACT_URLS]";
      expect((await f.routines.execute("routine-add", { ...input, payload: { flow: "/outside" }, flow }, actor)).ok).toBe(false);
      await mkdir(join(f.routinesDir, "flows"), { recursive: true });
      const path = join(f.routinesDir, "flows", `${input.id}.yaml`);
      await writeFile(path, "unowned");
      expect((await f.routines.execute("routine-add", { ...input, flow }, actor)).ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe("unowned");
      expect((await readdir(f.routinesDir)).sort()).toEqual(["flows"]);
    } finally { await f.cleanup(); }
  });

  it("rolls back a newly stored flow when the activation cannot commit", async () => {
    const f = await fixture();
    try {
      const routines = new RoutineCommands({
        dir: f.routinesDir, sources: f.sources, knownTargets: async () => [input.target], lastDecision: () => null,
        dryRun: async () => {
          await mkdir(join(f.routinesDir, `${input.id}.yaml`));
          return { wouldOutcome: "matched", reasons: [] };
        },
      });
      expect((await routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor)).ok).toBe(false);
      expect(await readdir(join(f.routinesDir, "flows"))).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("refuses removing a routine whose owned flow was replaced by a hand-written file", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor);
      const path = join(f.routinesDir, "flows", `${input.id}.yaml`);
      await writeFile(path, "hand-written");
      expect((await remove(f.routines, input.id)).ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe("hand-written");
      expect(await readFile(join(f.routinesDir, `${input.id}.yaml`), "utf8")).toContain("policy: approval");
    } finally { await f.cleanup(); }
  });

  it("writes nothing when real Dry Run refuses a retained idempotency guard", async () => {
    const f = await fixture();
    try {
      await f.routines.execute("routine-add", { ...input, policy: "auto" }, actor);
      await until(() => f.store.get(input.id) !== undefined);
      const { deriveIdempotencyKey } = await import("../../src/pipeline/impulse");
      const key = await deriveIdempotencyKey(input.id, input.payload);
      await f.repo.putIdempotencyKey(input.id, key, new Date(Date.now() + 60000).toISOString());
      await remove(f.routines, input.id);
      const refusal = await f.routines.execute("routine-add", { ...input, policy: "auto" }, actor);
      expect(refusal).toMatchObject({ ok: false, error: { message: expect.stringContaining("Dry Run refused") } });
      expect((await readdir(f.routinesDir)).sort()).toEqual([".removals"]);
    } finally { await f.cleanup(); }
  });
});
