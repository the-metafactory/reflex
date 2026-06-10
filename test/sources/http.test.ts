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
    httpBp("broken", { when: { http: { token_env: "DEFINITELY_UNSET_ENV" } } }),
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
    const r = await call("/hook/gh-ping", { body: '{"ref":"main"}' });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { outcome: string; decision_id: string };
    expect(body.outcome).toBe("fired");
    expect(body.decision_id).toBeDefined();
    const row = repo.historyFor({ blueprintId: "gh-ping" })[0]!;
    expect(row.impulse.kind).toBe("http");
    expect(row.impulse.payload).toEqual({ ref: "main" });
  });

  it("401 without token; 401 with wrong token", async () => {
    expect((await call("/hook/gh-ping", {}, null)).status).toBe(401);
    expect((await call("/hook/gh-ping", {}, "wrong")).status).toBe(401);
  });

  it("auth precedes existence: unknown id is 401 without a token — indistinguishable", async () => {
    expect((await call("/hook/nope", {}, null)).status).toBe(401);
    expect((await call("/hook/nope", {}, "anything")).status).toBe(401); // no token to validate against → still 401
  });

  it("405 non-POST; 404 unknown path shape", async () => {
    expect((await fetch(`${base}/hook/gh-ping`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await call("/other/route")).status).toBe(404);
  });

  it("415 wrong content type; 422 bad JSON; 413 oversize", async () => {
    expect((await call("/hook/bulk", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call("/hook/bulk", { body: "{nope" })).status).toBe(422);
    // NOTE: rate limiting precedes content checks by design — use a fresh
    // bucket (dedicated blueprint) so the matrix tests don't starve it.
    expect((await call("/hook/bulk", { body: JSON.stringify({ x: "y".repeat(300 * 1024) }) })).status).toBe(413);
  });

  it("503 for a route whose token_env is unset", async () => {
    const r = await call("/hook/broken", {}, "anything");
    expect(r.status).toBe(503);
  });

  it("202 carries an honest blocked verdict (cooldown)", async () => {
    const first = await call("/hook/gated");
    expect(first.status).toBe(202);
    const second = await call("/hook/gated", { body: '{"n":2}' });
    expect(second.status).toBe(202);
    const body = (await second.json()) as { outcome: string; reason: string };
    expect(body.outcome).toBe("blocked");
    expect(body.reason).toBe("cooldown");
  });

  it("429 beyond the rate limit with Retry-After", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) {
      last = await call("/hook/tight", { body: JSON.stringify({ i }) });
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
      await call("/hook/gh-ping", { body: '{"log":"check"}' });
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
