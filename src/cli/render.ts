import type { CmdResponse } from "../cmd/protocol";
import { PROTOCOL_VERSION } from "../cmd/protocol";

export const EXIT_OK = 0;
export const EXIT_DOMAIN = 1;
export const EXIT_TRANSPORT = 2;

export interface Rendered {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

/**
 * Map a CmdResponse to output + exit code. `--json` emits the raw response
 * data (single JSON document, script-safe). A response from a NEWER protocol
 * than this CLI understands renders raw with a warning (forward compat).
 */
export function renderResponse(
  response: CmdResponse,
  options: { json: boolean; human: (data: unknown) => string },
): Rendered {
  if (response.v > PROTOCOL_VERSION) {
    return {
      exitCode: response.ok ? EXIT_OK : EXIT_DOMAIN,
      stdout: JSON.stringify(response, null, 2),
      stderr: `warning: response protocol v${response.v} is newer than this CLI (v${PROTOCOL_VERSION}) — raw output`,
    };
  }
  if (!response.ok) {
    const error = response.error ?? { code: "internal", message: "unknown error" };
    if (options.json) {
      return { exitCode: EXIT_DOMAIN, stdout: JSON.stringify({ error }, null, 2) };
    }
    const state = error.currentState ? ` (current state: ${error.currentState})` : "";
    return { exitCode: EXIT_DOMAIN, stdout: "", stderr: `error [${error.code}]: ${error.message}${state}` };
  }
  if (options.json) {
    return { exitCode: EXIT_OK, stdout: JSON.stringify(response.data ?? null, null, 2) };
  }
  return { exitCode: EXIT_OK, stdout: options.human(response.data) };
}

export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => String(r[c] ?? ""))))].join(
    "\n",
  );
}
