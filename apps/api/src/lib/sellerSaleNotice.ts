import { prisma } from "../db.js";
import { logTimeline } from "./timeline.js";
import { sendPushToAgent } from "../push.js";
import { recomputeSellerCardState } from "./sellerCardState.js";

/**
 * СТОРОНА ПРОДАВЦА ПРИ УСПЕШНОЙ СДЕЛКЕ (владелец 09.09.2026).
 *
 * ЧТО БЫЛО. Сделка закрывается на карточке ПОКУПАТЕЛЯ — так требует routes/deals.ts,
 * и требует правильно: без покупателя сделки нет. Но карточку ПРОДАВЦА после продажи
 * его квартиры не трогал никто. Он оставался активным, по нему шёл счётчик тишины, и
 * через три рабочих дня владелец получал «агент забросил клиента» — про агента,
 * который только что продал эту квартиру. Дальше светофор доводил карточку до
 * «Потерянных» со штрафом. Система наказывала за ту самую сделку, за которую компания
 * получила деньги.
 *
 * Здесь закрывается вся сторона продавца сразу:
 *   1. состояние карточки пересчитывается (lib/sellerCardState.ts) — и только если у
 *      продавца не осталось других объектов в работе, она уходит в «Завершённые
 *      сделки»: у человека может продаваться ещё две квартиры;
 *   2. в хронологию продавца пишется строка о продаже — иначе агент, принявший
 *      объект, не видит у себя ни слова о том, что его объект продан;
 *   3. интейкеру (кто завёл объект) уходит уведомление о продаже.
 *
 * Всё best-effort и после коммита сделки: сделка уже состоялась, и ни одна из этих
 * трёх вещей не имеет права её сорвать.
 */

export interface SellerSaleNoticeInput {
  propertyId: string;
  /** Кто закрыл сделку — им подписывается системная запись в хронологии продавца. */
  closedById: string;
  buyerName: string | null;
}

export async function notifySellerSideOfSale(input: SellerSaleNoticeInput): Promise<void> {
  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: {
      id: true,
      shortId: true,
      title: true,
      sellerClientId: true,
      intakeAgentId: true,
      currency: true,
      instagramUrl: true,
      soldAt: true,
    },
  });
  if (!property?.sellerClientId) return;

  const verdict = await recomputeSellerCardState({ sellerClientId: property.sellerClientId });
  if (verdict === null) return;

  const seller = await prisma.client.findFirst({
    where: { id: property.sellerClientId, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true, lastAgentId: true },
  });
  if (!seller) return;

  /**
   * Автор записи — тот, кто закрыл сделку. Interaction.agentId обязателен в схеме, а
   * карточка продавца к этому моменту уже могла остаться без назначенного агента
   * (уход в «Потерянные» его снимает), поэтому подставлять «агента продавца» нельзя.
   */
  const tail =
    verdict.next === "DEAL_CLOSED"
      ? "Карточка перешла в «Завершённые сделки»."
      : verdict.next === "KEEP"
        ? `У продавца ещё ${verdict.objectsInWork} объект(а) в работе — карточка остаётся активной.`
        : "";
  /**
   * ПОВТОР ЗАДАНИЯ НЕ ПИШЕТ ПРОДАЖУ ВТОРОЙ РАЗ (аудит Codex 04.10, JOB-04).
   * deal-close-followup бросает ошибку при отказе сайта и повторяется целиком, а
   * запись и пуш к тому времени уже ушли. Граница «та же продажа» — Property.soldAt:
   * запись, созданная не раньше него, относится к текущей продаже; после аннулирования
   * и новой продажи soldAt новый, и запись честно пишется заново.
   */
  const alreadyNoted = await prisma.interaction.findFirst({
    where: {
      clientId: seller.id,
      propertyId: property.id,
      type: "SYSTEM",
      notes: { startsWith: `Объект №${property.shortId} продан` },
      ...(property.soldAt ? { createdAt: { gte: property.soldAt } } : {}),
    },
    select: { id: true },
  });

  if (!alreadyNoted) {
    await prisma.interaction
      .create({
        data: {
          clientId: seller.id,
          agentId: input.closedById,
          propertyId: property.id,
          type: "SYSTEM",
          notes: `Объект №${property.shortId} продан${input.buyerName ? ` — покупатель ${input.buyerName}` : ""}. ${tail}`.trim(),
        },
      })
      .catch((err) => console.error("[продавец] запись о продаже:", err instanceof Error ? err.message : err));

    await notifyIntakeAgent(property, seller.shortId, seller.fullName).catch((err) =>
      console.error("[продавец] уведомление интейкеру:", err instanceof Error ? err.message : err)
    );
  }

  await taskToMarkSoldInInstagram(property).catch((err) =>
    console.error("[продавец] задача про пост Instagram:", err instanceof Error ? err.message : err)
  );
}

