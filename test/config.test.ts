import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/load";

const ENV_KEYS = [
  "REFLEX_PRINCIPAL",
  "REFLEX_STACK",
  "REFLEX_NATS_URL",
  "REFLEX_NATS_CREDS",
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

const saved = cleanEnv();
afterEach(() => {
  cleanEnv();
});
process.on("exit", () => {
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
});
