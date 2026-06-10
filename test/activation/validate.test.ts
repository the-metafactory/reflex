import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePaths } from "../../src/activation/validate-cli";

const GOOD = `schema: metafactory/activation/v1
activations:
  - id: good-one
    target: "@jc/good"
    when:
      manual: {}
`;

const BAD_KIND = `schema: metafactory/activation/v1
activations:
  - id: bad-kind
    target: "@jc/bad"
    when:
      schedule: "0 7 * * *"
      manual: {}
`;

const BAD_YAML = `schema: metafactory/activation/v1\nactivations: [`;

describe("validatePaths", () => {
  it("validates a directory corpus: one error per bad file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-validate-"));
    writeFileSync(join(dir, "good.yaml"), GOOD);
    writeFileSync(join(dir, "badkind.yaml"), BAD_KIND);
    writeFileSync(join(dir, "badyaml.yaml"), BAD_YAML);
    const result = await validatePaths([dir]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.file).sort()).toEqual(
      [join(dir, "badkind.yaml"), join(dir, "badyaml.yaml")].sort(),
    );
    expect(result.blueprints.map((b) => b.id)).toEqual(["good-one"]);
  });

  it("returns ok for a clean tree incl. sidecars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-validate-"));
    mkdirSync(join(dir, "flows/a"), { recursive: true });
    writeFileSync(join(dir, "flows/a/reflex.yaml"), GOOD.replace("good-one", "sidecar-one"));
    writeFileSync(join(dir, "central.yaml"), GOOD);
    const result = await validatePaths([dir]);
    expect(result.ok).toBe(true);
    expect(result.blueprints.map((b) => b.id).sort()).toEqual(["good-one", "sidecar-one"]);
  });

  it("catches duplicate ids across files and purges the contested id from results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-validate-"));
    writeFileSync(join(dir, "one.yaml"), GOOD);
    writeFileSync(join(dir, "two.yaml"), GOOD);
    const result = await validatePaths([dir]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain("good-one");
    expect(result.errors[0]!.message).toContain("one.yaml");
    // The contested id must NOT surface as a clean blueprint.
    expect(result.blueprints.map((b) => b.id)).not.toContain("good-one");
  });

  it("an invalid file contributes NO blueprints, not partial ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-validate-"));
    // File with one valid entry followed by an in-file duplicate: whole file rejected.
    writeFileSync(
      join(dir, "partial.yaml"),
      `schema: metafactory/activation/v1
activations:
  - id: first-ok
    target: "@jc/a"
    when:
      manual: {}
  - id: first-ok
    target: "@jc/b"
    when:
      manual: {}
`,
    );
    const result = await validatePaths([dir]);
    expect(result.ok).toBe(false);
    expect(result.blueprints).toEqual([]); // nothing partial leaked
  });

  it("missing path is an error, not a throw", async () => {
    const result = await validatePaths(["/no/such/path"]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain("/no/such/path");
  });
});
