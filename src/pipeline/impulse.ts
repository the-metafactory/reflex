import type { ReflexActor } from "../bus/envelopes";
import type { ImpulseKind } from "../activation/types";

/**
 * An observed input fact the pipeline evaluates (CONTEXT.md: Impulse).
 * Every impulse arrives already attributed to one blueprint: schedule and
 * manual/http carry the id by construction; bus impulses are attributed by
 * the subscription matcher (R-108) before reaching the pipeline.
 */
export interface Impulse {
  kind: ImpulseKind;
  blueprintId: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  actor: ReflexActor;
  /** Present for bus-kind impulses: provenance of the matched envelope. */
  sourceEnvelope?: { id: string; type: string; correlationId?: string };
}

export type GuardReason = "idempotency" | "cooldown" | "run-lock" | "run-lock-buffered";

export type EvaluateResult =
  | { outcome: "ignored"; reason: "no-match" | "disabled" | "paused" }
  | { outcome: "matched"; decisionId: string; expiresAt: string }
  | { outcome: "blocked"; decisionId: string; reason: GuardReason }
  | { outcome: "fired"; decisionId: string; correlationId: string };

/** Stable JSON: object keys sorted recursively so key derivation is canonical. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Idempotency Key (CONTEXT.md): stable identity deduplicating equivalent
 * activations — hash of blueprint id + canonical payload.
 *
 * Async since reflex#15: Cloudflare Workers have no Bun.CryptoHasher and
 * Web Crypto's digest is promise-only. On Bun the fast sync hasher still
 * runs; the promise wrapper costs one microtask. Streaming update(a) +
 * update(b) equals hashing the concatenation, so both paths produce the
 * same digest as the pre-#15 implementation.
 */
export async function deriveIdempotencyKey(
  blueprintId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const material = blueprintId + canonicalJson(payload);
  if (typeof Bun !== "undefined") {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(material);
    return hasher.digest("hex");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Dedup window: DD-71 Stage-4 precedent (10 minutes). Constant in v0. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
