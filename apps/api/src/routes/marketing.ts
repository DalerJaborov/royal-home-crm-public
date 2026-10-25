import { visibleErrorLogs } from "../lib/systemErrorVisibility.js";
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { loadPipelineDeadlines, stageState } from "../lib/propertyPipeline.js";
import {
  videoHandoffQueuePositions,
  cancelVideoHandoffQueueEntry,
  videoHandoffPublishDedupeKey,
  videoHandoffQueueState,
  setVideoHandoffQueuePaused,
  moveVideoHandoffInQueue,
  holdVideoHandoff,
  releaseVideoHandoffHold,
  dispatchInBackground,
  HANDOFF_DISPATCH_BUSY_WINDOW_MS,
} from "../lib/videoHandoff.js";
import { logAudit } from "../lib/audit.js";
import { HAS_INSTAGRAM_LINK_WHERE } from "../lib/instagramLink.js";
import { PROPERTY_LIST_INCLUDE, presentPropertyListItems, type PropertyListRecord } from "../lib/propertyListItem.js";
import {
  PROPERTY_PIPELINE_STATUSES,
  pageQuerySchema,
  cancelVideoHandoffBodySchema,
  pauseVideoHandoffQueueBodySchema,
  videoHandoffMoveBodySchema,
  holdVideoHandoffBodySchema,
  type VideoHandoffMoveResult,
  type VideoHandoffQueueState,
} from "@royal-home/shared";
import type { Response, NextFunction, Request } from "express";
import { loadBotCapabilities } from "../messengers/botCapabilities.js";
import { isBotEnabledForChannel } from "../messengers/botChannels.js";
import { logSystemError } from "../lib/systemError.js";
import { loadPublishScheduleRules } from "../lib/publishScheduleRules.js";
import { INSTAGRAM_ONLINE_MIN_DAYS, dailyPublishCapacity } from "../lib/publishSchedule.js";
import { loadPostStats } from "../lib/postStats.js";
import { analyzePosts, enrichPosts, summarizeWithAi } from "../lib/postAnalysis.js";
import { loadFirstSeconds } from "../lib/firstSeconds.js";
import { listCrosspostWhitelistedPages } from "../lib/facebookCrosspost.js";
import { loadCredentials } from "../messengers/meta.js";
import { loadCatalogProperties } from "../lib/metaCatalogFeed.js";
import { runSocialDigestsTick } from "../lib/socialDigests.js";
import { z } from "zod";
import { describeError } from "../lib/describeError.js";
import { getChatTitle, getChatMemberStatus, isTelegramEnabled, canBotWriteToChat } from "../telegram/api.js";
import { parseTelegramChatIds } from "../lib/telegramChats.js";

/**
 * Кабинет маркетинга.
 *
 * Задача владельца 05.08.2026 (вечер, «кабинет маркетинга тоже готово?») — не
 * было в исходной письменной спецификации (не путать с кабинетом СБ, который
 * был прописан явно), сделано по прямой устной просьбе. Построено по тому же
 * паттерну, что и routes/security.ts: минимальная агрегация уже существующих
 * данных, без новых таблиц и миграций.
 *
 * Источник данных — конвейер подготовки объекта (lib/propertyPipeline.ts):
 * PENDING_REVIEW → AWAITING_PHOTOS → AWAITING_VIDEO → EDITING → AVAILABLE.
 * Просрочка считается той же функцией stageState, что красит StatusBadge и
 * копит штрафы Royal Score (notifyOverdueMaterials) — критерии здесь не
 * изобретаются заново, а переиспользуются один в один.
 *
 * ДОСТУП — сознательно НЕ по праву properties.viewAll (оно есть также у
 * EDITOR, ADMIN, DIRECTOR, MANAGER — см. permissions.ts), а по роли явно:
 * MARKETING, DIRECTOR и ADMIN (директор и администратор — для контроля и
 * полной видимости, решение владельца 22.08.2026: разделы других ролей не
 * должны быть слепой зоной для руководства). /queue и /summary показывают
 * ВЕСЬ конвейер подготовки объекта (проверка, фото, видео) — это рабочая
 * очередь именно маркетинга, монтажёру сюда хода нет (см.
 * marketing-center.test.ts, тест написан явно под это решение).
 *
 * EDITOR добавлен 06.08.2026, но НЕ на весь кабинет — только на /editors-load
 * (см. requireEditorsLoadRole ниже): у монтажёра не было своего входа в
 * ОЧЕРЕДЬ МОНТАЖА конкретно (только «Объекты» + фильтр вручную по статусу).
 * Полная очередь подготовки (кто ждёт проверки, чьи фото отклонены и почему)
 * маркетингу и монтажёру видна одинаково не по смыслу: это чужой этап.
 * Админу — видна вся ВЕТКА целиком (и очередь, и нагрузка монтажа), как
 * директору: у руководства нет «чужого этапа».
 */
// ADMIN добавлен решением владельца 22.08.2026: администратор и директор видят
// вообще все разделы CRM, даже не свои по обязанности (см. feat/admin-director-
// full-visibility) — тот же принцип применён здесь, чтобы кабинет маркетинга не
// остался исключением.
/** Сама проверка роли, отдельно от middleware (24.09.2026): «Вернуть монтажёру»
 *  с removeFromSocial:true (routes/properties/videos.ts) применяет её условно,
 *  только когда поле передано, — обычному requireMarketingRole как middleware
 *  этого не сделать, а вторая копия списка ролей разошлась бы с этой. */
export function hasMarketingRole(role: string | undefined): boolean {
  return role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
}

/** Экспортирована (17.09.2026): TikTok (routes/tiktok.ts) использует те же права,
 *  что кабинет маркетинга — общий helper, а не вторая копия проверки роли. */
