import { WebSocketTransport } from "@the-metafactory/myelin/edge";
import type { MyelinEnvelope, WebSocketTransportOptions } from "@the-metafactory/myelin/edge";
import { ReflexJetStream } from "../bus/jetstream";

/** Same temporary Myelin compatibility boundary as ReflexNatsTransport. */
export class ReflexWebSocketTransport extends WebSocketTransport {
  private readonly reflexJetStream: ReflexJetStream;

  constructor(options: WebSocketTransportOptions, timeoutMs?: number) {
    super(options);
    this.reflexJetStream = new ReflexJetStream(timeoutMs);
  }

  async getStreamManager() {
    return this.reflexJetStream.getManager(await this.ensureNc());
  }

  override async publish(subject: string, envelope: MyelinEnvelope): Promise<void> {
    if (subject.startsWith("_INBOX.")) return super.publish(subject, envelope);
    await this.reflexJetStream.publish(await this.ensureNc(), subject, this.codec.encode(envelope));
  }

  override async close(): Promise<void> {
    this.reflexJetStream.reset();
    await super.close();
  }
}
