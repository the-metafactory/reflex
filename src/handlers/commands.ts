import type { BlueprintStore } from "../activation/store";
import type { ReflexActor } from "../bus/envelopes";
import { Pipeline } from "../pipeline/evaluate";
import type { Impulse } from "../pipeline/impulse";
import { ConflictError, type Repository } from "../store/repository";

export type HandlerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: "not-found" | "conflict" | "invalid-input" | "internal";
        message: string;
        currentState?: string;
      };
    };

export interface FireData {
  outcome: "ignored" | "matched" | "blocked" | "fired";
  decisionId?: string;
  reason?: string;
  correlationId?: string;
  expiresAt?: string;
}

export interface ResolveData {
  outcome: "fired" | "blocked" | "denied" | "ignored";
  decisionId?: string;
  reason?: string;
}

/** A Matched Decision awaiting approval (canonical core name — the friendly
 * CLI verb `pending` exists only at the R-107 surface, per CONTEXT.md). */
export interface WaitingApproval {
  decisionId: string;
  blueprintId: string;
  matchedAt: string;
  expiresAt: string;
  impulseSummary: string;
}

/**
 * Transport-agnostic operator command handlers (design §8 business logic).
 * R-107 binds these to NATS request/reply; Cortex later issues the same
 * commands. Handlers return typed results — never throw across the wire
 * boundary; conflicts carry the ACTUAL current state for honest rendering.
 */
export class CommandHandlers {
  constructor(
    private readonly store: BlueprintStore,
    private readonly pipeline: Pipeline,
    private readonly repo: Repository,
  ) {}

  /** Manual fire: full pipeline, no bypass (grill decision 17). */
  async fire(
    blueprintId: string,
    input: Record<string, unknown>,
    actor: ReflexActor,
  ): Promise<HandlerResult<FireData>> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return invalid(`--input must be a JSON object, got ${Array.isArray(input) ? "array" : typeof input}`);
    }
    const blueprint = this.store.get(blueprintId);
    if (!blueprint) {
      return {
        ok: false,
        error: {
          code: "not-found",
          message: `No Activation Blueprint "${blueprintId}" loaded${nearestHint(blueprintId, this.store)}`,
        },
      };
    }
    const impulse: Impulse = {
      kind: "manual",
      blueprintId,
      payload: input,
      receivedAt: new Date().toISOString(),
      actor,
    };
    try {
      const result = await this.pipeline.evaluate(impulse);
      switch (result.outcome) {
        case "ignored":
          return ok({ outcome: "ignored", reason: result.reason });
        case "matched":
          return ok({ outcome: "matched", decisionId: result.decisionId, expiresAt: result.expiresAt });
        case "blocked":
          return ok({ outcome: "blocked", decisionId: result.decisionId, reason: result.reason });
        case "fired":
          return ok({ outcome: "fired", decisionId: result.decisionId, correlationId: result.correlationId });
      }
    } catch (error) {
      return internal("fire", error as Error);
    }
  }

  async approve(decisionId: string, actor: ReflexActor): Promise<HandlerResult<ResolveData>> {
    try {
      const result = await this.pipeline.resolveMatched(decisionId, "approve", actor);
      if (result.outcome === "fired") return ok({ outcome: "fired", decisionId: result.decisionId });
      if (result.outcome === "blocked")
        return ok({ outcome: "blocked", decisionId: result.decisionId, reason: result.reason });
      return ok({ outcome: "ignored", reason: "blueprint-removed" });
    } catch (error) {
      return mapResolveError(decisionId, error as Error);
    }
  }

  async deny(decisionId: string, actor: ReflexActor): Promise<HandlerResult<ResolveData>> {
    try {
      const result = await this.pipeline.resolveMatched(decisionId, "deny", actor);
      if (result.outcome === "denied") {
        return ok({ outcome: "denied", decisionId: result.decisionId });
      }
      // resolveMatched(deny) only produces denied today — branch defensively
      // so a future pipeline change can never masquerade as a denial.
      return internal("deny", new Error(`unexpected resolution outcome "${result.outcome}"`));
    } catch (error) {
      return mapResolveError(decisionId, error as Error);
    }
  }

  /** Matched Decisions awaiting approval. R-107 maps its `pending` CLI verb here. */
  listWaiting(): HandlerResult<WaitingApproval[]> {
    try {
      const waiting = this.repo.listWaiting();
      return ok(
        waiting.map((w) => ({
          decisionId: w.decisionId,
          blueprintId: w.decision.blueprintId,
          matchedAt: w.decision.createdAt,
          expiresAt: w.expiresAt,
          impulseSummary: `${w.decision.impulse.kind}: ${Object.keys(w.decision.impulse.payload).join(", ") || "(empty payload)"}`,
        })),
      );
    } catch (error) {
      return internal("list-waiting", error as Error);
    }
  }
}

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function invalid<T>(message: string): HandlerResult<T> {
  return { ok: false, error: { code: "invalid-input", message } };
}

function internal<T>(operation: string, error: Error): HandlerResult<T> {
  return { ok: false, error: { code: "internal", message: `${operation} failed: ${error.message}` } };
}

function mapResolveError<T>(decisionId: string, error: Error): HandlerResult<T> {
  if (error instanceof ConflictError) {
    return {
      ok: false,
      error: {
        code: "conflict",
        message: `Decision ${decisionId} already resolved — current state: ${error.currentState}`,
        currentState: error.currentState,
      },
    };
  }
  if (error.message.includes("not found")) {
    return { ok: false, error: { code: "not-found", message: error.message } };
  }
  return internal("resolve", error);
}

/** Cheap nearest-id hint: loaded ids sharing the longest common prefix. */
function nearestHint(missing: string, store: BlueprintStore): string {
  const candidates = store
    .current()
    .map((b) => b.id)
    .map((id) => ({ id, score: commonPrefix(id, missing) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.id);
  return candidates.length > 0 ? ` — did you mean: ${candidates.join(", ")}?` : "";
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
