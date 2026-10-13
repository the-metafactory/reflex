import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  installSequence,
  logsInvocation,
  startSequence,
  statusInvocation,
  stopSequence,
  uninstallSequence,
} from "../../src/service/commands";
import { buildServiceContext, recordedBunPath, serviceCommand } from "../../src/service/run";
import { renderLaunchdPlist, renderSystemdUnit, SERVICE_LABEL } from "../../src/service/units";

// reflex#37: a named second service next to the default one.

const base = {
  label: SERVICE_LABEL,
  bunPath: "/opt/bun/bin/bun",
  daemonScript: "/repo/src/bin/reflex-daemon.ts",
  workingDir: "/repo",
  home: "/srv/op",
  logsDir: "/srv/op/.config/reflex/logs",
};

describe("default service render is unchanged", () => {
  // Snapshots recorded against the pre-#37 render.
  it("launchd plist bytes", () => {
    expect(renderLaunchdPlist(base)).toMatchSnapshot();
  });
  it("systemd unit bytes", () => {
    expect(renderSystemdUnit(base)).toMatchSnapshot();
  });
});

const host = (platform: string, cwd = "/work") => ({ platform, home: "/home/op", uid: 501, cwd });

function configFile(content = "principal: jc\nstack: personal\nstate_dir: /srv/op/state/reflex-personal\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "reflex-svc-"));
  const path = join(dir, "personal.yaml");
  writeFileSync(path, content);
  return path;
}

describe("named instance on darwin", () => {
  const config = configFile();
  const ctx = buildServiceContext("install", { instance: "personal", config }, host("darwin"));

  it("label, plist path, log dir", () => {
    expect(ctx.cmd.label).toBe("ai.meta-factory.reflex.personal");
    expect(ctx.unitPath).toBe("/home/op/Library/LaunchAgents/ai.meta-factory.reflex.personal.plist");
    expect(ctx.logsDir).toBe("/home/op/.config/reflex/logs/personal");
  });

  it("plist carries the label, REFLEX_CONFIG and per-instance logs", () => {
    const plist = renderLaunchdPlist(ctx.unit);
    expect(plist).toContain("<key>Label</key>\n    <string>ai.meta-factory.reflex.personal</string>");
    expect(plist).toContain(`<key>REFLEX_CONFIG</key>\n        <string>${config}</string>`);
    expect(plist).toContain("<string>/home/op/.config/reflex/logs/personal/reflex.log</string>");
    expect(plist).toContain("<string>/home/op/.config/reflex/logs/personal/reflex.error.log</string>");
  });

  it("every launchctl call targets the instance label, never the default", () => {
    const argvs = [
      ...installSequence(ctx.cmd),
      ...uninstallSequence(ctx.cmd),
      ...startSequence(ctx.cmd),
      ...stopSequence(ctx.cmd),
      statusInvocation(ctx.cmd),
    ].map((i) => i.argv.join(" "));
    for (const argv of argvs) {
      if (argv.includes("bootstrap")) expect(argv).toEndWith(ctx.unitPath);
      else expect(argv).toEndWith("gui/501/ai.meta-factory.reflex.personal");
    }
    expect(logsInvocation(ctx.cmd, ctx.logsDir, false).argv).toEqual([
      "tail", "-n", "50",
      "/home/op/.config/reflex/logs/personal/reflex.log",
      "/home/op/.config/reflex/logs/personal/reflex.error.log",
    ]);
  });

  it("non-install verbs need no --config", () => {
    for (const verb of ["start", "stop", "status", "uninstall", "logs"]) {
      expect(buildServiceContext(verb, { instance: "personal" }, host("darwin")).cmd.label).toBe(
        "ai.meta-factory.reflex.personal",
      );
    }
  });
});

describe("named instance on linux", () => {
  const config = configFile();
  const ctx = buildServiceContext("install", { instance: "personal", config }, host("linux"));

  it("unit reflex-personal.service with REFLEX_CONFIG", () => {
    expect(ctx.unitPath).toBe("/home/op/.config/systemd/user/reflex-personal.service");
    expect(ctx.cmd.unit).toBe("reflex-personal");
    expect(renderSystemdUnit(ctx.unit)).toContain(`Environment="REFLEX_CONFIG=${config}"`);
  });

  it("every systemctl/journalctl call names reflex-personal", () => {
    const argvs = [
      ...installSequence(ctx.cmd),
      ...uninstallSequence(ctx.cmd),
      ...startSequence(ctx.cmd),
      ...stopSequence(ctx.cmd),
      statusInvocation(ctx.cmd),
      logsInvocation(ctx.cmd, ctx.logsDir, true),
    ].map((i) => i.argv);
    for (const argv of argvs) {
      if (argv.includes("daemon-reload")) continue;
      expect(argv).toContain("reflex-personal");
      expect(argv).not.toContain("reflex");
    }
  });
});

