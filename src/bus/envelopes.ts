import type { EnvelopePublishInput } from "@the-metafactory/myelin";
import type { ReflexConfig } from "../config/schema";

/** Envelope type for a Fired Decision committing to start an Execution Run. */
export const ACTIVATION_FIRED_TYPE = "reflex.activation.fired";
/** Envelope type prefix for decision audit events; suffixed with the outcome. */
export const ACTIVATION_DECISION_TYPE_PREFIX = "reflex.activation.decision";

/** Who/what produced an impulse or resolution. Rides extensions.actor. */
export interface ReflexActor {
  type: "operator" | "agent" | "system";
  id: string;
}

/** Published decision outcomes. Ignored Decisions are counters, never wire events. */
export type PublishedDecisionOutcome = "matched" | "blocked" | "fired" | "denied" | "expired";

const PUBLISHED_OUTCOMES: ReadonlySet<string> = new Set([
  "matched",
  "blocked",
  "fired",
  "denied",
  "expired",
]);

/** Myelin derives the principal from the source's first segment. */
export function reflexSource(cfg: Pick<ReflexConfig, "principal">): string {
  return `${cfg.principal}.reflex.activation`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Myelin requires correlation_id to be a UUID when present. Enforce at the
 * builder boundary so a bad caller value fails HERE with a named error, not
 * later inside envelope validation (sage R-101 cycle-3 finding).
 */
function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${field} must be a UUID (myelin correlation contract), got: "${value}"`);
  }
}

export interface ActivationFiredInput {
  /** Target Execution Blueprint reference (opaque to Reflex). */
  target: string;
  /** Activation Payload, shaped toward the target's Run Contract. */
  payload: Record<string, unknown>;
  idempotencyKey: string;
  /** The Fired Decision this event commits. */
  decisionId: string;
  correlationId: string;
  actor: ReflexActor;
  /** Decision that caused this one (e.g. buffering Blocked Decision). */
  causationId?: string;
}

export function buildActivationFired(
  cfg: Pick<ReflexConfig, "principal">,
  input: ActivationFiredInput,
): EnvelopePublishInput {
  assertUuid(input.correlationId, "correlationId");
  return {
    source: reflexSource(cfg),
    type: ACTIVATION_FIRED_TYPE,
    correlation_id: input.correlationId,
    payload: {
      target: input.target,
      payload: input.payload,
      idempotency_key: input.idempotencyKey,
      decision_id: input.decisionId,
    },
    extensions: {
      decision_id: input.decisionId,
      actor: { ...input.actor },
      ...(input.causationId ? { causation_id: input.causationId } : {}),
    },
  };
}

export interface ActivationDecisionInput {
  outcome: PublishedDecisionOutcome;
  blueprintId: string;
  decisionId: string;
  reason?: string;
  actor?: ReflexActor;
  correlationId?: string;
  causationId?: string;
}

export function buildActivationDecision(
  cfg: Pick<ReflexConfig, "principal">,
  input: ActivationDecisionInput,
): EnvelopePublishInput {
  if (!PUBLISHED_OUTCOMES.has(input.outcome)) {
    throw new Error(
      `Decision outcome "${input.outcome}" is not published — ignored decisions are per-blueprint counters, not wire events`,
    );
  }
  if (input.correlationId) assertUuid(input.correlationId, "correlationId");
  return {
    source: reflexSource(cfg),
    type: `${ACTIVATION_DECISION_TYPE_PREFIX}.${input.outcome}`,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    payload: {
      blueprint_id: input.blueprintId,
      decision_id: input.decisionId,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    extensions: {
      decision_id: input.decisionId,
      ...(input.actor ? { actor: { ...input.actor } } : {}),
      ...(input.causationId ? { causation_id: input.causationId } : {}),
    },
  };
}
