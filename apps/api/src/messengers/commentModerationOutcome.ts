import { z } from "zod";

export type ModerationProvider = "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" | "TELEGRAM";
export type ModerationEffect = "delete" | "hide" | "unhide" | "reject";
export type ModerationOutcome = {
  outcome: "accepted" | "refused" | "gone" | "unknown";
  provider: ModerationProvider;
  effect: ModerationEffect;
  reason: string;
};

const graphSuccessSchema = z.object({ success: z.boolean() }).passthrough();
const graphErrorSchema = z.object({ error: z.object({ code: z.number().int() }).passthrough() }).passthrough();
const telegramSuccessSchema = z.object({ ok: z.literal(true), result: z.literal(true) }).passthrough();
const youtubeSuccessSchema = z.object({ status: z.literal(204), body: z.literal("") });

export class CommentModerationError extends Error {
  constructor(readonly result: ModerationOutcome) {
    super(`Comment moderation ${result.outcome}: ${result.reason}`);
  }
}

export function requireModerationAccepted(result: ModerationOutcome): ModerationOutcome {
  if (result.outcome !== "accepted") throw new CommentModerationError(result);
  return result;
}

export function graphModerationOutcome(
  provider: "INSTAGRAM" | "FACEBOOK", effect: "delete" | "hide" | "unhide", body: unknown
): ModerationOutcome {
  const parsed = graphSuccessSchema.safeParse(body);
  if (parsed.success && !Object.hasOwn(parsed.data, "error") && !Object.hasOwn(parsed.data, "error_code")) {
    const success = parsed.data.success;
    return { provider, effect, outcome: success ? "accepted" : "refused", reason: success ? "provider_confirmed" : "provider_false" };
  }
  return { provider, effect, outcome: "unknown", reason: "unconfirmed_response" };
}

export function telegramDeleteOutcome(body: unknown, status = 200): ModerationOutcome {
  const parsed = telegramSuccessSchema.safeParse(body);
  const accepted = status >= 200 && status < 300 && parsed.success && !Object.hasOwn(parsed.data, "error_code");
  return { provider: "TELEGRAM", effect: "delete", outcome: accepted ? "accepted" : "unknown",
    reason: accepted ? "provider_confirmed" : "unconfirmed_response" };
}

export function youtubeRejectOutcome(status: number, body: string): ModerationOutcome {
  const accepted = youtubeSuccessSchema.safeParse({ status, body }).success;
  return { provider: "YOUTUBE", effect: "reject", outcome: accepted ? "accepted" : "unknown",
    reason: accepted ? "provider_confirmed" : "unconfirmed_response" };
}

/** Only errors returned by this moderation attempt; no existence inference from a failed GET. */
export function moderationErrorOutcome(
  provider: ModerationProvider, effect: ModerationEffect, error: unknown
): ModerationOutcome {
  if (error instanceof CommentModerationError) return error.result;
  const text = error instanceof Error ? error.message : "";
  if (provider === "TELEGRAM") {
    if (/^Telegram API deleteMessage:.*message to delete not found/i.test(text)) {
      return { provider, effect, outcome: "gone", reason: "message_not_found" };
    }
    if (/^Telegram API deleteMessage:.*(?:can't be deleted|not enough rights|need administrator rights|CHAT_ADMIN_REQUIRED|have no rights)/i.test(text)) {
      return { provider, effect, outcome: "refused", reason: "delete_not_allowed" };
    }
  }
  if (provider === "YOUTUBE") {
    const detail = error as { status?: unknown; reason?: unknown } | null;
    if (detail?.status === 404 && detail.reason === "commentNotFound") {
      return { provider, effect, outcome: "gone", reason: "comment_not_found" };
    }
    if (detail?.status === 401 || detail?.status === 403) {
      return { provider, effect, outcome: "refused", reason: "provider_denied" };
    }
  }
  if (provider === "INSTAGRAM" || provider === "FACEBOOK") {
    const response = /^Graph API HTTP (\d{3}): (.*)$/s.exec(text);
    const status = response?.[1];
    if (status === "401" || status === "403") {
      return { provider, effect, outcome: "refused", reason: "provider_denied" };
    }
    if (status?.startsWith("4")) {
      try {
        const body = graphErrorSchema.safeParse(JSON.parse(response![2]));
        if (body.success && [190, 200, 368].includes(body.data.error.code)) {
          return { provider, effect, outcome: "refused", reason: "provider_denied" };
        }
      } catch {
        // Truncated error text or ambiguous code 100 never proves absence/refusal.
      }
    }
  }
  return { provider, effect, outcome: "unknown", reason: "unconfirmed_attempt" };
}

export function moderationFailureNote(result: ModerationOutcome): string {
  return result.outcome === "gone" ? "gone" : result.outcome === "refused"
    ? (result.effect === "hide" || result.effect === "unhide" ? "cant_hide" : "cant_delete")
    : "moderation_unknown";
}

export function moderationAcceptedNote(result: ModerationOutcome, reason: string): string {
  requireModerationAccepted(result);
  const marker = result.effect === "reject" ? "youtube_rejected"
    : result.effect === "delete" ? "moderation_deleted" : "moderation_hidden";
  return (reason ? `${marker}; ${reason}` : marker).slice(0, 200);
}
