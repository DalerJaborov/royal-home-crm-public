import { z } from "zod";
import { geminiReportedUsage, type ProviderUsage } from "./providerContract.js";

/** Decoder identifier must be selected by the ORIGINAL archived runtime profile,
 * never by response JSON, a model tool argument, or a generic SDK adapter. */
export const GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL = "google-generatecontent-v1beta-text-tools-protojson-20261015-v1" as const;
const tokenCount = z.number().int().min(0).max(2_147_483_647);
const textDetails = z.array(z.object({ modality: z.literal("TEXT"), tokenCount }).strict()).max(1);
const usageSchema = z.object({
  promptTokenCount: tokenCount.optional(), candidatesTokenCount: tokenCount.optional(),
  cachedContentTokenCount: tokenCount.optional(), thoughtsTokenCount: tokenCount.optional(),
  toolUsePromptTokenCount: tokenCount.optional(), totalTokenCount: tokenCount.optional(),
  promptTokensDetails: textDetails.optional(), candidatesTokensDetails: textDetails.optional(),
  cacheTokensDetails: textDetails.optional(), toolUsePromptTokensDetails: textDetails.optional(),
  // Endpoint reference documents lowercase values; the current pinned reference
  // rate is standard only. Do not treat flex/priority as standard pricing.
  serviceTier: z.enum(["unspecified", "standard"]).optional(),
}).strict();
type DefaultedField = "cachedContentTokenCount" | "thoughtsTokenCount" | "toolUsePromptTokenCount";
type UnknownReason = "missing_usage" | "invalid_usage" | "unsupported_fields" | "missing_anchors" |
  "normalization_requires_totals" | "inconsistent_totals" | "unpriced_tool_input" | "inconsistent_details";
export type ManagedGeminiToolsUsage =
  | { status: "complete"; usage: ProviderUsage; protocol: typeof GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL; defaultedFields: DefaultedField[] }
  | { status: "unknown"; usage: ProviderUsage; reason: UnknownReason };

/** Only the text-only, nonstreaming /v1beta/models/*:generateContent function
 * declaration wire. This function validates data; it does not qualify a model,
 * authenticate a response, enable tools, approve prices, or issue a refund.
 * Caller must have bound the exact archived profile/target to the attempt. */
export function decodeManagedGeminiToolsUsage(raw: unknown): ManagedGeminiToolsUsage {
  const unknown = (reason: UnknownReason): ManagedGeminiToolsUsage => {
    const baseline = geminiReportedUsage(raw, "tools");
    return { status: "unknown", reason, usage: { ...baseline,
      completeness: baseline.source === "missing" ? "missing" : "partial" } };
  };
  if (raw === null || raw === undefined) return unknown("missing_usage");
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) return unknown(parsed.error.issues.some(issue => issue.code === "unrecognized_keys") ? "unsupported_fields" : "invalid_usage");
  // Explicit undefined is not serialized JSON and must not masquerade as a
  // ProtoJSON omission. Null/string/NaN/etc were already rejected by the schema.
  if (Object.values(parsed.data).some(value => value === undefined)) return unknown("invalid_usage");
  const value = parsed.data;
  const p = value.promptTokenCount, c = value.candidatesTokenCount;
  if (p === undefined || c === undefined) return unknown("missing_anchors");
  const completeBaseline = value.cachedContentTokenCount !== undefined && value.thoughtsTokenCount !== undefined;
  if (!completeBaseline && (p <= 0 || value.totalTokenCount === undefined)) return unknown("normalization_requires_totals");

  // These three fields are plain proto3 int32 without explicit presence in the
  // official GenerateContentResponse.UsageMetadata descriptor. Only this
  // pinned protocol may interpret their ABSENT JSON key as scalar default zero.
  const k = value.cachedContentTokenCount ?? 0;
  const h = value.thoughtsTokenCount ?? 0;
  const u = value.toolUsePromptTokenCount ?? 0;
  if (k > p) return unknown("inconsistent_totals");
  // REST reference + JS SDK describe total = P + C + H + U. Cache is a subset
  // of P and is NOT added again. Old googleapis proto's total comment is stale.
  if (value.totalTokenCount !== undefined && value.totalTokenCount !== p + c + h + u) return unknown("inconsistent_totals");
  // Existing ProviderUsage/price policy has no independently proven tool-input
  // category. Never hide U in zero/P or silently apply an invented input rate.
  if (u > 0) return unknown("unpriced_tool_input");
  const matches = (details: z.infer<typeof textDetails> | undefined, expected: number) =>
    details === undefined || details.reduce((sum, item) => sum + item.tokenCount, 0) === expected;
  if (!matches(value.promptTokensDetails, p) || !matches(value.candidatesTokensDetails, c) ||
      !matches(value.cacheTokensDetails, k) || !matches(value.toolUsePromptTokensDetails, u)) return unknown("inconsistent_details");
  const defaultedFields: DefaultedField[] = [];
  if (value.cachedContentTokenCount === undefined) defaultedFields.push("cachedContentTokenCount");
  if (value.thoughtsTokenCount === undefined) defaultedFields.push("thoughtsTokenCount");
  if (value.toolUsePromptTokenCount === undefined) defaultedFields.push("toolUsePromptTokenCount");
  return { status: "complete", protocol: GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL, defaultedFields,
    usage: { source: "reported", completeness: "complete", inputTokens: p - k, outputTokens: c,
      cacheReadTokens: k, thinkingTokens: h, audioInputTokens: null, audioOutputTokens: null, searchUnits: null } };
}
