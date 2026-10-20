import type { BulkTrashItemResult } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { syncPropertiesToSite, type SyncableProperty } from "./siteSync.js";
import { logSystemError } from "./systemError.js";
import { revokePropertyShareLinks } from "./propertyShareLink.js";
import { queueVideoHandoff, rearmPublishAfterRestore, releaseVideoHandoffForTrashed } from "./videoHandoff.js";
import { describeError } from "./describeError.js";
import { cancelPendingInstagramContainersForTrashed } from "./instagramPendingContainers.js";
import { sendPushToAgent } from "../push.js";

/**
 * УДАЛЕНИЕ ОБЪЕКТА В КОРЗИНУ — ОДНА ФУНКЦИЯ НА ВСЕ ВХОДЫ.
 *
 * Зеркало lib/trashClient.ts (31.08.2026): вход стал не один, а два — прямое
 * DELETE /properties/:id (руководство удаляет само) и одобрение заявки агента
 * (POST /properties/delete-requests/:id/approve). Логика (проверка сделок,
 * снятие с сайта, deletedAt) вынесена сюда, а не продублирована во втором
 * маршруте — см. урок с незакрытыми требованиями клиента (trashClient.ts).
 *
 * С 03.09.2026 вход третий — массовое удаление из списка (POST
 * /properties/bulk-trash). Оно НЕ вызывает trashProperty в цикле: каждый
 * опубликованный объект стоил бы сайту отдельного запроса (до 50 подряд — партия
 * не уложилась бы в таймаут прокси). Партия — основная реализация
 * (trashProperties), а одиночное удаление — её частный случай на один id; второй
 * копии правил (сделки, снятие с сайта, deletedAt) в проекте по-прежнему нет.
 *
 * Мягкое удаление: объект уходит в Корзину (deletedAt), фото/видео на диске
 * остаются — «Восстановить» возвращает всё как было. Объект с хотя бы одной
 * сделкой удалить нельзя (Deal.propertyId — обязательный FK без каскада, да и
 * терять историю сделок нельзя). Физическое удаление — отдельно,
 * DELETE /:id/permanent.
 *
 * Запись в журнал (logAudit) остаётся у вызывающего: ей нужен req, а здесь его
 * нет. Все поля для неё возвращаются в результате.
 */
export type TrashPropertyResult =
  | {
      ok: true;
      property: { id: string; shortId: number; title: string; publishedOnSite: boolean };
    }
  | { ok: false; status: 404 | 409; error: string };

/** Строка итога партии + всё, что нужно вызывающему для журнала и ответа. */
export interface BulkTrashResultItem extends BulkTrashItemResult {
  /** Код ответа для одиночного входа: 404 «не найден», 409 «есть сделки». */
  status?: 404 | 409;
  /** Был ли объект на сайте — попадает в журнал действий, как и раньше. */
  publishedOnSite?: boolean;
}

/**
 * ЗАЯВКИ АГЕНТА НА УДАЛЕНИЕ ЗАКРЫВАЮТСЯ ВМЕСТЕ С ОБЪЕКТОМ (07.09.2026).
 *
 * Вынесено из trashProperties в отдельную функцию (разведка того же дня): помимо
 * bulk-trash/одиночного удаления, объект может уйти в Корзину и МИМО этой пары —
 * например вебхуком сайта (routes/webhooks.ts, action:"deleted"), у которого нет
 * агента CRM, отсюда `byAgentId: string | null`. Раньше такой путь не закрывал
 * заявку вовсе — она висела в Архиве строкой без объекта, «Удалить в корзину»
 * упиралась в 404, «Отклонить» соврала бы агенту.
 *
 * Best-effort по умолчанию — как и у trashClient (см. его заголовок): карточка/
 * объект обязаны уйти в Корзину, даже если гашение заявки споткнётся, а окно
 * решения по заявке отсеивает уже удалённые объекты само (проверка `deletedAt`,
 * а не текста ошибки, в routes/properties/deleteRequests.ts). Ошибка внутри
 * по-прежнему гасится через `.catch` и не пробрасывается — только ЭТО делает
 * безопасным передать сюда `tx`, чтобы участвовать в чужой открытой транзакции
 * (тот же приём, что `logTimeline({..., tx})` в lib/timeline.ts): падение самого
 * запроса не оборвёт транзакцию вызывающего, а вот падение процесса ПОСЕРЕДИНЕ —
 * между `property.update` и этим гашением — теперь откатывает оба сразу, а не
 * оставляет объект в Корзине с открытой заявкой на его удаление.
 */
