/**
 * Конвейер подготовки объекта: проверка → фото → видео → монтаж → в продаже.
 *
 * ЗАЧЕМ. Раньше карточка появлялась сразу в состоянии «В продаже», даже когда у
 * объекта не было ни одной фотографии. Понять, чего ему не хватает и кто этим
 * сейчас занят, можно было только спросив людей вслух — а спрашивают обычно тогда,
 * когда объект уже неделю никуда не движется.
 *
 * ПРОСРОЧКА НЕ ДВИГАЕТ ОБЪЕКТ САМА. Она красит этап и попадает в список
 * просроченных, а решение остаётся за людьми: снимать нечего, если собственник не
 * открыл дверь, и автоматический перевод в следующее состояние спрятал бы ровно ту
 * проблему, ради которой конвейер и заводился.
 *
 * СРОКИ — В НАСТРОЙКАХ (решение владельца: ни одно число не остаётся в коде).
 * Здесь только значения на случай недоступной базы.
 */

import type { Request } from "express";
import {
  MIN_PROPERTY_PHOTOS,
  PROPERTY_PIPELINE_STATUSES,
  PROPERTY_STAGE_OWNER,
  type PropertyStageState,
  type PropertyStatus,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgent, sendPushToAgents, closeLeadPushNotifications } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "./scoreJournal.js";
import { logAudit, logSystemAudit } from "./audit.js";
import { isInstagramLink } from "./instagramLink.js";
import { syncPropertiesToSite } from "./siteSync.js";
import { logSystemError } from "./systemError.js";
import { notifyWaitingBuyersOfNewProperty } from "./propertyMatchFilter.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { shouldAlert } from "./notifications.js";
import { reportCronRowError } from "./cronHeartbeat.js";

/** Предохранитель по частоте (владелец 15.09.2026) — повторный аларм по одному
 *  и тому же поводу не чаще раза в сутки, см. doc-comment у shouldAlert в notifications.ts. */
const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Запасные сроки в днях — ровно те, что стоят умолчаниями колонок в схеме. */
const FALLBACK_DAYS: Partial<Record<PropertyStatus, number>> = {
  PENDING_REVIEW: 1,
  AWAITING_PHOTOS: 2,
  AWAITING_VIDEO: 2,
  EDITING: 2,
};

/** Срок в днях на каждый этап конвейера. Ключи — только состояния конвейера:
 *  у «В продаже» и «Продано» срока нет и быть не может. */
export type PipelineDeadlines = Record<(typeof PROPERTY_PIPELINE_STATUSES)[number], number>;

export async function loadPipelineDeadlines(): Promise<PipelineDeadlines> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        propertyReviewDays: true,
        propertyPhotoDays: true,
        propertyVideoDays: true,
        propertyEditingDays: true,
      },
    });
    return {
      PENDING_REVIEW: s?.propertyReviewDays ?? FALLBACK_DAYS.PENDING_REVIEW!,
      AWAITING_PHOTOS: s?.propertyPhotoDays ?? FALLBACK_DAYS.AWAITING_PHOTOS!,
      AWAITING_VIDEO: s?.propertyVideoDays ?? FALLBACK_DAYS.AWAITING_VIDEO!,
      EDITING: s?.propertyEditingDays ?? FALLBACK_DAYS.EDITING!,
    };
  } catch {
    return {
      PENDING_REVIEW: FALLBACK_DAYS.PENDING_REVIEW!,
      AWAITING_PHOTOS: FALLBACK_DAYS.AWAITING_PHOTOS!,
      AWAITING_VIDEO: FALLBACK_DAYS.AWAITING_VIDEO!,
      EDITING: FALLBACK_DAYS.EDITING!,
    };
  }
}

/**
 * Чего объекту не хватает, чтобы выйти в продажу. Пустая строка — всё на месте.
 *
 * ПРАВИЛО ВЛАДЕЛЬЦА (02.08.2026): последний этап подготовки — монтажёр публикует
 * видео-обзор в Instagram и вставляет ссылку в карточку. Пока ссылки нет, работа
 * не закончена, и объект в продажу не выходит, как бы ни хотелось поскорее.
 * Фотографии проверяем заодно: объект без единого снимка нечего показывать
 * клиенту, а до сих пор такой мог оказаться в продаже с первой же секунды.
 *
 * ПРОВЕРЯЕТСЯ ТОЛЬКО ВЫХОД ИЗ КОНВЕЙЕРА. Объект, который уже был в продаже,
 * требованию не подчиняется: отменённая сделка возвращает статус AVAILABLE, и
 * старая карточка без instagramUrl не должна блокировать отмену сделки — это
 * поломало бы работу ради правила, придуманного позже неё.
 */
