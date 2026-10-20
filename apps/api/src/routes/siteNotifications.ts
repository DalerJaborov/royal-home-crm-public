import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { isSiteListedStatus, syncPropertiesToSite } from "../lib/siteSync.js";
import { resolveDistrict } from "./webhooks.js";
import {
  closePendingPropertyDeleteRequests,
  closeTrashedPropertyWorkSatellites,
  reopenWorkAfterRestore,
} from "../lib/trashProperty.js";
import { revokePropertyShareLinks } from "../lib/propertyShareLink.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { fromTjs, loadMoneyContext, roundMoney } from "../lib/money.js";
import type { Currency } from "@royal-home/shared";

export const siteNotificationsRouter = Router();

/**
 * СТРАНИЦЫ ВМЕСТО ОБРЕЗА (02.10.2026): список кончался на двухстах, и старые
 * уведомления было не увидеть ничем, кроме «Разобрать все». Теперь экран
 * дочитывает их кнопкой «Показать ещё». Бейджи меню параметров не шлют и
 * берут отсюда только `total` — им достаётся первая страница по умолчанию.
 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Непросмотренные уведомления о правках на сайте — для баннера/бейджа в CRM.
 * Приём самих уведомлений от сайта — см. /webhooks/site-listing-changed в webhooks.ts. */
