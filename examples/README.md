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

The CLI produces a `manual` Impulse through the full pipeline — policy and every Activation Guard apply; there is no bypass. The command returns the decision verdict synchronously.

## The acceptance walk

```
./examples/demo.sh
```

Starts a daemon against your local `nats-server -js`, fires `f-testing`, shows `pending`/`history`, and stops cleanly. Running it twice demonstrates guard honesty: the second walk's blocks appear as Blocked Decisions, not errors.
