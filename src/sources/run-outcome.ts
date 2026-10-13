import { executionRunFinishedSubject, validateExecutionRunFinished } from "@the-metafactory/myelin/edge";
import type { ExecutionRunFinishedPayload, MyelinEnvelope, RunOutcome, ValidationError } from "@the-metafactory/myelin/edge";
import type { ReflexConfig } from "../config/schema";

/** Stack-local execution.run.finished contract for Run Lock release. */
export function runOutcomeSubject(cfg: Pick<ReflexConfig, "principal" | "stack">): string {
  return executionRunFinishedSubject(cfg.principal, cfg.stack);
}

export type RunFinishedResult =
  | { valid: true; correlationId: string; outcome: RunOutcome }
  | { valid: false; errors: ValidationError[] };

/**
 * Validate before reading the lock join key. Payload correlation is always
 * present and may be non-UUID; envelope correlation is optional (Vigil Q34).
 * Every accepted Run Outcome is terminal, so all release the lock equally.
 */
export function readRunFinished(envelope: MyelinEnvelope): RunFinishedResult {
  const validation = validateExecutionRunFinished(envelope);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  // The myelin validator checks the complete payload but returns no type predicate.
  const payload = envelope.payload as unknown as ExecutionRunFinishedPayload;
  return { valid: true, correlationId: payload.correlation_id, outcome: payload.outcome };
}
