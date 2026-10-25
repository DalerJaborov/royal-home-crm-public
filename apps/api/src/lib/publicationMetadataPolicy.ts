import { createHash } from "node:crypto";
import { z } from "zod";

export const metadataPayloadSchema = z.object({
  caption: z.string(), coverKey: z.string().nullable(), coverDigest: z.string().nullable(),
  targets: z.array(z.object({ postId: z.string().min(1), chatId: z.string().optional() })),
}).strict();
export type MetadataPayload = z.infer<typeof metadataPayloadSchema>;
export type MetadataResult = { status: "APPLIED" | "FAILED" | "UNKNOWN"; code: string };
export type MetadataPlan = { channel: string; operation: string; status: string; reason: string; payload: MetadataPayload };
export function metadataHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function planPublicationMetadata(input: { caption: string; coverKey: string | null; coverDigest: string | null; channels: string[]; postIds: unknown; telegramChatId: string | null }): MetadataPlan[] {
  const ids = input.postIds && typeof input.postIds === "object" ? input.postIds as Record<string, unknown> : {};
  return [...new Set(input.channels)].sort().flatMap(channel => ["CAPTION", "COVER"].map(operation => {
    const targets: MetadataPayload["targets"] = [];
    if (typeof ids[channel] === "string" && ids[channel]) {
      if (channel !== "TELEGRAM" || input.telegramChatId) targets.push({ postId: ids[channel] as string, ...(channel === "TELEGRAM" ? { chatId: input.telegramChatId! } : {}) });
    }
    if (channel === "TELEGRAM" && ids.TELEGRAM_EXTRA && typeof ids.TELEGRAM_EXTRA === "object") {
      for (const [chatId, postId] of Object.entries(ids.TELEGRAM_EXTRA).sort()) if (typeof postId === "string" && postId && !targets.some(t => t.chatId === chatId && t.postId === postId)) targets.push({ postId, chatId });
    }
    const supported = operation === "CAPTION" ? ["FACEBOOK", "TELEGRAM", "YOUTUBE"].includes(channel) : ["FACEBOOK", "YOUTUBE"].includes(channel);
    const missing = !targets.length || (operation === "COVER" ? !input.coverDigest : !input.caption.trim());
    return { channel, operation, status: supported && !missing ? "PREVIEW" : "MANUAL_REQUIRED",
      reason: !supported ? "Автоматическая замена не подтверждена; требуется ручная работа." : missing ? "Недостаточно данных публикации или материала." : "Предпросмотр; площадка ещё не изменена.",
      payload: { caption: input.caption, coverKey: input.coverKey, coverDigest: input.coverDigest, targets } };
  }));
}
/** One durable claim, one attempt per target. A partial/ambiguous write is never retried. */
export async function performMetadataTargets(plan: Pick<MetadataPlan, "channel" | "operation" | "payload">, adapter: (channel: string, operation: string, payload: MetadataPayload, target: MetadataPayload["targets"][number]) => Promise<MetadataResult>) {
  const results: Array<MetadataResult & { targetIndex: number }> = [];
  for (let i = 0; i < plan.payload.targets.length; i++) {
    let result: MetadataResult;
    try { result = await adapter(plan.channel, plan.operation, plan.payload, plan.payload.targets[i]); }
    catch { result = { status: "UNKNOWN", code: "OUTCOME_UNKNOWN" }; }
    results.push({ ...result, targetIndex: i });
    if (result.status !== "APPLIED") break;
  }
  const status = results.length && results.every(r => r.status === "APPLIED") && results.length === plan.payload.targets.length ? "APPLIED"
    : results.some(r => r.status === "UNKNOWN" || r.status === "APPLIED") ? "UNKNOWN" : "FAILED";
  return { status, results };
}
