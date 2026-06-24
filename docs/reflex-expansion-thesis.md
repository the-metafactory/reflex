# Reflex Expansion — Council + Adversarial Synthesis

> Strategy note, 2026-06-24. Output of a structured exploration: oscillating
> ideation (tactical/strategic/meta) → 5-member council debate → 3-attacker
> adversarial pass. Captures *what to build, what to defer, what to kill*, and
> the guardrails that must land before any new unattended auto-fire.
>
> Full reasoning trail (seed idea catalog + all 8 agent transcripts verbatim):
> [reflex-expansion-thesis-appendix.md](reflex-expansion-thesis-appendix.md).

## Verdict first

The exercise nearly refuted itself, and that is the most useful output.
"Brainstorm more uses for Reflex" is solution-first reasoning — it manufactures
demand. The null-hypothesis attacker conceded the two facts that flip it: the
generic `process` handler (cortex#1188) drove blueprint marginal cost to
**near-zero**, and there are **3 unprompted live uses** (issue→Discord,
PR→sage review, weekly build-journal) = real fit. So the answer is neither
"expand" nor "freeze" — it is **demand-pulled expansion on the v0 matcher, with
two architectural fixes before anything auto-fires unattended.**

The sharpest single finding cuts the whole roadmap: **issue-triage needs zero
new matcher work** — it is flat `label == []`, which the v0 flat field-equality
matcher already does. "Fix the matcher first" (ranked the bottleneck by 3 of 5
council voices) is speculative generality delaying the one shippable win. Let
real misfires name the matcher extension that is actually load-bearing.

## The idea space (oscillated) + combined verdict

| Idea | Aperture | Verdict | Why |
|---|---|---|---|
| **Issue-triage → #triage Discord** (unlabeled, no LLM) | tactical | **SHIP NOW** | Real recurring toil; flat matcher already does it; reuses live path; ~1 afternoon |
| **Dry-run test harness** | meta | **SHIP NEXT** | Makes every future blueprint safe to change; prevents 3am self-spam; genuine load-bearing piece |
| **Tag → release-notes process** | tactical | **SHIP (clean)** | Single impulse → single fire → deterministic process. Archetypal activation, no nested fields |
| **Nightly sec/dep audit → Discord** | tactical | **SHIP (read-only)** | Same shape as live issue→Discord; aligns w/ day job; no write authority |
| **Self-watchdog** (did automations fire?) | strategic/meta | **SHIP — RE-SPEC** | Must be **out-of-band** (external pinger, not a Reflex blueprint) AND assert on **outcome = success**, not the fire-record. As proposed it is security theater that suppresses the alarm it exists to raise |
| **Richer matcher** (nested-eq + negation) | meta | **DEFER → on-demand** | Not the bottleneck for triage. When a real gate needs it, add *only that*, with a written non-goal + test corpus. Treat as a security-sensitive parser; **never** a trust-gate on attacker-controlled fields |
| **Decision-ledger as substrate** | strategic | **GATE** | Moat illusion — once Cortex/Pulse read the raw schema it is an unmigratable hidden API. Only ever publish a **frozen, versioned view** |
| **Cross-repo fan-out** (1→N targets) | strategic | **KILL (→ Pulse)** | Multi-target = orchestration. Boundary violation |
| **Auto-merge dep-bot PR** | tactical | **KILL (unanimous)** | Untrusted + replayable + bot-spoofable impulse → write to `main` → chains to deploy. Never `policy: auto` |
| **Deploy-chain / rollback / canary** | tactical/strategic | **KILL (→ Pulse/Cortex)** | Sequencing & compensation are orchestration/cancellation, not activation |
| **Org-consent gateway** | strategic | **KILL (wrong context)** | Per-decision approval ≠ standing org governance (that is Spawn/Governance). And the audience is one |
| **Cadence engine for all rituals** | strategic | **PARTIAL** | "Migrate scattered cron onto one clock" = fine subtraction. "Engine/authority" = scheduling-as-a-service overreach. Do the migration, skip the abstraction |

## The one architectural insight (highest leverage per line)

Make **`pulse.run.completed{outcome}` the single signal consumed everywhere, and
carry a `causation_depth` field** on every fired run (incremented from the
triggering event). One enriched event simultaneously fixes three independent
failures the adversaries found:

1. **Watchdog false-negative** — assert `success within window`, not "fired."
   Reflex records *intent*; the journal can fire-record green while the git-push
   403'd and the public site sits stale for weeks.
2. **Cross-blueprint activation storm** — `cooldown`/`run_lock` are
   *per-blueprint*; an A→B→A loop lives in the edges no guard owns. A global
   `depth > N` drop kills all cycles. A richer matcher makes this *worse* — more
   blueprints match `pulse.run.>`.
3. **Buffered-impulse re-presentation** already consumes these outcomes — one
   schema, not two.

## Hard guardrails before ANY unattended auto-fire

- **Replay:** key idempotency on **payload-hash + event-identity**, not
  `X-GitHub-Delivery`. A re-signed body at 11s sails past `cooldown: 10s` → N
  auto-merges/deploys.
- **Forgeable trust:** the `sender.login` gate is bypassable (top-level vs
  nested author mismatch on fork PRs). Gate on cryptographic identity (app-id /
  commit signature), never a payload string.
- **Capability scope:** every assistant **read-only by default**; writes go
  through a separate deterministic/approval step. Untrusted PR **diff** (not just
  body) is the injection channel; quarantine-by-prompt is defeatable.
- **Dual-brain:** daemon + edge both wake on the same cron tick → double
  git-push/deploy. Schedule fires need a **shared lease**; loser no-ops.
- **Hot-reload:** on blueprint removal/rename, **drain in-flight approvals +
  buffered impulses** for the vanished id — else an `approval`-gated action
  re-presents as `auto`.

## Boundary hygiene (one new word)

Name **`ActivationChain`, explicitly owned by Pulse.** The moment any "then"
appears (docs *then* deploy), someone crams sequencing into a blueprint. Naming
the seam makes the violation un-sneakable. Reflex fires one `ActivationEvent`;
ordered reactions are Pulse's `ActivationChain`.

## Keep yourself honest

The diagnostic question worth pinning: **"In the last 30 days, how many ecosystem
components changed because an external user/outcome demanded it — vs. because
building them was satisfying?"** If mostly the latter, the lore is outrunning the
leaves. Triage and the dry-run harness pass this test (real toil, real
misfire-prevention). Most of the S-tier strategic ideas do not — yet.

## Net recommendation

1. Ship **issue-triage** + **dry-run harness** (zero new risk, real payoff).
2. Re-spec the **watchdog** out-of-band, asserting on the outcome signal.
3. Land the **`outcome + causation_depth`** event before adding any *reactive*
   blueprint.
4. **Defer** the matcher until a misfire names the exact extension needed.
5. Everything orchestration-shaped stays in **Pulse**.

---

*Method: ApertureOscillation (idea generation) · Council (Operator, Boundary
Architect, Ecosystem Strategist, Security Adversary, YAGNI Skeptic) · RedTeam
(roadmap attack, null-hypothesis, compound-failure). 8 agents total.*
