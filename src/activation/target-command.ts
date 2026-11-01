import { z } from "zod";

const targetReply = z.object({ targets: z.array(z.string().min(1).max(200)).max(10000) }).strict();
const removalReply = z.object({ targets: z.array(z.object({ target: z.string(), flowRoot: z.string() }).strict()).max(10000) }).strict();
const limit = 65536;

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Routine target discovery output exceeds 64KiB");
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}

async function discover(command: readonly string[] | undefined, timeoutMs = 10000): Promise<unknown> {
  if (!command?.length) throw new Error("Routine target discovery is not configured");
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Routine target discovery timed out")), timeoutMs);
    });
    const [stdout, , code] = await Promise.race([
      Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]), timedOut,
    ]);
    if (code !== 0) throw new Error("Routine target discovery failed; check the configured command");
    let raw: unknown;
    try { raw = JSON.parse(stdout); } catch { throw new Error("Routine target discovery did not return JSON"); }
    return raw;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export async function discoverRoutineTargets(command: readonly string[] | undefined, timeoutMs = 10000): Promise<readonly string[]> {
  return targetReply.parse(await discover(command, timeoutMs)).targets;
}
export async function discoverRoutineRemovalTargets(command: readonly string[] | undefined, timeoutMs = 10000) {
  return removalReply.parse(await discover(command ? [...command, "--removal-safe"] : undefined, timeoutMs)).targets;
}
