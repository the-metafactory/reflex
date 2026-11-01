import { createHash } from "node:crypto";
import { Cron } from "croner";
import { isMap, isScalar, isSeq, parseDocument, visit, type YAMLMap, type Scalar } from "yaml";
import { z } from "zod";

export const ScheduleValueSchema = z.object({ schedule: z.string().min(1).max(1000), timezone: z.string().min(1).max(100).nullable() }).strict();
export const ScheduleChangeSchema = ScheduleValueSchema.extend({ id: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ScheduleValue = z.infer<typeof ScheduleValueSchema>;
export const routineRevision = (text: string, yaml: string | null): string => createHash("sha256").update(text).update("\0").update(yaml ?? "").digest("hex");

function map(value: unknown): YAMLMap {
  if (!isMap(value)) throw new Error("The schedule is not stored in a supported mapping");
  return value;
}

function stringScalar(value: unknown): value is Scalar<string> {
  return isScalar(value) && typeof value.value === "string";
}

function scalar(value: unknown): Scalar<string> {
  if (!stringScalar(value) || value.anchor || value.tag || !value.range) throw new Error("The schedule uses a shared or unsupported scalar");
  return value;
}

function source(text: string) {
  const document = parseDocument(text, { keepSourceTokens: true });
  if (document.errors.length) throw new Error("The routine YAML cannot be safely edited");
  visit(document, { Alias: () => { throw new Error("Shared YAML references cannot be edited safely"); } });
  const activations = map(document.contents).get("activations", true);
  if (!isSeq(activations) || activations.items.length !== 1) throw new Error("The routine must contain one activation");
  const entry = map(activations.items[0]);
  const when = map(entry.get("when", true));
  const schedule = scalar(when.get("schedule", true));
  const zone = when.get("timezone", true);
  const timezone = zone === undefined ? null : scalar(zone);
  if (when.anchor || entry.anchor || activations.anchor || map(document.contents).anchor) throw new Error("Shared YAML mappings cannot be edited safely");
  return { when, schedule, timezone };
}

export function storedSchedule(text: string): ScheduleValue {
  const value = source(text);
  return { schedule: value.schedule.value, timezone: value.timezone?.value ?? null };
}

export function scheduleProjection(value: ScheduleValue, at: number) {
  const effectiveTimezone = value.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en", { timeZone: effectiveTimezone }); }
  catch { throw new Error("timezone: Choose a valid timezone"); }
  let cron: Cron;
  try { cron = new Cron(value.schedule, { timezone: effectiveTimezone, paused: true }); }
  catch { throw new Error("schedule: The routine owner does not support this schedule expression"); }
  try {
    const occurrences: string[] = [];
    let next = cron.nextRun(new Date(at));
    while (next && occurrences.length < 3) {
      const previous = next.getTime(); occurrences.push(next.toISOString()); next = cron.nextRun(next);
      if (next && next.getTime() <= previous) throw new Error("schedule: The scheduling owner returned a non-increasing occurrence");
    }
    return { ...value, effectiveTimezone, occurrences };
  } finally { cron.stop(); }
}

export function changedScheduleText(text: string, value: ScheduleValue): string {
  const { when, schedule, timezone } = source(text);
  const edits: { start: number; end: number; value: string }[] = [];
  if (schedule.value !== value.schedule) {
    if (!schedule.range) throw new Error("Schedule source range is unavailable");
    edits.push({ start: schedule.range[0], end: schedule.range[1], value: JSON.stringify(value.schedule) });
  }
  if ((timezone?.value ?? null) !== value.timezone) {
    if (timezone && value.timezone !== null) {
      if (!timezone.range) throw new Error("Timezone source range is unavailable");
      edits.push({ start: timezone.range[0], end: timezone.range[1], value: JSON.stringify(value.timezone) });
    } else if (value.timezone !== null) {
      if (!when.range || !schedule.range) throw new Error("Timezone insertion point is unavailable");
      if (when.flow) {
        const end = when.range[1] - 1;
        if (text[end] !== "}") throw new Error("Inline schedule cannot be safely extended");
        edits.push({ start: end, end, value: `, timezone: ${JSON.stringify(value.timezone)}` });
      } else {
        const pair = when.items.find((item) => isScalar(item.key) && item.key.value === "schedule");
        if (!pair || !isScalar(pair.key) || !pair.key.range) throw new Error("Schedule indentation is unavailable");
        const indent = text.slice(text.lastIndexOf("\n", pair.key.range[0]) + 1, pair.key.range[0]);
        if (!/^ *$/.exec(indent)) throw new Error("Schedule indentation cannot be safely preserved");
        const end = when.range[2];
        edits.push({ start: end, end, value: `${text[end - 1] === "\n" ? "" : "\n"}${indent}timezone: ${JSON.stringify(value.timezone)}\n` });
      }
    } else {
      const pair = when.items.find((item) => isScalar(item.key) && item.key.value === "timezone");
      if (!pair || !isScalar(pair.key) || !pair.key.range || !timezone?.range || !when.range) throw new Error("Timezone removal point is unavailable");
      if (when.flow) {
        const prefix = text.slice(when.range[0], pair.key.range[0]);
        const comma = prefix.lastIndexOf(",");
        if (comma >= 0) edits.push({ start: when.range[0] + comma, end: timezone.range[1], value: "" });
        else {
          const end = text.indexOf(",", timezone.range[1]);
          if (end < 0 || end >= when.range[1]) throw new Error("Inline timezone cannot be safely removed");
          edits.push({ start: pair.key.range[0], end: end + 1, value: "" });
        }
      } else {
        const start = text.lastIndexOf("\n", pair.key.range[0]) + 1;
        if (!/^ *$/.exec(text.slice(start, pair.key.range[0]))) throw new Error("Timezone indentation cannot be safely preserved");
        edits.push({ start, end: timezone.range[2], value: "" });
      }
    }
  }
  let next = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
  const actual = storedSchedule(next);
  if (actual.schedule !== value.schedule || actual.timezone !== value.timezone) throw new Error("The proposed schedule could not be preserved exactly");
  return next;
}
