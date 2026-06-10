import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseActivationDocument } from "./schema";
import { DuplicateIdError } from "./store";
import type { ActivationBlueprint } from "./types";

export interface ValidationResult {
  ok: boolean;
  blueprints: ActivationBlueprint[];
  /** One entry per offending file. */
  errors: Array<{ file: string; message: string }>;
}

/**
 * Daemon-less validation core for `reflex validate` (spec FR-7). Accepts
 * files and/or directories; directories are scanned for activation documents
 * (reflex.yaml sidecars anywhere + any *.yaml at the top level). Reports one
 * error block per offending file and cross-file duplicate ids.
 *
 * A file's blueprints enter the merged result only when the WHOLE file is
 * valid — an invalid file contributes errors, never partial blueprints
 * (sage R-102 finding).
 */
export async function validatePaths(paths: string[]): Promise<ValidationResult> {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      return { ok: false, blueprints: [], errors: [{ file: path, message: `path not found: ${path}` }] };
    }
    if (statSync(path).isDirectory()) {
      for await (const rel of new Bun.Glob("**/reflex.yaml").scan({ cwd: path })) {
        files.push(join(path, rel));
      }
      for await (const rel of new Bun.Glob("*.yaml").scan({ cwd: path })) {
        const abs = join(path, rel);
        if (!files.includes(abs)) files.push(abs);
      }
    } else {
      files.push(path);
    }
  }

  const errors: ValidationResult["errors"] = [];
  const byId = new Map<string, ActivationBlueprint>();
  for (const file of [...new Set(files)].sort()) {
    try {
      const parsed = parseActivationDocument(await Bun.file(file).text(), file);
      // Stage the whole file first; merge only if it is clean end-to-end.
      const staged = new Map<string, ActivationBlueprint>();
      for (const blueprint of parsed) {
        const existing = byId.get(blueprint.id) ?? staged.get(blueprint.id);
        if (existing) {
          throw new DuplicateIdError(blueprint.id, existing.sourceFile, blueprint.sourceFile);
        }
        staged.set(blueprint.id, blueprint);
      }
      for (const [id, blueprint] of staged) byId.set(id, blueprint);
    } catch (error) {
      errors.push({ file, message: (error as Error).message });
    }
  }
  return { ok: errors.length === 0, blueprints: [...byId.values()], errors };
}