/** Минимум фото объекта — определён в @royal-home/shared, чтобы экран одобрения и
 *  сервер считали по одному правилу. Реэкспорт: импорты по коду не трогаем. */
export { MIN_PROPERTY_PHOTOS };

export function blockersForSale(property: { instagramUrl: string | null; photoCount: number }): string[] {
  const blockers: string[] = [];
  if (property.photoCount < MIN_PROPERTY_PHOTOS) {
    blockers.push(`фото меньше минимума (${property.photoCount} из ${MIN_PROPERTY_PHOTOS})`);
  }
  // Пустое поле и заполненное «не тем» — РАЗНЫЕ сообщения, и это не придирка к
  // словам. Общее «нет ссылки» на карточке, где поле на глазах заполнено, уже
  // отправляло владельца заполнять заполненное (см. историю в lib/instagramLink.ts).
  const link = property.instagramUrl?.trim();
  if (!link) {
    blockers.push("нет ссылки на видео-обзор в Instagram");
  } else if (!isInstagramLink(link)) {
    blockers.push("в поле видео-обзора ссылка не на Instagram — обзор должен быть опубликован в Instagram");
  }
  return blockers;
}

/** Состояния конвейера — множеством, чтобы проверка «объект ещё готовится» была
 *  одной и той же во всех местах, а не тремя разными списками. */
export function isPipelineStatus(status: PropertyStatus): boolean {
  return (PROPERTY_PIPELINE_STATUSES as readonly PropertyStatus[]).includes(status);
}

// Описано один раз в @royal-home/shared: то же состояние читает значок этапа в
// интерфейсе. Прежнее имя оставлено псевдонимом — им пользуется остальной файл.
export type StageState = PropertyStageState;

/**
 * Состояние этапа для одного объекта.
 *
 * Чистая функция: сроки передаются снаружи, чтобы список из сотни объектов не сделал
 * сотню запросов в настройки. Ровно та же причина, по которой рубильники бота
 * читаются один раз на вебхук, а не на каждое сообщение.
 */
export function stageState(
  status: PropertyStatus,
  stageEnteredAt: Date,
  deadlines: PipelineDeadlines,
  now = new Date()
): StageState {
  const owner = PROPERTY_STAGE_OWNER[status] ?? null;
  const limitDays = (deadlines as Partial<Record<PropertyStatus, number>>)[status] ?? null;
  const daysInStage = Math.floor((now.getTime() - stageEnteredAt.getTime()) / (24 * 60 * 60 * 1000));
  return {
    inPipeline: owner !== null,
    owner,
    daysInStage,
    limitDays,
    // Строго больше: объект, вошедший в этап два дня назад при сроке в два дня,
    // просрочен ещё не сегодня, а завтра. Иначе красным горело бы всё, что успело
    // прожить ровно отведённое время.
    overdue: limitDays !== null && daysInStage > limitDays,
  };
}

/**
 * Просрочка этапов «Ожидает фото» / «Ожидает видео» — штраф Royal Score
 * (таблица владельца, п. 21-22) для ответственного за объект.
 *
 * ОДИН ШТРАФ НА ВЕСЬ ПРОСТОЙ, А НЕ ЗА КАЖДЫЙ ТИК. sourceId = id объекта: пока
 * объект не покидал этот этап, уникальность (kind, sourceId) в журнале не даст
 * записать событие повторно — тот же приём, что и в notifyOverdueTasks. Если
 * объект уйдёт с этапа и вернётся на него снова (возврат на доработку), второй
 * штраф уже не спишется — id объекта тот же. Компромисс в пользу простоты,
 * симметричный остальным «overdue»-джобам.
 *
 * PUSH — ТОЖЕ РОВНО ОДИН, А НЕ КАЖДЫЙ ЧАС. У Property нет своего поля-отметки
 * (в отличие от Interaction.noShowNotifiedAt) — заводить миграцию ради одного
 * булева поля дороже, чем спросить сам журнал: если событие уже записано, тик
 * не первый, и push отправлять незачем. Проверяем ДО recordScoreEvent (он
 * fire-and-forget и не гарантирует, что запись видна тут же), а не после.
 */
