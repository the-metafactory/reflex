/**
 * PURE argv builders for service management (FR-7: arrays only, no shell
 * string interpolation) plus the status-output parser. The executor in
 * run.ts spawns these; tests assert them without touching launchctl.
 */
export type ServicePlatform = "darwin" | "linux";

export interface Invocation {
  argv: string[];
  /** Non-zero exit tolerated (idempotency steps like bootout-before-bootstrap). */
  allowFail?: boolean;
}

export function assertSupported(platform: string): ServicePlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(`service commands support darwin (launchd) and linux (systemd --user); got ${platform}`);
}

export interface CommandContext {
  platform: ServicePlatform;
  label: string;
  unitPath: string;
  uid: number;
}

export function installSequence(ctx: CommandContext): Invocation[] {
  if (ctx.platform === "darwin") {
    return [
      // bootout first: makes reinstall idempotent ("already loaded" otherwise)
      { argv: ["launchctl", "bootout", `gui/${ctx.uid}/${ctx.label}`], allowFail: true },
      { argv: ["launchctl", "bootstrap", `gui/${ctx.uid}`, ctx.unitPath] },
      { argv: ["launchctl", "kickstart", "-k", `gui/${ctx.uid}/${ctx.label}`] },
    ];
  }
  return [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "enable", "--now", "reflex"] },
  ];
}

export function uninstallSequence(ctx: CommandContext): Invocation[] {
  if (ctx.platform === "darwin") {
    return [{ argv: ["launchctl", "bootout", `gui/${ctx.uid}/${ctx.label}`], allowFail: true }];
  }
  return [
    { argv: ["systemctl", "--user", "disable", "--now", "reflex"], allowFail: true },
    { argv: ["systemctl", "--user", "daemon-reload"] },
  ];
}

/**
 * start/stop under launchd KeepAlive: `launchctl stop` would be resurrected
 * instantly by KeepAlive, so STOP means bootout (unload; unit file stays)
 * and START means bootstrap + kickstart (re-load). Verified live: a plain
 * stop produced a new pid within a second.
 */
export function startSequence(ctx: CommandContext): Invocation[] {
  if (ctx.platform === "darwin") {
    return [
      { argv: ["launchctl", "bootstrap", `gui/${ctx.uid}`, ctx.unitPath], allowFail: true }, // already loaded → fine
      { argv: ["launchctl", "kickstart", "-k", `gui/${ctx.uid}/${ctx.label}`] },
    ];
  }
  return [{ argv: ["systemctl", "--user", "start", "reflex"] }];
}

export function stopSequence(ctx: CommandContext): Invocation[] {
  if (ctx.platform === "darwin") {
    return [{ argv: ["launchctl", "bootout", `gui/${ctx.uid}/${ctx.label}`] }];
  }
  return [{ argv: ["systemctl", "--user", "stop", "reflex"] }];
}

export function statusInvocation(ctx: CommandContext): Invocation {
  return ctx.platform === "darwin"
    ? { argv: ["launchctl", "print", `gui/${ctx.uid}/${ctx.label}`], allowFail: true }
    : { argv: ["systemctl", "--user", "is-active", "reflex"], allowFail: true };
}

export function logsInvocation(ctx: CommandContext, logsDir: string, follow: boolean): Invocation {
  if (ctx.platform === "darwin") {
    const tail = ["tail", ...(follow ? ["-f"] : ["-n", "50"])];
    return { argv: [...tail, `${logsDir}/reflex.log`, `${logsDir}/reflex.error.log`] };
  }
  return { argv: ["journalctl", "--user", "-u", "reflex", ...(follow ? ["-f"] : ["-n", "50"])] };
}

export interface ServiceState {
  running: boolean;
  pid: number | null;
}

/** Parse `launchctl print` / `systemctl is-active` output (pure, fixture-tested). */
export function parseStatus(platform: ServicePlatform, exitCode: number, stdout: string): ServiceState {
  if (exitCode !== 0) return { running: false, pid: null };
  if (platform === "darwin") {
    const running = /state = running/.test(stdout);
    const pid = /pid = (\d+)/.exec(stdout)?.[1];
    return { running, pid: pid ? Number(pid) : null };
  }
  return { running: stdout.trim() === "active", pid: null };
}
