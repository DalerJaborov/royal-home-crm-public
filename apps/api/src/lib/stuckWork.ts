import { Prisma, type BackgroundJob } from "../generated/prisma/client.js";
import { channelLabel, parsePermissionOverrides, resolvePermissions } from "@royal-home/shared";
import { publicBackgroundJobSql, isPrivateBackgroundJob, countVisibleBackgroundJobs } from "./backgroundJobPrivacy.js";
import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { notifyFeedOnly } from "./notifications.js";

/**
 * ВИДИМОСТЬ ЗАСТРЯВШЕЙ РАБОТЫ (владелец 21.09.2026): «ничто никогда не
 * теряется и спустя время всё равно доезжает» — очередь `BackgroundJob`
 * (jobs/runner.ts) умеет повторять и уже подбирает зависшие RUNNING, но до
 * этого модуля НИКТО не видел глазами, что именно застряло и что сдалось.
 * Повод — объект №114: ролик принят, но выкат посреди публикации оставил его
 * молча «не опубликован» до утра.
 *
 * Три вещи с разной судьбой:
 *  - GIVEN_UP — попытки исчерпаны, runner.ts уже прогнал onGiveUp/logSystemError
 *    один раз; здесь — экран и уведомление хозяину, а не повторный механизм отказа;
 *  - PENDING дольше PENDING_OVERDUE_MIN после своего runAt — исполнитель
 *    (тик раз в минуту) не успевает: живой признак, что воркер не справляется;
 *  - RUNNING дольше RUNNING_STUCK_MIN — тот же порог, что и подбор зависших в
 *    runner.ts (STUCK_RUNNING_MIN), но ПОКАЗЫВАЕМ раньше, чем воркер САМ его
 *    подберёт на следующем тике: человек видит зависание, не дожидаясь автоподбора.
 */

/** PENDING старше своего runAt на этот срок — тик раз в минуту явно не успевает. */
const PENDING_OVERDUE_MIN = 10;
/** Тот же смысл, что STUCK_RUNNING_MIN в jobs/runner.ts — воркер умер между run и DONE. */
const RUNNING_STUCK_MIN = 15;

function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60_000);
}

/**
 * Русские названия типов фоновых заданий (ночная проверка 01.10.2026, №240):
 * человек видел на экране «Что не доехало» и в пуше сырой код вроде
 * `seller-photo-insight`. Словарь лежит здесь, а не в packages/shared: оба
 * места, где он нужен (подпись строки и текст уведомления), собираются на
 * сервере, а экран получает готовое `typeLabel`. Новый обработчик очереди без
 * строки здесь ловит tests/stuck-work-type-labels.test.ts.
 */
export const JOB_TYPE_LABELS: Record<string, string> = {
  "ai-reply-retry": "Повтор ответа бота клиенту",
  "ai-turn-blocked-followup": "Дозапрос после остановки бота",
  "client-reactivation": "Возврат клиента в работу",
  "clip-compress": "Сжатие видео объекта",
  "deal-close-followup": "Напоминание после закрытия сделки",
  "deal-review-ask": "Просьба оставить отзыв о сделке",
  "deferred-push": "Отложенное уведомление",
  "geo-match-sweep": "Ночной подбор объектов по карте",
  geocode: "Определение адреса на карте",
  "photo-post-publish": "Публикация фото-поста",
  "recording-search-retry": "Поиск записи разговора",
  "seller-facts": "Разбор фактов из переписки с продавцом",
  "seller-photo-insight": "Оценка фото продавца",
  "site-resync": "Обновление объекта на сайте",
  "social-repost-publish": "Повторный показ объекта в соцсетях",
  "social-video-publish": "Публикация свободного ролика в соцсети",
  "telegram-dm-reply-retry": "Повтор ответа в личных сообщениях Telegram",
  "telegram-reply-retry": "Повтор ответа в Telegram",
  "tiktok-publish-retry": "Повторная публикация в TikTok",
  "transcription-retry": "Расшифровка разговора",
  "video-handoff-publish": "Публикация ролика от монтажёра",
  "video-opening": "Оценка начала ролика",
};

