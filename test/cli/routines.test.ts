import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, access, readFile } from "node:fs/promises";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus } from "../../src/bus";
import { runCommand } from "../../src/cli/main";
import { startDaemon, type ReflexDaemon } from "../../src/daemon";
import { testConfig } from "../helpers";

const transport = createTransport({ type: "memory" });
const shared = {
  publish: transport.publish.bind(transport), request: transport.request.bind(transport),
  subscribe: transport.subscribe.bind(transport), subscribeBestEffort: transport.subscribeBestEffort.bind(transport),
  close: async () => {},
};
const cfg = testConfig({ stack: "routine-test" });
const makeBus = () => createReflexBus(cfg, { transport: shared });
const run = (argv: string[]) => runCommand(argv, { cfg, makeBus });
let daemon: ReflexDaemon;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reflex-routine-cli-"));
  await mkdir(join(dir, "activations"));
  const contract = join(dir, "contract.ts");
  await writeFile(contract, `const input = JSON.parse(await Bun.stdin.text());
const attempts = Number(/attempts: (\\d+)/.exec(input.yaml)?.[1] ?? 2);
const value = input.patches[0]?.value ?? attempts;
const view = {name:"F_CLI_EDIT",steps:[{path:["actions",0],action:"retry",purpose:"Sequence",parameters:[{name:"attempts",kind:"literal",value}],editable:[{name:"attempts",type:"number",minimum:1}],reason:"Retry contract"}]};
console.log(JSON.stringify({view,...(input.patches.length ? {yaml:input.yaml.replace(/attempts: \\d+/,"attempts: "+value)} : {})}));`);
  daemon = await startDaemon({ ...cfg, activationsDir: join(dir, "activations"), routinesDir: join(dir, "routines"), routineFlowContractCommand: [process.execPath, contract] }, {
    dbPath: join(dir, "test.db"), bus: makeBus(), routineTargetLookup: async () => ["@jc/noop"], routineRemovalTargetLookup: async () => [{ target: "@jc/noop", flowRoot: join(dir, "routines", "flows") }],
  });
});
afterAll(async () => { await daemon.stop(); await transport.close(); await rm(dir, { recursive: true, force: true }); });

async function remove(id: string) {
  const detail = await run(["routine", "removal", "inspect", id, "--json"]);
  const { revision } = z.object({ revision: z.string() }).parse(JSON.parse(detail.stdout));
  return run(["routine", "remove", id, "--revision", revision, "--request-id", crypto.randomUUID(), "--json"]);
}

async function waitLoaded(present: boolean) {
  const deadline = Date.now() + 5000;
  while (Boolean(daemon.store.get("cli-routine")) !== present && Date.now() < deadline) await Bun.sleep(25);
  expect(Boolean(daemon.store.get("cli-routine"))).toBe(present);
}

