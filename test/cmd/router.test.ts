import { describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import { BlueprintStore } from "../../src/activation/store";
import { createReflexBus } from "../../src/bus";
import { reflexSource } from "../../src/bus/envelopes";
import { CMD_REQUEST_TYPE, cmdSubject } from "../../src/cmd/protocol";
import { CommandRouter } from "../../src/cmd/router";
import { CommandHandlers } from "../../src/handlers/commands";
import { Pipeline } from "../../src/pipeline/evaluate";
import { ScheduleSource } from "../../src/sources/schedule";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const cfg = testConfig();

async function rig() {
  const { db, close } = openDb(":memory:");
  const repo = new Repository(db);
  const store = new BlueprintStore([]);
  const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
  const pipeline = new Pipeline({ store, repo, bus });
  const handlers = new CommandHandlers(store, pipeline, repo);
  const schedule = new ScheduleSource(store, pipeline);
  const router = new CommandRouter({ cfg, bus, handlers, pipeline, repo, store, schedule, daemonVersion: "t", startedAt: "now" });
  await router.start();
  return { bus, close: async () => { await bus.close(); close(); } };
}

function request(bus: Awaited<ReturnType<typeof rig>>["bus"], payload: Record<string, unknown>) {
  return bus.request(
    { source: reflexSource(cfg), type: CMD_REQUEST_TYPE, payload, timeoutMs: 1000 },
    cmdSubject(cfg, "waiting"),
  );
}

describe("router protocol gates", () => {
  it("rejects missing/newer protocol versions — never executes", async () => {
    const { bus, close } = await rig();
    for (const payload of [{ args: {}, actor: { type: "operator", id: "jc" } }, { v: 2, args: {}, actor: { type: "operator", id: "jc" } }]) {
      const reply = await request(bus, payload);
      const response = reply.payload as { ok: boolean; error?: { code: string } };
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("protocol-version");
    }
    await close();
  });

  it("rejects malformed actors (shape-validated claimed identity)", async () => {
    const { bus, close } = await rig();
    for (const actor of [undefined, "jc", { type: "root", id: "jc" }, { type: "operator", id: "" }, { type: "operator", id: "x".repeat(200) }]) {
      const reply = await request(bus, { v: 1, args: {}, actor });
      const response = reply.payload as { ok: boolean; error?: { code: string } };
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("invalid-input");
    }
    await close();
  });

  it("valid v1 request with valid actor executes", async () => {
    const { bus, close } = await rig();
    const reply = await request(bus, { v: 1, args: {}, actor: { type: "operator", id: "jc" } });
    const response = reply.payload as { ok: boolean; data: unknown[] };
    expect(response.ok).toBe(true);
    expect(response.data).toEqual([]);
    await close();
  });
});
