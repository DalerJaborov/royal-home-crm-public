import type { PropertyStatus } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logSystemAudit } from "./audit.js";
import { isPipelineStatus } from "./propertyPipeline.js";
import { sendPushToAgent } from "../push.js";
import { syncPropertiesToSite } from "./siteSync.js";
import { logSystemError } from "./systemError.js";
import { addBusinessDays } from "./businessDays.js";
import { closeWorkAfterLeavingSale } from "./propertyLeftSale.js";

/**
 * Статус объекта ставится сам — вторая половина решения владельца 08.08.2026
 * («хочу, чтобы агенты меньше меняли всё руками») после автостатусов клиента
 * (см. lib/clientAutoStatus.ts).
 *
 * ЧЕМ ОБЪЕКТ ОТЛИЧАЕТСЯ ОТ КЛИЕНТА. У клиента статус — это оценка отношений, и
 * выводить её приходится из косвенных признаков (тишина, недозвоны). У объекта
 * же статус — это факт, который система знает точно: по объекту идёт сделка или
 * не идёт, продан он или нет. Поэтому здесь нет ни одного порога в днях: гадать
 * не о чем, всё решают сделки.
 *
 * ЗАЧЕМ ТОГДА АВТОМАТИКА, ЕСЛИ СДЕЛКИ И ТАК ДВИГАЮТ СТАТУС. Двигают — но только
 * пока событие проходит штатным путём (POST /deals, PATCH /deals/:id). Мимо него
 * статус разъезжается с реальностью и остаётся так навсегда: объект висит в
 * резерве, сделки по нему давно нет, и он не показывается ни в подборе, ни на
 * сайте — а заметить это можно, только открыв карточку глазами. Разъехаться
 * успевали: удаление сделки, ручная правка статуса до появления проверок,
 * перенос старых объявлений, сбой на середине транзакции.
 *
 * ИСКЛЮЧЕНИЕ (найдено код-ревью 13.08.2026): резерв БЕЗ сделки — с 13.08.2026 это
 * не всегда «разъехалось». «Договор» в «Итоге показа» (routes/me.ts) ставит объект
 * в RESERVED заранее, до оформления Deal — так и задумано, на срок
 * Settings.dealReservationBusinessDays (тот же таймер, что у резерва на сделке,
 * lib/dealReservation.ts). Снимать такую бронь раньше срока — откатывать саму
 * фичу автоброни. Поэтому reservation-gone теперь ждёт истечения того же срока,
 * а не снимает резерв при первой же ночной сверке.
 *
 * ПРАВИЛА (по убыванию силы):
 *   Продано          — по объекту есть завершённая сделка;
 *   Забронировано    — по объекту идёт живая сделка;
 *   В продаже        — резерв держится, а живой сделки нет;
 *   Снято с продажи  — собственник помечен человеком как «Потерянный»
 *                      (светофор неактивных — не человек, см. sellerLostByHuman).
 *
 * ЧЕГО АВТОМАТИКА НЕ ДЕЛАЕТ.
 * — Не трогает конвейер подготовки (проверка → фото → видео → монтаж): там
 *   объект двигают люди и одобрения материалов, и «умный» перевод спрятал бы
 *   ровно ту проблему, ради которой конвейер заводился (см. propertyPipeline.ts).
 * — Не поднимает объект из «Снято с продажи» и не отменяет «Продано»: вернуть
 *   объект в продажу — решение человека, у которого есть причина.
 * — Не снимает с продажи по молчанию или простою. Отсутствие показов — повод
 *   поговорить о цене, а не убрать объект с сайта; для этого есть подсказки на
 *   дашборде, и превращать их в необратимое действие нельзя.
 */

/** Почему статус переехал — идёт в историю объекта и в текст пуша. */
export type PropertyStatusReason =
  | "deal-completed"
  | "deal-active"
  | "reservation-gone"
  | "seller-lost";

export interface PropertyStatusFacts {
  /** По объекту есть завершённая сделка. */
  dealCompleted: boolean;
  /** По объекту идёт сделка, которая ещё не завершена и не отменена. */
  dealActive: boolean;
  /** Собственник, приведший объект, помечен ЧЕЛОВЕКОМ как «Потерянный» (не светофором). */
  sellerLost: boolean;
  /** RESERVED без активной сделки держится дольше положенного срока (или резерва
   *  вовсе не было, reservedAt=null) — только тогда reservation-gone имеет право
   *  сработать. Не относится к другим статусам — там факт не смотрится вовсе. */
  reservationExpired: boolean;
}

