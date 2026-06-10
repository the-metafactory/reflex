import { describe, expect, it } from "bun:test";
import { parseActivationDocument, parseDuration } from "../../src/activation/schema";

function doc(entries: string): string {
  return `schema: metafactory/activation/v1\nactivations:\n${entries}`;
}

const SCHEDULE_ENTRY = `  - id: pr-stats-daily
    target: "@jc/f-pr-stats"
    when:
      schedule: "0 7 * * *"
      timezone: Europe/Zurich
    policy: auto
    guards:
      cooldown: 6h
      run_lock: skip
    payload:
      mode: daily
`;

const BUS_ENTRY = `  - id: pilot-scan
    target: "@jc/pilot-scan"
    when:
      bus:
        subject: "local.jc.default.tasks.review.completed"
        where: { flow: review }
    policy: approval
    approval_timeout: 1h
    guards:
      run_lock: buffer
`;

const MANUAL_ENTRY = `  - id: f-testing
    target: "@jc/f-testing"
    when:
      manual: {}
`;

describe("parseDuration", () => {
  it("parses s/m/h/d forms to ms", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("6h")).toBe(21_600_000);
    expect(parseDuration("2d")).toBe(172_800_000);
  });
  it("rejects garbage with the raw value", () => {
    expect(() => parseDuration("6 hours")).toThrow(/6 hours/);
    expect(() => parseDuration("-5m")).toThrow(/-5m/);
  });
});

describe("activation schema", () => {
  it("parses all three example shapes with defaults applied", () => {
    const bps = parseActivationDocument(doc(SCHEDULE_ENTRY + BUS_ENTRY + MANUAL_ENTRY), "/tmp/x.yaml");
    expect(bps).toHaveLength(3);
    const sched = bps[0]!;
    expect(sched.id).toBe("pr-stats-daily");
    expect(sched.kind).toBe("schedule");
    expect(sched.guards.cooldownMs).toBe(21_600_000);
    expect(sched.guards.runLock).toBe("skip");
    expect(sched.approvalTimeoutMs).toBe(3_600_000); // default 1h
    expect(sched.sourceFile).toBe("/tmp/x.yaml");
    const bus = bps[1]!;
    expect(bus.kind).toBe("bus");
    expect(bus.policy).toBe("approval");
    expect(bus.when).toEqual({
      bus: { subject: "local.jc.default.tasks.review.completed", where: { flow: "review" } },
    });
    const manual = bps[2]!;
    expect(manual.kind).toBe("manual");
    expect(manual.policy).toBe("auto");
    expect(manual.guards).toEqual({});
  });

  it("rejects two impulse kinds in one when block", () => {
    const bad = `  - id: x
    target: "@jc/x"
    when:
      schedule: "0 7 * * *"
      bus: { subject: "a.b" }
`;
    expect(() => parseActivationDocument(doc(bad), "/tmp/x.yaml")).toThrow(/exactly one Impulse Kind/);
  });

  it("rejects run_lock allow, suggesting key removal", () => {
    const bad = SCHEDULE_ENTRY.replace("run_lock: skip", "run_lock: allow");
    expect(() => parseActivationDocument(doc(bad), "/tmp/x.yaml")).toThrow(/removing the key/);
  });

  it("rejects unknown keys (strict)", () => {
    const bad = SCHEDULE_ENTRY.replace("policy: auto", "policy: auto\n    triger: oops");
    expect(() => parseActivationDocument(doc(bad), "/tmp/x.yaml")).toThrow(/triger/);
  });

  it("rejects nested where fields — flat only in v0", () => {
    const bad = BUS_ENTRY.replace("where: { flow: review }", "where: { a: { b: 1 } }");
    expect(() => parseActivationDocument(doc(bad), "/tmp/x.yaml")).toThrow(/flat/i);
  });

  it("rejects invalid cron expressions naming them", () => {
    const bad = SCHEDULE_ENTRY.replace('"0 7 * * *"', '"99 99 * * *"');
    expect(() => parseActivationDocument(doc(bad), "/tmp/x.yaml")).toThrow(/99 99/);
  });

  it("rejects wrong schema header", () => {
    const text = `schema: metafactory/activation/v2\nactivations: []`;
    expect(() => parseActivationDocument(text, "/tmp/x.yaml")).toThrow(/activation\/v1/);
  });

  it("accepts http kind with token_env", () => {
    const entry = `  - id: gh-ping
    target: "@jc/gh"
    when:
      http:
        token_env: GH_PING_TOKEN
`;
    const bps = parseActivationDocument(doc(entry), "/tmp/x.yaml");
    expect(bps[0]!.kind).toBe("http");
  });
});
