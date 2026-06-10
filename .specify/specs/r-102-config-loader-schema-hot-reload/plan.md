# Plan: R-102 Config Loader + Schema + Hot-Reload

**Spec:** `spec.md` (82%) · **Date:** 2026-06-10 · **Builds on:** R-101 (`src/config/` daemon config — distinct from this feature's *blueprint* config)

## Architecture

```
src/
  activation/
    schema.ts        # zod: metafactory/activation/v1 — Activation Blueprint entry (FR-1, FR-2)
    types.ts         # ActivationBlueprint, WhenBlock, ImpulseKind, Guards (canonical glossary names)
    parse.ts         # YAML file → validated blueprint list, error formatting (FR-8)
    sources.ts       # surface discovery: sidecar glob (**/reflex.yaml) + central dir (FR-3)
    store.ts         # BlueprintStore — merged set, atomic swap, dup-id rejection (FR-4, FR-5)
    watcher.ts       # fs.watch with 200ms debounce → reload pipeline (FR-5)
    validate-cli.ts  # reflex validate core (daemon-less) (FR-7)
test/
  activation/schema.test.ts  parse.test.ts  store.test.ts  watcher.test.ts  validate.test.ts
  fixtures/activation/  # valid + malformed corpus incl. the three R-110 example shapes
```

Daemon config (R-101 `src/config/`) gains `watch_roots: string[]` (default `[]`) and `activations_dir` (default `~/.config/reflex/activations`).

## Spec Traceability

| FR/NFR | Approach |
|--------|----------|
| FR-1 | `schema.ts`: strict zod object per entry — `id` (slug regex), `target` (non-empty string), `when` (discriminated by exactly-one-kind rule), `policy` enum default `auto`, `approval_timeout` duration default `1h`, `guards.cooldown` duration, `guards.run_lock` enum `skip\|buffer`, `payload` record. `.strict()` everywhere — unknown keys are errors |
| FR-2 | `WhenBlock`: zod union over `{schedule, timezone?}` / `{manual: true \| {}}` / `{bus: {subject, where?}}` / `{http: {token_env?}}`; refinement rejects >1 kind with "exactly one Impulse Kind per blueprint in v0". `where` values constrained to string\|number\|boolean (flat — nested object rejected with "flat fields only in v0") |
| FR-3 | `sources.ts`: `Bun.Glob("**/reflex.yaml")` over configured `watch_roots` + `*.yaml` in `activations_dir`; both surfaces → one file list; absent central dir = empty; missing sidecar root = startup warning, continue |
| FR-4 | `store.ts` `loadSet(files)`: parse all → collect blueprints with provenance (file path) → duplicate id → `DuplicateIdError` naming both paths. First load: throw (daemon refuses start). Reload: keep current set, log error block (last-good-set policy) |
| FR-5 | `BlueprintStore.swap(newSet)`: single reference assignment (readers hold the array they grabbed — no torn reads); `watcher.ts` debounces 200ms, re-runs full discovery+parse, calls swap only on full-set validity |
| FR-6 | `store.ts` emits `removed` diff on swap; `onBlueprintsRemoved(cb)` hook — R-106 registers expiry (`blueprint-removed`); v0 wiring here is the callback registry only (R-106 supplies the consumer). Tested with a spy |
| FR-7 | `validate-cli.ts` `validatePaths(paths) → {ok, errors[]}` — pure function consumed later by R-107's `reflex validate`; exit-code mapping lives with the CLI |
| FR-8 | `parse.ts` error formatter: `file:line` (from yaml CST when available), zod path joined (`activations[2].when.bus.where`), expected vs received. Every malformed fixture asserts its message shape |
| FR-9 | Durations via shared `parseDuration` util (`30s/15m/6h/2d` → ms); cron strings validated by constructing a `Croner` instance (same lib R-105 runs — single-library rule) in schema refinement |
| NFR-1/2 | Perf test: 100 synthetic blueprints parse+swap < 500ms; 100 files validate < 1s |
| NFR-3 | Watcher handles atomic-rename: watch directories (not files), re-glob on any event in a watched root |
| NFR-4 | No myelin import anywhere in `src/activation/` (architectural test greps imports) |

## Data Model

```ts
type ImpulseKind = "schedule" | "manual" | "bus" | "http";
interface ActivationBlueprint {
  id: string; target: string; kind: ImpulseKind;
  when: ScheduleWhen | ManualWhen | BusWhen | HttpWhen;
  policy: "auto" | "approval" | "disabled";
  approvalTimeoutMs: number;          // default 3_600_000
  guards: { cooldownMs?: number; runLock?: "skip" | "buffer" };
  payload: Record<string, unknown>;
  sourceFile: string;                  // provenance for error messages
}
```

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---------|-----------|----------|--------------|
| Duplicate id at startup | loadSet | abort daemon, error names both files | startup only |
| Duplicate id on reload | loadSet | keep last-good set, log error block | zero — old set serves |
| Malformed YAML on reload | parse | last-good set, error block names file | zero |
| Watcher event storm (git checkout) | debounce window | single revalidation of final state | one reload |
| Watched root deleted mid-run | fs.watch error event | warning, re-arm watcher on next interval; other roots unaffected | one surface |
| Blueprint removed with waiting Matched Decision | swap diff | `onBlueprintsRemoved` → R-106 expiry `blueprint-removed` | that decision only |
| Clock-skewed editor writes (same mtime) | content hash compare, not mtime | reload fires on content change regardless | none |

## Test Assertions (verifiability)

- `schema.test.ts`: every R-110 example shape parses; `{schedule, bus}` both present → `/exactly one Impulse Kind/`; `run_lock: allow` → error message contains `removing the key`; unknown key `triger:` → strict-mode error naming it; nested `where: {a: {b: 1}}` → `/flat fields only/`.
- `parse.test.ts`: malformed YAML error contains absolute file path; zod error contains `activations[1].guards.cooldown` path and `expected duration` text.
- `store.test.ts`: dup across two files names BOTH paths; swap under concurrent reads — reader iterating old array is unaffected (snapshot identity test); removed-diff spy receives `["gone-id"]`.
- `watcher.test.ts`: write→reload (real tmp dir, 500ms ceiling); invalid write keeps `store.current` identity unchanged; 10 rapid writes → exactly 1 reload (debounce counter).
- `validate.test.ts`: corpus run — `{ok: false}` lists one error per bad file, `{ok: true}` for examples dir.

Framework: `bun:test`, real tmp dirs (`mkdtemp`), no watcher mocking — real `fs.watch` with generous-but-bounded waits.

## Constitutional Compliance

- CLI-First: `validatePaths` is the `reflex validate` core ✓ · Library-First: exported from `src/index.ts` ✓ · Test-First: RED per task ✓ · Deterministic: content-hash reloads, fixed debounce ✓ · Code Before Prompts ✓

## Implementation Order (→ tasks.md)

T-1 duration util + schema → T-2 parse + error format → T-3 sources discovery → T-4 store (merge/dup/swap/diff) → T-5 watcher → T-6 validatePaths + fixtures corpus → T-7 daemon-config keys + index exports.

## Dependencies / Risks

- croner added now (shared with R-105). Risk: `fs.watch` flakiness on macOS — mitigated by directory-level watch + debounce + content hash; watcher tests use real FS deliberately.