export interface PropertyStatusDecision {
  next: PropertyStatus;
  reason: PropertyStatusReason;
}

/**
 * Куда должен переехать статус объекта. null — оставить как есть.
 *
 * Чистая функция без обращений к базе — по той же причине, что и у клиента:
 * сочетаний фактов немного, и каждое должно быть проверено тестом, а не
 * рассуждением.
 */
export function decidePropertyStatus(
  status: PropertyStatus,
  facts: PropertyStatusFacts,
): PropertyStatusDecision | null {
  // Объект ещё готовится — конвейер ведут люди.
  if (isPipelineStatus(status)) return null;
  // Финальные состояния: из них выводит только человек.
  if (status === "SOLD" || status === "WITHDRAWN") return null;

  const decision = ((): PropertyStatusDecision | null => {
    if (facts.dealCompleted) return { next: "SOLD", reason: "deal-completed" };
    if (facts.dealActive) return { next: "RESERVED", reason: "deal-active" };
    if (status === "RESERVED" && facts.reservationExpired)
      return { next: "AVAILABLE", reason: "reservation-gone" };
    // Собственник отказался работать — продавать больше нечего. Проверяется
    // последним: пока по объекту идёт живая сделка, снимать его нельзя, чем бы
    // ни закончились отношения с собственником.
    if (facts.sellerLost) return { next: "WITHDRAWN", reason: "seller-lost" };
    return null;
  })();

  return decision && decision.next !== status ? decision : null;
}

/** Собирает факты по объекту — три запроса, независимо от размера истории.
 *  `reservedAt` — с самого Property (вызывающий уже прочитал его вместе с
 *  остальными полями), не пересчитывается здесь второй раз. */
export async function collectPropertyFacts(
  propertyId: string,
  sellerClientId: string | null,
  reservedAt: Date | null = null,
  now: Date = new Date(),
): Promise<PropertyStatusFacts> {
  const [deals, seller, settings] = await Promise.all([
    // Потолок обязателен: у объекта, который переоткрывали, сделок бывает много,
    // а для ответа хватает самих стадий.
    prisma.deal.findMany({
      where: { propertyId },
      select: { stage: true },
      take: 50,
    }),
    // sellerClientId хранится строкой без внешнего ключа (см. схему), поэтому
    // клиента может уже не быть — findFirst, а не findUnique с уверенностью.
    sellerClientId
      ? prisma.client.findFirst({
          where: { id: sellerClientId, deletedAt: null },
          select: { id: true, status: true, kind: true, lostAt: true },
        })
      : Promise.resolve(null),
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { dealReservationBusinessDays: true },
    }),
  ]);

  // Без reservedAt (бронь неизвестного возраста — теоретически не должно
  // случаться у RESERVED, но лучше отпустить сразу, чем зависнуть навечно) или
  // с истёкшим сроком — тот же расчёт, что у lib/dealReservation.ts, чтобы два
  // крона не спорили о том, когда бронь считается просроченной.
  const reservationDays = settings?.dealReservationBusinessDays ?? 3;
  const reservationExpired =
    !reservedAt || addBusinessDays(reservedAt, reservationDays) <= now;

  return {
    dealCompleted: deals.some((d) => d.stage === "COMPLETED"),
    dealActive: deals.some(
      (d) => d.stage !== "COMPLETED" && d.stage !== "CANCELLED",
    ),
    // Только SELLER: у объекта, заведённого из обращения покупателя (так тоже
    // бывает — агент завёл карточку по ходу разговора), «Потерянный» означает
    // потерянного покупателя, а не отказ собственника.
    sellerLost:
      seller?.kind === "SELLER" &&
      seller.status === "LOST" &&
      (await sellerLostByHuman(seller.id, seller.lostAt)),
    reservationExpired,
  };
}

/**
 * Механизмы, переводящие клиента в «Потерянные» без человека. Их LOST — не отказ
 * собственника, и снимать по нему объекты с продажи нельзя.
 */
export const AUTOMATIC_LOST_SOURCES = ["lost.promote"] as const;

