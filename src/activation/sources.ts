import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DiscoverOptions {
  /** Roots scanned recursively for sidecar `reflex.yaml` files. */
  watchRoots: string[];
  /** Central directory: every `*.yaml` is an activation document. */
  activationsDir: string;
  onWarning?: (message: string) => void;
}

/**
 * Discover activation documents across both config surfaces (spec FR-3).
 * Absent central dir = empty surface. Missing watch root = warning, continue.
 * Result is deduped and stable-sorted.
 */
export async function discoverActivationFiles(options: DiscoverOptions): Promise<string[]> {
  const warn = options.onWarning ?? ((m: string) => console.warn(`[reflex-config] ${m}`));
  const found = new Set<string>();

  for (const root of new Set(options.watchRoots)) {
    if (!existsSync(root)) {
      warn(`watch root not found: ${root} — skipping this surface`);
      continue;
    }
    const glob = new Bun.Glob("**/reflex.yaml");
    for await (const rel of glob.scan({ cwd: root, absolute: false })) {
      found.add(join(root, rel));
    }
  }

  if (existsSync(options.activationsDir)) {
    const glob = new Bun.Glob("*.yaml");
    for await (const rel of glob.scan({ cwd: options.activationsDir, absolute: false })) {
      found.add(join(options.activationsDir, rel));
    }
  }

  return [...found].sort();
}
