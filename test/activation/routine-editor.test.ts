import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { RoutineCommands } from "../../src/activation/routines";
import { ACTIVATION_SCHEMA_ID } from "../../src/activation/schema";
import type { RoutineFlowContract } from "../../src/activation/routine-contract";

const actor = { type: "operator", id: "test" } as const;
const yaml = "name: F_TEST\ninput: {token: keep-private}\nactions:\n  - retry:\n      attempts: 2\n      actions: [A_NOOP]\n";
const view = { name: "F_TEST", steps: [{ path: ["actions", 0], action: "retry", purpose: "Sequence", parameters: [{ name: "attempts", kind: "literal" as const, value: 3 }], editable: [{ name: "attempts", type: "number" as const, minimum: 1 }], reason: "Retry contract" }] };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "reflex-edit-"));
  const activationsDir = join(dir, "activations");
  const routinesDir = join(dir, "routines");
  await mkdir(activationsDir); await mkdir(routinesDir);
  let duringValidation: (() => Promise<void>) | null = null;
  let refused = false;
  const flowContract: RoutineFlowContract = async (text, patches) => {
    if (!patches.length) return { view };
    if (refused) throw new Error("Flow validation refused fields");
    const doc = parseDocument(text);
    for (const patch of patches) doc.setIn(patch.path, patch.value);
    await duringValidation?.();
    return { view, yaml: doc.toString() };
  };
  let dryRuns = 0;
  const deps = { dir: routinesDir, sources: { activationsDir, routinesDir, watchRoots: [] }, knownTargets: async () => ["@test/pulse-flow"], lastDecision: () => null, flowContract, dryRun: async (): Promise<{ wouldOutcome: "matched"; reasons: string[] }> => { dryRuns++; return { wouldOutcome: "matched", reasons: [] }; } };
  const routines = new RoutineCommands(deps);
  const added = await routines.execute("routine-add", { id: "edit-test", schedule: "0 0 1 1 *", timezone: "UTC", target: "@test/pulse-flow", payload: { preserve: true }, flow: yaml }, actor);
  expect(added.ok).toBe(true);
  const flowFile = join(routinesDir, "flows", "edit-test.yaml");
  const file = join(routinesDir, "edit-test.yaml");
  const inspect = () => routines.execute("routine-inspect", { id: "edit-test" }, actor);
  return { dir, activationsDir, routines, flowFile, file, inspect, dryRuns: () => dryRuns, fork: (contract = flowContract) => new RoutineCommands({ ...deps, flowContract: contract }), lock: join(routinesDir, ".edit-test.write-lock"),
    setDuring: (callback: () => Promise<void>) => { duringValidation = callback; }, setRefused: () => { refused = true; },
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("owner routine editing", () => {
  it("refuses oversized UTF-8 contract output before replacing the installed flow", async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.flowFile, "utf8");
      const inspected = await f.inspect();
      if (!inspected.ok || typeof inspected.data !== "object" || !inspected.data || !("revision" in inspected.data)) throw new Error("inspect failed");
      const oversized = `# reflex-generated-flow: edit-test v1\nname: F_TEST\ndescription: ${"ü".repeat(550000)}\nactions: [A_NOOP]\n`;
      expect(oversized.length).toBeLessThan(1048576);
      expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(1048576);
      const other = f.fork(async () => ({ view, yaml: oversized }));
      const result = await other.execute("routine-update", { id: "edit-test", revision: inspected.data.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }, actor);
      expect(result.ok).toBe(false);
      expect(await readFile(f.flowFile, "utf8")).toBe(before);
      expect((await f.inspect()).ok).toBe(true);
      const added = await f.routines.execute("routine-add", { id: "oversized", schedule: "0 0 1 1 *", timezone: "UTC", target: "@test/pulse-flow", payload: {}, flow: oversized }, actor);
      expect(added.ok).toBe(false);
      expect(await Bun.file(join(f.dir, "routines", "oversized.yaml")).exists()).toBe(false);
    } finally { await f.cleanup(); }
  });
  it("coordinates every owner mutation across independent command instances", async () => {
    const f = await fixture();
    let signal = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pending: ReturnType<RoutineCommands["execute"]> | undefined;
    try {
      const inspected = await f.inspect();
      if (!inspected.ok || typeof inspected.data !== "object" || !inspected.data || !("revision" in inspected.data)) throw new Error("inspect failed");
      const args = { id: "edit-test", revision: inspected.data.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] };
      f.setDuring(async () => { signal(); await gate; });
      pending = f.routines.execute("routine-update", args, actor);
      await entered;
      const other = f.fork();
      const commands: { command: Parameters<RoutineCommands["execute"]>[0]; args: Record<string, unknown> }[] = [
        { command: "routine-set-policy", args: { id: "edit-test", policy: "approval" } },
        { command: "routine-remove", args: { id: "edit-test" } },
        { command: "routine-update", args },
        { command: "routine-add", args: { id: "edit-test", schedule: "0 0 1 1 *", timezone: "UTC", target: "@test/pulse-flow", payload: {} } },
      ];
      for (const { command, args: input } of commands) {
        const result = await other.execute(command, input, actor);
        expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("Another routine writer") } });
      }
      release();
      expect((await pending).ok).toBe(true);
      expect((await other.execute("routine-update", args, actor)).ok).toBe(false);
      expect(await readFile(f.flowFile, "utf8")).toContain("attempts: 3");
      expect(f.dryRuns()).toBe(1);
    } finally { release(); await pending; await f.cleanup(); }
  });
  it("preserves a replaced write lock instead of removing another owner's lock", async () => {
    const f = await fixture();
    try {
      const inspected = await f.inspect();
      if (!inspected.ok || typeof inspected.data !== "object" || !inspected.data || !("revision" in inspected.data)) throw new Error("inspect failed");
      f.setDuring(async () => { await unlink(f.lock); await writeFile(f.lock, "other-owner"); });
      const result = await f.routines.execute("routine-update", { id: "edit-test", revision: inspected.data.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }, actor);
      expect(result).toMatchObject({ ok: false, error: { code: "write-uncertain" } });
      expect(await readFile(f.lock, "utf8")).toBe("other-owner");
    } finally { await f.cleanup(); }
  });
  it("lists external scheduled definitions read-only and leaves non-scheduled definitions out", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.activationsDir, "external.yaml"), stringify({ schema: ACTIVATION_SCHEMA_ID, activations: [{ id: "external", target: "@other/pulse-flow", when: { schedule: "0 9 * * *", timezone: "Europe/Zurich" }, policy: "disabled", payload: {} }] }));
      const result = await f.routines.execute("routine-list", {}, actor);
      expect(result).toMatchObject({ ok: true, data: expect.arrayContaining([{ id: "external", schedule: "0 9 * * *", timezone: "Europe/Zurich", policy: "disabled", target: "@other/pulse-flow", lastDecision: null, file: join(f.activationsDir, "external.yaml"), readOnly: true, capabilities: { editSchedule: false } }]) });
    } finally { await f.cleanup(); }
  });
  it("atomically updates only flow bytes, preserves activation, and refuses stale or invalid edits without execution", async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.file, "utf8");
      const inspected = await f.inspect();
      if (!inspected.ok || typeof inspected.data !== "object" || !inspected.data || !("revision" in inspected.data)) throw new Error("inspect failed");
      const args = { id: "edit-test", revision: inspected.data.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] };
      const saved = await f.routines.execute("routine-update", args, actor);
      expect(saved.ok).toBe(true);
      expect(await readFile(f.file, "utf8")).toBe(before);
      const installed = await readFile(f.flowFile, "utf8");
      expect(installed).toContain("attempts: 3");
      expect(installed).toContain("keep-private");
      expect((await f.routines.execute("routine-update", args, actor)).ok).toBe(false);
      expect(await readFile(f.flowFile, "utf8")).toBe(installed);
      expect(f.dryRuns()).toBe(1);
      const newer = await f.inspect();
      if (!newer.ok || typeof newer.data !== "object" || !newer.data || !("revision" in newer.data)) throw new Error("inspect failed");
      f.setRefused();
      expect((await f.routines.execute("routine-update", { ...args, revision: newer.data.revision }, actor)).ok).toBe(false);
      expect(await readFile(f.flowFile, "utf8")).toBe(installed);
    } finally { await f.cleanup(); }
  });
  it("refuses a writer change during validation before replacement", async () => {
    const f = await fixture();
    try {
      const inspected = await f.inspect();
      if (!inspected.ok || typeof inspected.data !== "object" || !inspected.data || !("revision" in inspected.data)) throw new Error("inspect failed");
      const newer = (await readFile(f.flowFile, "utf8")).replace("attempts: 2", "attempts: 7");
      f.setDuring(() => writeFile(f.flowFile, newer));
      expect((await f.routines.execute("routine-update", { id: "edit-test", revision: inspected.data.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }, actor)).ok).toBe(false);
      expect(await readFile(f.flowFile, "utf8")).toBe(newer);
    } finally { await f.cleanup(); }
  });
});
