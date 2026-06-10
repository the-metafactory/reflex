import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/store/db";
import { Repository } from "../../src/store/repository";

const SRC = join(import.meta.dir, "../../src");
const IMPULSE = { kind: "manual" as const, payload: {}, receivedAt: "2026-06-10T10:00:00Z" };

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("architectural gates", () => {
  it("ADR-0001: no UPDATE targets decisions outcome anywhere in src/", () => {
    for (const file of tsFiles(SRC)) {
      const text = readFileSync(file, "utf-8");
      expect(text.includes("update(decisions)")).toBe(false);
      expect(/UPDATE\s+decisions/i.test(text)).toBe(false);
    }
  });

  it("no drizzle/sqlite imports outside src/store (repository is the only query module)", () => {
    for (const file of tsFiles(SRC)) {
      if (file.includes("/store/")) continue;
      const text = readFileSync(file, "utf-8");
      expect(text.includes("drizzle-orm")).toBe(false);
      expect(text.includes("bun:sqlite")).toBe(false);
    }
  });
});

describe("performance", () => {
  it("1000 decision inserts complete within budget", () => {
    const { db, close } = openDb(":memory:");
    const r = new Repository(db);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      r.recordDecision({ blueprintId: `bp-${i % 10}`, outcome: "fired", impulse: IMPULSE });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
    close();
  });

  it("history query on a 10k-row table is fast", () => {
    const { db, close } = openDb(":memory:");
    const r = new Repository(db);
    for (let i = 0; i < 10_000; i++) {
      r.recordDecision({ blueprintId: `bp-${i % 100}`, outcome: "blocked", impulse: IMPULSE, guardBlockReason: "cooldown" });
    }
    const start = performance.now();
    const rows = r.historyFor({ blueprintId: "bp-7", limit: 100 });
    const elapsed = performance.now() - start;
    expect(rows.length).toBe(100);
    expect(elapsed).toBeLessThan(20);
    close();
  });
});
