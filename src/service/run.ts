import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSupported,
  installSequence,
  logsInvocation,
  parseStatus,
  startSequence,
  statusInvocation,
  stopSequence,
  uninstallSequence,
  type CommandContext,
  type Invocation,
} from "./commands";
import { loadConfig } from "../config/load";
import { renderLaunchdPlist, renderSystemdUnit, SERVICE_LABEL, type UnitContext } from "./units";

export interface ServiceResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export interface ServiceOptions {
  follow?: boolean;
  /** Named second service (reflex#37); unset = the default service. */
  instance?: string;
  /** Config the named instance's daemon reads (`REFLEX_CONFIG`); install only. */
  config?: string;
}

/** The instance name lands in a launchd label, a file path and a systemd
 * unit name: allowlist, fail closed. */
export const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ServiceContext {
  unit: UnitContext;
  cmd: CommandContext;
  unitPath: string;
  logsDir: string;
  /** The commands a message tells the operator to run for this service. */
  installHint: string;
  startHint: string;
}

export interface ServiceHost {
  platform: string;
  home: string;
  uid: number;
  cwd: string;
}

const realHost = (): ServiceHost => ({
  platform: process.platform,
  home: homedir(),
  uid: userInfo().uid,
  cwd: process.cwd(),
});

/** Per-service names: the default service, or the `<instance>`-suffixed set. */
function serviceNames(instance: string | undefined): {
  label: string;
  unitName: string;
  logsSubdir: string;
  instanceArgs: string;
} {
  return instance === undefined
    ? { label: SERVICE_LABEL, unitName: "reflex", logsSubdir: ".config/reflex/logs", instanceArgs: "" }
    : {
        label: `${SERVICE_LABEL}.${instance}`,
        unitName: `reflex-${instance}`,
        logsSubdir: join(".config/reflex/logs", instance),
        instanceArgs: ` --instance ${instance}`,
      };
}

/**
 * The named instance's config, checked as its daemon will read it: the
 * file alone (the unit sets no REFLEX_* overlay). It must be valid and set
 * `state_dir`, or the two daemons would share the default reflex.db.
 */
function checkInstanceConfig(instance: string, config: string | undefined, cwd: string): string {
  if (config === undefined) {
    throw new Error(`install --instance ${instance} needs --config <path>`);
  }
  const path = resolve(cwd, config);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`--config file does not exist: ${path}`);
  }
  const loaded = loadConfig({ configPath: path, env: {} });
  if (loaded.stateDir === undefined) {
    throw new Error(`--config ${path} sets no state_dir — the instance would share the default service's reflex.db`);
  }
  return path;
}

/**
 * Resolve every path, name and env entry a service verb touches. Throws —
 * before any file write or launchctl/systemctl call — on a bad instance
 * name, a `--config` without `--instance`, or an install whose config is
 * missing, invalid or without `state_dir`. No `--instance` yields exactly
 * the pre-#37 default service.
 */
export function buildServiceContext(verb: string, options: ServiceOptions = {}, host: ServiceHost = realHost()): ServiceContext {
  const platform = assertSupported(host.platform);
  const { instance } = options;
  if (instance !== undefined && !INSTANCE_NAME.test(instance)) {
    throw new Error(`invalid --instance "${instance}" — expected ${INSTANCE_NAME.source}`);
  }
  if (instance === undefined && options.config !== undefined) {
    throw new Error("--config needs --instance; the default service reads the default config");
  }
  const reflexConfig =
    instance !== undefined && verb === "install" ? checkInstanceConfig(instance, options.config, host.cwd) : undefined;

  const { label, unitName, logsSubdir, instanceArgs } = serviceNames(instance);
  const logsDir = join(host.home, logsSubdir);
  const unit: UnitContext = {
    label,
    bunPath: process.execPath,
    daemonScript: resolve(import.meta.dir, "../bin/reflex-daemon.ts"),
    workingDir: resolve(import.meta.dir, "../.."),
    home: host.home,
    logsDir,
    ...(reflexConfig !== undefined ? { reflexConfig } : {}),
  };
  const unitPath =
    platform === "darwin"
      ? join(host.home, "Library/LaunchAgents", `${label}.plist`)
      : join(host.home, ".config/systemd/user", `${unitName}.service`);
  return {
    unit,
    cmd: { platform, label, unitPath, unit: unitName, uid: host.uid },
    unitPath,
    logsDir,
    installHint: `reflex service install${instanceArgs}${instance === undefined ? "" : " --config <path>"}`,
    startHint: `reflex service start${instanceArgs}`,
  };
}

/** The bun interpreter a rendered unit runs: the first ProgramArguments
 * entry (plist) or the first ExecStart word (systemd, quotes stripped). */
