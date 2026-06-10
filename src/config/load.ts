import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { configSchema, type ReflexConfig } from "./schema";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config/reflex/config.yaml");

export interface LoadOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
}

/** Deep-set a dotted path on a plain object (small, local — no library). */
function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

const ENV_MAP: Array<{ env: string; path: string[]; parse?: (raw: string) => unknown }> = [
  { env: "REFLEX_PRINCIPAL", path: ["principal"] },
  { env: "REFLEX_STACK", path: ["stack"] },
  { env: "REFLEX_NATS_URL", path: ["nats", "url"] },
  { env: "REFLEX_NATS_CREDS", path: ["nats", "creds"] },
  { env: "REFLEX_NATS_INSECURE", path: ["nats", "insecure"], parse: (raw) => raw === "1" || raw === "true" },
  {
    env: "REFLEX_PUBLISH_QUEUE_LIMIT",
    path: ["publish_queue_limit"],
    parse: (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid REFLEX_PUBLISH_QUEUE_LIMIT: "${raw}" — expected a number`);
      }
      return n;
    },
  },
];

/**
 * Load daemon config: YAML file (when present) overlaid with REFLEX_* env
 * vars (env wins), then schema-validated. Missing file with complete env
 * is valid; validation errors name the offending field.
 */
export function loadConfig(options: LoadOptions = {}): ReflexConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const env = options.env ?? process.env;

  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, "utf-8");
    try {
      raw = (parse(text) ?? {}) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to parse config file ${configPath}: ${(error as Error).message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Config file ${configPath} must contain a YAML mapping`);
    }
  }

  for (const { env: key, path, parse: parseRaw } of ENV_MAP) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      setPath(raw, path, parseRaw ? parseRaw(value) : value);
    }
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid reflex config (${configPath}): ${detail}`);
  }

  const parsed = result.data;
  return {
    principal: parsed.principal,
    stack: parsed.stack,
    nats: parsed.nats,
    publishQueueLimit: parsed.publish_queue_limit,
    sovereignty: parsed.sovereignty,
    watchRoots: parsed.watch_roots,
    activationsDir: parsed.activations_dir,
  };
}
