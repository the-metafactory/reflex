import type { DurableObjectNamespace, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
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
 * Reflex edge Worker (reflex#15): a stateless front that forwards both
 * impulse HTTP traffic and Cron Trigger firings into the ReflexConsumer
 * Durable Object, where the pipeline, guards, bus subscriptions, and
 * per-blueprint serialization live.
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // PUBLIC ALLOWLIST (sage reflex#16 blocker): only the impulse surface
    // is forwarded. /schedule and /status are the DO's internal protocol —
    // an unauthenticated POST /schedule from the internet must never be
    // able to trigger schedule blueprints outside Cloudflare Cron.
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/impulse/")) {
      return new Response(JSON.stringify({ error: "unknown path" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return consumer(env).fetch(request as never) as unknown as Promise<Response>;
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    // Cloudflare's field is named `cron`; the canonical vocabulary
    // (CONTEXT.md: Impulse Kind `schedule`, `cron` is an Avoid alias)
    // takes over at this boundary.
    ctx.waitUntil(
      consumer(env).fetch("https://reflex-edge.internal/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expression: controller.cron, scheduledTime: controller.scheduledTime }),
      }) as unknown as Promise<Response>,
    );
  },
};
