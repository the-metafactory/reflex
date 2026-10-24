import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

export const sovereigntySchema = z.object({
  classification: z.enum(["local", "federated", "public"]).default("local"),
  data_residency: z.string().default("CH"),
  max_hop: z.number().int().min(0).default(0),
  frontier_ok: z.boolean().default(false),
  model_class: z.enum(["local-only", "frontier", "any"]).default("any"),
});

/**
 * principal/stack are interpolated into NATS subjects — they must be single
 * safe tokens. Wildcards (`*`, `>`) or separators (`.`) in a config/env value
 * would silently broaden the REFLEX stream scope (sage R-101 security finding).
 */
const subjectToken = (name: string) =>
  z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, {
      message: `${name} must be a single NATS subject token ([A-Za-z0-9_-]) — '.', '*', '>' are not allowed`,
    });

export const configSchema = z.object({
  principal: subjectToken("principal"),
  stack: subjectToken("stack").default("default"),
  nats: z
    .object({
      url: z.string().url().default("nats://127.0.0.1:4222"),
      creds: z.string().min(1).default(join(homedir(), ".config/nats/creds/reflex.creds")),
      /** Dev-only: connect unauthenticated (matches current ecosystem
       * practice — cortex/sage connect insecure to the local bus). The
       * daemon warns loudly; production keeps the DD-72 creds fail-fast. */
      insecure: z.boolean().default(false),
      /** JetStream management and publish acknowledgement timeout, in ms. */
      timeout_ms: z.number().int().positive().max(2_147_483_647).default(10_000),
    })
    .default({}),
  publish_queue_limit: z.number().int().positive().default(1000),
  sovereignty: sovereigntySchema.default({}),
  /** Roots scanned recursively for reflex.yaml sidecars (R-102). */
  watch_roots: z.array(z.string().min(1)).default([]),
  /** Central activation-blueprint directory (R-102). */
  activations_dir: z
    .string()
    .min(1)
    .default(join(homedir(), ".config/reflex/activations")),
  /** Directory holding this instance's reflex.db (a leading `~/` expands).
   * Unset: the XDG state path (`defaultDbPath()`). A second instance on one
   * machine sets its own so the two never share a DB (reflex#36). */
  state_dir: z.string().min(1).optional(),
});

export interface ReflexConfig {
  principal: string;
  stack: string;
  nats: { url: string; creds: string; insecure: boolean; timeout_ms?: number };
  publishQueueLimit: number;
  sovereignty: z.infer<typeof sovereigntySchema>;
  watchRoots: string[];
  activationsDir: string;
  /** Absolute (`~/` already expanded); undefined = default DB path. */
  stateDir?: string;
}
