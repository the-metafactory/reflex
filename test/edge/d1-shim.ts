import { Database } from "bun:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

/**
 * Minimal D1Database test double over bun:sqlite — just enough surface for
 * drizzle-orm/d1 (bind().run()/.all()/.raw()) and D1Repository's raw CAS
 * paths (meta.changes, batch-as-transaction). Lets the D1 driver run under
 * `bun test` without miniflare/workerd infra.
 *
 * Fidelity notes:
 * - `batch()` wraps statements in BEGIN/COMMIT — same atomicity D1 gives.
 * - `meta.changes` comes from bun:sqlite's Statement.run() result — same
 *   sqlite changes() semantics D1 reports.
 * - NOT a full D1 emulation (no sessions API, no exec parsing edge cases);
 *   live D1 behavior is verified at deploy time.
 */
export function createD1Shim(sqlite: Database): D1Database {
  function prepared(query: string, params: unknown[] = []): D1PreparedStatement {
    const stmt = {
      bind(...values: unknown[]): D1PreparedStatement {
        return prepared(query, values);
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const row = sqlite.prepare(query).get(...(params as never[])) as Record<string, unknown> | null;
        if (!row) return null;
        return (colName ? row[colName] : row) as T;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const result = sqlite.prepare(query).run(...(params as never[]));
        return d1Result<T>([], Number(result.changes), Number(result.lastInsertRowid));
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rows = sqlite.prepare(query).all(...(params as never[])) as T[];
        return d1Result<T>(rows, 0, 0);
      },
      async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
        const s = sqlite.prepare(query);
        const rows = s.values(...(params as never[])) as T[];
        if (options?.columnNames) {
          return [s.columnNames as T, ...rows];
        }
        return rows;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  const db = {
    prepare(query: string): D1PreparedStatement {
      return prepared(query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.run("BEGIN");
      try {
        const results: D1Result<T>[] = [];
        for (const stmt of statements) {
          // Statements built by this shim expose run(); drizzle's batch
          // path maps results itself from the same shape.
          results.push((await (stmt as unknown as { run(): Promise<D1Result<T>> }).run()) as D1Result<T>);
        }
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string): Promise<{ count: number; duration: number }> {
      sqlite.run(query);
      return { count: 1, duration: 0 };
    },
    dump(): never {
      throw new Error("d1-shim: dump() not implemented");
    },
    withSession(): never {
      throw new Error("d1-shim: sessions not implemented");
    },
  };
  return db as unknown as D1Database;
}

function d1Result<T>(results: T[], changes: number, lastRowId: number): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      duration: 0,
      changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
    },
  } as D1Result<T>;
}
