import { describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import { buildServiceContext } from "../../src/service/run";
import { renderLaunchdPlist, renderSystemdUnit, SERVICE_LABEL, servicePath } from "../../src/service/units";

const ctx = {
  label: SERVICE_LABEL,
  bunPath: "/opt/bun/bin/bun",
  daemonScript: "/repo/src/bin/reflex-daemon.ts",
  workingDir: "/repo",
  home: "/home/op",
  logsDir: "/home/op/.config/reflex/logs",
};

describe("servicePath", () => {
  it("puts bun first, keeps the installer's absolute entries in order, and ends with the system directories", () => {
    expect(servicePath("/opt/bun/bin/bun", "/home/op/.local/bin:/home/op/bin:/usr/bin")).toBe(
      "/opt/bun/bin:/home/op/.local/bin:/home/op/bin:/usr/bin:/usr/local/bin:/opt/homebrew/bin:/bin",
    );
  });
  it("drops relative and empty entries and repeats", () => {
    expect(servicePath("/opt/bun/bin/bun", ".:bin::/home/op/bin:/opt/bun/bin:/home/op/bin")).toBe(
      "/opt/bun/bin:/home/op/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    );
  });
  it("without an installer PATH is bun plus the system directories", () => {
    expect(servicePath("/opt/bun/bin/bun", undefined)).toBe("/opt/bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin");
  });
});

describe("a unit rendered with a path", () => {
  const path = "/opt/bun/bin:/home/op/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
  it("launchd carries it as PATH", () => {
    expect(renderLaunchdPlist({ ...ctx, path })).toContain(`<key>PATH</key>\n        <string>${path}</string>`);
  });
  it("systemd carries it as an Environment PATH", () => {
    expect(renderSystemdUnit({ ...ctx, path })).toContain(`Environment="PATH=${path}"\n`);
  });
  it("refuses control characters in it", () => {
    expect(() => renderLaunchdPlist({ ...ctx, path: "/usr/bin\n<key>evil</key>" })).toThrow(/control characters/);
    expect(() => renderSystemdUnit({ ...ctx, path: "/usr/bin\nExecStart=/bin/evil" })).toThrow(/control characters/);
  });
});

describe("reflex service install keeps the installer's PATH", () => {
  const host = (platform: string) => ({ platform, home: "/home/op", uid: 501, cwd: "/work", path: "/home/op/.local/bin:/home/op/bin:relative" });
  it.each(["darwin", "linux"])("on %s", (platform) => {
    const { unit } = buildServiceContext("install", {}, host(platform));
    expect(unit.path).toBe(servicePath(process.execPath, "/home/op/.local/bin:/home/op/bin"));
    expect(unit.path?.startsWith(`${dirname(process.execPath)}:/home/op/.local/bin:/home/op/bin:`)).toBe(true);
  });
});

describe("systemd Environment values", () => {
  it("write a literal % as %% so systemd does not expand it as a specifier", () => {
    const unit = renderSystemdUnit({ ...ctx, home: "/home/50%", path: "/opt/tools%h/bin:/usr/bin", reflexConfig: "/cfg/%i.yaml" });
    expect(unit).toContain('Environment="HOME=/home/50%%"\n');
    expect(unit).toContain('Environment="PATH=/opt/tools%%h/bin:/usr/bin"\n');
    expect(unit).toContain('Environment="REFLEX_CONFIG=/cfg/%%i.yaml"\n');
  });
});
