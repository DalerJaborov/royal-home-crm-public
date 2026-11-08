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
// 08.11.2026 (owner: "грубый и резкий"): the bare "Эта публикация не наша." read as a rebuke. Softer and with the reason;
// still no thanks (owner 30.10: like-exchange words get no "Спасибо"), the first contact adds the greeting.
export const FOREIGN_SHARE_LINE = {
  ru: "Похоже, эта публикация не наша: такого объекта нет в нашем каталоге. Если ищете жильё, напишите, какое вам нужно.",
  tg: "Ин эълон аз мо нест, дар каталоги мо чунин объект нест. Агар хона лозим бошад, нависед, ки чӣ гуна хона мекобед.",
} as const;
/** Our own publication (found in our account) that no object is linked to: say so once and ask for the wish in words. No dash (owner's rule). */
export const OWN_SHARE_UNLINKED_LINE = {
  ru: "Это наша публикация, но объект к ней не привязан. Напишите район и число комнат, и я подберу варианты.",
  tg: "Ин нашрияи мост, вале объект ба он пайваст нест. Ноҳия ва шумораи ҳуҷраҳоро нависед, вариантҳоро интихоб мекунам.",
} as const;
/** Earlier wording, still recognised in dialogue history (the "answered once" checks below), never produced. */
const LEGACY_SHARE_LINES: readonly string[] = ["Эта публикация не наша. Если ищете жильё, напишите, что нужно.",
  "Ин нашрия аз мо нест. Агар хона лозим бошад, нависед, чӣ мекобед.",
  "Это наша публикация, но объект к ней не привязан. Напишите район и число комнат — подберу.",
  "Ин нашрияи мост, вале объект ба он пайваст нест. Минтақа ва шумораи ҳуҷраҳоро нависед — интихоб мекунам.",
  "Пришлите, пожалуйста, обычным фото — так агент его сохранит.", "Лутфан, ҳамчун акси оддӣ фиристед — агент онро нигоҳ медорад."];
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

/** The greeting the renderer opens a dialogue with (its `social.greet`); defined here so the attachment checks below can skip it
 * without importing the renderer. «Ассалому алайкум» is how the agency's operators open a Tajik chat. */
export const CUSTOMER_AGENT_GREETING = { ru: "Здравствуйте!", tg: "Ассалому алайкум!" } as const;
/** The one question for anything we cannot (or need not) read: never a word about the file failing to open. */
export const BUSINESS_QUESTION = {
  ru: "Что вас интересует: покупка или продажа недвижимости?",
  tg: "Шуморо чӣ лозим: харид ё фурӯши манзил?",
} as const;
/** A disappearing (one-time) photo or video cannot be kept by anybody: ask for an ordinary one. */
export const EPHEMERAL_PHOTO_LINE = {
  ru: "Пришлите, пожалуйста, обычным фото, так агент сможет его сохранить.",
  tg: "Бемалол ҳамчун акси оддӣ фиристед, то агент онро нигоҳ дорад.",
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
  return ATTACHMENT_QUESTIONS[kinds.length === 1 ? kinds[0] : "unknown"][language];
}
/** True when an earlier assistant turn of this dialogue already answered a forwarded publication with a fixed line
 * (the foreign-share line, or the generic "what do you want to know about this publication" the older build sent). */
export function customerAgentForeignShareAnswered(assistantTexts: readonly string[]): boolean {
  const lines = new Set([FOREIGN_SHARE_LINE.ru, FOREIGN_SHARE_LINE.tg, OWN_SHARE_UNLINKED_LINE.ru, OWN_SHARE_UNLINKED_LINE.tg, ATTACHMENT_QUESTIONS.share.ru, ATTACHMENT_QUESTIONS.share.tg,
    ...LEGACY_SHARE_LINES]);
  return assistantTexts.some(text => text.split(/\r?\n/).some(line => lines.has(line.trim())));
}
/** Every fixed line above: the repeat guard must see them as questions already asked, and the memory allow-list as renderer text. */
export function customerAgentAttachmentLines(): string[] {
  return [...[...Object.values(ATTACHMENT_QUESTIONS), ATTACHMENT_OBJECT_QUESTION, EPHEMERAL_PHOTO_LINE].flatMap(line => [line.ru, line.tg]), ...LEGACY_SHARE_LINES];
}

/** Old wording kept only for recognising history; never produced (the tone guard test skips these). */
export function customerAgentLegacyAttachmentLines(): readonly string[] { return LEGACY_SHARE_LINES; }

/** The LAST assistant turn was only this kind of fixed attachment question (business question, ephemeral request, object question):
 * asking it again would be a repeat, so the answer to a second file with the same nothing in it is silence. */
export function customerAgentAttachmentQuestionAsked(assistantTexts: readonly string[]): boolean {
  const last = assistantTexts.at(-1);
  if (!last) return false;
  const lines = new Set([BUSINESS_QUESTION.ru, BUSINESS_QUESTION.tg, EPHEMERAL_PHOTO_LINE.ru, EPHEMERAL_PHOTO_LINE.tg,
    ATTACHMENT_OBJECT_QUESTION.ru, ATTACHMENT_OBJECT_QUESTION.tg, ...LEGACY_SHARE_LINES.filter(line => /фото|акси/u.test(line))]);
  // The first answer of a dialogue opens with a greeting (08.11.2026): it is not part of what was asked.
  const parts = last.split(/\r?\n/).map(line => line.trim()).filter(line => line && line !== CUSTOMER_AGENT_GREETING.ru && line !== CUSTOMER_AGENT_GREETING.tg);
  return parts.length > 0 && parts.every(line => lines.has(line));
}