siteNotificationsRouter.get("/", requireAuth, requirePermission("siteChanges.view"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const { page, pageSize } = parsed.data;
  const unresolved = { resolvedAt: null };
  // Список и общий счётчик — отдельными запросами: бейдж и счётчик обязаны
  // показывать правду про ВСЕ неразобранные, а не только про одну страницу.
  const [items, total] = await Promise.all([
    prisma.siteEditNotification.findMany({
      where: unresolved,
      // id — добивка порядка, чтобы строки одной секунды не перескакивали
      // между страницами «Показать ещё».
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { property: { select: { id: true, shortId: true, title: true, publishedOnSite: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.siteEditNotification.count({ where: unresolved }),
  ]);
  res.json({ items, total, page, pageSize });
});

const resolveSchema = z.object({ resolution: z.enum(["ACCEPTED", "REJECTED"]) });

/** Сайт присылает значение поля либо как есть, либо как `{from, to}` (см.
 *  formatChangeValue в SiteChanges.tsx) — разворачиваем до того, как писать в Property. */
function unwrapSiteChangeValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if ("to" in rec) return rec.to;
    if ("new" in rec) return rec.new;
    if ("after" in rec) return rec.after;
  }
  return v;
}

/**
 * «Принять» правку сайта (action UPDATED) должно применить к Property РОВНО то, что
 * сайт прислал в `changes` — не больше. Белый список полей и осторожность с
 * district/districtId — та же, что в webhooks.ts `/site-listing-upserted`: район
 * переписываем только при уверенном совпадении названия, иначе оставляем прежний
 * (resolveDistrict иначе вернул бы districts[0] — заведомо чужой район).
 * Неизвестные/нераспознанные ключи (например editedBy, status) молча пропускаются:
 * это метаданные или поля, которыми управляет только CRM, а не сайт.
 */
async function buildPropertyUpdateFromSiteChanges(
  changes: Record<string, unknown>,
  propertyCurrency: Currency | string
): Promise<Prisma.PropertyUncheckedUpdateInput> {
  const data: Prisma.PropertyUncheckedUpdateInput = {};

  if ("price" in changes) {
    const v = unwrapSiteChangeValue(changes.price);
    const n = typeof v === "number" ? v : Number(v);
    // Цена с сайта — ВСЕГДА в сомони (ночная проверка 24.09.2026): CRM сама шлёт
    // на сайт `priceInTjs` (lib/siteSync.ts), а объекты, заведённые на сайте,
    // создаются с currency: "TJS" (webhooks.ts). Объект же в CRM может быть в
    // долларах — и число писалось в `price` как есть: 85 000 $ после «Принять»
    // становились 850 000 $ (сомони, записанные как доллары). Переводим в валюту
    // объекта тем же курсом и тем же правилом, что и везде (lib/money.ts). Ноль
    // и отрицательное — не цена, а пустое поле на сайте: не принимаем.
    if (Number.isFinite(n) && n > 0) {
      if (propertyCurrency === "USD") {
        const ctx = await loadMoneyContext();
        data.price = roundMoney(fromTjs(n, "USD", ctx));
      } else {
        data.price = n;
      }
    }
  }
  if ("address" in changes) {
    const v = unwrapSiteChangeValue(changes.address);
    if (typeof v === "string" && v.trim()) data.address = v;
  }
  if ("description" in changes) {
    const v = unwrapSiteChangeValue(changes.description);
    if (typeof v === "string" || v === null) data.description = v as string | null;
  }
  if ("area" in changes || "areaSqm" in changes) {
    const v = unwrapSiteChangeValue("areaSqm" in changes ? changes.areaSqm : changes.area);
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) data.areaSqm = n;
  }
  if ("rooms" in changes) {
    const v = unwrapSiteChangeValue(changes.rooms);
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n >= 0) data.rooms = Math.trunc(n);
  }
  if ("district" in changes) {
    const v = unwrapSiteChangeValue(changes.district);
    if (typeof v === "string" && v.trim()) {
      const districts = await prisma.district.findMany({ select: { id: true, name: true } });
      const { id, matched } = resolveDistrict(v, districts);
      if (matched) data.districtId = id;
    }
  }

  return data;
}

type ResolveOutcome =
  | { ok: true; propertyDeleted?: boolean }
  | { ok: false; status: number; error: string };

/**
 * Причина отказа сайта или null. `syncPropertiesToSite` возвращает `ok: true` на любой
 * принятый HTTP 2xx, а отказ по самому объекту лежит в `results[i].ok` (SYNC-01): без
 * проверки элемента объект помечался опубликованным, хотя сайт его не принял. Та же
 * проверка стоит у остальных вызывающих (propertyPipeline, trashProperty, crud).
 */
function siteSyncProblem(result: Awaited<ReturnType<typeof syncPropertiesToSite>>): string | null {
  if (!result.ok) return result.error;
  return result.results.find((r) => !r.ok)?.error ?? null;
}

/**
 * ACCEPTED — правка сайта принята как есть, CRM ничего не трогает (админ уже сверил
 * вручную). REJECTED — версия CRM пересылается на сайт заново, перезаписывая правку сайта
 * (для DELETED это republish — объект появляется на сайте снова).
 *
 * Вынесено из обработчика `/:id/resolve` (15.09.2026), чтобы «Разобрать все»
 * применяла РОВНО ту же логику по каждому уведомлению — публикацию,
 * применение правок, мягкое удаление, — а не просто ставила галочку поверх
 * непросмотренных решений, как errorLog.ts. Там у строк журнала нет
 * побочных эффектов, здесь они есть, и обходить их значило бы разобрать
 * пачку, ничего не поменяв ни на сайте, ни в объектах.
 */
async function resolveOneNotification(id: string, resolution: "ACCEPTED" | "REJECTED"): Promise<ResolveOutcome> {
  const notification = await prisma.siteEditNotification.findUnique({
    where: { id },
    include: { property: { include: { district: true, photos: { orderBy: { order: "asc" } } } } },
  });
  if (!notification) return { ok: false, status: 404, error: "Уведомление не найдено" };
  if (notification.resolvedAt) return { ok: false, status: 409, error: "Уже обработано" };

  /**
   * «ОТКАТИТЬ» УДАЛЕНИЕ, СДЕЛАННОЕ САЙТОМ (глубокая проверка 02.10.2026, D4).
   * Вебхук удаления кладёт объект без сделок в Корзину вместе с этим самым
   * уведомлением — и ранняя ветка ниже («объект в Корзине — разбирать нечего»)
   * закрывала откат «успешно», ничего не сделав: объект оставался в Корзине и
   * не возвращался на сайт, а директор считал, что вернул. В Корзине его
   * держит именно сайт, если `deletedById` пуст: все пути в Корзину из CRM
   * (lib/trashProperty.ts) пишут, кто удалил, вебхук — нет. Такой объект
   * восстанавливается веткой REJECTED ниже; убранный в Корзину человеком —
   * по-прежнему нет: это его решение, и откат чужого уведомления его не отменяет.
   */
  const restoringSiteDeletion =
    resolution === "REJECTED" &&
    notification.action === "DELETED" &&
    notification.property.deletedAt !== null &&
    notification.property.deletedById === null;

  /**
   * Объект мог уехать в Корзину ПОСЛЕ прихода уведомления (26.08.2026): «Отклонить»
   * по старому уведомлению переопубликовывал удалённый объект на публичный сайт и
   * ставил publishedOnSite: true карточке, которой в CRM больше нет. Разбирать
   * такое уведомление нечего — резолвим без единого похода на сайт.
   */
  if (notification.property.deletedAt && !restoringSiteDeletion) {
    const resolvedDeleted = await prisma.siteEditNotification.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: new Date(), resolution },
    });
    if (resolvedDeleted.count === 0) return { ok: false, status: 409, error: "Уже обработано" };
    return { ok: true, propertyDeleted: true };
  }

  /**
   * Атомарный захват ДО сетевого вызова (26.08.2026): между старой проверкой
   * resolvedAt и записью шёл синк с сайтом на секунды — два одновременных resolve
   * (двойной клик, два админа) оба проходили проверку, и при разных resolution на
   * сайт улетали противоречащие команды. Проигравший получает 409; при отказе
   * сайта отметка снимается — уведомление остаётся разбираемым.
   *
   * ЧТО ИМЕННО ПИШЕТ ЗАХВАТ (21.09.2026). Раньше он писал СРАЗУ ОБА поля —
   * `resolution` и `resolvedAt`, — то есть объявлял правку разобранной за секунды
   * до того, как она на самом деле уезжала на сайт. Снять отметку мог только этот
   * же процесс, а автовыкат перезапускает контейнеры по каждому мержу в main:
   * рестарт посреди синка оставлял уведомление «разобранным» навсегда, при том что
   * на сайт не ушло ничего. Список «на разбор» фильтруется по `resolvedAt: null` —
   * правка просто пропадала с глаз, без ошибки и без следа.
   *
   * Теперь захват пишет ТОЛЬКО `resolution` («разбор начат», тот же приём, что у
   * дедупликации вебхуков в lib/webhookDedupe.ts), а `resolvedAt` («разбор
   * закончен») ложится последним действием, когда сайт уже ответил. Защита от
   * двойного клика та же самая — условие переехало на `resolution: null`, — а
   * оборванный разбор остаётся в списке, потому что `resolvedAt` у него пуст.
   */
  const claimed = await prisma.siteEditNotification.updateMany({
    where: { id, resolution: null },
    data: { resolution },
  });
  if (claimed.count === 0) return { ok: false, status: 409, error: "Уже обработано" };
  const releaseClaim = () =>
    prisma.siteEditNotification.updateMany({ where: { id }, data: { resolvedAt: null, resolution: null } }).catch(() => {});

  if (notification.action === "CREATED") {
    // Новый объект с сайта на модерации. Одобрить (ACCEPTED) — публикуем на сайте;
    // Отклонить (REJECTED) — оставляем скрытым (не удаляем — решение обратимо).
    if (resolution === "ACCEPTED") {
      const result = await syncPropertiesToSite([notification.property], "publish");
      const problem = siteSyncProblem(result);
      if (problem) {
        await releaseClaim();
        return { ok: false, status: 502, error: `Не удалось опубликовать объект на сайте: ${problem}` };
      }
      await prisma.property.update({ where: { id: notification.propertyId }, data: { publishedOnSite: true } });
    } else {
      const result = await syncPropertiesToSite([notification.property], "unpublish");
      const problem = siteSyncProblem(result);
      if (problem) {
        await releaseClaim();
        return { ok: false, status: 502, error: `Не удалось скрыть объект на сайте: ${problem}` };
      }
      await prisma.property.update({ where: { id: notification.propertyId }, data: { publishedOnSite: false } });
    }
  } else if (resolution === "REJECTED" && !isSiteListedStatus(notification.property.status)) {
    // Версия CRM — «на сайте объекта нет» (снят с продажи или вернулся в
    // подготовку): откат правки сайта не вправе публиковать его заново (D10,
    // глубокая проверка 02.10.2026, тот же класс, что №129 и D3). Снимаем
    // объявление; объект, убранный в Корзину сайтом, возвращается из неё, но
    // на витрину не выходит.
    const result = await syncPropertiesToSite([notification.property], "unpublish");
    const problem = siteSyncProblem(result);
    if (problem) {
      await releaseClaim();
      return { ok: false, status: 502, error: `Не удалось снять объект с сайта: ${problem}` };
    }
    await prisma.property.update({
      where: { id: notification.propertyId },
      data: restoringSiteDeletion
        ? { publishedOnSite: false, deletedAt: null, deletedById: null }
        : { publishedOnSite: false },
    });
    if (restoringSiteDeletion) await reopenWorkAfterRestore(notification.property);
  } else if (resolution === "REJECTED") {
    // UPDATED/DELETED: REJECTED = вернуть версию CRM на сайт (перезаписать/переопубликовать).
    const result = await syncPropertiesToSite([notification.property], "publish");
    const problem = siteSyncProblem(result);
    if (problem) {
      await releaseClaim();
      return { ok: false, status: 502, error: `Не удалось отправить версию CRM на сайт: ${problem}` };
    }
    // Отказ от удаления с сайта возвращает объект и из Корзины CRM: сайт его
    // удалил и вебхук убрал его туда же, а теперь он снова на сайте — лежать в
    // Корзине ему незачем (аудит 23.09.2026, №47).
    await prisma.property.update({
      where: { id: notification.propertyId },
      data:
        notification.action === "DELETED"
          ? { publishedOnSite: true, deletedAt: null, deletedById: null }
          : { publishedOnSite: true },
    });
    if (restoringSiteDeletion) await reopenWorkAfterRestore(notification.property);
  } else if (notification.action === "UPDATED") {
    // UPDATED + ACCEPTED: раньше эта ветка не существовала вовсе — кнопка «Принять»
    // ставила resolvedAt и ничего не писала в Property, хотя подпись кнопки
    // ("Принять правку сайта как есть") обещает обратное. Пишем ровно то, что
    // сайт прислал в `changes`, белым списком (см. buildPropertyUpdateFromSiteChanges).
    try {
      const changes = (notification.changes ?? null) as Record<string, unknown> | null;
      if (changes && Object.keys(changes).length > 0) {
        const updateData = await buildPropertyUpdateFromSiteChanges(changes, notification.property.currency);
        if (Object.keys(updateData).length > 0) {
          await prisma.property.update({ where: { id: notification.propertyId }, data: updateData });
        }
      }
    } catch (err) {
      await releaseClaim();
      return { ok: false, status: 500, error: "Не удалось применить правку сайта к объекту" };
    }
  } else if (notification.action === "DELETED") {
    // DELETED + ACCEPTED: принять удаление сайтом как есть — объект уходит в Корзину
    // в CRM тоже (мягкое удаление, как и обычный DELETE /properties/:id), и его
    // спутники (заявки на удаление, ссылки на просмотр) гасятся тем же путём, что и
    // в webhooks.ts `/site-listing-upserted` — иначе ровно тот класс бага из
    // памяти репозитория: "спутник не гаснет при удалении родителя".
    // Объект со сделкой в Корзину не уходит ни одним путём — как и из CRM
    // (trashProperties). Удаление с сайта тут принять нельзя: сначала сделка
    // (аудит 23.09.2026, №47).
    if ((await prisma.deal.count({ where: { propertyId: notification.propertyId } })) > 0) {
      await releaseClaim();
      return {
        ok: false,
        status: 409,
        error: "У объекта есть сделка — удалить его нельзя. Отклоните удаление, чтобы вернуть объект на сайт.",
      };
    }
    try {
      // Объект в Корзину и гашение его спутников — одной транзакцией: порознь
      // падение между шагами оставляет объект удалённым, а заявку агента на его
      // удаление и приватные ссылки на просмотр — живыми (тот же класс, что чинил
      // webhooks.ts `/site-listing-upserted`, см. его комментарий у транзакции).
      await prisma.$transaction(async (tx) => {
        await tx.property.update({
          where: { id: notification.propertyId },
          data: { deletedAt: new Date(), publishedOnSite: false },
        });
        await closePendingPropertyDeleteRequests([notification.propertyId], null, "Объект удалён через сайт", tx);
        await revokePropertyShareLinks([notification.propertyId], tx);
      });
      await closeTrashedPropertyWorkSatellites([notification.propertyId]);
    } catch (err) {
      await releaseClaim();
      return { ok: false, status: 500, error: "Не удалось применить удаление объекта, пришедшее с сайта" };
    }
  }

  // РАЗБОР ЗАКОНЧЕН — и только теперь. Всё, что могло сходить на сайт и не
  // вернуться, уже вернулось: до этой строки уведомление остаётся в списке
  // «на разбор», и рестарт посреди синка его не теряет.
  //
  // `resolution` пишется ПОВТОРНО нарочно: выкат пересоздаёт контейнеры, и
  // новый успевает подняться, пока старый ещё дотягивает свои запросы
  // (SHUTDOWN_GRACE_MS в index.ts — 15 секунд). Снятие оборванных захватов на
  // старте нового процесса могло бы в это окно обнулить `resolution` у разбора,
  // который на самом деле идёт, — и уведомление закрылось бы без решения.
  await prisma.siteEditNotification.update({ where: { id }, data: { resolvedAt: new Date(), resolution } });
  return { ok: true };
}

