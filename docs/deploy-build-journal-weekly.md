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
| **cortex** | the generic `process` handler (cortex#1188, ships once) **+** a process **spec file** **+** a target row | `cortex-prod` on clawbox |
| **clawbox env** | pulse repo + claude/discord/wrangler creds | the host the process runs on |

> The `process` handler is generic and config-driven: once cortex#1188 is on
> prod, **future** scheduled jobs are just a new spec file + target row — no
> cortex release. This first one rides along with the cortex#1188 deploy.

## Real values (inherited from the F-6 deployments)

| Thing | Value |
|-------|-------|
| Worker | `reflex-edge` → `https://reflex-edge.jens-christian-66c.workers.dev` |
| KV namespace id | `0f52ed4f786845a7a66cb37e3297855e` (invisible.ch acct) |
| KV key prefix | `activation/` (one doc per key) |
| Principal / stack | `jc` / `default` |
| cortex prod | clawbox `~/code/mf/cortex-prod` (systemd drop-in) |
| pulse repo (clawbox) | confirm path; handler runs `run-journal.ts` from here |

## Why the generic `process` code handler, not an LLM session

This run **git-pushes and `wrangler deploy`s a public website unattended**. The
F-6 `notify.discord` target is an in-process **code handler** (deterministic, no
Claude session); `sage-pr-review` is an LLM session. A public deploy should
follow the code path, not the LLM path — the schedule is a fixed schedule
expression, the command is fixed, and there is no human in the loop to catch an
LLM that mis-runs a deploy.

Rather than a bespoke handler per job, cortex ships ONE generic `process`
handler (cortex#1188): the command is a **spec file** (DATA) on the host, the
target names which spec to run, and the activation payload only fills declared
typed `{param}` slots (here `{days}`). argv comes from the spec and runs with no
shell. cortex#1188 is *designed* to enforce this boundary — `target.process`
(the spec name) read from the trusted target config not the payload; a `string`
param `enum`-constrained unless `freeform` is set; array-spawn so a param value
is a single argv element. **Verify it against the merged cortex code before the
first unattended deploy** — source + tests: `cortex` repo
`src/bus/process-runner.ts` (`ProcessParamSchema`, `resolveArgv`) and
`src/bus/__tests__/process-runner.test.ts` (the "spec name comes from
target.process, NOT the payload" case). The intent: a payload fills declared
slots only — it does not choose the command. Adding the next scheduled job is a
new spec file + target row — no
cortex release.

## Gate 0 — merge both PRs first

- [ ] Merge **reflex#30** (blueprint + greens the examples vocab/id gate)
- [ ] Merge **cortex#1188** (the generic `process` code handler)

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

Three things on prod (cortex#1188 ships the generic handler; the spec + target
row are this job's DATA):

**1. The process spec file** — copy the cortex example onto the host, into the
processes dir (`$CORTEX_PROCESSES_DIR`, else `<config-dir>/processes`, else
`~/.config/cortex/processes/`):

```bash
mkdir -p ~/.config/cortex/processes
cp ~/code/mf/cortex-prod/examples/processes/build-journal.yaml ~/.config/cortex/processes/
$EDITOR ~/.config/cortex/processes/build-journal.yaml   # set `cwd:` to the pulse repo on THIS host
```

```yaml
name: build-journal
cwd: /abs/path/to/pulse            # the pulse repo ON THIS HOST
argv: [bun, examples/build-journal/run-journal.ts, --llm, --days, "{days}", --post, --deploy]
timeout_ms: 900000
detach: true                      # long run: don't block the serial bridge; report via system.bus.process
params:
  days: { type: int, default: 7 }
```

**2. The target row** — append under `reflex_activation.targets:` in the live
`cortex.yaml` (alongside `notify-discord`). `handler: process` + `process:`
names the spec; NOT `prompt:` (that would route to an agent session):

```yaml
    - target: "@jc/build-journal"
      capability: "process.run"          # free-form label
      assistant: cortex                  # required by schema; IGNORED for code-handler targets
      handler: "process"
      process: "build-journal"           # → the spec file above
```

The handler reads the spec fresh per fire, fills `{days}` from the payload
(`7`) or the spec default, and runs `bun …run-journal.ts --llm --days 7 --post
--deploy` in `cwd`. The demo gate auto-passes (no `--interactive`) — the
"fully auto-publish" intent. A 15-minute watchdog kills a hung run (< the
20-minute JetStream `ack_wait`); a non-zero exit / timeout emits
`system.bus.process{failed}`. Because this spec sets **`detach: true`** (so a
~10-min run does not block other reflex activations), the run is supervised in
the background: a failure is **reported via `system.bus.process{failed}` only —
it is NOT auto-re-fired**; the next Sunday schedule re-runs it (idempotent —
overwrites that date's entry, clean repo = no-op commit). (Only *synchronous*,
non-detached process specs re-fire on failure.) These are cortex-side behaviours
intended in cortex#1188 (`src/bus/process-runner.ts` — `superviseRun`, the
`detach` branch, the `timeout_ms` cap; `system-events.ts`); **verify against the
merged cortex code before relying on them for an unattended deploy.**

**3. Host environment** — this host must have on PATH / authenticated: **bun**,
the **claude** CLI (the `--llm` agents), the **discord** CLI + creds (the
`--post` teaser), **wrangler** auth for the `myelin-cortex-site` Cloudflare Pages
project (which `--deploy` ships to `stack.meta-factory.ai`), and a checkout of
`myelin-cortex-site` for the build-log write + commit. These are the HOST's
environment — never cortex config. Without them the run fails at
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
  impulse for `build-journal-weekly` (or temporarily set the schedule a few minutes
  out, load to KV, then restore). Expect:
  - reflex-edge log: blueprint `build-journal-weekly` fired → `@jc/build-journal`
  - cortex log: `reflex_activation_dispatched` + `system.bus.process{started}` (process `build-journal`)
  - the handler runs the pulse pipeline; a new `build-log/<date>-build-journal.html`
    is committed + deployed; a teaser appears in the public Discord channel;
    `system.bus.process{completed}` on the bus.
- [ ] Confirm `stack.meta-factory.ai/build-log/` shows the new entry.

## Rollback

- Reflex: `bunx wrangler kv key delete --remote --namespace-id 0f52ed4f786845a7a66cb37e3297855e "activation/build-journal-weekly"` → gone next refresh.
- Cortex: remove the target row (and/or `rm ~/.config/cortex/processes/build-journal.yaml`),
  restart. Absent target = the schedule fires but resolves to nothing (a
  `_failed`/unresolved-target log, no side effect). The generic `process`
  handler stays — it's inert with no `process` target.
- To pause without un-deploying: set `policy: approval` in the blueprint so each
  Sunday fire parks for an operator approval instead of auto-firing.

## Gotchas

1. A schedule blueprint needs **no** GitHub webhook and **no** HMAC secret —
   don't copy the `secret_env` / org-delivery steps from the `github-*` runbooks.
2. THIS first job needs the cortex **code** deploy (the generic `process`
   handler, cortex#1188) on prod — not just config. AFTER that lands, every
   *next* scheduled job is a spec file + target row only, no cortex release.
3. The handler's host must carry the **publish credentials** (claude, discord,
   wrangler, the site checkout). Without them the run fails at `--post`/`--deploy`.
4. `--days 7` assumes a weekly cadence. A missed Sunday (daemon down — reflex
   does **not** backfill) leaves a gap; the next run still only looks back 7 days.