export function requireMarketingRole<P>(req: Request<P>, res: Response, next: NextFunction) {
  if (!req.agent) return res.status(401).json({ error: "Требуется авторизация" });
  if (!hasMarketingRole(req.agent.role)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  next();
}

/** /editors-load — своя очередь монтажа, её видят маркетинг, монтажёр, директор и админ. */
function requireEditorsLoadRole<P>(req: Request<P>, res: Response, next: NextFunction) {
  if (!req.agent) return res.status(401).json({ error: "Требуется авторизация" });
  if (
    req.agent.role !== "MARKETING" &&
    req.agent.role !== "EDITOR" &&
    req.agent.role !== "DIRECTOR" &&
    req.agent.role !== "ADMIN"
  ) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  next();
}

export const marketingRouter = Router();

/** Потолок сканирования конвейера подготовки (PENDING_REVIEW/AWAITING_PHOTOS/
 *  AWAITING_VIDEO/EDITING) для счётчиков «Маркетинга» (22.09.2026, класс
 *  «Пагинация»): подмножество каталога, но само по себе без верхней границы.
 *  Тот же потолок использует routes/dashboardMissionControl.ts — один и тот же
 *  механизм, не копия логики. */
export const MARKETING_PIPELINE_SCAN_CAP = 5000;

marketingRouter.use(requireAuth);

/**
 * СТРОКА КОНВЕЙЕРА = ОБЪЕКТ СПИСКА + ОЧЕРЕДЬ (24.09.2026, владелец: «добавь
 * карточку объекта полностью со всей информацией, как и везде»). Объект — той
 * же формы и тем же сериализатором, что GET /properties (lib/propertyListItem.ts),
 * чтобы веб рисовал его тем же PropertyRow; поверх — поля, которые конвейер
 * отдавал и раньше (photoCount, responsibleAgent), и место в очереди монтажёра
 * (videoHandoffQueuePosition: 1 — держатель места, 2+ — ждущие, null — вне
 * очереди; см. lib/videoHandoff.ts::videoHandoffQueuePositions).
 */
async function pipelineRows(records: PropertyListRecord[], req: Request, handoffPositions: Map<string, number>) {
  const presented = await presentPropertyListItems(records, req);
  return sortEditingByHandoffQueue(
    presented.map((p) => ({
      ...p,
      photoCount: p.photos.length,
      responsibleAgent: p.intakeAgent ?? p.assignedAgent ?? null,
      videoHandoffQueuePosition: handoffPositions.get(p.id) ?? null,
    }))
  );
}

/**
 * «НА МОНТАЖЕ» — ОДНИМ БЛОКОМ В ПОРЯДКЕ ОЧЕРЕДИ МОНТАЖЁРА (24.09.2026, владелец
 * увидел держателя места четвёртым, а строки очереди — вперемешку с другими
 * стадиями). Все строки EDITING собираются в один непрерывный блок на месте
 * первой из них: держатель → 2-й → 3-й → … → на монтаже без места в очереди
 * (прежним порядком). Остальные стадии не двигаются. Место — из общей функции
 * порядка (videoHandoffQueuePositions), а не из возраста стадии.
 */
function sortEditingByHandoffQueue<T extends { status: string; videoHandoffQueuePosition: number | null }>(rows: T[]): T[] {
  const firstEditing = rows.findIndex((r) => r.status === "EDITING");
  if (firstEditing < 0) return rows;
  const editing = rows
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.status === "EDITING")
    .sort((a, b) => (a.r.videoHandoffQueuePosition ?? Infinity) - (b.r.videoHandoffQueuePosition ?? Infinity) || a.i - b.i)
    .map((x) => x.r);
  const rest = rows.filter((r) => r.status !== "EDITING");
  const before = rows.slice(0, firstEditing).filter((r) => r.status !== "EDITING");
  return [...before, ...editing, ...rest.slice(before.length)];
}

/**
 * Раздел 1: «Очередь подготовки» — все объекты в конвейере (PENDING_REVIEW/
 * AWAITING_PHOTOS/AWAITING_VIDEO/EDITING), с состоянием этапа (владелец,
 * дни, просрочка) — тем же stageState, который использует StatusBadge и
 * notifyOverdueMaterials.
 */
/** Стадия — фильтр НА СЕРВЕРЕ (02.10.2026, класс «Пагинация»): раньше экран
 *  брал страницу из 40 строк всего конвейера и фильтровал её по стадии у себя,
 *  а пейджер листал весь конвейер — на стадии «Монтаж» могло быть пусто на
 *  странице 1 и густо на странице 3. Без `status` — весь конвейер, как раньше. */
const queueQuerySchema = pageQuerySchema.extend({
  status: z.enum(PROPERTY_PIPELINE_STATUSES).optional(),
});

