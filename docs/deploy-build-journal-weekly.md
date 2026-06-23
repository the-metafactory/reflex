# Deploy runbook — `build-journal-weekly` → public build journal, every Sunday

End to end: **Sunday 18:00 Europe/Zurich → reflex fires → cortex F-6 bridge →
the pulse `P_BUILD_JOURNAL` pipeline runs and publishes** (Discord teaser + site
deploy to `stack.meta-factory.ai/build-log/`). No laptop in the loop.

Reflex owns the clock (internal heartbeat / DO alarm); the schedule needs **no
GitHub delivery and no HMAC secret** — that makes this simpler than the
`github-*` blueprints. The work splits across three surfaces:

| Surface | What lands | Where |
|---------|-----------|-------|
| **reflex** | the schedule blueprint (this PR) | `examples/build-journal-weekly/reflex.yaml` → reflex-edge KV |
| **cortex** | a new `build-journal.run` capability handler **+** the target row | `cortex-prod` on clawbox (a cortex PR + config) |
| **clawbox env** | pulse repo + claude/discord/wrangler creds | the host the cortex handler shells out from |

## Real values (inherited from the F-6 deployments)

| Thing | Value |
|-------|-------|
| Worker | `reflex-edge` → `https://reflex-edge.jens-christian-66c.workers.dev` |
| KV namespace id | `0f52ed4f786845a7a66cb37e3297855e` (invisible.ch acct) |
| KV key prefix | `activation/` (one doc per key) |
| Principal / stack | `jc` / `default` |
| cortex prod | clawbox `~/code/mf/cortex-prod` (systemd drop-in) |
| pulse repo (clawbox) | confirm path; handler runs `run-journal.ts` from here |

## Why a deterministic code handler, not an LLM session

This run **git-pushes and `wrangler deploy`s a public website unattended**. The
F-6 `notify.discord` target is an in-process **code handler** (deterministic, no
Claude session); `sage-pr-review` is an LLM session. A weekly public deploy
should follow `notify.discord`, not the LLM path — the trigger is a fixed cron,
the command is fixed, and there is no human in the loop to catch an LLM that
mis-runs a deploy. So `build-journal.run` is a **new code handler** that shells
the exact pulse command and reports the outcome. The blueprint `payload`
(`days`/`post`/`deploy`) is the only input.

## Gate 0 — merge both PRs first

- [ ] Merge **reflex#30** (blueprint + greens the examples vocab/id gate)
- [ ] Merge **cortex#1188** (the `build-journal.run` code handler)

## Part A — cortex (on clawbox, NOT a laptop)

The executor is **code** (the new handler) + **config** (the target row). Both
must land on prod.

```bash
ssh clawbox
cd ~/code/mf/cortex-prod
git fetch origin && git checkout main && git pull        # picks up cortex#1188
bun install && bun run build                             # prod build

$EDITOR <live cortex.yaml>     # the config systemd cortex-prod loads
```

Two config edits (cortex#1188), both in the live `cortex.yaml`:

**1. The target row** — append under `reflex_activation.targets:` (alongside the
existing `notify-discord` row). This is a **code-handler** target: it sets
`handler:`, NOT `prompt:` (mutually exclusive — a `prompt` would route to a
non-existent agent capability instead of the handler):

```yaml
    - target: "@jc/build-journal"
      capability: "build-journal.run"
      assistant: cortex                  # required by schema; IGNORED for code-handler targets
      handler: "build-journal"           # → createBuildJournalRunner (cortex#1188)
```

**2. The handler config** — a new top-level block (sibling of `notify:`):

```yaml
build_journal:
  pulse_repo: /abs/path/to/pulse   # the pulse repo on THIS host; run-journal.ts is shelled from here
  days_default: 7                  # used when the activation payload omits `days`
```

The handler runs `bun examples/build-journal/run-journal.ts --llm --days <N>
--post --deploy` inside `pulse_repo` (`--post`/`--deploy` on by default —
disabled only by an explicit `post:false`/`deploy:false` in the blueprint
payload). `--days <N>` comes from the payload (`7`) or `days_default`. The
demo gate auto-passes (no `--interactive`) — that is the "fully auto-publish"
intent. A 15-minute watchdog kills a hung run (< the 20-minute JetStream
`ack_wait`); a non-zero exit / timeout emits `system.bus.build_journal{failed}`
and re-fires.

This host must have on PATH / authenticated: **bun**, the **claude** CLI (the
`--llm` agents), the **discord** CLI + creds (the `--post` teaser), **wrangler**
auth for the `myelin-cortex-site` Cloudflare Pages project (the `--deploy`), and
a checkout of `myelin-cortex-site` for the build-log write + commit. These are
the HOST's environment — never cortex config. Without them the run fails at
`--post`/`--deploy` (→ `failed`, re-fireable).

```bash
sudo systemctl restart cortex-prod
journalctl -u cortex-prod -n 50 --no-pager | grep -i reflex   # bridge up + target loaded
```

- [ ] cortex-prod restarted; log shows `reflex_activation` listener up + `@jc/build-journal` resolvable

## Part B — reflex-edge KV (laptop)

No secret needed for a schedule blueprint.

```bash
cd ~/work/mf/reflex
git checkout main && git pull            # post-merge: blueprint on main

bunx wrangler kv key put --remote \
  --namespace-id 0f52ed4f786845a7a66cb37e3297855e \
  "activation/build-journal-weekly" \
  "$(cat examples/build-journal-weekly/reflex.yaml)"

bunx wrangler kv key get --remote \
  --namespace-id 0f52ed4f786845a7a66cb37e3297855e \
  "activation/build-journal-weekly" | head -5
```

- [ ] Key present in KV
- [ ] Picked up ≤1 heartbeat refresh (~minutes) via the consumer DO `store.swap`, or force with `bunx wrangler deploy`

## Part C — verify end-to-end

- [ ] **Manual fire** before waiting a week. From clawbox, publish a `schedule`
  impulse for `build-journal-weekly` (or temporarily set the cron a few minutes
  out, load to KV, then restore). Expect:
  - reflex-edge log: blueprint `build-journal-weekly` fired → `@jc/build-journal`
  - cortex log: `reflex_activation_dispatched` (capability `build-journal.run`)
  - the handler runs the pulse pipeline; a new `build-log/<date>-build-journal.html`
    is committed + deployed; a teaser appears in the public Discord channel.
- [ ] Confirm `stack.meta-factory.ai/build-log/` shows the new entry.

## Rollback

- Reflex: `bunx wrangler kv key delete --remote --namespace-id 0f52ed4f786845a7a66cb37e3297855e "activation/build-journal-weekly"` → gone next refresh.
- Cortex: remove the target row, restart. Absent target = the schedule fires but
  resolves to nothing (a `_failed`/unresolved-target log, no side effect).
- To pause without un-deploying: set `policy: approval` in the blueprint so each
  Sunday fire parks for an operator approval instead of auto-firing.

## Gotchas

1. A schedule blueprint needs **no** GitHub webhook and **no** HMAC secret —
   don't copy the `secret_env` / org-delivery steps from the `github-*` runbooks.
2. cortex needs the **code** deploy (the `build-journal.run` handler), not just
   the config row — same lesson as cortex#1184 for `skip_authors`.
3. The handler's host must carry the **publish credentials** (claude, discord,
   wrangler, the site checkout). Without them the run fails at `--post`/`--deploy`.
4. `--days 7` assumes a weekly cadence. A missed Sunday (daemon down — reflex
   does **not** backfill) leaves a gap; the next run still only looks back 7 days.
