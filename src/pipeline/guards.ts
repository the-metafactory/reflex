import type { ActivationBlueprint } from "../activation/types";
import type { Repository } from "../store/repository";
import { deriveIdempotencyKey } from "./impulse";
import type { GuardReason, Impulse } from "./impulse";

export type GuardCheck =
  | { pass: true; idempotencyKey: string }
  | { pass: false; reason: GuardReason; detail: string; idempotencyKey: string };

/**
 * Activation Guards in fixed order: Idempotency Key → Cooldown → Run Lock
 * (first violation wins; later guards not evaluated — deterministic audit).
 * READ-ONLY: engagement (key insert, cooldown set, lock claim) happens on
 * the fire path, never here — dry runs share this exact code (FR-9).
 */
export function checkGuards(
  blueprint: ActivationBlueprint,
  impulse: Impulse,
  repo: Repository,
  now: string,
): GuardCheck {
  const idempotencyKey = deriveIdempotencyKey(blueprint.id, impulse.payload);

  if (repo.hasIdempotencyKey(blueprint.id, idempotencyKey, now)) {
    return { pass: false, reason: "idempotency", detail: `duplicate activation within window (key ${idempotencyKey.slice(0, 12)}…)`, idempotencyKey };
  }

  const guardState = repo.getGuardState(blueprint.id);
  if (blueprint.guards.cooldownMs !== undefined && guardState?.cooldownUntil && guardState.cooldownUntil > now) {
    return { pass: false, reason: "cooldown", detail: `cooldown until ${guardState.cooldownUntil}`, idempotencyKey };
  }

  if (blueprint.guards.runLock !== undefined && guardState?.runLockHolder) {
    const reason: GuardReason = blueprint.guards.runLock === "buffer" ? "run-lock-buffered" : "run-lock";
    return { pass: false, reason, detail: `run in flight (correlation ${guardState.runLockHolder})`, idempotencyKey };
  }

  return { pass: true, idempotencyKey };
}
