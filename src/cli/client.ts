import type { ReflexBus } from "../bus";
import { reflexSource } from "../bus/envelopes";
import type { ReflexActor } from "../bus/envelopes";
import type { ReflexConfig } from "../config/schema";
import { CMD_REQUEST_TYPE, PROTOCOL_VERSION, cmdSubject, type CmdResponse, type Command } from "../cmd/protocol";

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function isRequestTimeout(message: string): boolean {
  return /timed out|timeout/i.test(message);
}

export class TransportUnreachable extends Error {
  constructor(
    readonly subject: string,
    readonly hint: string,
    cause: string,
  ) {
    super(`${isRequestTimeout(cause) ? "daemon reply timed out" : "daemon not reachable"} on ${subject} (${cause}) — ${hint}`);
    this.name = "TransportUnreachable";
  }
}

/**
 * Thin requester (decision 7): publish a CmdRequest, await the reply
 * envelope, hand back the CmdResponse. Timeout/connect failures throw
 * TransportUnreachable — rendered as exit 2, distinct from domain errors.
 */
export async function requestCommand(
  bus: ReflexBus,
  cfg: ReflexConfig,
  command: Command,
  args: Record<string, unknown>,
  actor: ReflexActor,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<CmdResponse> {
  const subject = cmdSubject(cfg, command);
  try {
    const reply = await bus.request(
      {
        source: reflexSource(cfg),
        type: CMD_REQUEST_TYPE,
        payload: { v: PROTOCOL_VERSION, args, actor } as unknown as Record<string, unknown>,
        timeoutMs,
      },
      subject,
    );
    return reply.payload as unknown as CmdResponse;
  } catch (error) {
    const message = (error as Error).message;
    const hint = isRequestTimeout(message)
      ? "the request was sent and the daemon may still act on it; check `reflex history` or the daemon log (`reflex service logs`) before retrying"
      : `check NATS at ${cfg.nats.url} and credentials ${cfg.nats.creds}`;
    throw new TransportUnreachable(subject, hint, message);
  }
}