export async function notifyOverdueMaterials(now: Date = new Date()): Promise<number> {
  const [deadlines, properties, rawReviewRequired] = await Promise.all([
    loadPipelineDeadlines(),
    prisma.property.findMany({
      // deletedAt: null (27.08.2026) — мягкое удаление объекта только снимает его
      // с сайта, статус не трогает. Без фильтра крон штрафовал Royal Score и слал
      // пуш руководству за материалы объекта, лежащего в Корзине — соседи по
      // тому же тику (requirePropertySummaries, releaseExpiredReservations,
      // refreshPropertyStatusesByTime) этот фильтр уже имеют.
      /**
       * EDITING добавлен 09.09.2026 (решение владельца). Объект, лежащий у
       * монтажёра, не производил задачи ни у кого: владелец уже одобрил материалы
       * и считает, что дело идёт, а `stageState` честно красит просрочку на
       * карточке — но никто туда не смотрит. Это единственный этап конвейера,
       * где объект лежит МЕЖДУ людьми и его никто не ждёт.
       */
      where: { deletedAt: null, status: { in: ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"] } },
      select: {
        id: true,
        shortId: true,
        title: true,
        status: true,
        stageEnteredAt: true,
        intakeAgentId: true,
        assignedAgentId: true,
        createdById: true,
      },
    }),
    isRawReviewRequired(),
  ]);
  if (properties.length === 0) return 0;

  const overdueIds = properties
    .filter((p) => stageState(p.status, p.stageEnteredAt, deadlines, now).overdue)
    .map((p) => p.id);
  if (overdueIds.length === 0) return 0;

  const alreadyScored = await prisma.royalScoreEvent.findMany({
    where: { kind: { in: ["photos_overdue", "video_overdue"] }, sourceId: { in: overdueIds } },
    select: { sourceId: true },
  });
  const alreadyScoredIds = new Set(alreadyScored.map((e) => e.sourceId));

  const points = await loadEventPoints();
  let notified = 0;

  for (const property of properties) {
    // Сбой одной записи не обрывает остальные (E8 глубокой проверки 02.10.2026, класс №173).
    try {
      if (!overdueIds.includes(property.id)) continue;

      /**
       * БАГ (прод №85, 17 дней): PENDING_REVIEW не входил в этот крон — просрочка
       * модерации только красила карточку (stageState), никого не алармила. Как и
       * EDITING, это не вина агента (он уже сдал материалы, ждём проверяющего), а
       * значит royalScoreEvent/штраф не пишем — только пуш тому, кто может
       * одобрить (properties.moderate), через ту же очередь алармов руководству.
       */
      if (property.status === "PENDING_REVIEW") {
        // Рубильник «проверка исходников» (25.09.2026) меняет ДЕЙСТВИЕ, а не
        // видимость (07.10.2026): раньше при выключенной проверке здесь стоял
        // `continue`, и объект, застрявший на PENDING_REVIEW, висел вечно, не
        // попадая никому на глаза. Модератору такой объект не показываем — ему
        // нечего одобрять, — но руководство (clients.assign) о нём узнаёт.
        const tag = `pending-review-overdue-${property.id}`;
        // Предохранитель: без него этот безусловный вызов на каждом часовом тике
        // и есть источник счётчика 128 на проде (повод не устранён — тик есть).
        if (await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now)) {
          const daysInStage = stageState(property.status, property.stageEnteredAt, deadlines, now).daysInStage;
          await enqueueDirectorAlert(
            rawReviewRequired
              ? {
                  title: "🔎 Объект просрочен на проверке",
                  body: `${property.title} — на модерации ${daysInStage} дн., фото/видео не одобрены и не отклонены`,
                  url: `/properties/${property.shortId}`,
                  tag,
                  recipientPermission: "properties.moderate",
                }
              : {
                  title: "🔎 Объект завис на проверке",
                  body: `${property.title} — ${daysInStage} дн. в статусе «на проверке» при выключенной проверке: не хватает фото или видео`,
                  url: `/properties/${property.shortId}`,
                  tag,
                  recipientPermission: "clients.assign",
                }
          );
        }
        notified++;
        continue;
      }

      const responsibleId = property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
      if (!responsibleId) continue;

      /**
       * МОНТАЖ — НЕ ЭТАП АГЕНТА, И ШТРАФА ЗА НЕГО НЕТ. Материалы он сдал, владелец
       * их одобрил; дальше объект у монтажёра, и наказывать за это агента значило
       * бы наказывать за чужую работу. Уведомление уходит, штраф — нет.
       */
      if (property.status === "EDITING") {
        const tag = `editing-overdue-${property.id}`;
        // await, а не fire-and-forget: это крон-тик, ждать некому, зато счётчик
        // notified становится честным, а тест — воспроизводимым.
        // Предохранитель — та же причина, что у PENDING_REVIEW выше: этот вызов
        // раньше был безусловным на каждый тик.
        if (await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now)) {
          await enqueueDirectorAlert({
            title: "🎬 Объект стоит на монтаже",
            body: `${property.title} — материалы одобрены, готового видео нет ${
              stageState(property.status, property.stageEnteredAt, deadlines, now).daysInStage
            } дн.`,
            url: `/properties/${property.shortId}`,
            tag,
            recipientPermission: "properties.moderate",
          });
        }
        notified++;
        continue;
      }

      const kind: ScoreEventKind = property.status === "AWAITING_PHOTOS" ? "photos_overdue" : "video_overdue";
      if (alreadyScoredIds.has(property.id)) continue;

      recordScoreEvent({
        agentId: responsibleId,
        kind,
        delta: points[kind],
        reason:
          kind === "photos_overdue"
            ? "Фотографии объекта не сданы в срок"
            : "Видео объекта не сдано в срок",
        sourceId: property.id,
      });

      // Часы алармов (владелец 07.09.2026): штраф выше уже начислен сразу
      // (idempotent через royalScoreEvent, не ждёт часов алармов) — откладывается
      // только пуш руководству о нём.
      // Штраф идемпотентен через royalScoreEvent, а пуш — нет: при выключенном Royal Score
      // событие не пишется, и без этой проверки очередь пополнялась бы на каждый тик.
      const materialsTag = `materials-overdue-${property.id}`;
      if (await shouldAlert(materialsTag, ALERT_MIN_INTERVAL_MS, now)) {
        await enqueueDirectorAlert({
          title: kind === "photos_overdue" ? "❗ Фото объекта просрочены" : "❗ Видео объекта просрочено",
          body: `${property.title} — этап «${property.status === "AWAITING_PHOTOS" ? "Ожидает фото" : "Ожидает видео"}» превысил срок`,
          url: `/properties/${property.shortId}`,
          tag: materialsTag,
          recipientPermission: "clients.assign",
        });
      }
      notified++;
    } catch (err) {
      reportCronRowError("Просрочка этапа объекта", property.shortId, err);
    }
  }
  return notified;
}

