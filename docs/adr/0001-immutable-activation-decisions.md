# Activation Decisions are immutable verdicts; waiting state lives elsewhere

An Activation Decision is the immutable record of one evaluation — written once, never updated to a different outcome. Anything that waits is modeled outside the decision log: a decision awaiting approval is the single non-terminal outcome (Matched, resolving to Fired/Denied/Expired via the approvals lifecycle), a deferred firing is a **Buffered Impulse** (re-presented as a *fresh* decision when the Run Lock releases, all guards re-run), and a `reflex test` produces a **Dry Run Verdict** that is not a decision at all (no guard mutation, no events, no history row). We chose this over the convenient alternatives — converting a Blocked Decision to Fired when a buffered run completes, or logging dry-run evaluations as flagged decision rows — because the decision log is the activation audit trail consumed by Miner and operators: a verdict that can change after the fact, or that records things which never really happened, is not evidence.

## Consequences

- The `decisions` table has no UPDATE path for outcomes (the Matched→Fired/Denied/Expired resolution lives in the `approvals` lifecycle, linked by decision id) — this is deliberate; do not "fix" it.
- Buffer re-presentation can legitimately block (e.g. a cooldown engaged meanwhile): two linked decisions, both honest.
- Decision history contains only real evaluations; audit queries need no dry-run or superseded-row filtering.