/**
 * Снять захваты, оборванные рестартом процесса (21.09.2026).
 *
 * `resolution` без `resolvedAt` означает «разбор начат и не закончен». Пока
 * процесс жив, это честное состояние длиной в секунды, и трогать его нельзя:
 * синк с сайтом прямо сейчас идёт. Но рестарт уносит всю работу в памяти, и на
 * старте такое состояние заведомо мёртвое — иначе уведомление осталось бы
 * незахватываемым: повторный «Принять» упирался бы в `resolution: null` и
 * честно отвечал 409 на правку, которую никто не разбирал.
 *
 * Зовётся из index.ts, как и досчёт оборванных стадий разговора, и по той же
 * причине: убирает за собой тот процесс, который потерял работу.
 */
export async function releaseInterruptedSiteEditClaims(): Promise<number> {
  const released = await prisma.siteEditNotification.updateMany({
    where: { resolvedAt: null, resolution: { not: null } },
    data: { resolution: null },
  });
  return released.count;
}

siteNotificationsRouter.post("/:id/resolve", requireAuth, requirePermission("siteChanges.resolve"), async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const outcome = await resolveOneNotification(req.params.id, parsed.data.resolution);
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  const updated = await prisma.siteEditNotification.findUnique({ where: { id: req.params.id } });
  res.json({ ...updated, propertyDeleted: outcome.propertyDeleted ?? false });
});