marketingRouter.get("/queue", requireMarketingRole, async (req, res) => {
  const parsedPage = queueQuerySchema.safeParse(req.query);
  if (!parsedPage.success) {
    return res.status(400).json({ error: "Неверный номер страницы", details: parsedPage.error.flatten() });
  }
  const { page, status } = parsedPage.data;
  const pageSize = 40;

  const where = {
    deletedAt: null,
    status: status ? status : { in: [...PROPERTY_PIPELINE_STATUSES] },
  };

  const [rows, total, handoffPositions] = await Promise.all([
    prisma.property.findMany({
      where,
      include: PROPERTY_LIST_INCLUDE,
      orderBy: [{ stageEnteredAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.property.count({ where }),
    videoHandoffQueuePositions(),
  ]);

  const items = await pipelineRows(rows, req, handoffPositions);

  res.json({ items, total, page, pageSize });
});

/**
 * Раздел «Каналы» (01.09.2026) — единый экран «что подключено, что отвечает,
 * что происходит», собранный по просьбе владельца после разбора автопубликации:
 * до этого статус каждого канала было видно только по отдельности (Настройки →
 * Каналы связи — что заполнено; «Здоровье системы» — что падает; «Публикации» —
 * что в очереди), а «всё ли работает как единая платформа» не отвечал никто.
 *
 * Собирает уже существующие данные, ничего не считает заново: подключено ли
 * (наличие токена/chat_id в Settings — те же поля, что читает lib/socialPublish.ts
 * и messengers/comments.ts), отвечает ли бот (isBotEnabledForChannel — тот же
 * рубильник, что решает живую переписку) и сколько объектов реально опубликовано
 * (Property.publishedChannels).
 */
/**
 * РАСПИСАНИЕ ВЫХОДА РОЛИКОВ (23.09.2026, владелец: «чтобы я видел время выхода,
 * объекты, почему именно, какие площадки»).
 *
 * Отвечает ровно на четыре вопроса и ничего не считает заново: правила берутся
 * из общей точки (lib/publishScheduleRules.ts) — той же, по которой слот и
 * выдавался, — а причина слота лежит у самого объекта, записанная в момент
 * выдачи. Пересчитывать причину здесь значило бы завести вторую копию правил и
 * однажды с ней разойтись.
 *
 * Площадки — те, что РЕАЛЬНО подключены сейчас, а не мечта: ровно те же
 * проверки, что на вкладке «Каналы» рядом. Telegram в этом списке — канал
 * агентства (telegramChannelId), а не переписка с клиентом.
 */
const SCHEDULE_UPCOMING_LIMIT = 50;

marketingRouter.get("/publish-schedule", requireMarketingRole, async (_req, res) => {
  const now = new Date();
  const [loaded, settings, candidates] = await Promise.all([
    loadPublishScheduleRules(),
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        metaPageToken: true,
        metaPageId: true,
        telegramChannelId: true,
        youtubeClientId: true,
        youtubeClientSecret: true,
        youtubeRefreshToken: true,
        tiktokRefreshToken: true,
        threadsAccessToken: true,
        threadsUserId: true,
        autoPublishEnabled: true,
      },
    }),
    // Ждут своего слота — принятый ролик, публикации ещё не было. Предел есть
    // (класс «Пагинация»): очередь на полсотни роликов вперёд уже говорит о
    // беде, а не о расписании.
    //
    // НОВЫЙ РОЛИК УЖЕ ВЫШЕДШЕГО ОБЪЕКТА (24.09.2026, случай ОБ-000132): готовый
    // ролик на замену грузят в вышедший объект, он встаёт в тот же час
    // расстановки — а очередь его не показывала, потому что брала только
    // объекты без публикаций. Теперь берёт и их, пока слот впереди (то же
    // правило, что у строки «Публикация запланирована» в карточке,
    // apps/web/src/lib/publishPlanned.ts); прошедший слот вышедшего объекта —
    // это его прошлый выход, а не застрявшая публикация.
    prisma.property.findMany({
      where: {
        deletedAt: null,
        videoHandoffStatus: "RECEIVED",
        scheduledPublishAt: { not: null },
        OR: [{ publishedChannels: { isEmpty: true } }, { scheduledPublishAt: { gt: now } }],
      },
      orderBy: { scheduledPublishAt: "asc" },
      take: SCHEDULE_UPCOMING_LIMIT,
      select: {
        id: true,
        shortId: true,
        title: true,
        scheduledPublishAt: true,
        scheduledPublishReason: true,
        videoHandoffReceivedAt: true,
        publishedChannels: true,
      },
    }),
  ]);

  // Instagram — по тому же маркеру, которым публикует сам код (основной аккаунт
  // списка → поле → окружение), а не по одному запасному полю (28.09.2026).
  const igConnected = Boolean((await loadCredentials()).igToken);
  const channels = [
    { channel: "INSTAGRAM", connected: igConnected },
    { channel: "FACEBOOK", connected: Boolean(settings?.metaPageToken && settings?.metaPageId) },
    { channel: "TELEGRAM", connected: Boolean(settings?.telegramChannelId) },
    {
      channel: "YOUTUBE",
      connected: Boolean(settings?.youtubeClientId && settings?.youtubeClientSecret && settings?.youtubeRefreshToken),
    },
    { channel: "TIKTOK", connected: Boolean(settings?.tiktokRefreshToken) },
    { channel: "THREADS", connected: Boolean(settings?.threadsAccessToken && settings?.threadsUserId) },
  ];
  const targetChannels = channels.filter((c) => c.connected).map((c) => c.channel);

  // Состояние задания публикации по каждой строке — одним запросом на всю
  // очередь (не по запросу на строку): экран прячет кнопки у ролика, который
  // уже публикуется, и называет застрявший застрявшим.
  const jobs = candidates.length
    ? await prisma.backgroundJob.findMany({
        where: { dedupeKey: { in: candidates.map((p) => videoHandoffPublishDedupeKey(p.id)) } },
        select: { dedupeKey: true, status: true },
      })
    : [];
  const jobStatusByKey = new Map(jobs.map((j) => [j.dedupeKey, j.status]));
  // Свободные ролики по расписанию (12.10.2026): ждут своего часа так же, как ролики объектов, но слот выбрал человек.
  const freeUpcoming = (
    await prisma.socialVideoPost.findMany({
      where: { deletedAt: null, status: "SCHEDULED", scheduledAt: { not: null } },
      orderBy: { scheduledAt: "asc" },
      take: SCHEDULE_UPCOMING_LIMIT,
      select: { id: true, title: true, scheduledAt: true, channels: true },
    })
  ).map((v) => ({
    id: v.id,
    title: v.title,
    at: v.scheduledAt?.toISOString() ?? null,
    channels: v.channels,
    overdue: v.scheduledAt ? v.scheduledAt.getTime() < now.getTime() : false,
  }));
  // Вышедший объект остаётся в очереди, только пока его новый ролик и правда
  // ждёт (PENDING) или уходит (RUNNING). Задание уже отработало («Опубликовать
  // сейчас» до слота) — ролик вышел, слот просто остался в будущем, и
  // показывать его застрявшим было бы враньём.
  const waiting = candidates.filter((p) => {
    if (p.publishedChannels.length === 0) return true;
    const status = jobStatusByKey.get(videoHandoffPublishDedupeKey(p.id));
    return status === "PENDING" || status === "RUNNING";
  });
  const jobState = (propertyId: string): "waiting" | "publishing" | "stuck" => {
    const status = jobStatusByKey.get(videoHandoffPublishDedupeKey(propertyId));
    if (status === "PENDING") return "waiting";
    if (status === "RUNNING") return "publishing";
    return "stuck";
  };

  res.json({
    now: now.toISOString(),
    schedule: {
      enabled: loaded.rules.enabled,
      windowStartMin: loaded.rules.windowStartMin,
      windowEndMin: loaded.rules.windowEndMin,
      minGapMin: loaded.rules.minGapMin,
      prioritySource: loaded.rules.prioritySource,
      priorityHours: loaded.priorityHours,
      heatmapEvents: loaded.heatmapEvents,
      heatmapDays: loaded.heatmapDays,
      heatmapTooSparse: loaded.heatmapTooSparse,
      instagramOnlineEnabled: loaded.instagramOnlineEnabled,
      instagramOnlineDays: loaded.instagramOnlineDays,
      instagramOnlineMinDays: INSTAGRAM_ONLINE_MIN_DAYS,
      priorityHoursByDow: loaded.priorityHoursByDow,
      /** Сколько роликов в день вмещают окно и промежуток. */
      dailyCapacity: dailyPublishCapacity(loaded.rules),
    },
    /** Куда уйдёт ролик, если выйдет прямо сейчас. */
    targetChannels,
    channels,
    autoPublishEnabled: settings?.autoPublishEnabled ?? false,
    freeUpcoming,
    upcoming: waiting.map((p) => ({
      propertyId: p.id,
      shortId: p.shortId,
      title: p.title,
      at: p.scheduledPublishAt?.toISOString() ?? null,
      reason: p.scheduledPublishReason,
      receivedAt: p.videoHandoffReceivedAt?.toISOString() ?? null,
      overdue: p.scheduledPublishAt ? p.scheduledPublishAt.getTime() < now.getTime() : false,
      jobState: jobState(p.id),
      // Площадки, где ролик уже стоит, публикация пропускает (skipChannels в
      // publishHandoffResult) — новый ролик вышедшего объекта уйдёт только туда,
      // откуда старый сняли.
      channels: targetChannels.filter((c) => !p.publishedChannels.includes(c)),
    })),
  });
});

/**
 * «Статистика роликов по всем площадкам» (24.09.2026, владелец: «статистика
 * роликов по всем площадкам») — просмотры/лайки/комментарии по каждому
 * опубликованному ролику на каждой площадке, и какая площадка и какой час
 * публикации работают лучше. Вся логика (токены, кэш на 30 минут, разбор
 * ответов площадок) — в lib/postStats.ts, роут только валидирует `?refresh=1`
 * и отдаёт готовый ответ.
 */
const postStatsQuerySchema = z.object({ refresh: z.literal("1").optional() });

marketingRouter.get("/post-stats", requireMarketingRole, async (req, res) => {
  const parsed = postStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неизвестный параметр запроса" });
  try {
    const result = await loadPostStats({ forceRefresh: parsed.data.refresh === "1" });
    res.json(result);
  } catch (err) {
    const message = describeError(err);
    void logSystemError("api", `Статистика роликов по площадкам: ${message}`);
    res.status(502).json({ error: "Не удалось собрать статистику роликов" });
  }
});

/**
 * «Почему взлетели» (24.09.2026, владелец: «анализатор в это же окно с
 * роликами — почему некоторые наши ролики хорошо взлетели»). Поверх той же
 * статистики площадок (кэш полчаса): сравнение по признакам + разбор ИИ раз
 * в сутки. ИИ не ответил — числа всё равно отдаются, разбор просто пуст.
 */
marketingRouter.get("/post-analysis", requireMarketingRole, async (_req, res) => {
  try {
    const stats = await loadPostStats();
    const analysis = analyzePosts(await enrichPosts(stats.posts));
    const ai = await summarizeWithAi(analysis);
    res.json({ ...analysis, ...ai });
  } catch (err) {
    void logSystemError("api", `Разбор «почему взлетели»: ${describeError(err)}`, { dedupKey: "post-analysis-failed" });
    res.status(502).json({ error: "Не удалось собрать разбор роликов" });
  }
});

/**
 * «Первые секунды ролика» (24.09.2026, Dan: «разбор первых секунд ролика»):
 * удержание с площадок + что ИИ увидел в первых трёх секундах каждого ролика.
 * Не разобранные ролики ставятся в очередь отсюда же (lib/firstSeconds.ts).
 */
marketingRouter.get("/first-seconds", requireMarketingRole, async (_req, res) => {
  try {
    res.json(await loadFirstSeconds());
  } catch (err) {
    void logSystemError("api", `Разбор первых секунд: ${describeError(err)}`, { dedupKey: "first-seconds-failed" });
    res.status(502).json({ error: "Не удалось собрать разбор первых секунд" });
  }
});

marketingRouter.get("/channels-status", requireMarketingRole, async (_req, res) => {
  const [settings, capabilities, publishedCount, recentErrors] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        autoPublishEnabled: true,
        metaPageToken: true,
        metaPageId: true,
        telegramChannelId: true,
        telegramDiscussionGroupId: true,
        telegramDirectMessagesEnabled: true,
        youtubeClientId: true,
        youtubeClientSecret: true,
        youtubeRefreshToken: true,
        tiktokRefreshToken: true,
        tiktokCreatorUsername: true,
        threadsAccessToken: true,
        threadsUserId: true,
        threadsUsername: true,
      },
    }),
    loadBotCapabilities(),
    // Вышедшие по каналам ИЛИ с рабочей ссылкой Instagram (05.10.2026): тот же счёт, что у
    // «ждут публикации» в lib/missionControlGaps.ts, иначе объект выпадал из обеих сторон.
    prisma.property.count({ where: { deletedAt: null, OR: [{ publishedChannels: { isEmpty: false } }, HAS_INSTAGRAM_LINK_WHERE] } }),
    // Тот же источник, что «Здоровье системы» — источники meta/telegram нарочно
    // не смешаны с ai/telephony: экран про каналы, не про весь автопилот.
    visibleErrorLogs().count({ where: { resolvedAt: null, source: { in: ["meta", "telegram"] } } }),
  ]);

  const [botInstagram, botFacebook, botTelegram] = await Promise.all([
    isBotEnabledForChannel("INSTAGRAM"),
    isBotEnabledForChannel("FACEBOOK"),
    isBotEnabledForChannel("TELEGRAM"),
  ]);

  // См. /publish-schedule выше: тот же маркер, что у публикации, а не запасное поле.
  const igConnected = Boolean((await loadCredentials()).igToken);

  res.json({
    autoPublishEnabled: settings?.autoPublishEnabled ?? false,
    publishedCount,
    openErrors: recentErrors,
    channels: {
      INSTAGRAM: {
        connected: igConnected,
        botEnabled: botInstagram,
        commentsEnabled: capabilities.comments,
      },
      FACEBOOK: {
        connected: Boolean(settings?.metaPageToken && settings?.metaPageId),
        botEnabled: botFacebook,
      },
      TELEGRAM: {
        botEnabled: botTelegram,
        crosspostConnected: Boolean(settings?.telegramChannelId),
        commentsConnected: Boolean(settings?.telegramDiscussionGroupId),
        commentsEnabled: capabilities.comments,
        directMessagesEnabled: settings?.telegramDirectMessagesEnabled ?? false,
      },
      YOUTUBE: {
        connected: Boolean(settings?.youtubeClientId && settings?.youtubeClientSecret && settings?.youtubeRefreshToken),
      },
      TIKTOK: {
        // Реализовано (17.09.2026) — Content Posting API, см. routes/tiktok.ts,
        // lib/socialPublish.ts. refreshToken появляется только после consent-flow
        // (кнопка «Подключить», сама CRM его не выпускает).
        connected: Boolean(settings?.tiktokRefreshToken),
        username: settings?.tiktokCreatorUsername ?? null,
      },
      THREADS: {
        // Реализовано (23.09.2026) — routes/threads.ts, lib/socialPublish.ts.
        connected: Boolean(settings?.threadsAccessToken && settings?.threadsUserId),
        username: settings?.threadsUsername ?? null,
      },
    },
  });
});

