/**
 * Reflex — the activation runtime of the metafactory ecosystem.
 * Library surface (R-101): config, bus, envelope builders, stream ensure.
 * The daemon binary arrives with the scheduler (R-105); the CLI with R-107.
 */
export { loadConfig, DEFAULT_CONFIG_PATH, type LoadOptions } from "./config/load";
export { configSchema, type ReflexConfig } from "./config/schema";
export {
  createReflexBus,
  type ReflexBus,
  type ReflexBusMetrics,
  type ReflexBusOptions,
} from "./bus";
export {
  ACTIVATION_DECISION_TYPE_PREFIX,
  ACTIVATION_FIRED_TYPE,
  buildActivationDecision,
  buildActivationFired,
  reflexSource,
  type ActivationDecisionInput,
  type ActivationFiredInput,
  type PublishedDecisionOutcome,
  type ReflexActor,
} from "./bus/envelopes";
export { ensureReflexStream, REFLEX_STREAM_NAME, reflexStreamSubjects } from "./bus/stream";
export {
  ACTIVATION_SCHEMA_ID,
  parseActivationDocument,
  parseDuration,
} from "./activation/schema";
export type {
  ActivationBlueprint,
  ActivationGuards,
  ActivationPolicy,
  ImpulseKind,
  WhenBlock,
} from "./activation/types";
export { BlueprintStore, DuplicateIdError, loadBlueprintSet } from "./activation/store";
export { discoverActivationFiles, type DiscoverOptions } from "./activation/sources";
export { ActivationWatcher, type WatcherOptions } from "./activation/watcher";
export { validatePaths, type ValidationResult } from "./activation/validate-cli";
export { openDb, type ReflexDb } from "./store/db";
export { defaultDbPath } from "./store/paths";
export {
  ConflictError,
  Repository,
  StorageError,
  type ApprovalRow,
  type DecisionOutcome,
  type DecisionRow,
  type ImpulseSnapshot,
} from "./store/repository";
// Public pipeline surface: Pipeline + its I/O types. Guard internals
// (checkGuards, key derivation, window constant) stay module-private —
// root exports are stable API (sage R-104 finding); tests import internally.
export { Pipeline, type PipelineOptions } from "./pipeline/evaluate";
export type { EvaluateResult, GuardReason, Impulse } from "./pipeline/impulse";
export type { DryRunVerdict } from "./pipeline/verdict";
// Daemon surface is deliberately opaque at the package root (sage R-105):
// stop + schedule status only. Internal composition (pipeline/store/repo/bus,
// ScheduleSource) is reachable via module imports inside this repo, not API.
export { startDaemon } from "./daemon";
export type { ReflexDaemonHandle } from "./daemon";
export type { ScheduleStatus } from "./sources/schedule";
// BoundedPublishQueue stays module-private (sage R-101 review): callers need
// createReflexBus + metrics, not the outage-buffer implementation.
