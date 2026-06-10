# Reflex

The activation runtime of the metafactory ecosystem. Reflex evaluates **Activation Blueprints** against **Impulses** (schedules, bus events, webhooks, manual fires) and — after policy, approval, and guard checks — emits **Activation Events** that start Execution Runs in Pulse.

Reflex initiates work; it never orchestrates it.

> Formerly `the-metafactory/cue` — renamed 2026-06-10. The domain vocabulary lives in `meta-factory/CONTEXT.md`; "cue" is retired everywhere.

## Design

- [Reflex v0 design](docs/design-reflex-v0.md) — architecture, decision pipeline, wire protocol, CLI
- Feature graph: [blueprint.yaml](blueprint.yaml) (R-100…R-110)

## Boundaries

| Reflex does | Reflex does not |
|---|---|
| Evaluate activation rules | Orchestrate runs (Pulse) |
| Record every Activation Decision | Inspect target blueprint internals |
| Enforce activation guards (cooldown, run lock, idempotency) | Enforce Runtime Policy (Spawn) |
| Emit `mf.{net}.reflex.activation.fired.*` | Cancel running executions (Cortex) |

## Stack

TypeScript + Bun · NATS JetStream (CloudEvents v1.0, DD-68) · SQLite + Drizzle · zod
