/**
 * Integration guard: tests run only when a local NATS server accepts us.
 * When absent — or present but refusing an unauthenticated client (an
 * operator-mode dev bus) — suites self-skip with a notice (spec NFR-2), so
 * `bun test` stays green offline.
 */
export const NATS_URL = process.env.REFLEX_TEST_NATS_URL ?? "nats://127.0.0.1:4222";

/**
 * When the integration suite is EXPLICITLY requested (bun test:integration
 * sets REFLEX_INTEGRATION=1), an unusable NATS is a hard failure — a
 * skipped suite must never masquerade as live evidence (sage R-101 review,
 * HonestOracle finding).
 */
export function requireWhenExplicit(unavailable: string | null, suite: string): void {
  if (unavailable !== null && process.env.REFLEX_INTEGRATION === "1") {
    throw new Error(
      `[integration] ${suite}: REFLEX_INTEGRATION=1 but ${unavailable} — ` +
        `refusing to skip-and-pass; start nats-server -js`,
    );
  }
}

/**
 * Why NATS at `url` cannot host the integration suites, or null when it can.
 * A TCP probe is not enough: a server that rejects the connection (e.g.
 * Authorization Violation) is reachable but unusable, so do the real NATS
 * handshake and round-trip a flush.
 */
export async function natsUnavailable(url: string = NATS_URL): Promise<string | null> {
  const { connect } = await import("@nats-io/transport-node");
  let nc: Awaited<ReturnType<typeof connect>>;
  try {
    nc = await connect({ servers: url, timeout: 1000, reconnect: false });
  } catch (error) {
    return `NATS at ${url} is unusable (${(error as Error).message})`;
  }
  try {
    await nc.flush();
    return null;
  } catch (error) {
    return `NATS at ${url} is unusable (${(error as Error).message})`;
  } finally {
    await nc.close().catch(() => {});
  }
}

export function skipNotice(suite: string, unavailable: string): void {
  console.warn(`[integration] ${suite}: ${unavailable} — skipping (start nats-server -js to enable)`);
}
