import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { DEFAULT_NATS_TIMEOUT_MS } from "../config/nats";

/** Workers-safe timeout policy shared by the TCP and WebSocket adapters. */
export class ReflexJetStream {
  private client: JetStreamClient | undefined;
  private manager: Promise<JetStreamManager> | undefined;

  constructor(private readonly timeoutMs = DEFAULT_NATS_TIMEOUT_MS) {}

  getManager(nc: NatsConnection): Promise<JetStreamManager> {
    this.manager ??= jetstreamManager(nc, { timeout: this.timeoutMs }).catch((error) => {
      this.manager = undefined; // timed-out initialization must be retryable
      throw error;
    });
    return this.manager;
  }

  async publish(nc: NatsConnection, subject: string, payload: Uint8Array): Promise<void> {
    if (subject.startsWith("_INBOX.")) {
      nc.publish(subject, payload);
      return;
    }
    this.client ??= jetstream(nc, { timeout: this.timeoutMs });
    await this.client.publish(subject, payload, { timeout: this.timeoutMs });
  }

  async close(closeTransport: () => Promise<void>): Promise<void> {
    this.client = undefined;
    this.manager = undefined;
    await closeTransport();
  }
}
