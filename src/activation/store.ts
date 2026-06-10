import { parseActivationDocument } from "./schema";
import type { ActivationBlueprint, ImpulseKind } from "./types";

export class DuplicateIdError extends Error {
  /** The contested blueprint id — consumers purge it from any partial result. */
  readonly id: string;
  constructor(id: string, firstFile: string, secondFile: string) {
    super(
      `Duplicate Activation Blueprint id "${id}" — defined in both ${firstFile} and ${secondFile}. ` +
        `Blueprint ids are global across all config surfaces; rename one.`,
    );
    this.name = "DuplicateIdError";
    this.id = id;
  }
}

/** Recursively freeze a blueprint so a snapshot really is immutable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Merge already-parsed blueprints into one set. Duplicate id across ANY two
 * sources throws DuplicateIdError naming both paths (spec FR-4). Shared by
 * the daemon loader and `validatePaths` so the two can never disagree.
 */
export function mergeBlueprints(parsed: ActivationBlueprint[][]): ActivationBlueprint[] {
  const byId = new Map<string, ActivationBlueprint>();
  for (const list of parsed) {
    for (const blueprint of list) {
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
 * Read + parse + merge a list of activation documents. Reads are async —
 * the reload path runs on the daemon event loop and must not block it
 * (sage R-102 finding).
 */
export async function loadBlueprintSet(files: string[]): Promise<ActivationBlueprint[]> {
  const parsed = await Promise.all(
    files.map(async (file) => parseActivationDocument(await Bun.file(file).text(), file)),
  );
  return mergeBlueprints(parsed);
}

/**
 * Holds the live blueprint set. swap() is a single reference assignment —
 * readers that grabbed current() keep a deep-frozen immutable snapshot
 * (spec FR-5; blueprints and their nested when/guards/payload are frozen,
 * not just the array). Removal diffs feed the approvals lifecycle (spec
 * FR-6: Matched Decisions for removed blueprints expire with reason
 * blueprint-removed — R-106 registers the callback). Callback errors are
 * contained here — a throwing subscriber can never corrupt or roll back a
 * completed swap.
 */
export class BlueprintStore {
  private set: readonly ActivationBlueprint[];
  private removedCallbacks: Array<(ids: string[]) => void> = [];

  constructor(initial: ActivationBlueprint[]) {
    this.set = deepFreeze(Object.freeze([...initial.map(deepFreeze)]));
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
    this.set = Object.freeze([...next.map(deepFreeze)]);
    if (removed.length > 0) {
      for (const cb of this.removedCallbacks) {
        try {
          cb(removed);
        } catch (error) {
          console.error(`[reflex-config] blueprint-removed callback failed: ${(error as Error).message}`);
        }
      }
    }
  }
}
