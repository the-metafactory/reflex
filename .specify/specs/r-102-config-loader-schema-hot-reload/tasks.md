# Tasks: R-102 Config Loader + Schema + Hot-Reload

Branch: `spec/r-102-config-loader` · TDD: RED → GREEN → full suite → BLUE → commit per task.

## T-1: Duration util + activation schema
- `src/activation/schema.ts` + `types.ts` + `parseDuration` (`30s/15m/6h/2d` → ms). Strict zod, exactly-one-kind refinement, flat-where constraint, croner-backed cron validation.
- Tests `test/activation/schema.test.ts`: R-110 example shapes pass; `{schedule,bus}` → /exactly one Impulse Kind/; `run_lock: allow` → message contains "removing the key"; unknown key → strict error; nested where → /flat fields only/; bad cron → error names expression.
- Covers: FR-1, FR-2, FR-9.

## T-2: Parse + error formatting
- `src/activation/parse.ts`: YAML file → blueprints with provenance; error block formatter (file, zod path, expected vs received).
- Tests `test/activation/parse.test.ts` on malformed fixture corpus.
- Covers: FR-8.

## T-3: Surface discovery
- `src/activation/sources.ts`: sidecar glob over `watch_roots` + central `activations_dir`; absent dir = empty; missing root = warning.
- Tests with tmp dirs.
- Covers: FR-3.

## T-4: BlueprintStore — merge, dup, swap, diff
- `src/activation/store.ts`: loadSet, DuplicateIdError (both paths), atomic swap, last-good-set on reload failure, removed-diff callback registry.
- Tests `test/activation/store.test.ts` incl. snapshot-identity concurrent-read test and removal spy.
- Covers: FR-4, FR-5, FR-6.

## T-5: Watcher
- `src/activation/watcher.ts`: directory-level fs.watch, 200ms debounce, content-hash change detection, re-arm on error.
- Tests `test/activation/watcher.test.ts` with real FS: write→reload <500ms; invalid write keeps set identity; 10 rapid writes → 1 reload.
- Covers: FR-5, NFR-3.

## T-6: validatePaths + fixtures corpus
- `src/activation/validate-cli.ts`; full fixture corpus under `test/fixtures/activation/`.
- Tests: corpus run, one error per bad file, examples-dir green.
- Covers: FR-7.

## T-7: Daemon-config keys + exports
- R-101 config schema gains `watch_roots`, `activations_dir`; `src/index.ts` exports activation module; perf assertions (100 blueprints < 500ms swap).
- Covers: NFR-1, NFR-2, NFR-4 (import-grep architectural test).

## Done gate
- Spec scenarios 1–6 each named in a test; vocabulary grep clean; `specflow validate R-102` all artifacts.
