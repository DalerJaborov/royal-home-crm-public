import type { ProviderAdapter, ProviderApi, ProviderAttemptSpec } from "./providerContract.js";

/** API compatibility is an explicit server policy, not a guess from a model's
 * name or a claim that the configured provider is currently reachable. */
export interface GeminiCapabilityProfile {
  revision: string;
  model: string;
  api: ProviderApi;
  adapters: readonly ProviderAdapter[];
  modalities: readonly ("text" | "image" | "audio" | "video" | "document")[];
  tools: "none" | "function";
  structuredReply: boolean;
  thinking: "none" | "budget" | "level";
  explicitCache: boolean;
  grounding: boolean;
  maxOutputTokens: number;
}
const API_ADAPTERS: Readonly<Record<ProviderApi, readonly ProviderAdapter[]>> = {
  generateContent: ["text", "tools", "grounded", "media", "transcribe", "tts"],
  cachedContents: ["cache"], bidiGenerateContent: ["live"], embedContent: ["embeddings"],
};
/** Declared adapters whose existing wire path is connected to P13. Live/media
 * etc remain explicit unconnected profiles until their own measured gates. */
export const GEMINI_MANAGED_ADAPTERS: readonly ProviderAdapter[] = ["text", "tools", "grounded", "cache"];
export function createGeminiCapabilityRegistry(profiles: readonly GeminiCapabilityProfile[]) {
  const rows = profiles.map(profile => {
    if (!profile.revision.trim() || !profile.model.trim() || profile.model.includes("*") ||
        !Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0 ||
        !API_ADAPTERS[profile.api] || !profile.adapters.length ||
        profile.adapters.some(adapter => !API_ADAPTERS[profile.api].includes(adapter))) {
      throw new TypeError("Invalid Gemini capability profile");
    }
    return Object.freeze({ ...profile, adapters: Object.freeze([...profile.adapters]), modalities: Object.freeze([...profile.modalities]) });
  });
  if (new Set(rows.map(row => `${row.api}:${row.model}:${row.revision}`)).size !== rows.length) throw new TypeError("Duplicate Gemini profile");
  return Object.freeze({
    profiles: Object.freeze(rows),
    supports(spec: ProviderAttemptSpec): boolean {
      const profile = rows.find(row => row.model === spec.model && row.api === spec.api && row.revision === spec.profileRevision);
      return !!profile && GEMINI_MANAGED_ADAPTERS.includes(spec.adapter) && profile.adapters.includes(spec.adapter) &&
        (!spec.features?.functions || profile.tools === "function") &&
        (!spec.features?.structuredReply || profile.structuredReply) &&
        (!spec.features?.thinking || profile.thinking === spec.features.thinking) &&
        (!spec.features?.cache || profile.explicitCache) &&
        (!spec.features?.grounding || profile.grounding) &&
        (!spec.features?.images || profile.modalities.includes("image")) &&
        (!spec.features?.modalities || spec.features.modalities.every(modality => profile.modalities.includes(modality))) &&
        Number.isSafeInteger(spec.maxOutputTokens) && (spec.api === "cachedContents" ? spec.maxOutputTokens === 0 : spec.maxOutputTokens > 0) &&
        spec.maxOutputTokens <= profile.maxOutputTokens;
    },
    find(model: string, api: ProviderApi, revision: string): Readonly<GeminiCapabilityProfile> | undefined {
      return rows.find(row => row.model === model && row.api === api && row.revision === revision);
    },
  });
}
