import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus, type ReflexBus } from "../../src/bus";
import { runCommand } from "../../src/cli/main";
import { EXIT_DOMAIN, EXIT_OK, EXIT_TRANSPORT } from "../../src/cli/render";
import { startDaemon, type ReflexDaemon } from "../../src/daemon";
import type { ReflexConfig } from "../../src/config/schema";
import { testConfig } from "../helpers";

// One shared InMemory transport: daemon router + CLI client must meet on it.
// CLI buses close after each invocation (correct for real NATS connections) —
// here that must not tear down the shared transport, so wrap close as no-op.
const transport = createTransport({ type: "memory" });
const cfg = testConfig();
const sharedNoClose = {
  publish: transport.publish.bind(transport),
  request: transport.request.bind(transport),
  subscribe: transport.subscribe.bind(transport),
  subscribeBestEffort: transport.subscribeBestEffort.bind(transport),
  close: async () => {},
};
const makeBus = (c: ReflexConfig): ReflexBus => createReflexBus(c, { transport: sharedNoClose as never });

let daemon: ReflexDaemon;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reflex-cli-"));
  const central = join(dir, "activations");
  mkdirSync(central);
  writeFileSync(
    join(central, "demo.yaml"),
    `schema: metafactory/activation/v1
activations:
  - id: cli-demo
    target: "@jc/cli-demo"
    when:
      manual: {}
  - id: cli-gate
    target: "@jc/cli-gate"
    when:
      manual: {}
    policy: approval
  - id: cli-sched
    target: "@jc/cli-sched"
    when:
      schedule: "0 7 * * *"
`,
  );
  const dcfg = testConfig({ watchRoots: [], activationsDir: central });
  daemon = await startDaemon(dcfg, {
    dbPath: join(dir, "reflex.db"),
    bus: createReflexBus(dcfg, { transport: sharedNoClose as never }),
    sweepIntervalMs: 100_000,
  });
});

afterAll(async () => {
  await daemon.stop();
});

function run(argv: string[]) {
  return runCommand(argv, { cfg, makeBus });
}

describe("reflex CLI end-to-end (InMemory)", () => {
  it("status: exit 0, shows blueprints + canonical waiting text", async () => {
    const r = await run(["status"]);
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.stdout).toContain("blueprints: 3");
    expect(r.stdout).toContain("Matched Decisions awaiting approval");
  });

  it("list --json is a parseable JSON document", async () => {
    const r = await run(["list", "--json"]);
    expect(r.exitCode).toBe(EXIT_OK);
    const rows = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(rows.map((x) => x.id).sort()).toEqual(["cli-demo", "cli-gate", "cli-sched"]);
  });

  it("fire returns the decision verdict; history lists it first", async () => {
    const r = await run(["fire", "cli-demo", "--input", '{"suite":"smoke"}']);
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.stdout).toContain("fired");
    const h = await run(["history", "--blueprint", "cli-demo", "--json"]);
    const rows = JSON.parse(h.stdout) as Array<{ outcome: string }>;
    expect(rows[0]!.outcome).toBe("fired");
  });

  it("approval round trip: fire → pending → approve; conflict on second approve", async () => {
    const fired = await run(["fire", "cli-gate", "--json"]);
    expect(fired.exitCode).toBe(EXIT_OK);
    const { decisionId } = JSON.parse(fired.stdout) as { decisionId: string };

    const pending = await run(["pending"]);
    expect(pending.stdout).toContain("cli-gate");
    expect(pending.stdout).toContain("Matched Decisions awaiting approval");

    const approved = await run(["approve", decisionId]);
    expect(approved.exitCode).toBe(EXIT_OK);
    expect(approved.stdout).toContain("fired");

    const again = await run(["approve", decisionId]);
    expect(again.exitCode).toBe(EXIT_DOMAIN);
    expect(again.stderr).toContain("conflict");
    expect(again.stderr).toContain("approved");
  });

  it("test renders a Dry Run Verdict distinctly", async () => {
    const r = await run(["test", "cli-demo"]);
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.stdout).toContain("DRY RUN — would fire");
  });

  it("bad --input JSON fails locally before any request", async () => {
    const r = await run(["fire", "cli-demo", "--input", "{nope"]);
    expect(r.exitCode).toBe(EXIT_DOMAIN);
    expect(r.stderr).toContain("invalid-input");
  });

  it("validate works with zero infrastructure", async () => {
    const r = await run(["validate", join(dir, "activations")]);
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.stdout).toContain("3 Activation Blueprint(s) valid");
  });

  it("unknown command → usage error exit 1", async () => {
    const r = await run(["frobnicate"]);
    expect(r.exitCode).toBe(EXIT_DOMAIN);
  });

  it("--json parses for every remote command (matrix)", async () => {
    for (const argv of [["status", "--json"], ["list", "--json"], ["pending", "--json"], ["history", "--json"]]) {
      const r = await run(argv);
      expect(r.exitCode).toBe(EXIT_OK);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    }
  });
});

describe("daemon unreachable", () => {
  it("times out with exit 2 and suggests checking both daemon availability and outcome", async () => {
    const lonely = createTransport({ type: "memory" }); // nobody listening
    const r = await runCommand(["pending", "--timeout", "300"], {
      cfg,
      makeBus: (c) => createReflexBus(c, { transport: lonely }),
    });
    expect(r.exitCode).toBe(EXIT_TRANSPORT);
    expect(r.stderr).toContain("request was sent");
    expect(r.stderr).toContain("daemon may still act");
    expect(r.stderr).toContain("reflex-daemon is running");
    expect(r.stderr).toContain("reflex history");
    expect(r.stderr).toContain("reflex service logs");
  }, 10_000);
});

describe("local --impulse parse", () => {
  it("malformed --impulse is a domain error, never a transport failure", async () => {
    const r = await run(["test", "cli-demo", "--impulse", "{nope"]);
    expect(r.exitCode).toBe(EXIT_DOMAIN);
    expect(r.stderr).toContain("invalid-input");
  });
});

describe("list filters", () => {
  it("--kind filters server-side", async () => {
    const r = await run(["list", "--kind", "schedule", "--json"]);
    expect(r.exitCode).toBe(EXIT_OK);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("cli-sched");
    expect(rows[0]!.kind).toBe("schedule");
  });
});
