import type { ReflexActor } from "../bus/envelopes";
import type { ReflexConfig } from "../config/schema";

export const PROTOCOL_VERSION = 1;

export const COMMANDS = ["status", "list", "fire", "approve", "deny", "pending", "history", "test"] as const;
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

/**
 * Command subjects live under the Reflex namespace: one subject per command.
 * `pending` is the friendly CLI verb (CONTEXT.md) — on the wire and in the
 * router it maps to the canonical listWaiting handler.
 */
export function cmdSubject(cfg: Pick<ReflexConfig, "principal" | "stack">, command: Command): string {
  return `local.${cfg.principal}.${cfg.stack}.reflex.cmd.${command}`;
}

export const CMD_REQUEST_TYPE = "reflex.cmd.request";
export const CMD_REPLY_TYPE = "reflex.cmd.reply";
