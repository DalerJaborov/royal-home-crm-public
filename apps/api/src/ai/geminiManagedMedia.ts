import { z } from "zod";
import { ProviderOperationError, geminiReportedUsage, type ProviderAttemptSpec, type ProviderUsage } from "./providerContract.js";
import { decodeManagedGeminiToolsUsage } from "./geminiManagedToolsUsage.js";

/** Selected only by an immutable, explicitly approved provider profile. Existing
 * text ledgers keep their original decoder and cannot acquire media pricing. */
export const GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL = "google-generatecontent-v1beta-multimodal-tools-20261017-v1" as const;
export const GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES = 20_000_000;
export const GEMINI_MANAGED_MEDIA_MIMES = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  audio: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/aac", "audio/flac"],
  video: ["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/mpeg"],
  document: ["application/pdf", "text/plain"],
} as const;
export type CustomerMediaModality = keyof typeof GEMINI_MANAGED_MEDIA_MIMES;

/** Inline bytes only. External File API/YouTube URLs require a separate measured
 * lifecycle; arbitrary provider parts are never silently treated as images. */
export function managedGeminiMediaFeatures(parts: readonly unknown[]): NonNullable<ProviderAttemptSpec["features"]> {
  const modalities = new Set<CustomerMediaModality>();
  const allowed = new Set(["text", "inline_data", "inlineData", "functionCall", "functionResponse", "thoughtSignature", "thought"]);
  for (const raw of parts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProviderOperationError("unsupported");
    const part = raw as Record<string, unknown>;
    if (Object.keys(part).some(key => !allowed.has(key))) throw new ProviderOperationError("unsupported");
    if ("inline_data" in part && "inlineData" in part) throw new ProviderOperationError("unsupported");
    for (const key of ["inline_data", "inlineData"]) {
      if (!(key in part)) continue;
      const carrier = part[key] as Record<string, unknown>;
      const mime = carrier?.mime_type ?? carrier?.mimeType;
      const modality = Object.entries(GEMINI_MANAGED_MEDIA_MIMES).find(([, mimes]) => (mimes as readonly string[]).includes(mime as string))?.[0] as CustomerMediaModality | undefined;
      if (!carrier || typeof carrier !== "object" || Array.isArray(carrier) || "mime_type" in carrier && "mimeType" in carrier || Object.keys(carrier).some(key => !["mime_type", "mimeType", "data"].includes(key)) ||
          !modality || typeof carrier.data !== "string" || !carrier.data.length || carrier.data.length > GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES ||
          carrier.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(carrier.data)) throw new ProviderOperationError("unsupported");
      modalities.add(modality);
    }
    const response = part.functionResponse;
    if (response && typeof response === "object" && "parts" in response) {
      const nested = (response as { parts: unknown }).parts;
      if (!Array.isArray(nested)) throw new ProviderOperationError("unsupported");
      for (const modality of managedGeminiMediaFeatures(nested).modalities ?? []) modalities.add(modality);
    }
  }
  return { images: modalities.has("image"), ...(modalities.size ? { modalities: [...modalities].sort() } : {}) };
}

const detail = z.array(z.object({ modality: z.enum(["TEXT", "IMAGE", "AUDIO", "VIDEO", "DOCUMENT"]),
  tokenCount: z.number().int().nonnegative().max(2_147_483_647) }).strict()).max(5);
/** Gemini3.6 standard has one input rate for these modalities. Details are
 * checked before reduction; AUDIO is included in inputTokens, not charged twice. */
export function decodeManagedGeminiMediaUsage(raw: unknown): ProviderUsage {
  const unknown = (): ProviderUsage => ({ ...geminiReportedUsage(raw, "tools"), completeness: raw == null ? "missing" : "partial" });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unknown();
  const value = raw as Record<string, unknown>;
  const projection = { ...value };
  for (const [key, anchor] of [["promptTokensDetails", "promptTokenCount"], ["candidatesTokensDetails", "candidatesTokenCount"],
    ["cacheTokensDetails", "cachedContentTokenCount"], ["toolUsePromptTokensDetails", "toolUsePromptTokenCount"]] as const) {
    if (!(key in value)) continue;
    const parsed = detail.safeParse(value[key]);
    if (!parsed.success || new Set(parsed.data.map(item => item.modality)).size !== parsed.data.length ||
        parsed.data.reduce((sum, item) => sum + item.tokenCount, 0) !== (value[anchor] ?? 0) ||
        key !== "promptTokensDetails" && parsed.data.some(item => item.modality !== "TEXT")) return unknown();
    // Validation above establishes the actual input sum. The existing strict
    // ProtoJSON decoder still validates anchors, totals, omissions and new fields.
    projection[key] = parsed.data.length ? [{ modality: "TEXT", tokenCount: value[anchor] ?? 0 }] : [];
  }
  return decodeManagedGeminiToolsUsage(projection).usage;
}

export const managedGeminiMediaDetailSchema = detail;
export const customerAgentMediaCountResponseSchema = z.object({
  totalTokens: z.number().int().nonnegative().max(32768), cachedContentTokenCount: z.literal(0).optional(),
  promptTokensDetails: detail.optional(), cacheTokensDetails: z.array(z.never()).max(0).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.promptTokensDetails && (new Set(value.promptTokensDetails.map(row => row.modality)).size !== value.promptTokensDetails.length ||
      value.promptTokensDetails.reduce((sum, row) => sum + row.tokenCount, 0) > value.totalTokens)) {
    ctx.addIssue({ code: "custom", message: "Inconsistent multimodal count details" });
  }
});
