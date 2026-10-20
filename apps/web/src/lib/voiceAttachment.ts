import type { MessageAttachment } from "../types";

/**
 * Есть ли среди вложений голосовое.
 *
 * ЗАЧЕМ. Текст расшифровки НЕ показывается агенту и никому в CRM — только сам
 * звук (решение владельца 16.08.2026, после случая, когда тихая запись дала
 * Gemini повод сочинить целую фразу, а она легла в переписку как будто агент
 * это сказал). Расшифровка при этом никуда не делась: она остаётся в
 * `ConversationMessage.content` в базе — боту она нужна как память о том, что
 * уже проговорено (см. apps/api/src/lib/conversationDelivery.ts), а людям
 * должно хватать самой записи.
 *
 * По этому признаку решаем, скрывать ли текст: ClientChatPanel.tsx,
 * Messages.tsx и MessageQuote.tsx (превью цитаты) используют его одинаково.
 */
export function hasVoiceAttachment(attachments?: MessageAttachment[]): boolean {
  return !!attachments?.some((a) => a.kind === "audio");
}
