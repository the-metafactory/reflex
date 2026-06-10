import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTransport, createEnvelope } from "@the-metafactory/myelin";
import { discoverActivationFiles } from "../src/activation/sources";
import { BlueprintStore, loadBlueprintSet } from "../src/activation/store";
import { validatePaths } from "../src/activation/validate-cli";
import { createReflexBus } from "../src/bus";
import { Pipeline } from "../src/pipeline/evaluate";
import { BusSource } from "../src/sources/bus";
import { runOutcomeSubject } from "../src/sources/run-outcome";
import { openDb } from "../src/store/db";
import { Repository } from "../src/store/repository";
import { testConfig } from "./helpers";

const EXAMPLES = join(import.meta.dir, "../examples");
const suiteStart = performance.now();

async function loadExamples() {
  const files = await discoverActivationFiles({ watchRoots: [EXAMPLES], activationsDir: "/nonexistent" });
  return loadBlueprintSet(files);
}

describe("scenario 1: examples are valid by construction (real loader, no fixture fork)", () => {
  it("loads exactly the three blueprints with expected shapes", async () => {
    const blueprints = await loadExamples();
    const byId = new Map(blueprints.map((b) => [b.id, b]));
    expect([...byId.keys()].sort()).toEqual(["f-testing", "pilot-scan", "pr-stats-daily"]);
    expect(byId.get("pr-stats-daily")!.kind).toBe("schedule");
    expect(byId.get("pr-stats-daily")!.guards).toEqual({ cooldownMs: 21_600_000, runLock: "skip" });
    expect(byId.get("pilot-scan")!.policy).toBe("approval");
    expect(byId.get("pilot-scan")!.guards.runLock).toBe("buffer");
    expect(byId.get("f-testing")!.kind).toBe("manual");
  });

  it("reflex validate core passes on examples/", async () => {
    const result = await validatePaths([EXAMPLES]);
    expect(result.ok).toBe(true);
    expect(result.blueprints).toHaveLength(3);
  });
});

describe("end-to-end flows (fake clock + InMemory)", () => {
  it("scenario 2: pr-stats-daily schedule impulse fires at the right target", async () => {
    const { db, close } = openDb(":memory:");
    const repo = new Repository(db);
    const store = new BlueprintStore(await loadExamples());
    const cfg = testConfig();
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
    const fired: string[] = [];
    await bus.subscribe(`local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`, async (e) => {
      fired.push((e.payload as { target: string }).target);
    });
    const pipeline = new Pipeline({ store, repo, bus, nowFn: () => "2026-06-11T07:00:00.000Z" });
    const result = await pipeline.evaluate({
      kind: "schedule",
      blueprintId: "pr-stats-daily",
      payload: { scheduled_for: "2026-06-11T05:00:00.000Z" },
      receivedAt: "2026-06-11T07:00:00.000Z",
      actor: { type: "system", id: "reflex-scheduler" },
    });
    await Bun.sleep(15);
    expect(result.outcome).toBe("fired");
    expect(fired).toEqual(["@jc/f-pr-stats"]);
    await bus.close();
    close();
  });

  it("scenario 3: pilot-scan full lifecycle — match → approve → fire; buffer re-presents", async () => {
    const { db, close } = openDb(":memory:");
    const repo = new Repository(db);
    const store = new BlueprintStore(await loadExamples());
    const cfg = testConfig();
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
    const nowRef = { now: "2026-06-11T10:00:00.000Z" };
    const pipeline = new Pipeline({ store, repo, bus, nowFn: () => nowRef.now });
    const source = new BusSource(cfg, store, bus, pipeline, repo);
    await source.start();
    const SUBJECT = "local.jc.default.tasks.review.completed";
    const publish = async (payload: Record<string, unknown>, type = "tasks.review.completed", corr?: string) => {
      await bus.raw.publish(
        SUBJECT.includes("review") && type.startsWith("pulse") ? runOutcomeSubject(cfg).replace(".>", ".succeeded") : SUBJECT,
        createEnvelope({ source: "jc.tasks.review", type, payload, correlation_id: corr, sovereignty: cfg.sovereignty }),
      );
      await Bun.sleep(20);
    };

    await publish({ flow: "review", pr: 42 });
    const matched = repo.listWaiting();
    expect(matched).toHaveLength(1);

    const resolved = await pipeline.resolveMatched(matched[0]!.decisionId, "approve", { type: "operator", id: "jc" });
    expect(resolved.outcome).toBe("fired");
    if (resolved.outcome !== "fired") throw new Error("unreachable");

    // second match during the in-flight run → Matched again? policy=approval:
    // it parks (approval) — approve it; run lock buffers the firing.
    nowRef.now = "2026-06-11T10:05:00.000Z";
    await publish({ flow: "review", pr: 43 });
    const matched2 = repo.listWaiting();
    expect(matched2).toHaveLength(1);
    const second = await pipeline.resolveMatched(matched2[0]!.decisionId, "approve", { type: "operator", id: "jc" });
    expect(second.outcome).toBe("blocked"); // run lock held → buffered
    expect(repo.getGuardState("pilot-scan")?.bufferedImpulse).toBeTruthy();

    // synthetic run outcome → buffered impulse re-presents and fires
    nowRef.now = "2026-06-11T10:30:00.000Z";
    await publish({ result: "ok" }, "pulse.run.succeeded", resolved.correlationId);
    await Bun.sleep(30);
    expect(repo.historyFor({ blueprintId: "pilot-scan" })[0]!.outcome).toBe("fired");
    await source.stop();
    await bus.close();
    close();
  });

  it("scenario 4: f-testing manual fire is the one-liner story", async () => {
    const { db, close } = openDb(":memory:");
    const repo = new Repository(db);
    const store = new BlueprintStore(await loadExamples());
    const bus = createReflexBus(testConfig(), { transport: createTransport({ type: "memory" }) });
    const pipeline = new Pipeline({ store, repo, bus });
    const result = await pipeline.evaluate({
      kind: "manual",
      blueprintId: "f-testing",
      payload: { suite: "smoke" },
      receivedAt: new Date().toISOString(),
      actor: { type: "operator", id: "jc" },
    });
    expect(result.outcome).toBe("fired");
    expect(repo.historyFor({ blueprintId: "f-testing" })).toHaveLength(1);
    await bus.close();
    close();
  });

  it("NFR-2: example flows complete inside the budget", () => {
    expect(performance.now() - suiteStart).toBeLessThan(10_000);
  });
});

describe("vocabulary gate (examples/)", () => {
  it("Avoid aliases absent from every example file", () => {
    const banned = [/\btrigger\b/i, /\boverlap\b/i, /\bwebhook\b/i, /\bcue\b/i, /\bhook\b/i];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    for (const file of walk(EXAMPLES)) {
      const text = readFileSync(file, "utf-8");
      for (const pattern of banned) {
        expect({ file, pattern: String(pattern), hit: pattern.test(text) }).toEqual({
          file,
          pattern: String(pattern),
          hit: false,
        });
      }
    }
  });
});
