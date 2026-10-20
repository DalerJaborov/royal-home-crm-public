import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { findClientDeliveryTarget, deliverToConversation } from "../lib/conversationDelivery.js";
import { createDealReviewAsk, deleteUnansweredDealReviewAsk } from "../lib/dealReviews.js";
import { isDealStillClosed } from "../lib/dealStillClosed.js";
import type { JobHandler } from "./registry.js";

/**
 * ВОПРОС «КАК ВСЁ ПРОШЛО» ЧЕРЕЗ 3 ДНЯ ПОСЛЕ ЗАКРЫТИЯ СДЕЛКИ (Пачка 11,
 * 11.09.2026, docs/gaps-audit-11-09.md).
 *
 * Ставится из routes/deals.ts вместе с deal-close-followup, но с отложенным
 * runAt (+3 суток) — то же задание очереди, не отдельный таймер в памяти.
 *
 * Спрашивает ОБЕИХ сторон, у кого нашёлся канал переписки: покупателя
 * (deal.client) и продавца объекта (property.sellerClientId), если он есть и
 * отличается от покупателя. Идемпотентно: createDealReviewAsk — ON CONFLICT DO
 * NOTHING по (dealId, clientId), повторный прогон второй раз не спросит.
 */
const schema = z.object({
  dealId: z.string(),
});

const REVIEW_QUESTION =
  "Здравствуйте! Прошло несколько дней после сделки — как всё прошло? Оцените нас от 1 до 5. " +
  "И если есть кому нас порекомендовать, оставьте, пожалуйста, номер телефона.";

async function askSide(dealId: string, clientId: string): Promise<void> {
  const target = await findClientDeliveryTarget(clientId);
  if (!target) return; // нет канала переписки — спросить негде, это не ошибка
  const channel = target.kind === "telegram" ? "telegram" : target.channel;
  const created = await createDealReviewAsk({ dealId, clientId, channel });
  if (!created) return;
  const res = await deliverToConversation(target, REVIEW_QUESTION, undefined, { sender: { kind: "bot" } });
  if (!res.ok) {
    /**
     * ОТКАЗ ИЗ-ЗА ОКНА ЗДЕСЬ ОЗНАЧАЕТ, ЧТО ОТЗЫВ ПОТЕРЯН НАВСЕГДА (12.09.2026).
     *
     * Вопрос уходит через трое суток после сделки, то есть окно Meta закрыто
     * почти всегда, а `createDealReviewAsk` уже пометил пару (сделка, клиент)
     * как спрошенную — повторной попытки не будет. Пишем это отдельной, ясной
     * строкой: раньше запись была неотличима от обычного сбоя сети, и по
     * журналу нельзя было понять, что целая функция не доставляет ничего.
     *
     * Правильное лечение — не повтор тем же текстом, а шаблон WhatsApp
     * (docs/post-viewing-survey-design-11-09.md, раздел 2А) или звонок.
     */
    if (res.code === "window_closed") {
      console.log(
        `[отзыв] клиент ${clientId}: окно переписки закрыто через 3 суток после сделки — ` +
          "вопрос об отзыве НЕ доставлен и повторяться не будет (нужен шаблон WhatsApp или звонок)"
      );
    } else {
      /**
       * ВРЕМЕННЫЙ ОТКАЗ (транспорт, канал, 5xx) — НЕ ПОТЕРЯ (аудит Codex 04.10, JOB-03).
       * Отметка «спрошено» уже стоит, и повтор задания увидел бы готовую пару и
       * вышел. Снимаем её (пока клиент не ответил) и бросаем ошибку: очередь
       * повторит по backoff, а onGiveUp запишет отказ в журнал, если не вышло совсем.
       */
      await deleteUnansweredDealReviewAsk({ dealId, clientId });
      throw new Error(`вопрос об отзыве не ушёл клиенту ${clientId}: ${res.error}`);
    }
  }
}

export const dealReviewAskJob: JobHandler<z.infer<typeof schema>> = {
  type: "deal-review-ask",
  schema,
  backoff: (attempt) => Math.min(2 ** attempt, 8) * 60_000,
  async run(payload) {
    const deal = await prisma.deal.findUnique({
      where: { id: payload.dealId },
      select: {
        id: true,
        clientId: true,
        stage: true,
        annulledAt: true,
        property: { select: { sellerClientId: true } },
      },
    });
    if (!deal) return; // сделку удалить нельзя, но на всякий случай — спрашивать не о чем
    // Аннулировали за три дня ожидания — спрашивать «как всё прошло» о сделке, которой
    // больше нет, нельзя; аннулирование задание очереди не отменяет (JOB-02).
    if (!isDealStillClosed(deal)) return;

    await askSide(deal.id, deal.clientId);
    if (deal.property.sellerClientId && deal.property.sellerClientId !== deal.clientId) {
      await askSide(deal.id, deal.property.sellerClientId);
    }
  },
  async onGiveUp(payload) {
    await logSystemError(
      "background-jobs",
      `Вопрос об отзыве по сделке ${payload.dealId} не отправлен после всех попыток`,
      { url: "/deals" }
    );
  },
};
