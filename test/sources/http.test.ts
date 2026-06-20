import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import { BlueprintStore } from "../../src/activation/store";
import type { ActivationBlueprint } from "../../src/activation/types";
import { createReflexBus } from "../../src/bus";
import { Pipeline } from "../../src/pipeline/evaluate";
import { HttpSource } from "../../src/sources/http";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";
import { testConfig } from "../helpers";

const TOKEN = "test-token-abc";
process.env.HTTP_TEST_TOKEN = TOKEN;

function httpBp(id: string, overrides: Partial<ActivationBlueprint> = {}): ActivationBlueprint {
  return {
    id,
    target: `@jc/${id}`,
    kind: "http",
    when: { http: { token_env: "HTTP_TEST_TOKEN" } },
    policy: "auto",
    approvalTimeoutMs: 3_600_000,
    guards: {},
    payload: {},
    sourceFile: "/tmp/x.yaml",
    ...overrides,
  };
}

let source: HttpSource;
let store: BlueprintStore;
let repo: Repository;
let base: string;
let cleanup: () => Promise<void>;

beforeAll(() => {
  const { db, close } = openDb(":memory:");
  repo = new Repository(db);
  store = new BlueprintStore([
    httpBp("gh-ping"),
    httpBp("gated", { guards: { cooldownMs: 6 * 3_600_000 } }),
    httpBp("tight", { }),
    httpBp("bulk"),
    httpBp("bytes"),
    httpBp("broken", { when: { http: { token_env: "DEFINITELY_UNSET_ENV" } } }),
    httpBp("authbearer", { when: { http: { auth: { mode: "bearer", secret_env: "HTTP_TEST_TOKEN" } } } }),
    httpBp("ghhmac", { when: { http: { auth: { mode: "github_hmac", secret_env: "HTTP_TEST_TOKEN" } } } }),
    httpBp("filtered", { when: { http: { token_env: "HTTP_TEST_TOKEN", where: { action: "opened" } } } }),
  ]);
  const bus = createReflexBus(testConfig(), { transport: createTransport({ type: "memory" }) });
  const pipeline = new Pipeline({ store, repo, bus });
  source = new HttpSource(store, pipeline, { port: 0, rateLimitPerMinute: 3 });
  source.start();
  base = `http://127.0.0.1:${source.port()}`;
  cleanup = async () => {
    await source.stop();
    await bus.close();
    close();
  };
});

afterAll(async () => {
  await cleanup();
});

function call(path: string, init: RequestInit = {}, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { method: "POST", body: "{}", ...init, headers });
}

describe("response-code matrix", () => {
  it("202 with pipeline verdict on valid call", async () => {
    const r = await call("/impulse/gh-ping", { body: '{"ref":"main"}' });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { outcome: string; decision_id: string };
    expect(body.outcome).toBe("fired");
    expect(body.decision_id).toBeDefined();
    const row = repo.historyFor({ blueprintId: "gh-ping" })[0]!;
    expect(row.impulse.kind).toBe("http");
    expect(row.impulse.payload).toEqual({ ref: "main" });
  });

  it("401 without token; 401 with wrong token", async () => {
    expect((await call("/impulse/gh-ping", {}, null)).status).toBe(401);
    expect((await call("/impulse/gh-ping", {}, "wrong")).status).toBe(401);
  });

  it("auth precedes existence: unknown id is 401 without a token — indistinguishable", async () => {
    expect((await call("/impulse/nope", {}, null)).status).toBe(401);
    expect((await call("/impulse/nope", {}, "anything")).status).toBe(401); // no token to validate against → still 401
  });

  it("405 non-POST; 404 unknown path shape", async () => {
    expect((await fetch(`${base}/impulse/gh-ping`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await call("/other/route")).status).toBe(404);
  });

  it("415 wrong content type; 422 bad JSON; 413 oversize", async () => {
    expect((await call("/impulse/bulk", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call("/impulse/bulk", { body: "{nope" })).status).toBe(422);
    // NOTE: rate limiting precedes content checks by design — use a fresh
    // bucket (dedicated blueprint) so the matrix tests don't starve it.
    expect((await call("/impulse/bulk", { body: JSON.stringify({ x: "y".repeat(300 * 1024) }) })).status).toBe(413);
  });

  it("503 for a route whose token_env is unset", async () => {
    const r = await call("/impulse/broken", {}, "anything");
    expect(r.status).toBe(503);
  });

  it("auth: { mode: bearer } resolves the secret like token_env (202)", async () => {
    expect((await call("/impulse/authbearer")).status).toBe(202);
  });

  it("github_hmac is edge-only on the local source → 501 (only after valid auth)", async () => {
    // Valid Bearer token presented, but the blueprint requests github_hmac.
    expect((await call("/impulse/ghhmac")).status).toBe(501);
  });

  it("edge-only 501 stays behind auth: unauthenticated github_hmac route → 401, not 501", async () => {
    expect((await call("/impulse/ghhmac", {}, null)).status).toBe(401);
  });

  it("where filtering is edge-only on the local source → 501", async () => {
    expect((await call("/impulse/filtered")).status).toBe(501);
  });

  it("202 carries an honest blocked verdict (cooldown)", async () => {
    const first = await call("/impulse/gated");
    expect(first.status).toBe(202);
    const second = await call("/impulse/gated", { body: '{"n":2}' });
    expect(second.status).toBe(202);
    const body = (await second.json()) as { outcome: string; reason: string };
    expect(body.outcome).toBe("blocked");
    expect(body.reason).toBe("cooldown");
  });

  it("429 beyond the rate limit with Retry-After", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) {
      last = await call("/impulse/tight", { body: JSON.stringify({ i }) });
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("token never logged", () => {
  it("console output during an authenticated call does not contain the token", async () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      await call("/impulse/gh-ping", { body: '{"log":"check"}' });
    } finally {
      console.info = original;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("constant-time compare", () => {
  it("implementation uses timingSafeEqual (grep gate)", async () => {
    const text = await Bun.file(new URL("../../src/sources/http.ts", import.meta.url).pathname).text();
    expect(text).toContain("timingSafeEqual");
    expect(text).not.toMatch(/presented\s*===\s*expected/);
  });
});

describe("byte-enforced body cap", () => {
  it("multi-byte chars count as BYTES: a body under the char limit but over the byte limit is 413", async () => {
    // 100k '€' chars = 300KB utf-8 — char count (100k) is under 256K, bytes are not.
    const euros = "€".repeat(100 * 1024);
    const r = await call("/impulse/bytes", { body: JSON.stringify({ x: euros }) });
    expect(r.status).toBe(413);
  });
});