/**
 * СТОРОЖ «МАТЕРИАЛОВ НЕТ — ОБЪЕКТ ЖДЁТ» (07.10.2026, владелец: «ролики и фото всегда
 * дозагружаются, агент видит процесс»). Живой случай: видео не догрузилось, объект
 * и фото созданы, ролика нет, и никто не узнал — объект висел на проверке без
 * единого человека, которому об этом сказано.
 *
 * Отдельно от notifyOverdueMaterials намеренно: тот сторож считает ПРОСРОЧКУ этапа
 * в днях (настройки владельца), красит штраф Royal Score и молчит у объекта без
 * ответственного. Этот — про факт «материала нет» через считаные часы, не привязан
 * ни к штрафу, ни к наличию `responsibleId`. Штрафы и баллы здесь не затрагиваются.
 *
 *  1. PENDING_REVIEW без единого видео дольше STUCK_VIDEO_AFTER_HOURS (независимо от
 *     рубильника rawReviewRequired): пуш принявшему агенту «видео не догружено»,
 *     один аларм руководству, на третьи сутки — ещё и директору. Повтор раз в сутки.
 *  2. AWAITING_PHOTOS / AWAITING_VIDEO старше STUCK_AWAITING_AFTER_HOURS без материала
 *     (нет ни одного фото / ни одного видео): суточный аларм ответственному,
 *     а при его отсутствии (нет ни принявшего, ни назначенного, ни создателя) —
 *     директору и администратору.
 *
 * Несайтовые объекты (offSite) не ждут видео вовсе — им нужны только фото.
 */
export const STUCK_VIDEO_AFTER_HOURS = 12;
export const STUCK_AWAITING_AFTER_HOURS = 24;
export const STUCK_ESCALATE_AFTER_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;

