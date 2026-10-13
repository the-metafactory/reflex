import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { natsUnavailable } from "./_guard";

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

describe("natsUnavailable", () => {
  it("names the URL when nothing listens", async () => {
    const url = `nats://127.0.0.1:${freePort()}`;
    expect(await natsUnavailable(url)).toContain(url);
  });

  const natsServer = Bun.which("nats-server");
  const started: { proc: Bun.Subprocess; dir: string }[] = [];
  afterAll(() => {
    for (const { proc, dir } of started) {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startNats(extra: string[]): Promise<string> {
    const port = freePort();
    const dir = mkdtempSync(join(tmpdir(), "reflex-guard-"));
    const proc = Bun.spawn([natsServer!, "-js", "-a", "127.0.0.1", "-p", String(port), "-sd", dir, ...extra], {
      stdout: "ignore",
      stderr: "ignore",
    });
    started.push({ proc, dir });
    const url = `nats://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        (await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).end();
        return url;
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error(`nats-server did not listen on ${url}`);
  }

  it.skipIf(!natsServer)("reports a reachable server that rejects us (auth required)", async () => {
    const url = await startNats(["--user", "u", "--pass", "p"]);
    const reason = await natsUnavailable(url);
    expect(reason).toContain(url);
    expect(reason?.toLowerCase()).toContain("authorization");
  });

  it.skipIf(!natsServer)("returns null for a server that accepts us", async () => {
    const url = await startNats([]);
    expect(await natsUnavailable(url)).toBeNull();
  });
});
