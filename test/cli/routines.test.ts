import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
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
  daemon = await startDaemon({ ...cfg, activationsDir: join(dir, "activations"), routinesDir: join(dir, "routines") }, {
    dbPath: join(dir, "test.db"), bus: makeBus(), routineTargetLookup: async () => ["@jc/noop"],
  });
});
afterAll(async () => { await daemon.stop(); await transport.close(); await rm(dir, { recursive: true, force: true }); });

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
    const test = await run(["test", "cli-routine", "--json"]);
    expect(JSON.parse(test.stdout)).toMatchObject({ wouldOutcome: "matched" });
    expect((await run(["routine", "set-policy", "cli-routine", "auto", "--json"])).exitCode).toBe(0);
    expect((await run(["routine", "set-policy", "cli-routine", "approve", "--json"])).exitCode).toBe(0);
    expect((await run(["routine", "remove", "cli-routine", "--json"])).exitCode).toBe(0);
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
});
