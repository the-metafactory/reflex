import { timingSafeEqual } from "node:crypto";
import type { BlueprintStore } from "../activation/store";
import type { HttpWhen } from "../activation/types";
import type { EvaluateResult, Impulse } from "../pipeline/impulse";

/** Pipeline slice the http source needs — injectable for tests. */
export interface HttpSink {
  evaluate(impulse: Impulse): Promise<EvaluateResult>;
}

export interface HttpSourceOptions {
  /** 0 = ephemeral (tests). Default 7717. */
  port?: number;
  /** Requests per minute per blueprint. Default 60. */
  rateLimitPerMinute?: number;
}

const MAX_BODY_BYTES = 256 * 1024;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Minimal HTTP Impulse Source (decision 12): localhost-only listener, one
 * route per http-kind blueprint (`POST /impulse/{blueprint-id}`), bearer
 * auth only. Auth ALWAYS precedes existence — unauthenticated callers can
 * never distinguish a missing blueprint from a bad token (spec FR-6).
 * Everything richer (public exposure, provider signatures) is post-v0.
 */
export class HttpSource {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private buckets = new Map<string, Bucket>();
  private readonly rateLimit: number;
  private readonly portOption: number;
  private misconfigWarned = new Set<string>();

  constructor(
    private readonly store: BlueprintStore,
    private readonly sink: HttpSink,
    options: HttpSourceOptions = {},
  ) {
    this.portOption = options.port ?? 7717;
    this.rateLimit = options.rateLimitPerMinute ?? 60;
  }

  /** Bound port when running, else null. */
  port(): number | null {
    return this.server?.port ?? null;
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: "127.0.0.1", // v0 policy: localhost only — never configurable here
      port: this.portOption,
      fetch: (request) => this.handle(request),
    });
    console.info(`[reflex-http] listening on 127.0.0.1:${this.server.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.stop(true);
    this.server = null;
  }

  private async handle(request: Request): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    const response = await this.route(request, url);
    const ip = this.server ? (this.server.requestIP(request)?.address ?? "?") : "?";
    // Access log: never the Authorization header (spec FR-8).
    console.info(
      `[reflex-http] ${request.method} ${url.pathname} ${response.status} ${(performance.now() - started).toFixed(1)}ms ${ip}`,
    );
    return response;
  }

  private async route(request: Request, url: URL): Promise<Response> {
    // Canonical Impulse vocabulary on the public surface (CONTEXT.md:
    // "hook" is an Avoid alias) — the route is /impulse/{blueprint-id}.
    const match = /^\/impulse\/([a-z0-9][a-z0-9-]*)$/.exec(url.pathname);
    if (!match) return json(404, { error: "unknown path" });
    if (request.method !== "POST") return json(405, { error: "POST only" });
    const blueprintId = match[1]!;

    // AUTH FIRST (FR-6): resolve the expected token only if the blueprint
    // exists; otherwise compare against nothing and return 401 — existence
    // is never observable without a valid token.
    const presented = bearerOf(request);
    const blueprint = this.store.get(blueprintId);
    const tokenEnv = blueprint && blueprint.kind === "http" ? (blueprint.when as HttpWhen).http.token_env : undefined;
    const expected = tokenEnv ? process.env[tokenEnv] : undefined;

    if (blueprint && blueprint.kind === "http" && tokenEnv && expected === undefined) {
      if (!this.misconfigWarned.has(blueprintId)) {
        this.misconfigWarned.add(blueprintId);
        console.error(`[reflex-http] ${blueprintId}: token_env ${tokenEnv} is unset — route disabled (503)`);
      }
      return json(503, { error: "route misconfigured — see reflex daemon log" });
    }
    if (!presented || !expected || !constantTimeEquals(presented, expected)) {
      return json(401, { error: "unauthorized" });
    }
    if (!blueprint || blueprint.kind !== "http") {
      // Prune per-blueprint state for ids that no longer resolve — a long
      // daemon under hot-reload churn must not grow buckets unboundedly.
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
      // 202: the impulse was ACCEPTED; the pipeline's verdict rides along
      // honestly (a blocked outcome is not an HTTP error — spec scenario 3).
      return json(202, {
        outcome: result.outcome,
        ...("decisionId" in result ? { decision_id: result.decisionId } : {}),
        ...("reason" in result ? { reason: result.reason } : {}),
      });
    } catch (error) {
      console.error(`[reflex-http] evaluate failed for ${blueprintId}: ${(error as Error).message}`);
      return json(500, { error: "internal — see reflex daemon log" });
    }
  }

  /** Continuous-refill token bucket per blueprint (FR-7). */
  private takeToken(blueprintId: string): boolean {
    const now = performance.now();
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

/** timingSafeEqual on equal-length buffers; length mismatch fails without compare. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Byte-counted streaming read with a hard cap: chunked or lengthless bodies
 * abort the moment the running BYTE count (not UTF-16 chars) exceeds the
 * limit — memory stays bounded by the cap, never by the request (sage R-109).
 */
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
