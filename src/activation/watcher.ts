import { watch, type FSWatcher } from "node:fs";
import { discoverActivationFiles, type DiscoverOptions } from "./sources";
import { BlueprintStore, mergeBlueprints } from "./store";
import { parseActivationDocument } from "./schema";

export interface WatcherOptions {
  /** Debounce window for filesystem event storms. Default 200ms. */
  debounceMs?: number;
  /**
   * Safety-net rescan cadence. macOS fs.watch can drop events around watcher
   * arming and under load; a periodic content-hash rescan catches anything
   * missed. No-op suppression makes idle rescans cheap. Default 2000ms.
   */
  rescanIntervalMs?: number;
}

/**
 * Hot-reload (spec FR-5): watch both config surfaces at directory level
 * (atomic-rename editor writes land as directory events), debounce, then
 * re-discover + re-parse the FULL set and atomically swap. Any failure
 * BEFORE the swap (read, parse, merge) keeps the last good set — a broken
 * edit never takes down a running set. The swap is the commit point;
 * subscriber callbacks run after it and are error-contained. Content
 * hashing avoids no-op swaps when events fire without changes.
 */
export class ActivationWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private lastErrorMessage: string | null = null;
  private lastHash: string | null = null;
  private reloadCallbacks: Array<() => void> = [];
  private readonly debounceMs: number;

  private readonly rescanIntervalMs: number;

  constructor(
    private readonly store: BlueprintStore,
    private readonly sources: DiscoverOptions,
    options: WatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 200;
    this.rescanIntervalMs = options.rescanIntervalMs ?? 2000;
  }

  onReload(callback: () => void): void {
    this.reloadCallbacks.push(callback);
  }

  lastError(): string | null {
    return this.lastErrorMessage;
  }

  async start(): Promise<void> {
    this.lastHash = (await this.readCorpus()).hash;
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
    // Safety net for dropped fs events (macOS arming race): periodic rescan;
    // content-hash no-op suppression keeps idle cost at one hash pass.
    this.rescanTimer = setInterval(() => {
      void this.reload();
    }, this.rescanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
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

  /**
   * One async read pass over the corpus: contents feed BOTH the change hash
   * and (when changed) the parse — no synchronous reads, no double read of
   * the same files (sage R-102 finding: reload must not block the daemon
   * event loop).
   */
  private async readCorpus(): Promise<{ hash: string; docs: Array<{ file: string; text: string }> }> {
    const files = await discoverActivationFiles({ ...this.sources, onWarning: () => {} });
    const docs = await Promise.all(
      files.map(async (file) => {
        try {
          return { file, text: await Bun.file(file).text() };
        } catch {
          return { file, text: "<unreadable>" };
        }
      }),
    );
    const hasher = new Bun.CryptoHasher("sha256");
    for (const doc of docs) {
      hasher.update(doc.file);
      hasher.update(doc.text);
    }
    return { hash: hasher.digest("hex"), docs };
  }

  private async reload(): Promise<void> {
    // Phase 1 — everything that can REJECT the reload happens before swap;
    // the last-good-set guarantee covers exactly this phase.
    let next;
    let hash: string;
    try {
      const corpus = await this.readCorpus();
      if (corpus.hash === this.lastHash) return; // event without content change
      hash = corpus.hash;
      next = mergeBlueprints(corpus.docs.map((d) => parseActivationDocument(d.text, d.file)));
    } catch (error) {
      // Last-good-set policy: log, keep serving the previous set.
      this.lastErrorMessage = (error as Error).message;
      console.error(`[reflex-config] reload rejected — keeping last good set:\n${this.lastErrorMessage}`);
      return;
    }

    // Phase 2 — commit. The swap is the commit point; subscriber callbacks
    // run after it and are contained, so they can neither roll back nor
    // misreport an already-committed reload (sage R-102 cycle-2 finding).
    this.store.swap(next);
    this.lastHash = hash;
    this.lastErrorMessage = null;
    for (const cb of this.reloadCallbacks) {
      try {
        cb();
      } catch (error) {
        console.error(`[reflex-config] reload callback failed (set already live): ${(error as Error).message}`);
      }
    }
  }
}
