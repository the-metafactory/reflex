import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Cron } from "croner";
import { z } from "zod";
import { discoverActivationFiles, type DiscoverOptions } from "./sources";
import { loadBlueprintSet } from "./store";

const instant = z.string().datetime({ offset: true });
const zone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Invalid timezone");
export const OccurrenceQuerySchema = z.object({
  principal: z.string().min(1), stack: z.string().min(1),
  start: instant, end: instant, timezone: zone,
  limit: z.number().int().min(1).max(1000).default(200),
  cursor: z.string().max(2000).optional(),
}).strict().refine((q) => Date.parse(q.end) > Date.parse(q.start) && Date.parse(q.end) - Date.parse(q.start) <= 32 * 86400000, "Query a positive range of at most 32 days");
const CursorSchema = z.object({ snapshot: z.string(), at: instant, id: z.string() }).strict();

export async function routineOccurrences(options: {
  sources: DiscoverOptions; dir: string; flowEditing: boolean;
  scope: { principal: string; stack: string }; args: Record<string, unknown>;
}) {
  const query = OccurrenceQuerySchema.parse(options.args);
  if (query.principal !== options.scope.principal || query.stack !== options.scope.stack) throw new Error("Routine owner scope does not match the requested principal and stack");
  const files = await discoverActivationFiles({ ...options.sources, onWarning: () => { throw new Error("Routine discovery is incomplete: a configured source is unavailable"); } });
  const blueprints = await loadBlueprintSet(files);
  if (blueprints.length > 2000) throw new Error("Routine inventory exceeds the occurrence query limit");
  const entries = [];
  for (const blueprint of blueprints) {
    if (!("schedule" in blueprint.when)) continue;
    const text = await readFile(blueprint.sourceFile, "utf8");
    const stat = await lstat(blueprint.sourceFile);
    const owned = stat.isFile() && !stat.isSymbolicLink() && text.startsWith("# reflex-generated-routine: v1\n") && resolve(blueprint.sourceFile) === resolve(join(options.dir, `${blueprint.id}.yaml`));
    const timezone = blueprint.when.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    zone.parse(timezone);
    let editParameters = false;
    if (owned && options.flowEditing && text.startsWith("# reflex-generated-routine: v1\n# reflex-owned-flow: v1\n")) {
      const expectedFlow = join(options.dir, "flows", `${blueprint.id}.yaml`);
      if (blueprint.payload.flow === expectedFlow) {
        try {
          const flowStat = await lstat(expectedFlow);
          editParameters = flowStat.isFile() && !flowStat.isSymbolicLink() && flowStat.size <= 1048576 && (await readFile(expectedFlow, "utf8")).startsWith(`# reflex-generated-flow: ${blueprint.id} v1\n`);
        } catch { editParameters = false; }
      }
    }
    entries.push({
      routineId: blueprint.id, schedule: blueprint.when.schedule, sourceTimezone: timezone,
      lifecycle: blueprint.policy === "disabled" ? "disabled" as const : "active" as const,
      handlingPolicy: blueprint.policy === "disabled" ? null : blueprint.policy,
      readOnly: !owned,
      capabilities: { editParameters, editSchedule: false, pause: false, delete: owned, setPolicy: owned },
    });
  }
  entries.sort((a, b) => a.routineId < b.routineId ? -1 : a.routineId > b.routineId ? 1 : 0);
  const snapshot = createHash("sha256").update(JSON.stringify({ entries, ...options.scope, start: query.start, end: query.end, timezone: query.timezone })).digest("hex");
  let after: z.infer<typeof CursorSchema> | undefined;
  if (query.cursor) {
    after = CursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    if (after.snapshot !== snapshot || Date.parse(after.at) < Date.parse(query.start) || Date.parse(after.at) >= Date.parse(query.end)) throw new Error("The calendar query changed; restart from its first page");
  }
  const boundary = after ? Date.parse(after.at) : Date.parse(query.start);
  const pending = entries.map((entry) => {
    const cron = new Cron(entry.schedule, { timezone: entry.sourceTimezone });
    let next = cron.nextRun(new Date(boundary - 1));
    if (after && next && next.getTime() === boundary && entry.routineId <= after.id) next = cron.nextRun(next);
    return { entry, cron, next };
  });
  const occurrences = [];
  while (occurrences.length <= query.limit) {
    const candidate = pending.filter((p) => p.next && p.next.getTime() < Date.parse(query.end)).sort((a, b) => {
      const time = (a.next?.getTime() ?? 0) - (b.next?.getTime() ?? 0);
      return time || (a.entry.routineId < b.entry.routineId ? -1 : a.entry.routineId > b.entry.routineId ? 1 : 0);
    })[0];
    if (!candidate?.next) break;
    occurrences.push({ ...candidate.entry, scheduledFor: candidate.next.toISOString() });
    candidate.next = candidate.cron.nextRun(candidate.next);
  }
  const complete = occurrences.length <= query.limit;
  const page = occurrences.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = !complete && last ? Buffer.from(JSON.stringify({ snapshot, at: last.scheduledFor, id: last.routineId })).toString("base64url") : null;
  return {
    owner: "reflex" as const, ...options.scope, start: query.start, end: query.end, timezone: query.timezone,
    meaning: "planned-trigger" as const, occurrences: page, complete, nextCursor,
    counts: { scope: "page" as const, total: page.length, active: page.filter((p) => p.lifecycle === "active").length, disabled: page.filter((p) => p.lifecycle === "disabled").length },
  };
}
