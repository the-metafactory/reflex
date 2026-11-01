import { createTransport } from "@the-metafactory/myelin";
import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineCommands } from "../../src/activation/routines";
import { BlueprintStore, loadBlueprintSet } from "../../src/activation/store";
import { discoverActivationFiles } from "../../src/activation/sources";
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
  const routines = new RoutineCommands({
    dir: routinesDir, sources, knownTargets,
    dryRun: (blueprint, actor) => pipeline.evaluateBlueprintDry(blueprint, {
      blueprintId: blueprint.id, kind: blueprint.kind, payload: blueprint.payload, actor, receivedAt: new Date().toISOString(),
    }),
    lastDecision: (id) => repo.historyFor({ blueprintId: id, limit: 1 })[0] ?? null,
  });
  await watcher.start();
  return { dir, central, routinesDir, sources, store, routines, repo, pipeline,
    cleanup: async () => { await watcher.stop(); await bus.close(); close(); await rm(dir, { recursive: true, force: true }); } };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}

describe("Reflex-owned routines with real loader and Dry Run", () => {
  it("refuses an unwritable owner before mutation and recovers a previously interrupted owned-flow removal", async () => {
    const f = await fixture();
    const activation = join(f.routinesDir, `${input.id}.yaml`);
    const flowFile = join(f.routinesDir, "flows", `${input.id}.yaml`);
    const routines = new RoutineCommands({
      dir: f.routinesDir, sources: f.sources, knownTargets: async () => [input.target], lastDecision: () => null,
      dryRun: async () => ({ wouldOutcome: "matched", reasons: [] }),
    });
    try {
      expect((await routines.execute("routine-add", { ...input, flow: "name: F_TEST\nactions: [A_EXTRACT_URLS]" }, actor)).ok).toBe(true);
      await chmod(f.routinesDir, 0o500);
      expect(await routines.execute("routine-remove", { id: input.id }, actor)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await Bun.file(flowFile).exists()).toBe(true);
      expect(await Bun.file(activation).exists()).toBe(true);
      expect(await routines.execute("routine-list", {}, actor)).toMatchObject({ ok: true, data: [{ id: input.id }] });
      await chmod(f.routinesDir, 0o700);
      await unlink(flowFile);
      expect((await routines.execute("routine-remove", { id: input.id }, actor)).ok).toBe(true);
      expect(await Bun.file(activation).exists()).toBe(false);
      expect(await routines.execute("routine-remove", { id: "missing" }, actor)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    } finally { await chmod(f.routinesDir, 0o700); await f.cleanup(); }
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
      expect(await f.routines.execute("routine-remove", { id: input.id }, actor)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
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
      expect((await f.routines.execute("routine-remove", { id: input.id }, actor)).ok).toBe(true);
      await until(() => f.store.get(input.id) === undefined);
      expect(await readdir(f.routinesDir)).toEqual([]);
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
      expect(await readdir(f.routinesDir)).toEqual([]);
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
      expect((await f.routines.execute("routine-remove", { id: input.id }, actor)).ok).toBe(false);
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
      expect((await f.routines.execute("routine-remove", { id: input.id }, actor)).ok).toBe(true);
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
      expect((await f.routines.execute("routine-remove", { id: input.id }, actor)).ok).toBe(true);
      expect(await readdir(join(f.routinesDir, "flows"))).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("rejects malformed flow and conflicting paths before writing and preserves unowned flows", async () => {
    const f = await fixture();
    try {
      expect((await f.routines.execute("routine-add", { ...input, flow: "bad: yaml" }, actor)).ok).toBe(false);
      expect(await readdir(f.routinesDir)).toEqual([]);
      const flow = "name: F_TEST\nactions: [A_EXTRACT_URLS]";
      expect((await f.routines.execute("routine-add", { ...input, payload: { flow: "/outside" }, flow }, actor)).ok).toBe(false);
      await mkdir(join(f.routinesDir, "flows"));
      const path = join(f.routinesDir, "flows", `${input.id}.yaml`);
      await writeFile(path, "unowned");
      expect((await f.routines.execute("routine-add", { ...input, flow }, actor)).ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe("unowned");
      expect(await readdir(f.routinesDir)).toEqual(["flows"]);
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
      expect((await f.routines.execute("routine-remove", { id: input.id }, actor)).ok).toBe(false);
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
      await f.routines.execute("routine-remove", { id: input.id }, actor);
      const refusal = await f.routines.execute("routine-add", { ...input, policy: "auto" }, actor);
      expect(refusal).toMatchObject({ ok: false, error: { message: expect.stringContaining("Dry Run refused") } });
      expect(await readdir(f.routinesDir)).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
