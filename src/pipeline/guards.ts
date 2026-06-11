import type { ActivationBlueprint } from "../activation/types";
import type { RepositoryPort } from "../store/port";
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
 *
 * Async since reflex#15: storage is a RepositoryPort (the edge D1 driver
 * has no sync API) and key derivation uses Web Crypto off Bun. The local
 * sync Repository satisfies the port unchanged.
 */
export async function checkGuards(
  blueprint: ActivationBlueprint,
  impulse: Impulse,
  repo: RepositoryPort,
  now: string,
): Promise<GuardCheck> {
  const idempotencyKey = await deriveIdempotencyKey(blueprint.id, impulse.payload);

  if (await repo.hasIdempotencyKey(blueprint.id, idempotencyKey, now)) {
    return { pass: false, reason: "idempotency", detail: `duplicate activation within window (key ${idempotencyKey.slice(0, 12)}…)`, idempotencyKey };
  }

  const guardState = await repo.getGuardState(blueprint.id);
  // Numeric compare, NOT lexical: '…T12:00:00Z' and '…T12:00:00.000Z' are the
  // same instant but sort differently as strings (sage R-104 finding).
  if (
    blueprint.guards.cooldownMs !== undefined &&
    guardState?.cooldownUntil &&
    Date.parse(guardState.cooldownUntil) > Date.parse(now)
  ) {
    return { pass: false, reason: "cooldown", detail: `cooldown until ${guardState.cooldownUntil}`, idempotencyKey };
  }

  if (blueprint.guards.runLock !== undefined && guardState?.runLockHolder) {
    const reason: GuardReason = blueprint.guards.runLock === "buffer" ? "run-lock-buffered" : "run-lock";
    return { pass: false, reason, detail: `run in flight (correlation ${guardState.runLockHolder})`, idempotencyKey };
  }

  return { pass: true, idempotencyKey };
}
