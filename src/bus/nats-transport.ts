import { existsSync } from "node:fs";
import { NATSTransport } from "@the-metafactory/myelin";
import { REFLEX_STREAM_NAME } from "./stream";
import type { ReflexConfig } from "../config/schema";

/** Fail-fast NATS transport construction (spec FR-7): refuse to construct
 * without a readable creds file — do not wait for the first connect to
 * discover misconfig. */
export function buildNatsTransport(cfg: ReflexConfig): NATSTransport {
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
    return new NATSTransport({
      servers: cfg.nats.url,
      name: `reflex-${cfg.principal}`,
      reconnect: true,
      streamName: REFLEX_STREAM_NAME,
    });
  }
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

