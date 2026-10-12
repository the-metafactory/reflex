import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus } from "../../src/bus";
import { runCommand } from "../../src/cli/main";
import { DEFAULT_CONFIG_PATH, loadConfig, resolveConfigPath } from "../../src/config/load";
import { startDaemon } from "../../src/daemon";
import { dbPathFor, defaultDbPath } from "../../src/store/paths";
import { testConfig } from "../helpers";

// reflex#36: a second instance on one machine gets its own config file
// (REFLEX_CONFIG) and its own DB (state_dir).

function writeConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reflex-instance-"));
  const path = join(dir, "personal.yaml");
  writeFileSync(path, content);
  return path;
}

describe("REFLEX_CONFIG", () => {
  it("is read when no configPath option is given", () => {
    const file = writeConfigFile("principal: jc\nstack: personal\n");
    const cfg = loadConfig({ env: { REFLEX_CONFIG: file } });
    expect(cfg.stack).toBe("personal");
  });

  it("loses to an explicit configPath option", () => {
    const envFile = writeConfigFile("principal: jc\nstack: fromenv\n");
    const optFile = writeConfigFile("principal: jc\nstack: fromopt\n");
    const cfg = loadConfig({ configPath: optFile, env: { REFLEX_CONFIG: envFile } });
    expect(cfg.stack).toBe("fromopt");
  });

  it("unset or empty resolves to the default config path", () => {
    expect(resolveConfigPath({}, {})).toBe(DEFAULT_CONFIG_PATH);
    expect(resolveConfigPath({}, { REFLEX_CONFIG: "" })).toBe(DEFAULT_CONFIG_PATH);
    expect(DEFAULT_CONFIG_PATH).toBe(join(homedir(), ".config/reflex/config.yaml"));
  });

  it("expands a literal leading ~/ (service units do not)", () => {
    const missing = "~/reflex-no-such-dir/personal.yaml";
    expect(() => resolveConfigPath({}, { REFLEX_CONFIG: missing })).toThrow(
      join(homedir(), "reflex-no-such-dir/personal.yaml"),
    );
  });

  it("naming a missing file throws naming the path — no env-only fallback", () => {
    const missing = join(tmpdir(), "reflex-no-such-dir", "personal.yaml");
    // Complete env config present: a fallback would succeed, so a throw
    // proves there is none.
    expect(() => loadConfig({ env: { REFLEX_CONFIG: missing, REFLEX_PRINCIPAL: "jc" } })).toThrow(missing);
  });
});

describe("state_dir", () => {
  it("unset → stateDir undefined → defaultDbPath()", () => {
    const cfg = loadConfig({ configPath: writeConfigFile("principal: jc\n"), env: {} });
    expect(cfg.stateDir).toBeUndefined();
    expect(dbPathFor(cfg, { XDG_STATE_HOME: "/xdg" })).toBe(defaultDbPath({ XDG_STATE_HOME: "/xdg" }));
    expect(dbPathFor(cfg, {})).toBe(join(homedir(), ".local/state/reflex/reflex.db"));
  });

  it("set → <state_dir>/reflex.db", () => {
    const cfg = loadConfig({ configPath: writeConfigFile("principal: jc\nstate_dir: /x/state\n"), env: {} });
    expect(cfg.stateDir).toBe("/x/state");
    expect(dbPathFor(cfg)).toBe("/x/state/reflex.db");
  });

  it("expands a leading ~/", () => {
    const cfg = loadConfig({
      configPath: writeConfigFile("principal: jc\nstate_dir: ~/.local/state/reflex-personal\n"),
      env: {},
    });
    expect(cfg.stateDir).toBe(join(homedir(), ".local/state/reflex-personal"));
  });

  it("the daemon opens its DB under state_dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-instance-daemon-"));
    const central = join(dir, "activations");
    mkdirSync(central);
    const stateDir = join(dir, "state");
    const cfg = testConfig({ activationsDir: central, stateDir });
    const bus = createReflexBus(cfg, { transport: createTransport({ type: "memory" }) });
    const daemon = await startDaemon(cfg, { bus, sweepIntervalMs: 100_000 });
    try {
      expect(existsSync(join(stateDir, "reflex.db"))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });
});

describe("REFLEX_CONFIG naming a missing file fails startup", () => {
  const previous = process.env.REFLEX_CONFIG;
  afterEach(() => {
    if (previous === undefined) delete process.env.REFLEX_CONFIG;
    else process.env.REFLEX_CONFIG = previous;
  });

  it("CLI exits non-zero naming the path", async () => {
    const missing = join(tmpdir(), "reflex-no-such-dir", "cli.yaml");
    process.env.REFLEX_CONFIG = missing;
    const rendered = await runCommand(["status"]);
    expect(rendered.exitCode).not.toBe(0);
    expect(rendered.stderr).toContain(missing);
  });

  it("daemon exits non-zero naming the path", () => {
    const missing = join(tmpdir(), "reflex-no-such-dir", "daemon.yaml");
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../../src/bin/reflex-daemon.ts")], {
      env: { ...process.env, REFLEX_CONFIG: missing, REFLEX_PRINCIPAL: "jc" },
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain(missing);
  });
});
