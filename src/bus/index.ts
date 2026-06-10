import { existsSync } from "node:fs";
import {
  EnvelopeTransport,
  NATSTransport,
  createEnvelope,
  createMiddlewareTransport,
  metricsMiddleware,
} from "@the-metafactory/myelin";
import type {
  EnvelopePublishInput,
  EnvelopeRequestInput,
  MyelinEnvelope,
  SubscribeOptions,
  Subscription,
  TransportPublisher,
  TransportSubscriber,
} from "@the-metafactory/myelin";
import { BoundedPublishQueue } from "./queue";
import { REFLEX_STREAM_NAME } from "./stream";
import type { ReflexConfig } from "../config/schema";
import {
  buildActivationDecision,
  buildActivationFired,
  type ActivationDecisionInput,
  type ActivationFiredInput,
} from "./envelopes";

export interface ReflexBusMetrics {
  published: number;
  received: number;
  handlerErrors: number;
  queued: number;
  dropped: number;
  lastPublishAt: string | null;
}

/** Reply builder for request/reply handlers: return value becomes the response envelope input. */
export type ReplyHandler = (envelope: MyelinEnvelope) => Promise<{
  source: string;
  type: string;
  payload: Record<string, unknown>;
}>;

export interface ReflexBusOptions {
  /** Inject a transport (tests: InMemoryTransport). Default: NATS from config. */
  transport?: TransportPublisher & TransportSubscriber;
  /** Retry-flush cadence for the outage queue. Default 1000ms. */
  flushIntervalMs?: number;
}

export interface ReflexBus {
  publishFired(input: ActivationFiredInput): Promise<void>;
  publishDecision(input: ActivationDecisionInput): Promise<void>;
  subscribe(
    subject: string,
    handler: (envelope: MyelinEnvelope) => Promise<void>,
    options?: SubscribeOptions,
  ): Promise<Subscription>;
  subscribeReplyable(subject: string, handler: ReplyHandler): Promise<Subscription>;
  request(input: EnvelopeRequestInput, subject?: string): Promise<MyelinEnvelope>;
  metrics(): ReflexBusMetrics;
  /** Underlying transport — NATS-only operations (ensureStream) reach through here. */
  raw: TransportPublisher & TransportSubscriber;
  close(): Promise<void>;
}

class Counter {
  value = 0;
  inc(_labels?: Record<string, string>): void {
    this.value += 1;
  }
}

/** Fail-fast NATS transport construction (spec FR-7): refuse to construct
 * without a readable creds file — do not wait for the first connect to
 * discover misconfig. */
function buildNatsTransport(cfg: ReflexConfig): NATSTransport {
  if (!existsSync(cfg.nats.creds)) {
    throw new Error(
      `NATS credentials file not found: ${cfg.nats.creds} — provision per DD-72 ` +
        `(per-component creds under ~/.config/nats/creds/) or set REFLEX_NATS_CREDS`,
    );
  }
  return new NATSTransport({
    servers: cfg.nats.url,
    name: `reflex-${cfg.principal}`,
    credentials: cfg.nats.creds,
    requireAuth: true,
    reconnect: true,
    streamName: REFLEX_STREAM_NAME,
  });
}

/** Metered transport + envelope layer over the raw transport. */
function buildEnvelopeLayer(
  cfg: ReflexConfig,
  transport: TransportPublisher & TransportSubscriber,
  published: Counter,
  received: Counter,
): { metered: ReturnType<typeof createMiddlewareTransport>; envelopeTransport: EnvelopeTransport } {
  const metrics = metricsMiddleware({ publishedTotal: published, receivedTotal: received });
  const metered = createMiddlewareTransport({
    publisher: transport,
    subscriber: transport,
    publishMiddleware: [metrics.publish],
    subscribeMiddleware: [metrics.subscribe],
  });
  const envelopeTransport = new EnvelopeTransport({
    publisher: metered,
    subscriber: metered,
    networkSovereignty: cfg.sovereignty,
    stack: cfg.stack,
  });
  return { metered, envelopeTransport };
}

export function createReflexBus(cfg: ReflexConfig, options: ReflexBusOptions = {}): ReflexBus {
  const transport = options.transport ?? buildNatsTransport(cfg);

  const published = new Counter();
  const receivedCounter = new Counter();
  let handlerErrors = 0;
  let lastPublishAt: string | null = null;

  const { metered, envelopeTransport } = buildEnvelopeLayer(cfg, transport, published, receivedCounter);

  function containHandler(
    subject: string,
    handler: (envelope: MyelinEnvelope) => Promise<void>,
  ): (envelope: MyelinEnvelope) => Promise<void> {
    return async (envelope) => {
      try {
        await handler(envelope);
      } catch (error) {
        handlerErrors += 1;
        console.error(`[reflex-bus] handler error on ${subject}: ${(error as Error).message}`);
      }
    };
  }

  // Outage queue (FR-8): a rejected publish is enqueued, never thrown to the
  // caller — the decision row in SQLite is the audit truth; the wire catches
  // up on reconnect. Drop-oldest beyond the limit, loudly.
  const queue = new BoundedPublishQueue<EnvelopePublishInput>(cfg.publishQueueLimit);
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function ensureFlushTimer(): void {
    if (flushTimer) return;
    flushTimer = setInterval(async () => {
      const { flushed } = await queue.flush(async (item) => {
        await envelopeTransport.publish(item);
      });
      if (flushed > 0) lastPublishAt = new Date().toISOString();
      if (queue.size === 0 && flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
    }, options.flushIntervalMs ?? 1000);
  }

  async function publishOrQueue(input: EnvelopePublishInput): Promise<void> {
    try {
      await envelopeTransport.publish(input);
      lastPublishAt = new Date().toISOString();
    } catch (error) {
      const droppedItem = queue.enqueue(input);
      if (droppedItem) {
        console.warn(
          `[reflex-bus] publish queue overflow — dropped oldest (type ${droppedItem.type}); ` +
            `queue limit ${cfg.publishQueueLimit}`,
        );
      }
      console.warn(`[reflex-bus] publish failed, queued (${queue.size}): ${(error as Error).message}`);
      ensureFlushTimer();
    }
  }

  return {
    async publishFired(input) {
      await publishOrQueue(buildActivationFired(cfg, input));
    },
    async publishDecision(input) {
      await publishOrQueue(buildActivationDecision(cfg, input));
    },
    subscribe(subject, handler, options) {
      return envelopeTransport.subscribe(subject, containHandler(subject, handler), options);
    },
    subscribeReplyable(subject, handler) {
      return envelopeTransport.subscribe(
        subject,
        containHandler(subject, async (envelope) => {
          const reply = await handler(envelope);
          const replyTo = (envelope.extensions?.reply_to as string | undefined) ?? undefined;
          if (!replyTo) return;
          // Reply goes through the RAW transport: _INBOX.* subjects are
          // outside the myelin subject grammar by design, so
          // EnvelopeTransport's subject/envelope alignment check would
          // (correctly, for normal traffic) reject them.
          const replyEnvelope = createEnvelope({
            ...reply,
            correlation_id: envelope.correlation_id,
            sovereignty: cfg.sovereignty,
          });
          await metered.publish(replyTo, replyEnvelope);
        }),
      );
    },
    request(input, subject) {
      return envelopeTransport.request(input, subject);
    },
    metrics() {
      return {
        published: published.value,
        received: receivedCounter.value,
        handlerErrors,
        queued: queue.size,
        dropped: queue.droppedCount,
        lastPublishAt,
      };
    },
    raw: transport,
    async close() {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      await envelopeTransport.close();
    },
  };
}
