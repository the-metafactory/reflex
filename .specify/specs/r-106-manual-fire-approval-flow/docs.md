# Documentation Updates — R-106: Manual fire + approval flow

Generated: 2026-06-10

## CHANGELOG

Entry added to CHANGELOG.md:
> - **R-106 Manual fire + approval flow**: **Core Problem:** Two human-facing halves of the pipeline are missing: (1) producing a `manual`-kind Impulse from an operator command (`reflex fire`) that goes through the FULL pipeline — no bypass...

## User-Facing Changes

### CLI Changes
- ----
- -------------
- --------
- --input
- ----------
- -------------------

## README Update

The following README updates are suggested:

═══ PAI | NATIVE MODE ═══════════════════════
🗒️ TASK: Generate README sections for R-106

## CLI

```bash
# Manual fire — impulse goes through full pipeline (policy, guards, approval)
reflex fire <blueprint-id> [--input '{"key": "value"}']

# Approval lifecycle
reflex approve <decision-id>   # Matched → Fired (or blocked by guard)
reflex deny <decision-id>      # Matched → Denied

# List pending approvals
reflex decisions --status=matched
```

Manual fires receive no special treatment: policy and guards apply exactly as for scheduled or event-driven impulses.

## Decision Lifecycle

| Status | Transitions to | Trigger |
|--------|----------------|---------|
| Matched | Fired | `approve` + guards pass |
| Matched | Denied | `deny` |
| Matched | Expired | Sweep timer (configurable interval) |
| Matched | Blocked | `approve` but guard fails |