describe("no --instance is the default service, exactly as before", () => {
  it("darwin: default label, plist path, logs, no REFLEX_CONFIG", () => {
    const ctx = buildServiceContext("install", {}, host("darwin"));
    expect(ctx.cmd.label).toBe("ai.meta-factory.reflex");
    expect(ctx.unitPath).toBe("/home/op/Library/LaunchAgents/ai.meta-factory.reflex.plist");
    expect(ctx.logsDir).toBe("/home/op/.config/reflex/logs");
    expect(ctx.unit.reflexConfig).toBeUndefined();
    expect(renderLaunchdPlist(ctx.unit)).not.toContain("REFLEX_CONFIG");
  });

  it("linux: reflex.service, unit reflex", () => {
    const ctx = buildServiceContext("install", {}, host("linux"));
    expect(ctx.unitPath).toBe("/home/op/.config/systemd/user/reflex.service");
    expect(ctx.cmd.unit).toBe("reflex");
    expect(renderSystemdUnit(ctx.unit)).not.toContain("REFLEX_CONFIG");
  });
});

describe("validation fails closed before any effect", () => {
  it("rejects instance names outside the allowlist, for every verb", () => {
    const bad = ["", "Personal", "-x", "a.b", "a/b", "a b", "../x", "x".repeat(33), "a\nb"];
    for (const verb of ["install", "uninstall", "start", "stop", "status", "logs"]) {
      for (const name of bad) {
        expect(() => buildServiceContext(verb, { instance: name, config: configFile() }, host("darwin"))).toThrow(
          /invalid --instance/,
        );
      }
    }
    expect(buildServiceContext("status", { instance: "x".repeat(32) }, host("darwin")).cmd.label).toEndWith(
      "x".repeat(32),
    );
  });

  it("serviceCommand returns non-zero for a bad name, touching nothing", async () => {
    for (const verb of ["install", "uninstall", "start", "stop", "status", "logs"]) {
      const result = await serviceCommand(verb, { instance: "../evil", config: configFile() });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid --instance");
    }
  });

  it("install --instance without --config", () => {
    expect(() => buildServiceContext("install", { instance: "personal" }, host("darwin"))).toThrow(/needs --config/);
  });

  it("install --instance with a missing --config names the path", () => {
    expect(() =>
      buildServiceContext("install", { instance: "personal", config: "nope/personal.yaml" }, host("darwin", "/work")),
    ).toThrow("--config file does not exist: /work/nope/personal.yaml");
  });

  it("--config without --instance is rejected", () => {
    expect(() => buildServiceContext("install", { config: configFile() }, host("darwin"))).toThrow(/needs --instance/);
  });

  it("resolves a relative --config to an absolute path before rendering", () => {
    const config = configFile();
    const ctx = buildServiceContext(
      "install",
      { instance: "personal", config: basename(config) },
      host("darwin", dirname(config)),
    );
    expect(ctx.unit.reflexConfig).toBe(config);
  });
});

describe("install --instance refuses a config that would share the default DB", () => {
  it("no state_dir → throws naming the config", () => {
    const config = configFile("principal: jc\nstack: personal\n");
    expect(() => buildServiceContext("install", { instance: "personal", config }, host("darwin"))).toThrow(
      `--config ${config} sets no state_dir`,
    );
  });

  it("an invalid config → throws (validated as the daemon will read it)", () => {
    const config = configFile("stack: personal\nstate_dir: /x\n");
    expect(() => buildServiceContext("install", { instance: "personal", config }, host("darwin"))).toThrow(/principal/);
  });
});

describe("recordedBunPath (status stale-interpreter check)", () => {
  it("plist: the first ProgramArguments entry, not a Label containing 'bun'", () => {
    const ctx = buildServiceContext("install", { instance: "bunny", config: configFile() }, host("darwin"));
    expect(recordedBunPath(renderLaunchdPlist(ctx.unit))).toBe(process.execPath);
  });

  it("systemd: the first ExecStart word with its quotes stripped", () => {
    expect(recordedBunPath(renderSystemdUnit({ ...base, bunPath: "/opt/my bun/bin/bun" }))).toBe("/opt/my bun/bin/bun");
    expect(recordedBunPath(renderSystemdUnit(base))).toBe("/opt/bun/bin/bun");
  });
});
