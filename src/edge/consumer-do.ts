import type { D1Database, DurableObjectState, KVNamespace } from "@cloudflare/workers-types";
import { WebSocketTransport } from "@the-metafactory/myelin/transport/websocket";
import { BlueprintStore } from "../activation/store";
import { createReflexBus, type ReflexBus } from "../bus";
import { REFLEX_STREAM_NAME } from "../bus/stream";
import type { ReflexConfig } from "../config/schema";
import { Pipeline } from "../pipeline/evaluate";
import { BusSource } from "../sources/bus";
import { EdgeScheduleSource } from "./schedule";
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

/** Blueprint refresh cadence — the edge stand-in for fs.watch hot-reload. */
const REFRESH_ALARM_MS = 5 * 60 * 1000;

interface Runtime {
  store: BlueprintStore;
  repo: D1Repository;
  bus: ReflexBus;
  pipeline: Pipeline;
  busSource: BusSource;
  http: EdgeHttpSource;
  schedule: EdgeScheduleSource;
}

/**
 * The Reflex edge consumer (reflex#15): ONE Durable Object instance is the
 * single-writer evaluation host — the Worker's fetch and scheduled handlers
 * forward everything here, so per-blueprint serialization (Pipeline.chains)
 * holds across the whole deployment, exactly like the local daemon process.
 * Run locks in D1 additionally CAS at the storage layer.
 *
 * The DO holds the myelin WebSocket bus connection (durable subscriptions
 * for bus-kind blueprints + the pulse run-outcome consumer) and refreshes
 * the blueprint set from KV on an alarm. v0 uses a plain held connection +
 * alarm keep-alive — the hibernation API requires DO-native WebSockets and
 * is incompatible with a client library's socket; revisit post-v0.
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

    const pipeline = new Pipeline({ store, repo, bus });
    const busSource = new BusSource(cfg, store, bus, pipeline, repo);
    const http = new EdgeHttpSource(store, pipeline, this.env);
    const schedule = new EdgeScheduleSource(store, pipeline);

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
    await this.state.storage.setAlarm(Date.now() + REFRESH_ALARM_MS);

    this.runtime = { store, repo, bus, pipeline, busSource, http, schedule };
    return this.runtime;
  }

  /**
   * Protocol from the Worker front (which allowlists what the public
   * internet can reach — see worker.ts):
   * - POST /schedule {expression, scheduledTime} — Cron Trigger forward (internal)
   * - GET /status — counters + active subscriptions (internal)
   * - /impulse/* — the public HTTP impulse surface (EdgeHttpSource)
   */
  async fetch(request: Request): Promise<Response> {
    const runtime = await this.ensureStarted();
    const url = new URL(request.url);

    // SECURITY (sage reflex#16 blocker): /schedule and /status are the
    // INTERNAL protocol — the Worker front forwards only /impulse/* from
    // the public internet (worker.ts allowlist), so these paths are
    // reachable solely via the scheduled-handler stub call. Canonical
    // vocabulary: the Impulse Kind is `schedule`; Cloudflare's `cron`
    // field name stays at the platform boundary in worker.ts.
    if (url.pathname === "/schedule" && request.method === "POST") {
      const event = (await request.json()) as { expression: string; scheduledTime: number };
      const results = await runtime.schedule.onScheduled({ cron: event.expression, scheduledTime: event.scheduledTime });
      return Response.json({ evaluated: results.length, outcomes: results.map((r) => r.outcome) });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        blueprints: runtime.store.current().length,
        busSubscriptions: runtime.busSource.active(),
        scheduleExpressions: runtime.schedule.expressions(),
        bus: runtime.bus.metrics(),
      });
    }

    return runtime.http.handle(request);
  }

  /** Alarm = blueprint refresh from KV (edge hot-reload) + re-arm. */
  async alarm(): Promise<void> {
    try {
      const runtime = await this.ensureStarted();
      runtime.store.swap(await loadBlueprintsFromKV(this.env.REFLEX_BLUEPRINTS));
      await runtime.busSource.sync();
    } catch (error) {
      console.error(`[reflex-edge] blueprint refresh failed (kept last good set): ${(error as Error).message}`);
    } finally {
      await this.state.storage.setAlarm(Date.now() + REFRESH_ALARM_MS);
    }
  }
}
