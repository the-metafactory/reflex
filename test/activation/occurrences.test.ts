import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { Cron } from "croner";
import { routineOccurrences } from "../../src/activation/occurrences";
import { ScheduleSource } from "../../src/sources/schedule";
import { BlueprintStore, loadBlueprintSet } from "../../src/activation/store";

const scope = { principal: "test", stack: "default" };
const query = { ...scope, start: "2026-03-29T00:00:00Z", end: "2026-03-30T00:00:00Z", timezone: "Europe/Zurich", limit: 100 };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "routine-occurrences-"));
  const central = join(dir, "activations");
  const owned = join(dir, "routines");
  await mkdir(central); await mkdir(owned);
  const sources = { activationsDir: central, routinesDir: owned, watchRoots: [] };
  const add = async (id: string, schedule: string, timezone = "Europe/Zurich", policy = "approval", managed = false) => {
    const file = join(managed ? owned : central, `${id}.yaml`);
    await writeFile(file, (managed ? "# reflex-generated-routine: v1\n" : "") + stringify({ schema: "metafactory/activation/v1", activations: [{ id, target: "@test/noop", when: { schedule, timezone }, policy, payload: { secret: "do-not-return" } }] }));
    return file;
  };
  const read = (args: Record<string, unknown> = query) => routineOccurrences({ sources, dir: owned, flowEditing: false, scope, args });
  return { dir, central, owned, sources, add, read, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("owner schedule occurrences", () => {
  it.each(["2026-03-29", "2026-10-25"])("matches real scheduler clock and second-step interval nextRun across DST on %s", async (date) => {
    const f = await fixture();
    try {
      const start = `${date}T00:00:00Z`;
      const end = `${date}T04:00:00Z`;
      await f.add("clock", "30 2 * * *");
      await f.add("interval", "0 */15 * * * *");
      const blueprints = await loadBlueprintSet([join(f.central, "clock.yaml"), join(f.central, "interval.yaml")]);
      let evaluated = 0;
      const source = new ScheduleSource(new BlueprintStore(blueprints), { evaluate: async () => { evaluated++; throw new Error("Read query must not evaluate"); } });
      const page = await f.read({ ...query, start, end });
      for (const blueprint of blueprints) {
        if (!("schedule" in blueprint.when)) throw new Error("Expected schedule");
        const cron = new Cron(blueprint.when.schedule, { timezone: blueprint.when.timezone });
        const expected: string[] = [];
        let next = cron.nextRun(new Date(Date.parse(start) - 1));
        while (next && next.getTime() < Date.parse(end)) {
          expected.push(next.toISOString());
          next = cron.nextRun(next);
        }
        expect(page.occurrences.filter((r) => r.routineId === blueprint.id).map((r) => r.scheduledFor)).toEqual(expected);
      }
      expect(source.status()).toEqual([]);
      expect(evaluated).toBe(0);
      expect(JSON.stringify(page)).not.toContain("do-not-return");
    } finally { await f.cleanup(); }
  });

  it("paginates dense equal-time routines without duplicates and excludes disabled from page active counts", async () => {
    const f = await fixture();
    try {
      await f.add("a", "* * * * * *", "UTC", "approval", true);
      await f.add("b", "* * * * * *", "UTC", "disabled");
      const start = "2026-01-01T00:00:00Z";
      const input = { ...query, start, end: "2026-01-01T00:00:03Z", limit: 3 };
      const first = await f.read(input);
      expect(first).toMatchObject({ complete: false, counts: { scope: "page", total: 3, active: 2, disabled: 1 } });
      expect(first.occurrences[0]).toMatchObject({ routineId: "a", scheduledFor: start.replace("Z", ".000Z"), readOnly: false, capabilities: { delete: true, editSchedule: true } });
      expect(first.occurrences[1]).toMatchObject({ routineId: "b", lifecycle: "disabled", handlingPolicy: null, readOnly: true, capabilities: { delete: false } });
      const second = await f.read({ ...input, cursor: first.nextCursor });
      expect(second.complete).toBe(true);
      expect(second.nextCursor).toBeNull();
      const keys = [...first.occurrences, ...second.occurrences].map((r) => `${r.scheduledFor}/${r.routineId}`);
      expect(keys).toHaveLength(6);
      expect(new Set(keys).size).toBe(6);
      const before = await readFile(join(f.owned, "a.yaml"), "utf8");
      await f.add("a", "*/2 * * * * *", "UTC", "approval", true);
      await expect(f.read({ ...input, cursor: first.nextCursor })).rejects.toThrow("changed");
      expect(before).not.toBe(await readFile(join(f.owned, "a.yaml"), "utf8"));
    } finally { await f.cleanup(); }
  });

  it("reports editable owned flows when the configured routine directory is relative", async () => {
    const f = await fixture();
    try {
      const file = await f.add("editable", "0 9 * * *", "UTC", "approval", true);
      const flow = join(f.owned, "flows", "editable.yaml");
      await mkdir(join(f.owned, "flows"));
      await writeFile(flow, "# reflex-generated-flow: editable v1\nname: F_TEST\nactions: [A_TEST]\n");
      await writeFile(file, "# reflex-generated-routine: v1\n# reflex-owned-flow: v1\n" + stringify({ schema: "metafactory/activation/v1", activations: [{ id: "editable", target: "@test/noop", when: { schedule: "0 9 * * *", timezone: "UTC" }, policy: "approval", payload: { flow } }] }));
      const page = await routineOccurrences({ sources: f.sources, dir: relative(process.cwd(), f.owned), flowEditing: true, scope, args: query });
      expect(page.occurrences[0]?.capabilities.editParameters).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("rejects invalid ranges, scope, timezone, limits, cursor and missing discovery instead of returning empty success", async () => {
    const f = await fixture();
    try {
      for (const invalid of [{ end: query.start }, { end: "2027-01-01T00:00:00Z" }, { timezone: "Invalid/Zone" }, { limit: 1001 }, { limit: 0 }, { principal: "foreign" }, { stack: "foreign" }, { cursor: "bad" }]) await expect(f.read({ ...query, ...invalid })).rejects.toThrow();
      await expect(routineOccurrences({ sources: { ...f.sources, watchRoots: [join(f.dir, "missing")] }, dir: f.owned, flowEditing: false, scope, args: query })).rejects.toThrow("discovery is incomplete");
      await expect(routineOccurrences({ sources: { ...f.sources, activationsDir: join(f.dir, "absent-activations") }, dir: f.owned, flowEditing: false, scope, args: query })).rejects.toThrow("source");
      await expect(routineOccurrences({ sources: { ...f.sources, routinesDir: join(f.dir, "absent-routines") }, dir: f.owned, flowEditing: false, scope, args: query })).rejects.toThrow("source");
      await writeFile(join(f.central, "broken.yaml"), "bad");
      await expect(f.read()).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
});
