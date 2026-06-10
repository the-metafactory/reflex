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

export const configSchema = z.object({
  principal: z.string().min(1),
  stack: z.string().min(1).default("default"),
  nats: z
    .object({
      url: z.string().url().default("nats://127.0.0.1:4222"),
      creds: z.string().min(1).default(join(homedir(), ".config/nats/creds/reflex.creds")),
    })
    .default({}),
  publish_queue_limit: z.number().int().positive().default(1000),
  sovereignty: sovereigntySchema.default({}),
});

export interface ReflexConfig {
  principal: string;
  stack: string;
  nats: { url: string; creds: string };
  publishQueueLimit: number;
  sovereignty: z.infer<typeof sovereigntySchema>;
}
