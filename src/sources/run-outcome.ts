import type { ReflexConfig } from "../config/schema";

/**
 * The pulse run-lifecycle contract boundary (pulse#27 still open): the
 * subject Reflex consumes and how a terminal outcome is detected. A pulse
 * contract change lands primarily here; note that BusSource.start() also
 * reads `envelope.type` and `envelope.correlation_id` — those two envelope
 * fields are part of the assumed contract surface.
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
