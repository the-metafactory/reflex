import type { DecisionOutcome } from "../store/repository";

/**
 * The predicted Activation Decision outcome reported by a Dry Run
 * (CONTEXT.md: Dry Run Verdict). NOT an Activation Decision: it mutates no
 * guard state, emits no events, and is not part of decision history.
 */
export interface DryRunVerdict {
  wouldOutcome: DecisionOutcome;
  /** Human-readable reasons, e.g. "would block: cooldown until 2026-06-10T16:00:00Z". */
  reasons: string[];
}