export async function notifyStuckMaterials(now: Date = new Date()): Promise<number> {
  const videoCutoff = new Date(now.getTime() - STUCK_VIDEO_AFTER_HOURS * HOUR_MS);
  const awaitingCutoff = new Date(now.getTime() - STUCK_AWAITING_AFTER_HOURS * HOUR_MS);
  const properties = await prisma.property.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: "PENDING_REVIEW", offSite: false, stageEnteredAt: { lte: videoCutoff }, videos: { none: {} } },
        { status: "AWAITING_PHOTOS", stageEnteredAt: { lte: awaitingCutoff }, photos: { none: {} } },
        { status: "AWAITING_VIDEO", offSite: false, stageEnteredAt: { lte: awaitingCutoff }, videos: { none: {} } },
      ],
    },
    select: {
      id: true,
      shortId: true,
      title: true,
      status: true,
      stageEnteredAt: true,
      intakeAgentId: true,
      assignedAgentId: true,
      createdById: true,
    },
    orderBy: { stageEnteredAt: "asc" },
    take: 500,
  });

  let notified = 0;
  for (const property of properties) {
    // Сбой одной записи не обрывает остальные (тот же приём, что в notifyOverdueMaterials).
    try {
      const url = `/properties/${property.shortId}`;
      const hoursInStage = Math.floor((now.getTime() - property.stageEnteredAt.getTime()) / HOUR_MS);

      if (property.status === "PENDING_REVIEW") {
        const tag = `video-missing-${property.id}`;
        if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) continue;
        const agentId = property.intakeAgentId ?? property.createdById;
        if (agentId) {
          await sendPushToAgent(agentId, {
            title: "🎥 Видео не догружено",
            body: `${property.title} — видео нет уже ${hoursInStage} ч. Откройте объект и добавьте ролик`,
            url,
            tag,
          });
        }
        await enqueueDirectorAlert({
          title: "🎥 У объекта нет видео",
          body: `${property.title} — на проверке ${hoursInStage} ч без единого видео, агент не догрузил ролик`,
          url,
          tag: `video-missing-lead-${property.id}`,
          recipientPermission: "clients.assign",
        });
        if (hoursInStage >= STUCK_ESCALATE_AFTER_HOURS) {
          await enqueueDirectorAlert({
            title: "🎥 Объект третьи сутки без видео",
            body: `${property.title} — видео так и не добавлено (${Math.floor(hoursInStage / 24)} дн.)`,
            url,
            tag: `video-missing-escalate-${property.id}`,
            recipientRoles: ["DIRECTOR"],
          });
        }
        notified++;
        continue;
      }

      // AWAITING_PHOTOS / AWAITING_VIDEO — суточный аларм без привязки к штрафу.
      const tag = `materials-missing-${property.id}`;
      if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) continue;
      const awaitingPhotos = property.status === "AWAITING_PHOTOS";
      const title = "📷 У объекта нет материалов";
      const body = `${property.title} — ${hoursInStage} ч в этапе «${
        awaitingPhotos ? "Ожидает фото" : "Ожидает видео"
      }», ${awaitingPhotos ? "фото" : "видео"} не загружено`;
      const responsibleId = property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
      if (responsibleId) {
        await sendPushToAgent(responsibleId, { title, body, url, tag });
      } else {
        await enqueueDirectorAlert({ title, body, url, tag, recipientRoles: ["DIRECTOR", "ADMIN"] });
      }
      notified++;
    } catch (err) {
      reportCronRowError("Материалов нет у объекта", property.shortId, err);
    }
  }
  return notified;
}

/**
 * Пуш тем, кто может одобрить/отклонить материалы (properties.moderate) — то же
 * право, что и кнопка «Одобрить». Раньше объект попадал в очередь молча: маркетинг
 * узнавал о новой карточке, только заглянув в список руками. Вызывается и при
 * создании объекта (сразу PENDING_REVIEW), и при возврате после доработки
 * (videoAutoRevert в PATCH /:id) — оба места переводят статус ровно один раз за
 * запрос, поэтому дублирования при одном вызове не возникает.
 *
 * МОНТАЖЁРА ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ (решение 16.08.2026). Просьба звучала как
 * «монтажёр хочет узнавать о работе раньше, чем “передан в монтаж”», и заманчиво
 * было добавить его в получатели этого пуша. Но на PENDING_REVIEW объекта ещё
 * нет как работы: у него нет ни одобренных фото, ни видео, а часть карточек
 * уходит на доработку и до монтажа не доходит вовсе. Пуш на каждую заведённую
 * карточку — это шум с задержкой в несколько дней до момента, когда по нему
 * можно что-то сделать; шум такого рода люди отключают целиком, и вместе с ним
 * теряется единственное сообщение, которое монтажёру действительно нужно
 * («передан в монтаж», notifyEditingStarted ниже).
 *
 * Потребность «планировать» закрыта не пушем, а видимостью: на Главной у
 * монтажёра стоит блок «Скоро на монтаж» — объекты этапа AWAITING_VIDEO
 * (GET /marketing/editor-queue). Он смотрит туда сам, когда планирует, и не
 * получает уведомления, на которое нельзя ответить действием.
 */
