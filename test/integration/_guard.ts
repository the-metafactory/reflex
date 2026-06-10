/**
 * Integration guard: tests run only when a local NATS server is reachable.
 * When absent, suites self-skip with a notice (spec NFR-2) — `bun test`
 * stays green offline.
 */
export const NATS_URL = process.env.REFLEX_TEST_NATS_URL ?? "nats://127.0.0.1:4222";

/**
 * When the integration suite is EXPLICITLY requested (bun test:integration
 * sets REFLEX_INTEGRATION=1), an unreachable NATS is a hard failure — a
 * skipped suite must never masquerade as live evidence (sage R-101 review,
 * HonestOracle finding).
 */
export function requireWhenExplicit(up: boolean, suite: string): void {
  if (!up && process.env.REFLEX_INTEGRATION === "1") {
    throw new Error(
      `[integration] ${suite}: REFLEX_INTEGRATION=1 but no NATS at ${NATS_URL} — ` +
        `refusing to skip-and-pass; start nats-server -js`,
    );
  }
}

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
