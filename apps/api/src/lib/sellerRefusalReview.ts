import { prisma } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { recomputeSellerCardState } from "./sellerCardState.js";
import { logTimeline } from "./timeline.js";

/**
 * ОТКАЗ ПРОДАВЦА, ОФОРМЛЕННЫЙ ЧЕРЕЗ СНЯТИЕ ОБЪЕКТА (владелец 09.09.2026).
 *
 * ЧТО ЭТО ЧИНИТ. Отдельной кнопки «закрыть сделку безуспешно» у продавца нет и не
 * будет: мы либо принимаем его объект, либо нет. Отказ оформляется заявкой на
 * удаление объекта с причиной — механизм существовал, но делал только половину дела:
 *
 *   1. СЧЁТЧИК ТИШИНЫ НЕ ОСТАНАВЛИВАЛСЯ. Агент честно оформлял отказ, объект уходил
 *      в Корзину, а карточка продавца оставалась активной — и через три рабочих дня
 *      владелец получал «агент забросил клиента» про человека, который всё сделал
 *      правильно. Единственный путь снять объект проходил через ложное обвинение.
 *
 *   2. ПРИЧИНА «ПРОДАН В ОБХОД АГЕНТСТВА» НИКУДА НЕ УХОДИЛА. Это главный
 *      автоматический вход в проверку СБ, и он был потерян вместе со всплывающими
 *      окнами: раньше отказ с такой причиной оформлял агент через форму, форму
 *      убрали, а ИИ отказы оформлять не умеет. Схема (Client.securityReview) прямо
 *      описывает этот сценарий, но включать его стало некому.
 *
 * ПОЧЕМУ СБ ВКЛЮЧАЕТСЯ НЕЗАВИСИМО ОТ ТОГО, КТО НАЖАЛ. Всё, что агент пишет о себе
 * сам, — это его слово о себе. Агент, уводящий сделку, закроет карточку красиво и с
 * правильной причиной. Поэтому «продан в обход» уходит в проверку всегда, а не по
 * усмотрению того, кто одобряет заявку.
 */

/** Причины снятия объекта, которые означают «сделка прошла мимо компании». */
const SECURITY_REVIEW_REASONS: ReadonlySet<string> = new Set(["SOLD_ELSEWHERE"]);

export interface SellerRefusalInput {
  propertyId: string;
  /** Код причины из PROPERTY_DELETE_REQUEST_REASONS. */
  reason: string;
  /** Комментарий агента. Для «продан в обход» обязателен — там названо агентство. */
  comment?: string | null;
  /** Кто просил снять объект — им подписывается системная запись. */
  requestedById: string;
}

/**
 * Вызывается ПОСЛЕ того, как объект уже ушёл в Корзину. Best-effort: удаление
 * состоялось, и ни пересчёт состояния, ни эскалация не имеют права его отменить.
 */
export async function applySellerRefusal(input: SellerRefusalInput): Promise<void> {
  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: { id: true, shortId: true, title: true, sellerClientId: true },
  });
  if (!property?.sellerClientId) return;

  const seller = await prisma.client.findFirst({
    where: { id: property.sellerClientId, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true, securityReview: true },
  });
  if (!seller) return;

  // Порядок важен: СБ включаем ДО пересчёта, потому что пересчёт может снять с
  // карточки агента (уход в «Потерянные»), а в записи для СБ он должен остаться.
  if (SECURITY_REVIEW_REASONS.has(input.reason)) {
    await escalateToSecurity(property, seller, input).catch((err) =>
      console.error("[отказ] эскалация в СБ:", err instanceof Error ? err.message : err)
    );
  }

  await recomputeSellerCardState({ sellerClientId: seller.id, lostReason: input.reason });
}

async function escalateToSecurity(
  property: { id: string; shortId: number; title: string },
  seller: { id: string; shortId: number; fullName: string; assignedAgentId: string | null; securityReview: string | null },
  input: SellerRefusalInput
): Promise<void> {
  // Тот же приём, что в sellerPropertyMissingAntifraud: updateMany с условием
  // securityReview: null — если проверка уже идёт, второй раз её не заводим.
  const started = await prisma.client.updateMany({
    where: { id: seller.id, securityReview: null },
    data: { securityReview: "PENDING" },
  });

  const agency = input.comment?.trim();
  const note = `Объект №${property.shortId} снят с продажи: продан в обход агентства${agency ? ` — ${agency}` : ""}. Карточка передана в СБ.`;

  if (seller.assignedAgentId) {
    // requestedById — реальный человек, подавший заявку на снятие объекта (kind agent).
    await logTimeline({
      clientId: seller.id,
      actor: { kind: "agent", agentId: input.requestedById },
      type: "SYSTEM",
      notes: note,
    });
  }

  if (started.count === 0) return; // проверка уже шла — второй раз владельца не будим

  void enqueueDirectorAlert({
    title: "🚩 Сделка прошла мимо агентства",
    body: `${seller.fullName}: объект «${property.title}» снят с продажи${agency ? `, названо агентство: ${agency}` : ""}`,
    url: `/clients/${seller.shortId}`,
    tag: `sold-elsewhere-${property.id}`,
    recipientPermission: "clients.assign",
  });
}
