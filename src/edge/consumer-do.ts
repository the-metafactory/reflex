import type { D1Database, DurableObjectState, KVNamespace } from "@cloudflare/workers-types";
import { WebSocketTransport } from "@the-metafactory/myelin/edge";
import { BlueprintStore } from "../activation/store";
import { createReflexBus, type ReflexBus } from "../bus";
import { REFLEX_STREAM_NAME, ensureReflexStream } from "../bus/stream";
import type { ReflexConfig } from "../config/schema";
import { Pipeline } from "../pipeline/evaluate";
import { BusSource } from "../sources/bus";
import { Scheduler } from "../scheduler/core";
import { EdgeHeartbeat, ALARM_PERIOD_MS } from "./heartbeat";
import { D1Repository } from "../store/d1-repository";
import { EdgeHttpSource } from "./http";
import { loadBlueprintsFromKV } from "./kv-blueprints";

/** Bindings the reflex edge worker expects (wrangler.toml). */
export interface ReflexEdgeEnv {
  REFLEX_DB: D1Database;
  REFLEX_BLUEPRINTS: KVNamespace;
  /** Single NATS subject token, e.g. "jc" (same rule as local config). */
  REFLEX_PRINCIPAL: string;
  /** Single NATS subject token. Default "default". */
  REFLEX_STACK?: string;
  /** wss:// URL of the hub's WebSocket listener (DD-70 port 9222). */
  REFLEX_NATS_WS_URL: string;
  /** Secret (REQUIRED): inline .creds file CONTENT (myelin credsContent).
   * There is no insecure fallback on edge — the local daemon's
   * nats.insecure escape hatch is loopback-only by definition, and a
   * Worker has no loopback bus. Missing secret → startup throws. */
  REFLEX_NATS_CREDS: string;
  /** HTTP-blueprint token secrets are looked up by binding name. */
  [binding: string]: unknown;
}

interface Runtime {
  store: BlueprintStore;
  repo: D1Repository;
  bus: ReflexBus;
  pipeline: Pipeline;
  busSource: BusSource;
  http: EdgeHttpSource;
  scheduler: Scheduler;
  heartbeat: EdgeHeartbeat;
}

/**
 * The Reflex edge consumer (reflex#15): ONE Durable Object instance is the
 * single-writer evaluation host — the Worker's fetch handler forwards impulse
 * traffic here, so per-blueprint serialization (Pipeline.chains) holds across
 * the whole deployment, exactly like the local daemon process. Run locks in
 * D1 additionally CAS at the storage layer.
 *
 * The DO holds the myelin WebSocket bus connection (durable subscriptions for
 * bus-kind blueprints + the execution.run.finished consumer). A self-rescheduling
 * alarm is the scheduler heartbeat (F-002): it evaluates due schedule
 * blueprints AND refreshes the blueprint set from KV on cadence — so reflex,
 * not Cloudflare Cron Triggers, owns the schedule clock. v0 uses a plain held
 * connection + alarm keep-alive — the hibernation API requires DO-native
 * WebSockets and is incompatible with a client library's socket; revisit post-v0.
 *
 * Sovereignty: operating this DO against local-classified traffic is
 * governed by DD-122 — the substrate must be declared (trusted_substrates)
 * and the payload-at-rest rule resolved before production traffic.
 */
