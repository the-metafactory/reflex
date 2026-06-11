import { describe, expect, it } from "bun:test";
import { deriveIdempotencyKey } from "../../src/pipeline/impulse";

describe("deriveIdempotencyKey", () => {
  it("is stable across property order", async () => {
    expect(await deriveIdempotencyKey("bp", { a: 1, b: { d: 4, c: 3 } })).toBe(
      await deriveIdempotencyKey("bp", { b: { c: 3, d: 4 }, a: 1 }),
    );
  });
  it("differs across payloads and blueprints", async () => {
    const base = await deriveIdempotencyKey("bp", { a: 1 });
    expect(await deriveIdempotencyKey("bp", { a: 2 })).not.toBe(base);
    expect(await deriveIdempotencyKey("bp2", { a: 1 })).not.toBe(base);
  });
  it("handles arrays and nulls deterministically", async () => {
    expect(await deriveIdempotencyKey("bp", { xs: [1, null, "z"] })).toBe(
      await deriveIdempotencyKey("bp", { xs: [1, null, "z"] }),
    );
  });
  it("Web Crypto path matches the Bun.CryptoHasher digest", async () => {
    // The edge runtime takes the crypto.subtle branch — both paths must
    // produce the identical key or local and edge would never dedupe
    // each other's activations.
    const viaBun = await deriveIdempotencyKey("bp", { a: 1 });
    const material = `bp{"a":1}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    const viaWebCrypto = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(viaBun).toBe(viaWebCrypto);
  });
});
