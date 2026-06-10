import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseActivationDocument } from "./schema";
import { DuplicateIdError, mergeBlueprints } from "./store";
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
  const fileSet = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) {
      return { ok: false, blueprints: [], errors: [{ file: path, message: `path not found: ${path}` }] };
    }
    if (statSync(path).isDirectory()) {
      for await (const rel of new Bun.Glob("**/reflex.yaml").scan({ cwd: path })) {
        fileSet.add(join(path, rel));
      }
      for await (const rel of new Bun.Glob("*.yaml").scan({ cwd: path })) {
        fileSet.add(join(path, rel));
      }
    } else {
      fileSet.add(path);
    }
  }

  const errors: ValidationResult["errors"] = [];
  // The SAME merge the daemon loader uses (mergeBlueprints) runs here —
  // applied incrementally per file so errors attribute to the offending
  // file. A failed file contributes nothing; a contested id is purged
  // (sage R-102 cycle-2/3 findings).
  let merged: ActivationBlueprint[] = [];
  for (const file of [...fileSet].sort()) {
    try {
      const parsed = parseActivationDocument(await Bun.file(file).text(), file);
      merged = mergeBlueprints([merged, parsed]);
    } catch (error) {
      if (error instanceof DuplicateIdError) {
        merged = merged.filter((b) => b.id !== error.id);
      }
      errors.push({ file, message: (error as Error).message });
    }
  }
  return { ok: errors.length === 0, blueprints: merged, errors };
}
