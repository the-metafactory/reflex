import type { BlueprintStore } from "../activation/store";
import type { ReflexBus } from "../bus";
import type { ReflexActor } from "../bus/envelopes";
import { reflexSource } from "../bus/envelopes";
import type { ReflexConfig } from "../config/schema";
import type { CommandHandlers, HandlerResult } from "../handlers/commands";
import type { Pipeline } from "../pipeline/evaluate";
import type { Impulse } from "../pipeline/impulse";
import type { ScheduleSource } from "../sources/schedule";
import type { Repository } from "../store/repository";
import { CMD_REPLY_TYPE, COMMANDS, PROTOCOL_VERSION, cmdSubject, type CmdRequest, type CmdResponse, type Command } from "./protocol";

function validateActor(raw: unknown): ReflexActor | null {
  if (typeof raw !== "object" || raw === null) return null;
  const actor = raw as { type?: unknown; id?: unknown };
  if (actor.type !== "operator" && actor.type !== "agent" && actor.type !== "system") return null;
  if (typeof actor.id !== "string" || actor.id.length === 0 || actor.id.length > 128) return null;
  return { type: actor.type, id: actor.id };
}

export interface RouterDeps {
  cfg: ReflexConfig;
  bus: ReflexBus;
  handlers: CommandHandlers;
  pipeline: Pipeline;
  repo: Repository;
  store: BlueprintStore;
  schedule: ScheduleSource;
  daemonVersion: string;
  startedAt: string;
}

/**
 * Daemon-side command router (decision 7): one replyable subscription per
 * command under `…reflex.cmd.*`. The CLI is a thin requester; Cortex can
 * later issue identical requests. Handler results pass through verbatim —
 * the router adds protocol framing only.
 */
export class CommandRouter {
  /** Per-start instance id: lets operators detect duplicate daemons on one bus. */
  readonly instanceId = crypto.randomUUID();

  constructor(private readonly deps: RouterDeps) {}

  async start(): Promise<void> {
    for (const command of COMMANDS) {
      await this.deps.bus.subscribeReplyable(cmdSubject(this.deps.cfg, command), async (envelope) => {
        const response = await this.dispatch(command, envelope.payload as unknown as CmdRequest);
        return {
          source: reflexSource(this.deps.cfg),
          type: CMD_REPLY_TYPE,
          payload: response as unknown as Record<string, unknown>,
        };
      });
    }
  }

  private async dispatch(command: Command, request: CmdRequest): Promise<CmdResponse> {
    // Protocol gate: this router speaks v1 only — newer/missing versions are
    // rejected, never executed (fail closed; sage R-107 finding).
    if (request?.v !== PROTOCOL_VERSION) {
      return {
        v: PROTOCOL_VERSION,
        ok: false,
        error: { code: "protocol-version", message: `daemon speaks protocol v${PROTOCOL_VERSION}; request carried v${String(request?.v)}` },
      };
    }
    // v0 trust model (spec: single-operator): authorization IS bus access —
    // NATS creds gate the command subjects (DD-72). The actor field is a
    // CLAIMED identity recorded for audit, not an authenticated principal;
    // shape-validated, never trusted for authorization. Signed-envelope
    // identity (myelin identity layer) is the deferred upgrade path.
    const actor = validateActor(request.actor);
    if (!actor) {
      return {
        v: PROTOCOL_VERSION,
        ok: false,
        error: { code: "invalid-input", message: "actor must be {type: operator|agent|system, id: string}" },
      };
    }
    const args = request.args ?? {};
    try {
      const result = await this.execute(command, args, actor);
      return { v: PROTOCOL_VERSION, ok: result.ok, ...(result.ok ? { data: result.data } : { error: result.error }) };
    } catch (error) {
      console.error(`[reflex-cmd] ${command} dispatch failed: ${(error as Error).message}`);
      return {
        v: PROTOCOL_VERSION,
        ok: false,
        error: { code: "internal", message: `${command} failed — see reflex daemon log for detail` },
      };
    }
  }

  private async execute(
    command: Command,
    args: Record<string, unknown>,
    actor: ReflexActor,
  ): Promise<HandlerResult<unknown>> {
    const { handlers, pipeline, repo, store, schedule } = this.deps;
    switch (command) {
      case "fire":
        return handlers.fire(String(args.blueprintId ?? ""), (args.input as Record<string, unknown>) ?? {}, actor);
      case "approve":
        return handlers.approve(String(args.decisionId ?? ""), actor);
      case "deny":
        return handlers.deny(String(args.decisionId ?? ""), actor);
      case "matched":
        return handlers.listWaiting();
      case "list": {
        const kindFilter = args.kind ? String(args.kind) : null;
        const targetFilter = args.target ? String(args.target) : null;
        return {
          ok: true,
          data: store
            .current()
            .filter((b) => (kindFilter ? b.kind === kindFilter : true))
            .filter((b) => (targetFilter ? b.target === targetFilter : true))
            .map((b) => ({
              id: b.id,
              kind: b.kind,
              target: b.target,
              policy: b.policy,
              sourceFile: b.sourceFile,
            })),
        };
      }
      case "history": {
        const limit = Math.min(Number(args.limit ?? 50), 200);
        const rows = repo.historyFor({
          blueprintId: args.blueprintId ? String(args.blueprintId) : undefined,
          limit,
        });
        return {
          ok: true,
          data: rows.map((r) => ({
            decisionId: r.id,
            blueprintId: r.blueprintId,
            outcome: r.outcome,
            reason: r.guardBlockReason,
            resolutionOf: r.resolutionOf,
            at: r.createdAt,
          })),
        };
      }
      case "dry-run": {
        const blueprintId = String(args.blueprintId ?? "");
        const blueprint = store.get(blueprintId);
        if (!blueprint) {
          return { ok: false, error: { code: "not-found", message: `No Activation Blueprint "${blueprintId}" loaded` } };
        }
        const impulse: Impulse = {
          kind: blueprint.kind,
          blueprintId,
          payload: (args.impulse as Record<string, unknown>) ?? {},
          receivedAt: new Date().toISOString(),
          actor,
        };
        return { ok: true, data: pipeline.evaluateDry(impulse) };
      }
      case "status": {
        const blueprints = store.current();
        const byKind: Record<string, number> = {};
        for (const b of blueprints) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
        const waiting = handlers.listWaiting();
        const nextTicks = schedule
          .status()
          .filter((s) => s.nextTick !== null)
          .sort((a, b) => (a.nextTick! < b.nextTick! ? -1 : 1))
          .slice(0, 3);
        return {
          ok: true,
          data: {
            version: this.deps.daemonVersion,
            instanceId: this.instanceId,
            startedAt: this.deps.startedAt,
            blueprints: { total: blueprints.length, byKind },
            waitingApprovals: waiting.ok ? waiting.data.length : -1,
            bus: this.deps.bus.metrics(),
            nextTicks,
          },
        };
      }
    }
  }
}
