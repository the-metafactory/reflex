import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSupported,
  installSequence,
  logsInvocation,
  parseStatus,
  startInvocation,
  statusInvocation,
  stopInvocation,
  uninstallSequence,
  type CommandContext,
  type Invocation,
} from "./commands";
import { renderLaunchdPlist, renderSystemdUnit, SERVICE_LABEL, type UnitContext } from "./units";

export interface ServiceResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

function contexts(): { unit: UnitContext; cmd: CommandContext; unitPath: string; logsDir: string } {
  const platform = assertSupported(process.platform);
  const home = homedir();
  const logsDir = join(home, ".config/reflex/logs");
  const unit: UnitContext = {
    label: SERVICE_LABEL,
    bunPath: process.execPath,
    daemonScript: resolve(import.meta.dir, "../bin/reflex-daemon.ts"),
    workingDir: resolve(import.meta.dir, "../.."),
    home,
    logsDir,
  };
  const unitPath =
    platform === "darwin"
      ? join(home, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`)
      : join(home, ".config/systemd/user/reflex.service");
  return { unit, cmd: { platform, label: SERVICE_LABEL, unitPath, uid: userInfo().uid }, unitPath, logsDir };
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

export async function serviceCommand(verb: string, options: { follow?: boolean } = {}): Promise<ServiceResult> {
  let ctx: ReturnType<typeof contexts>;
  try {
    ctx = contexts();
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: (error as Error).message };
  }
  const { unit, cmd, unitPath, logsDir } = ctx;

  switch (verb) {
    case "install": {
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      mkdirSync(join(unitPath, ".."), { recursive: true });
      const content = cmd.platform === "darwin" ? renderLaunchdPlist(unit) : renderSystemdUnit(unit);
      try {
        writeFileSync(unitPath, content, { mode: 0o644 });
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: `${(error as Error).message} (${unitPath})` };
      }
      const failure = await execute(installSequence(cmd));
      if (failure) return failure;
      return { exitCode: 0, stdout: `installed + started ${SERVICE_LABEL}\nunit: ${unitPath}\nlogs: ${logsDir}` };
    }
    case "uninstall": {
      const failure = await execute(uninstallSequence(cmd));
      if (failure) return failure;
      rmSync(unitPath, { force: true });
      return { exitCode: 0, stdout: `uninstalled ${SERVICE_LABEL}` };
    }
    case "start":
    case "stop": {
      if (!existsSync(unitPath)) {
        return { exitCode: 1, stdout: "", stderr: "not installed — run: reflex service install" };
      }
      const failure = await execute([verb === "start" ? startInvocation(cmd) : stopInvocation(cmd)]);
      if (failure) return failure;
      return { exitCode: 0, stdout: `${verb}: ok` };
    }
    case "status": {
      if (!existsSync(unitPath)) {
        return { exitCode: 1, stdout: "", stderr: "not installed — run: reflex service install" };
      }
      const invocation = statusInvocation(cmd);
      const proc = Bun.spawn(invocation.argv, { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      const state = parseStatus(cmd.platform, exitCode, stdout);
      const lines = [
        `${SERVICE_LABEL}: ${state.running ? `running${state.pid ? ` (pid ${state.pid})` : ""}` : "installed, not running — run: reflex service start"}`,
      ];
      // Stale-interpreter check: the unit references the bun resolved at
      // install time; a missing path means the service can't restart.
      const recorded = readFileSync(unitPath, "utf-8").match(/<string>([^<]*bun[^<]*)<\/string>|ExecStart=(\S+)/);
      const recordedBun = recorded?.[1] ?? recorded?.[2];
      if (recordedBun && !existsSync(recordedBun)) {
        lines.push(`warning: unit references missing bun at ${recordedBun} — run: reflex service install`);
      }
      const errLog = join(logsDir, "reflex.error.log");
      if (cmd.platform === "darwin" && existsSync(errLog)) {
        const tail = readFileSync(errLog, "utf-8").trimEnd().split("\n").slice(-5);
        if (tail.length > 0 && tail[0] !== "") lines.push("--- last error-log lines ---", ...tail);
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
