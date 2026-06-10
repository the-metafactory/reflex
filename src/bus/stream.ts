import { NATSTransport } from "@the-metafactory/myelin";
import type { ReflexConfig } from "../config/schema";

export const REFLEX_STREAM_NAME = "REFLEX";

/**
 * Subject wildcard covering everything Reflex publishes under the myelin
 * grammar `local.{principal}.{stack}.reflex.>`. The single place a Reflex
 * subject prefix is assembled (spec FR-3: no hand-built subjects elsewhere —
 * stream provisioning is the one structural exception and lives here).
 */
export function reflexStreamSubjects(cfg: Pick<ReflexConfig, "principal" | "stack">): string[] {
  return [`local.${cfg.principal}.${cfg.stack}.reflex.>`];
}

/**
 * Idempotently ensure the REFLEX JetStream stream (spec FR-5). Create if
 * absent; existing stream is left untouched (myelin ensureStream semantics).
 * Throws with an actionable message when JetStream is unavailable.
 */
export async function ensureReflexStream(
  transport: unknown,
  cfg: Pick<ReflexConfig, "principal" | "stack">,
): Promise<void> {
  if (!(transport instanceof NATSTransport)) {
    return; // InMemoryTransport — nothing to provision (tests, dry tooling)
  }
  try {
    await transport.ensureStream(REFLEX_STREAM_NAME, reflexStreamSubjects(cfg), {
      retention: "limits",
      storage: "file",
      discard: "old",
    });
  } catch (error) {
    throw new Error(
      `Failed to ensure JetStream stream ${REFLEX_STREAM_NAME}: ${(error as Error).message} — ` +
        `is nats-server running with JetStream enabled (-js)?`,
    );
  }
}