export async function closePendingPropertyDeleteRequests(
  propertyIds: string[],
  byAgentId: string | null,
  decisionNote = "Объект удалён в Корзину",
  tx?: TxClient
): Promise<void> {
  if (propertyIds.length === 0) return;
  const client = tx ?? prisma;
  await client.propertyDeleteRequest
    .updateMany({
      where: { propertyId: { in: propertyIds }, status: "PENDING" },
      data: { status: "APPROVED", decidedById: byAgentId, decidedAt: new Date(), decisionNote },
    })
    .catch((err) => {
      void logSystemError(
        "api",
        `Заявки на удаление удалённых объектов не закрыты (${propertyIds.join(", ")}): ${
          err instanceof Error ? err.message : err
        }`
      );
    });
}

/**
 * ЗАЯВКИ НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА ГАСНУТ ВМЕСТЕ С НИМ (07.10.2026).
 * Объект ушёл в Корзину — «Принять» по заявке было бы ответом на «объект не найден».
 * CANCELLED, а не REJECTED: никто заявку не отклонял. Best-effort, как у заявок на удаление:
 * объект обязан уйти в Корзину, даже если гашение споткнётся; сбой — в журнал ошибок.
 * Решённые заявки (APPROVED/REJECTED/FAILED) остаются историей; при удалении навсегда
 * строки уходят каскадом по внешнему ключу.
 */
export async function closePendingPropertyChangeRequests(propertyIds: string[]): Promise<void> {
  if (propertyIds.length === 0) return;
  await prisma.propertyChangeRequest
    .updateMany({
      where: { propertyId: { in: propertyIds }, status: "PENDING" },
      data: { status: "CANCELLED", decidedAt: new Date(), decisionNote: "Объект удалён в Корзину" },
    })
    .catch((err) => {
      void logSystemError(
        "api",
        `Заявки на изменение удалённых объектов не закрыты (${propertyIds.join(", ")}): ${
          err instanceof Error ? err.message : err
        }`
      );
    });
}

/**
 * Снятие партии с сайта перед удалением — best-effort одним запросом.
 *
 * Недоступность сайта не должна блокировать удаление, но молчать тоже нельзя:
 * осиротевший листинг надо находить по журналу «Здоровье системы», а не
 * случайно в логах контейнера.
 */