export function recordedBunPath(unitText: string): string | undefined {
  const match = unitText.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>|^ExecStart="((?:[^"\\]|\\.)*)"/m);
  return match?.[1] ?? match?.[2]?.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

async function execute(invocations: Invocation[]): Promise<ServiceResult | null> {
  for (const invocation of invocations) {
    const proc = Bun.spawn(invocation.argv, { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0 && !invocation.allowFail) {
      return {
        exitCode,
        stdout: "",
        stderr: `${stderr.trim()}\nservice step failed (${invocation.argv[0]} exited ${exitCode})`,
      };
    }
  }
  return null;
}

export async function serviceCommand(verb: string, options: ServiceOptions = {}): Promise<ServiceResult> {
  let ctx: ServiceContext;
  try {
    ctx = buildServiceContext(verb, options);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: (error as Error).message };
  }
  const { unit, cmd, unitPath, logsDir, installHint, startHint } = ctx;
  const { label } = cmd;

  switch (verb) {
    case "install": {
      const content = cmd.platform === "darwin" ? renderLaunchdPlist(unit) : renderSystemdUnit(unit);
      // One guarded block for ALL filesystem effects: an unwritable target
      // returns the documented result, never an escaped rejection.
      try {
        mkdirSync(logsDir, { recursive: true, mode: 0o700 });
        mkdirSync(join(unitPath, ".."), { recursive: true });
        writeFileSync(unitPath, content, { mode: 0o644 });
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: `${(error as Error).message} (target: ${unitPath})` };
      }
      const failure = await execute(installSequence(cmd));
      if (failure) return failure;
      return { exitCode: 0, stdout: `installed + started ${label}\nunit: ${unitPath}\nlogs: ${logsDir}` };
    }
    case "uninstall": {
      const failure = await execute(uninstallSequence(cmd));
      if (failure) return failure;
      rmSync(unitPath, { force: true });
      return { exitCode: 0, stdout: `uninstalled ${label}` };
    }
    case "start":
    case "stop": {
      if (!existsSync(unitPath)) {
        return { exitCode: 1, stdout: "", stderr: `not installed — run: ${installHint}` };
      }
      const failure = await execute(verb === "start" ? startSequence(cmd) : stopSequence(cmd));
      if (failure) return failure;
      return { exitCode: 0, stdout: `${verb}: ok` };
    }
    case "status": {
      if (!existsSync(unitPath)) {
        return { exitCode: 1, stdout: "", stderr: `not installed — run: ${installHint}` };
      }
      const invocation = statusInvocation(cmd);
      const proc = Bun.spawn(invocation.argv, { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      const state = parseStatus(cmd.platform, exitCode, stdout);
      const lines = [
        `${label}: ${state.running ? `running${state.pid ? ` (pid ${state.pid})` : ""}` : `installed, not running — run: ${startHint}`}`,
      ];
      // Stale-interpreter check: the unit references the bun resolved at
      // install time; a missing path means the service can't restart.
      const recordedBun = recordedBunPath(readFileSync(unitPath, "utf-8"));
      if (recordedBun && !existsSync(recordedBun)) {
        lines.push(`warning: unit references missing bun at ${recordedBun} — run: ${installHint}`);
      }
      if (cmd.platform === "linux") {
        // Spec FR-5 promises last log lines on BOTH platforms.
        const journal = Bun.spawn(["journalctl", "--user", "-u", cmd.unit, "-n", "5", "--no-pager"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const text = (await new Response(journal.stdout).text()).trimEnd();
        await journal.exited;
        if (text !== "") lines.push("--- last journal lines ---", ...text.split("\n"));
      }
      const errLog = join(logsDir, "reflex.error.log");
      if (cmd.platform === "darwin" && existsSync(errLog)) {
        // Bounded: crash loops under KeepAlive grow this file without bound —
        // never read it whole (sage R-111 finding).
        const proc = Bun.spawn(["tail", "-n", "5", errLog], { stdout: "pipe", stderr: "ignore" });
        const tailText = (await new Response(proc.stdout).text()).trimEnd();
        await proc.exited;
        if (tailText !== "") lines.push("--- last error-log lines ---", ...tailText.split("\n"));
      }
      return { exitCode: state.running ? 0 : 1, stdout: lines.join("\n") };
    }
    case "logs": {
      const invocation = logsInvocation(cmd, logsDir, options.follow ?? false);
      const proc = Bun.spawn(invocation.argv, { stdout: "inherit", stderr: "inherit" });
      return { exitCode: await proc.exited, stdout: "" };
    }
    default:
      return { exitCode: 1, stdout: "", stderr: `unknown service verb "${verb}" — install|uninstall|start|stop|status|logs` };
  }
}
