import { z } from "zod";
import type { BlueprintStore } from "./store";
import type { Repository } from "../store/repository";

const slug = z.string().min(1).max(1000).regex(/^[a-z0-9][a-z0-9-]*$/);
const querySchema = z.object({
  principal: z.string().min(1).max(100), stack: z.string().min(1).max(100),
  routineId: slug.optional(), decisionId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2000).optional(),
}).strict();
const cursorSchema = z.object({ principal: z.string(), stack: z.string(), routineId: slug.nullable(), at: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict();

export function routineHistory(repo: Repository, scope: { principal: string; stack: string }, store: BlueprintStore, args: Record<string, unknown>) {
  const query = querySchema.parse(args);
  if (query.principal !== scope.principal || query.stack !== scope.stack) throw new Error("Routine history scope mismatch");
  const cursor = query.cursor ? cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))) : undefined;
  if (cursor && (cursor.principal !== scope.principal || cursor.stack !== scope.stack || cursor.routineId !== (query.routineId ?? null) || query.decisionId)) throw new Error("Routine history cursor belongs to another query");
  const rows = repo.routineHistory({ blueprintId: query.routineId, decisionId: query.decisionId, limit: query.limit + 1, before: cursor });
  const complete = rows.length <= query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    owner: "reflex" as const, ...scope, routineId: query.routineId ?? null,
    records: page.map((row) => {
      const current = store.get(row.blueprintId);
      const approval = row.outcome === "matched" ? repo.getApproval(row.id) : null;
      return {
        decisionId: row.id, routineId: row.blueprintId, routineName: row.impulse.routineName ?? row.blueprintId,
        nameSource: row.impulse.routineName ? "recorded" as const : "identifier" as const,
        target: row.impulse.routineTarget ?? null,
        definitionPresent: Boolean(current), decision: row.outcome, at: row.createdAt, impulseKind: row.impulse.kind,
        correlationId: row.outcome === "fired" ? row.correlationId : null, resolutionOf: row.resolutionOf,
        approval: approval ? { state: approval.state, decidedAt: approval.decidedAt, expiresAt: approval.expiresAt } : null,
      };
    }),
    complete, nextCursor: !complete && last ? Buffer.from(JSON.stringify({ ...scope, routineId: query.routineId ?? null, at: last.createdAt, id: last.id })).toString("base64url") : null,
  };
}