async function unpublishBeforeTrash(published: SyncableProperty[]): Promise<void> {
  if (published.length === 0) return;
  const ids = published.map((p) => p.id).join(", ");
  try {
    const result = await syncPropertiesToSite(published, "unpublish");
    const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
    if (problem) {
      console.error(`[siteSync] Не удалось снять с сайта перед удалением (${ids}): ${problem}`);
      void logSystemError("site-sync", `Объекты остались на сайте после удаления в CRM (${ids}): ${problem}`, {
        url: `/properties/${published[0].id}`,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[siteSync] Ошибка снятия с сайта перед удалением (${ids}):`, reason);
    void logSystemError("site-sync", `Ошибка снятия объектов с сайта перед удалением (${ids}): ${reason}`, {
      url: `/properties/${published[0].id}`,
    });
  }
}

const HAS_DEALS_ERROR = "У объекта есть сделки — сначала снимите сделку, потом удаляйте объект";

/**
 * Удаление партии объектов в Корзину. Партия НЕ всё-или-ничего: объект со
 * сделкой или уже удалённый отсекается сам по себе, остальные уходят в Корзину —
 * иначе одна чужая сделка отменяла бы уборку полусотни тестовых карточек, а
 * человеку было бы нечего чинить, кроме как искать виновную строку вручную.
 *
 * Порядок ответа = порядок переданных id: экран показывает отказы напротив тех
 * же строк, которые человек отмечал галочками.
 */
export async function trashProperties(propertyIds: string[], byAgentId: string): Promise<BulkTrashResultItem[]> {
  const ids = [...new Set(propertyIds)];
  const properties = await prisma.property.findMany({
    where: { id: { in: ids } },
    include: { district: true, photos: { orderBy: { order: "asc" } }, _count: { select: { deals: true } } },
  });
  const byId = new Map(properties.map((p) => [p.id, p]));

  const eligible: typeof properties = [];
  const results: BulkTrashResultItem[] = ids.map((id) => {
    const property = byId.get(id);
    if (!property || property.deletedAt) {
      return { id, ok: false, status: 404 as const, error: "Объект не найден" };
    }
    if (property._count.deals > 0) {
      return {
        id,
        shortId: property.shortId,
        title: property.title,
        ok: false,
        status: 409 as const,
        error: HAS_DEALS_ERROR,
      };
    }
    eligible.push(property);
    return {
      id,
      shortId: property.shortId,
      title: property.title,
      ok: true,
      publishedOnSite: property.publishedOnSite,
    };
  });

  if (eligible.length === 0) return results;

  await unpublishBeforeTrash(eligible.filter((p) => p.publishedOnSite));

  /**
   * ЗАПИСЬ В КОРЗИНУ — ПОД БЛОКИРОВКОЙ СТРОКИ ОБЪЕКТА И С ПОВТОРНОЙ ПРОВЕРКОЙ СДЕЛОК
   * (аудит Codex 04.10.2026, №13). Проверка `_count.deals` выше сделана до снятия
   * с сайта (сетевой вызов, секунды), и за это окно POST /deals успевал завести
   * сделку: объект уходил в Корзину с живой сделкой. Предикат «нет сделок» внутри
   * одного UPDATE не спасает (при ожидании блокировки подзапрос читает старый
   * снимок), поэтому: SELECT … FOR UPDATE берёт строки, резерв в POST (property.
   * updateMany) ждёт их, а сделки перечитываются ПОСЛЕ блокировки. Либо POST
   * закоммитился раньше — тогда его сделка видна здесь и объект остаётся (409),
   * либо ждёт нас и видит deletedAt (резерв требует deletedAt: null).
   * Партия по-прежнему не «всё или ничего»: отсечённые уходят строкой отказа.
   */
  const eligibleIds = eligible.map((p) => p.id);
  const refusedById = new Map<string, 404 | 409>();
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Property" WHERE "id" = ANY(${eligibleIds}) AND "deletedAt" IS NULL FOR UPDATE`;
    const lockedIds = locked.map((row) => row.id);
    const withDeals = new Set(
      (
        await tx.deal.findMany({
          where: { propertyId: { in: lockedIds } },
          select: { propertyId: true },
          distinct: ["propertyId"],
        })
      ).map((d) => d.propertyId)
    );
    const lockedSet = new Set(lockedIds);
    for (const id of eligibleIds) {
      if (!lockedSet.has(id)) refusedById.set(id, 404);
      else if (withDeals.has(id)) refusedById.set(id, 409);
    }
    const okIds = lockedIds.filter((id) => !withDeals.has(id));
    // Одним запросом, а не await в цикле: удаление партии — единственное действие,
    // и незачем платить за него полусотней UPDATE. Отметку publishedOnSite здесь
    // не трогаем — «Восстановить» и раньше не возвращало объект на сайт само
    // (см. POST /:id/restore), решение о повторной публикации принимают отдельно.
    if (okIds.length > 0) {
      await tx.property.updateMany({
        where: { id: { in: okIds }, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: byAgentId },
      });
    }
  });

  if (refusedById.size > 0) {
    for (const p of eligible) {
      const status = refusedById.get(p.id);
      if (!status) continue;
      const at = results.findIndex((r) => r.id === p.id);
      results[at] =
        status === 409
          ? { id: p.id, shortId: p.shortId, title: p.title, ok: false, status, error: HAS_DEALS_ERROR }
          : { id: p.id, ok: false, status, error: "Объект не найден" };
      if (status === 409 && p.publishedOnSite) {
        // Сделку завели, пока объект снимался с сайта: в Корзину он не ушёл, но с
        // сайта уже снят. Молча оставлять такое нельзя — решение о возврате на сайт
        // принимает человек, поэтому в журнал «Здоровье системы».
        void logSystemError(
          "site-sync",
          `Объект ${p.id} снят с сайта при удалении, но не удалён: за это время по нему заведена сделка. Проверьте публикацию.`,
          { url: `/properties/${p.id}` }
        );
      }
    }
  }
  const trashed = eligible.filter((p) => !refusedById.has(p.id));
  if (trashed.length === 0) return results;

  // Зеркало правки по клиентам (lib/trashClient.ts, тот же день, живой случай
  // Продавец №0127): заявка агента на удаление гасится вместе с объектом.
  // ЗДЕСЬ, А НЕ В trashProperty: одиночное удаление — частный случай партии (см.
  // ниже), а массовое удаление галочками идёт только сюда. Правка в одиночной
  // функции оставила бы bulk-trash дырой ровно того же вида. Закрываем как
  // APPROVED, а не REJECTED: с точки зрения агента заявка исполнена.
  await closePendingPropertyDeleteRequests(
    trashed.map((p) => p.id),
    byAgentId
  );

  // Публичные ссылки на объект тоже гаснут вместе с ним (07.09.2026, разведка
  // «осиротевшие спутники») — см. заголовок revokePropertyShareLinks.
  await revokePropertyShareLinks(trashed.map((p) => p.id));

  await closeTrashedPropertyWorkSatellites(trashed.map((p) => p.id));

  return results;
}

/**
 * Работа, которая крутится вокруг объекта и гаснет вместе с ним в Корзине.
 * ОДИН СПИСОК на все пути в Корзину — кнопку в CRM, партию галочками и удаление
 * с сайта (аудит 23.09.2026, №47: сайт гасил только заявки и ссылки, монтажёр
 * продолжал держать задачу по удалённому объекту). Новый спутник добавляется
 * сюда, и все пути получают его сразу.
 */
export async function closeTrashedPropertyWorkSatellites(propertyIds: string[]): Promise<void> {
  // Заявки агента на изменение опубликованного объекта (07.10.2026): менять в Корзине нечего —
  // ждущие закрываются «отозвана» с причиной, как заявки на удаление выше.
  await closePendingPropertyChangeRequests(propertyIds);

  // Очередь монтажа — спутник того же рода: удалённый объект держал место
  // монтажёра навсегда, и следующие объекты не уезжали вовсе (19.09.2026).
  await releaseVideoHandoffForTrashed(propertyIds);

  // Отложенный контейнер Instagram — тот же спутник и самый дорогой из них:
  // контейнер живёт у Meta сутки, и фоновый проход опубликовал бы ролик
  // удалённого объекта на публичной странице агентства через часы после
  // удаления (22.09.2026). См. cancelPendingInstagramContainersForTrashed.
  await cancelPendingInstagramContainersForTrashed(propertyIds);

  await cancelOpenShowingsForTrashed(propertyIds);
}

/** Потолок открытых показов на партию удаляемых объектов — реально единицы. */
const OPEN_SHOWINGS_CAP = 500;

/**
 * ПОКАЗ ПО ОБЪЕКТУ ИЗ КОРЗИНЫ СНИМАЕТСЯ (аудит 23.09.2026, №46).
 *
 * Показ оставался живым: клиенту уходило напоминание-подтверждение, а агенту
 * после времени показа — «Итог показа» и отметка о пропуске, хотя ехать было
 * некуда. Снимаем тем же приёмом, что и удаление навсегда (DELETE
 * /:id/permanent) и ручная отмена (applyCancellation): nextAction: null,
 * declinedAt, след в notes, гашение «Итога показа». Клиенту CRM сама ничего не
 * пишет — агент получает пуш и сам предупреждает клиента.
 */
export async function cancelOpenShowingsForTrashed(propertyIds: string[]): Promise<void> {
  await cancelOpenShowings(propertyIds, {
    note: "Объект удалён в Корзину — показ снят с календаря",
    pushTitle: "Показ снят: объект удалён",
    pushBody: (shortId, client) => `Объект №${shortId} убран в Корзину, показ клиенту ${client} снят. Предупредите клиента.`,
  });
}

/**
 * ТО ЖЕ ДЛЯ ОБЪЕКТА, УШЕДШЕГО С ПРОДАЖИ (02.10.2026, аудит «Проданный объект»):
 * продан сделкой или снят — будущие показы снимаются, клиенту не приходит
 * «завтра показ» проданной квартиры, а агент не едет впустую. Только БУДУЩИЕ:
 * показ, время которого уже прошло, ждёт «Итога показа» и отчёт не теряет.
 */
export async function cancelFutureShowingsForOffSale(propertyIds: string[], becameSold: boolean): Promise<void> {
  const what = becameSold ? "продан" : "снят с продажи";
  await cancelOpenShowings(propertyIds, {
    note: `Объект ${what} — показ снят с календаря`,
    pushTitle: `Показ снят: объект ${what}`,
    pushBody: (shortId, client) => `Объект №${shortId} ${what}, показ клиенту ${client} снят. Предупредите клиента.`,
    onlyAfter: new Date(),
  });
}

interface CancelShowingsOptions {
  note: string;
  pushTitle: string;
  pushBody: (propertyShortId: number | string, clientName: string) => string;
  /** Только показы позже этого момента (прошедшие остаются на «Итог показа»). */
  onlyAfter?: Date;
}

async function cancelOpenShowings(propertyIds: string[], opts: CancelShowingsOptions): Promise<void> {
  if (propertyIds.length === 0) return;
  try {
    const now = new Date();
    const open = await prisma.interaction.findMany({
      where: {
        propertyId: { in: propertyIds },
        type: "SHOWING",
        nextAction: { not: null },
        completedAt: null,
        ...(opts.onlyAfter ? { nextActionDate: { gt: opts.onlyAfter } } : {}),
      },
      select: {
        id: true,
        notes: true,
        agentId: true,
        subjectAgentId: true,
        client: { select: { shortId: true, fullName: true } },
        property: { select: { shortId: true } },
      },
      take: OPEN_SHOWINGS_CAP,
    });
    if (open.length === 0) return;
    await prisma.$transaction(
      open.map((s) =>
        prisma.interaction.update({
          where: { id: s.id },
          data: {
            nextAction: null,
            declinedAt: now,
            notes: `${s.notes}\n${opts.note}`,
          },
        })
      )
    );
    await prisma.pendingSummary.updateMany({
      where: { kind: "meeting", subjectId: { in: open.map((s) => s.id) }, doneAt: null },
      data: { doneAt: now },
    });
    for (const s of open) {
      const agentId = s.agentId ?? s.subjectAgentId;
      if (!agentId) continue;
      void sendPushToAgent(agentId, {
        title: opts.pushTitle,
        body: opts.pushBody(s.property?.shortId ?? "?", s.client?.fullName ?? ""),
        url: s.client ? `/clients/${s.client.shortId}` : "/calendar",
      }).catch(() => {});
    }
  } catch (err) {
    void logSystemError(
      "api",
      `Показы по объектам (${opts.note}) не сняты (${propertyIds.join(", ")}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Одиночное удаление — частный случай партии на один id. */
export async function trashProperty(propertyId: string, byAgentId: string): Promise<TrashPropertyResult> {
  const [result] = await trashProperties([propertyId], byAgentId);
  if (!result.ok) {
    return { ok: false, status: result.status ?? 404, error: result.error ?? "Объект не найден" };
  }
  return {
    ok: true,
    property: {
      id: result.id,
      shortId: result.shortId!,
      title: result.title!,
      publishedOnSite: result.publishedOnSite === true,
    },
  };
}

/**
 * РАБОТА, КОТОРАЯ ВОЗВРАЩАЕТСЯ ВМЕСТЕ С ОБЪЕКТОМ ИЗ КОРЗИНЫ. Один список на оба
 * пути восстановления — кнопку «Восстановить» (POST /properties/:id/restore) и
 * «Откатить» удаление объявления сайтом (routes/siteNotifications.ts, глубокая
 * проверка 02.10.2026, D4). Зеркало closeTrashedPropertyWorkSatellites.
 * Best-effort: сбой не отменяет самого восстановления.
 */
export async function reopenWorkAfterRestore(property: {
  id: string;
  shortId: number;
  status: string;
  videoHandoffFinalPath: string | null;
}): Promise<void> {
  /**
   * ВЕРНУТЬ В ОЧЕРЕДЬ МОНТАЖА, ЕСЛИ ОН ТАМ БЫЛ (25.09.2026, А3). Удаление
   * (releaseVideoHandoffForTrashed → closeVideoHandoff) переводит объект в
   * «синтетический» RECEIVED и оставляет ЕДИНСТВЕННЫЙ след — запись
   * MontajerMessage kind="PROPERTY_DELETED" в момент удаления (Property сама
   * это не помнит, videoHandoffStatus уже RECEIVED и от обычного RECEIVED не
   * отличим). Смотрим на самую свежую запись журнала: если это она и объект
   * всё ещё на этапе EDITING без готового ролика — значит его сняли с монтажа
   * ИМЕННО удалением, а не как-то ещё после, и возвращаем в очередь тем же
   * путём, что и одобрение (queueVideoHandoff, сам проверит
   * videoHandoffEnabled/монтажёра и no-op'нет, если чего-то не хватает).
   * Если данных нет (журнала нет, или последняя запись — что-то другое) —
   * оставляем как есть: «Снова на монтаж» на карточке доступна руками.
   */
  if (property.status === "EDITING" && !property.videoHandoffFinalPath) {
    const lastMessage = await prisma.montajerMessage.findFirst({
      where: { propertyId: property.id },
      orderBy: { sentAt: "desc" },
      select: { kind: true },
    });
    if (lastMessage?.kind === "PROPERTY_DELETED") {
      await queueVideoHandoff(property.id).catch((err) =>
        void logSystemError(
          "video-handoff",
          `Объект №${property.shortId}: возврат в очередь монтажа после восстановления не удался: ${describeError(err)}`
        )
      );
    }
  }

  // Находка №130 ночной проверки (24.09.2026): объект с принятым роликом,
  // побывавший в Корзине, иначе не публикуется никогда — задание публикации
  // закрылось DONE в момент удаления (увидело deletedAt), а сторож
  // недоехавших публикаций пропускает объект, у которого уже есть строка
  // задания.
  await rearmPublishAfterRestore(property.id).catch((err) =>
    logSystemError(
      "video-handoff",
      `Объект ${property.id}: восстановлен из Корзины, но публикацию принятого ролика переоткрыть не удалось: ${describeError(err)}`
    )
  );
}
