import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/service/run";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "reflex-exec-"));
  dirs.push(dir);
  return dir;
}

function failsFirst(times: number, counter: string): string[] {
  return ["sh", "-c", `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ $n -gt ${times} ] || { echo "Bootstrap failed: 5" >&2; exit 5; }`];
}

describe("a step with retryForMs", () => {
  it("is re-run until it succeeds, then the next step runs", async () => {
    const dir = scratch();
    const counter = join(dir, "attempts");
    const marker = join(dir, "kickstarted");
    const result = await execute([{ argv: failsFirst(3, counter), retryForMs: 2_000 }, { argv: ["touch", marker] }], 10);
    expect(result).toBeNull();
    expect(readFileSync(counter, "utf8").trim()).toBe("4");
    expect(existsSync(marker)).toBe(true);
  });

  it("fails the sequence with the step's last error when it is still failing at the deadline", async () => {
    const dir = scratch();
    const marker = join(dir, "kickstarted");
    const result = await execute([{ argv: failsFirst(1_000, join(dir, "attempts")), retryForMs: 100 }, { argv: ["touch", marker] }], 10);
    expect(result?.exitCode).toBe(5);
    expect(result?.stderr).toBe("Bootstrap failed: 5\nservice step failed (sh exited 5)");
    expect(existsSync(marker)).toBe(false);
  });

  it("runs once when it succeeds at once", async () => {
    const counter = join(scratch(), "attempts");
    expect(await execute([{ argv: failsFirst(0, counter), retryForMs: 2_000 }], 10)).toBeNull();
    expect(readFileSync(counter, "utf8").trim()).toBe("1");
  });
});

describe("a step without retryForMs", () => {
  it("runs once and fails the sequence at once", async () => {
    const counter = join(scratch(), "attempts");
    const result = await execute([{ argv: failsFirst(1, counter) }], 10);
    expect(result?.exitCode).toBe(5);
    expect(readFileSync(counter, "utf8").trim()).toBe("1");
  });
});
