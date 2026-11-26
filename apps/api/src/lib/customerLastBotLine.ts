/**
 * ПОСЛЕДНЯЯ РЕПЛИКА БОТА ИЛИ СОТРУДНИКА ДО ХОДА КЛИЕНТА — только для решения «ок / спасибо / пока → реакция»
 * (ai/ackTurnDoor.ts, 26.11.2026). Модели этот текст не уходит.
 *
 * Почему не память ядра (customerAgentVerifiedContext.turns): она строгая — берёт реплику бота только с квитанцией
 * провайдера и только строки, которые прошли фильтр «можно показать модели». Шаблонная фраза оператора («Спасибо, номер
 * получил, агент вам позвонит.») туда не попадала, и дверь считала, что «бот ещё не говорил» — «Ок» уходил оператору,
 * а тот писал «Ваша заявка у агента, он с вами свяжется.» (живой случай Instagram 26.11.2026).
 *
 * Источники, берём более свежий:
 *  - переписка BotConversation.messages — туда попадает и доставленный ответ ядра (customerDeliveryAdapters), и ответ
 *    сотрудника вручную;
 *  - последняя принятая к отправке часть ответа ядра (CustomerOutboxPart ACCEPTED) — на случай, если отражение в
 *    переписку ещё не записано.
 * Сбой чтения — null: тогда обычный ход (лишний ответ лучше потерянного).
 */
import { prisma } from "../db.js";
import { decodeCustomerOutboxPayload } from "./customerOutbox.js";
import { lastBotSpeech, type BotLineEntry } from "../ai/ackTurnDoor.js";

type Line = { text: string; at: number | null };

/** @param before момент прихода сообщения клиента (Date или миллисекунды): позже него реплики не берём. */
export async function readLastBotLine(conversationId: string, before: Date | number): Promise<Line | null> {
  const limit = typeof before === "number" ? before : before.getTime();
  const [native, parts] = await Promise.all([
    prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } }).catch(() => null),
    // Ответ — текст и до десятка фото объекта: берём с запасом, текст ищем среди них (полезная нагрузка зашифрована).
    prisma.customerOutboxPart.findMany({
      where: { conversationId, sourceKind: "BOT_TURN", status: "ACCEPTED", acceptedAt: { not: null, lte: new Date(limit) } },
      orderBy: [{ acceptedAt: "desc" }, { ordinal: "desc" }],
      select: { payloadVersion: true, payloadEncrypted: true, payloadHash: true, acceptedAt: true }, take: 16,
    }).catch(() => []),
  ]);
  // Переписка — той же функцией, что у остальных путей (вложения, ссылки, геометки, неотправленное — не слова).
  const fromNative: Line | null = lastBotSpeech(Array.isArray(native?.messages) ? native.messages as BotLineEntry[] : [], limit);
  let fromOutbox: Line | null = null;
  for (const part of parts) {
    if (!part.acceptedAt) continue;
    try {
      const payload = decodeCustomerOutboxPayload(part);
      if (payload.kind === "text" && payload.text.trim()) { fromOutbox = { text: payload.text, at: part.acceptedAt.getTime() }; break; }
    } catch { /* повреждённая часть — не источник */ }
  }
  if (fromNative && fromOutbox) return (fromOutbox.at ?? 0) > (fromNative.at ?? 0) ? fromOutbox : fromNative;
  return fromNative ?? fromOutbox;
}
