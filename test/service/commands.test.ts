import { describe, expect, it } from "bun:test";
import {
  assertSupported,
  installSequence,
  logsInvocation,
  parseStatus,
  startSequence,
  statusInvocation,
  stopSequence,
  uninstallSequence,
} from "../../src/service/commands";

const darwin = { platform: "darwin" as const, label: "ai.meta-factory.reflex", unitPath: "/u/p.plist", uid: 501 };
const linux = { platform: "linux" as const, label: "ai.meta-factory.reflex", unitPath: "/u/reflex.service", uid: 1000 };

describe("platform gate (scenario 5)", () => {
  it("rejects unsupported platforms naming the supported set", () => {
    expect(() => assertSupported("win32")).toThrow(/darwin \(launchd\) and linux \(systemd --user\); got win32/);
    expect(assertSupported("darwin")).toBe("darwin");
  });
});

describe("darwin sequences", () => {
  it("install: bootout(allowFail) -> bootstrap -> kickstart (scenario 3 idempotency)", () => {
    expect(installSequence(darwin)).toEqual([
      { argv: ["launchctl", "bootout", "gui/501/ai.meta-factory.reflex"], allowFail: true },
      { argv: ["launchctl", "bootstrap", "gui/501", "/u/p.plist"] },
      { argv: ["launchctl", "kickstart", "-k", "gui/501/ai.meta-factory.reflex"] },
    ]);
  });
  it("uninstall/start/stop/status argv", () => {
    expect(uninstallSequence(darwin)).toEqual([
      { argv: ["launchctl", "bootout", "gui/501/ai.meta-factory.reflex"], allowFail: true },
    ]);
    // KeepAlive semantics: stop = bootout (unload), start = bootstrap + kickstart
    expect(startSequence(darwin)).toEqual([
      { argv: ["launchctl", "bootstrap", "gui/501", "/u/p.plist"], allowFail: true },
      { argv: ["launchctl", "kickstart", "-k", "gui/501/ai.meta-factory.reflex"] },
    ]);
    expect(stopSequence(darwin)).toEqual([{ argv: ["launchctl", "bootout", "gui/501/ai.meta-factory.reflex"] }]);
    expect(statusInvocation(darwin).allowFail).toBe(true);
  });
});

describe("linux sequences (scenario 4)", () => {
  it("install: daemon-reload -> enable --now", () => {
    expect(installSequence(linux)).toEqual([
      { argv: ["systemctl", "--user", "daemon-reload"] },
      { argv: ["systemctl", "--user", "enable", "--now", "reflex"] },
    ]);
  });
  it("logs uses journalctl, follow flag honored", () => {
    expect(logsInvocation(linux, "/logs", true).argv).toEqual(["journalctl", "--user", "-u", "reflex", "-f"]);
    expect(logsInvocation(darwin, "/logs", false).argv).toEqual([
      "tail", "-n", "50", "/logs/reflex.log", "/logs/reflex.error.log",
    ]);
  });
});

describe("status parser", () => {
  it("launchctl print: running + pid extracted", () => {
    const fixture = "ai.meta-factory.reflex = {\n  state = running\n  pid = 4242\n}";
    expect(parseStatus("darwin", 0, fixture)).toEqual({ running: true, pid: 4242 });
  });
  it("not loaded (exit != 0) -> not running", () => {
    expect(parseStatus("darwin", 113, "")).toEqual({ running: false, pid: null });
  });
  it("systemd is-active", () => {
    expect(parseStatus("linux", 0, "active\n")).toEqual({ running: true, pid: null });
    expect(parseStatus("linux", 3, "inactive\n")).toEqual({ running: false, pid: null });
  });
});
