import { z } from "zod";

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export const RoutinePatchSchema = z.object({ path: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1).max(40), value: scalar }).strict();
export const RoutineViewSchema = z.object({ name: z.string(), steps: z.array(z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])), action: z.string(), purpose: z.string(),
  parameters: z.array(z.object({ name: z.string(), kind: z.enum(["literal", "binding", "redacted"]), value: scalar.nullable() })),
  editable: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean"]), minimum: z.number().optional(), maximum: z.number().optional(), enum: z.array(scalar).optional() })), reason: z.string(),
})) });
const replySchema = z.object({ view: RoutineViewSchema, yaml: z.string().min(1).max(1048576).optional() }).strict();
export type RoutineFlowContract = (yaml: string, patches: z.infer<typeof RoutinePatchSchema>[]) => Promise<z.infer<typeof replySchema>>;

export function commandFlowContract(command: string[] | undefined): RoutineFlowContract | undefined {
  if (!command?.length) return undefined;
  return async (yaml, patches) => {
    const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(9); }, 10000);
    try {
      child.stdin.write(JSON.stringify({ yaml, patches }));
      child.stdin.end();
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1500000) { child.kill(9); throw new Error("Routine flow contract output exceeds its size limit"); }
        stdout += decoder.decode(chunk.value, { stream: true });
      }
      stdout += decoder.decode();
      const code = await child.exited;
      if (expired || stdout.length > 1500000) throw new Error("Routine flow validation unavailable");
      if (code !== 0) {
        const refusal = z.object({ error: z.string().max(2000) }).safeParse(JSON.parse(stdout));
        throw new Error(refusal.success ? refusal.data.error : "Routine flow validation refused the proposed fields");
      }
      return replySchema.parse(JSON.parse(stdout));
    } finally { clearTimeout(timer); }
  };
}
