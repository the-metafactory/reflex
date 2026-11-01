import { mkdir, open, readFile, rename, unlink, lstat, link } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { stringify, parse } from "yaml";
import { z } from "zod";
import { RoutinePatchSchema, type RoutineFlowContract } from "./routine-contract";
import { ScheduleChangeSchema, changedScheduleText, routineRevision, scheduleProjection, storedSchedule, type ScheduleValue } from "./routine-schedule";
import { Cron } from "croner";
import { parseActivationDocument, ACTIVATION_SCHEMA_ID } from "./schema";
import { discoverActivationFiles, type DiscoverOptions } from "./sources";
import { loadBlueprintSet, mergeBlueprints } from "./store";
import type { ActivationBlueprint } from "./types";
import type { ReflexActor } from "../bus/envelopes";
import type { DryRunVerdict } from "../pipeline/verdict";
import type { HandlerResult } from "../handlers/commands";

const idSchema = z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/);
const policySchema = z.enum(["approval", "auto"]);
const addSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300).optional(),
  schedule: z.string().min(1),
  timezone: z.string().min(1),
  target: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  policy: policySchema.default("approval"),
  flow: z.string().min(1).max(1048576).optional(),
  servesGoal: z.string().regex(/^G[0-9]+$/).optional(),
}).strict();
const flowDocument = z.object({ name: z.string().min(1), actions: z.array(z.unknown()).min(1), input: z.record(z.unknown()).optional() }).passthrough();
const flowMarker = (id: string) => `# reflex-generated-flow: ${id} v1\n`;
const flowOwnership = "# reflex-owned-flow: v1\n";
const marker = "# reflex-generated-routine: v1\n";
const MAX_FLOW_BYTES = 1048576;
type RoutineCommand = "routine-add" | "routine-remove" | "routine-list" | "routine-set-policy" | "routine-inspect" | "routine-update" | "routine-schedule-inspect" | "routine-schedule-preview" | "routine-schedule-update";

class RoutineWriteUncertain extends Error {}

async function writing<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new RoutineWriteUncertain(error instanceof Error ? error.message : "Routine write did not complete"); }
}

export interface RoutineDeps {
  dir: string;
  sources: DiscoverOptions;
  knownTargets: () => Promise<readonly string[]>;
  dryRun: (blueprint: ActivationBlueprint, actor: ReflexActor) => Promise<DryRunVerdict>;
  lastDecision: (id: string) => unknown;
  flowContract?: RoutineFlowContract;
}

