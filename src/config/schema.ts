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
});

export interface ReflexConfig {
  principal: string;
  stack: string;
  nats: { url: string; creds: string };
  publishQueueLimit: number;
  sovereignty: z.infer<typeof sovereigntySchema>;
  watchRoots: string[];
  activationsDir: string;
}