describe("routine CLI through daemon command protocol", () => {
  it("adds, lists, tests, changes policy and removes with clean JSON", async () => {
    const flowFile = join(dir, "supplied-flow.yaml");
    await writeFile(flowFile, "name: F_CLI_TEST\nactions: [A_EXTRACT_URLS]\n");
    const add = await run(["routine", "add", "--id", "cli-routine", "--schedule", "0 0 1 1 *", "--timezone", "Europe/Zurich", "--target", "@jc/noop", "--payload", "{}", "--flow-file", flowFile, "--json"]);
    expect(add.exitCode).toBe(0);
    expect(JSON.parse(add.stdout)).toMatchObject({ id: "cli-routine", file: join(dir, "routines", "cli-routine.yaml") });
    await waitLoaded(true);
    const list = await run(["list", "--json"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject([{ id: "cli-routine", policy: "approval" }]);
    const routines = await run(["routine", "list", "--json"]);
    expect(JSON.parse(routines.stdout)).toMatchObject([{ id: "cli-routine", policy: "approval", lastDecision: null }]);
    const calendar = await run(["routine", "occurrences", "--start", "2027-12-31T00:00:00Z", "--end", "2028-01-02T00:00:00Z", "--timezone", "Europe/Zurich", "--json"]);
    expect(calendar.exitCode).toBe(0);
    expect(JSON.parse(calendar.stdout)).toMatchObject({ owner: "reflex", principal: cfg.principal, stack: cfg.stack, complete: true, occurrences: [{ routineId: "cli-routine", scheduledFor: "2027-12-31T23:00:00.000Z" }] });
    expect(daemon.repo.historyFor({ limit: 10 })).toEqual([]);
    const invalidCalendar = await run(["routine", "occurrences", "--start", "bad", "--end", "bad", "--timezone", "UTC", "--json"]);
    expect(invalidCalendar.exitCode).toBe(1);
    const test = await run(["test", "cli-routine", "--json"]);
    expect(JSON.parse(test.stdout)).toMatchObject({ wouldOutcome: "matched" });
    expect((await run(["routine", "set-policy", "cli-routine", "auto", "--json"])).exitCode).toBe(0);
    expect((await run(["routine", "set-policy", "cli-routine", "approve", "--json"])).exitCode).toBe(0);
    expect((await remove("cli-routine")).exitCode).toBe(0);
    await waitLoaded(false);
    expect(JSON.parse((await run(["routine", "list", "--json"])).stdout)).toEqual([]);
    expect(daemon.repo.historyFor({ limit: 10 })).toEqual([]);
    await expect(access(join(dir, "routines/flows/cli-routine.yaml"))).rejects.toThrow();
  });

  it("refuses malformed payload locally and unknown targets before files", async () => {
    const args = ["routine", "add", "--id", "cli-routine", "--schedule", "0 0 1 1 *", "--timezone", "UTC", "--target", "@jc/unknown", "--payload"];
    expect((await run([...args, "{"])).exitCode).toBe(1);
    const refusal = await run([...args, "{}"]);
    expect(refusal.exitCode).toBe(1);
    expect(refusal.stderr).toContain("Unknown routine target");
    expect(JSON.parse((await run(["routine", "list", "--json"])).stdout)).toEqual([]);
  });

  it("inspects and updates through the actual daemon RPC and refuses the stale revision without firing", async () => {
    const flow = join(dir, "edit-flow.yaml");
    await writeFile(flow, "name: F_CLI_EDIT\nactions:\n  - retry:\n      attempts: 2\n      actions: [A_NOOP]\n");
    expect((await run(["routine", "add", "--id", "cli-editor", "--schedule", "0 0 1 1 *", "--timezone", "UTC", "--target", "@jc/noop", "--payload", "{}", "--flow-file", flow, "--json"])).exitCode).toBe(0);
    const inspected = await run(["routine", "inspect", "cli-editor", "--json"]);
    expect(inspected.exitCode).toBe(0);
    const detail: unknown = JSON.parse(inspected.stdout);
    if (typeof detail !== "object" || detail === null || !("revision" in detail) || typeof detail.revision !== "string") throw new Error("Owner inspection did not return a revision");
    const args = ["routine", "update", "cli-editor", "--revision", detail.revision, "--patches", JSON.stringify([{ path: ["actions", 0, "retry", "attempts"], value: 3 }]), "--json"];
    const saved = await run(args);
    expect(saved.exitCode).toBe(0);
    expect(JSON.parse(saved.stdout)).toMatchObject({ flow: { steps: [{ parameters: [{ name: "attempts", kind: "literal", value: 3 }] }] } });
    expect((await run(args)).exitCode).toBe(1);
    expect(daemon.repo.historyFor({ limit: 10 })).toEqual([]);
    expect((await remove("cli-editor")).exitCode).toBe(0);
  });

  it("reads scoped paginated historical decisions through the daemon without modifying them", async () => {
    const decision = daemon.repo.recordDecision({ blueprintId: "historical-fixture", outcome: "fired", correlationId: crypto.randomUUID(), impulse: { kind: "schedule", payload: { private: "fixture-only" }, receivedAt: new Date().toISOString(), routineName: "Recorded fixture" } });
    const history = await run(["routine", "history", "--routine-id", "historical-fixture", "--limit", "1", "--json"]);
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(history.stdout)).toMatchObject({ owner: "reflex", principal: cfg.principal, stack: cfg.stack, complete: true, records: [{ decisionId: decision.id, correlationId: decision.correlationId, routineName: "Recorded fixture", definitionPresent: false }] });
    expect(history.stdout).not.toContain("fixture-only");
    expect((await run(["routine", "history", "--stack", "foreign", "--json"])).exitCode).toBe(1);
    expect((await run(["routine", "history", "--limit", "101", "--json"])).exitCode).toBe(1);
  });

  it("previews and confirms schedule updates over real RPC with revision refusal and no execution", async () => {
    const history = daemon.repo.historyFor({ limit: 100 });
    expect((await run(["routine", "add", "--id", "cli-schedule", "--schedule", "0 0 1 1 *", "--timezone", "UTC", "--target", "@jc/noop", "--payload", "{}", "--json"])).exitCode).toBe(0);
    const file = join(dir, "routines", "cli-schedule.yaml"); const before = await readFile(file, "utf8");
    const inspected = await run(["routine", "schedule", "inspect", "cli-schedule", "--json"]); expect(inspected.exitCode).toBe(0);
    const current = z.object({ revision: z.string() }).parse(JSON.parse(inspected.stdout));
    const fields = ["cli-schedule", "--revision", current.revision, "--schedule", "0 9 1 1 *", "--owner-timezone"];
    const response = await run(["routine", "schedule", "preview", ...fields, "--json"]); expect(response.exitCode).toBe(0);
    const planned = z.object({ proposedRevision: z.string() }).parse(JSON.parse(response.stdout)); expect(await readFile(file, "utf8")).toBe(before);
    const update = ["routine", "schedule", "update", ...fields, "--proposed-revision", planned.proposedRevision, "--json"];
    const saved = await run(update); expect(saved.exitCode).toBe(0); expect(JSON.parse(saved.stdout)).toMatchObject({ revision: planned.proposedRevision, current: { schedule: "0 9 1 1 *", timezone: null } });
    expect((await run(update)).exitCode).toBe(1);
    expect((await run(["routine", "schedule", "preview", "cli-schedule", "--revision", planned.proposedRevision, "--schedule", "invalid", "--timezone", "UTC", "--json"])).exitCode).toBe(1);
    expect(daemon.repo.historyFor({ limit: 100 })).toEqual(history);
    expect((await remove("cli-schedule")).exitCode).toBe(0);
  });
});
