import { describe, expect, it } from "bun:test";
import { deriveIdempotencyKey } from "../../src/pipeline/impulse";

describe("deriveIdempotencyKey", () => {
  it("is stable across property order", () => {
    expect(deriveIdempotencyKey("bp", { a: 1, b: { d: 4, c: 3 } })).toBe(
      deriveIdempotencyKey("bp", { b: { c: 3, d: 4 }, a: 1 }),
    );
  });
  it("differs across payloads and blueprints", () => {
    const base = deriveIdempotencyKey("bp", { a: 1 });
    expect(deriveIdempotencyKey("bp", { a: 2 })).not.toBe(base);
    expect(deriveIdempotencyKey("bp2", { a: 1 })).not.toBe(base);
  });
  it("handles arrays and nulls deterministically", () => {
    expect(deriveIdempotencyKey("bp", { xs: [1, null, "z"] })).toBe(
      deriveIdempotencyKey("bp", { xs: [1, null, "z"] }),
    );
  });
});
