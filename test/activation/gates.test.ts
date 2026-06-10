import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BlueprintStore } from "../../src/activation/store";
import { parseActivationDocument } from "../../src/activation/schema";

const ACTIVATION_SRC = join(import.meta.dir, "../../src/activation");

describe("architectural gates", () => {
  it("src/activation has zero myelin imports (NFR-4: loader is transport-free)", () => {
    for (const file of readdirSync(ACTIVATION_SRC)) {
      const text = readFileSync(join(ACTIVATION_SRC, file), "utf-8");
      expect(text.includes("@the-metafactory/myelin")).toBe(false);
    }
  });

  it("100 blueprints parse + swap under 500ms (NFR-1)", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      [
        `  - id: bp-${i}`,
        `    target: "@jc/bp-${i}"`,
        `    when:`,
        `      schedule: "${i % 60} 7 * * *"`,
      ].join("\n"),
    ).join("\n");
    const text = `schema: metafactory/activation/v1\nactivations:\n${entries}\n`;
    const start = performance.now();
    const blueprints = parseActivationDocument(text, "/tmp/perf.yaml");
    const store = new BlueprintStore([]);
    store.swap(blueprints);
    const elapsed = performance.now() - start;
    expect(blueprints).toHaveLength(100);
    expect(elapsed).toBeLessThan(500);
  });
});
