# Specification: R-111 Service Controls (launchd + systemd)

> specflow DB id F-001 (CLI rejects R-prefixed ids); blueprint id R-111. 2026-06-11.

## Problem Statement

The daemon currently runs as a session-started background process — it survives the session but not a reboot, has no supervision (no restart-on-crash), and its logs go to a transient task file. Operators need the ecosystem-standard service story: launchd LaunchAgent on macOS (the cortex/sage pattern), systemd user unit on Linux.

## Users & Stakeholders

Primary: the operator on this laptop (launchd, immediate need). Secondary: future Linux deployments (systemd user units); clawbox-style hosts.

## Requirements

### Functional

| ID | Requirement |
|----|-------------|
| FR-1 | `reflex service install` renders + installs the platform unit: macOS → `~/Library/LaunchAgents/ai.meta-factory.reflex.plist` (RunAtLoad, KeepAlive, logs `~/.config/reflex/logs/reflex.log`/`.error.log`, env HOME+PATH, WorkingDirectory = repo root, ProgramArguments = resolved bun + absolute `src/bin/reflex-daemon.ts`); Linux → `~/.config/systemd/user/reflex.service` (Restart=always, RestartSec=2, journal) |
| FR-2 | `install` activates: `launchctl bootstrap gui/$UID <plist>` (+ `kickstart` if already loaded → `bootout` first, idempotent reinstall); Linux: `systemctl --user daemon-reload && systemctl --user enable --now reflex` |
| FR-3 | `uninstall` deactivates + removes the unit file (`bootout` / `disable --now` + rm); idempotent when absent |
| FR-4 | `start` / `stop` with KeepAlive-correct semantics: stop = `launchctl bootout` (unit file stays; a plain `launchctl stop` is resurrected instantly by KeepAlive — observed live), start = `bootstrap` + `kickstart -k` (Linux: `systemctl --user start/stop`) |
| FR-5 | `status`: unit installed? loaded/running (launchctl print / systemctl is-active) + last 5 log lines; exit 0 running, 1 not |
| FR-6 | `logs [--follow]`: tail the launchd log files / `journalctl --user -u reflex` |
| FR-7 | Renderers are pure functions over `{bunPath, daemonScript, workingDir, home, logsDir}` — fully unit-testable; command builders return argv arrays (no string-shell interpolation) |
| FR-8 | Unsupported platform → clear error naming supported ones; service subcommand never touches the bus (purely local) |

### Non-Functional

| ID | Requirement |
|----|-------------|
| NFR-1 | `bun test` offline: renderers + command builders covered; no launchctl/systemctl executed in tests |
| NFR-2 | Live verification on this machine (launchd): install → status running → reflex status round-trip → survives `kickstart -k` restart |
| NFR-3 | Unit files carry a generated-by header naming the source of truth (re-render on reinstall; manual edits overwritten) |

## Acceptance Scenarios

**Scenario 1:** Given no service installed, when `reflex service install` runs on macOS, then the plist exists with the resolved absolute paths and `launchctl print gui/$UID/ai.meta-factory.reflex` shows it running, and `reflex status` round-trips against the supervised daemon.

**Scenario 2:** Given the service is running, when `reflex service stop` then `start` run, then status reflects each state transition and the daemon PID changes.

**Scenario 3:** Given the service is installed, when `install` runs again after the unit template changes, then the file is re-rendered and the service restarted (idempotent reinstall).

**Scenario 4:** Given a Linux platform (simulated in tests), when units are rendered, then the systemd unit contains ExecStart with absolute bun + daemon paths, Restart=always, and the install command sequence is `daemon-reload` → `enable --now`.

**Scenario 5:** Given an unsupported platform string, when any service command builds, then a clear error names darwin/linux as supported.

## Error Handling (user-facing messages + exit codes)

| Condition | Message (stderr) | Exit |
|---|---|---|
| unsupported platform | `service commands support darwin (launchd) and linux (systemd --user); got <platform>` | 1 |
| launchctl/systemctl invocation fails | the tool's stderr verbatim + `service <verb> failed (<tool> exited <code>)` | tool's code (non-zero) |
| status: unit not installed | `not installed — run: reflex service install` | 1 |
| status: installed but not running | `installed, not running — run: reflex service start` (+ last error-log lines) | 1 |
| install: logs dir uncreatable / plist unwritable | OS error verbatim + the target path | 1 |
| stale bun path detected at status | warning line `unit references missing bun at <path> — run: reflex service install` (status still reports) | unchanged |

All commands: exit 0 = requested state holds; exit 1 = domain failure; tool exit codes pass through on subprocess failure. No timeouts needed — launchctl/systemctl are synchronous (install end-to-end < 5s observed; not a gate).

## Assumptions & Dependencies

- bun on the operator's machine; `process.execPath` at install time is the supervised interpreter (re-resolved every install)
- The repo checkout is the deployment (units reference absolute paths into it; moving the repo requires reinstall)
- macOS: user launchd domain (`gui/$UID`) reachable — normal logged-in session; Linux: a user systemd instance with lingering or an active session
- `~/.config/reflex/` writable; unit files carry mode 0644, logs dir 0700

## Edge Cases

| Scenario | Expected |
|---|---|
| bun moves (version manager) | reinstall re-resolves `process.execPath`; status surfaces a stale-path warning when the recorded path no longer exists |
| install while ad-hoc daemon runs | documented: operator stops the ad-hoc process (or the supervised one takes over the cmd subjects — duplicate-daemon visible via status instanceId) |
| logs dir missing | created by install (0700, consistent with state-dir policy) |
| launchctl bootstrap "already loaded" | bootout first, then bootstrap (idempotent) |

## Success Criteria

- [ ] Renderer + command-builder unit tests green offline
- [ ] Live launchd walk on this machine recorded in verify.md (scenarios 1–3)
- [ ] Vocabulary gates green

## Scope

IN: service subcommand, renderers, launchd + systemd user units, live launchd verification. OUT: system-level (root) units, Windows, log rotation, packaging the repo elsewhere (units point at this checkout).