/** Русское название типа задания; незнакомый тип — общее слово, а не сырой код. */
export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? "Фоновое задание";
}

export interface StuckWorkItem {
  id: string;
  type: string;
  /** Название типа по-русски (JOB_TYPE_LABELS) — на экране вместо сырого `type`. */
  typeLabel: string;
  status: "GIVEN_UP" | "PENDING" | "RUNNING";
  label: string;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: Date;
  updatedAt: Date;
}

/**
 * Человекочитаемое описание задания + хозяин (кто может что-то сделать) —
 * best-effort по полям payload, конкретным для каждого типа обработчика
 * (jobs/*.ts). Неизвестный тип или пропавшая запись — честная строка вместо
 * падения: список не должен рушиться из-за одной устаревшей записи.
 */
async function describeJob(type: string, payload: unknown): Promise<{ label: string; ownerAgentId: string | null }> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  try {
    switch (type) {
      case "geocode":
      case "clip-compress":
      case "site-resync":
      case "geo-match-sweep":
      // Публикация ролика от монтажёра (случай №114, 21.09.2026) —
      // jobs/videoHandoffPublish.ts, тот же payload {propertyId}.
      // Отложенный повтор публикации в TikTok (23.09.2026) — тот же payload
      // {propertyId}, и сдаётся он так же: человеку, хозяину объекта.
      // Фото-посты для объектов без ролика (28.09.2026, jobs/photoPostPublish.ts)
      // — тот же payload {propertyId}.
      // Повторный показ объекта (28.09.2026, jobs/socialRepostPublish.ts) —
      // тот же payload {propertyId, ...}, хозяин ищется так же.
      case "tiktok-publish-retry":
      case "photo-post-publish":
      case "social-repost-publish":
      case "video-handoff-publish": {
        const propertyId = str(p.propertyId);
        if (!propertyId) break;
        const property = await prisma.property.findUnique({
          where: { id: propertyId },
          select: { shortId: true, title: true, assignedAgentId: true },
        });
        if (!property) return { label: `Объект удалён (${propertyId.slice(0, 8)})`, ownerAgentId: null };
        return { label: `Объект №${property.shortId} «${property.title}»`, ownerAgentId: property.assignedAgentId };
      }
      // Разбор фактов и оценка фото продавца (добавлены 21.09.2026) — тот же
      // payload {clientId}, что и у "client-reactivation" (ночная проверка
      // 24.09.2026: без этих case попадали в default и показывались голой
      // английской строкой типа, без клиента и хозяина).
      // Свободный ролик (12.10.2026, jobs/socialVideoPublish.ts): payload {id} — запись SocialVideoPost, хозяин — автор.
      case "social-video-publish": {
        const videoId = str(p.id);
        if (!videoId) break;
        const video = await prisma.socialVideoPost.findUnique({ where: { id: videoId }, select: { title: true, createdById: true } });
        if (!video) return { label: `Свободный ролик удалён (${videoId.slice(0, 8)})`, ownerAgentId: null };
        return { label: `Свободный ролик «${video.title}»`, ownerAgentId: video.createdById };
      }
      case "seller-facts":
      case "seller-photo-insight":
      case "client-reactivation": {
        const clientId = str(p.clientId);
        if (!clientId) break;
        const client = await prisma.client.findUnique({
          where: { id: clientId },
          select: { shortId: true, fullName: true, assignedAgentId: true },
        });
        if (!client) return { label: `Клиент удалён (${clientId.slice(0, 8)})`, ownerAgentId: null };
        return { label: `Клиент №${client.shortId} «${client.fullName}»`, ownerAgentId: client.assignedAgentId };
      }
      case "deal-close-followup":
      case "deal-review-ask": {
        const dealId = str(p.dealId);
        if (!dealId) break;
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          select: { agentId: true, property: { select: { shortId: true, title: true } } },
        });
        if (!deal) return { label: `Сделка удалена (${dealId.slice(0, 8)})`, ownerAgentId: null };
        return {
          label: `Сделка по объекту №${deal.property.shortId} «${deal.property.title}»`,
          ownerAgentId: deal.agentId,
        };
      }
      case "ai-reply-retry":
      case "ai-turn-blocked-followup": {
        const conversationId = str(p.conversationId);
        if (!conversationId) break;
        const conv = await prisma.botConversation.findUnique({
          where: { id: conversationId },
          select: { channel: true, client: { select: { shortId: true, fullName: true, assignedAgentId: true } } },
        });
        if (!conv) return { label: `Диалог удалён (${conversationId.slice(0, 8)})`, ownerAgentId: null };
        return {
          // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
          label: conv.client
            ? `Диалог с клиентом №${conv.client.shortId} «${conv.client.fullName}» (${channelLabel(conv.channel)})`
            : `Диалог без карточки клиента (${channelLabel(conv.channel)})`,
          ownerAgentId: conv.client?.assignedAgentId ?? null,
        };
      }
      case "telegram-reply-retry": {
        const conversationId = str(p.conversationId);
        if (!conversationId) break;
        const conv = await prisma.telegramConversation.findUnique({
          where: { id: conversationId },
          select: { client: { select: { shortId: true, fullName: true, assignedAgentId: true } } },
        });
        if (!conv) return { label: `Telegram-диалог удалён (${conversationId.slice(0, 8)})`, ownerAgentId: null };
        return {
          label: conv.client
            ? `Telegram-диалог с клиентом №${conv.client.shortId} «${conv.client.fullName}»`
            : "Telegram-диалог без карточки клиента",
          ownerAgentId: conv.client?.assignedAgentId ?? null,
        };
      }
      case "telegram-dm-reply-retry": {
        const conversationId = str(p.conversationId);
        if (!conversationId) break;
        const conv = await prisma.telegramDirectConversation.findUnique({
          where: { id: conversationId },
          select: { client: { select: { shortId: true, fullName: true, assignedAgentId: true } } },
        });
        if (!conv) return { label: `Telegram ЛС: диалог удалён (${conversationId.slice(0, 8)})`, ownerAgentId: null };
        return {
          label: conv.client
            ? `Telegram ЛС с клиентом №${conv.client.shortId} «${conv.client.fullName}»`
            : "Telegram ЛС без карточки клиента",
          ownerAgentId: conv.client?.assignedAgentId ?? null,
        };
      }
      case "transcription-retry":
      case "recording-search-retry": {
        const interactionId = str(p.interactionId);
        if (!interactionId) break;
        const interaction = await prisma.interaction.findUnique({
          where: { id: interactionId },
          select: {
            subjectAgentId: true,
            agentId: true,
            client: { select: { shortId: true, fullName: true, assignedAgentId: true } },
          },
        });
        if (!interaction) return { label: `Запись звонка: карточка удалена (${interactionId.slice(0, 8)})`, ownerAgentId: null };
        return {
          label: `Запись разговора с клиентом №${interaction.client.shortId} «${interaction.client.fullName}»`,
          ownerAgentId: interaction.subjectAgentId ?? interaction.agentId ?? interaction.client.assignedAgentId,
        };
      }
      case "deferred-push":
        return { label: "Отложенный пуш сотрудникам", ownerAgentId: null };
      default:
        break;
    }
  } catch (err) {
    console.error(`[stuckWork] не удалось описать задание «${type}»:`, describeError(err));
    return { label: `${jobTypeLabel(type)} — не удалось описать задание`, ownerAgentId: null };
  }
  return { label: jobTypeLabel(type), ownerAgentId: null };
}

