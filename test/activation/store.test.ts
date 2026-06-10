import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlueprintStore, DuplicateIdError, loadBlueprintSet } from "../../src/activation/store";

function fileWith(id: string, dir?: string): string {
  const d = dir ?? mkdtempSync(join(tmpdir(), "reflex-store-"));
  const path = join(d, `${id}.yaml`);
  writeFileSync(
    path,
    `schema: metafactory/activation/v1\nactivations:\n  - id: ${id}\n    target: "@jc/${id}"\n    when:\n      manual: {}\n`,
  );
  return path;
}

describe("loadBlueprintSet", () => {
  it("merges blueprints across files", async () => {
    const set = await loadBlueprintSet([fileWith("aa"), fileWith("bb")]);
    expect(set.map((b) => b.id).sort()).toEqual(["aa", "bb"]);
  });

  it("duplicate id names BOTH files", async () => {
    const dir1 = mkdtempSync(join(tmpdir(), "reflex-store-"));
    const dir2 = mkdtempSync(join(tmpdir(), "reflex-store-"));
    const f1 = fileWith("dup", dir1);
    const f2 = fileWith("dup", dir2);
    try {
      await loadBlueprintSet([f1, f2]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateIdError);
      expect((error as Error).message).toContain(f1);
      expect((error as Error).message).toContain(f2);
    }
  });
});

describe("BlueprintStore", () => {
  it("swap is atomic — readers keep their snapshot", async () => {
    const store = new BlueprintStore(await loadBlueprintSet([fileWith("aa")]));
    const snapshot = store.current();
    store.swap(await loadBlueprintSet([fileWith("bb")]));
    expect(snapshot.map((b) => b.id)).toEqual(["aa"]); // old snapshot untouched
    expect(store.current().map((b) => b.id)).toEqual(["bb"]);
  });

  it("reports removed blueprint ids to registered callbacks on swap", async () => {
    const store = new BlueprintStore(await loadBlueprintSet([fileWith("aa"), fileWith("bb")]));
    const removed: string[][] = [];
    store.onBlueprintsRemoved((ids) => removed.push(ids));
    store.swap(await loadBlueprintSet([fileWith("bb")]));
    expect(removed).toEqual([["aa"]]);
  });

  it("byKind filters", async () => {
    const store = new BlueprintStore(await loadBlueprintSet([fileWith("aa")]));
    expect(store.byKind("manual").map((b) => b.id)).toEqual(["aa"]);
    expect(store.byKind("schedule")).toEqual([]);
  });

  it("get returns a blueprint by id or undefined", async () => {
    const store = new BlueprintStore(await loadBlueprintSet([fileWith("aa")]));
    expect(store.get("aa")?.target).toBe("@jc/aa");
    expect(store.get("zz")).toBeUndefined();
  });
});
