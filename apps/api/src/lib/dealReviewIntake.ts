import { prisma } from "../db.js";
import { normalizeDigits } from "./shared/phoneText.js";
import { parseDealReviewReply } from "./dealReviewParser.js";
import { findPendingDealReview, markDealReviewAnswered } from "./dealReviews.js";
import { recordScoreEvent } from "./scoreJournal.js";
import { createLeadFromChannel } from "../services/leads/intake.js";
import { logSystemError } from "./systemError.js";

/**
 * ПЕРЕХВАТ ОТВЕТА НА ВОПРОС ОБ ОТЗЫВЕ (Пачка 11, 11.09.2026).
 *
 * Вызывается в самом начале processMessengerTurn (messengers/conversation.ts),
 * ДО дебаунса и ДО модели: если у клиента висит неотвеченный DealReview, его
 * ближайшее сообщение — скорее всего ответ на вопрос бота, и лучше разобрать
 * его сразу же лёгким парсером (lib/dealReviewParser.ts), чем гонять через ИИ
 * или, того хуже, пытаться продать несуществующий объект человеку, который
 * просто поставил оценку.
 *
 * НЕ РАЗОБРАЛИ — ПРОПУСКАЕМ ДАЛЬШЕ. handled: false здесь означает «это
 * сообщение не про отзыв», а не «отзыв не принят» — разговор идёт обычным
 * ходом бота как ни в чём не бывало (вопрос остаётся висеть до следующего
 * сообщения или так и останется без ответа, это нормально).
 */
export interface DealReviewIntakeResult {
  handled: boolean;
  /** Что ответить клиенту — заполнено только при handled: true. */
  reply?: string;
}

const THANKS_NO_REFERRAL = "Спасибо за оценку! Рады были помочь.";
const THANKS_WITH_REFERRAL =
  "Спасибо за оценку и за рекомендацию! Обязательно свяжемся с человеком, которого вы указали.";

export async function tryHandleDealReviewReply(clientId: string, text: string): Promise<DealReviewIntakeResult> {
  if (!text) return { handled: false };
  const pending = await findPendingDealReview(clientId);
  if (!pending) return { handled: false };

  const parsed = parseDealReviewReply(text);
  if (!parsed) return { handled: false };

  const referralPhone = parsed.referralPhone
    ? normalizeDigits(parsed.referralPhone.replace(/\D/g, ""))
    : null;

  await markDealReviewAnswered({
    id: pending.id,
    rating: parsed.rating,
    text,
    referralPhone,
  });

  const [deal, reviewer] = await Promise.all([
    prisma.deal.findUnique({ where: { id: pending.dealId }, select: { id: true, agentId: true } }),
    prisma.client.findUnique({ where: { id: clientId }, select: { fullName: true } }),
  ]);

  // Сделку удалить нельзя (FK) — значит agentId всегда есть, но на всякий
  // случай не роняем сам ответ клиенту, если сделки почему-то не нашлось.
  if (deal) {
    await prisma.interaction
      .create({
        data: {
          clientId,
          agentId: deal.agentId,
          type: "SYSTEM",
          notes:
            `Отзыв после сделки: оценка ${parsed.rating}/5` +
            (referralPhone ? `, оставлена рекомендация ${referralPhone}` : ""),
          outcome: parsed.rating >= 4 ? "POSITIVE" : parsed.rating <= 2 ? "NEGATIVE" : "NEUTRAL",
        },
      })
      .catch((err) => console.error("[отзыв] запись в хронологию:", err instanceof Error ? err.message : err));
  }

  // ЛИД ПО РЕКОМЕНДАЦИИ — ДО БАЛЛОВ И ОТВЕТА КЛИЕНТУ (CRM-REVIEW01, аудит 04.10.2026).
  // Отзыв уже помечен отвеченным, и повторная доставка его не найдёт: если лид не
  // создался, нельзя ни обещать «свяжемся», ни начислять агенту баллы за рекомендацию,
  // которую CRM не приняла. Сбой пишем в журнал вместе с номером, чтобы его завели руками.
  let referralAccepted = false;
  if (referralPhone) {
    // Рекомендованный номер — новый лид, привязанный к агенту сделки (п.3 задания):
    // createLeadFromChannel сам разберётся, если номер уже есть в базе (существующий
    // клиент, дубль) — тогда просто ничего не сломает, новой карточки не будет.
    try {
      await createLeadFromChannel({
        fullName: `Рекомендация от ${reviewer?.fullName ?? "клиента"}`,
        phone: referralPhone,
        source: "REFERRAL",
        requestedAgentId: deal?.agentId,
        requestedAgentNote: `Рекомендован клиентом после сделки ${pending.dealId}`,
      });
      referralAccepted = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[отзыв] лид по рекомендации не создан:", reason);
      void logSystemError(
        "api",
        `Рекомендация после сделки ${pending.dealId} не принята: лид по номеру ${referralPhone} не создан (${reason}). ` +
          `Номер сохранён в отзыве, заведите обращение вручную.`
      );
    }
  }

  if (deal?.agentId) {
    if (parsed.rating >= 4) {
      void recordScoreEvent({
        agentId: deal.agentId,
        kind: "review_received",
        delta: 2,
        reason: `Получен отзыв ${parsed.rating}/5 после сделки`,
        sourceId: `review-${pending.id}`,
      });
    }
    if (referralAccepted) {
      void recordScoreEvent({
        agentId: deal.agentId,
        kind: "review_referral",
        delta: 3,
        reason: "Клиент оставил рекомендацию после сделки",
        sourceId: `review-referral-${pending.id}`,
      });
    }
  }

  return { handled: true, reply: referralAccepted ? THANKS_WITH_REFERRAL : THANKS_NO_REFERRAL };
}
