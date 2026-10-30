import { z } from "zod";

/** Transport metadata, not a claim that the model saw/listened to a file.
 * Derived only from the original authenticated DM envelope. No URL, caption,
 * phone, consent or executable instructions enter this value. */
export const customerAgentAttachmentInputSchema = z.object({
  kinds: z.array(z.enum(["image", "audio", "video", "document", "share", "foreign_share", "own_share_unlinked", "link", "unknown"])).min(1).max(16),
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

const ATTACHMENT_OBJECT_QUESTION = { ru: "Что хотите узнать об этом объекте?", tg: "Дар бораи ин объект чиро донистан мехоҳед?" };
const ATTACHMENT_QUESTIONS = {
    share: { ru: "Что хотите узнать по этой публикации?", tg: "Дар бораи ин нашрия чиро донистан мехоҳед?" },
    foreign_share: FOREIGN_SHARE_LINE,
    own_share_unlinked: OWN_SHARE_UNLINKED_LINE,
    link: { ru: "Что хотите узнать по этой ссылке?", tg: "Дар бораи ин пайванд чиро донистан мехоҳед?" },
    image: { ru: "Получил фото, но его содержимое мне сейчас недоступно. Что вы хотели уточнить?", tg: "Аксро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Чиро пурсидан мехостед?" },
    audio: { ru: "Получил голосовое, но его содержимое мне сейчас недоступно. Можете написать ваш вопрос текстом?", tg: "Паёми овозиро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Метавонед саволатонро бо матн нависед?" },
    video: { ru: "Получил видео, но его содержимое мне сейчас недоступно. Что вы хотели узнать?", tg: "Видеоро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Чиро донистан мехостед?" },
    document: { ru: "Получил документ, но его содержимое мне сейчас недоступно. Какой вопрос вы хотели обсудить?", tg: "Ҳуҷҷатро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Кадом саволро муҳокима кардан мехостед?" },
    unknown: { ru: "Вложение не открылось. Напишите текстом, что вас интересует.", tg: "Файл кушода нашуд. Бо матн нависед, чӣ лозим аст." },
};

export function customerAgentAttachmentQuestion(input: CustomerAgentAttachmentInput, language: "ru" | "tg", hasProperty: boolean): string {
  if (hasProperty) return ATTACHMENT_OBJECT_QUESTION[language];
  const kinds = [...new Set(input.kinds)];
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
  return [...Object.values(ATTACHMENT_QUESTIONS), ATTACHMENT_OBJECT_QUESTION].flatMap(line => [line.ru, line.tg]);
}
