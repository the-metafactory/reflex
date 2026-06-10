import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type ReflexDb = BunSQLiteDatabase<typeof schema>;

/** Resolved at import time so bundled callers still find the SQL files. */
const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

/**
 * Open (creating if needed) the Reflex DB: WAL mode, busy timeout, then run
 * committed migrations BEFORE returning — no subsystem touches an
 * unmigrated DB (spec FR-1, FR-8). Migration failure throws naming the
 * migrations folder; the daemon caller exits non-zero.
 */
export function openDb(path: string): { db: ReflexDb; close: () => void } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  let sqlite: Database;
  try {
    sqlite = new Database(path, { create: true });
  } catch (error) {
    throw new Error(
      `Cannot open reflex DB at ${path}: ${(error as Error).message} — another reflex instance running?`,
    );
  }
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA busy_timeout = 5000;");
  sqlite.run("PRAGMA foreign_keys = ON;");

  const db = drizzle(sqlite, { schema });
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } catch (error) {
    sqlite.close();
    throw new Error(`Reflex DB migration failed (${MIGRATIONS_DIR}): ${(error as Error).message}`);
  }
  return { db, close: () => sqlite.close() };
}