/**
 * ПРОВЕРКА ДОПОЛНИТЕЛЬНЫХ ЧАТОВ TELEGRAM (26.09.2026, п.6 задания) — кнопка
 * «Проверить» рядом с полем в Настройках. Те же getChat/getChatMember, что
 * суточная самопроверка (lib/integrationHealth.ts::checkTelegramExtraChatsHealth),
 * но по требованию и с названием чата в каждой строке, а не только записью в
 * журнал ошибок. Права — как у остального маркетинга (requireMarketingRole).
 */
marketingRouter.get("/telegram-chats-check", requireMarketingRole, async (_req, res) => {
  if (!isTelegramEnabled()) {
    return res.json({ configured: false, chats: [] });
  }
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramChannelId: true, telegramExtraChatIds: true },
  });
  const chatIds = parseTelegramChatIds(settings?.telegramExtraChatIds ?? null, settings?.telegramChannelId ?? null);

  const chats = await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        const [title, member] = await Promise.all([getChatTitle(chatId), getChatMemberStatus(chatId)]);
        const canWrite = canBotWriteToChat(member);
        return { chatId, title, canWrite, error: canWrite ? undefined : `статус ${member.status}` };
      } catch (err) {
        return { chatId, title: null, canWrite: false, error: describeError(err) };
      }
    })
  );

  res.json({ configured: true, chats });
});

