import { describe, expect, it } from "bun:test";
import { reflexStreamSubjects, REFLEX_STREAM_NAME } from "../src/bus/stream";
import { testConfig } from "./helpers";

describe("reflex stream config", () => {
  it("derives the wildcard from principal + stack, never hand-built elsewhere", () => {
    const cfg = testConfig();
    expect(reflexStreamSubjects(cfg)).toEqual(["local.jc.default.reflex.>"]);
  });

  it("stream name is REFLEX", () => {
    expect(REFLEX_STREAM_NAME).toBe("REFLEX");
  });
});
