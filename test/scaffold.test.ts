import { describe, expect, it } from "bun:test";
import { InMemoryTransport, createTransport } from "@the-metafactory/myelin";

describe("scaffold", () => {
  it("resolves myelin transport exports", () => {
    const t = createTransport({ type: "memory" });
    expect(t).toBeInstanceOf(InMemoryTransport);
  });
});
