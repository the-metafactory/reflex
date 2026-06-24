# Reflex Examples

Three Activation Blueprints covering the v0 Impulse Kinds. Each `reflex.yaml` is fully commented — the files are the tutorial. Copy one next to your flow, change `id` and `target`, and the daemon hot-reloads it (a duplicate `id` is a loud load error, never silent shadowing).

Validate anything without a daemon or NATS:

```
reflex validate examples/
```

## pr-stats-daily — schedule

Fires `@jc/f-pr-stats` every morning at 07:00 Europe/Zurich.

- The scheduler produces an Internal Impulse per cron tick; missed ticks while the daemon was down are logged, never backfilled.
- `cooldown: 6h` blocks a re-fire within the window (an honest **Blocked Decision** with reason `cooldown` lands in history).
- Observe: `reflex status` (next ticks), `reflex history --blueprint pr-stats-daily`, `reflex test pr-stats-daily` (Dry Run Verdict, zero side effects).

## pilot-scan — bus + approval

When a `tasks.review.completed` envelope with `flow: review` appears on the bus, a **Matched Decision** parks for the operator.

1. `reflex pending` — see Matched Decisions awaiting approval
2. `reflex approve <decision-id>` — guards re-run, then the Activation Event fires (or `reflex deny <decision-id>`)
3. Unanswered for 1h → **Expired Decision** (reason `timeout`)
4. `run_lock: buffer`: a second match during the in-flight run becomes the **Buffered Impulse** — re-presented exactly once when the run-outcome event arrives.

## f-testing — manual

```
reflex fire f-testing --input '{"suite":"smoke"}'
```

The CLI produces a `manual` Impulse through the full pipeline. Guard enforcement on the manual path is demonstrable, not asserted: the demo fires this blueprint twice with identical input and the duplicate is blocked by the always-on Idempotency Key guard (`blocked — idempotency` in history); cooldown blocking a manual fire is proven in the handler test suite. The command returns the decision verdict synchronously.

## github-issue-opened / github-pr-opened / github-pr-review — http (GitHub delivery)

Three `http`-kind blueprints fired directly by GitHub's signed delivery (`github_hmac` auth over `X-Hub-Signature-256`), no laptop in the loop. The org-wide delivery means every Metafactor repo reaches reflex; the flat `where` narrows to a precise event (`github_event` + `action`).

- **github-issue-opened** → `@jc/notify-discord`: new issue → cortex F-6 bridge → per-repo Discord post (code-handler path).
- **github-pr-opened** → `@jc/f-pr-opened`: generic "PR opened" Execution Blueprint (F-003 reference).
- **github-pr-review** → `@jc/sage-pr-review`: PR opened → cortex bridge → sage runs its `code-review.*` capability on the PR (CC-prompt path). The author trust gate (skip trusted authors, review everyone else) lives in cortex, not here — reflex's v0 `where` is flat field-equality and cannot read the nested author or negate. The trusted-author list is a **configurable** cortex setting and the gate is **deterministic** (the bridge drops a trusted author's dispatch before any session starts; it never trusts the LLM to honour a "skip" instruction). Each `reflex.yaml` header is the full tutorial, including the required cortex `reflex_activation.targets` entry.
- **tag-release-notes** → `@jc/release-notes`: a tag pushed → cortex bridge → a deterministic cortex `process` handler generates a release-notes **draft** (same config-driven runner as build-journal, not an LLM session). Matches GitHub's `create` event on `ref_type: tag` (both top-level, flat-matchable — a `push` ref would need a prefix match the matcher cannot do). New, isolated GitHub delivery with its own HMAC secret. The header documents the cortex `process` spec + binding; the generator itself is the cortex-side build.

## The acceptance walk

```
./examples/demo.sh
```

Starts a daemon against your local `nats-server -js`, fires `f-testing`, shows `pending`/`history`, and stops cleanly. The walk fires the same input twice: the duplicate is blocked by the always-on Idempotency Key guard — guard behavior lands in history as an honest Blocked Decision, not an error.