async function toItem(job: BackgroundJob, status: StuckWorkItem["status"]): Promise<StuckWorkItem> {
  const { label, ownerAgentId } = await describeJob(job.type, job.payload);
  return {
    id: job.id,
    type: job.type,
    typeLabel: jobTypeLabel(job.type),
    status,
    label,
    ownerAgentId,
    ownerAgentName: null, // заполняется пачкой в listStuckWork — не по одному имени на запись
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    runAt: job.runAt,
    updatedAt: job.updatedAt,
  };
}

export interface StuckWorkSnapshot {
  givenUp: StuckWorkItem[];
  hanging: StuckWorkItem[];
  counts: { givenUp: number; hanging: number };
}

/**
 * Сдавшееся задание показываем две недели (02.10.2026). Дольше оно только
 * копится: 172 из 200 строк экрана были неотвеченными диалогами 05–07.09
 * (ИИ лежал), и отвечать тем клиентам через месяц уже нельзя, а свежие
 * отказы тонули под ними. Записи остаются в базе — уходят только с экрана.
 */
export const GIVEN_UP_VISIBLE_DAYS = 14;

/** Условие «сдалось и ещё на виду» — одно на экран, пульт и ответы помощника,
 *  чтобы счётчики не расходились между собой. */
export function givenUpVisibleWhere(now: Date = new Date()) {
  return {
    status: "GIVEN_UP" as const,
    updatedAt: { gte: new Date(now.getTime() - GIVEN_UP_VISIBLE_DAYS * 24 * 60 * 60_000) },
  };
}