/**
 * ОТКАЗ СОБСТВЕННИКА — ТОЛЬКО ОТ ЧЕЛОВЕКА (живая жалоба 23.09.2026). Светофор
 * неактивных сам переводил продавца в «Потерянные» по исчерпанным попыткам
 * дозвона, ночная сверка читала это как «собственник отказался от работы с
 * нами», снимала его объекты с продажи и с сайта и писала агенту неправду.
 * Собственник при этом работал с агентом. Кто перевёл в LOST, видно по записи
 * CLIENT_AGENT_CHANGE того же момента (lib/changeClientAgent.ts пишет её
 * внутри той же транзакции). Нет записи — ручной перевод на карточке (PATCH
 * status=LOST), это решение человека.
 */
async function sellerLostByHuman(
  clientId: string,
  lostAt: Date | null,
): Promise<boolean> {
  const since = lostAt ? new Date(lostAt.getTime() - 60_000) : undefined;
  const last = await prisma.auditLog.findFirst({
    where: {
      entityType: "Client",
      entityId: clientId,
      action: "CLIENT_AGENT_CHANGE",
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { meta: true },
  });
  const source = (last?.meta as { source?: unknown } | null)?.source;
  return !(
    typeof source === "string" &&
    (AUTOMATIC_LOST_SOURCES as readonly string[]).includes(source)
  );
}

/** Подписи для пуша — слово в слово те же, что видит человек в карточке
 *  (apps/web/src/lib/format.ts, PROPERTY_STATUS_LABELS). */
const STATUS_LABEL: Record<PropertyStatus, string> = {
  PENDING_REVIEW: "На проверке",
  AWAITING_PHOTOS: "Ждём фото",
  AWAITING_VIDEO: "Ждём видео",
  EDITING: "На монтаже",
  AVAILABLE: "В продаже",
  RESERVED: "Резерв · задаток",
  SOLD: "Продано",
  WITHDRAWN: "Снято с продажи",
};

/** Те же подписи для ИИ-помощника (превью смены статуса): одно место, как в карточке. */
export const PROPERTY_STATUS_LABEL_RU: Readonly<Record<PropertyStatus, string>> = STATUS_LABEL;

const REASON_TEXT: Record<PropertyStatusReason, string> = {
  "deal-completed": "сделка завершена",
  "deal-active": "по объекту идёт сделка",
  "reservation-gone": "сделки по объекту больше нет",
  "seller-lost": "собственник отказался от работы с нами",
};

/**
 * Пересчитать статус одного объекта и записать, если он изменился.
 * Возвращает новый статус или null, если ничего не поменялось.
 */
export async function refreshPropertyStatus(
  propertyId: string,
): Promise<PropertyStatus | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      shortId: true,
      title: true,
      status: true,
      price: true,
      soldAt: true,
      deletedAt: true,
      sellerClientId: true,
      reservedAt: true,
      publishedOnSite: true,
      intakeAgentId: true,
      assignedAgentId: true,
      createdById: true,
    },
  });
  // Объект в Корзине не участвует ни в подборе, ни в отчётах — двигать его
  // статус означало бы менять то, что человек уже убрал с глаз.
  if (!property || property.deletedAt) return null;

  const facts = await collectPropertyFacts(
    property.id,
    property.sellerClientId,
    property.reservedAt,
  );
  const decision = decidePropertyStatus(property.status, facts);
  if (!decision) return null;

  const { next, reason } = decision;
  const from = property.status;
  // Условие по текущему статусу внутри updateMany — защита от гонки со штатным
  // путём: пока мы считали факты, сделку могли закрыть, и переписывать её
  // результат своим устаревшим решением нельзя.
  const changed = await prisma.property.updateMany({
    where: { id: property.id, status: from },
    data: {
      status: next,
      stageEnteredAt: new Date(),
      // Резерв снят — таймер «3 рабочих дня» больше не о чем считать.
      ...(next !== "RESERVED"
        ? { reservedAt: null, reservedForClientId: null }
        : {}),
      // Цена продажи — снимок на момент сделки, как в PATCH /deals/:id. Дважды
      // не переписываем: у объекта, уже помеченного проданным, она своя.
      ...(next === "SOLD" && !property.soldAt
        ? { soldAt: new Date(), soldPrice: property.price }
        : {}),
    },
  });
  if (changed.count !== 1) return null;

  logSystemAudit("PROPERTY_STATUS_CHANGED", "Property", property.id, {
    was: from,
    becomes: next,
    reason,
    auto: true,
  });

  // Пуш ответственному — тот же порядок, что и у остальных уведомлений
  // конвейера: интейкер → риелтор → создатель карточки. Молча снимать объект с
  // продажи нельзя: это тот случай, когда человек обязан узнать сразу.
  const responsibleId =
    property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
  if (responsibleId) {
    void sendPushToAgent(responsibleId, {
      title: `🏠 Статус объекта: ${STATUS_LABEL[next]}`,
      body: `${property.title} — ${REASON_TEXT[reason]}`,
      url: `/properties/${property.shortId}`,
      tag: `property-auto-status-${property.id}`,
    }).catch((err) =>
      console.error(
        "[push] автостатус объекта:",
        err instanceof Error ? err.message : err,
      ),
    );
  }

  // Посты, повторы, место монтажёра и будущие показы — как при ручной смене статуса.
  if (next === "SOLD") closeWorkAfterLeavingSale(property.id, "sold");
  else if (next === "WITHDRAWN") closeWorkAfterLeavingSale(property.id, "withdrawn");
  else if (next === "RESERVED") closeWorkAfterLeavingSale(property.id, "reserved");

  await syncStatusToSite(property, next);
  return next;
}

