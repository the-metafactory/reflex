import { describe, expect, it } from "bun:test";
import type { KVNamespace } from "@cloudflare/workers-types";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { EdgeHttpSource, bytesToHex } from "../../src/edge/http";
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

  it("unset secret binding is indistinguishable from missing blueprint (401, not 503)", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), {});
    const response = await source.handle(post("/impulse/bp", { headers: auth }));
    expect(response.status).toBe(401);
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

// Schedule evaluation moved off Cloudflare Cron Triggers (F-002): the
// EdgeScheduleSource string-match path is gone — schedule firing is now the
// pure Scheduler.tick core (see test/scheduler/core.test.ts) driven by the
// DO-alarm heartbeat (see test/edge/heartbeat.test.ts).

describe("EdgeHttpSource — github_hmac (F-003)", () => {
  const SECRET = "topsecret-webhook";
  const ghBp = (where?: Record<string, string | number | boolean>): ActivationBlueprint =>
    bp({ id: "gh", kind: "http", when: { http: { auth: { mode: "github_hmac", secret_env: "GH" }, ...(where ? { where } : {}) } } });

  async function sign(secret: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return "sha256=" + bytesToHex(new Uint8Array(sig));
  }

  function ghPost(body: string, headers: Record<string, string>): Request {
    return new Request("https://reflex.example/impulse/gh", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  const PR_BODY = JSON.stringify({ action: "opened", number: 7, repository: { full_name: "the-metafactory/reflex" } });

  it("valid signature + matching where → fires, with injected top-level fields", async () => {
    const s = sink();
    const source = new EdgeHttpSource(new BlueprintStore([ghBp({ github_event: "pull_request", action: "opened" })]), s, { GH: SECRET });
    const sig = await sign(SECRET, PR_BODY);
    const res = await source.handle(ghPost(PR_BODY, { "x-hub-signature-256": sig, "x-github-event": "pull_request", "x-github-delivery": "d-1" }));
    expect(res.status).toBe(202);
    expect((await res.json() as Record<string, unknown>).outcome).toBe("fired");
    expect(s.seen[0]!.payload.github_event).toBe("pull_request");
    expect(s.seen[0]!.payload.repository).toBe("the-metafactory/reflex");
    expect(s.seen[0]!.payload.github_delivery).toBe("d-1");
    expect(s.seen[0]!.payload.action).toBe("opened"); // full payload preserved
  });

  it("tampered body (signature over different bytes) → 401", async () => {
    const s = sink();
    const source = new EdgeHttpSource(new BlueprintStore([ghBp()]), s, { GH: SECRET });
    const sig = await sign(SECRET, PR_BODY);
    const res = await source.handle(ghPost(JSON.stringify({ action: "closed" }), { "x-hub-signature-256": sig, "x-github-event": "pull_request" }));
    expect(res.status).toBe(401);
    expect(s.seen).toHaveLength(0);
  });

  it("missing signature header → 401", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([ghBp()]), sink(), { GH: SECRET });
    expect((await source.handle(ghPost(PR_BODY, { "x-github-event": "pull_request" }))).status).toBe(401);
  });

  it("wrong secret → 401", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([ghBp()]), sink(), { GH: SECRET });
    const sig = await sign("not-the-secret", PR_BODY);
    expect((await source.handle(ghPost(PR_BODY, { "x-hub-signature-256": sig, "x-github-event": "pull_request" }))).status).toBe(401);
  });

  it("unset secret binding → 401 (route disabled)", async () => {
    const source = new EdgeHttpSource(new BlueprintStore([ghBp()]), sink(), {});
    const sig = await sign(SECRET, PR_BODY);
    expect((await source.handle(ghPost(PR_BODY, { "x-hub-signature-256": sig, "x-github-event": "pull_request" }))).status).toBe(401);
  });

  it("auth precedes body-shape: bad bearer token with non-JSON body → 401, not 415 (R-109 FR-6)", async () => {
    // Bearer blueprint; wrong token + wrong content-type. Must be 401 (auth
    // first), never 415 — and the body is never read for a rejected caller.
    const source = new EdgeHttpSource(new BlueprintStore([bp({})]), sink(), { TOK: "s3cret" });
    const req = new Request("https://reflex.example/impulse/bp", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "text/plain" },
      body: "not json",
    });
    expect((await source.handle(req)).status).toBe(401);
  });

  it("where filter: non-matching event → 202 ignored, not fired", async () => {
    const s = sink();
    const source = new EdgeHttpSource(new BlueprintStore([ghBp({ github_event: "pull_request", action: "opened" })]), s, { GH: SECRET });
    const issueBody = JSON.stringify({ action: "opened", repository: { full_name: "the-metafactory/reflex" } });
    const sig = await sign(SECRET, issueBody);
    const res = await source.handle(ghPost(issueBody, { "x-hub-signature-256": sig, "x-github-event": "issues", "x-github-delivery": "d-2" }));
    expect(res.status).toBe(202);
    expect((await res.json() as Record<string, unknown>).outcome).toBe("ignored");
    expect(s.seen).toHaveLength(0);
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

describe("worker public allowlist (sage reflex#16 blocker)", () => {
  function workerEnv() {
    const forwarded: Request[] = [];
    const stub = { fetch: async (req: Request) => { forwarded.push(req as Request); return new Response("ok"); } };
    const env = {
      REFLEX_CONSUMER: { idFromName: () => "id", get: () => stub },
    } as never;
    return { env, forwarded };
  }

  it("public /schedule and /status are 404 at the Worker — never forwarded to the DO", async () => {
    const { default: worker } = await import("../../src/edge/worker");
    const { env, forwarded } = workerEnv();
    for (const path of ["/schedule", "/status", "/cron"]) {
      const response = await worker.fetch(new Request(`https://edge.example${path}`, { method: "POST" }), env);
      expect(response.status).toBe(404);
    }
    expect(forwarded.length).toBe(0);
  });

  it("/impulse/* is forwarded", async () => {
    const { default: worker } = await import("../../src/edge/worker");
    const { env, forwarded } = workerEnv();
    const response = await worker.fetch(new Request("https://edge.example/impulse/bp", { method: "POST" }), env);
    expect(response.status).toBe(200);
    expect(forwarded.length).toBe(1);
  });
});
