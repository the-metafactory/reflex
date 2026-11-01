import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
  const routines = new RoutineCommands({ dir: routinesDir, sources: { activationsDir, routinesDir, watchRoots: [] }, knownTargets: async () => ["@test/pulse-flow"], lastDecision: () => null, flowContract, dryRun: async () => { dryRuns++; return { wouldOutcome: "matched", reasons: [] }; } });
  const added = await routines.execute("routine-add", { id: "edit-test", schedule: "0 0 1 1 *", timezone: "UTC", target: "@test/pulse-flow", payload: { preserve: true }, flow: yaml }, actor);
  expect(added.ok).toBe(true);
  const flowFile = join(routinesDir, "flows", "edit-test.yaml");
  const file = join(routinesDir, "edit-test.yaml");
  const inspect = () => routines.execute("routine-inspect", { id: "edit-test" }, actor);
  return { dir, activationsDir, routines, flowFile, file, inspect, dryRuns: () => dryRuns,
    setDuring: (callback: () => Promise<void>) => { duringValidation = callback; }, setRefused: () => { refused = true; },
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("owner routine editing", () => {
  it("lists external scheduled definitions read-only and leaves non-scheduled definitions out", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.activationsDir, "external.yaml"), stringify({ schema: ACTIVATION_SCHEMA_ID, activations: [{ id: "external", target: "@other/pulse-flow", when: { schedule: "0 9 * * *", timezone: "Europe/Zurich" }, policy: "disabled", payload: {} }] }));
      const result = await f.routines.execute("routine-list", {}, actor);
      expect(result).toMatchObject({ ok: true, data: expect.arrayContaining([{ id: "external", schedule: "0 9 * * *", timezone: "Europe/Zurich", policy: "disabled", target: "@other/pulse-flow", lastDecision: null, file: join(f.activationsDir, "external.yaml"), readOnly: true }]) });
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
