import { describe, expect, it } from "bun:test";
import { ReflexConsumer, type ReflexEdgeEnv } from "../../src/edge/consumer-do";
import type { DurableObjectState, KVNamespace } from "@cloudflare/workers-types";

function consumer(timeout: string | undefined) {
  const env = {
    REFLEX_PRINCIPAL: "jc",
    REFLEX_NATS_WS_URL: "ws://localhost:4222",
    REFLEX_NATS_TIMEOUT_MS: timeout,
    REFLEX_NATS_CREDS: "",
    REFLEX_BLUEPRINTS: {
      list: async () => ({ keys: [], list_complete: true }),
    } as unknown as KVNamespace,
  } as ReflexEdgeEnv;
  return new ReflexConsumer({} as DurableObjectState, env);
}

describe("edge NATS timeout configuration", () => {
  for (const value of [undefined, "", "1", "30000", "2147483647"]) {
    it(`accepts ${JSON.stringify(value)} and proceeds to the credentials check`, async () => {
      await expect(consumer(value).fetch(new Request("https://reflex.example/status")))
        .rejects.toThrow("REFLEX_NATS_CREDS secret is required");
    });
  }

  for (const value of ["0", "-1", "1.5", "nope", "Infinity", "2147483648", " "]) {
    it(`labels invalid timeout ${JSON.stringify(value)}`, async () => {
      await expect(consumer(value).fetch(new Request("https://reflex.example/status")))
        .rejects.toThrow(`Invalid REFLEX_NATS_TIMEOUT_MS: ${value}`);
    });
  }
});
