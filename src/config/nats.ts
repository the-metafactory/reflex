import { z } from "zod";

export const DEFAULT_NATS_TIMEOUT_MS = 10_000;
export const natsTimeoutSchema = z.number().int().positive().max(2_147_483_647).default(DEFAULT_NATS_TIMEOUT_MS);