/**
 * Список для экрана «Что не доехало». GIVEN_UP не удаляется чисткой (см.
 * runner.ts — она трогает только DONE/SKIPPED), поэтому список ограничен
 * последними 200 по времени, а не выбирается целиком (правило CLAUDE.md про
 * пагинацию любого роута со списком). Счётчик — честный COUNT, а не длина
 * выборки: раньше он упирался в те же 200.
 */
/** Сколько сдавшихся отдаём за раз и потолок «Показать ещё» (02.10.2026): раньше
 *  экран всегда получал 200 строк и дальше не листался, а `describeJob` на каждую
 *  строку — отдельный запрос в базу, так что 200 строк разом ещё и медленно. */
export const GIVEN_UP_PAGE = 50;
export const GIVEN_UP_MAX = 1000;

export async function listStuckWork(opts: { givenUpLimit?: number; includePrivate?: boolean } = {}): Promise<StuckWorkSnapshot> {
  const givenUpLimit = Math.min(Math.max(1, opts.givenUpLimit ?? GIVEN_UP_PAGE), GIVEN_UP_MAX);
  const givenUpWhere = givenUpVisibleWhere();
  const visible = opts.includePrivate === true ? Prisma.sql`TRUE` : publicBackgroundJobSql();
  const givenUpSql = Prisma.sql`status = 'GIVEN_UP' AND "updatedAt" >= ${givenUpWhere.updatedAt.gte}`;
  const pendingSql = Prisma.sql`status = 'PENDING' AND "runAt" < ${minutesAgo(PENDING_OVERDUE_MIN)}`;
  const runningSql = Prisma.sql`status = 'RUNNING' AND "lockedAt" < ${minutesAgo(RUNNING_STUCK_MIN)}`;
  const [givenUpRows, givenUpCount, pendingOverdueRows, runningStuckRows, hangingCount] = opts.includePrivate !== true ? await Promise.all([
    prisma.$queryRaw<BackgroundJob[]>(Prisma.sql`SELECT * FROM "BackgroundJob" WHERE ${givenUpSql} AND ${visible} ORDER BY "updatedAt" DESC, id DESC LIMIT ${givenUpLimit}`),
    countVisibleBackgroundJobs(givenUpSql),
    prisma.$queryRaw<BackgroundJob[]>(Prisma.sql`SELECT * FROM "BackgroundJob" WHERE ${pendingSql} AND ${visible} ORDER BY "runAt" LIMIT 200`),
    prisma.$queryRaw<BackgroundJob[]>(Prisma.sql`SELECT * FROM "BackgroundJob" WHERE ${runningSql} AND ${visible} ORDER BY "lockedAt" LIMIT 200`),
    countVisibleBackgroundJobs(Prisma.sql`(${pendingSql} OR ${runningSql})`),
  ]) : await Promise.all([
    prisma.backgroundJob.findMany({
      where: givenUpWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: givenUpLimit,
    }),
    prisma.backgroundJob.count({ where: givenUpWhere }),
    prisma.backgroundJob.findMany({
      where: { status: "PENDING", runAt: { lt: minutesAgo(PENDING_OVERDUE_MIN) } },
      orderBy: { runAt: "asc" },
      take: 200,
    }),
    prisma.backgroundJob.findMany({
      where: { status: "RUNNING", lockedAt: { lt: minutesAgo(RUNNING_STUCK_MIN) } },
      orderBy: { lockedAt: "asc" },
      take: 200,
    }),
    prisma.backgroundJob.count({
      where: {
        OR: [
          { status: "PENDING", runAt: { lt: minutesAgo(PENDING_OVERDUE_MIN) } },
          { status: "RUNNING", lockedAt: { lt: minutesAgo(RUNNING_STUCK_MIN) } },
        ],
      },
    }),
  ]);

  const [givenUp, hangingPending, hangingRunning] = await Promise.all([
    Promise.all(givenUpRows.map((j) => toItem(j, "GIVEN_UP"))),
    Promise.all(pendingOverdueRows.map((j) => toItem(j, "PENDING"))),
    Promise.all(runningStuckRows.map((j) => toItem(j, "RUNNING"))),
  ]);
  const hanging = [...hangingRunning, ...hangingPending];

  const ownerIds = [...new Set([...givenUp, ...hanging].map((i) => i.ownerAgentId).filter((v): v is string => !!v))];
  if (ownerIds.length > 0) {
    const owners = await prisma.agent.findMany({ where: { id: { in: ownerIds } }, select: { id: true, fullName: true } });
    const byId = new Map(owners.map((o) => [o.id, o.fullName]));
    for (const item of [...givenUp, ...hanging]) {
      if (item.ownerAgentId) item.ownerAgentName = byId.get(item.ownerAgentId) ?? null;
    }
  }

  return {
    givenUp,
    hanging,
    counts: { givenUp: givenUpCount, hanging: hangingCount },
  };
}