/**
 * Подписчики «объект встал на проверку». Модуль модерации в Telegram
 * подписывается сам (onPendingReview в telegramModeration.ts): прямой импорт
 * отсюда замыкал цикл propertyPipeline → telegramModeration → propertyReview →
 * propertyPipeline, который ловит audit:deps.
 */
type PendingReviewListener = (propertyId: string) => Promise<void>;
const pendingReviewListeners: PendingReviewListener[] = [];
export function onPendingReview(listener: PendingReviewListener): void {
  pendingReviewListeners.push(listener);
}

/**
 * ПРОВЕРКА ИСХОДНИКОВ ВЫКЛЮЧЕНА (25.09.2026, владелец: «выключи временно
 * одобрение роликов от агентов — пусть сразу идут монтажёру»). Settings.
 * rawReviewRequired = false: объект, вставший на проверку, модераторам не
 * показывается — ни пушем, ни в Telegram, — а одобряется самой CRM, как только
 * у него есть фото и видео (lib/propertyReview.ts::autoApproveIfRawReviewOff).
 * Одобрение подписывается сюда тем же приёмом, что и Telegram выше: прямой
 * импорт propertyReview отсюда замкнул бы цикл.
 */
type RawReviewBypass = (propertyId: string) => Promise<unknown>;
const rawReviewBypassListeners: RawReviewBypass[] = [];
export function onRawReviewBypass(listener: RawReviewBypass): void {
  rawReviewBypassListeners.push(listener);
}

/** Нужна ли проверка фото и видео агента человеком. Нет строки настроек — нужна. */
export async function isRawReviewRequired(): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { rawReviewRequired: true } });
  return settings?.rawReviewRequired ?? true;
}

export async function notifyPendingReview(propertyId: string, shortId: number, title: string): Promise<void> {
  if (!(await isRawReviewRequired())) {
    // Ждать нечего и некого: CRM одобрит сама, если фото и видео уже есть; если
    // видео ещё нет — одобрит при его загрузке (routes/properties/videos.ts).
    for (const listener of rawReviewBypassListeners) await listener(propertyId);
    return;
  }
  // Модераторам в Telegram (22.09.2026) — отдельно и не дожидаясь: отправка альбомов
  // и видео идёт минутами, а сбой Telegram не должен трогать пуш CRM ниже.
  for (const listener of pendingReviewListeners) {
    void listener(propertyId).catch((err) => console.error("[pending-review] подписчик:", err));
  }
  const moderators = await findAgentsWithPermission("properties.moderate");
  if (moderators.length === 0) return;
  await sendPushToAgents(moderators, {
    title: "🏠 Объект ждёт проверки",
    body: `${title} — фото и видео нужно одобрить или вернуть на доработку`,
    url: `/properties/${shortId}`,
    // Первый уровень владельца: пока фото и видео не одобрены, объект не идёт
    // в продажу — работа агента и продавца стоит (NOTIFICATION_LEVELS).
    level: "APPROVAL",
    tag: `property-pending-review-${propertyId}`,
  });
}

/**
 * Один модератор одобрил или вернул на доработку — у ОСТАЛЬНЫХ с правом
 * properties.moderate пуш «Объект ждёт проверки» гасим: карточка их очереди уже
 * не касается, а провисевший пуш выглядит так, будто её никто не тронул.
 */
export async function closePendingReviewPush(propertyId: string): Promise<void> {
  const moderators = await findAgentsWithPermission("properties.moderate");
  const tag = `property-pending-review-${propertyId}`;
  await closeLeadPushNotifications(moderators.map((id) => ({ agentId: id, tag })));
}

/**
 * ВОЗВРАТ НА ПРОВЕРКУ ПОСЛЕ ДОЗАГРУЗКИ ВИДЕО — зеркало автовозврата по фото
 * (routes/properties.ts, POST /:id/photos).
 *
 * Раньше объект, отправленный маркетингом на доработку видео, возвращался на
 * проверку только когда в карточку вписывали ссылку на Instagram. Но ждут на этом
 * этапе не ссылку, а НОВЫЕ СЫРЫЕ РОЛИКИ агента (владелец 17.08.2026): ссылку
 * делает монтажёр, и двумя этапами позже. То есть агент мог переснять и залить
 * видео, а объект оставался «Ждём видео» навсегда — работа сделана, конвейер стоит.
 *
 * Вызывается из обоих путей загрузки: обычного POST /:id/videos и докачки
 * многочастевой сессии. Молча выходит, если объект не ждал видео.
 */
