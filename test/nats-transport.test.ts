import { describe, expect, it } from "bun:test";
import { createEnvelope } from "@the-metafactory/myelin";
import { TimeoutError } from "@nats-io/nats-core";
import type { NatsConnection, RequestOptions } from "@nats-io/nats-core";
import { ReflexNatsTransport, buildNatsTransport } from "../src/bus/nats-transport";
import { ReflexWebSocketTransport } from "../src/edge/nats-transport";
import { ensureReflexStream } from "../src/bus/stream";
import { testConfig } from "./helpers";

/** Real JetStream client/manager, fake only the connection's wire interface. */
function rig(Adapter: typeof ReflexNatsTransport | typeof ReflexWebSocketTransport, timeoutMs?: number, managerTimeouts = 0) {
  const requests: Array<{ subject: string; timeout: number | undefined }> = [];
  const inboxes: string[] = [];
  let connections = 0;
  const nc = {
    options: {},
    request: async (subject: string, _data: unknown, options: RequestOptions) => {
      requests.push({ subject, timeout: options.timeout });
      if (subject === "$JS.API.INFO" && managerTimeouts-- > 0) throw new TimeoutError();
      const response = subject === "$JS.API.STREAM.INFO.REFLEX"
        ? { config: { name: "REFLEX", sealed: false }, state: {} }
        : { stream: "REFLEX", seq: 1 };
      return { data: new TextEncoder().encode(JSON.stringify(response)) };
    },
    publish: (subject: string) => { inboxes.push(subject); },
    drain: async () => {},
  } as unknown as NatsConnection;
  const transport = new Adapter({ servers: "ws://localhost:4222", streamName: "REFLEX" }, timeoutMs);
  Object.assign(transport, {
    establishConnection: async () => {
      connections++;
      return nc;
    },
  });
  return { transport, requests, inboxes, connections: () => connections };
}

const envelope = () => createEnvelope({ source: "jc.default.reflex", type: "reflex.activation.fired", payload: {}, sovereignty: testConfig().sovereignty });

for (const Adapter of [ReflexNatsTransport, ReflexWebSocketTransport]) {
  describe(`${Adapter.name} JetStream timeout`, () => {
    for (const [label, configured, expected] of [["default", undefined, 10_000], ["configured", 24_000, 24_000]] as const) {
      it(`uses the ${label} timeout for manager, context, and publish`, async () => {
        const { transport, requests } = rig(Adapter, configured);
        try {
          const manager = await transport.getStreamManager();
          expect(manager.getOptions().timeout).toBe(expected);
          await manager.streams.info("REFLEX");
          await transport.publish("local.jc.default.reflex.activation.fired", envelope());
          expect(requests).toEqual([
            { subject: "$JS.API.INFO", timeout: expected },
            { subject: "$JS.API.STREAM.INFO.REFLEX", timeout: expected },
            { subject: "local.jc.default.reflex.activation.fired", timeout: expected },
          ]);
        } finally {
          await transport.close();
        }
      });
    }

    it("retries manager initialization on the same connection after a timeout", async () => {
      const { transport, requests, connections } = rig(Adapter, 15_000, 2);
      try {
        await expect(transport.getStreamManager()).rejects.toBeInstanceOf(TimeoutError);
        await expect(transport.getStreamManager()).rejects.toBeInstanceOf(TimeoutError);
        const manager = await transport.getStreamManager();
        expect(await transport.getStreamManager()).toBe(manager);
        expect(requests).toHaveLength(3);
        expect(connections()).toBe(1);
      } finally {
        await transport.close();
      }
    });

    it("reinitializes clients after close and preserves the inbox bypass", async () => {
      const { transport, requests, inboxes, connections } = rig(Adapter);
      await transport.publish("_INBOX.reply", envelope());
      expect(requests).toHaveLength(0);
      expect(inboxes).toEqual(["_INBOX.reply"]);
      await transport.getStreamManager();
      await transport.publish("local.jc.default.reflex.activation.fired", envelope());
      await transport.close();
      try {
        await transport.getStreamManager();
        await transport.publish("local.jc.default.reflex.activation.fired", envelope());
        expect(connections()).toBe(2);
        expect(requests).toHaveLength(4);
      } finally {
        await transport.close();
      }
    });
  });
}

describe("TCP transport construction", () => {
  it("retries real TCP request timeouts without creating an unknown stream", async () => {
    const subjects: string[] = [];
    let lookups = 0;
    // Speak only the NATS wire handshake and API replies. The real Myelin
    // connection generates its own request timeout for the first two lookups.
    const server = Bun.listen<{ pending: string; sid?: string }>({
      hostname: "127.0.0.1", port: 0,
      socket: {
        open(socket) {
          socket.data = { pending: "" };
          socket.write(`INFO ${JSON.stringify({
            server_id: "reflex-test", version: "2.10.0", proto: 1,
            max_payload: 1048576, headers: true, jetstream: true,
          })}\r\n`);
        },
        data(socket, bytes) {
          socket.data.pending += new TextDecoder().decode(bytes);
          let end: number;
          while ((end = socket.data.pending.indexOf("\r\n")) !== -1) {
            const line = socket.data.pending.slice(0, end);
            socket.data.pending = socket.data.pending.slice(end + 2);
            const [op, subject, reply] = line.split(" ");
            if (op === "PING") socket.write("PONG\r\n");
            if (op === "SUB") socket.data.sid = line.split(" ").at(-1);
            if (op !== "PUB") continue;
            subjects.push(subject);
            let response: object;
            if (subject === "$JS.API.INFO") response = {};
            else if (subject === "$JS.API.STREAM.INFO.REFLEX") {
              if (++lookups <= 2) continue;
              response = { config: { name: "REFLEX", sealed: false }, state: {} };
            } else continue;
            const payload = JSON.stringify(response);
            socket.write(`MSG ${reply} ${socket.data.sid} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
          }
        },
      },
    });
    const transport = new ReflexNatsTransport({ servers: `nats://127.0.0.1:${server.port}`, reconnect: false }, 100);
    const delays: number[] = [];
    try {
      await ensureReflexStream(transport, testConfig(), { sleep: async (ms) => { delays.push(ms); } });
      expect(delays).toEqual([1000, 2000]);
      expect(lookups).toBe(3);
      expect(subjects).toEqual([
        "$JS.API.INFO", "$JS.API.STREAM.INFO.REFLEX",
        "$JS.API.STREAM.INFO.REFLEX", "$JS.API.STREAM.INFO.REFLEX",
      ]);
    } finally {
      await transport.close();
      server.stop(true);
    }
  });

  it("builder carries the configured timeout into the transport", async () => {
    const cfg = testConfig({ nats: { url: "nats://localhost:4222", creds: "", insecure: true, timeout_ms: 27_000 } });
    const transport = buildNatsTransport(cfg);
    // Use the builder's actual adapter over a fake connection, avoiding a server.
    const timeouts: number[] = [];
    Object.assign(transport, { establishConnection: async () => ({
      options: {},
      request: async (_subject: string, _data: unknown, options: RequestOptions) => {
        timeouts.push(options.timeout);
        return { data: new TextEncoder().encode('{"stream":"REFLEX","seq":1}') };
      },
      drain: async () => {},
    }) });
    try {
      await transport.getStreamManager();
      await transport.publish("local.jc.default.reflex.activation.fired", envelope());
      expect(timeouts).toEqual([27_000, 27_000]);
    } finally {
      await transport.close();
    }
  });
});