/**
 * «Разобрать все» — принять непросмотренные правки сайта как есть, одним
 * решением (жалоба владельца 15.09.2026: мусор копится, директор и админ его
 * видят, но убрать могут только по одному). Резолвится КАЖДОЕ уведомление той
 * же функцией, что и одиночная кнопка «Принять/Одобрить» — публикация на
 * сайте, применение правок к Property, мягкое удаление — а не только показанные
 * в списке 200 (GET / режет выборку, счётчик выше — нет).
 *
 * Отправка идёт ПОСЛЕДОВАТЕЛЬНО и в фоне, тем же приёмом, что и «Повторить всем
 * зависшим» в errorLog.ts: пачка может тянуть внешние вызовы (синк с сайтом) на
 * каждую запись, и синхронный ответ рисковал бы упереться в таймаут прокси
 * раньше, чем дойдёт до последней. Список уведомлений берём ЗАНОВО в момент
 * запуска, а не тот, что видел клиент секунды назад.
 */
/** Сколько уведомлений разбирает одно нажатие «Разобрать все» — см. комментарий ниже. */
const RESOLVE_ALL_LIMIT = 500;

siteNotificationsRouter.post("/resolve-all", requireAuth, requirePermission("siteChanges.resolve"), async (req, res) => {
  // ПРЕДЕЛ ВЫБОРКИ (22.09.2026, тот же класс, что #690). Выборка была без
  // потолка: накопилось тысяч десять неразобранных — и фоновый проход разбирает
  // их по одному запросу на запись, час подряд, держа соединения. Кнопка при этом
  // нажимается повторно, и проходов становится два. Потолок делает работу
  // порционной: сколько разобрали, столько и отдали, остальное следующим нажатием.
  const rows = await prisma.siteEditNotification.findMany({
    where: { resolvedAt: null },
    select: { id: true },
    take: RESOLVE_ALL_LIMIT,
  });
  // Сколько осталось за потолком — чтобы интерфейс мог сказать «разобрано 500,
  // осталось столько-то», а не сделать вид, что разобрал всё. Молчащий потолок
  // хуже отсутствия потолка: человек уходит с экрана уверенным, что очередь пуста.
  const remaining =
    rows.length < RESOLVE_ALL_LIMIT
      ? 0
      : (await prisma.siteEditNotification.count({ where: { resolvedAt: null } })) - rows.length;
  res.json({ queued: rows.length, remaining: Math.max(0, remaining) });
  if (rows.length === 0) return;

  void (async () => {
    let resolved = 0;
    for (const row of rows) {
      try {
        const outcome = await resolveOneNotification(row.id, "ACCEPTED");
        if (outcome.ok) resolved++;
      } catch (err) {
        await logSystemError("site-sync", `«Разобрать все» — уведомление ${row.id} не разобрано: ${describeError(err)}`);
      }
    }
    if (resolved < rows.length) {
      await logSystemError(
        "site-sync",
        `«Разобрать все»: разобрано ${resolved} из ${rows.length} уведомлений — часть отклонена сайтом, см. выше по журналу`
      );
    }
  })();
});