export class ReflexConsumer {
  private runtime: Runtime | null = null;
  private starting: Promise<Runtime> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ReflexEdgeEnv,
  ) {}

  private cfg(): ReflexConfig {
    return {
      principal: this.env.REFLEX_PRINCIPAL,
      stack: this.env.REFLEX_STACK ?? "default",
      // url/creds are carried for interface completeness; the transport is
      // injected below, so buildNatsTransport (and its fs access) never runs.
      nats: { url: this.env.REFLEX_NATS_WS_URL, creds: "", insecure: false },
      publishQueueLimit: 1000,
      sovereignty: {
        classification: "local",
        data_residency: "CH",
        max_hop: 0,
        frontier_ok: false,
        model_class: "any",
      },
      watchRoots: [],
      activationsDir: "",
    };
  }

  private ensureStarted(): Promise<Runtime> {
    if (this.runtime) return Promise.resolve(this.runtime);
    // A rejected startup must NOT be cached (sage reflex#16 finding): a
    // transient KV/D1/bus failure would otherwise poison every later
    // fetch/alarm until the DO is evicted. Clear the slot on rejection so
    // the next event retries startup.
    this.starting ??= this.start().catch((error: unknown) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async start(): Promise<Runtime> {
    const cfg = this.cfg();
    const store = new BlueprintStore(await loadBlueprintsFromKV(this.env.REFLEX_BLUEPRINTS));
    const repo = new D1Repository(this.env.REFLEX_DB);

    // FAIL CLOSED (sage reflex#16 cycle-2 blocker): a missing secret must
    // never silently downgrade to an unauthenticated remote bus
    // connection — the same invariant the local daemon enforces via the
    // DD-72 creds fail-fast. requireAuth stays hard-true.
    if (!this.env.REFLEX_NATS_CREDS || this.env.REFLEX_NATS_CREDS.trim() === "") {
      throw new Error(
        "REFLEX_NATS_CREDS secret is required — provision the inline .creds content (wrangler secret put REFLEX_NATS_CREDS); there is no insecure mode on edge",
      );
    }
    const transport = new WebSocketTransport({
      servers: this.env.REFLEX_NATS_WS_URL,
      name: `reflex-edge-${cfg.principal}`,
      credsContent: this.env.REFLEX_NATS_CREDS,
      requireAuth: true,
      streamName: REFLEX_STREAM_NAME,
    });
    const bus = createReflexBus(cfg, { transport });

    // Provision the REFLEX JetStream stream (subjects local.{p}.{s}.reflex.>)
    // so publishFired Activation Events persist AND durable consumers (e.g. the
    // cortex reflex-activation bridge) can bind. Idempotent create-if-absent;
    // the local daemon does the same on boot (daemon.ts). Without this, edge
    // fired events are core-only and lost (#25).
    await ensureReflexStream(bus.raw, cfg);

    const pipeline = new Pipeline({ store, repo, bus });
    const busSource = new BusSource(cfg, store, bus, pipeline, repo);
    const http = new EdgeHttpSource(store, pipeline, this.env);
    // F-002: reflex owns the schedule clock. A self-rescheduling DO alarm
    // (EdgeHeartbeat) drives Scheduler.tick — zero Cloudflare Cron Triggers.
    const scheduler = new Scheduler({ store, sink: pipeline });
    const heartbeat = new EdgeHeartbeat(this.state, scheduler, async () => {
      store.swap(await loadBlueprintsFromKV(this.env.REFLEX_BLUEPRINTS));
      await busSource.sync();
    });

    // R-106 lifecycle wiring: Matched Decisions for removed blueprints
    // expire with reason blueprint-removed — same as the local daemon.
    store.onBlueprintsRemoved((ids) => {
      const now = new Date().toISOString();
      for (const id of ids) {
        void repo.expireForBlueprint(id, now).catch((error: unknown) => {
          console.error(`[reflex-edge] expireForBlueprint(${id}) failed: ${(error as Error).message}`);
        });
      }
    });

    await busSource.start();
    await heartbeat.arm(); // start the heartbeat (schedule eval + KV refresh)

    this.runtime = { store, repo, bus, pipeline, busSource, http, scheduler, heartbeat };
    return this.runtime;
  }

  /**
   * Protocol from the Worker front (which allowlists what the public
   * internet can reach — see worker.ts):
   * - GET /status — counters + active subscriptions + heartbeat (internal)
   * - /impulse/* — the public HTTP impulse surface (EdgeHttpSource)
   *
   * F-002: the old POST /schedule Cron-Trigger forward is gone — scheduling
   * is driven internally by the DO alarm (EdgeHeartbeat), not by CF crons.
   */
  async fetch(request: Request): Promise<Response> {
    const runtime = await this.ensureStarted();
    const url = new URL(request.url);

    // SECURITY (sage reflex#16 blocker): /status is INTERNAL — the Worker
    // front forwards only /impulse/* from the public internet (worker.ts
    // allowlist).
    if (url.pathname === "/status" && request.method === "GET") {
      const heartbeat = await runtime.heartbeat.load();
      return Response.json({
        blueprints: runtime.store.current().length,
        busSubscriptions: runtime.busSource.active(),
        scheduleBlueprints: runtime.store.byKind("schedule").map((b) => b.id),
        heartbeat: { lastTick: heartbeat.lastTick, periodMs: ALARM_PERIOD_MS },
        bus: runtime.bus.metrics(),
      });
    }

    return runtime.http.handle(request);
  }

  /**
   * Alarm = the scheduler heartbeat (F-002): evaluate due schedule blueprints
   * over (lastTick, now], refresh blueprints from KV on cadence, persist
   * lastTick, and re-arm. EdgeHeartbeat.onAlarm re-arms in its own finally;
   * the catch below covers a hard failure BEFORE the heartbeat runs (e.g.
   * startup) so the clock can never stop.
   */
  async alarm(): Promise<void> {
    try {
      const runtime = await this.ensureStarted();
      const result = await runtime.heartbeat.onAlarm();
      if (result.errors.length > 0) {
        console.warn(`[reflex-edge] schedule tick: ${result.errors.length} blueprint error(s): ${JSON.stringify(result.errors)}`);
      }
      if (result.collapsed.length > 0) {
        console.info(`[reflex-edge] schedule tick: collapsed ${result.collapsed.length} blueprint(s) after a gap`);
      }
    } catch (error) {
      console.error(`[reflex-edge] heartbeat failed before tick: ${(error as Error).message}`);
      await this.state.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
    }
  }
}
