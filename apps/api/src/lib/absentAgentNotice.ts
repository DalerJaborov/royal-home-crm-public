import { prisma } from "../db.js";
import { absenceKindOf } from "./agentAvailability.js";
import { deliverToConversation, findClientDeliveryTarget } from "./conversationDelivery.js";
import { sendPushToAgent } from "../push.js";

/**
 * КЛИЕНТ ВЕРНУЛСЯ, А ЕГО АГЕНТ ОТСУТСТВУЕТ — ОБЪЯСНЯЕМ ОБОИМ (владелец 09.09.2026).
 *
 * ЗАЧЕМ. Правило «нет объекта в работе + агент в отпуске = сразу другому» решает
 * задачу компании: вернувшемуся нужно физическое действие, и человек в отпуске его
 * не сделает. Но для КЛИЕНТА это выглядит иначе: он написал «своему» человеку, а
 * отвечает незнакомый. И для агента тоже: он выходит из отпуска и обнаруживает, что
 * его клиента увели, не сказав ни слова.
 *
 * Уважение к отношениям здесь проявляется не ожиданием, а двумя дешёвыми
 * сообщениями:
 *   1. клиенту — что его агент в отпуске и с ним свяжется коллега;
 *   2. прежнему агенту — что клиент вернулся и передан, чтобы он позвонил сам,
 *      когда выйдет.
 *
 * ПРОДАВЦУ С ОБЪЕКТОМ В РАБОТЕ текст другой: его никому не передают, и пугать его
 * «свяжется коллега» нельзя. Ему важно другое — что квартира продаётся всё это
 * время силами всей компании.
 *
 * Всё best-effort: клиент уже принят, лид распределён, и ни одно из этих сообщений
 * не имеет права сорвать приём заявки.
 */

export type AbsentNoticeKind =
  /** Клиента передали другому агенту. */
  | "handed-over"
  /** Клиент остался за своим агентом (продавец с объектом в работе). */
  | "kept"
  /** Покупатель остался за своим агентом (владелец 23.09.2026). Отдельный текст:
   *  до этого покупателю уходило «ваш объект всё это время в продаже». */
  | "kept-buyer";

export interface AbsentAgentNoticeInput {
  clientId: string;
  /** Агент, который отсутствует, — прежний владелец карточки. */
  absentAgentId: string;
  kind: AbsentNoticeKind;
}

/** Текст клиенту. Без слова «отпуск»/«больничный» по отдельности — клиенту незачем
 *  знать, болен человек или отдыхает; ему важно, что делать дальше. */
function clientText(kind: AbsentNoticeKind, agentName: string): string {
  if (kind === "handed-over") {
    return `Здравствуйте! ${agentName} сейчас в отъезде, поэтому с вами свяжется коллега из Royal Home — он уже в курсе вашего вопроса.`;
  }
  if (kind === "kept-buyer") {
    return `Здравствуйте! ${agentName} сейчас в отъезде и остаётся вашим агентом. Ваш запрос у нас записан, пишите сюда — мы ответим и подскажем по объектам.`;
  }
  return `Здравствуйте! ${agentName} сейчас в отъезде. Ваш объект всё это время в продаже: он размещён на сайте и в наших соцсетях, и его показывают все агенты Royal Home. Как только появятся новости, мы сразу напишем.`;
}

export async function noticeAbsentAgentReturn(input: AbsentAgentNoticeInput): Promise<void> {
  // Отсутствия уже нет (вышел, пока клиент писал) — объяснять нечего.
  if ((await absenceKindOf(input.absentAgentId)) === null) return;

  const [client, agent] = await Promise.all([
    prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
      select: { id: true, shortId: true, fullName: true },
    }),
    prisma.agent.findUnique({ where: { id: input.absentAgentId }, select: { fullName: true } }),
  ]);
  if (!client || !agent) return;

  const target = await findClientDeliveryTarget(client.id);
  if (target) {
    /**
     * Отправитель — бот, а не агент: это служебное объяснение от компании, и
     * записывать его как попытку связаться конкретного человека нельзя
     * (см. markAgentAttempt в lib/clientWorkStalled.ts — попытка засчитывается
     * только назначенному агенту и только за его собственное действие).
     */
    const res = await deliverToConversation(target, clientText(input.kind, agent.fullName), undefined, {
      sender: { kind: "bot" },
    });
    if (!res.ok) {
      console.error("[отсутствие] сообщение клиенту не ушло:", res.error);
    }
  }

  if (input.kind === "handed-over") {
    await sendPushToAgent(input.absentAgentId, {
      title: "↪️ Ваш клиент вернулся и передан",
      body: `${client.fullName} написал, пока вас нет. Клиент передан коллеге — свяжитесь с ним, когда выйдете.`,
      url: `/clients/${client.shortId}`,
      tag: `absent-handover-${client.id}`,
    });
  }
}
