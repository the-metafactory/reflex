# Plan: R-111 Service Controls

**Spec:** spec.md (84%) · 2026-06-11 · specflow F-001 ↔ blueprint R-111.

## Architecture

```
src/service/
  units.ts       # PURE: renderLaunchdPlist(ctx), renderSystemdUnit(ctx); UnitContext type (FR-1, FR-7, NFR-3)
  commands.ts    # PURE: per-platform argv builders install/uninstall/start/stop/status/logs (FR-2..6, FR-7, FR-8)
  run.ts         # thin executor: Bun.spawn argv, capture, exit-code passthrough; writes unit files, mkdir logs 0700
src/cli/main.ts  # `service <verb>` subcommand → run.ts (validate-style: never builds a bus)
test/service/units.test.ts  commands.test.ts   # offline (NFR-1)
```

## Data Flow

```
reflex service install
  → UnitContext { platform, bunPath: process.execPath, daemonScript: <abs src/bin/reflex-daemon.ts>,
                  workingDir: <repo root>, home, logsDir: ~/.config/reflex/logs, label: ai.meta-factory.reflex }
  → render unit (pure) → write file (0644) + mkdir logs (0700)
  → activation argv sequence (pure) → Bun.spawn each, fail-fast on non-zero
status → query argv → parse running/loaded (pure parser over launchctl print / systemctl is-active output) + tail logs
```

## Spec Traceability

| FR/NFR | Approach |
|---|---|
| FR-1 | `units.ts`: plist mirrors the cortex template (Label, ProgramArguments [bun, daemonScript], WorkingDirectory, RunAtLoad, KeepAlive, Std*Path under logsDir, Env HOME+PATH incl. dirname(bunPath)); systemd unit: [Unit] Description+After=network.target, [Service] ExecStart, Restart=always, RestartSec=2, WorkingDirectory, [Install] WantedBy=default.target; both with generated-by header (NFR-3) |
| FR-2 | darwin install seq: [bootout (ignore-missing)] → bootstrap gui/$UID plist → kickstart -k; linux: daemon-reload → enable --now (idempotent both) |
| FR-3 | uninstall: bootout + rm -f (ignore-missing) / disable --now + rm + daemon-reload |
| FR-4 | start: kickstart -k gui/$UID/label · stop: launchctl stop label / systemctl --user start|stop |
| FR-5 | status: `launchctl print gui/$UID/label` (exit≠0 → not loaded) parsed for `state = running` + pid; `systemctl --user is-active`; + stale-bun check (existsSync(ctx.bunPath from recorded unit)) + tail -5 error log |
| FR-6 | logs: tail [-f] logsDir files / journalctl --user -u reflex [-f] (spawn inherit) |
| FR-7 | argv arrays only; renderers string-template over ctx — both modules import nothing impure |
| FR-8 | `commandsFor(platform)` throws the spec's message for anything ∉ {darwin, linux} |
| NFR-1 | tests assert exact rendered unit content (snapshot-by-substring: label, paths, KeepAlive, Restart=always) + argv sequences + status parser on captured launchctl/systemctl fixtures |
| NFR-2 | live walk post-merge-gates on this machine: install → status → CLI round-trip → kickstart restart → verify in verify.md |

## Failure Modes & Blast Radius

| Failure | Detection | Recovery | Blast radius |
|---|---|---|---|
| bootstrap "already loaded" | launchctl exit≠0 | bootout-first sequence makes install idempotent | none |
| daemon crash-loops under KeepAlive | error log growth | status shows last error lines; uninstall stops the loop | local daemon |
| unit written, activation fails | fail-fast on the failing argv with tool stderr | file remains for inspection; rerun install | none |
| repo moved | stale paths in unit | status stale-path warning → reinstall | service down until reinstall |
| ad-hoc daemon still running at install | duplicate daemons on one bus | status instanceId (R-107) exposes duplicates; doc note | first-responder races on cmd subjects |

## Test Assertions

- units: plist contains Label/ai.meta-factory.reflex, both ProgramArguments absolute, Std*Path under logsDir, KeepAlive true; systemd contains ExecStart="<bun> <daemon>", Restart=always, WantedBy=default.target; both contain the generated-by header.
- commands: darwin install argv sequence exactly [[launchctl bootout …(allowFail)], [launchctl bootstrap …], [launchctl kickstart -k …]]; linux [[systemctl --user daemon-reload], [systemctl --user enable --now reflex]]; unsupported("win32") throws naming darwin/linux.
- status parser: fixture of `launchctl print` running output → {running: true, pid}; non-loaded exit → {installed: maybe, running: false}.

## Constitutional Compliance (commitments, verified at done gate)

CLI-First — it IS a CLI verb; Library-First — units/commands pure modules; Test-First — RED per task; Deterministic — pure renderers/builders; Code Before Prompts.

## Order

T-1 units renderers → T-2 command builders + status parser → T-3 executor + CLI wiring → T-4 offline tests + live launchd walk.
