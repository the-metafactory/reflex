import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { configSchema, type ReflexConfig } from "./schema";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config/reflex/config.yaml");

export interface LoadOptions {
  /** Wins over `REFLEX_CONFIG`; default `DEFAULT_CONFIG_PATH`. */
  configPath?: string;
  env?: Record<string, string | undefined>;
}

/** Expand a leading `~/` to the home directory; other paths pass through. */
function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Config file: explicit option, else `REFLEX_CONFIG` (empty = unset, like
 * the other REFLEX_* vars), else the default path. A `REFLEX_CONFIG` naming
 * a missing file throws — a typo must not start an instance on env-only
 * config, i.e. on the default instance's stack (reflex#36).
 */
export function resolveConfigPath(options: LoadOptions, env: Record<string, string | undefined>): string {
  if (options.configPath !== undefined) return options.configPath;
  const fromEnv = env.REFLEX_CONFIG;
  if (fromEnv === undefined || fromEnv === "") return DEFAULT_CONFIG_PATH;
  if (!existsSync(fromEnv)) {
    throw new Error(`REFLEX_CONFIG names a config file that does not exist: ${fromEnv}`);
  }
  return fromEnv;
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
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(options, env);

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
    ...(parsed.state_dir !== undefined ? { stateDir: expandHome(parsed.state_dir) } : {}),
  };
}
