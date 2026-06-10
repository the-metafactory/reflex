import { describe, expect, it } from "bun:test";
import {
  deriveNatsSubject,
  validateEnvelope,
  validateSubjectEnvelopeAlignment,
} from "@the-metafactory/myelin";
import {
  ACTIVATION_DECISION_TYPE_PREFIX,
  ACTIVATION_FIRED_TYPE,
  buildActivationDecision,
  buildActivationFired,
  reflexSource,
} from "../src/bus/envelopes";
import { makeEnvelope, testConfig } from "./helpers";

const cfg = testConfig();
// Myelin contract: correlation_id must be a UUID when present.
const CORR = crypto.randomUUID();

describe("envelope builders", () => {
  it("fired input produces a valid envelope with derived aligned subject", () => {
    const input = buildActivationFired(cfg, {
      target: "@jc/f-pr-stats",
      payload: { mode: "daily" },
      idempotencyKey: "abc123",
      decisionId: "dec-1",
      correlationId: CORR,
      actor: { type: "system", id: "reflex-scheduler" },
    });
    expect(input.type).toBe(ACTIVATION_FIRED_TYPE);
    expect(input.source).toBe(`${cfg.principal}.reflex.activation`);
    expect(input.payload.target).toBe("@jc/f-pr-stats");
    expect(input.payload.idempotency_key).toBe("abc123");
    expect(input.correlation_id).toBe(CORR);
    expect(input.extensions?.decision_id).toBe("dec-1");
    expect(input.extensions?.actor).toEqual({ type: "system", id: "reflex-scheduler" });

    const envelope = makeEnvelope(cfg, input);
    expect(validateEnvelope(envelope).valid).toBe(true);
    const subject = deriveNatsSubject(envelope, cfg.stack);
    expect(subject).toBe(`local.${cfg.principal}.${cfg.stack}.reflex.activation.fired`);
    expect(validateSubjectEnvelopeAlignment(subject, envelope, cfg.stack).aligned).toBe(true);
  });

  it("decision input carries the outcome in the type", () => {
    const input = buildActivationDecision(cfg, {
      outcome: "blocked",
      blueprintId: "pilot-scan",
      decisionId: "dec-2",
      reason: "cooldown",
      actor: { type: "operator", id: "jc" },
    });
    expect(input.type).toBe(`${ACTIVATION_DECISION_TYPE_PREFIX}.blocked`);
    expect(input.payload.blueprint_id).toBe("pilot-scan");
    expect(input.payload.reason).toBe("cooldown");
    const envelope = makeEnvelope(cfg, input);
    expect(validateEnvelope(envelope).valid).toBe(true);
  });

  it("decision input rejects the ignored outcome (never published)", () => {
    expect(() =>
      buildActivationDecision(cfg, {
        outcome: "ignored" as never,
        blueprintId: "x",
        decisionId: "d",
      }),
    ).toThrow(/ignored/);
  });

  it("reflexSource derives from the principal", () => {
    expect(reflexSource(cfg)).toBe("jc.reflex.activation");
  });
});
