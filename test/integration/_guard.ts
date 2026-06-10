/**
 * Integration guard: tests run only when a local NATS server is reachable.
 * When absent, suites self-skip with a notice (spec NFR-2) — `bun test`
 * stays green offline.
 */
export const NATS_URL = process.env.REFLEX_TEST_NATS_URL ?? "nats://127.0.0.1:4222";

export async function natsReachable(): Promise<boolean> {
  try {
    const { host, port } = parseUrl(NATS_URL);
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

function parseUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 4222) };
}

export function skipNotice(suite: string): void {
  console.warn(`[integration] ${suite}: no NATS at ${NATS_URL} — skipping (start nats-server -js to enable)`);
}
