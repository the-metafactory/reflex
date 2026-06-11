# Documentation Updates — F-001: Service controls (launchd + systemd)

Generated: 2026-06-11

## CHANGELOG

Entry added to CHANGELOG.md:
> - **F-001 Service controls (launchd + systemd)**: The daemon currently runs as a session-started background process — it survives the session but not a reboot, has no supervision (no restart-on-crash), and its logs go to a transient task file. Ope...

## User-Facing Changes

### CLI Changes
- ----
- -------------
- --user
- --now
- --follow
- ---

### Other Changes
- user-facing

## README Update

User-facing changes detected. Consider updating README.md with:

- New CLI commands/options in the Usage section
