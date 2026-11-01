import { createHash } from "node:crypto";
import { lstat, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Cron } from "croner";
import { z } from "zod";
import { discoverActivationFiles, type DiscoverOptions } from "./sources";
import { loadBlueprintSet } from "./store";
import type { ActivationBlueprint } from "./types";
import { storedSchedule, storedPaused } from "./routine-schedule";

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

async function inspectOwnership(blueprint: ActivationBlueprint, dir: string, flowEditing: boolean, entriesInFile: number) {
  const [text, fileStat] = await Promise.all([readFile(blueprint.sourceFile, "utf8"), lstat(blueprint.sourceFile)]);
  const owned = entriesInFile === 1 && fileStat.isFile() && !fileStat.isSymbolicLink() && text.startsWith("# reflex-generated-routine: v1\n") && resolve(blueprint.sourceFile) === join(dir, `${blueprint.id}.yaml`);
  let editParameters = false;
  if (owned && flowEditing && text.startsWith("# reflex-generated-routine: v1\n# reflex-owned-flow: v1\n")) {
    const expectedFlow = join(dir, "flows", `${blueprint.id}.yaml`);
    if (blueprint.payload.flow === expectedFlow) {
      try {
        const flowStat = await lstat(expectedFlow);
        editParameters = flowStat.isFile() && !flowStat.isSymbolicLink() && flowStat.size <= 1048576 && (await readFile(expectedFlow, "utf8")).startsWith(`# reflex-generated-flow: ${blueprint.id} v1\n`);
      } catch { editParameters = false; }
    }
  }
  let editSchedule = false;
  if (owned) { try { storedSchedule(text); editSchedule = true; } catch { editSchedule = false; } }
  let pause = false;
  if (editSchedule && blueprint.policy !== "disabled") { try { storedPaused(text); pause = true; } catch { pause = false; } }
  return { readOnly: !owned, capabilities: { editParameters, editSchedule, pause, delete: owned, setPolicy: owned } };
}

export async function routineOccurrences(options: {
  sources: DiscoverOptions; dir: string; flowEditing: boolean; lifecycleApplied?: (blueprint: ActivationBlueprint) => boolean;
  scope: { principal: string; stack: string }; args: Record<string, unknown>;
}) {
  const dir = resolve(options.dir);
  const query = OccurrenceQuerySchema.parse(options.args);
  if (query.principal !== options.scope.principal || query.stack !== options.scope.stack) throw new Error("Routine owner scope does not match the requested principal and stack");
  for (const source of new Set([options.sources.activationsDir, options.sources.routinesDir, options.dir].filter((value): value is string => value !== undefined))) {
    try {
      if (!(await stat(source)).isDirectory()) throw new Error("Not a directory");
    } catch { throw new Error("Routine discovery is incomplete: a configured source directory is unavailable"); }
  }
  const files = await discoverActivationFiles({ ...options.sources, onWarning: () => { throw new Error("Routine discovery is incomplete: a configured source is unavailable"); } });
  const blueprints = await loadBlueprintSet(files);
  if (blueprints.length > 2000) throw new Error("Routine inventory exceeds the occurrence query limit");
  const entries = [];
  const fileCounts = new Map<string, number>();
  for (const blueprint of blueprints) fileCounts.set(blueprint.sourceFile, (fileCounts.get(blueprint.sourceFile) ?? 0) + 1);
  const scheduled = blueprints.filter((blueprint) => "schedule" in blueprint.when);
  for (let offset = 0; offset < scheduled.length; offset += 16) {
    const batch = await Promise.all(scheduled.slice(offset, offset + 16).map(async (blueprint) => {
      if (!("schedule" in blueprint.when)) throw new Error("Routine is not scheduled");
      const timezone = blueprint.when.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      zone.parse(timezone);
      return {
        routineId: blueprint.id, schedule: blueprint.when.schedule, sourceTimezone: timezone,
        lifecycle: options.lifecycleApplied && !options.lifecycleApplied(blueprint) ? "unconfirmed" as const : blueprint.policy === "disabled" ? "disabled" as const : blueprint.paused ? "paused" as const : "active" as const,
        handlingPolicy: blueprint.policy === "disabled" ? null : blueprint.policy,
        ...await inspectOwnership(blueprint, dir, options.flowEditing, fileCounts.get(blueprint.sourceFile) ?? 0),
      };
    }));
    entries.push(...batch);
  }
  entries.sort((a, b) => a.routineId < b.routineId ? -1 : a.routineId > b.routineId ? 1 : 0);
  const snapshot = createHash("sha256").update(JSON.stringify({ entries, ...options.scope, start: query.start, end: query.end, timezone: query.timezone })).digest("hex");
  let after: z.infer<typeof CursorSchema> | undefined;
  if (query.cursor) {
    after = CursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    if (after.snapshot !== snapshot || Date.parse(after.at) < Date.parse(query.start) || Date.parse(after.at) >= Date.parse(query.end)) throw new Error("The calendar query changed; restart from its first page");
  }
  const boundary = after ? Date.parse(after.at) : Date.parse(query.start);
  const end = Date.parse(query.end);
  const pending = entries.map((entry) => {
    const cron = new Cron(entry.schedule, { timezone: entry.sourceTimezone });
    let next = cron.nextRun(new Date(boundary - 1));
    if (after && next && next.getTime() === boundary && entry.routineId <= after.id) next = cron.nextRun(next);
    return { entry, cron, next };
  });
  const occurrences = [];
  while (occurrences.length <= query.limit) {
    let candidate: typeof pending[number] | undefined;
    for (const item of pending) {
      if (!item.next || item.next.getTime() >= end) continue;
      if (!candidate?.next || item.next.getTime() < candidate.next.getTime() || (item.next.getTime() === candidate.next.getTime() && item.entry.routineId < candidate.entry.routineId)) candidate = item;
    }
    if (!candidate?.next) break;
    occurrences.push({ ...candidate.entry, scheduledFor: candidate.next.toISOString() });
    const previous = candidate.next.getTime();
    candidate.next = candidate.cron.nextRun(candidate.next);
    if (candidate.next && candidate.next.getTime() <= previous) throw new Error("The scheduling owner returned a non-increasing occurrence");
  }
  const complete = occurrences.length <= query.limit;
  const page = occurrences.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = !complete && last ? Buffer.from(JSON.stringify({ snapshot, at: last.scheduledFor, id: last.routineId })).toString("base64url") : null;
  return {
    owner: "reflex" as const, ...options.scope, start: query.start, end: query.end, timezone: query.timezone,
    meaning: "planned-trigger" as const, occurrences: page, complete, nextCursor,
    counts: { scope: "page" as const, total: page.length, active: page.filter((p) => p.lifecycle === "active").length, disabled: page.filter((p) => p.lifecycle !== "active").length },
  };
}