/**
 * ПРОВЕРКА ПАРТНЁРСКИХ СТРАНИЦ ДЛЯ КРОССПОСТИНГА FACEBOOK (28.09.2026) —
 * кнопка «Проверить» рядом со списком Settings.facebookCrosspostPageIds
 * (ChannelsTab.tsx). Права те же, что у остального кабинета маркетинга:
 * список партнёров не тайна, но и не для чужих глаз.
 */
marketingRouter.get("/facebook-crosspost-check", requireMarketingRole, async (_req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { facebookCrosspostPageIds: true },
  });
  const pageIds = settings?.facebookCrosspostPageIds ?? [];
  if (pageIds.length === 0) return res.json({ pages: [] });

  const creds = await loadCredentials();
  if (!creds.pageToken || !creds.pageId) {
    return res.status(400).json({ error: "Маркер и id нашей Страницы Facebook не настроены (Настройки → Каналы)" });
  }

  try {
    const whitelisted = await listCrosspostWhitelistedPages(creds.pageId, creds.pageToken);
    const whitelistedById = new Map(whitelisted.map((p) => [p.id, p.name]));
    res.json({
      pages: pageIds.map((id) => ({
        id,
        name: whitelistedById.get(id) ?? null,
        confirmed: whitelistedById.has(id),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: `Meta не ответила: ${describeError(err)}` });
  }
});

/**
 * Счётчики сверху кабинета: сколько ждёт фото / ждёт видео / на монтаже /
 * просрочено суммарно — считаются той же логикой stageState, а не отдельными
 * дублирующими SQL-условиями по срокам.
 */
marketingRouter.get("/summary", requireMarketingRole, async (_req, res) => {
  const deadlines = await loadPipelineDeadlines();
  const rows = await prisma.property.findMany({
    where: {
      deletedAt: null,
      status: { in: [...PROPERTY_PIPELINE_STATUSES] },
    },
    select: { status: true, stageEnteredAt: true },
    take: MARKETING_PIPELINE_SCAN_CAP,
  });
  if (rows.length >= MARKETING_PIPELINE_SCAN_CAP) {
    void logSystemError("api", `Маркетинг «Сводка»: конвейер подготовки больше ${MARKETING_PIPELINE_SCAN_CAP} объектов — счётчики занижены`);
  }

  let awaitingReview = 0;
  let awaitingPhotos = 0;
  let awaitingVideo = 0;
  let editing = 0;
  let overdue = 0;

  for (const p of rows) {
    if (p.status === "PENDING_REVIEW") awaitingReview++;
    if (p.status === "AWAITING_PHOTOS") awaitingPhotos++;
    if (p.status === "AWAITING_VIDEO") awaitingVideo++;
    if (p.status === "EDITING") editing++;
    if (stageState(p.status, p.stageEnteredAt, deadlines).overdue) overdue++;
  }

  res.json({ total: rows.length, awaitingReview, awaitingPhotos, awaitingVideo, editing, overdue });
});

/**
 * Раздел «Ждут публикации» (шаг 5 переноса, 10.09.2026): объекты, вышедшие из
 * конвейера подготовки (в продажу) за последние RECENTLY_PUBLISHED_WINDOW_DAYS
 * дней, и в какие каналы каждый из них реально ушёл.
 *
 * МОМЕНТ ВЫХОДА ИЗ КОНВЕЙЕРА — НЕ Property.stageEnteredAt: то поле двигает
 * ЛЮБАЯ смена статуса через PATCH /properties/:id (routes/properties/crud.ts,
 * строка со stageEnteredAt при data.status !== existing.status), включая ручную
 * реактивацию WITHDRAWN→AVAILABLE, которая к конвейеру отношения не имеет.
 * Точный момент — запись AuditLog { action: "PROPERTY_EDITING_DONE" }: её пишет
 * ТОЛЬКО lib/propertyPipeline.ts#publishAfterEditingComplete, то есть ровно тот
 * переход монтаж→в продаже, о котором спрашивает эта плашка.
 *
 * КАНАЛЫ — Property.publishedChannels (реальное поле, не выдумка): куда ушла
 * публикация после автопубликации (см. комментарий поля в schema.prisma).
 * Пусто — пост ещё не ушёл в каналы (ручной путь или очередь автопубликации).
 *
 * Один объект теоретически может выйти из конвейера дважды за окно (вернули на
 * доработку и снова опубликовали) — оставляем только самое свежее событие,
 * иначе он задвоился бы в списке.
 */
const RECENTLY_PUBLISHED_WINDOW_DAYS = 7;
const RECENTLY_PUBLISHED_LIMIT = 50;
const RECENTLY_PUBLISHED_FREE_LIMIT = 20;

const recentlyPublishedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

marketingRouter.get("/recently-published", requireMarketingRole, async (req, res) => {
  const parsed = recentlyPublishedQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверный номер страницы", details: parsed.error.flatten() });
  const { page } = parsed.data;
  const pageSize = RECENTLY_PUBLISHED_LIMIT;
  const cutoff = new Date(Date.now() - RECENTLY_PUBLISHED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const auditWhere = { entityType: "Property", action: "PROPERTY_EDITING_DONE", createdAt: { gte: cutoff } } as const;
  // «Показать ещё» (02.10.2026): раньше список резался на 50 событиях без
  // способа увидеть остальные. Страница — по событиям журнала; повтор того же
  // объекта внутри страницы ниже схлопывается, на стыке страниц его снимает
  // накопление на экране (дедуп по id).
  const [total, events] = await Promise.all([
    prisma.auditLog.count({ where: auditWhere }),
    prisma.auditLog.findMany({
      where: auditWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { entityId: true, createdAt: true },
    }),
  ]);

  const seen = new Set<string>();
  const latestEvents = events.filter((e): e is typeof e & { entityId: string } => {
    if (!e.entityId || seen.has(e.entityId)) return false;
    seen.add(e.entityId);
    return true;
  });

  const properties = await prisma.property.findMany({
    where: { id: { in: latestEvents.map((e) => e.entityId) } },
    select: { id: true, shortId: true, title: true, deletedAt: true, publishedChannels: true },
  });
  const byId = new Map(properties.map((p) => [p.id, p]));

  const items = latestEvents
    .map((e) => {
      const p = byId.get(e.entityId);
      // Удалённый объект (Корзина) из очереди публикаций пропадает — как и
      // везде в каталоге, мягко удалённое ведёт себя как несуществующее.
      if (!p || p.deletedAt) return null;
      return {
        id: p.id,
        shortId: p.shortId,
        title: p.title,
        publishedAt: e.createdAt,
        publishedChannels: p.publishedChannels,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Свободные ролики (раздел «Ролики в соцсети», 12.10.2026) идут отдельным списком: у них нет карточки объекта и
  // события выхода из конвейера - выход фиксирует сам ролик (finishedAt). Только первая страница: список короткий.
  const freeVideos =
    page === 1
      ? (
          await prisma.socialVideoPost.findMany({
            where: { deletedAt: null, finishedAt: { gte: cutoff }, NOT: { publishedChannels: { isEmpty: true } } },
            orderBy: { finishedAt: "desc" },
            take: RECENTLY_PUBLISHED_FREE_LIMIT,
            select: { id: true, title: true, status: true, finishedAt: true, publishedChannels: true },
          })
        ).map((v) => ({ id: v.id, title: v.title, status: v.status, publishedAt: v.finishedAt, publishedChannels: v.publishedChannels }))
      : [];

  res.json({ items, freeVideos, total, page, pageSize, windowDays: RECENTLY_PUBLISHED_WINDOW_DAYS });
});

/**
 * Раздел 2: «Нагрузка по монтажёрам».
 *
 * ВАЖНО про модель данных: в схеме НЕТ поля «ответственный монтажёр» на
 * Property — на этапе EDITING ответственный это РОЛЬ (PROPERTY_STAGE_OWNER),
 * а не конкретный сотрудник (см. комментарий у POST /properties/:id/complete-editing
 * в routes/properties.ts: «ответственный — это роль, а не отдельная колонка»).
 * Любой монтажёр может забрать в работу любой объект на EDITING — персонального
 * закрепления не существует.
 *
 * Поэтому «нагрузка по монтажёрам» здесь — это НЕ разбивка одной и той же
 * очереди по сотрудникам (это было бы обманчиво: сумма по монтажёрам не должна
 * казаться больше самой очереди), а список активных монтажёров рядом с общим
 * состоянием очереди монтажа. Если позже появится персональное закрепление
 * (поле editorId на Property), эта агрегация должна быть заменена на группировку
 * по нему — оставлен явный комментарий, чтобы не потерялось.
 */
/**
 * Раздел 3: РАБОЧАЯ ОЧЕРЕДЬ МОНТАЖЁРА — то, что он должен увидеть, открыв CRM.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ /editors-load. Тот отдаёт ЧИСЛА (сколько на монтаже, сколько
 * просрочено, кто из монтажёров активен) — этого хватает значку в меню, но не
 * хватает человеку: чтобы понять, ЧТО именно делать, монтажёр шёл в «Объекты» и
 * руками выбирал фильтр «На монтаже». Здесь те же объекты списком.
 *
 * ДВА СПИСКА, А НЕ ОДИН. `inEditing` — работа прямо сейчас (EDITING). `upcoming` —
 * объекты на этапе «Ожидает видео»: они ещё не его, снимает агент, но именно они
 * придут к нему следующими, и это единственный честный способ дать монтажёру
 * планировать день, не дёргая его пушем на каждую новую карточку (см. решение о
 * notifyPendingReview в lib/propertyPipeline.ts).
 *
 * Предел выборки жёсткий (EDITOR_QUEUE_LIMIT на страницу): роут возвращает
 * массив, а очередь монтажа теоретически неограниченна. С 02.10.2026 у каждого
 * списка своя страница (editingPage/upcomingPage) и «Показать ещё» на экране —
 * раньше 51-й объект нельзя было увидеть вовсе. Счётчики — отдельным count():
 * число под плиткой обязано быть честным, даже когда список подрезан.
 */
const EDITOR_QUEUE_LIMIT = 50;

/** Страница считается отдельно по каждому из двух списков (02.10.2026): «Показать
 *  ещё» под «На монтаже» не должно листать «Скоро придут», и наоборот. */
const editorQueueQuerySchema = z.object({
  editingPage: z.coerce.number().int().min(1).max(1000).default(1),
  upcomingPage: z.coerce.number().int().min(1).max(1000).default(1),
});

marketingRouter.get("/editor-queue", requireEditorsLoadRole, async (req, res) => {
  const parsed = editorQueueQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверный номер страницы", details: parsed.error.flatten() });
  const { editingPage, upcomingPage } = parsed.data;
  const editingWhere = { deletedAt: null, status: "EDITING" as const };
  const upcomingWhere = { deletedAt: null, status: "AWAITING_VIDEO" as const };

  const [editingRows, upcomingRows, inEditingTotal, upcomingTotal, editingStages, deadlines, handoffPositions] = await Promise.all([
    prisma.property.findMany({
      where: editingWhere,
      include: PROPERTY_LIST_INCLUDE,
      // Дольше всех ждущий — первым: очередь монтажа живёт по времени входа в
      // этап, тем же порядком, что и «Очередь подготовки» у маркетинга.
      orderBy: [{ stageEnteredAt: "asc" }, { id: "asc" }],
      skip: (editingPage - 1) * EDITOR_QUEUE_LIMIT,
      take: EDITOR_QUEUE_LIMIT,
    }),
    prisma.property.findMany({
      where: upcomingWhere,
      include: PROPERTY_LIST_INCLUDE,
      orderBy: [{ stageEnteredAt: "asc" }, { id: "asc" }],
      skip: (upcomingPage - 1) * EDITOR_QUEUE_LIMIT,
      take: EDITOR_QUEUE_LIMIT,
    }),
    prisma.property.count({ where: editingWhere }),
    prisma.property.count({ where: upcomingWhere }),
    // Просрочка — по всему этапу, а не по выданной странице (02.10.2026): с
    // «Показать ещё» страница перестала быть «всем списком». Тот же приём и
    // потолок, что у /editors-load ниже: только две колонки, правило — stageState.
    prisma.property.findMany({
      where: editingWhere,
      select: { status: true, stageEnteredAt: true },
      take: MARKETING_PIPELINE_SCAN_CAP,
    }),
    loadPipelineDeadlines(),
    videoHandoffQueuePositions(),
  ]);

  const [inEditing, upcoming] = await Promise.all([
    pipelineRows(editingRows, req, handoffPositions),
    pipelineRows(upcomingRows, req, handoffPositions),
  ]);
  res.json({
    inEditing,
    upcoming,
    editingPage,
    upcomingPage,
    pageSize: EDITOR_QUEUE_LIMIT,
    counts: {
      inEditing: inEditingTotal,
      overdue: editingStages.filter((p) => stageState(p.status, p.stageEnteredAt, deadlines).overdue).length,
      upcoming: upcomingTotal,
    },
  });
});

/**
 * Ручная отмена из очереди хендоффа (владелец 19.09.2026 — «чтобы админ и
 * монтажёр и директор видели очередь и могли отменять»). Та же роль, что видит
 * `/editor-queue` (маркетинг/монтажёр/директор/админ), может снять ЛЮБОЙ
 * объект с передачи боту, не только свой — очередь на всех одна, «строго по
 * одному» монтажёру. Объект остаётся на своём этапе (обычно EDITING), меняется
 * только `videoHandoffStatus` — см. lib/videoHandoff.ts::cancelVideoHandoffQueueEntry.
 */
marketingRouter.post("/video-handoff/:id/cancel", requireEditorsLoadRole, async (req, res) => {
  // Тело необязательно: старый клиент шлёт POST без тела — значит «как было»
  // (место уходит следующему). holdQueue=true — придержать очередь (24.09.2026).
  const parsed = cancelVideoHandoffBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const result = await cancelVideoHandoffQueueEntry(req.params.id, {
    holdQueue: parsed.data.holdQueue,
    pauseReason: parsed.data.reason,
    pausedById: req.agent!.id,
  });
  if (!result.ok) return res.status(result.code === "NOT_FOUND" ? 404 : 409).json({ error: result.error, code: result.code });
  logAudit(req, "PROPERTY_VIDEO_HANDOFF_CANCELLED", "Property", req.params.id, {
    holdQueue: parsed.data.holdQueue,
    reason: parsed.data.reason ?? null,
  });
  res.json({ ok: true });
});

/**
 * ПЕРЕСТАНОВКА В ОЧЕРЕДИ МОНТАЖА (24.09.2026, владелец: «кнопку, чтобы
 * передвигать очередь — какой-то объект быстрее на монтаж»). Право — то же,
 * что у снятия. Держателя места двигать нельзя — 409 HOLDER_CANNOT_MOVE.
 * См. lib/videoHandoff.ts::moveVideoHandoffInQueue.
 */
marketingRouter.post("/video-handoff/:id/move", requireEditorsLoadRole, async (req, res) => {
  const parsed = videoHandoffMoveBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const result = await moveVideoHandoffInQueue(req.params.id, parsed.data);
  if (!result.ok) return res.status(result.code === "NOT_FOUND" ? 404 : 409).json({ error: result.error, code: result.code });
  if (result.from !== result.to) {
    logAudit(req, "PROPERTY_VIDEO_HANDOFF_MOVED", "Property", req.params.id, {
      shortId: result.shortId,
      from: result.from,
      to: result.to,
      move: parsed.data.to,
    });
  }
  const body: VideoHandoffMoveResult = { ok: true, shortId: result.shortId, from: result.from, to: result.to };
  res.json(body);
});

/**
 * ОТЛОЖИТЬ / ВЕРНУТЬ В ОЧЕРЕДЬ ОДИН ОБЪЕКТ (25.09.2026, владелец: «чтобы была
 * возможность придерживать какой-то монтаж на паузе»). Право то же, что у
 * снятия/хода. Держателя места (SENT_TO_EDITOR) отложить нельзя — 409, для
 * него есть «Снять с монтажа». См. lib/videoHandoff.ts::holdVideoHandoff.
 */
marketingRouter.post("/video-handoff/:id/hold", requireEditorsLoadRole, async (req, res) => {
  const parsed = holdVideoHandoffBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const result = await holdVideoHandoff(req.params.id, { reason: parsed.data.reason, byId: req.agent!.id });
  if (!result.ok) return res.status(result.code === "NOT_FOUND" ? 404 : 409).json({ error: result.error, code: result.code });
  logAudit(req, "PROPERTY_VIDEO_HANDOFF_HELD", "Property", req.params.id, { reason: parsed.data.reason ?? null });
  res.json({ ok: true });
});

/** См. lib/videoHandoff.ts::releaseVideoHandoffHold. */
marketingRouter.post("/video-handoff/:id/unhold", requireEditorsLoadRole, async (req, res) => {
  const result = await releaseVideoHandoffHold(req.params.id);
  if (!result.ok) return res.status(result.code === "NOT_FOUND" ? 404 : 409).json({ error: result.error, code: result.code });
  logAudit(req, "PROPERTY_VIDEO_HANDOFF_RELEASED", "Property", req.params.id, {});
  res.json({ ok: true });
});

/**
 * ОТПРАВИТЬ МОНТАЖЁРУ ПОВТОРНО ИЗ CRM (25.09.2026, владелец: «повторно
 * отправить монтажёру, если мы не получили файл»). Только для держателя места
 * (SENT_TO_EDITOR, не ручная загрузка) — тот же смысл, что у `resendSourceVideos`
 * в боте (telegram/bot.ts), но по объекту из CRM, а не «текущему у монтажёра»
 * из чата. Переиспользует dispatchToEditor через dispatchInBackground (файл_id
 * уже ушедшего ролика долетит мгновенно, недошедший — заново), а не копирует
 * логику отправки. Ответ сразу, отправка идёт в фоне (та же причина, что у
 * releaseQueueIfClear — браузер рвёт запрос на 30 с).
 */
marketingRouter.post("/video-handoff/:id/resend", requireEditorsLoadRole, async (req, res) => {
  const propertyId = req.params.id;
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      shortId: true,
      deletedAt: true,
      videoHandoffStatus: true,
      videoHandoffManualSince: true,
      videoHandoffDispatchStartedAt: true,
    },
  });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (property.videoHandoffStatus !== "SENT_TO_EDITOR" || property.videoHandoffManualSince) {
    return res.status(409).json({ error: "Объект сейчас не у монтажёра", code: "NOT_HOLDER" });
  }
  if (
    property.videoHandoffDispatchStartedAt &&
    Date.now() - property.videoHandoffDispatchStartedAt.getTime() < HANDOFF_DISPATCH_BUSY_WINDOW_MS
  ) {
    return res.status(409).json({ error: "Уже отправляется — подождите", code: "BUSY" });
  }
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  if (!settings?.videoMontajerAgentId) return res.status(409).json({ error: "Монтажёр не назначен в Настройках", code: "NO_MONTAJER" });
  // «Повторно» из CRM = человек говорит, что монтажёр файлы НЕ получил, хотя
  // отметки могут стоять: шлём всё заново (дошедшее — по file_id, это секунда и
  // ноль байт; см. deliverSourceVideos), а не только «недошедшее», как слово
  // «файлы» у бота.
  dispatchInBackground(propertyId, settings.videoMontajerAgentId, { resend: "all" });
  logAudit(req, "PROPERTY_VIDEO_HANDOFF_RESENT", "Property", propertyId, { shortId: property.shortId });
  res.json({ started: true });
});

/**
 * СОСТОЯНИЕ И ПАУЗА ОЧЕРЕДИ МОНТАЖЁРА (24.09.2026, снятие №133/134/135 подряд
 * отдало монтажёру три объекта, которые никто не собирался ему давать). Экран
 * конвейера показывает, кому уйдёт место при снятии держателя, и умеет
 * придержать очередь. Право то же, что у снятия.
 */
marketingRouter.get("/video-handoff/queue-state", requireEditorsLoadRole, async (_req, res) => {
  const state: VideoHandoffQueueState = await videoHandoffQueueState();
  res.json(state);
});

marketingRouter.post("/video-handoff/queue/pause", requireEditorsLoadRole, async (req, res) => {
  const parsed = pauseVideoHandoffQueueBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  await setVideoHandoffQueuePaused(true, { byId: req.agent!.id, reason: parsed.data.reason });
  logAudit(req, "VIDEO_HANDOFF_QUEUE_PAUSED", "Settings", "singleton", { reason: parsed.data.reason ?? null });
  res.json(await videoHandoffQueueState());
});

marketingRouter.post("/video-handoff/queue/resume", requireEditorsLoadRole, async (req, res) => {
  await setVideoHandoffQueuePaused(false);
  logAudit(req, "VIDEO_HANDOFF_QUEUE_RESUMED", "Settings", "singleton", {});
  res.json(await videoHandoffQueueState());
});

marketingRouter.get("/editors-load", requireEditorsLoadRole, async (_req, res) => {
  const deadlines = await loadPipelineDeadlines();
  const [editors, editingProperties] = await Promise.all([
    prisma.agent.findMany({
      where: { role: "EDITOR" },
      select: { id: true, fullName: true, avatarUrl: true, isActive: true },
      orderBy: { fullName: "asc" },
      // Потолок обязателен даже там, где агентов десяток — см. hallOfFame.ts.
      take: 500,
    }),
    prisma.property.findMany({
      where: { deletedAt: null, status: "EDITING" },
      select: { status: true, stageEnteredAt: true },
      take: MARKETING_PIPELINE_SCAN_CAP,
    }),
  ]);
  if (editingProperties.length >= MARKETING_PIPELINE_SCAN_CAP) {
    void logSystemError("api", `Маркетинг «Нагрузка монтажёров»: EDITING больше ${MARKETING_PIPELINE_SCAN_CAP} объектов — счётчики занижены`);
  }

  const overdueCount = editingProperties.filter(
    (p) => stageState(p.status, p.stageEnteredAt, deadlines).overdue
  ).length;

  res.json({
    editors,
    sharedQueue: {
      inEditing: editingProperties.length,
      overdue: overdueCount,
    },
  });
});

/**
 * Счётчик для экрана Настроек (блок «Фид каталога для рекламы Meta»): сколько
 * объектов сейчас реально уйдёт в CSV. Те же строки, что отдаёт сам публичный
 * маршрут (lib/metaCatalogFeed.ts, кэш на 10 минут) — считать отдельно значило
 * бы рано или поздно разойтись с тем, что Meta получает на самом деле.
 */
marketingRouter.get("/meta-catalog-feed/status", requireMarketingRole, async (_req, res) => {
  const rows = await loadCatalogProperties();
  res.json({ count: rows.length });
});

/**
 * СПИСОК ПОСЛЕДНИХ ПОДБОРОК (28.09.2026, agent-brief.md reposts-digests) —
 * панель публикаций Центра маркетинга: заголовок, дата, каналы, ссылка.
 * Группируем по (kind, title, propertyIds, createdAt-минута приблизительно) —
 * проще и честнее: три строки SocialDigestPost (по каналу) одной публикации
 * создаются в одной транзакции, поэтому createdAt у них совпадает секунда в
 * секунду — группировка по нему безопасна.
 */
marketingRouter.get("/digests", requireMarketingRole, async (_req, res) => {
  const rows = await prisma.socialDigestPost.findMany({
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true,
      kind: true,
      title: true,
      propertyIds: true,
      channel: true,
      status: true,
      publishedAt: true,
      permalink: true,
      createdAt: true,
    },
  });
  const groups = new Map<string, { title: string; kind: string; propertyCount: number; createdAt: Date; channels: { channel: string; status: string; permalink: string | null }[] }>();
  for (const r of rows) {
    const key = `${r.createdAt.toISOString()}:${r.title}`;
    const g = groups.get(key) ?? { title: r.title, kind: r.kind, propertyCount: r.propertyIds.length, createdAt: r.createdAt, channels: [] };
    g.channels.push({ channel: r.channel, status: r.status, permalink: r.permalink });
    groups.set(key, g);
  }
  res.json({ digests: [...groups.values()].slice(0, 20) });
});

/**
 * «СОБРАТЬ ПОДБОРКУ СЕЙЧАС» (28.09.2026, agent-brief.md reposts-digests) —
 * та же функция, что зовёт крон (runSocialDigestsTick), но день/час/
 * digestLastRunAt здесь НЕ проверяются: явная кнопка человека, а не автомат
 * по расписанию — тот же приём, что у /:id/photo-post и /:id/repost (force
 * обходит только рубильник Settings.digestsEnabled внутри pickDigest — сама
 * подборка не гейтится им, гейт стоит только у крона).
 */
const runDigestNowSchema = z.object({});
marketingRouter.post("/digests/run", requireMarketingRole, async (req, res) => {
  runDigestNowSchema.parse(req.body ?? {});
  try {
    const result = await runSocialDigestsTick(new Date(), { force: true });
    logAudit(req, "SOCIAL_DIGEST_RUN", "SocialDigestPost", null, { kind: result.kind ?? null, published: result.published ?? 0, failed: result.failed ?? 0 });
    res.status(200).json(result);
  } catch (err) {
    void logSystemError("meta", `Ручной запуск подборки не удался: ${describeError(err)}`);
    res.status(500).json({ error: "Не удалось собрать подборку" });
  }
});
