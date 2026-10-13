/**
 * Canonical glossary types (reflex/CONTEXT.md): one configuration entry =
 * one Activation Blueprint with exactly one implicit Activation Rule in v0.
 * The When Block declares the Impulse Source; Impulse Kinds are the closed
 * set schedule | manual | bus | http.
 */
export type ImpulseKind = "schedule" | "manual" | "bus" | "http";

export interface ScheduleWhen {
  schedule: string;
  timezone?: string;
}
export interface ManualWhen {
  manual: Record<string, never> | true;
}
export interface BusWhen {
  bus: {
    subject: string;
    where?: Record<string, string | number | boolean>;
  };
}
export type HttpAuthMode = "bearer" | "github_hmac";

export interface HttpAuth {
  /** `bearer` = Authorization: Bearer <secret>. `github_hmac` = verify the
   *  X-Hub-Signature-256 HMAC-SHA256 of the raw body with <secret>. */
  mode: HttpAuthMode;
  /** Worker secret BINDING name holding the secret (never the value). */
  secret_env: string;
}

export interface HttpWhen {
  http: {
    /** Bearer shorthand — equivalent to auth: { mode: "bearer", secret_env: <token_env> }.
     *  Mutually exclusive with `auth`. Retained for back-compat; `auth` is the general form. */
    token_env?: string;
    /** Generic auth block. Mutually exclusive with token_env. */
    auth?: HttpAuth;
    /** Flat field-equals filter over top-level payload fields (same matcher as bus.where).
     *  In github_hmac mode, `github_event` and `repository` are injected before matching. */
    where?: Record<string, string | number | boolean>;
  };
}
export type WhenBlock = ScheduleWhen | ManualWhen | BusWhen | HttpWhen;

export type ActivationPolicy = "auto" | "approval" | "disabled";

export interface ActivationGuards {
  cooldownMs?: number;
  runLock?: "skip" | "buffer";
}

export interface ActivationBlueprint {
  id: string;
  target: string;
  /** Goal and/or node IDs served by the resulting Activated Run. */
  serves?: { goal?: string; node?: string };
  kind: ImpulseKind;
  when: WhenBlock;
  policy: ActivationPolicy;
  approvalTimeoutMs: number;
  guards: ActivationGuards;
  payload: Record<string, unknown>;
  /** Provenance: file this blueprint was loaded from. */
  sourceFile: string;
}
