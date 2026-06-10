import { describe, expect, it } from "bun:test";
import { NATSTransport } from "@the-metafactory/myelin";
import { ensureReflexStream, REFLEX_STREAM_NAME, reflexStreamSubjects } from "../../src/bus/stream";
import { testConfig } from "../helpers";
import { NATS_URL, natsReachable, skipNotice } from "./_guard";

const up = await natsReachable();
if (!up) skipNotice("stream");

const cfg = testConfig({ principal: "jc", stack: "itest" });

describe.skipIf(!up)("integration: REFLEX stream ensure", () => {
  it("creates the stream, and a second run is a no-op", async () => {
    const transport = new NATSTransport({ servers: NATS_URL, name: "reflex-itest-stream" });

    await ensureReflexStream(transport, cfg);

    // Reach into JetStream management to snapshot the stream config.
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const { connect } = await import("@nats-io/transport-node");
    const nc = await connect({ servers: NATS_URL });
    const jsm = await jetstreamManager(nc);
    const before = await jsm.streams.info(REFLEX_STREAM_NAME);
    expect(before.config.subjects).toContain(reflexStreamSubjects(cfg)[0]!);

    await ensureReflexStream(transport, cfg); // idempotent re-run

    const after = await jsm.streams.info(REFLEX_STREAM_NAME);
    expect(after.config).toEqual(before.config);

    await nc.close();
    await transport.close();
  }, 10_000);
});
