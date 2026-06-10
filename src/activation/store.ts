import { readFileSync } from "node:fs";
import { parseActivationDocument } from "./schema";
import type { ActivationBlueprint, ImpulseKind } from "./types";

export class DuplicateIdError extends Error {
  constructor(id: string, firstFile: string, secondFile: string) {
    super(
      `Duplicate Activation Blueprint id "${id}" — defined in both ${firstFile} and ${secondFile}. ` +
        `Blueprint ids are global across all config surfaces; rename one.`,
    );
    this.name = "DuplicateIdError";
  }
}

/**
 * Parse + merge a list of activation documents into one blueprint set.
 * A duplicate id across ANY two files is a load error naming both paths
 * (spec FR-4 — fail loud, no silent shadowing).
 */
export async function loadBlueprintSet(files: string[]): Promise<ActivationBlueprint[]> {
  const byId = new Map<string, ActivationBlueprint>();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const blueprint of parseActivationDocument(text, file)) {
      const existing = byId.get(blueprint.id);
      if (existing) {
        throw new DuplicateIdError(blueprint.id, existing.sourceFile, blueprint.sourceFile);
      }
      byId.set(blueprint.id, blueprint);
    }
  }
  return [...byId.values()];
}

/**
 * Holds the live blueprint set. swap() is a single reference assignment —
 * readers that grabbed current() keep an immutable snapshot (spec FR-5).
 * Removal diffs feed the approvals lifecycle (spec FR-6: Matched Decisions
 * for removed blueprints expire with reason blueprint-removed — R-106
 * registers the callback).
 */
export class BlueprintStore {
  private set: readonly ActivationBlueprint[];
  private removedCallbacks: Array<(ids: string[]) => void> = [];

  constructor(initial: ActivationBlueprint[]) {
    this.set = Object.freeze([...initial]);
  }

  current(): readonly ActivationBlueprint[] {
    return this.set;
  }

  get(id: string): ActivationBlueprint | undefined {
    return this.set.find((b) => b.id === id);
  }

  byKind(kind: ImpulseKind): ActivationBlueprint[] {
    return this.set.filter((b) => b.kind === kind);
  }

  onBlueprintsRemoved(callback: (ids: string[]) => void): void {
    this.removedCallbacks.push(callback);
  }

  swap(next: ActivationBlueprint[]): void {
    const nextIds = new Set(next.map((b) => b.id));
    const removed = this.set.filter((b) => !nextIds.has(b.id)).map((b) => b.id);
    this.set = Object.freeze([...next]);
    if (removed.length > 0) {
      for (const cb of this.removedCallbacks) cb(removed);
    }
  }
}
