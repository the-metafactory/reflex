import type { ReflexConfig } from "../config/schema";

/**
 * THE pulse run-lifecycle contract boundary (pulse#27 still open): the
 * subject Reflex consumes for Execution Run outcomes and how a terminal
 * outcome is detected. When pulse pins its contract, ONLY this file changes.
 */
export function runOutcomeSubject(cfg: Pick<ReflexConfig, "principal" | "stack">): string {
  return `local.${cfg.principal}.${cfg.stack}.pulse.run.>`;
}

const TERMINAL_OUTCOMES = ["succeeded", "failed", "cancelled", "blocked"] as const;
export type RunOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * Detect a terminal Run Outcome from an envelope type, e.g.
 * `pulse.run.succeeded` → "succeeded". Non-terminal lifecycle events
 * (started, progress, …) return null.
 */
export function terminalOutcomeOf(envelopeType: string): RunOutcome | null {
  const suffix = envelopeType.split(".").at(-1);
  return (TERMINAL_OUTCOMES as readonly string[]).includes(suffix ?? "") ? (suffix as RunOutcome) : null;
}