export class RoutineCommands {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RoutineDeps) {}

  execute(command: RoutineCommand, args: Record<string, unknown>, actor: ReflexActor): Promise<HandlerResult<unknown>> {
    const next = this.chain.then(async (): Promise<HandlerResult<unknown>> => {
      try {
          const read = command === "routine-list" || command === "routine-inspect" || command === "routine-schedule-inspect" || command === "routine-schedule-preview";
          return read ? await this.run(command, args, actor) : await this.withWriteLock(idSchema.parse(args.id), () => this.run(command, args, actor));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Routine command refused";
          return { ok: false, error: { code: error instanceof RoutineWriteUncertain ? "write-uncertain" : "invalid-input", message: message.replace(/\s+/g, " ").trim() } };
        }
      });
    this.chain = next.catch(() => {});
    return next;
  }

  private async run(command: RoutineCommand, args: Record<string, unknown>, actor: ReflexActor): Promise<HandlerResult<unknown>> {
        switch (command) {
          case "routine-add": return { ok: true, data: await this.add(args, actor) };
          case "routine-remove": return { ok: true, data: await this.remove(args) };
          case "routine-list": return { ok: true, data: await this.list() };
          case "routine-set-policy": return { ok: true, data: await this.setPolicy(args, actor) };
          case "routine-inspect": return { ok: true, data: await this.inspect(args) };
          case "routine-update": return { ok: true, data: await this.update(args) };
          case "routine-schedule-inspect": return { ok: true, data: await this.inspectSchedule(args) };
          case "routine-schedule-preview": return { ok: true, data: await this.previewSchedule(args) };
          case "routine-schedule-update": return { ok: true, data: await this.updateSchedule(args) };
        }
  }

  private async withWriteLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.deps.dir, { recursive: true });
    const file = join(this.deps.dir, `.${id}.write-lock`);
    const handle = await open(file, "wx", 0o600).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Another routine writer holds this routine. Retry after it finishes; an interrupted writer requires operator lock cleanup.");
      throw error;
    });
    const identity = await handle.stat();
    try { return await operation(); }
    finally {
      await handle.close();
      const current = await lstat(file);
      if (current.ino !== identity.ino || current.dev !== identity.dev) throw new RoutineWriteUncertain("Routine write lock ownership changed; the replacement lock was preserved.");
      await unlink(file);
    }
  }

  private file(id: string): string {
    return join(this.deps.dir, `${idSchema.parse(id)}.yaml`);
  }

  private async validate(text: string, file: string, actor: ReflexActor, replacing = false, checkTarget = true): Promise<ActivationBlueprint> {
    const [blueprint] = parseActivationDocument(text, file);
    if (!blueprint) throw new Error("Routine must contain one activation");
    if (checkTarget && !(await this.deps.knownTargets()).includes(blueprint.target)) throw new Error(`Unknown routine target ${blueprint.target}`);
    if (!("schedule" in blueprint.when) || !blueprint.when.timezone) throw new Error("Routine requires a schedule and timezone");
    new Intl.DateTimeFormat("en", { timeZone: blueprint.when.timezone }).format();
    new Cron(blueprint.when.schedule, { timezone: blueprint.when.timezone, paused: true }).stop();
    const files = await discoverActivationFiles(this.deps.sources);
    const existing = await loadBlueprintSet(files.filter((path) => !replacing || resolve(path) !== resolve(file)));
    mergeBlueprints([existing, [blueprint]]);
    const verdict = await this.deps.dryRun(blueprint, actor);
    if (verdict.wouldOutcome !== "matched" && verdict.wouldOutcome !== "fired") {
      throw new Error(`Dry Run refused routine ${blueprint.id}: ${verdict.reasons.join("; ")}`);
    }
    return blueprint;
  }

  private async add(args: Record<string, unknown>, actor: ReflexActor) {
    const input = addSchema.parse(args);
    const file = this.file(input.id);
    let flow: string | undefined;
    if (input.flow !== undefined) {
      flowDocument.parse(parse(input.flow));
      flow = flowMarker(input.id) + input.flow;
      if (Buffer.byteLength(flow, "utf8") > MAX_FLOW_BYTES) throw new Error("Routine flow exceeds its UTF-8 byte size limit");
    }
    const flowFile = join(this.deps.dir, "flows", `${input.id}.yaml`);
    if (flow !== undefined && "flow" in input.payload) throw new Error("--flow-file supplies payload.flow; do not also set payload.flow");
    const text = marker + (flow === undefined ? "" : flowOwnership) + stringify({ schema: ACTIVATION_SCHEMA_ID, activations: [{
      id: input.id, ...(input.name ? { name: input.name } : {}), target: input.target, when: { schedule: input.schedule, timezone: input.timezone },
      policy: input.policy, payload: flow === undefined ? input.payload : { ...input.payload, flow: flowFile },
      ...(input.servesGoal ? { serves: { goal: input.servesGoal } } : {}),
    }] });
    await this.validate(text, file, actor);
    return writing(async () => {
      let flowCreated = false;
      try {
        if (flow !== undefined) {
          await this.install(flowFile, flow);
          flowCreated = true;
        }
        await this.install(file, text);
      } catch (error) {
        if (flowCreated) await unlink(flowFile);
        throw error;
      }
      return { id: input.id, file, ...(flow === undefined ? {} : { flowFile }) };
    });
  }

  private async install(file: string, text: string): Promise<void> {
    await mkdir(resolve(file, ".."), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.close();
      await link(temporary, file);
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  private async owned(id: string) {
    const file = this.file(id);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Routine ${id} is not a generated regular file`);
    const text = await readFile(file, "utf8");
    if (!text.startsWith(marker)) throw new Error(`Routine ${id} was not created by routine add`);
    const blueprints = parseActivationDocument(text, file);
    const blueprint = blueprints[0];
    if (blueprints.length !== 1 || !blueprint || blueprint.id !== id) throw new Error(`Routine ${id} has invalid ownership metadata`);
    return { file, text, blueprint };
  }

  private async remove(args: Record<string, unknown>) {
    const { id } = z.object({ id: idSchema }).strict().parse(args);
    const { file, text, blueprint } = await this.owned(id);
    let flowFile: string | undefined;
    if (text.startsWith(marker + flowOwnership)) {
      flowFile = join(this.deps.dir, "flows", `${id}.yaml`);
      if (blueprint.payload.flow !== flowFile) throw new Error(`Routine ${id} has invalid flow ownership`);
      try {
        const stat = await lstat(flowFile);
        if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(flowFile, "utf8")).startsWith(flowMarker(id))) {
          throw new Error(`Routine ${id} flow was not generated by routine add`);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        flowFile = undefined;
      }
    }
    return writing(async () => {
      if (flowFile) await unlink(flowFile);
      await unlink(file);
      return { id, file };
    });
  }

  private async setPolicy(args: Record<string, unknown>, actor: ReflexActor) {
    const { id, policy } = z.object({ id: idSchema, policy: policySchema }).strict().parse(args);
    const { file, text } = await this.owned(id);
    const document = z.object({ schema: z.string(), activations: z.array(z.record(z.unknown())).length(1) }).parse(parse(text));
    const entry = document.activations[0];
    if (!entry) throw new Error("Routine activation missing");
    entry.policy = policy;
    const next = marker + (text.startsWith(marker + flowOwnership) ? flowOwnership : "") + stringify(document);
    await this.validate(next, file, actor, true, policy === "auto");
    return writing(async () => {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await Bun.write(temporary, next, { mode: 0o600 });
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => {}); }
      return { id, policy, file };
    });
  }

  private async list() {
    const files = await discoverActivationFiles(this.deps.sources);
    const rows = [];
    for (const blueprint of await loadBlueprintSet(files)) {
      const file = blueprint.sourceFile;
      const text = await readFile(file, "utf8");
      if (!("schedule" in blueprint.when)) continue;
      let editSchedule = false;
      try { editSchedule = text.startsWith(marker) && idSchema.safeParse(blueprint.id).success && resolve(file) === resolve(this.file(blueprint.id)) && (await lstat(file)).isFile(); if (editSchedule) storedSchedule(text); }
      catch { editSchedule = false; }
      rows.push({ id: blueprint.id, schedule: "schedule" in blueprint.when ? blueprint.when.schedule : null,
        timezone: "timezone" in blueprint.when ? blueprint.when.timezone ?? null : null,
        policy: blueprint.policy,
        target: blueprint.target, lastDecision: this.deps.lastDecision(blueprint.id), file,
        readOnly: !this.deps.flowContract || !text.startsWith(marker + flowOwnership) || !idSchema.safeParse(blueprint.id).success || resolve(file) !== resolve(this.file(blueprint.id)),
        capabilities: { editSchedule },
      });
    }
    return rows;
  }

  private async snapshot(id: string) {
    const files = await discoverActivationFiles(this.deps.sources);
    const matches = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const blueprint of parseActivationDocument(text, file)) if (blueprint.id === id && "schedule" in blueprint.when) matches.push({ file, text, blueprint });
    }
    if (matches.length !== 1) throw new Error("Routine is unavailable or has conflicting definitions");
    const entry = matches[0];
    if (!entry) throw new Error("Routine is unavailable");
    const flowFile = entry.blueprint.payload.flow;
    if (typeof flowFile !== "string" || !isAbsolute(flowFile) || !/\.ya?ml$/.exec(flowFile)) return { ...entry, yaml: null, flowFile: null, writable: false, revision: routineRevision(entry.text, null) };
    const stat = await lstat(flowFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FLOW_BYTES) throw new Error("Routine flow is not an inspectable regular YAML file");
    const yaml = await readFile(flowFile, "utf8");
    const activationStat = await lstat(entry.file);
    const writable = activationStat.isFile() && !activationStat.isSymbolicLink() && entry.text.startsWith(marker + flowOwnership) && resolve(entry.file) === resolve(this.file(id)) && resolve(flowFile) === resolve(join(this.deps.dir, "flows", `${id}.yaml`)) && yaml.startsWith(flowMarker(id));
    const revision = routineRevision(entry.text, yaml);
    return { ...entry, yaml, flowFile, writable, revision };
  }

  private async inspect(args: Record<string, unknown>) {
    const { id } = z.object({ id: idSchema }).strict().parse(args);
    const state = await this.snapshot(id);
    const base = { id, revision: state.revision, writable: state.writable && Boolean(this.deps.flowContract) };
    if (!state.yaml) return { ...base, flow: null, reason: "This routine has no inspectable flow file." };
    if (!this.deps.flowContract) return { ...base, flow: null, reason: "The owner has no configured flow inspection contract. Editing is unavailable." };
    const result = await this.deps.flowContract(state.yaml, []);
    return { ...base, flow: result.view, reason: state.writable ? "" : "This definition is owned outside Reflex routine storage and is read-only." };
  }

  private async scheduleState(id: string) {
    const state = await this.snapshot(id);
    const stat = await lstat(state.file);
    const owned = stat.isFile() && !stat.isSymbolicLink() && state.text.startsWith(marker) && resolve(state.file) === resolve(this.file(id));
    let reason = owned ? "" : "This definition is owned outside Reflex routine storage and its schedule is read-only.";
    if (!("schedule" in state.blueprint.when)) throw new Error("This routine does not have a scheduled trigger");
    let current: ScheduleValue = { schedule: state.blueprint.when.schedule, timezone: state.blueprint.when.timezone ?? null };
    try { current = storedSchedule(state.text); }
    catch (error) { reason = error instanceof Error ? error.message : "The stored schedule cannot be safely edited"; }
    return { ...state, current, scheduleWritable: owned && !reason, scheduleReason: reason };
  }

  private async inspectSchedule(args: Record<string, unknown>) {
    const { id } = z.object({ id: idSchema }).strict().parse(args);
    const state = await this.scheduleState(id);
    const at = Date.now();
    return { id, revision: state.revision, at: new Date(at).toISOString(), writable: state.scheduleWritable, reason: state.scheduleReason, current: scheduleProjection(state.current, at) };
  }

  private async prepareSchedule(args: Record<string, unknown>) {
    const input = ScheduleChangeSchema.parse(args);
    const state = await this.scheduleState(input.id);
    if (!state.scheduleWritable) throw new Error(state.scheduleReason);
    if (state.revision !== input.revision) throw new Error("Routine changed since it was opened. Refresh before applying schedule edits.");
    const at = Date.now();
    const proposed = scheduleProjection({ schedule: input.schedule, timezone: input.timezone }, at);
    const text = changedScheduleText(state.text, proposed);
    const [blueprint] = parseActivationDocument(text, state.file);
    if (!blueprint || blueprint.id !== input.id) throw new Error("The schedule edit changed routine identity");
    return { input, state, text, reply: { id: input.id, revision: state.revision, proposedRevision: routineRevision(text, state.yaml), at: new Date(at).toISOString(), current: scheduleProjection(state.current, at), proposed } };
  }

  private async previewSchedule(args: Record<string, unknown>) {
    return (await this.prepareSchedule(args)).reply;
  }

  private async updateSchedule(args: Record<string, unknown>) {
    const { proposedRevision, ...input } = ScheduleChangeSchema.extend({ proposedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(args);
    const prepared = await this.prepareSchedule(input);
    if (prepared.reply.proposedRevision !== proposedRevision) throw new Error("The confirmed schedule preview does not match this update");
    const temporary = `${prepared.state.file}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, prepared.text, { mode: 0o600 });
      const current = await this.snapshot(input.id);
      if (current.revision !== input.revision) throw new Error("Routine changed while validating the schedule. Refresh before applying edits.");
      await writing(() => rename(temporary, prepared.state.file));
    } finally { await unlink(temporary).catch(() => {}); }
    const installed = await this.scheduleState(input.id);
    if (installed.revision !== proposedRevision || installed.text !== prepared.text) throw new RoutineWriteUncertain("The owner could not verify the committed schedule. Refresh before retrying.");
    const at = Date.now();
    return { id: input.id, revision: installed.revision, at: new Date(at).toISOString(), writable: installed.scheduleWritable, reason: installed.scheduleReason, current: scheduleProjection(installed.current, at) };
  }

  private async update(args: Record<string, unknown>) {
    const { id, revision, patches } = z.object({ id: idSchema, revision: z.string().regex(/^[a-f0-9]{64}$/), patches: z.array(RoutinePatchSchema).min(1).max(100) }).strict().parse(args);
    const original = await this.snapshot(id);
    if (!original.writable || !original.yaml || !original.flowFile || !this.deps.flowContract) throw new Error("This routine has no owner-supported update contract");
    if (original.revision !== revision) throw new Error("Routine changed since it was opened. Refresh before applying edits.");
    const result = await this.deps.flowContract(original.yaml, patches);
    if (!result.yaml) throw new Error("Flow contract did not confirm a validated update");
    if (Buffer.byteLength(result.yaml, "utf8") > MAX_FLOW_BYTES) throw new Error("Routine flow exceeds its UTF-8 byte size limit");
    if (!result.yaml.startsWith(flowMarker(id))) throw new Error("Flow contract did not preserve ownership metadata");
    const temporary = `${original.flowFile}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, result.yaml, { mode: 0o600 });
      const current = await this.snapshot(id);
      if (current.revision !== revision) throw new Error("Routine changed while validating edits. Refresh before applying edits.");
      await writing(() => rename(temporary, original.flowFile));
    } finally { await unlink(temporary).catch(() => {}); }
    const installed = await this.snapshot(id);
    if (installed.yaml !== result.yaml) throw new RoutineWriteUncertain("The owner could not verify the committed flow. Refresh before retrying.");
    return { id, revision: installed.revision, writable: true, reason: "", flow: result.view };
  }
}
