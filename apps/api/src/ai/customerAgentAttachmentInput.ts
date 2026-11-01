import { z } from "zod";

/** Transport metadata, not a claim that the model saw/listened to a file.
 * Derived only from the original authenticated DM envelope. No URL, caption,
 * phone, consent or executable instructions enter this value. */
export const customerAgentAttachmentInputSchema = z.object({
  kinds: z.array(z.enum(["image", "audio", "video", "document", "share", "foreign_share", "own_share_unlinked", "link", "ephemeral", "unknown"])).min(1).max(16),
}).strict();
export type CustomerAgentAttachmentInput = z.infer<typeof customerAgentAttachmentInputSchema>;

/** A publication somebody forwarded to us that is NOT ours: the lookup in our own accounts found nothing (the server
 * decides that, never the model). It is neither a question nor a listing, so it is answered with this one line at most
 * once per dialogue and then not at all (30.10.2026: the same "Что хотите узнать по этой публикации?" three times in a row). */
export const FOREIGN_SHARE_LINE = {
  ru: "Эта публикация не наша. Если ищете жильё, напишите, что нужно.",
  tg: "Ин нашрия аз мо нест. Агар хона лозим бошад, нависед, чӣ мекобед.",
} as const;
/** Our own publication (found in our account) that no object is linked to: say so once and ask for the wish in words. */
export const OWN_SHARE_UNLINKED_LINE = {
  ru: "Это наша публикация, но объект к ней не привязан. Напишите район и число комнат — подберу.",
  tg: "Ин нашрияи мост, вале объект ба он пайваст нест. Минтақа ва шумораи ҳуҷраҳоро нависед — интихоб мекунам.",
} as const;
/** Every attachment of the input is our own unlinked publication. */
export function customerAgentOwnUnlinkedOnly(input: CustomerAgentAttachmentInput | undefined): boolean {
  return !!input && input.kinds.length > 0 && input.kinds.every(kind => kind === "own_share_unlinked");
}
/** The fixed notice for a lone foreign / own-unlinked publication, or null for any other input. */
export function customerAgentShareNotice(input: CustomerAgentAttachmentInput | undefined, language: "ru" | "tg"): string | null {
  return customerAgentForeignShareOnly(input) ? FOREIGN_SHARE_LINE[language] : customerAgentOwnUnlinkedOnly(input) ? OWN_SHARE_UNLINKED_LINE[language] : null;
}
/** Every attachment of the input is a foreign publication (nothing of ours is mixed in). */
export function customerAgentForeignShareOnly(input: CustomerAgentAttachmentInput | undefined): boolean {
  return !!input && input.kinds.length > 0 && input.kinds.every(kind => kind === "foreign_share");
}
/** Marks the shares of an input as foreign. Pure: whether they ARE foreign is the caller's server fact, never the model's. */
export function customerAgentMarkForeignShare(input: CustomerAgentAttachmentInput | undefined, kind: "foreign_share" | "own_share_unlinked" | false): CustomerAgentAttachmentInput | undefined {
  if (!input || !kind || !input.kinds.every(kind => kind === "share")) return input;
  return { kinds: input.kinds.map(() => kind) };
}

/** The one question for anything we cannot (or need not) read: never a word about the file failing to open. */
export const BUSINESS_QUESTION = {
  ru: "Что вас интересует: покупка или продажа недвижимости?",
  tg: "Шуморо чӣ лозим: харид ё фурӯши манзил?",
} as const;
/** A disappearing (one-time) photo or video cannot be kept by anybody: ask for an ordinary one. */
export const EPHEMERAL_PHOTO_LINE = {
  ru: "Пришлите, пожалуйста, обычным фото — так агент его сохранит.",
  tg: "Лутфан, ҳамчун акси оддӣ фиристед — агент онро нигоҳ медорад.",
} as const;
/** A photo with no object found: it is usually a screenshot of a listing, so the object number is asked first
 * (01.11.2026 live: a photo got a list of other objects). A seller can still say so. */
