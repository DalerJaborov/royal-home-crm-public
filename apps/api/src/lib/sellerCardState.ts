import { prisma, type TxClient } from "../db.js";

/**
 * СОСТОЯНИЕ КАРТОЧКИ ПРОДАВЦА НЕ ВЫБИРАЕТСЯ, А ПЕРЕСЧИТЫВАЕТСЯ (владелец 09.09.2026,
 * docs/put-prodavca.html §14).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Одно и то же правило нужно в трёх местах: сделка завершена
 * (routes/deals.ts), объект снят с продажи и объект удалён (routes/properties/
 * deleteRequests.ts). Три копии одного правила в этом проекте уже расходились — см.
 * шапку services/leads/selection.ts про два разошедшихся тай-брейка. Поэтому правило
 * живёт здесь одной функцией, а вызывающие только сообщают ей повод.
 *
 * ПОРЯДОК ПРОВЕРОК — И ЭТО ГЛАВНОЕ В ФАЙЛЕ:
 *
 *   1. Остались объекты В РАБОТЕ → карточку не трогаем, продавец живой клиент.
 *      «В работе» = всё, кроме «Продано» и «Снято с продажи»: объект в конвейере
 *      (на одобрении, у монтажёра) — это тоже работа, за которую агент уже съездил
 *      и снял. Продажа ПЕРВОЙ из трёх квартир карточку не закрывает: у человека
 *      продаются ещё две.
 *   2. Объектов в работе не осталось, но была хоть одна ЗАВЕРШЁННАЯ сделка →
 *      «Завершённые сделки». Успех важнее отказа: продавец, продавший у нас одну
 *      квартиру и снявший с продажи вторую, — не «потерянный». Решать по последнему
 *      действию значило бы записать в потери человека, принёсшего компании деньги.
 *   3. Ни того, ни другого → «Потерянные».
 *
 * ПОРЯДОК ИМЕННО ТАКОЙ, И ЭТО НЕ ПРИДИРКА. Первая версия ставила проверку сделки
 * первой — и закрывала карточку сразу после продажи одной из трёх квартир, вопреки
 * прямому решению владельца («карточка остаётся, уходит только объект»). Поймано
 * тестом «продан ОДИН объект из трёх».
 *
 * СЧЁТЧИК ТИШИНЫ ОСТАНАВЛИВАЕТСЯ ВМЕСТЕ С ЭТИМ (lastAgentAttemptAt = сейчас). После
 * продажи или оформленного отказа агент законно может не звонить этому человеку
 * несколько дней, и тревога «агент забросил клиента» по нему — ложная. Ровно из-за
 * её отсутствия система наказывала агента за проданную им же квартиру.
 */

/** Статусы объекта, при которых работа по нему ещё идёт. */
export const IN_WORK_STATUSES = [
  "PENDING_REVIEW",
  "AWAITING_PHOTOS",
  "AWAITING_VIDEO",
  "EDITING",
  "AVAILABLE",
  "RESERVED",
] as const;

export type SellerCardOutcome =
  /** Есть завершённая сделка — карточка уходит в «Завершённые сделки». */
  | { next: "DEAL_CLOSED" }
  /** Объектов в работе не осталось и сделок не было — «Потерянные». */
  | { next: "LOST"; reason: string | null }
  /** Работа продолжается — карточку не трогаем. */
  | { next: "KEEP"; objectsInWork: number };

type Db = Pick<TxClient, "client" | "property" | "deal" | "$queryRaw">;

export interface SellerCardInput {
  /** Карточка продавца. Строка без внешнего ключа (Property.sellerClientId), поэтому
   *  клиента может уже не быть — это не ошибка. */
  sellerClientId: string;
  /** Причина последнего снятия объекта — попадёт в карточку, если она уходит в
   *  «Потерянные». Для завершённой сделки не нужна. */
  lostReason?: string | null;
}

/** Чистое правило без базы — чтобы его можно было проверить тестом без стенда. */
export function decideSellerCardState(input: {
  hasCompletedDeal: boolean;
  objectsInWork: number;
  lostReason?: string | null;
}): SellerCardOutcome {
  // Работа продолжается — решать судьбу карточки рано, чем бы ни кончились
  // остальные объекты.
  if (input.objectsInWork > 0)
    return { next: "KEEP", objectsInWork: input.objectsInWork };
  // Работа кончилась. Успех перевешивает отказ.
  if (input.hasCompletedDeal) return { next: "DEAL_CLOSED" };
  return { next: "LOST", reason: input.lostReason ?? null };
}

/**
 * Пересчитать и применить. Возвращает решение — вызывающий по нему пишет строку в
 * хронологию и шлёт уведомления, здесь этого сознательно нет: модуль про состояние
 * карточки, а не про оповещения.
 *
 * Никогда не бросает наружу: пересчёт состояния не имеет права сорвать закрытие
 * сделки или одобрение заявки, ради которых его и позвали.
 */
