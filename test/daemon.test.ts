import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "@the-metafactory/myelin";
import { TimeoutError } from "@nats-io/nats-core";
import type { StreamInfo } from "@nats-io/jetstream";
import { createReflexBus } from "../src/bus";
import { startDaemon } from "../src/daemon";
import { testConfig, fakeTransport } from "./helpers";

function docFor(id: string, cron = "0 7 * * *"): string {
  return `schema: metafactory/activation/v1\nactivations:\n  - id: ${id}\n    target: "@jc/${id}"\n    when:\n      schedule: "${cron}"\n`;
}

describe("startDaemon", () => {
  it("daemon entry logs exhausted timeouts and exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-exit-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, `principal: jc\nstate_dir: ${dir}\nactivations_dir: ${dir}/activations\n`);
    const sourcePath = (relative: string) => new URL(relative, import.meta.url).pathname;
    // Isolate module fakes in a child: exercise the real entry, daemon and
    // stream loop; replace only the bus adapter and retry clock.
    const script = `
      import { mock } from "bun:test";
      import { createTransport } from "@the-metafactory/myelin";
      import { TimeoutError } from "@nats-io/nats-core";
      const streamPath = ${JSON.stringify(sourcePath("../src/bus/stream.ts"))};
      const ensure = (await import(streamPath)).ensureReflexStream;
      const transport = Object.assign(createTransport({type:"memory"}), {
        getStreamManager: async () => ({streams: {
          info: async () => { throw new TimeoutError(); },
          add: async () => { throw new Error("unsafe creation"); }
        }})
      });
      mock.module(${JSON.stringify(sourcePath("../src/bus/nats-transport.ts"))}, () => ({ buildNatsTransport: () => transport }));
      mock.module(streamPath, () => ({ ensureReflexStream: (raw, cfg) => ensure(raw, cfg, {sleep: async () => {}}) }));
      await import(${JSON.stringify(sourcePath("../src/bin/reflex-daemon.ts"))});
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, REFLEX_CONFIG: configPath },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("attempt 1/10");
    expect(stderr).toContain("startup failed: Failed to ensure JetStream stream REFLEX after 10 attempts (timeout retries exhausted)");
    expect(stderr).not.toContain("unsafe creation");
  });

  it("stays in startup through stream timeouts, then runs and stops normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-retry-"));
    const central = join(dir, "activations");
    mkdirSync(central);
    writeFileSync(join(central, "a.yaml"), docFor("retry-a"));
    const cfg = testConfig({ activationsDir: central });
    let calls = 0;
    const info = mock(async (): Promise<StreamInfo> => {
      if (++calls <= 3) throw new TimeoutError();
      return {} as StreamInfo;
    });
    const add = mock(async () => ({} as StreamInfo));
    const transport = Object.assign(createTransport({ type: "memory" }), fakeTransport(info, add));
    const bus = createReflexBus(cfg, { transport });
    const delays: number[] = [];
    const daemon = await startDaemon(cfg, {
      bus, dbPath: join(dir, "reflex.db"),
      streamStartup: { sleep: async (ms) => { delays.push(ms); } },
    });
    try {
      expect(delays).toEqual([1000, 2000, 4000]);
      expect(info).toHaveBeenCalledTimes(4);
      expect(add).not.toHaveBeenCalled();
      expect(daemon.scheduleStatus()).toHaveLength(1);
      const decision = await daemon.pipeline.evaluate({
        kind: "schedule", blueprintId: "retry-a", payload: {},
        receivedAt: new Date().toISOString(), actor: { type: "system", id: "test" },
      });
      expect(decision.outcome).toBe("fired");
    } finally {
      await daemon.stop();
    }
  });

  it("rejects startup after stream retries are exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-exhausted-"));
    const cfg = testConfig({ activationsDir: dir });
    const info = mock(async (): Promise<StreamInfo> => { throw new TimeoutError(); });
    const add = mock(async () => ({} as StreamInfo));
    const transport = Object.assign(createTransport({ type: "memory" }), fakeTransport(info, add));
    const bus = createReflexBus(cfg, { transport });
    try {
      await expect(startDaemon(cfg, {
        bus, dbPath: join(dir, "reflex.db"), streamStartup: { sleep: async () => {} },
      })).rejects.toThrow(/REFLEX after 10 attempts/);
      expect(info).toHaveBeenCalledTimes(10);
      expect(add).not.toHaveBeenCalled();
    } finally {
      await bus.close();
    }
  });

  it("does not retry a non-timeout stream startup error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-permission-"));
    const cfg = testConfig({ activationsDir: dir });
    const getStreamManager = mock(async () => { throw new Error("permission denied"); });
    const transport = Object.assign(createTransport({ type: "memory" }), { getStreamManager });
    const bus = createReflexBus(cfg, { transport });
    const sleep = mock(async (_ms: number) => {});
    try {
      await expect(startDaemon(cfg, {
        bus, dbPath: join(dir, "reflex.db"), streamStartup: { sleep },
      })).rejects.toThrow(/permission denied/);
      expect(getStreamManager).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      await bus.close();
    }
  });

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
    const deadline = Date.now() + 10_000; // fs.watch latency under parallel load — generous-but-bounded
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
    await expect(startDaemon(cfg, { dbPath: join(dir, "reflex.db"), bus })).rejects.toThrow(/dup/);
    await bus.close();
  });
});

describe("http listener lifecycle", () => {
  it("zero listeners without http blueprints; listener appears via hot-reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-daemon-"));
    const central = join(dir, "activations");
    mkdirSync(central);
    writeFileSync(join(central, "a.yaml"), docFor("sched-only"));
    const cfg = testConfig({ watchRoots: [], activationsDir: central });
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
    const daemon = await startDaemon(cfg, { dbPath: join(dir, "reflex.db"), bus, sweepIntervalMs: 100_000, httpPort: 0 });
    expect(daemon.http.port()).toBeNull(); // no http blueprints → no listener

    process.env.LIFECYCLE_TOKEN = "t";
    writeFileSync(
      join(central, "h.yaml"),
      `schema: metafactory/activation/v1\nactivations:\n  - id: hooky\n    target: "@jc/hooky"\n    when:\n      http:\n        token_env: LIFECYCLE_TOKEN\n`,
    );
    const deadline = Date.now() + 10_000;
    while (daemon.http.port() === null && Date.now() < deadline) await Bun.sleep(30);
    expect(daemon.http.port()).not.toBeNull();
    await daemon.stop();
  });
});
