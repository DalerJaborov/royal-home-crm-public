import { commentDecisionSchema, type CommentDecision, type CommentDecisionCapabilities } from "@royal-home/shared";
import { logSystemError } from "../lib/systemError.js";

/** All current comment adapters implement moderation attempts. Actual provider
 * rights remain the existing transport responsibility, not a model claim. */
export function commentDecisionCapabilities(channel: string): CommentDecisionCapabilities {
  return { privateReply: channel === "INSTAGRAM" || channel === "FACEBOOK", supportsModeration: true };
}

export function validateCommentDecision(raw: unknown, capabilities: CommentDecisionCapabilities, endpoint: "instagram-comment" | "telegram-comment"): CommentDecision | null {
  if (raw == null) return null;
  const parsed = commentDecisionSchema(capabilities).safeParse(raw);
  if (parsed.success) return parsed.data;
  const fields = new Set(["action", "reply", "dm", "reason"]);
  const issues = parsed.error.issues.slice(0, 8).map((issue) => {
    const head = issue.path[0];
    return `${typeof head === "string" && fields.has(head) ? head : "other"}:${issue.code}`;
  }).join(", ");
  // Never record model values or unknown resource/actor field names.
  void logSystemError("ai", `CommentDecision invalid (${endpoint}; ${issues})`);
  return null; // Existing consumer null/AiUnavailable path handles retries.
}
