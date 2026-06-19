import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ReflexEdgeEnv } from "./consumer-do";

export { ReflexConsumer } from "./consumer-do";

interface WorkerEnv extends ReflexEdgeEnv {
  REFLEX_CONSUMER: DurableObjectNamespace;
}

/** Every deployment uses ONE consumer instance — the single-writer model. */
const CONSUMER_NAME = "reflex";

function consumer(env: WorkerEnv) {
  return env.REFLEX_CONSUMER.get(env.REFLEX_CONSUMER.idFromName(CONSUMER_NAME));
}

/**
 * Reflex edge Worker (reflex#15, F-002): a stateless front that forwards
 * impulse HTTP traffic into the ReflexConsumer Durable Object, where the
 * pipeline, guards, bus subscriptions, per-blueprint serialization, AND the
 * scheduler heartbeat (a self-rescheduling DO alarm) live.
 *
 * There is deliberately NO `scheduled` handler: reflex owns the schedule
 * clock via the DO alarm, so the Worker consumes zero Cloudflare Cron
 * Triggers (F-002 / reflex#20).
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // PUBLIC ALLOWLIST (sage reflex#16 blocker): only the impulse surface is
    // forwarded. /status is the DO's internal protocol and is not reachable
    // from the public internet.
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/impulse/")) {
      return new Response(JSON.stringify({ error: "unknown path" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return consumer(env).fetch(request as never) as unknown as Promise<Response>;
  },
};
