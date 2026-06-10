# Reflex

The activation context of the metafactory ecosystem: evaluating when declared work should start, and starting it. The ecosystem-wide domain language in `meta-factory/CONTEXT.md` (Activation section) is authoritative; this file defines Reflex-local terms and refinements only. Upstream terms (Impulse, Activation Blueprint, Activation Rule, Activation Decision, Activation Guard, Activation Policy, Activation Approval, Activation Event, Activation Payload) are used here with their upstream meanings.

## Language

## Language

**When Block**:
The configuration surface that declares which **Impulse Source** feeds a blueprint's **Activation Rule**.
_Avoid_: Trigger, trigger type, hook

**Impulse Kind**:
The canonical name of an **Impulse Source** in a **When Block** — one of `schedule`, `manual`, `bus`, `http`.
_Avoid_: Event, webhook, cron, trigger type

**Buffered Impulse**:
An **Impulse** held by a **Run Lock** in buffer mode, re-presented once when the lock releases.
_Avoid_: Queued decision, pending fire

**Dry Run Verdict**:
The predicted **Activation Decision** outcome reported by a **Dry Run**.
_Avoid_: Dry decision, test decision

## Relationships

- A **When Block** declares exactly one **Impulse Source** per blueprint in v0.
- One configuration entry declares exactly one **Activation Blueprint**.
- In v0, an **Activation Blueprint** contains exactly one **Activation Rule** (implicit; multi-rule blueprints are a later extension inside the same entry).
- An identifier in configuration names an **Activation Blueprint**, never a rule.
- The CLI fires, lists, and inspects **Activation Blueprints** by blueprint identifier.
- A CLI fire produces a `manual`-kind **Impulse**; it never starts a run directly. There is no guard-bypass path in Reflex.
- Every run Reflex starts is an **Activated Run**. A **Manual Run** is a run started outside Reflex entirely (direct Pulse/Cortex invocation).
- An **Activation Decision** is an immutable verdict of one evaluation — it is never mutated into a different outcome later.
- A **Buffered Impulse** holds at most one impulse per blueprint (newest replaces older). Its re-presentation produces a fresh **Activation Decision**, which re-runs all **Activation Guards** and links to the **Blocked Decision** that buffered it.
- A **Run Lock** has a conflict mode: `skip` (conflicting impulse produces a **Blocked Decision**) or `buffer` (conflicting impulse becomes the **Buffered Impulse**). A blueprint without a **Run Lock** allows concurrent runs.
- A **Dry Run Verdict** mutates no guard state, emits no events, and is not part of decision history.
- An **Activation Blueprint** targets exactly one **Execution Blueprint**; its **Activation Payload** is shaped toward the target's **Run Contract**.

## Example dialogue

> **Dev:** "Operator ran `reflex fire pilot-scan` while a run was in flight — did we get a Manual Run?"
> **Domain expert:** "No. The CLI produced a `manual`-kind **Impulse**. The **Run Lock** was held in buffer mode, so the evaluation recorded a **Blocked Decision** and the impulse became the **Buffered Impulse**. When the run-outcome event released the lock, the impulse was re-presented, a fresh **Activation Decision** passed all guards, **Fired**, and the resulting run is an **Activated Run** — like every run Reflex starts."
>
> **Dev:** "And if the policy required approval and nobody answered?"
> **Domain expert:** "The **Matched Decision** would resolve to an **Expired Decision** when the approval window lapsed. Matched is the only non-terminal outcome — it always ends as Fired, Denied, or Expired."

## Flagged ambiguities

- "rule id" vs "blueprint id" — resolved: configuration `id:` names an **Activation Blueprint**; the **Activation Rule** is interior to the blueprint and unnamed in v0. A duplicate-id load error is blueprint-level.
- "trigger" was used throughout the v0 design doc (`trigger:` key, "trigger types") — resolved: banned per upstream. The configuration keyword is the **When Block** (`when:`); prose says an **Activation Rule** evaluates **Impulses** from an **Impulse Source**.
- "expired" was invented ad hoc in the v0 design doc (once described as "Blocked-equivalent") — resolved: **Denied Decision** and **Expired Decision** are first-class terminal outcomes, added to the upstream taxonomy. A **Blocked Decision** is strictly a guard outcome; denial and expiry are approval outcomes.
- "pending" — resolved: friendly CLI verb only (`reflex pending` lists **Matched Decisions**). Banned in prose, code identifiers, and event types.
- Naming principle (from the `when:` and `pending` resolutions): **friendly surface, canonical core** — operator-facing surfaces (CLI verbs, config keywords) may use approachable words; every identifier beneath them (code, wire, storage, prose) uses the canonical term, and the glossary records the mapping.
- "overlap" (Temporal-derived, used in the v0 design doc as `overlap: skip|buffer|cancel|allow`) — resolved: banned. The config key is the guard's canonical name (`run_lock: skip | buffer`); absence of a **Run Lock** means concurrent runs are allowed. `cancel` was already rejected as a boundary violation.
- Wire envelope: DD-68 named CloudEvents, but the ecosystem converged on the **Myelin envelope** (`@the-metafactory/myelin`) — resolved: an **Activation Event** is carried as a MyelinEnvelope; "CloudEvents" describes the superseded 2026-04 design, not the wire.
