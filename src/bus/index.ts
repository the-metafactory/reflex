import { existsSync } from "node:fs";
import {
  EnvelopeTransport,
  NATSTransport,
  createEnvelope,
  createMiddlewareTransport,
  metricsMiddleware,
} from "@the-metafactory/myelin";
import type {
  EnvelopeRequestInput,
  MyelinEnvelope,
  SubscribeOptions,
  Subscription,
  TransportPublisher,
  TransportSubscriber,
} from "@the-metafactory/myelin";
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

export function createReflexBus(cfg: ReflexConfig, options: ReflexBusOptions = {}): ReflexBus {
  let transport = options.transport;
  if (!transport) {
    // Fail-fast policy (spec FR-7): refuse to construct without a readable
    // creds file — do not wait for the first connect to discover misconfig.
    if (!existsSync(cfg.nats.creds)) {
      throw new Error(
        `NATS credentials file not found: ${cfg.nats.creds} — provision per DD-72 ` +
          `(per-component creds under ~/.config/nats/creds/) or set REFLEX_NATS_CREDS`,
      );
    }
    transport = new NATSTransport({
      servers: cfg.nats.url,
      name: `reflex-${cfg.principal}`,
      credentials: cfg.nats.creds,
      requireAuth: true,
      reconnect: true,
    });
  }

  const published = new Counter();
  const receivedCounter = new Counter();
  let handlerErrors = 0;
  let lastPublishAt: string | null = null;

  const metrics = metricsMiddleware({ publishedTotal: published, receivedTotal: receivedCounter });
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

  return {
    async publishFired(input) {
      await envelopeTransport.publish(buildActivationFired(cfg, input));
      lastPublishAt = new Date().toISOString();
    },
    async publishDecision(input) {
      await envelopeTransport.publish(buildActivationDecision(cfg, input));
      lastPublishAt = new Date().toISOString();
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
        queued: 0,
        dropped: 0,
        lastPublishAt,
      };
    },
    raw: transport,
    async close() {
      await envelopeTransport.close();
    },
  };
}
