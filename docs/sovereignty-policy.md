# Sovereignty policy artifact — provenance

`docs/sovereignty-policy.json` is the DD-122 `trusted_substrates` audit
artifact for the reflex-edge Cloudflare deployment. It is intent + audit
surface only: reflex does not enforce it at runtime, and the myelin
sovereignty engine's `SOVEREIGNTY_POLICY` KV bucket is not yet provisioned.
It is shaped to load as-is (`nats kv put SOVEREIGNTY_POLICY config "$(cat
docs/sovereignty-policy.json)"`) once that engine exists.

## Authority for `data_residency_accepted: true`

The acceptance is **not** self-asserted by this PR — it carries a recorded
principal decision:

- **Decision:** DD-122 (the-metafactory/meta-factory `design/design-decisions.md`)
- **Boundary model:** Option B — principal boundary = trust root + declared
  processor set. **Status:** Decided 2026-06-11. **Approved by:**
  Jens-Christian Fischer (issue the-metafactory/meta-factory#552).
- **Payload-at-rest (the field's authority):** DD-122 point 4 —
  **RESOLVED option (a), decided 2026-06-12 by Jens-Christian.** Verbatim:

  > Activation Payload contents at rest on third-party storage (D1/KV/DO)
  > require either (a) declared residency acceptance in policy, or (b)
  > payload encryption with principal-held keys before write. **Decided
  > 2026-06-12 (Jens-Christian): option (a) — declared residency
  > acceptance.** The `trusted_substrates` declaration carries the
  > acceptance; Cloudflare can read payload plaintext at rest on declared
  > substrates, and the principal accepts that trade for the edge
  > deployment.

So `data_residency_accepted: true` on the `cloudflare`/`reflex-edge` entry is
the encoding of that 2026-06-12 decision. Option (b) (principal-key
encryption) remains a future tightening that would supersede point 4.

## Entry meaning

| Field | Value | Why |
|---|---|---|
| `provider` | `cloudflare` | the substrate |
| `tenancy` | `66c80b89ed06c59e27d321d0229fc34f` | the invisible.ch Cloudflare account id the worker is deployed to |
| `roles` | `["reflex-edge"]` | the only component declared on this substrate |
| `data_residency_accepted` | `true` | DD-122 point 4 option (a), above |
