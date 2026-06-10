import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/store/db";
import { defaultDbPath } from "../../src/store/paths";

describe("paths", () => {
  it("honors XDG_STATE_HOME", () => {
    expect(defaultDbPath({ XDG_STATE_HOME: "/custom/state" })).toBe("/custom/state/reflex/reflex.db");
  });
  it("defaults to ~/.local/state", () => {
    expect(defaultDbPath({})).toContain("/.local/state/reflex/reflex.db");
  });
});

describe("openDb", () => {
  it("creates, migrates, and exposes all six tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-db-"));
    const { db, close } = openDb(join(dir, "deep/reflex.db"));
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%drizzle%' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      "approvals",
      "decisions",
      "fired_events",
      "guard_state",
      "idempotency_keys",
      "ignored_counters",
    ]);
    close();
  });

  it("rejects a seventh outcome via CHECK (valid outcome inserts fine)", () => {
    const { db, close } = openDb(":memory:");
    // Positive control: identical statement with a valid outcome succeeds —
    // so the rejection below is the CHECK constraint, not a syntax problem.
    db.run(
      sql`INSERT INTO decisions (id, blueprint_id, outcome, impulse, created_at) VALUES ('ok','b','fired','{}','2026-01-01T00:00:00Z')`,
    );
    expect(() =>
      db.run(
        sql`INSERT INTO decisions (id, blueprint_id, outcome, impulse, created_at) VALUES ('x','b','exploded','{}','2026-01-01T00:00:00Z')`,
      ),
    ).toThrow();
    close();
  });

  it("is idempotent across reopen (migrations re-run as no-op)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-db-"));
    const path = join(dir, "reflex.db");
    openDb(path).close();
    const second = openDb(path);
    expect(second.db).toBeDefined();
    second.close();
  });
});

describe("permissions", () => {
  it("state dir 0700, db file 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflex-db-"));
    const path = join(dir, "private/reflex.db");
    openDb(path).close();
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
