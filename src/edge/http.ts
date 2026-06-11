import type { BlueprintStore } from "../activation/store";
import type { HttpWhen } from "../activation/types";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";

/** Pipeline slice the edge http source needs — injectable for tests. */
export interface EdgeHttpSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
}

export interface EdgeHttpOptions {
  /** Requests per minute per blueprint. Default 60. PER-ISOLATE — see note. */
  rateLimitPerMinute?: number;
}

const MAX_BODY_BYTES = 256 * 1024;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Workers-native HTTP Impulse Source (reflex#15) — R-109 semantic parity
 * on the `fetch` handler instead of Bun.serve:
 *
 * - route `POST /impulse/{blueprint-id}`, bearer auth only
 * - AUTH ALWAYS PRECEDES EXISTENCE: unauthenticated callers can never
 *   distinguish a missing blueprint from a bad token (R-109 FR-6)
 * - constant-time token compare (XOR over bytes — no Node Buffer on edge)
 * - bounded body read (256 KB, byte-counted, chunked bodies included)
 * - 202 with the honest pipeline verdict riding along
 *
 * Differences from R-109, by the nature of the platform:
 * - tokens come from Worker secret bindings (`env`), not process.env —
 *   `token_env` names the BINDING
 * - the rate limit bucket is PER-ISOLATE, not global: Cloudflare may run
 *   many isolates, so the effective global limit is N×configured. Treat
 *   it as an abuse brake, not an exact quota (documented in edge README).
 * - localhost-only does not apply — the Worker URL is the exposure
 *   boundary; bearer auth is the gate.
 */
export class EdgeHttpSource {
  private buckets = new Map<string, Bucket>();
  private readonly rateLimit: number;
  private misconfigWarned = new Set<string>();

  constructor(
    private readonly store: BlueprintStore,
    private readonly sink: EdgeHttpSink,
    /** Worker bindings object — token_env names a secret binding on it. */
    private readonly secrets: Record<string, unknown>,
    options: EdgeHttpOptions = {},
  ) {
    this.rateLimit = options.rateLimitPerMinute ?? 60;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/impulse\/([a-z0-9][a-z0-9-]*)$/.exec(url.pathname);
    if (!match) return json(404, { error: "unknown path" });
    if (request.method !== "POST") return json(405, { error: "POST only" });
    const blueprintId = match[1]!;

    // AUTH FIRST (R-109 FR-6): resolve the expected token only if the
    // blueprint exists; otherwise compare against nothing and 401 —
    // existence is never observable without a valid token.
    const presented = bearerOf(request);
    const blueprint = this.store.get(blueprintId);
    const tokenBinding =
      blueprint && blueprint.kind === "http" ? (blueprint.when as HttpWhen).http.token_env : undefined;
    const expectedRaw = tokenBinding ? this.secrets[tokenBinding] : undefined;
    const expected = typeof expectedRaw === "string" ? expectedRaw : undefined;

    if (blueprint && blueprint.kind === "http" && tokenBinding && expected === undefined) {
      if (!this.misconfigWarned.has(blueprintId)) {
        this.misconfigWarned.add(blueprintId);
        console.error(`[reflex-edge-http] ${blueprintId}: secret binding ${tokenBinding} is unset — route disabled (503)`);
      }
      return json(503, { error: "route misconfigured — see worker log" });
    }
    if (!presented || !expected || !constantTimeEquals(presented, expected)) {
      return json(401, { error: "unauthorized" });
    }
    if (!blueprint || blueprint.kind !== "http") {
      this.buckets.delete(blueprintId);
      this.misconfigWarned.delete(blueprintId);
      return json(404, { error: `no http Activation Blueprint "${blueprintId}" loaded` });
    }

    if (!this.takeToken(blueprintId)) {
      const retryAfter = Math.ceil(60 / this.rateLimit);
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
      });
    }

    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return json(415, { error: "content-type must be application/json" });
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });
    const raw = await readBounded(request, MAX_BODY_BYTES);
    if (raw === null) return json(413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw === "" ? "{}" : raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(422, { error: "body must be a JSON object" });
    }

    const impulse: Impulse = {
      kind: "http",
      blueprintId,
      payload,
      receivedAt: new Date().toISOString(),
      actor: { type: "system", id: `http:${blueprintId}` },
    };
    try {
      const result = await this.sink.evaluate(impulse);
      return json(202, {
        outcome: result.outcome,
        ...("decisionId" in result ? { decision_id: result.decisionId } : {}),
        ...("reason" in result ? { reason: result.reason } : {}),
      });
    } catch (error) {
      console.error(`[reflex-edge-http] evaluate failed for ${blueprintId}: ${(error as Error).message}`);
      return json(500, { error: "internal — see worker log" });
    }
  }

  /** Continuous-refill token bucket per blueprint — per isolate (see class doc). */
  private takeToken(blueprintId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(blueprintId) ?? { tokens: this.rateLimit, lastRefill: now };
    bucket.tokens = Math.min(this.rateLimit, bucket.tokens + ((now - bucket.lastRefill) / 60_000) * this.rateLimit);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      this.buckets.set(blueprintId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(blueprintId, bucket);
    return true;
  }
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time compare without Node's timingSafeEqual: XOR-accumulate
 * over equal-length byte arrays. Length mismatch fails fast — length is
 * not secret here (tokens are operator-chosen).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i]! ^ bufB[i]!;
  return diff === 0;
}

/** Byte-counted streaming read with a hard cap (R-109 parity, no Buffer). */
async function readBounded(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
