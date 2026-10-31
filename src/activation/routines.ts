import { mkdir, open, readFile, rename, unlink, lstat, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify, parse } from "yaml";
import { z } from "zod";
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

export interface RoutineDeps {
  dir: string;
  sources: DiscoverOptions;
  knownTargets: () => Promise<readonly string[]>;
  dryRun: (blueprint: ActivationBlueprint, actor: ReflexActor) => Promise<DryRunVerdict>;
  lastDecision: (id: string) => unknown;
}

export class RoutineCommands {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RoutineDeps) {}

  execute(command: "routine-add" | "routine-remove" | "routine-list" | "routine-set-policy", args: Record<string, unknown>, actor: ReflexActor): Promise<HandlerResult<unknown>> {
    const next = this.chain.then(async (): Promise<HandlerResult<unknown>> => {
      try {
        switch (command) {
          case "routine-add": return { ok: true, data: await this.add(args, actor) };
          case "routine-remove": return { ok: true, data: await this.remove(args) };
          case "routine-list": return { ok: true, data: await this.list() };
          case "routine-set-policy": return { ok: true, data: await this.setPolicy(args, actor) };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Routine command refused";
        return { ok: false, error: { code: "invalid-input", message: message.replace(/\s+/g, " ").trim() } };
      }
    });
    this.chain = next.catch(() => {});
    return next;
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
    }
    const flowFile = join(this.deps.dir, "flows", `${input.id}.yaml`);
    if (flow !== undefined && "flow" in input.payload) throw new Error("--flow-file supplies payload.flow; do not also set payload.flow");
    const text = marker + (flow === undefined ? "" : flowOwnership) + stringify({ schema: ACTIVATION_SCHEMA_ID, activations: [{
      id: input.id, target: input.target, when: { schedule: input.schedule, timezone: input.timezone },
      policy: input.policy, payload: flow === undefined ? input.payload : { ...input.payload, flow: flowFile },
      ...(input.servesGoal ? { serves: { goal: input.servesGoal } } : {}),
    }] });
    await this.validate(text, file, actor);
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
      const stat = await lstat(flowFile);
      if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(flowFile, "utf8")).startsWith(flowMarker(id))) {
        throw new Error(`Routine ${id} flow was not generated by routine add`);
      }
    }
    await unlink(file);
    if (flowFile) await unlink(flowFile);
    return { id, file };
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
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, next, { mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return { id, policy, file };
  }

  private async list() {
    const files = await discoverActivationFiles({ watchRoots: [], activationsDir: this.deps.dir, onWarning: () => {} });
    const rows = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (!text.startsWith(marker)) continue;
      const [blueprint] = parseActivationDocument(text, file);
      if (!blueprint) continue;
      rows.push({ id: blueprint.id, schedule: "schedule" in blueprint.when ? blueprint.when.schedule : null,
        timezone: "timezone" in blueprint.when ? blueprint.when.timezone : null,
        policy: blueprint.policy,
        target: blueprint.target, lastDecision: this.deps.lastDecision(blueprint.id), file });
    }
    return rows;
  }
}
