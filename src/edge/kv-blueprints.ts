import type { KVNamespace } from "@cloudflare/workers-types";
import { parseActivationDocument } from "../activation/schema";
import { mergeBlueprints } from "../activation/store";
import type { ActivationBlueprint } from "../activation/types";

/**
 * KV-backed blueprint loading (reflex#15) — the edge replacement for
 * R-102's config files + fs.watch. Activation documents live as YAML
 * values under a key prefix (one document per key, same format the local
 * daemon reads from disk); an admin writes them via `wrangler kv` or a
 * later admin API. Loading is pull-based: the Durable Object refreshes on
 * its alarm cadence and swaps the in-memory BlueprintStore — the same
 * swap/diff semantics (removal expiry, subscription reconcile) the local
 * hot-reload path uses.
 *
 * Duplicate ids across documents throw exactly like the local loader
 * (mergeBlueprints is shared code).
 */
export const DEFAULT_BLUEPRINT_PREFIX = "activation/";

export async function loadBlueprintsFromKV(
  kv: KVNamespace,
  prefix: string = DEFAULT_BLUEPRINT_PREFIX,
): Promise<ActivationBlueprint[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const documents = await Promise.all(
    keys.map(async (key) => {
      const text = await kv.get(key, "text");
      // A key deleted between list and get is simply absent this cycle.
      if (text === null) return [];
      // sourceFile carries KV provenance — duplicate-id errors name both keys.
      return parseActivationDocument(text, `kv:${key}`);
    }),
  );
  return mergeBlueprints(documents);
}
