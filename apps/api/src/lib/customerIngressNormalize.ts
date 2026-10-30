import { createHash } from "node:crypto";
import { z } from "zod";
import { parseIncoming, type MetaIncoming } from "../messengers/meta.js";
import { WEBSITE_SESSION_RE } from "../messengers/websiteChat.js";
import { adReferralBoundToEvent, peekAdReferral } from "../messengers/metaPeerMemory.js";
import { customerPropertyEvidenceFromMeta, customerPropertyEvidenceFromText } from "./customerPropertyEvidence.js";
import { authenticatedCustomerRequestEvidence } from "./customerIngressAuthority.js";
import { customerNormalizedIngressSchema, type CustomerNormalizedIngressInput } from "./customerIngressPayload.js";

type VerifiedRequest = object & { rawBody?: Buffer };
const record = (value: unknown): Record<string, any> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Source = { path: string; frame: Record<string, any>; recipientPhoneDigits?: string };

/** Find the exact raw frame of a parser-produced MID/target, not a caller's
 * claimed JSON path. Multiple candidates fail closed rather than choose one. */
function metaSource(body: unknown, input: MetaIncoming): Source | null {
  const found: Source[] = [], envelope = record(body);
  list(envelope?.entry).forEach((rawEntry, e) => {
    const entry = record(rawEntry); if (!entry) return;
    if (envelope?.object === "whatsapp_business_account") {
      list(entry.changes).forEach((rawChange, c) => {
        const value = record(record(rawChange)?.value);
        if (record(value?.metadata)?.phone_number_id !== input.accountExternalId) return;
        list(value?.messages).forEach((rawMessage, m) => {
          const message = record(rawMessage);
          if (message?.id === input.messageId && message?.from === input.senderId) {
            const display = record(value?.metadata)?.display_phone_number;
            const digits = typeof display === "string" ? display.replace(/[+\s()-]/g, "") : "";
            found.push({ path: `$.entry[${e}].changes[${c}].value.messages[${m}]`, frame: message,
              ...(/^\d{8,15}$/.test(digits) ? { recipientPhoneDigits: digits } : {}) });
          }
        });
      });
    } else {
      const events: Source[] = list(entry.messaging).flatMap((value, m) => {
        const frame = record(value); return frame ? [{ path: `$.entry[${e}].messaging[${m}]`, frame }] : [];
      });
      list(entry.changes).forEach((value, c) => {
        const change = record(value), frame = record(change?.value);
        if (change?.field === "messages" && frame?.message) events.push({ path: `$.entry[${e}].changes[${c}].value`, frame });
      });
      for (const source of events) {
        const event = source.frame, message = record(event.message), postback = record(event.postback), echo = message?.is_echo === true;
        const sender = record(event.sender)?.id, recipient = record(event.recipient)?.id;
        if ((message?.mid ?? postback?.mid) === input.messageId && (echo ? recipient : sender) === input.senderId &&
            (echo ? sender : recipient || entry.id) === input.accountExternalId) found.push(source);
      }
    }
  });
  return found.length === 1 ? found[0] : null;
}
function mediaKind(value: string | undefined): CustomerNormalizedIngressInput["media"][number]["kind"] {
  return value === "image" || value === "video" || value === "audio" || value === "document" || value === "share" || value === "link" ? value : "unknown";
}
function observedMediaKind(value: string | undefined): CustomerNormalizedIngressInput["media"][number]["kind"] {
  if (value === "ig_reel" || value === "ig_post") return "share";
  if (value === "file") return "document";
  return mediaKind(value);
}

/** A click on our ad arrives as its own event without a message (MetaIncoming.referralOnly); the webhook
 * remembers it per account/peer after checking the signed target. The next CORE message of that peer
 * inside ten minutes gets it as ad evidence, but only when the message has no property reference of its own
 * (a typed link or number, a shared post, a story, a reply, a button) and no ad of its own: a second source
 * would turn into a conflict instead of help. Reading does not consume and the outcome is fixed per MID: the same event normalised again
 * (redelivery, recovery) gives the same evidence; the webhook consumes the memory once the message is taken. */
const REMEMBERED_AD_WINDOW_MS = 10 * 60_000;
function withRememberedAdReferral(message: MetaIncoming): MetaIncoming {
  if (message.isEcho || message.referralOnly || message.adId || message.adPostId || !message.messageId || !message.accountExternalId) return message;
  if (customerPropertyEvidenceFromMeta(message).length) return message;
  const ref = adReferralBoundToEvent(message.channel, message.senderId, message.accountExternalId, message.messageId,
    () => peekAdReferral(message.channel, message.senderId, message.accountExternalId!, Date.now(), REMEMBERED_AD_WINDOW_MS)?.ref ?? null);
  return ref ? { ...message, ...ref, fromAd: true, propertyReferralOrigin: "remembered_referral" } : message;
}

/** Only raw bytes belonging to this genuinely authenticated request are parsed.
 * Nothing here classifies FINAL-IN, creates a native, or mints a customer brand. */
