import { describe, expect, it } from "bun:test";
import { NATSTransport } from "@the-metafactory/myelin";
import { ensureReflexStream, REFLEX_STREAM_NAME, reflexStreamSubjects } from "../../src/bus/stream";
import { testConfig } from "../helpers";
import { NATS_URL, natsUnavailable, requireWhenExplicit, skipNotice } from "./_guard";

const unavailable = await natsUnavailable();
if (unavailable) skipNotice("stream", unavailable);
requireWhenExplicit(unavailable, "stream");
const up = unavailable === null;

const cfg = testConfig({ principal: "jc", stack: "itest" });

describe.skipIf(!up)("integration: REFLEX stream ensure", () => {
  it("ensure is idempotent; honest no-op when another stack owns the stream", async () => {
    const transport = new NATSTransport({ servers: NATS_URL, name: "reflex-itest-stream" });
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const { connect } = await import("@nats-io/transport-node");
    const nc = await connect({ servers: NATS_URL });
    const jsm = await jetstreamManager(nc);

    // create-if-absent semantics: when a PRODUCTION daemon already owns
    // REFLEX with another stack's subjects, this test must not fight it
    // (the multi-stack wrinkle recorded in docs/plan-state.md).
    let preexisting: string[] | null = null;
    try {
      preexisting = (await jsm.streams.info(REFLEX_STREAM_NAME)).config.subjects ?? null;
    } catch {
      preexisting = null;
    }

    if (preexisting && !preexisting.includes(reflexStreamSubjects(cfg)[0]!)) {
      console.warn(
        `[integration] REFLEX stream owned by another stack (${preexisting.join(",")}) — ` +
          `verifying ensure is a no-op against it instead of subject membership`,
      );
      await ensureReflexStream(transport, cfg); // must not modify or throw
      const after = await jsm.streams.info(REFLEX_STREAM_NAME);
      expect(after.config.subjects).toEqual(preexisting);
    } else {
      await ensureReflexStream(transport, cfg);
      const before = await jsm.streams.info(REFLEX_STREAM_NAME);
      expect(before.config.subjects).toContain(reflexStreamSubjects(cfg)[0]!);
      await ensureReflexStream(transport, cfg); // idempotent re-run
      const after = await jsm.streams.info(REFLEX_STREAM_NAME);
      expect(after.config).toEqual(before.config);
    }

    await nc.close();
    await transport.close();
  }, 10_000);
});