export async function recomputeSellerCardState(
  input: SellerCardInput,
  db: Db = prisma,
): Promise<SellerCardOutcome | null> {
  try {
    if (db === prisma) return await prisma.$transaction(tx => recomputeSellerCardState(input, tx));
    await db.$queryRaw`SELECT id FROM "Client" WHERE id=${input.sellerClientId} FOR UPDATE`;
    const seller = await db.client.findFirst({
      where: { id: input.sellerClientId, deletedAt: null },
      select: {
        id: true,
        status: true,
        assignedAgentId: true,
        lastAgentId: true,
        dualIntent: true,
      },
    });
    if (!seller) return null;
    // Архив — ручное решение руководства, автоматика его не отменяет.
    if (seller.status === "ARCHIVED") return null;

    const properties = await db.property.findMany({
      where: { sellerClientId: input.sellerClientId, deletedAt: null },
      select: { id: true, status: true },
    });
    const inWork = properties.filter((p) =>
      (IN_WORK_STATUSES as readonly string[]).includes(p.status),
    ).length;

    // Removing the seller side cannot terminate buyer work or a live deal.
    const hasOpenDeal = await db.deal.count({ where: { OR: [{ clientId: seller.id }, { propertyId: { in: properties.map(p => p.id) } }], stage: { notIn: ["COMPLETED", "CANCELLED"] } } });
    if (seller.dualIntent || hasOpenDeal > 0) return { next: "KEEP", objectsInWork: inWork };

    const hasCompletedDeal =
      properties.length > 0 &&
      (await db.deal.count({
        where: {
          propertyId: { in: properties.map((p) => p.id) },
          stage: "COMPLETED",
        },
      })) > 0;

    const verdict = decideSellerCardState({
      hasCompletedDeal,
      objectsInWork: inWork,
      lostReason: input.lostReason,
    });

    // Счётчик тишины останавливается при ЛЮБОМ исходе, включая «работа
    // продолжается»: повод пересчёта (продажа, оформленный отказ) сам по себе —
    // работа агента по этому клиенту.
    const stopSilenceClock = { lastAgentAttemptAt: new Date() };

    if (verdict.next === "DEAL_CLOSED") {
      await db.client.update({
        where: { id: seller.id },
        data: {
          status: "DEAL_CLOSED",
          ...stopSilenceClock,
          // Кто вёл карточку — пригодится, когда продавец вернётся продавать снова.
          ...(seller.assignedAgentId
            ? { lastAgentId: seller.assignedAgentId }
            : {}),
        },
      });
      return verdict;
    }

    if (verdict.next === "LOST") {
      /**
       * АГЕНТ СОХРАНЯЕТСЯ (аудит владения 11.09.2026, дыра №2 — тот же класс
       * бага, что у светофора/отказа/передачи: четвёртый путь в LOST, который
       * молча обнулял assignedAgentId, найден при правке трёх остальных).
       * Решение владельца 11.09.2026: LOST не занимает слот в портфеле
       * (`lib/leadLimits.ts::TERMINAL_STATUSES`), значит отбирать карточку не
       * нужно — lastAgentId ставим тем же приёмом, что и раньше.
       */
      await db.client.update({
        where: { id: seller.id },
        data: {
          status: "LOST",
          lostAt: new Date(),
          ...stopSilenceClock,
          ...(verdict.reason ? { refusalReason: verdict.reason } : {}),
          ...(seller.assignedAgentId
            ? { lastAgentId: seller.assignedAgentId }
            : {}),
        },
      });
      return verdict;
    }

    await db.client.update({
      where: { id: seller.id },
      data: stopSilenceClock,
    });
    return verdict;
  } catch (err) {
    console.error(
      "[продавец] пересчёт состояния карточки:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Статусы, при которых объект стоит в продаже (на сайте и в каталоге агента). */
export const ON_SALE_STATUSES = ["AVAILABLE", "RESERVED"] as const;

/**
 * У КОГО ИЗ ПРОДАВЦОВ ОБЪЕКТ ЕЩЁ В РАБОТЕ (или только в продаже, onSaleOnly).
 * Одно правило для всей автоматики «давности и молчания» (23.09.2026): продавец,
 * у которого объект в работе, не «молчит» и не «теряется» — его объект агент
 * предлагает покупателям, звонить ему незачем. Один запрос на пачку.
 */
export async function sellersWithPropertyInWork(
  clientIds: string[],
  opts: { onSaleOnly?: boolean } = {},
): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const statuses = opts.onSaleOnly
    ? [...ON_SALE_STATUSES]
    : [...IN_WORK_STATUSES];
  const rows = await prisma.property.findMany({
    where: {
      sellerClientId: { in: clientIds },
      deletedAt: null,
      status: { in: statuses },
    },
    select: { sellerClientId: true },
  });
  return new Set(
    rows.map((r) => r.sellerClientId).filter((id): id is string => !!id),
  );
}
