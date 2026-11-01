import type { ReflexActor } from "../bus/envelopes";
import type { ReflexConfig } from "../config/schema";

export const PROTOCOL_VERSION = 1;

// Wire command names are CANONICAL (CONTEXT.md): the friendly CLI verb
// `pending` maps to `matched` before it ever reaches protocol or subjects.
export const COMMANDS = ["status", "list", "fire", "approve", "deny", "matched", "history", "dry-run", "routine-add", "routine-remove", "routine-removal-inspect", "routine-removal-status", "routine-removal-reconcile", "routine-list", "routine-set-policy", "routine-inspect", "routine-update", "routine-occurrences", "routine-history", "routine-schedule-inspect", "routine-schedule-preview", "routine-schedule-update", "routine-lifecycle-inspect", "routine-lifecycle-preview", "routine-lifecycle-update"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CmdRequest {
  v: typeof PROTOCOL_VERSION;
  args: Record<string, unknown>;
  actor: ReflexActor;
}

export interface CmdError {
  code: string;
  message: string;
  currentState?: string;
}

export interface CmdResponse {
  v: number;
  ok: boolean;
  data?: unknown;
  error?: CmdError;
}

/** Command subjects live under the Reflex namespace: one subject per command. */
export function cmdSubject(cfg: Pick<ReflexConfig, "principal" | "stack">, command: Command): string {
  return `local.${cfg.principal}.${cfg.stack}.reflex.cmd.${command}`;
}

export const CMD_REQUEST_TYPE = "reflex.cmd.request";
export const CMD_REPLY_TYPE = "reflex.cmd.reply";
