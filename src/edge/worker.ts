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
    return consumer(env).fetch(request as never) as unknown as Promise<Response>;
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      consumer(env).fetch("https://reflex-edge.internal/cron", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }),
      }) as unknown as Promise<Response>,
    );
  },
};
