import { describe, it, expect } from "bun:test";
import { discoverRoutineTargets } from "../../src/activation/target-command";

const command = (script: string) => [process.execPath, "-e", script];
describe("configured direct-argv routine target discovery", () => {
  it("accepts strict references-only JSON with diagnostics on stderr", async () => {
    expect(await discoverRoutineTargets(command('console.error("diagnostic");console.log(JSON.stringify({targets:["@example/noop"]}))'))).toEqual(["@example/noop"]);
  });
  it.each([
    'console.log("banner");console.log(JSON.stringify({targets:[]}))',
    'console.log("not json")',
    'console.log(JSON.stringify({targets:[],secret:"no"}))',
    'console.log(JSON.stringify({targets:[3]}))',
    'console.log(JSON.stringify({targets:[]}));process.exit(1)',
  ])("refuses malformed or unsuccessful provider output %s", async (script) => {
    await expect(discoverRoutineTargets(command(script))).rejects.toThrow();
  });
  it("bounds stdout and stderr and terminates timed-out providers", async () => {
    await expect(discoverRoutineTargets(command('console.log("x".repeat(70000))'))).rejects.toThrow("64KiB");
    await expect(discoverRoutineTargets(command('console.error("x".repeat(70000))'))).rejects.toThrow("64KiB");
    const start = Date.now();
    await expect(discoverRoutineTargets(command('setInterval(()=>{},1000)'), 50)).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2000);
  });
  it("refuses absent and missing commands", async () => {
    await expect(discoverRoutineTargets(undefined)).rejects.toThrow("not configured");
    await expect(discoverRoutineTargets(["/nonexistent/reflex-discovery"])).rejects.toThrow();
  });
});