export function normalizeAuthenticatedCustomerIngress(request: VerifiedRequest): { entries: CustomerNormalizedIngressInput[]; unsupported: number } {
  const evidence = authenticatedCustomerRequestEvidence(request);
  if (!evidence || !request.rawBody || request.rawBody.byteLength > 2 * 1024 * 1024) throw new Error("Authenticated raw ingress unavailable");
  const body: unknown = JSON.parse(request.rawBody.toString("utf8"));
  if (evidence.provenance === "website_application_key") {
    const parsed = z.object({ sessionId: z.string().regex(WEBSITE_SESSION_RE), text: z.string().trim().min(1).max(2000),
      name: z.string().trim().max(120).optional(), messageId: z.string().trim().min(1).max(200).optional(),
      pageUrl: z.string().trim().url().max(500).optional().catch(undefined),
    }).strip().parse(body);
    if (!parsed.messageId) return { entries: [], unsupported: 1 };
    return { entries: [customerNormalizedIngressSchema.parse({ version: 1, channel: "WEBSITE", peer: parsed.sessionId,
      eventKind: "website_message", eventId: parsed.messageId, inputText: parsed.text,
      ...(parsed.name ? { displayName: parsed.name } : {}), source: { path: "$", frameHash: hash(body) },
      observations: { providerEcho: false, referralOnly: false, classifier: { version: 1, bareTemplateEcho: false } }, media: [],
      propertyEvidence: customerPropertyEvidenceFromText(`${parsed.text}${parsed.pageUrl ? ` ${parsed.pageUrl}` : ""}`),
    })], unsupported: 0 };
  }
  const parsed = parseIncoming(body, undefined, false, { captureCustomerReferences: true });
  if (parsed.length > 64) throw new Error("Ingress batch exceeds bound");
  const supported = parsed.filter(message => !!message.messageId);
  return { unsupported: parsed.length - supported.length, entries: supported.map(message => {
    const source = metaSource(body, message);
    if (!source) throw new Error("Ingress frame membership ambiguous");
    const media: CustomerNormalizedIngressInput["media"] = [];
    const mediaKinds: CustomerNormalizedIngressInput["media"][number]["kind"][] = [];
    if (message.attachmentType || message.attachmentUrl || message.mediaId || message.attachmentMediaId) media.push({
      kind: mediaKind(message.attachmentType), ...(message.attachmentUrl ? { url: message.attachmentUrl } : {}),
      ...(message.mediaId ? { assetRef: message.mediaId } : {}), ...(message.attachmentMediaId ? { publicationId: message.attachmentMediaId } : {}),
    });
    if (media.length) mediaKinds.push(observedMediaKind(message.attachmentType));
    for (const extra of message.extraAttachments ?? []) {
      media.push({ kind: mediaKind(extra.type), ...(extra.url ? { url: extra.url } : {}),
        ...(extra.attachmentMediaId ? { publicationId: extra.attachmentMediaId } : {}) });
      mediaKinds.push(observedMediaKind(extra.type));
    }
    return customerNormalizedIngressSchema.parse({ version: 1, channel: message.channel, peer: message.senderId,
      accountExternalId: message.accountExternalId, eventId: message.messageId, eventKind: message.payload ? "postback" : "message",
      inputText: message.text ?? "", ...(message.name ? { displayName: message.name } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.payload ? { postbackPayload: message.payload } : {}),
      source: { path: source.path, frameHash: hash(source.frame) },
      observations: { providerEcho: !!message.isEcho, referralOnly: !!message.referralOnly,
        classifier: { version: 1, bareTemplateEcho: !message.text && message.attachmentType === "template",
          ...(mediaKinds.length ? { mediaKinds } : {}),
          ...(source.recipientPhoneDigits ? { recipientPhoneDigits: source.recipientPhoneDigits } : {}) } }, media,
      propertyEvidence: customerPropertyEvidenceFromMeta(withRememberedAdReferral(message)),
    });
  }) };
}

/** Routing metadata for an actual signed raw Meta frame, including missing MID.
 * No synthetic event identity, FINAL-IN or customer grant is manufactured. */
export function normalizeAuthenticatedMetaRoutingSubjects(request: VerifiedRequest): Array<{
  channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; peer: string; accountExternalId?: string;
  eventKind: "message" | "postback"; eventId?: string;
}> {
  if (authenticatedCustomerRequestEvidence(request)?.provenance !== "meta_signature" || !request.rawBody || request.rawBody.byteLength > 2*1024*1024) throw new Error("Raw routing request unavailable");
  const messages = parseIncoming(JSON.parse(request.rawBody.toString("utf8")), undefined, false, { captureCustomerReferences: true });
  if (messages.length > 64) throw new Error("Routing batch exceeds bound");
  return messages.filter(message => !message.isEcho && !message.referralOnly && !(!message.text && message.attachmentType === "template"))
    .map(message => ({ channel: message.channel, peer: message.senderId, accountExternalId: message.accountExternalId,
      eventKind: message.payload ? "postback" as const : "message" as const, ...(message.messageId ? { eventId: message.messageId } : {}) }));
}
