import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ActivationBlueprint, HttpWhen, ImpulseKind, WhenBlock } from "./types";

export const ACTIVATION_SCHEMA_ID = "metafactory/activation/v1";

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const DURATION_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30s | 15m | 6h | 2d` → milliseconds. Throws naming the raw value. */
export function parseDuration(raw: string): number {
  const match = DURATION_RE.exec(raw);
  if (!match) {
    throw new Error(`Invalid duration "${raw}" — expected forms like 30s, 15m, 6h, 2d`);
  }
  return Number(match[1]) * DURATION_MS[match[2] as string]!;
}

const durationSchema = z.string().transform((raw, ctx) => {
  try {
    return parseDuration(raw);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    return z.NEVER;
  }
});

const cronSchema = z.string().superRefine((expr, ctx) => {
  // Single-library rule (plan FR-9): validation constructs the same Croner
  // that R-105 executes — validator and scheduler cannot disagree.
  try {
    new Cron(expr, { paused: true }).stop();
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid cron expression "${expr}": ${(error as Error).message}`,
    });
  }
});

const flatWhere = z
  .record(z.union([z.string(), z.number(), z.boolean()], {
    errorMap: () => ({ message: "where values must be flat (string|number|boolean) — flat fields only in v0" }),
  }))
  .optional();

const httpAuthSchema = z
  .object({
    mode: z.enum(["bearer", "github_hmac"], {
      errorMap: () => ({ message: 'http auth.mode must be "bearer" or "github_hmac"' }),
    }),
    secret_env: z.string().min(1),
  })
  .strict();

const httpWhenSchema = z
  .object({
    token_env: z.string().min(1).optional(),
    auth: httpAuthSchema.optional(),
    where: flatWhere,
  })
  .strict()
  .superRefine((http, ctx) => {
    const hasToken = http.token_env !== undefined;
    const hasAuth = http.auth !== undefined;
    if (hasToken && hasAuth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http: token_env and auth are mutually exclusive — use one (token_env is the Bearer shorthand)",
      });
    }
    if (!hasToken && !hasAuth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http: requires token_env (Bearer shorthand) or an auth block",
      });
    }
  });

const whenSchema = z
  .object({
    schedule: cronSchema.optional(),
    timezone: z.string().optional(),
    manual: z.union([z.literal(true), z.object({}).strict()]).optional(),
    bus: z
      .object({
        subject: z.string().min(1),
        where: flatWhere,
      })
      .strict()
      .optional(),
    http: httpWhenSchema.optional(),
  })
  .strict()
  .superRefine((when, ctx) => {
    const kinds = (["schedule", "manual", "bus", "http"] as const).filter((k) => when[k] !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `When Block must declare exactly one Impulse Kind (schedule|manual|bus|http), found ${kinds.length ? kinds.join("+") : "none"}`,
      });
    }
    if (when.timezone !== undefined && when.schedule === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "timezone only applies to the schedule kind" });
    }
  });

const runLockSchema = z.union([z.literal("skip"), z.literal("buffer")], {
  errorMap: (_issue, ctx) => ({
    message:
      ctx.data === "allow"
        ? `run_lock has no "allow" value — concurrent runs are allowed by removing the key`
        : `run_lock must be "skip" or "buffer"`,
  }),
});

const entrySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, { message: "id must be a lowercase slug ([a-z0-9-])" }),
    target: z.string().min(1),
    when: whenSchema,
    policy: z.enum(["auto", "approval", "disabled"]).default("auto"),
    approval_timeout: durationSchema.default("1h"),
    guards: z
      .object({
        cooldown: durationSchema.optional(),
        run_lock: runLockSchema.optional(),
      })
      .strict()
      .default({}),
    payload: z.record(z.unknown()).default({}),
  })
  .strict();

const documentSchema = z
  .object({
    schema: z.literal(ACTIVATION_SCHEMA_ID, {
      errorMap: () => ({ message: `schema must be "${ACTIVATION_SCHEMA_ID}"` }),
    }),
    activations: z.array(entrySchema).default([]),
  })
  .strict();

function kindOf(when: Record<string, unknown>): ImpulseKind {
  if (when.schedule !== undefined) return "schedule";
  if (when.manual !== undefined) return "manual";
  if (when.bus !== undefined) return "bus";
  return "http";
}

function normalizeWhen(when: Record<string, unknown>, kind: ImpulseKind): WhenBlock {
  switch (kind) {
    case "schedule":
      return {
        schedule: when.schedule as string,
        ...(when.timezone ? { timezone: when.timezone as string } : {}),
      };
    case "manual":
      return { manual: {} };
    case "bus":
      return { bus: when.bus as BusWhenInner };
    case "http":
      return { http: (when.http ?? {}) as HttpWhen["http"] };
  }
}
type BusWhenInner = { subject: string; where?: Record<string, string | number | boolean> };

/**
 * Parse one YAML document into Activation Blueprints. Errors carry the
 * source file, the zod path, and the message (spec FR-8).
 */
export function parseActivationDocument(text: string, sourceFile: string): ActivationBlueprint[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`${sourceFile}: YAML parse error — ${(error as Error).message}`);
  }
  const result = documentSchema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`${sourceFile}: invalid activation document\n  ${detail}`);
  }
  return result.data.activations.map((entry) => {
    const kind = kindOf(entry.when as Record<string, unknown>);
    return {
      id: entry.id,
      target: entry.target,
      kind,
      when: normalizeWhen(entry.when as Record<string, unknown>, kind),
      policy: entry.policy,
      approvalTimeoutMs: entry.approval_timeout,
      guards: {
        ...(entry.guards.cooldown !== undefined ? { cooldownMs: entry.guards.cooldown } : {}),
        ...(entry.guards.run_lock !== undefined ? { runLock: entry.guards.run_lock } : {}),
      },
      payload: entry.payload,
      sourceFile,
    };
  });
}
