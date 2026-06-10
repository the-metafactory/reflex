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
// BoundedPublishQueue stays module-private (sage R-101 review): callers need
// createReflexBus + metrics, not the outage-buffer implementation.
