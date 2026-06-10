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
export interface HttpWhen {
  http: {
    token_env?: string;
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
  kind: ImpulseKind;
  when: WhenBlock;
  policy: ActivationPolicy;
  approvalTimeoutMs: number;
  guards: ActivationGuards;
  payload: Record<string, unknown>;
  /** Provenance: file this blueprint was loaded from. */
  sourceFile: string;
}
