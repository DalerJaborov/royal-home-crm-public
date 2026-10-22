import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** Internal source identity for duplicate suppression only, never identity/tool
 * authority. Installed by actual webhook/native retry adapters, not JSON origin.
 * Retries reset the ordinal for the SAME original source; distinct inputs may
 * legitimately produce identical output and must have distinct effect keys. */
const sources = new AsyncLocalStorage<{ sourceHash: string; ordinal: number }>();
export function legacyMetaDmSourceHash(originalMid: string | null | undefined): string | null {
  return !originalMid || originalMid.length > 512 || /\s/.test(originalMid) ? null
    : createHash("sha256").update(JSON.stringify(["meta_dm_mid", originalMid])).digest("hex");
}
export function withLegacyMetaDmSource<T>(originalMid: string | null | undefined, run: () => Promise<T>): Promise<T> {
  const sourceHash = legacyMetaDmSourceHash(originalMid);
  if (!sourceHash) return sources.exit(run);
  return sources.run({ sourceHash, ordinal: 0 }, run);
}
export function nextLegacyPhysicalEffect(endpointScopeId: string | null, targetDigest: string): { effectKey: string | null; sourceHash: string | null } {
  const source = sources.getStore();
  if (!source || !endpointScopeId) return { effectKey: null, sourceHash: null };
  const ordinal = source.ordinal++;
  return { effectKey: createHash("sha256").update(JSON.stringify([1, endpointScopeId, source.sourceHash, targetDigest, ordinal])).digest("hex"),
    sourceHash: source.sourceHash };
}
