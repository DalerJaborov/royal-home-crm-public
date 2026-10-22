import { z } from "zod";

export const metaMessageIdSchema = z.string().min(1).max(512).refine(value => !/\s/.test(value));
const mid = metaMessageIdSchema;
/** DM and comment replies have different provider receipt fields. */
export const metaMessageReceiptSchema = z.object({ message_id: mid.optional(),
  messages: z.array(z.object({ id: mid }).passthrough()).length(1).optional() }).passthrough()
  .refine(value => !value.message_id || !value.messages || value.message_id === value.messages[0].id);
const publicReceiptSchema = z.object({ id: mid }).passthrough();
export function contradictoryMetaSendResponse(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return Object.hasOwn(value, "error") || Object.hasOwn(value, "error_code") || value.success === false || value.ok === false;
}
export function metaPhysicalReceiptId(surface: "dm" | "public_comment" | null, raw: unknown): string | null {
  if (contradictoryMetaSendResponse(raw)) return null;
  if (surface === "dm") {
    const parsed = metaMessageReceiptSchema.safeParse(raw);
    return parsed.success ? parsed.data.message_id ?? parsed.data.messages?.[0].id ?? null : null;
  }
  const parsed = surface === "public_comment" ? publicReceiptSchema.safeParse(raw) : null;
  return parsed?.success ? parsed.data.id : null;
}
