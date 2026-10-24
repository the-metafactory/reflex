import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/load";

const ENV_KEYS = [
  "REFLEX_PRINCIPAL",
  "REFLEX_STACK",
  "REFLEX_NATS_URL",
  "REFLEX_NATS_CREDS",
  "REFLEX_NATS_TIMEOUT_MS",
  "REFLEX_PUBLISH_QUEUE_LIMIT",
] as const;

function cleanEnv(): Record<string, string> {
  const saved: Record<string, string> = {};
  for (const k of ENV_KEYS) {
    if (process.env[k] !== undefined) {
      saved[k] = process.env[k]!;
      delete process.env[k];
    }
  }
  return saved;
}

function writeConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reflex-config-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

// Scrub REFLEX_* before each test (isolation within this file), restore the
// ORIGINAL values after each test — later test files in the same Bun process
// must see the env they started with (sage R-101 cycle-3 finding: exit-time
// restore leaks missing-var state across files).
const saved = cleanEnv();
Object.assign(process.env, saved);
beforeEach(() => {
  cleanEnv();
});
afterEach(() => {
  cleanEnv();
  Object.assign(process.env, saved);
});

describe("loadConfig", () => {
  it("loads from file with defaults applied", () => {
    const file = writeConfigFile("principal: jc\n");
    const cfg = loadConfig({ configPath: file });
    expect(cfg.principal).toBe("jc");
    expect(cfg.stack).toBe("default");
    expect(cfg.nats.url).toBe("nats://127.0.0.1:4222");
    expect(cfg.nats.creds).toContain("/.config/nats/creds/reflex.creds");
    expect(cfg.nats.timeout_ms).toBe(10_000);
    expect(cfg.publishQueueLimit).toBe(1000);
    expect(cfg.sovereignty).toEqual({
      classification: "local",
      data_residency: "CH",
      max_hop: 0,
      frontier_ok: false,
      model_class: "any",
    });
  });

  it("loads from env only when file is absent", () => {
    process.env.REFLEX_PRINCIPAL = "jc";
    process.env.REFLEX_NATS_URL = "nats://127.0.0.1:5333";
    const cfg = loadConfig({ configPath: "/nonexistent/reflex-config.yaml" });
    expect(cfg.principal).toBe("jc");
    expect(cfg.nats.url).toBe("nats://127.0.0.1:5333");
  });

  it("loads the JetStream timeout from YAML and allows an env override", () => {
    const file = writeConfigFile("principal: jc\nnats:\n  timeout_ms: 25000\n");
    expect(loadConfig({ configPath: file }).nats.timeout_ms).toBe(25_000);
    process.env.REFLEX_NATS_TIMEOUT_MS = "30000";
    expect(loadConfig({ configPath: file }).nats.timeout_ms).toBe(30_000);
  });

  it("rejects invalid JetStream timeouts before startup", () => {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "2147483648", "slow"]) {
      const file = writeConfigFile(`principal: jc\nnats:\n  timeout_ms: ${value}\n`);
      expect(() => loadConfig({ configPath: file })).toThrow(/nats.timeout_ms/);
    }
    const file = writeConfigFile("principal: jc\n");
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "2147483648", "slow"]) {
      expect(() => loadConfig({ configPath: file, env: { REFLEX_NATS_TIMEOUT_MS: value } })).toThrow(/nats.timeout_ms/);
    }
  });

  it("env overrides file", () => {
    const file = writeConfigFile("principal: filer\nnats:\n  url: nats://127.0.0.1:1111\n");
    process.env.REFLEX_PRINCIPAL = "enver";
    const cfg = loadConfig({ configPath: file });
    expect(cfg.principal).toBe("enver");
    expect(cfg.nats.url).toBe("nats://127.0.0.1:1111");
  });

  it("rejects invalid values naming the field", () => {
    const file = writeConfigFile("principal: jc\npublish_queue_limit: -5\n");
    expect(() => loadConfig({ configPath: file })).toThrow(/publish_queue_limit/);
  });

  it("rejects when principal is missing everywhere", () => {
    const file = writeConfigFile("stack: default\n");
    expect(() => loadConfig({ configPath: file })).toThrow(/principal/);
  });

  it("rejects malformed YAML naming the file", () => {
    const file = writeConfigFile("principal: [unclosed\n");
    expect(() => loadConfig({ configPath: file })).toThrow(new RegExp(file.replace(/[/.]/g, "\\$&")));
  });

  it("parses queue limit from env as number", () => {
    const file = writeConfigFile("principal: jc\n");
    process.env.REFLEX_PUBLISH_QUEUE_LIMIT = "50";
    const cfg = loadConfig({ configPath: file });
    expect(cfg.publishQueueLimit).toBe(50);
  });

  it("rejects principal/stack containing subject metacharacters", () => {
    for (const bad of ["jc.evil", "j*", "j>", "a b"]) {
      const file = writeConfigFile(`principal: "${bad}"\n`);
      expect(() => loadConfig({ configPath: file })).toThrow(/principal must be a single NATS subject token/);
    }
    const stackFile = writeConfigFile('principal: jc\nstack: "bad.stack"\n');
    expect(() => loadConfig({ configPath: stackFile })).toThrow(/stack must be a single NATS subject token/);
  });

  it("rejects non-numeric queue limit env naming the raw value", () => {
    const file = writeConfigFile("principal: jc\n");
    process.env.REFLEX_PUBLISH_QUEUE_LIMIT = "abc";
    expect(() => loadConfig({ configPath: file })).toThrow(/Invalid REFLEX_PUBLISH_QUEUE_LIMIT: "abc"/);
  });
});

describe("nats.insecure", () => {
  it("defaults false; env flag parses (env restored)", () => {
    const file = writeConfigFile("principal: jc\n");
    expect(loadConfig({ configPath: file }).nats.insecure).toBe(false);
    const previous = process.env.REFLEX_NATS_INSECURE;
    try {
      process.env.REFLEX_NATS_INSECURE = "1";
      expect(loadConfig({ configPath: file }).nats.insecure).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.REFLEX_NATS_INSECURE;
      else process.env.REFLEX_NATS_INSECURE = previous;
    }
  });
});