export async function revertToReviewAfterVideoUpload(property: {
  id: string;
  shortId: number;
  title: string;
  status: PropertyStatus;
  videoRejectionCount: number;
  intakeAgentId: string | null;
  assignedAgentId: string | null;
  createdById: string | null;
}): Promise<void> {
  if (property.status !== "AWAITING_VIDEO") return;
  await prisma.property.update({
    where: { id: property.id },
    data: {
      status: "PENDING_REVIEW",
      stageEnteredAt: new Date(),
      reviewRejectionReason: null,
      reviewRejectionVoiceUrl: null,
      reviewRejectionVoiceTranscript: null,
    },
  });
  const responsibleId = property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
  if (responsibleId) {
    const points = await loadEventPoints();
    recordScoreEvent({
      agentId: responsibleId,
      kind: "property_rework_fixed",
      delta: points.property_rework_fixed,
      reason: "Новое видео загружено — объект возвращён на проверку",
      sourceId: `reject-${property.id}-video-${property.videoRejectionCount}`,
    });
  }
  await notifyPendingReview(property.id, property.shortId, property.title);
}

/**
 * Пуш монтажёрам (properties.aiListing — то же право, что и подпись под Reels),
 * когда объект попадает в монтаж — оба материала уже одобрены маркетингом.
 */
export async function notifyEditingStarted(propertyId: string, shortId: number, title: string): Promise<void> {
  const editors = await findAgentsWithPermission("properties.aiListing");
  if (editors.length === 0) return;
  await sendPushToAgents(editors, {
    title: "🏠 Объект передан в монтаж",
    body: `${title} — фото и видео одобрены, нужен видео-обзор в Instagram`,
    url: `/properties/${shortId}`,
    tag: `property-editing-${propertyId}`,
  });
}

/**
 * Объект ушёл из монтажа (ссылка на Reels вписана и объект опубликован, или
 * статус сменили вручную) — у остальных монтажёров пуш «Объект передан в
 * монтаж» гасим тем же способом, что и closePendingReviewPush выше.
 */
export async function closeEditingPush(propertyId: string): Promise<void> {
  const editors = await findAgentsWithPermission("properties.aiListing");
  const tag = `property-editing-${propertyId}`;
  await closeLeadPushNotifications(editors.map((id) => ({ agentId: id, tag })));
}

/**
 * Пуш ответственному за объект, когда конвейер выпустил карточку в продажу.
 * Ответственный — тот же, кому летят напоминания о просрочке (notifyOverdueMaterials
 * выше): intakeAgentId (принял объект) ?? assignedAgentId ?? createdById. Раньше
 * этот переход конвейера был единственным без единого пуша: агент, заведший объект
 * и неделю ждавший подготовки, узнавал, что объект наконец в продаже, только
 * заглянув в список сам.
 */
async function notifyPublished(
  propertyId: string,
  shortId: number,
  title: string,
  responsibleId: string | null
): Promise<void> {
  if (!responsibleId) return;
  await sendPushToAgent(responsibleId, {
    title: "✅ Объект в продаже",
    body: `${title} — подготовка завершена, карточка опубликована`,
    url: `/properties/${shortId}`,
    tag: `property-published-${propertyId}`,
  });
}

/**
 * ВЫХОД ИЗ МОНТАЖА → ПУБЛИКАЦИЯ. Общий код-путь для двух вызовов: ручная кнопка
 * «Готово» (POST /:id/complete-editing) и автопубликация из PATCH, когда монтажёр
 * вписывает ссылку на Reels, а blockersForSale() уже пуст (решение владельца
 * 05.08.2026 — кнопку руками жать не нужно). Раньше это была одна копия кода
 * внутри complete-editing — вынесено сюда, чтобы автопуть не разъезжался с
 * ручным (сырое видео, аудит, синхронизация с сайтом — везде один и тот же шаг).
 *
 * Ожидает объект УЖЕ переведённым в AVAILABLE (вызывающий код сам решает, в какой
 * транзакции менять статус — при автопути это та же транзакция, что и остальной
 * PATCH). Здесь — только сайд-эффекты публикации, которые нельзя завести дважды.
 */
