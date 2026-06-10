# Documentation Updates — R-110: Example activation blueprints

Generated: 2026-06-10

## CHANGELOG

Entry added to CHANGELOG.md:
> - **R-110 Example activation blueprints**: **Core Problem:** The three concrete activation needs that motivated Reflex (F_PR_STATS daily report, Pilot 30-minute scan, F_TESTING on-demand run) have no committed expression. Examples serve tri...

## User-Facing Changes

### CLI Changes
- ----
- -------------
- --------
- ---
- ----------
- -------------------

## README Update

The following README updates are suggested:

## Examples

Three activation blueprints in `examples/` demonstrate each impulse kind:

| Example | Kind | Policy | Key Guards |
|---------|------|--------|------------|
| `pr-stats-daily/` | schedule (`0 7 * * *`) | auto | cooldown 6h, run_lock skip |
| `pilot-scan/` | bus (task-completed) | approval | approval_timeout 1h, run_lock buffer |
| `f-testing/` | manual | auto | none |

Each `reflex.yaml` is self-documenting — comments explain every field.

```bash
# Test any example without firing
reflex test examples/pr-stats-daily

# Fire manual example
reflex fire f-testing

# Observe decision flow
reflex status
reflex pending
reflex history
```

See `examples/README.md` for detailed walkthroughs.