export type RetryOutcome = "ok" | "not-found" | "not-stuck";

/**
 * «Повторить» — возвращает застрявшее задание в очередь: сбрасывает попытки,
 * снимает лизинг, runAt = сейчас. Работает только на реально застрявшей
 * записи (GIVEN_UP, просроченный PENDING, зависший RUNNING) — обычное свежее
 * задание кнопка не трогает, чтобы не путать «стоит в очереди штатно» с
 * «нажали и ничего не поменялось».
 */
export async function retryStuckWorkItem(id: string, includePrivate = false): Promise<RetryOutcome> {
  if (!includePrivate) {
    const updated = await prisma.$executeRaw(Prisma.sql`UPDATE "BackgroundJob" SET status='PENDING', attempts=0, "runAt"=now(), "lockedAt"=NULL, "lockedBy"=NULL, "updatedAt"=now()
      WHERE id=${id} AND ${publicBackgroundJobSql()} AND (status='GIVEN_UP' OR (status='PENDING' AND "runAt" < ${minutesAgo(PENDING_OVERDUE_MIN)}) OR (status='RUNNING' AND "lockedAt" < ${minutesAgo(RUNNING_STUCK_MIN)}))`);
    if (updated) return "ok";
    const visible = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "BackgroundJob" WHERE id=${id} AND ${publicBackgroundJobSql()}`);
    return visible.length ? "not-stuck" : "not-found";
  }
  const job = await prisma.backgroundJob.findUnique({ where: { id } });
  if (!job) return "not-found";
  const isStuck =
    job.status === "GIVEN_UP" ||
    (job.status === "PENDING" && job.runAt < minutesAgo(PENDING_OVERDUE_MIN)) ||
    (job.status === "RUNNING" && !!job.lockedAt && job.lockedAt < minutesAgo(RUNNING_STUCK_MIN));
  if (!isStuck) return "not-stuck";
  await prisma.backgroundJob.update({
    where: { id },
    data: { status: "PENDING", attempts: 0, runAt: new Date(), lockedAt: null, lockedBy: null },
  });
  return "ok";
}

/** Сколько заданий сдалось за окно [since, сейчас) — для утреннего отчёта. */
export async function countStuckWorkGivenUpSince(since: Date): Promise<number> {
  return countVisibleBackgroundJobs(Prisma.sql`status='GIVEN_UP' AND "updatedAt">=${since}`);
}

/** Сколько сейчас висит (просроченный PENDING + зависший RUNNING) — то же
 *  условие, что и hanging в listStuckWork, но одним COUNT без выборки строк. */
export async function countStuckWorkHangingNow(): Promise<number> {
  return countVisibleBackgroundJobs(Prisma.sql`((status='PENDING' AND "runAt"<${minutesAgo(PENDING_OVERDUE_MIN)}) OR (status='RUNNING' AND "lockedAt"<${minutesAgo(RUNNING_STUCK_MIN)}))`);
}

/**
 * УВЕДОМЛЕНИЕ ХОЗЯИНУ СДАВШЕЙСЯ РАБОТЫ (владелец 21.09.2026, п.2 задания).
 *
 * Зовётся ИЗ runner.ts РОВНО В МОМЕНТ перехода в GIVEN_UP (оба места — исчерпание
 * при захвате зависшего RUNNING и исчерпание в catch) — то есть один раз на
 * окончательную сдачу, а не на каждую попытку. `tag` с id задания на всякий
 * случай защищает и от повторного вызова: `createNotification`/`notifyFeedOnly`
 * с тем же tag обновляют существующую строку, а не плодят новую.
 *
 * Получатели — директор/админ (тот же порядок, что и во всех остальных сводках,
 * см. cron.ts) и хозяин конкретной карточки, если describeJob его нашёл. Без
 * push (notifyFeedOnly, П-20.09): директор и так видит экран «Что не доехало» —
 * будить телефон на КАЖДОЕ сдавшееся фоновое задание было бы тем самым лишним
 * звонком, который владелец просил убрать 20.09.2026.
 */
export async function notifyStuckWorkGivenUp(job: BackgroundJob): Promise<void> {
  try {
    const privateJob = await isPrivateBackgroundJob(job);
    const { label, ownerAgentId } = await describeJob(job.type, job.payload);
    const directors = await prisma.agent.findMany({
      where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
      select: { id: true, role: true, permissions: true },
    });
    const recipients = new Set<string>(directors.filter(d => !privateJob || resolvePermissions(d.role, parsePermissionOverrides(d.permissions)).has("clients.securityReview")).map((d) => d.id));
    if (ownerAgentId && !privateJob) recipients.add(ownerAgentId);
    if (recipients.size === 0) return;

    const reason = job.lastError ? job.lastError.slice(0, 200) : "процесс умирал на этом задании";
    await notifyFeedOnly([...recipients], {
      kind: "background-job-given-up",
      title: "Задание не доехало",
      body: `${label}: «${jobTypeLabel(job.type)}» сдалось после ${job.attempts} попыток — ${reason}. Открыть «Что не доехало» и повторить.`,
      url: "/stuck-work",
      tag: `${privateJob ? "investigation-" : ""}background-job-given-up:${job.id}`,
    });
  } catch (err) {
    // Уведомление — довесок к уже случившемуся GIVEN_UP (тот уже в journal
    // через logSystemError в runner.ts), поэтому его собственный сбой не
    // должен ронять тик очереди — журналируем и идём дальше.
    console.error("[stuckWork] уведомление о сдавшемся задании:", describeError(err));
  }
}
