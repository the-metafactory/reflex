import { describe, expect, it } from "bun:test";
import type { KVNamespace } from "@cloudflare/workers-types";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { CronSource } from "../../src/edge/cron";
import { EdgeHttpSource } from "../../src/edge/http";
import { loadBlueprintsFromKV } from "../../src/edge/kv-blueprints";
import type { EvaluateResult, Impulse } from "../../src/pipeline/impulse";

function bp(overrides: Partial<ActivationBlueprint>): ActivationBlueprint {
  return {
    id: "bp",
    target: "@jc/x",
    kind: "http",
    when: { http: { token_env: "TOK" } },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: {},
    sourceFile: "kv:test",
    ...overrides,
  };
}

function sink(outcome: EvaluateResult = { outcome: "fired", decisionId: "d1", correlationId: "c1" }) {
  const seen: Impulse[] = [];
  return {
    seen,
    evaluate: async (impulse: Impulse) => {
      seen.push(impulse);
      return outcome;
    },
  };
}

function post(path: string, init: RequestInit = {}): Request {
  return new Request(`https://reflex.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body ?? "{}",
    ...init,
  });
}

describe("EdgeHttpSource", () => {
  const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };

  it("auth precedes existence: unknown blueprint without token is 401, never 404", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([]), sink(), { TOK: "s3cret" });
    const response = await source.handle(post("/impulse/ghost"));
    expect(response.status).toBe(401);
  });

  it("202 carries the honest pipeline verdict", async () => {
    const s = sink();
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), s, { TOK: "s3cret" });
    const response = await source.handle(post("/impulse/bp", { headers: auth, body: JSON.stringify({ n: 1 }) }));
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("fired");
    expect(body.decision_id).toBe("d1");
    expect(s.seen[0]!.kind).toBe("http");
    expect(s.seen[0]!.payload).toEqual({ n: 1 });
  });

  it("token comes from the secret BINDING named by token_env", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), { TOK: "other" });
    const response = await source.handle(post("/impulse/bp", { headers: auth }));
    expect(response.status).toBe(401);
  });

  it("unset secret binding disables the route with 503", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), {});
    const response = await source.handle(post("/impulse/bp", { headers: auth }));
    expect(response.status).toBe(503);
  });

  it("rejects non-JSON-object bodies with 422", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), { TOK: "s3cret" });
    const response = await source.handle(post("/impulse/bp", { headers: auth, body: "[1,2]" }));
    expect(response.status).toBe(422);
  });

  it("rejects oversize declared bodies with 413", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), { TOK: "s3cret" });
    const response = await source.handle(
      post("/impulse/bp", { headers: { ...auth, "content-length": String(512 * 1024) } }),
    );
    expect(response.status).toBe(413);
  });

  it("rate limits per blueprint with retry-after", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), { TOK: "s3cret" }, { rateLimitPerMinute: 2 });
    expect((await source.handle(post("/impulse/bp", { headers: auth }))).status).toBe(202);
    expect((await source.handle(post("/impulse/bp", { headers: auth }))).status).toBe(202);
    const limited = await source.handle(post("/impulse/bp", { headers: auth }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

describe("CronSource", () => {
  const schedBp = (id: string, schedule: string): ActivationBlueprint =>
    bp({ id, kind: "schedule", when: { schedule } });

  it("evaluates only blueprints whose expression matches the fired cron", async () => {
    const s = sink();
    const store = new BlueprintStore([schedBp("daily", "0 7 * * *"), schedBp("hourly", "0 * * * *")]);
    const source = new CronSource(store, s);
    const results = await source.onScheduled({ cron: "0 7 * * *", scheduledTime: Date.parse("2026-06-11T07:00:00Z") });
    expect(results.length).toBe(1);
    expect(s.seen[0]!.blueprintId).toBe("daily");
    expect(s.seen[0]!.kind).toBe("schedule");
    expect(s.seen[0]!.payload.scheduled_for).toBe("2026-06-11T07:00:00.000Z");
  });

  it("no matching expression → zero evaluations", async () => {
    const s = sink();
    const source = new CronSource(new BlueprintStore([schedBp("daily", "0 7 * * *")]), s);
    const results = await source.onScheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() });
    expect(results.length).toBe(0);
    expect(s.seen.length).toBe(0);
  });

  it("reports blueprint expressions missing from the wrangler-declared cron list", () => {
    const store = new BlueprintStore([schedBp("daily", "0 7 * * *"), schedBp("hourly", "0 * * * *")]);
    const source = new CronSource(store, sink());
    expect(source.unmatchedExpressions(["0 7 * * *"])).toEqual(["0 * * * *"]);
    expect(source.unmatchedExpressions(["0 7 * * *", "0 * * * *"])).toEqual([]);
  });
});

describe("loadBlueprintsFromKV", () => {
  const DOC = `schema: metafactory/activation/v1
activations:
  - id: pr-stats-daily
    target: "@jc/f-pr-stats"
    when:
      schedule: "0 7 * * *"
    policy: auto
`;

  function mockKV(entries: Record<string, string>, pageSize = 2): KVNamespace {
    const names = Object.keys(entries);
    return {
      async list({ prefix, cursor }: { prefix?: string; cursor?: string }) {
        const filtered = names.filter((n) => n.startsWith(prefix ?? ""));
        const start = cursor ? Number(cursor) : 0;
        const page = filtered.slice(start, start + pageSize);
        const done = start + pageSize >= filtered.length;
        return {
          keys: page.map((name) => ({ name })),
          list_complete: done,
          ...(done ? {} : { cursor: String(start + pageSize) }),
        };
      },
      async get(key: string) {
        return entries[key] ?? null;
      },
    } as unknown as KVNamespace;
  }

  it("loads and merges documents across paginated keys", async () => {
    const second = DOC.replace("pr-stats-daily", "pr-stats-2").replace("0 7", "0 8");
    const third = DOC.replace("pr-stats-daily", "pr-stats-3").replace("0 7", "0 9");
    const kv = mockKV({
      "activation/a.yaml": DOC,
      "activation/b.yaml": second,
      "activation/c.yaml": third,
      "other/ignored.yaml": DOC,
    });
    const blueprints = await loadBlueprintsFromKV(kv);
    expect(blueprints.map((b) => b.id).sort()).toEqual(["pr-stats-2", "pr-stats-3", "pr-stats-daily"]);
    expect(blueprints[0]!.sourceFile.startsWith("kv:")).toBe(true);
  });

  it("duplicate ids across keys throw naming both KV keys", async () => {
    const kv = mockKV({ "activation/a.yaml": DOC, "activation/b.yaml": DOC });
    await expect(loadBlueprintsFromKV(kv)).rejects.toThrow(/kv:activation\/a\.yaml.*kv:activation\/b\.yaml|defined in both/);
  });
});
