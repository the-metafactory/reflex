import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT_DOMAIN, EXIT_OK, renderResponse } from "../../src/cli/render";

describe("renderResponse", () => {
  it("maps ok → 0, domain error → 1; conflict state surfaces", () => {
    expect(renderResponse({ v: 1, ok: true, data: { x: 1 } }, { json: true, human: () => "" }).exitCode).toBe(EXIT_OK);
    const err = renderResponse(
      { v: 1, ok: false, error: { code: "conflict", message: "nope", currentState: "denied" } },
      { json: false, human: () => "" },
    );
    expect(err.exitCode).toBe(EXIT_DOMAIN);
    expect(err.stderr).toContain("denied");
  });

  it("newer protocol → warning + raw passthrough, never a crash", () => {
    const r = renderResponse({ v: 2, ok: true, data: { future: true } }, { json: false, human: () => "ignored" });
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.stderr).toContain("newer than this CLI");
    expect(JSON.parse(r.stdout)).toEqual({ v: 2, ok: true, data: { future: true } });
  });
});

describe("vocabulary audit (CLI surface)", () => {
  it("no banned glossary terms in cli/cmd sources", () => {
    for (const dir of ["src/cli", "src/cmd"]) {
      for (const file of readdirSync(join(import.meta.dir, "../../", dir))) {
        const text = readFileSync(join(import.meta.dir, "../../", dir, file), "utf-8");
        for (const banned of ["trigger", "overlap", "webhook", " cue ", '"cue"'] ) {
          expect(text.toLowerCase().includes(banned)).toBe(false);
        }
      }
    }
  });
});

describe("protocol gates (router-side, via e2e rig in e2e.test.ts)", () => {
  it("placeholder — version + actor gates asserted in router tests", () => {
    expect(true).toBe(true);
  });
});
