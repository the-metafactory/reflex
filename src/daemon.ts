import { ActivationWatcher } from "./activation/watcher";
import { discoverActivationFiles } from "./activation/sources";
import { BlueprintStore, loadBlueprintSet } from "./activation/store";
import { createReflexBus, type ReflexBus } from "./bus";
import { ensureReflexStream } from "./bus/stream";
import type { ReflexConfig } from "./config/schema";
import { Pipeline } from "./pipeline/evaluate";
import { ScheduleSource } from "./sources/schedule";
import { openDb } from "./store/db";
import { defaultDbPath } from "./store/paths";
import { Repository } from "./store/repository";

export interface DaemonOptions {
  /** Override DB path (tests). Default: XDG state path. */
  dbPath?: string;
  /** Inject a transport-backed bus (tests). Default: NATS from config. */
  bus?: ReflexBus;
  /** Approval expiry sweep cadence. Default 30s. */
  sweepIntervalMs?: number;
}

export interface ReflexDaemon {
  pipeline: Pipeline;
  store: BlueprintStore;
  schedule: ScheduleSource;
  repo: Repository;
  bus: ReflexBus;
  stop(): Promise<void>;
}

/**
 * Composition root: config → storage → blueprint surfaces → bus → stream →
 * pipeline → impulse sources → lifecycle timers. Fail-fast: any precondition
 * failure (creds, JetStream, migration, duplicate blueprint id) throws before
 * the daemon serves anything; the bin entry exits non-zero.
 */
export async function startDaemon(cfg: ReflexConfig, options: DaemonOptions = {}): Promise<ReflexDaemon> {
  const { db, close: closeDb } = openDb(options.dbPath ?? defaultDbPath());
  const repo = new Repository(db);

  const sources = { watchRoots: cfg.watchRoots, activationsDir: cfg.activationsDir };
  const store = new BlueprintStore(await loadBlueprintSet(await discoverActivationFiles(sources)));
  const watcher = new ActivationWatcher(store, sources);

  const bus = options.bus ?? createReflexBus(cfg);
  await ensureReflexStream(bus.raw, cfg);

  const pipeline = new Pipeline({ store, repo, bus });
  const schedule = new ScheduleSource(store, pipeline);

  // Lifecycle wiring: hot-reload syncs scheduler jobs + expires waiting
  // decisions of removed blueprints (R-102 FR-6 / CONTEXT.md).
  watcher.onReload(() => schedule.sync());
  store.onBlueprintsRemoved((ids) => {
    const now = new Date().toISOString();
    for (const id of ids) {
      const expired = repo.expireForBlueprint(id, now);
      if (expired.length > 0) {
        console.info(`[reflex-daemon] expired ${expired.length} waiting decision(s) for removed blueprint ${id}`);
      }
    }
  });

  // Approval expiry sweep: timeout'd Matched Decisions resolve to Expired.
  // Runs once at startup (no immortal waiting rows after downtime), then on
  // an interval. R-106 builds the full approval lifecycle on top.
  repo.sweepExpiredApprovals(new Date().toISOString());
  const sweepTimer = setInterval(() => {
    repo.sweepExpiredApprovals(new Date().toISOString());
  }, options.sweepIntervalMs ?? 30_000);

  await watcher.start();
  schedule.start();
  console.info(
    `[reflex-daemon] up — ${store.current().length} blueprint(s), ` +
      `${schedule.status().length} scheduled, principal ${cfg.principal}/${cfg.stack}`,
  );

  let stopped = false;
  return {
    pipeline,
    store,
    schedule,
    repo,
    bus,
    async stop() {
      if (stopped) return;
      stopped = true;
      schedule.stop();
      await watcher.stop();
      clearInterval(sweepTimer);
      await bus.close();
      closeDb();
      console.info("[reflex-daemon] stopped");
    },
  };
}
