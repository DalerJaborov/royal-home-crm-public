import { z } from "zod";

/** Transport metadata, not a claim that the model saw/listened to a file.
 * Derived only from the original authenticated DM envelope. No URL, caption,
 * phone, consent or executable instructions enter this value. */
export const customerAgentAttachmentInputSchema = z.object({
  kinds: z.array(z.enum(["image", "audio", "video", "document", "share", "link", "unknown"])).min(1).max(16),
}).strict();
export type CustomerAgentAttachmentInput = z.infer<typeof customerAgentAttachmentInputSchema>;

export function customerAgentAttachmentQuestion(input: CustomerAgentAttachmentInput, language: "ru" | "tg", hasProperty: boolean): string {
  if (hasProperty) return language === "tg" ? "Дар бораи ин объект чиро донистан мехоҳед?" : "Что хотите узнать об этом объекте?";
  const kinds = [...new Set(input.kinds)];
  const kind = kinds.length === 1 ? kinds[0] : "unknown";
  const questions = {
    share: { ru: "Что хотите узнать по этой публикации?", tg: "Дар бораи ин нашрия чиро донистан мехоҳед?" },
    link: { ru: "Что хотите узнать по этой ссылке?", tg: "Дар бораи ин пайванд чиро донистан мехоҳед?" },
    image: { ru: "Получил фото, но его содержимое мне сейчас недоступно. Что вы хотели уточнить?", tg: "Аксро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Чиро пурсидан мехостед?" },
    audio: { ru: "Получил голосовое, но его содержимое мне сейчас недоступно. Можете написать ваш вопрос текстом?", tg: "Паёми овозиро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Метавонед саволатонро бо матн нависед?" },
    video: { ru: "Получил видео, но его содержимое мне сейчас недоступно. Что вы хотели узнать?", tg: "Видеоро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Чиро донистан мехостед?" },
    document: { ru: "Получил документ, но его содержимое мне сейчас недоступно. Какой вопрос вы хотели обсудить?", tg: "Ҳуҷҷатро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Кадом саволро муҳокима кардан мехостед?" },
    unknown: { ru: "Получил вложение, но его содержимое мне сейчас недоступно. Что вы хотели уточнить?", tg: "Замимаро гирифтам, аммо муҳтавояш ҳоло ба ман дастрас нест. Чиро пурсидан мехостед?" },
  };
  return questions[kind][language];
}
