import { existsSync } from "node:fs";
import { NATSTransport } from "@the-metafactory/myelin";
import type { MyelinEnvelope, NATSTransportOptions } from "@the-metafactory/myelin";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { REFLEX_STREAM_NAME } from "./stream";
import type { ReflexConfig } from "../config/schema";

/** Local override until Myelin exposes JetStream timeout options. Core-NATS
 * request/reply and subscriptions retain Myelin's behavior. */
export class ReflexNatsTransport extends NATSTransport {
  private reflexClient: JetStreamClient | undefined;
  private reflexManager: Promise<JetStreamManager> | undefined;

  constructor(options: NATSTransportOptions, private readonly timeoutMs = 10_000) {
    super(options);
  }

  async getStreamManager(): Promise<JetStreamManager> {
    if (!this.reflexManager) {
      this.reflexManager = this.ensureNc()
        .then((nc) => jetstreamManager(nc, { timeout: this.timeoutMs }))
        .catch((error) => {
          this.reflexManager = undefined; // a timed-out initialization must be retryable
          throw error;
        });
    }
    return this.reflexManager;
  }

  override async publish(subject: string, envelope: MyelinEnvelope): Promise<void> {
    if (subject.startsWith("_INBOX.")) return super.publish(subject, envelope);
    const nc = await this.ensureNc();
    this.reflexClient ??= jetstream(nc, { timeout: this.timeoutMs });
    await this.reflexClient.publish(subject, this.codec.encode(envelope), { timeout: this.timeoutMs });
  }

  override async close(): Promise<void> {
    this.reflexClient = undefined;
    this.reflexManager = undefined;
    await super.close();
  }
}

/** Fail-fast NATS transport construction (spec FR-7): refuse to construct
 * without a readable creds file — do not wait for the first connect to
 * discover misconfig. */
export function buildNatsTransport(cfg: ReflexConfig): ReflexNatsTransport {
  if (cfg.nats.insecure) {
    // Explicit dev opt-out of the DD-72 creds fail-fast — LOOPBACK ONLY.
    // A non-local URL with insecure=true is a misconfiguration, not a mode:
    // unauthenticated traffic to a remote bus is never acceptable (sage
    // R-110 security finding).
    const host = new URL(cfg.nats.url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error(
        `nats.insecure=true is loopback-only (got ${host}) — provision DD-72 credentials for remote servers`,
      );
    }
    console.warn("[reflex-bus] INSECURE: connecting to NATS without credentials (nats.insecure=true, loopback)");
    return new ReflexNatsTransport({
      servers: cfg.nats.url,
      name: `reflex-${cfg.principal}`,
      reconnect: true,
      streamName: REFLEX_STREAM_NAME,
    }, cfg.nats.timeout_ms);
  }
  if (!existsSync(cfg.nats.creds)) {
    throw new Error(
      `NATS credentials file not found: ${cfg.nats.creds} — provision per DD-72 ` +
        `(per-component creds under ~/.config/nats/creds/) or set REFLEX_NATS_CREDS`,
    );
  }
  return new ReflexNatsTransport({
    servers: cfg.nats.url,
    name: `reflex-${cfg.principal}`,
    credentials: cfg.nats.creds,
    requireAuth: true,
    reconnect: true,
    streamName: REFLEX_STREAM_NAME,
  }, cfg.nats.timeout_ms);
}