/**
 * Сайт обязан узнать о смене — иначе объявление на royalhome.tj остаётся
 * висеть в продаже после того, как CRM объект уже продала или сняла. Best-effort
 * с записью в «Здоровье системы», как и в PATCH /properties/:id: недоступный
 * сайт не повод оставлять статус в CRM неверным.
 */
async function syncStatusToSite(
  property: { id: string; shortId: number; publishedOnSite: boolean },
  next: PropertyStatus,
): Promise<void> {
  if (!property.publishedOnSite) return;
  // Обратного перехода здесь не бывает: из «Продано» и «Снято» автоматика не
  // выводит (см. decidePropertyStatus), поэтому «unsold» в этом списке нет.
  const action =
    next === "SOLD" ? "sold" : next === "WITHDRAWN" ? "unpublish" : null;
  if (!action) return;

  const withRelations = await prisma.property.findUnique({
    where: { id: property.id },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  if (!withRelations) return;

  try {
    const result = await syncPropertiesToSite([withRelations], action);
    const problem = !result.ok
      ? result.error
      : result.results.find((r) => !r.ok)?.error;
    if (!problem) {
      // Объявления на сайте больше нет — отметка обязана это отражать, иначе
      // карточка продолжает считаться опубликованной, а кнопка «Опубликовать»
      // не показывается тому, кто захочет вернуть объект в продажу.
      if (action === "unpublish") {
        await prisma.property.update({
          where: { id: property.id },
          data: { publishedOnSite: false },
        });
      }
      return;
    }
    void logSystemError(
      "site-sync",
      `Автостатус объекта ${property.id} не дошёл до сайта: ${problem}`,
      {
        url: `/properties/${property.shortId}`,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logSystemError(
      "site-sync",
      `Автостатус объекта ${property.id} — ошибка синхронизации: ${message}`,
      {
        url: `/properties/${property.shortId}`,
      },
    );
  }
}

/**
 * Ночная сверка: объекты, чей статус разъехался со сделками.
 *
 * Выбираем только то, что вообще может разъехаться — «В продаже» и
 * «Забронирован». Конвейер, проданные и снятые автоматика не трогает, и тащить
 * их из базы незачем.
 */
export async function refreshPropertyStatusesByTime(): Promise<{
  checked: number;
  changed: number;
}> {
  const candidates = await prisma.property.findMany({
    where: { deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
    select: { id: true },
    orderBy: { stageEnteredAt: "asc" },
    take: 500,
  });

  let changed = 0;
  for (const property of candidates) {
    const next = await refreshPropertyStatus(property.id);
    if (next) changed++;
  }
  return { checked: candidates.length, changed };
}

/**
 * Объекты, приведённые одним собственником, — точка входа для события «продавца
 * пометили Потерянным». Отдельная функция, а не выборка на месте вызова: правило
 * «какие объекты считаются принадлежащими этому продавцу» должно жить рядом с
 * правилами, которые на нём основаны.
 */
export async function refreshPropertiesOfSeller(
  clientId: string,
): Promise<number> {
  const properties = await prisma.property.findMany({
    where: {
      sellerClientId: clientId,
      deletedAt: null,
      status: { in: ["AVAILABLE", "RESERVED"] },
    },
    select: { id: true },
    take: 100,
  });

  let changed = 0;
  for (const property of properties) {
    const next = await refreshPropertyStatus(property.id);
    if (next) changed++;
  }
  return changed;
}
