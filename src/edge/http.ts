import type { BlueprintStore } from "../activation/store";
import type { ActivationBlueprint, HttpAuthMode, HttpWhen } from "../activation/types";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";
import { matches } from "../sources/bus";

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
 * Workers-native HTTP Impulse Source (reflex#15, F-003) — R-109 semantic parity
 * on the `fetch` handler instead of Bun.serve:
 *
 * - route `POST /impulse/{blueprint-id}`
 * - two auth modes (`when.http.auth.mode`): `bearer` (Authorization: Bearer)
 *   and `github_hmac` (verify X-Hub-Signature-256 over the raw body) — `token_env`
 *   is the legacy Bearer shorthand. GitHub webhooks use github_hmac (F-003).
 * - AUTH ALWAYS PRECEDES EXISTENCE: an unauthenticated caller can never
 *   distinguish a missing blueprint from a bad credential (R-109 FR-6)
 * - constant-time credential compare (XOR over bytes — no Node Buffer on edge)
 * - bounded body read (256 KB, byte-counted); HMAC is over the EXACT raw bytes
 * - optional `where` flat field-equals filter (same matcher as bus); github_hmac
 *   injects top-level `github_event`/`repository`/`github_delivery` before matching
 * - 202 with the honest pipeline verdict riding along
 *
 * Platform differences from R-109: credentials come from Worker secret
 * bindings (`env`), not process.env; the rate-limit bucket is PER-ISOLATE
 * (abuse brake, not exact quota); localhost-only does not apply.
 */
export class EdgeHttpSource {
  private buckets = new Map<string, Bucket>();
  private readonly rateLimit: number;
  private misconfigWarned = new Set<string>();

  constructor(
    private readonly store: BlueprintStore,
    private readonly sink: EdgeHttpSink,
    /** Worker bindings object — secret_env/token_env name a secret binding on it. */
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

    // Body-shape gates (mode-independent — leak no existence/auth info).
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return json(415, { error: "content-type must be application/json" });
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });

    // Read the raw bytes ONCE: github_hmac verifies over these exact bytes,
    // and the JSON body is parsed from the same bytes (never re-serialized).
    const bytes = await readBoundedBytes(request, MAX_BODY_BYTES);
    if (bytes === null) return json(413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });

    const authed = await this.authorize(request, blueprintId, bytes);
    if (authed instanceof Response) return authed;
    const blueprint = authed;

    if (!this.takeToken(blueprintId)) {
      const retryAfter = Math.ceil(60 / this.rateLimit);
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
      });
    }

    const raw = new TextDecoder().decode(bytes);
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw === "" ? "{}" : raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(422, { error: "body must be a JSON object" });
    }

    const httpWhen = (blueprint.when as HttpWhen).http;
    // github_hmac: inject top-level matchable/dedup fields. `repository` is
    // compacted to its full_name string so flat `where` can match it (the rest
    // of the GitHub payload is preserved); `github_delivery` feeds the pipeline
    // idempotency key so a redelivered webhook fires once.
    if (authModeOf(httpWhen) === "github_hmac") {
      const repo = payload.repository as { full_name?: unknown } | undefined;
      payload = {
        ...payload,
        github_event: request.headers.get("x-github-event") ?? undefined,
        repository: typeof repo?.full_name === "string" ? repo.full_name : undefined,
        github_delivery: request.headers.get("x-github-delivery") ?? undefined,
      };
    }

    if (httpWhen.where && !matches(httpWhen.where, payload)) {
      return json(202, { outcome: "ignored", reason: "no-match" });
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

  /**
   * Auth + existence resolution (R-109 FR-6, tightened per sage reflex#16):
   * a caller without a VALID credential always sees 401 — including for missing
   * blueprints (no secret → auth fails) and misconfigured routes (secret binding
   * unset, logged once). Only a VALID credential against a non-http/missing
   * blueprint reveals 404. Returns the resolved http blueprint on success.
   */
  private async authorize(
    request: Request,
    blueprintId: string,
    bytes: Uint8Array,
  ): Promise<ActivationBlueprint | Response> {
    const blueprint = this.store.get(blueprintId);
    const httpWhen = blueprint && blueprint.kind === "http" ? (blueprint.when as HttpWhen).http : undefined;
    const mode = httpWhen ? authModeOf(httpWhen) : undefined;
    const secretEnv = httpWhen ? (httpWhen.auth?.secret_env ?? httpWhen.token_env) : undefined;
    const expectedRaw = secretEnv ? this.secrets[secretEnv] : undefined;
    const expected = typeof expectedRaw === "string" ? expectedRaw : undefined;

    // Misconfig: an http blueprint names a secret binding that is unset →
    // route disabled, logged once, indistinguishable from missing (401).
    if (httpWhen && secretEnv && expected === undefined) {
      if (!this.misconfigWarned.has(blueprintId)) {
        this.misconfigWarned.add(blueprintId);
        console.error(`[reflex-edge-http] ${blueprintId}: secret binding ${secretEnv} is unset — route disabled (401 to callers)`);
      }
      return json(401, { error: "unauthorized" });
    }

    let authOk = false;
    if (expected !== undefined) {
      if (mode === "github_hmac") {
        authOk = await verifyGithubSignature(bytes, expected, request.headers.get("x-hub-signature-256"));
      } else if (mode === "bearer") {
        const presented = bearerOf(request);
        authOk = !!presented && constantTimeEquals(presented, expected);
      }
    }
    if (!authOk) return json(401, { error: "unauthorized" });

    if (!blueprint || blueprint.kind !== "http") {
      this.buckets.delete(blueprintId);
      this.misconfigWarned.delete(blueprintId);
      return json(404, { error: `no http Activation Blueprint "${blueprintId}" loaded` });
    }
    return blueprint;
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

/** Resolve the auth mode for an http when-block: explicit auth.mode, else the
 *  token_env Bearer shorthand. */
function authModeOf(httpWhen: HttpWhen["http"]): HttpAuthMode | undefined {
  if (httpWhen.auth) return httpWhen.auth.mode;
  if (httpWhen.token_env) return "bearer";
  return undefined;
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verify a GitHub `X-Hub-Signature-256` header (`sha256=<hex>`) against
 * HMAC-SHA256(secret, rawBody) using Web Crypto (no Node built-ins). The HMAC
 * is computed over the EXACT received bytes; the hex compare is constant-time.
 */
async function verifyGithubSignature(bytes: Uint8Array, secret: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const expectedHex = header.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(bytes));
  const actualHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return constantTimeEquals(actualHex, expectedHex);
}

/**
 * Constant-time compare without Node's timingSafeEqual: XOR-accumulate over
 * equal-length byte arrays. Length mismatch fails fast — length is not secret.
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

/** Byte-counted streaming read with a hard cap (R-109 parity, no Buffer). Returns
 *  the exact bytes (the caller decodes for JSON and HMACs over them). */
async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
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
  return merged;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