const IMAGE_OBJECT_QUESTION = {
  ru: "Какой это объект? Пришлите его номер или ссылку, а если хотите продать свою недвижимость — так и напишите.",
  tg: "Ин кадом объект аст? Рақам ё пайвандашро фиристед, агар амволи худро фурӯхтан хоҳед — ҳамин тавр нависед.",
} as const;
const ATTACHMENT_OBJECT_QUESTION = { ru: "Что хотите узнать об этом объекте?", tg: "Дар бораи ин объект чиро донистан мехоҳед?" };
const ATTACHMENT_QUESTIONS = {
    share: { ru: "Что хотите узнать по этой публикации?", tg: "Дар бораи ин нашрия чиро донистан мехоҳед?" },
    foreign_share: FOREIGN_SHARE_LINE,
    own_share_unlinked: OWN_SHARE_UNLINKED_LINE,
    link: { ru: "Что хотите узнать по этой ссылке?", tg: "Дар бораи ин пайванд чиро донистан мехоҳед?" },
    image: BUSINESS_QUESTION, audio: BUSINESS_QUESTION, video: BUSINESS_QUESTION, document: BUSINESS_QUESTION,
    ephemeral: BUSINESS_QUESTION, unknown: BUSINESS_QUESTION,
};

/** `focused`: an object is in focus or the customer is a seller (then a one-time photo is worth asking to be resent as an ordinary one). */
export function customerAgentAttachmentQuestion(input: CustomerAgentAttachmentInput, language: "ru" | "tg", hasProperty: boolean, focused = hasProperty): string {
  const kinds = [...new Set(input.kinds)];
  if (kinds.length === 1 && kinds[0] === "ephemeral" && focused) return EPHEMERAL_PHOTO_LINE[language];
  if (hasProperty) return ATTACHMENT_OBJECT_QUESTION[language];
  if (kinds.length === 1 && kinds[0] === "image" && !focused) return IMAGE_OBJECT_QUESTION[language];
  return ATTACHMENT_QUESTIONS[kinds.length === 1 ? kinds[0] : "unknown"][language];
}
/** True when an earlier assistant turn of this dialogue already answered a forwarded publication with a fixed line
 * (the foreign-share line, or the generic "what do you want to know about this publication" the older build sent). */
export function customerAgentForeignShareAnswered(assistantTexts: readonly string[]): boolean {
  const lines = new Set([FOREIGN_SHARE_LINE.ru, FOREIGN_SHARE_LINE.tg, OWN_SHARE_UNLINKED_LINE.ru, OWN_SHARE_UNLINKED_LINE.tg, ATTACHMENT_QUESTIONS.share.ru, ATTACHMENT_QUESTIONS.share.tg]);
  return assistantTexts.some(text => text.split(/\r?\n/).some(line => lines.has(line.trim())));
}
/** Every fixed line above: the repeat guard must see them as questions already asked, and the memory allow-list as renderer text. */
export function customerAgentAttachmentLines(): string[] {
  return [...Object.values(ATTACHMENT_QUESTIONS), ATTACHMENT_OBJECT_QUESTION, IMAGE_OBJECT_QUESTION, EPHEMERAL_PHOTO_LINE].flatMap(line => [line.ru, line.tg]);
}

/** The LAST assistant turn was only this kind of fixed attachment question (business question, ephemeral request, object question):
 * asking it again would be a repeat, so the answer to a second file with the same nothing in it is silence. */
export function customerAgentAttachmentQuestionAsked(assistantTexts: readonly string[]): boolean {
  const last = assistantTexts.at(-1);
  if (!last) return false;
  const lines = new Set([BUSINESS_QUESTION.ru, BUSINESS_QUESTION.tg, EPHEMERAL_PHOTO_LINE.ru, EPHEMERAL_PHOTO_LINE.tg,
    ATTACHMENT_OBJECT_QUESTION.ru, ATTACHMENT_OBJECT_QUESTION.tg, IMAGE_OBJECT_QUESTION.ru, IMAGE_OBJECT_QUESTION.tg]);
  const parts = last.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(line => lines.has(line));
}
