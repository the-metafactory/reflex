import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlueprintStore, loadBlueprintSet } from "../../src/activation/store";
import { discoverActivationFiles } from "../../src/activation/sources";
import { ActivationWatcher } from "../../src/activation/watcher";

function docFor(id: string, cron = "0 7 * * *"): string {
  return `schema: metafactory/activation/v1\nactivations:\n  - id: ${id}\n    target: "@jc/${id}"\n    when:\n      schedule: "${cron}"\n`;
}

async function setup() {
  const central = mkdtempSync(join(tmpdir(), "reflex-watch-"));
  writeFileSync(join(central, "a.yaml"), docFor("aa"));
  const opts = { watchRoots: [] as string[], activationsDir: central };
  const store = new BlueprintStore(await loadBlueprintSet(await discoverActivationFiles(opts)));
  const watcher = new ActivationWatcher(store, opts, { debounceMs: 50 });
  await watcher.start();
  return { central, store, watcher };
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(25);
}

describe("ActivationWatcher", () => {
  it("reloads on file change", async () => {
    const { central, store, watcher } = await setup();
    writeFileSync(join(central, "a.yaml"), docFor("aa", "0 9 * * *"));
    await until(() => {
      const bp = store.get("aa");
      return bp !== undefined && "schedule" in bp.when && bp.when.schedule === "0 9 * * *";
    });
    const bp = store.get("aa")!;
    expect("schedule" in bp.when && bp.when.schedule).toBe("0 9 * * *");
    await watcher.stop();
  });

  it("keeps the last good set when an invalid file is written", async () => {
    const { central, store, watcher } = await setup();
    const before = store.current();
    writeFileSync(join(central, "a.yaml"), "schema: wrong\nactivations: [");
    await Bun.sleep(400); // give the watcher a chance to (not) break things
    expect(store.current()).toBe(before); // identity: untouched
    expect(watcher.lastError()).toContain("a.yaml");
    await watcher.stop();
  });

  it("debounces rapid writes into one reload", async () => {
    const { central, store, watcher } = await setup();
    let reloads = 0;
    watcher.onReload(() => {
      reloads += 1;
    });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(central, "a.yaml"), docFor("aa", `${i} 9 * * *`));
    }
    await until(() => reloads >= 1);
    await Bun.sleep(300);
    expect(reloads).toBe(1);
    await watcher.stop();
  });

  it("picks up new files and removals", async () => {
    const { central, store, watcher } = await setup();
    writeFileSync(join(central, "b.yaml"), docFor("bb"));
    await until(() => store.get("bb") !== undefined);
    expect(store.get("bb")).toBeDefined();

    const removed: string[][] = [];
    store.onBlueprintsRemoved((ids) => removed.push(ids));
    rmSync(join(central, "b.yaml"));
    await until(() => store.get("bb") === undefined);
    expect(store.get("bb")).toBeUndefined();
    expect(store.get("aa")).toBeDefined();
    expect(removed).toEqual([["bb"]]);
    await watcher.stop();
  });
});

describe("rescan disable", () => {
  it("rescanIntervalMs: 0 disables the safety net (no busy loop)", async () => {
    const central = mkdtempSync(join(tmpdir(), "reflex-watch-"));
    writeFileSync(join(central, "a.yaml"), docFor("aa"));
    const opts = { watchRoots: [] as string[], activationsDir: central };
    const store = new BlueprintStore(await loadBlueprintSet(await discoverActivationFiles(opts)));
    const watcher = new ActivationWatcher(store, opts, { debounceMs: 50, rescanIntervalMs: 0 });
    let reloads = 0;
    watcher.onReload(() => { reloads += 1; });
    await watcher.start();
    await Bun.sleep(150); // a zero-delay interval would have fired many times
    expect(reloads).toBe(0);
    await watcher.stop();
  });
});