export async function publishAfterEditingComplete(
  /** null — конвейер закрывает не HTTP-запрос, а фоновая публикация ролика от
   *  монтажёра (lib/videoHandoff.ts): аудит пишется от имени «Система». */
  req: Request | null,
  property: {
    id: string;
    shortId: number;
    title: string;
    intakeAgentId?: string | null;
    assignedAgentId?: string | null;
    createdById?: string | null;
  }
): Promise<{ updated: Awaited<ReturnType<typeof prisma.property.update>>; siteSyncError?: string }> {
  // Пишем в историю СРАЗУ после смены статуса, а не после успешной публикации на
  // сайт: то, что объект вышел из конвейера, — случившийся в CRM факт независимо
  // от того, ответит ли внешний сайт.
  if (req) logAudit(req, "PROPERTY_EDITING_DONE", "Property", property.id, { shortId: property.shortId, title: property.title });
  else logSystemAudit("PROPERTY_EDITING_DONE", "Property", property.id, { shortId: property.shortId, title: property.title });

  // Тот же факт «объект вышел из конвейера» — повод уведомить того, кто его завёл.
  // Fire-and-forget, как и остальные пуши конвейера: отсутствие подписки/пуша не
  // должно блокировать публикацию.
  const responsibleId = property.intakeAgentId ?? property.assignedAgentId ?? property.createdById ?? null;
  void notifyPublished(property.id, property.shortId, property.title, responsibleId).catch((err) =>
    console.error("[push] объект опубликован:", err)
  );

  // Сырое видео синхронно здесь больше НЕ удаляется (решение владельца
  // 20.09.2026: кнопка «Вернуть монтажёру» упиралась в «исходники уже стёрты» —
  // владелец нажал её в тот же день монтажа и получил отказ). Удаление теперь
  // только через cleanupStalePropertyVideos (lib/propertyVideoCleanup.ts) — там
  // же и порог хранения RAW_VIDEO_RETENTION_DAYS с замером диска, обосновавшим
  // 30 дней вместо «сразу».

  const withRelations = await prisma.property.findUnique({
    where: { id: property.id },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  if (!withRelations) {
    throw new Error(`publishAfterEditingComplete: объект ${property.id} не найден после смены статуса`);
  }

  // Конвейер выпустил объект в продажу — повод проверить, не ждёт ли его уже
  // какой-то покупатель (docs/auto-match-alert-plan-31-08-2026.md). Fire-and-forget
  // и до попытки синхронизации с сайтом: отказ сайта — отдельная проблема, агент
  // клиента про подходящий объект узнать не должен ждать её починки.
  void notifyWaitingBuyersOfNewProperty(withRelations).catch((err) =>
    console.error("[автоподбор] объект вышел из конвейера:", err instanceof Error ? err.message : err)
  );

  const result = await syncPropertiesToSite([withRelations], "publish");
  if (!result.ok || result.results.some((r) => !r.ok)) {
    // Статус в CRM уже сменился — откатывать его не нужно (объект честно готов,
    // просто ждёт публикации): ответственный видит явную ошибку сайта и повторяет
    // публикацию отдельной кнопкой на карточке, когда сайт снова доступен.
    const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
    void logSystemError(
      "site-sync",
      `Выход из монтажа у ${property.id}: объект переведён в продажу, но сайт отказал: ${problem}`,
      { url: `/properties/${property.shortId}` }
    );
    /**
     * ОТКАЗ ПУБЛИКАЦИИ — СТРОКА ВЛАДЕЛЬЦУ, А НЕ ТОЛЬКО ЖУРНАЛ (владелец 09.09.2026).
     *
     * Раньше отказ уходил в logSystemError и на этом заканчивался — то есть в
     * технический журнал, который никто не открывает. Объект при этом в CRM «в
     * продаже», на сайте его нет, ссылки нет, и все таймеры по нему идут как по
     * продающемуся. Агент говорит продавцу «ваш объект на сайте», и узнать правду
     * можно было только от самого продавца.
     *
     * Без выдержки: это поломка, а не чья-то медлительность, ждать нечего.
     */
    void enqueueDirectorAlert({
      title: "⚠️ Объект не вышел на сайт",
      body: `${property.title} — монтаж закончен, но публикация не прошла: ${problem ?? "сайт недоступен"}`,
      url: `/properties/${property.shortId}`,
      tag: `publish-failed-${property.id}`,
      recipientPermission: "properties.moderate",
    });
    return { updated: withRelations, siteSyncError: problem ?? "Сайт недоступен" };
  }

  const published = await prisma.property.update({ where: { id: property.id }, data: { publishedOnSite: true } });
  return { updated: published };
}