/**
 * ЗАДАЧА ВЛАДЕЛЬЦУ: ДОПИСАТЬ «ПРОДАНО» В ОПИСАНИЕ ПОСТА (владелец 09.09.2026).
 *
 * Направление правды — из CRM наружу: сделку закрывает агент, объект помечается
 * проданным на сайте автоматически. Но описание поста в Instagram правит ЧЕЛОВЕК
 * руками, и система про это ручное действие не узнает никогда.
 *
 * Без задачи получается расхождение, которое стоит звонков: объект продан в CRM и
 * активен в Instagram, и по нему продолжают звонить. Задача живёт обычным путём
 * (Interaction.nextAction — отдельной модели задач в CRM нет, см. lib/tasks.ts) и
 * снимается галочкой «выполнено».
 *
 * Поста нет — и задачи нет: у объекта «только в CRM» править нечего.
 */
async function taskToMarkSoldInInstagram(property: {
  id: string;
  shortId: number;
  title: string;
  instagramUrl: string | null;
}): Promise<void> {
  if (!property.instagramUrl?.trim()) return;

  // Тот же findFirst по DIRECTOR, что в changeClientAgent и clientLifecycle, но
  // БЕЗ orderBy — при двух активных директорах выбор был недетерминированным.
  // Здесь директор не подписывает чужое действие, а получает задачу, поэтому
  // fallback остаётся; убираем только случайность выбора (17.09.2026).
  const director = await prisma.agent.findFirst({
    where: { role: "DIRECTOR", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!director) return;

  const seller = await prisma.property.findUnique({
    where: { id: property.id },
    select: { sellerClientId: true },
  });
  if (!seller?.sellerClientId) return;

  // Дедуп: одна задача на объект, сколько бы раз ни пришёл повторный вызов.
  const already = await prisma.interaction.findFirst({
    where: { propertyId: property.id, nextAction: { contains: "продано» в описание поста" } },
    select: { id: true },
  });
  if (already) return;

  // SYSTEM, а не директор (П-10, 17.09.2026) — он ещё не открывал Instagram,
  // задача только заводится; subjectAgentId держит её в его списке дел.
  await logTimeline({
    clientId: seller.sellerClientId,
    actor: { kind: "system", source: "seller-sale-notice-instagram", subjectAgentId: director.id },
    type: "SYSTEM",
    propertyId: property.id,
    notes: `Объект №${property.shortId} продан — пост в Instagram остаётся активным до правки описания`,
    nextAction: `Дописать «продано» в описание поста Instagram по объекту №${property.shortId}`,
    nextActionDate: new Date(),
  });
}

/**
 * Интейкер (агент, принявший объект — Property.intakeAgentId, не денежная роль
 * с 11.09.2026) узнаёт о продаже своего объекта в момент сделки, а не из отчёта
 * в конце месяца. 0,5% «за приём объекта» отменены — уведомление больше не
 * называет сумму, только сам факт продажи.
 */
async function notifyIntakeAgent(
  property: { id: string; shortId: number; title: string; intakeAgentId: string | null; currency: string },
  sellerShortId: number,
  sellerName: string
): Promise<void> {
  if (!property.intakeAgentId) return;
  await sendPushToAgent(property.intakeAgentId, {
    title: "✅ Ваш объект продан",
    body: `${property.title} — продавец ${sellerName}.`,
    url: `/clients/${sellerShortId}`,
    tag: `intake-sold-${property.id}`,
  });
}
