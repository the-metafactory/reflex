import { z } from "zod";

const targetReply = z.object({ targets: z.array(z.string().min(1).max(200)).max(10000) }).strict();
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

export async function discoverRoutineTargets(command: readonly string[] | undefined, timeoutMs = 10000): Promise<readonly string[]> {
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
    const result = targetReply.safeParse(raw);
    if (!result.success) throw new Error("Routine target discovery requires JSON {targets: [references]}");
    return result.data.targets;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
