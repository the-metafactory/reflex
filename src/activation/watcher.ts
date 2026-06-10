import { watch, type FSWatcher } from "node:fs";
import { readFileSync } from "node:fs";
import { discoverActivationFiles, type DiscoverOptions } from "./sources";
import { BlueprintStore, loadBlueprintSet } from "./store";

export interface WatcherOptions {
  /** Debounce window for filesystem event storms. Default 200ms. */
  debounceMs?: number;
}

/**
 * Hot-reload (spec FR-5): watch both config surfaces at directory level
 * (atomic-rename editor writes land as directory events), debounce, then
 * re-discover + re-parse the FULL set and atomically swap. Any failure
 * keeps the last good set — a broken edit never takes down a running set.
 * Content hashing avoids no-op swaps when events fire without changes.
 */
export class ActivationWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastErrorMessage: string | null = null;
  private lastHash: string | null = null;
  private reloadCallbacks: Array<() => void> = [];
  private readonly debounceMs: number;

  constructor(
    private readonly store: BlueprintStore,
    private readonly sources: DiscoverOptions,
    options: WatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 200;
  }

  onReload(callback: () => void): void {
    this.reloadCallbacks.push(callback);
  }

  lastError(): string | null {
    return this.lastErrorMessage;
  }

  async start(): Promise<void> {
    this.lastHash = await this.contentHash();
    const dirs = [...this.sources.watchRoots, this.sources.activationsDir];
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, { recursive: true }, () => this.schedule());
        watcher.on("error", (error) => {
          console.warn(`[reflex-config] watcher error on ${dir}: ${(error as Error).message}`);
        });
        this.watchers.push(watcher);
      } catch {
        // Missing dir already warned by discovery; nothing to watch.
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, this.debounceMs);
  }

  private async contentHash(): Promise<string> {
    const files = await discoverActivationFiles({ ...this.sources, onWarning: () => {} });
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of files) {
      hasher.update(file);
      try {
        hasher.update(readFileSync(file));
      } catch {
        hasher.update("<unreadable>");
      }
    }
    return hasher.digest("hex");
  }

  private async reload(): Promise<void> {
    try {
      const hash = await this.contentHash();
      if (hash === this.lastHash) return; // event without content change
      const files = await discoverActivationFiles(this.sources);
      const next = await loadBlueprintSet(files);
      this.store.swap(next);
      this.lastHash = hash;
      this.lastErrorMessage = null;
      for (const cb of this.reloadCallbacks) cb();
    } catch (error) {
      // Last-good-set policy: log, keep serving the previous set.
      this.lastErrorMessage = (error as Error).message;
      console.error(`[reflex-config] reload rejected — keeping last good set:\n${this.lastErrorMessage}`);
    }
  }
}
