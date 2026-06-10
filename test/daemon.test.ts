import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus } from "../src/bus";
import { startDaemon } from "../src/daemon";
import { testConfig } from "./helpers";

function docFor(id: string, cron = "0 7 * * *"): string {
  return `schema: metafactory/activation/v1\nactivations:\n  - id: ${id}\n    target: "@jc/${id}"\n    when:\n      schedule: "${cron}"\n`;
}

describe("startDaemon", () => {
  it("starts, reflects blueprints, evaluates manual impulses, stops cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-"));
    const central = join(dir, "activations");
    mkdirSync(central);
    writeFileSync(join(central, "a.yaml"), docFor("daemon-a"));
    const cfg = testConfig({ watchRoots: [], activationsDir: central });
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });

    const daemon = await startDaemon(cfg, { dbPath: join(dir, "reflex.db"), bus, sweepIntervalMs: 100_000 });
    expect(daemon.store.current().map((b) => b.id)).toEqual(["daemon-a"]);
    expect(daemon.schedule.status()).toHaveLength(1);
    expect(daemon.schedule.status()[0]!.nextTick).not.toBeNull();

    // the wired pipeline works end-to-end against the daemon's own store/repo
    const result = await daemon.pipeline.evaluate({
      kind: "schedule",
      blueprintId: "daemon-a",
      payload: { scheduled_for: "2026-06-10T07:00:00Z" },
      receivedAt: new Date().toISOString(),
      actor: { type: "system", id: "test" },
    });
    expect(result.outcome).toBe("fired");
    expect(daemon.repo.historyFor({ blueprintId: "daemon-a" })).toHaveLength(1);

    await daemon.stop();
    await daemon.stop(); // idempotent
  });

  it("hot-reload reaches the scheduler through the daemon wiring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-"));
    const central = join(dir, "activations");
    mkdirSync(central);
    writeFileSync(join(central, "a.yaml"), docFor("hot-a"));
    const cfg = testConfig({ watchRoots: [], activationsDir: central });
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
    const daemon = await startDaemon(cfg, { dbPath: join(dir, "reflex.db"), bus, sweepIntervalMs: 100_000 });

    writeFileSync(join(central, "b.yaml"), docFor("hot-b"));
    const deadline = Date.now() + 3000;
    while (daemon.schedule.status().length < 2 && Date.now() < deadline) {
      await Bun.sleep(30);
    }
    expect(
      daemon.schedule
        .status()
        .map((s) => s.blueprintId)
        .sort(),
    ).toEqual(["hot-a", "hot-b"]);
    await daemon.stop();
  });

  it("fails fast on a duplicate blueprint id at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-"));
    const central = join(dir, "activations");
    mkdirSync(central);
    writeFileSync(join(central, "one.yaml"), docFor("dup"));
    writeFileSync(join(central, "two.yaml"), docFor("dup"));
    const cfg = testConfig({ watchRoots: [], activationsDir: central });
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
    expect(startDaemon(cfg, { dbPath: join(dir, "reflex.db"), bus })).rejects.toThrow(/dup/);
    await bus.close();
  });
});
