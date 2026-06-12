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
  // Capability check instead of `instanceof NATSTransport` (myelin#190):
  // the class check value-imported NATSTransport, dragging transport-node
  // into Workers bundles via this module (the DO imports REFLEX_STREAM_NAME
  // from here). Structural dispatch is deliberately WIDER than the old
  // nominal check: any transport exposing ensureStream provisions (NATS
  // TCP, WebSocket); InMemoryTransport lacks it and skips, same as before.
  if (transport === null || typeof transport !== "object") {
    return; // null/undefined/primitive — nothing to provision (old instanceof was false here too)
  }
  const provisionable = transport as { ensureStream?: (name: string, subjects: string[], cfg: object) => Promise<void> };
  if (typeof provisionable.ensureStream !== "function") {
    return; // InMemoryTransport — nothing to provision (tests, dry tooling)
  }
  try {
    await provisionable.ensureStream(REFLEX_STREAM_NAME, reflexStreamSubjects(cfg), {
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
