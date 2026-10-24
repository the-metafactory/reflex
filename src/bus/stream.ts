import type { ReflexConfig } from "../config/schema";
import { JetStreamApiError, JetStreamApiCodes } from "@nats-io/jetstream";
import type { JetStreamManager } from "@nats-io/jetstream";

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

/** Only the stream-management interface is needed by startup (and fakes). */
export type ReflexStreamManager = { streams: Pick<JetStreamManager["streams"], "info" | "add"> };

export interface StreamStartupOptions {
  /** Test clock; production uses real, referenced timers. */
  sleep?: (ms: number) => Promise<void>;
}

async function provisionOnce(
  manager: ReflexStreamManager,
  cfg: Pick<ReflexConfig, "principal" | "stack">,
): Promise<void> {
  try {
    await manager.streams.info(REFLEX_STREAM_NAME);
    return;
  } catch (error) {
    if (!(error instanceof JetStreamApiError) || error.code !== JetStreamApiCodes.StreamNotFound) throw error;
  }
  await manager.streams.add({
    name: REFLEX_STREAM_NAME,
    subjects: reflexStreamSubjects(cfg),
    retention: "limits",
    storage: "file",
    discard: "old",
    max_bytes: 512 * 1024 * 1024,
    max_age: 7 * 24 * 60 * 60 * 1e9,
    num_replicas: 1,
  });
}

/**
 * Create only after a definite not-found. A timeout leaves existence unknown:
 * retry the lookup, never delegate to Myelin's catch-all ensureStream.
 * Ten attempts, with delays of 1, 2, 4, 8, 16, 30, 30, 30, 30 seconds.
 * Existing streams are left untouched, including other stacks' subjects.
 */
export async function ensureReflexStream(
  transport: unknown,
  cfg: Pick<ReflexConfig, "principal" | "stack">,
  options: StreamStartupOptions = {},
): Promise<void> {
  // Structural dispatch keeps TCP/Node imports out of Workers bundles.
  if (transport === null || typeof transport !== "object") {
    return; // null/undefined/primitive — nothing to provision (old instanceof was false here too)
  }
  const provisionable = transport as {
    getStreamManager?: () => Promise<ReflexStreamManager>;
    ensureStream?: unknown;
  };
  if (typeof provisionable.getStreamManager !== "function") {
    if (typeof provisionable.ensureStream === "function") {
      throw new Error("Reflex stream provisioning requires getStreamManager; unsafe ensureStream is unsupported");
    }
    return; // InMemoryTransport — nothing to provision
  }
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = 10;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const manager = await provisionable.getStreamManager();
      await provisionOnce(manager, cfg);
      return;
    } catch (error) {
      // nats-core 3.4 identifies request timeouts by this name, with no
      // numeric code. Class identity is not stable across package copies.
      const timeout = error instanceof Error && error.name === "TimeoutError";
      if (!timeout || attempt === attempts) {
        throw new Error(
          `Failed to ensure JetStream stream ${REFLEX_STREAM_NAME}` +
            (timeout ? ` after ${attempts} attempts (timeout retries exhausted)` : "") +
            `: ${error instanceof Error ? error.message : String(error)} — ` +
            `check NATS connectivity, JetStream availability and permissions`,
          { cause: error },
        );
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      console.warn(`[reflex-daemon] JetStream stream ${REFLEX_STREAM_NAME} timed out (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}
