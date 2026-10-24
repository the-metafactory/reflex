#!/usr/bin/env bun
import { loadConfig } from "../config/load";
import { startDaemon } from "../daemon";

/**
 * Daemon entry: load config (file + REFLEX_* env), start, stop cleanly on
 * SIGINT/SIGTERM. Stream startup retries transient timeouts first; any
 * remaining startup precondition failure exits non-zero with the
 * actionable error (fail-fast policy, R-101).
 */
async function main(): Promise<void> {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    const cfg = loadConfig();
    daemon = await startDaemon(cfg);
  } catch (error) {
    console.error(`[reflex-daemon] startup failed: ${(error as Error).message}`);
    process.exit(1);
  }
  const shutdown = (signal: string) => {
    console.info(`[reflex-daemon] ${signal} — shutting down`);
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((error: Error) => {
        console.error(`[reflex-daemon] shutdown cleanup failed: ${error.message}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
