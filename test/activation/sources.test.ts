import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverActivationFiles } from "../../src/activation/sources";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "reflex-sources-"));
}

describe("discoverActivationFiles", () => {
  it("finds sidecar reflex.yaml files recursively under watch roots", async () => {
    const root = tmp();
    mkdirSync(join(root, "flows/a"), { recursive: true });
    mkdirSync(join(root, "flows/b/deep"), { recursive: true });
    writeFileSync(join(root, "flows/a/reflex.yaml"), "x");
    writeFileSync(join(root, "flows/b/deep/reflex.yaml"), "x");
    writeFileSync(join(root, "flows/a/other.yaml"), "x"); // not a sidecar
    const files = await discoverActivationFiles({ watchRoots: [root], activationsDir: join(root, "nope") });
    expect(files.sort()).toEqual([join(root, "flows/a/reflex.yaml"), join(root, "flows/b/deep/reflex.yaml")].sort());
  });

  it("includes every *.yaml in the central dir", async () => {
    const central = tmp();
    writeFileSync(join(central, "one.yaml"), "x");
    writeFileSync(join(central, "two.yaml"), "x");
    writeFileSync(join(central, "notes.txt"), "x");
    const files = await discoverActivationFiles({ watchRoots: [], activationsDir: central });
    expect(files.sort()).toEqual([join(central, "one.yaml"), join(central, "two.yaml")].sort());
  });

  it("treats an absent central dir as empty and warns-but-continues on a missing root", async () => {
    const warnings: string[] = [];
    const files = await discoverActivationFiles({
      watchRoots: ["/definitely/missing/root"],
      activationsDir: "/definitely/missing/central",
      onWarning: (w) => warnings.push(w),
    });
    expect(files).toEqual([]);
    expect(warnings.join(" ")).toContain("/definitely/missing/root");
    expect(warnings.join(" ")).not.toContain("central");
  });

  it("merges both surfaces and dedupes", async () => {
    const root = tmp();
    writeFileSync(join(root, "reflex.yaml"), "x");
    const files = await discoverActivationFiles({
      watchRoots: [root, root],
      activationsDir: root, // reflex.yaml is not *.yaml-in-central? it IS .yaml — dedupe must collapse
    });
    expect(files).toEqual([join(root, "reflex.yaml")]);
  });
});
