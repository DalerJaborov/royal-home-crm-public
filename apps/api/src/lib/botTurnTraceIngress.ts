import type { BotIngressShape } from "@royal-home/shared";
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
/** Pure presence projection, including the current parser's postback referral loss. */
export function projectBotIngressShape(event: unknown, message: unknown, normalizedReferral: boolean): BotIngressShape {
  const e = object(event); const m = object(message); const postback = object(e.postback);
  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  const waAttachment = ["image", "audio", "voice", "video", "document", "sticker", "location"].some((field) => !!m[field]) || (Array.isArray(m.contacts) && m.contacts.length > 0);
  return { eventReferral: !!e.referral, messageReferral: !!m.referral, postbackReferral: !!postback.referral,
    quickReplyPayload: !!object(m.quick_reply).payload, postbackPayload: !!postback.payload,
    replyTo: !!m.reply_to || !!object(m.context).id, story: !!object(m.reply_to).story,
    attachments: Math.min(1000, attachments.length || (waAttachment ? 1 : 0)), normalizedReferral };
}
