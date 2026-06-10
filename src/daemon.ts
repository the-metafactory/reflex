import { ActivationWatcher } from "./activation/watcher";
import { discoverActivationFiles } from "./activation/sources";
import { BlueprintStore, loadBlueprintSet } from "./activation/store";
import { createReflexBus, type ReflexBus } from "./bus";
import { ensureReflexStream } from "./bus/stream";
import type { ReflexConfig } from "./config/schema";
import { CommandRouter } from "./cmd/router";
import { CommandHandlers } from "./handlers/commands";
import { Pipeline } from "./pipeline/evaluate";
import { BusSource } from "./sources/bus";
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

/** Opaque public handle (package-root contract): observe + stop. */
export interface ReflexDaemonHandle {
  scheduleStatus(): import("./sources/schedule").ScheduleStatus[];
  stop(): Promise<void>;
}

/** Full internal daemon — repo-internal consumers (tests, R-107 transport binding). */
export interface ReflexDaemon extends ReflexDaemonHandle {
  pipeline: Pipeline;
  store: BlueprintStore;
  schedule: ScheduleSource;
  repo: Repository;
  bus: ReflexBus;
  handlers: CommandHandlers;
}

/**
 * Composition root: config → storage → blueprint surfaces → bus → stream →
 * pipeline → impulse sources → lifecycle timers. ASSEMBLY is fail-fast:
 * any precondition failure during assembly (migration, duplicate blueprint
 * id, creds, JetStream) throws — with already-opened resources closed —
 * before the watcher or scheduler start. Failures AFTER start surface
 * through their own paths (watcher last-good-set, bus outage queue).
 */
export async function startDaemon(cfg: ReflexConfig, options: DaemonOptions = {}): Promise<ReflexDaemon> {
  const { db, close: closeDb } = openDb(options.dbPath ?? defaultDbPath());
  let bus: ReflexBus | undefined;
  try {
    return await assemble();
  } catch (error) {
    // Startup-failure cleanup (sage R-105): never leak the DB handle or a
    // connected bus to a caller that only sees the thrown error.
    if (bus && !options.bus) await bus.close().catch(() => {});
    closeDb();
    throw error;
  }

  async function assemble(): Promise<ReflexDaemon> {
  const repo = new Repository(db);

  const sources = { watchRoots: cfg.watchRoots, activationsDir: cfg.activationsDir };
  const store = new BlueprintStore(await loadBlueprintSet(await discoverActivationFiles(sources)));
  const watcher = new ActivationWatcher(store, sources);

  bus = options.bus ?? createReflexBus(cfg);
  await ensureReflexStream(bus.raw, cfg);

  const pipeline = new Pipeline({ store, repo, bus });
  const schedule = new ScheduleSource(store, pipeline);
  const handlers = new CommandHandlers(store, pipeline, repo);
  const busSource = new BusSource(cfg, store, bus, pipeline, repo);
  const busRef = bus;
  const router = new CommandRouter({
    cfg,
    bus: busRef,
    handlers,
    pipeline,
    repo,
    store,
    schedule,
    daemonVersion: "0.1.0",
    startedAt: new Date().toISOString(),
  });
  await router.start();

  // Lifecycle wiring: hot-reload syncs scheduler jobs + expires waiting
  // decisions of removed blueprints (R-102 FR-6 / CONTEXT.md).
  watcher.onReload(() => {
    schedule.sync();
    void busSource.sync();
  });
  store.onBlueprintsRemoved((ids) => {
    const now = new Date().toISOString();
    for (const id of ids) {
      const expired = repo.expireForBlueprint(id, now);
      if (expired.length > 0) {
        console.info(`[reflex-daemon] expired ${expired.length} waiting decision(s) for removed blueprint ${id}`);
      }
    }
  });

  await watcher.start();
  schedule.start();
  await busSource.start();

  // Approval expiry sweep: timeout'd Matched Decisions resolve to Expired.
  // Runs once now (no immortal waiting rows after downtime), then on an
  // interval. Created AFTER all fallible startup steps — a failed start must
  // not leak a live timer (sage R-105 cycle-3). R-106 builds the full
  // approval lifecycle on top.
  repo.sweepExpiredApprovals(new Date().toISOString());
  const sweepTimer = setInterval(() => {
    repo.sweepExpiredApprovals(new Date().toISOString());
  }, options.sweepIntervalMs ?? 30_000);
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
    bus: busRef,
    handlers,
    scheduleStatus: () => schedule.status(),
    async stop() {
      if (stopped) return;
      stopped = true;
      schedule.stop();
      await busSource.stop();
      await watcher.stop();
      clearInterval(sweepTimer);
      await busRef.close();
      closeDb();
      console.info("[reflex-daemon] stopped");
    },
  };
  }
}
