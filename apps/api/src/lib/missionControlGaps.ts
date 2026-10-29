import { visibleErrorLogs } from "./systemErrorVisibility.js";
import { expenseCentsToTjs } from "./money.js";
import { visibleInteractionWhere } from "./investigationPrivacy.js";
import { canViewInvestigations } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { dushanbeDayRange, dushanbeStartOfMonth, dushanbeStartOfToday, dushanbeWallClock } from "./dushanbeTime.js";
import { centsToTjs, loadMoneyContext, roundMoney, toCents } from "./money.js";
import { activeLeadCounts, loadLeadLimits, slotsTaken } from "./leadLimits.js";
import { isBotEnabledForChannel } from "../messengers/botChannels.js";
import { loadCredentials } from "../messengers/meta.js";
import { HAS_INSTAGRAM_LINK_WHERE, NO_INSTAGRAM_LINK_WHERE } from "./instagramLink.js";
import { getExtensionStatuses } from "./telephony/extensionPool.js";
import { RATED_ROLES } from "@royal-home/shared";
import { TASK_WHERE } from "./tasks.js";

/**
 * БЛОКИ ПУЛЬТА, КОТОРЫЕ ПОКАЗЫВАЛИ «НЕТ ДАННЫХ» (владелец 12.09.2026: «почему
 * некоторые разделы без данных? всё должно работать»).
 *
 * При переносе артефакта «Единый пульт директора» (шаги 1–5, 10.09.2026) разметка
 * каждого блока была скопирована дословно, а вот сервер под добрую половину из них
 * не считал ничего: карточка рисовалась корпусом и честной строкой «на пульт эти
 * данные пока не приходят». Честно — но бесполезно; этот файл закрывает пробел.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ДОПИСАТЬ В routes/dashboardMissionControl.ts: тот и
 * так 687 строк и держит каркас (кэш, гейты модулей, конверт ответа). Считалки
 * живут рядом с остальными — lib/marketingFunnel.ts, lib/leaderboard.ts,
 * lib/financePulse.ts, — и роут остаётся сборкой, а не свалкой запросов.
 *
 * ОБЩИЕ ПРАВИЛА ЭТОГО ФАЙЛА:
 *  - данные НЕ выдумываются: если в базе пусто, возвращается пустой список и
 *    поле-объяснение `reason` — фронт печатает причину («за 30 дней публикаций не
 *    было»), а не безликое «нет данных»;
 *  - у каждой выборки есть ПРЕДЕЛ (take) — пульт опрашивается раз в минуту, и
 *    безлимитный findMany здесь стоил бы базе дороже всего экрана;
 *  - никаких `await` внутри `map` по строкам из базы: счётчики берутся groupBy или
 *    одним $queryRaw на всю страницу;
 *  - границы суток и месяцев — только через lib/dushanbeTime.ts.
 */

/** Сколько строк отдаём в списках блоков — столько же, сколько показывает артефакт. */
const LIST_CAP = 6;

/** Потолок кандидатов для выборок, которые нельзя посчитать одним COUNT. */
const SCAN_CAP = 500;

/** Причина пустоты блока: фронт печатает её вместо «нет данных». */
export type McReason = string;

export interface McEmptyable {
  /** Пусто и почему. `null` — данные есть. */
  reason: McReason | null;
}

// ─── Ждут публикации ─────────────────────────────────────────────────────────

export interface McPublishQueueItem {
  id: string;
  shortId: number;
  title: string;
  /** Сколько дней объект в продаже и всё ещё ни в одном канале. */
  waitingDays: number;
}

export interface McPublishQueue extends McEmptyable {
  count: number;
  items: McPublishQueueItem[];
  /** Сколько объектов уже разошлось по каналам — знаменатель для «N из M». */
  publishedCount: number;
}

/**
 * «Ждут публикации» — объекты В ПРОДАЖЕ, которых нет НИ В ОДНОМ канале
 * (`publishedChannels` пуст). Ровно то, что спрашивает карточка: не «что недавно
 * опубликовали» (это отдельный роут /marketing/recently-published), а что стоит
 * готовое и до сайта с соцсетями так и не доехало.
 *
 * Срок ожидания считается от `stageEnteredAt` (момент попадания в текущий статус),
 * а не от `createdAt`: объект мог месяц готовиться в конвейере, и «ждёт публикации
 * 30 дней» было бы неправдой.
 */
export async function loadPublishQueue(now: Date): Promise<McPublishQueue> {
  const where = {
    deletedAt: null,
    status: "AVAILABLE",
    publishedChannels: { isEmpty: true },
    // Рабочая ссылка Instagram в карточке = ролик вышел, даже если каналы не отмечены
    // (05.10.2026): такой объект не «ждёт публикации».
    AND: [NO_INSTAGRAM_LINK_WHERE],
  } satisfies Prisma.PropertyWhereInput;

  const [count, rows, publishedCount] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({
      where,
      orderBy: { stageEnteredAt: "asc" },
      take: LIST_CAP,
      select: { id: true, shortId: true, title: true, stageEnteredAt: true, createdAt: true },
    }),
    // Знаменатель «N из M»: вышедшие по каналам ИЛИ с рабочей ссылкой Instagram — дополнение к `where` выше.
    prisma.property.count({ where: { deletedAt: null, OR: [{ publishedChannels: { isEmpty: false } }, HAS_INSTAGRAM_LINK_WHERE] } }),
  ]);

  return {
    count,
    publishedCount,
    items: rows.map((p) => ({
      id: p.id,
      shortId: p.shortId,
      title: p.title,
      waitingDays: Math.max(0, Math.floor((now.getTime() - (p.stageEnteredAt ?? p.createdAt).getTime()) / 86_400_000)),
    })),
    reason:
      count > 0
        ? null
        : publishedCount > 0
          ? "Все объекты в продаже уже разошлись по каналам."
          : "Объектов в продаже нет — публиковать нечего.",
  };
}

// ─── Каналы ──────────────────────────────────────────────────────────────────

export interface McChannelRow {
  id: string;
  label: string;
  /** Подключён ли канал (есть токен/идентификатор в настройках). */
  connected: boolean;
  /** Отвечает ли бот в этом канале (тот же рубильник, что и в живой переписке). */
  botEnabled: boolean | null;
  /** Короткое пояснение состояния для строки карточки. */
  detail: string;
}

/** Канал, у которого последняя ночная самопроверка нашла поломку (IntegrationHealthSnapshot.ok=false). */
export interface McChannelProblem {
  /** Имя канала, как в снимке самопроверки (IntegrationCheck.name). */
  channel: string;
  /** Что сломано — короткий текст (до 160 знаков). */
  problem: string;
  /** Когда проверено (ISO). */
  checkedAt: string;
  /** Куда идти чинить — путь экрана веб-приложения. */
  fixPath: string;
}

export interface McChannelsHealth extends McEmptyable {
  items: McChannelRow[];
  /** Поломки по живой самопроверке (не «токен задан»). Пусто — поломок нет ИЛИ снимка ещё нет (см. healthCheckedAt). */
  problems?: McChannelProblem[];
  /** Время самой свежей строки снимка самопроверки; null — снимка нет («нет данных»). */
  healthCheckedAt?: string | null;
  /** У OpenAI закончились деньги: за 24 ч есть нерешённая ошибка с insufficient_quota / «закончились деньги». */
  openaiOutOfMoney?: boolean;
  connectedCount: number;
  /** Неразобранные ошибки каналов из «Здоровья системы» (источники meta/telegram). */
  openErrors: number;
  autoPublishEnabled: boolean;
}

/**
 * «Каналы» — то же, что показывает /marketing/channels-status, но сведённое в
 * плоский список строк: карточка на пульте узкая, дерево вложенных флагов в неё
 * не помещается. Источник данных ОДИН И ТОТ ЖЕ (Settings + isBotEnabledForChannel),
 * дублирующей логики «подключено ли» здесь нет — только раскладка в строки.
 */
/** Экран, где чинят внешние доступы (ночная самопроверка и ключи). */
export const CHANNEL_FIX_PATH = "/integrations";

/** Признаки «деньги на OpenAI кончились» в тексте ErrorLog (openaiClient.isOutOfMoney + describeOpenAiError). */
const OPENAI_MONEY_SIGNS = ["insufficient_quota", "закончились деньги", "billing_hard_limit_reached"];

export async function loadChannelsHealth(now: Date = new Date()): Promise<McChannelsHealth> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [snapshots, openaiMoneyErrors] = await Promise.all([
    prisma.integrationHealthSnapshot.findMany({ orderBy: { name: "asc" }, take: 100 }),
    visibleErrorLogs().count({
      where: {
        resolvedAt: null,
        createdAt: { gte: dayAgo },
        OR: OPENAI_MONEY_SIGNS.map((sign) => ({ message: { contains: sign, mode: "insensitive" as const } })),
      },
    }),
  ]);
  const problems: McChannelProblem[] = snapshots
    .filter((r) => r.ok === false)
    .map((r) => ({
      channel: r.name,
      problem: (r.detail ?? "проверка не прошла").slice(0, 160),
      checkedAt: r.checkedAt.toISOString(),
      fixPath: CHANNEL_FIX_PATH,
    }));
  const healthCheckedAt = snapshots.length
    ? new Date(Math.max(...snapshots.map((r) => r.checkedAt.getTime()))).toISOString()
    : null;
  const [settings, openErrors] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        autoPublishEnabled: true,
        metaPageToken: true,
        metaPageId: true,
        telegramChannelId: true,
        telegramDiscussionGroupId: true,
        youtubeClientId: true,
        youtubeClientSecret: true,
        youtubeRefreshToken: true,
        tiktokRefreshToken: true,
        threadsAccessToken: true,
        threadsUserId: true,
      },
    }),
    visibleErrorLogs().count({ where: { resolvedAt: null, source: { in: ["meta", "telegram"] } } }),
  ]);

  const [botInstagram, botFacebook, botTelegram] = await Promise.all([
    isBotEnabledForChannel("INSTAGRAM"),
    isBotEnabledForChannel("FACEBOOK"),
    isBotEnabledForChannel("TELEGRAM"),
  ]);

  // Маркер Instagram — тот же, которым публикует и отвечает сам код
  // (loadCredentials: основной аккаунт списка → поле → окружение), а не одно
  // запасное поле Settings.metaIgToken: при аккаунте списком оно пустое, и пульт
  // говорил «токен не задан» у работающего канала (28.09.2026).
  const igConnected = Boolean((await loadCredentials()).igToken);
  const fbConnected = Boolean(settings?.metaPageToken && settings?.metaPageId);
  const tgConnected = Boolean(settings?.telegramChannelId);
  const ytConnected = Boolean(settings?.youtubeClientId && settings?.youtubeClientSecret && settings?.youtubeRefreshToken);
  const ttConnected = Boolean(settings?.tiktokRefreshToken);
  const thConnected = Boolean(settings?.threadsAccessToken && settings?.threadsUserId);

  const items: McChannelRow[] = [
    {
      id: "INSTAGRAM",
      label: "Instagram",
      connected: igConnected,
      botEnabled: botInstagram,
      detail: igConnected ? (botInstagram ? "подключён, бот отвечает" : "подключён, бот выключен") : "токен не задан",
    },
    {
      id: "FACEBOOK",
      label: "Facebook",
      connected: fbConnected,
      botEnabled: botFacebook,
      detail: fbConnected ? (botFacebook ? "подключён, бот отвечает" : "подключён, бот выключен") : "страница не привязана",
    },
    {
      id: "TELEGRAM",
      label: "Telegram",
      connected: tgConnected,
      botEnabled: botTelegram,
      detail: tgConnected
        ? settings?.telegramDiscussionGroupId
          ? "канал и обсуждения подключены"
          : "канал подключён, обсуждений нет"
        : "канал не указан",
    },
    {
      id: "YOUTUBE",
      label: "YouTube",
      connected: ytConnected,
      botEnabled: null,
      detail: ytConnected ? "доступ выдан" : "доступ не выдан",
    },
    {
      id: "TIKTOK",
      label: "TikTok",
      connected: ttConnected,
      botEnabled: null,
      detail: ttConnected ? "доступ выдан" : "доступ не выдан",
    },
    {
      id: "THREADS",
      label: "Threads",
      connected: thConnected,
      botEnabled: null,
      detail: thConnected ? "доступ выдан" : "доступ не выдан",
    },
  ];

  const connectedCount = items.filter((c) => c.connected).length;
  return {
    items,
    problems,
    healthCheckedAt,
    openaiOutOfMoney: openaiMoneyErrors > 0,
    connectedCount,
    openErrors,
    autoPublishEnabled: settings?.autoPublishEnabled ?? false,
    reason: connectedCount > 0 ? null : "Ни один канал не подключён — откройте «Настройки → Каналы связи».",
  };
}

// ─── Бот замолчал / клиент ждёт агента ───────────────────────────────────────

export interface McDialogRow {
  id: string;
  /** "BOT" — BotConversation (Instagram/Facebook/WhatsApp), "TELEGRAM" — TelegramConversation. */
  kind: "BOT" | "TELEGRAM";
  channel: string;
  title: string;
  clientId: string | null;
  lastMessageAt: string;
  /** Сколько минут клиент ждёт ответа. */
  waitingMinutes: number;
}

export interface McDialogZone extends McEmptyable {
  count: number;
  items: McDialogRow[];
}

export interface McBotAttention {
  /** Бот замолчал: последняя реплика клиента, бот НЕ на паузе, ответа нет дольше порога. */
  silent: McDialogZone;
  /** Клиент ждёт человека: бота поставили на паузу (передали агенту), а ответа всё нет. */
  waitingHuman: McDialogZone;
  /** Бот прямо сейчас: сколько диалогов получили реплику за последние 15 минут. */
  liveCount: number;
}

/** Сколько минут молчания считать поломкой, а не паузой на размышление. */
const BOT_SILENCE_MINUTES = 15;
/** Окно «прямо сейчас» для строки «Бот прямо сейчас». */
const BOT_LIVE_MINUTES = 15;

interface RawDialogRow {
  id: string;
  kind: "BOT" | "TELEGRAM";
  channel: string;
  title: string;
  clientId: string | null;
  lastMessageAt: Date;
  paused: boolean;
}

/**
 * Одна выборка на оба блока: обе таблицы диалогов читаются ОДНИМ `$queryRaw`
 * с UNION ALL (как это уже делает routes/conversations.ts) — иначе на каждый
 * блок уходило бы по два запроса, а их и так два.
 *
 * «Последняя реплика от клиента» определяется тем же предикатом, что в инбоксе:
 * `messages -> -1 ->> 'role' = 'user'`. Держать здесь свою копию правила нельзя —
 * разошлись бы цифры на пульте и в разделе; предикат вынесен в константу ниже.
 */
const LAST_FROM_CLIENT_SQL = Prisma.sql`jsonb_typeof(c."messages") = 'array' AND (c."messages" -> -1 ->> 'role') = 'user'`;

export async function loadBotAttention(now: Date): Promise<McBotAttention> {
  const silenceCutoff = new Date(now.getTime() - BOT_SILENCE_MINUTES * 60_000);
  const liveCutoff = new Date(now.getTime() - BOT_LIVE_MINUTES * 60_000);

  const [rows, liveCount] = await Promise.all([
    prisma.$queryRaw<RawDialogRow[]>`
      SELECT c."id",
             'BOT'::text AS "kind",
             c."channel",
             COALESCE(NULLIF(cl."fullName", ''), c."subscriberId") AS "title",
             c."clientId",
             COALESCE(c."lastMessageAt", c."updatedAt") AS "lastMessageAt",
             (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > ${now}) OR c."botPausedAt" IS NOT NULL AS "paused"
        FROM "BotConversation" c
        LEFT JOIN "Client" cl ON cl."id" = c."clientId"
       WHERE ${LAST_FROM_CLIENT_SQL}
         AND COALESCE(c."lastMessageAt", c."updatedAt") < ${silenceCutoff}
       UNION ALL
      SELECT c."id",
             'TELEGRAM'::text AS "kind",
             'TELEGRAM'::text AS "channel",
             COALESCE(NULLIF(cl."fullName", ''), NULLIF(c."username", ''), c."chatId") AS "title",
             c."clientId",
             COALESCE(c."lastMessageAt", c."updatedAt") AS "lastMessageAt",
             (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > ${now}) OR c."botPausedAt" IS NOT NULL AS "paused"
        FROM "TelegramConversation" c
        LEFT JOIN "Client" cl ON cl."id" = c."clientId"
       WHERE ${LAST_FROM_CLIENT_SQL}
         AND COALESCE(c."lastMessageAt", c."updatedAt") < ${silenceCutoff}
       ORDER BY "lastMessageAt" ASC
       LIMIT ${SCAN_CAP}
    `,
    prisma
      .$queryRaw<{ n: bigint }[]>`
        SELECT (
          (SELECT COUNT(*) FROM "BotConversation" WHERE COALESCE("lastMessageAt", "updatedAt") >= ${liveCutoff})
          +
          (SELECT COUNT(*) FROM "TelegramConversation" WHERE COALESCE("lastMessageAt", "updatedAt") >= ${liveCutoff})
        ) AS n
      `
      .then((r) => Number(r[0]?.n ?? 0)),
  ]);

  const toRow = (r: RawDialogRow): McDialogRow => ({
    id: r.id,
    kind: r.kind,
    channel: r.channel,
    title: r.title || "Без имени",
    clientId: r.clientId,
    lastMessageAt: r.lastMessageAt.toISOString(),
    waitingMinutes: Math.max(0, Math.round((now.getTime() - r.lastMessageAt.getTime()) / 60_000)),
  });

  const silentRows = rows.filter((r) => !r.paused);
  const waitingRows = rows.filter((r) => r.paused);

  return {
    liveCount,
    silent: {
      count: silentRows.length,
      items: silentRows.slice(0, LIST_CAP).map(toRow),
      reason: silentRows.length > 0 ? null : `Ни один диалог не ждёт бота дольше ${BOT_SILENCE_MINUTES} минут.`,
    },
    waitingHuman: {
      count: waitingRows.length,
      items: waitingRows.slice(0, LIST_CAP).map(toRow),
      reason: waitingRows.length > 0 ? null : "Никого не передали человеку: бот ведёт все диалоги сам.",
    },
  };
}

// ─── Пульс · 30 дней ─────────────────────────────────────────────────────────

export interface McPulseDay {
  /** Календарная дата по Душанбе, "YYYY-MM-DD". */
  date: string;
  leads: number;
  showings: number;
}

export interface McPulse extends McEmptyable {
  days: McPulseDay[];
  leadsTotal: number;
  showingsTotal: number;
}

const PULSE_DAYS = 30;

/**
 * «Пульс · 30 дней» — подневной ряд «пришло клиентов / состоялось показов».
 *
 * Считается ДВУМЯ groupBy по дню, а не тридцатью парами count: тридцать дней ×
 * два ряда = шестьдесят запросов на каждый опрос пульта, при опросе раз в минуту
 * это шестьдесят тысяч запросов в сутки на одну карточку.
 *
 * День — календарный ПО ДУШАНБЕ: группировка идёт по сдвинутой метке времени
 * (`createdAt + 5 часов`), иначе ряд ломался бы на границе суток ровно так же,
 * как ломался «сторож сегодня» до аудита 02.09.
 */
export async function loadPulse30Days(now: Date, viewerRole?: string): Promise<McPulse> {
  const todayStart = dushanbeStartOfToday(now);
  const from = new Date(todayStart.getTime() - (PULSE_DAYS - 1) * 86_400_000);
  const to = dushanbeDayRange(now).end;

  const [leadRows, showingRows] = await Promise.all([
    prisma.$queryRaw<{ d: Date; n: bigint }[]>`
      SELECT date_trunc('day', "createdAt" + interval '5 hours') AS d, COUNT(*) AS n
        FROM "Client"
       WHERE "deletedAt" IS NULL AND "createdAt" >= ${from} AND "createdAt" < ${to}
       GROUP BY 1
    `,
    prisma.$queryRaw<{ d: Date; n: bigint }[]>`
      SELECT date_trunc('day', "createdAt" + interval '5 hours') AS d, COUNT(*) AS n
        FROM "Interaction"
       WHERE "type" = 'SHOWING' AND "createdAt" >= ${from} AND "createdAt" < ${to}
         AND (${canViewInvestigations(viewerRole)} OR "investigationOnly" = false)
         AND "taskCancelledAt" IS NULL
         AND NOT ("nextAction" IS NULL AND "declinedAt" IS NOT NULL)
       GROUP BY 1
    `,
  ]);

  const key = (d: Date) => d.toISOString().slice(0, 10);
  const leads = new Map(leadRows.map((r) => [key(r.d), Number(r.n)]));
  const showings = new Map(showingRows.map((r) => [key(r.d), Number(r.n)]));

  const days: McPulseDay[] = [];
  for (let i = PULSE_DAYS - 1; i >= 0; i -= 1) {
    const dayStart = new Date(todayStart.getTime() - i * 86_400_000);
    const label = dushanbeWallClock(dayStart).toISOString().slice(0, 10);
    days.push({ date: label, leads: leads.get(label) ?? 0, showings: showings.get(label) ?? 0 });
  }

  const leadsTotal = days.reduce((s, d) => s + d.leads, 0);
  const showingsTotal = days.reduce((s, d) => s + d.showings, 0);
  return {
    days,
    leadsTotal,
    showingsTotal,
    reason: leadsTotal + showingsTotal > 0 ? null : "За 30 дней не было ни одного нового клиента и ни одного показа.",
  };
}

// ─── Комиссия · 12 месяцев ───────────────────────────────────────────────────

export interface McCommissionMonth {
  /** Первое число месяца по Душанбе, "YYYY-MM". */
  month: string;
  amountTjs: number;
  deals: number;
}

export interface McCommission12 extends McEmptyable {
  months: McCommissionMonth[];
  totalTjs: number;
  bestMonth: string | null;
  /**
   * Расходы ТЕКУЩЕГО месяца — строка «Расходы месяца» на пульте, до 12.09.2026
   * стоявшая пустой. Лежит здесь, а не отдельной секцией: это те же деньги за
   * тем же правом finance.view, и лишний ключ в снимке означал бы лишний запрос
   * и лишний кэш ради одного числа.
   */
  expensesMonthTjs: number;
}

const COMMISSION_MONTHS = 12;

/**
 * «Комиссия · 12 месяцев» — закрытые сделки по месяцам закрытия.
 *
 * ВАЛЮТА. Суммировать `commissionAmount` напрямую нельзя: у сделки есть снапшот
 * валюты (`Deal.currency`), и доллар с сомони складывались бы 1:1 — та самая
 * ошибка, ради которой поле currency и заводили. Перевод идёт через общий
 * lib/money.ts (курс из настроек), как в «Финансах» и отчётах.
 *
 * Блок закрыт правом finance.view на вызывающей стороне: без него в снимок
 * уходит `null`, а не нули (правило «никогда не показывать нулевые данные в
 * слоте цифры»).
 */
export async function loadCommission12Months(now: Date): Promise<McCommission12> {
  const monthStart = dushanbeStartOfMonth(now);
  const wall = dushanbeWallClock(monthStart);
  const from = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - (COMMISSION_MONTHS - 1), 1) - 5 * 3600_000);
  const to = dushanbeDayRange(now).end;

  const [deals, money, expenses] = await Promise.all([
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: from, lt: to } },
      select: { closedAt: true, commissionAmount: true, currency: true },
      // Потолок: 12 месяцев сделок агентства — сотни строк, но безлимитный
      // findMany в горячем роуте недопустим по правилу пагинации.
      take: 5000,
      orderBy: { closedAt: "asc" },
    }),
    loadMoneyContext(),
    // Расходы текущего месяца — удалённые (deletedAt) не считаются, как и везде
    // в финансах: решение человека «этой строки быть не должно» сильнее отчёта.
    prisma.expense.findMany({
      where: { deletedAt: null,status:"PAID", month: { gte: monthStart } },
      select: { amount: true, currency: true,exchangeRate:true },
      take: 2000,
    }),
  ]);

  const buckets = new Map<string, { cents: number; deals: number }>();
  const labels: string[] = [];
  for (let i = COMMISSION_MONTHS - 1; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - i, 1));
    const label = m.toISOString().slice(0, 7);
    labels.push(label);
    buckets.set(label, { cents: 0, deals: 0 });
  }

  for (const d of deals) {
    if (!d.closedAt) continue;
    const label = dushanbeWallClock(d.closedAt).toISOString().slice(0, 7);
    const bucket = buckets.get(label);
    if (!bucket) continue;
    bucket.deals += 1;
    bucket.cents += centsToTjs(toCents(d.commissionAmount), d.currency, money);
  }

  const months: McCommissionMonth[] = labels.map((label) => {
    const b = buckets.get(label)!;
    return { month: label, amountTjs: roundMoney(b.cents / 100), deals: b.deals };
  });
  const totalTjs = roundMoney(months.reduce((s, m) => s + m.amountTjs, 0));
  const best = months.reduce<McCommissionMonth | null>((acc, m) => (acc && acc.amountTjs >= m.amountTjs ? acc : m), null);

  const expensesCents = expenses.reduce((acc, e) => acc + expenseCentsToTjs(e, money), 0);

  return {
    months,
    totalTjs,
    bestMonth: best && best.amountTjs > 0 ? best.month : null,
    expensesMonthTjs: roundMoney(expensesCents / 100),
    reason: totalTjs > 0 ? null : "За 12 месяцев закрытых сделок с комиссией не было.",
  };
}

// ─── Карточка клиента (кто ждёт сильнее других) ──────────────────────────────

export interface McAttentionClient extends McEmptyable {
  id: string;
  shortId: number;
  fullName: string;
  status: string;
  kind: string;
  source: string | null;
  agentName: string | null;
  /** Часы с последнего касания. */
  hoursSinceContact: number;
  /** Почему именно он: короткая строка для карточки. */
  why: string;
}

/**
 * «Карточка клиента» — один клиент, который ждёт внимания сильнее прочих.
 *
 * Порядок тот же, что у среза «Мой вид» в разделе «Клиенты»
 * (`attention_desc`, routes/clients/list.ts): сначала непринятые карточки
 * (acceptedAt = null), внутри — по давности последнего касания. Своего порядка
 * тут нет намеренно: два разных «самых горящих клиента» на пульте и в разделе —
 * это вопрос владельца «а кому верить».
 */
export async function loadAttentionClient(now: Date): Promise<McAttentionClient | (McEmptyable & { id: null })> {
  const row = await prisma.client.findFirst({
    where: {
      deletedAt: null,
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      workStatus: "ACTIVE",
    },
    orderBy: [{ acceptedAt: { sort: "asc", nulls: "first" } }, { lastContactAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      shortId: true,
      fullName: true,
      status: true,
      kind: true,
      source: true,
      acceptedAt: true,
      firstContactAt: true,
      lastContactAt: true,
      assignedAgent: { select: { fullName: true } },
    },
  });

  if (!row) return { id: null, reason: "Активных карточек в работе нет." };

  const hours = Math.max(0, Math.floor((now.getTime() - row.lastContactAt.getTime()) / 3_600_000));
  const why = !row.acceptedAt
    ? "карточку ещё не принял агент"
    : !row.firstContactAt
      ? "принята, но первого разговора не было"
      : `последнее касание ${hours} ч назад`;

  return {
    id: row.id,
    shortId: row.shortId,
    fullName: row.fullName,
    status: row.status,
    kind: row.kind,
    source: row.source,
    agentName: row.assignedAgent?.fullName ?? null,
    hoursSinceContact: hours,
    why,
    reason: null,
  };
}

// ─── Заявки на удаление ──────────────────────────────────────────────────────

export interface McDeleteRequestRow {
  id: string;
  kind: "CLIENT" | "PROPERTY";
  title: string;
  reason: string;
  requestedBy: string | null;
  createdAt: string;
  href: string;
}

export interface McDeleteRequests extends McEmptyable {
  clients: number;
  properties: number;
  total: number;
  items: McDeleteRequestRow[];
}

/**
 * «Заявки на удаление» — ожидающие решения просьбы агентов убрать карточку
 * клиента или объекта (clients.requestDelete / properties.requestDelete).
 * Счётчики те же, что уже попадали в «Первую линию» текстом; здесь они становятся
 * числом и списком, чтобы директор решал прямо с пульта.
 */
export async function loadDeleteRequests(): Promise<McDeleteRequests> {
  const [clients, properties, clientRows, propertyRows] = await Promise.all([
    prisma.clientDeleteRequest.count({ where: { status: "PENDING" } }),
    prisma.propertyDeleteRequest.count({ where: { status: "PENDING" } }),
    prisma.clientDeleteRequest.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: LIST_CAP,
      select: {
        id: true,
        reason: true,
        createdAt: true,
        client: { select: { id: true, shortId: true, fullName: true } },
        requestedBy: { select: { fullName: true } },
      },
    }),
    prisma.propertyDeleteRequest.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: LIST_CAP,
      select: {
        id: true,
        reason: true,
        createdAt: true,
        property: { select: { id: true, shortId: true, title: true } },
        requestedBy: { select: { fullName: true } },
      },
    }),
  ]);

  const items: McDeleteRequestRow[] = [
    ...clientRows.map((r) => ({
      id: r.id,
      kind: "CLIENT" as const,
      title: r.client?.fullName ?? "Карточка клиента",
      reason: r.reason,
      requestedBy: r.requestedBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      href: r.client ? `/clients/${r.client.shortId}` : "/archive",
    })),
    ...propertyRows.map((r) => ({
      id: r.id,
      kind: "PROPERTY" as const,
      title: r.property?.title ?? "Карточка объекта",
      reason: r.reason,
      requestedBy: r.requestedBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      href: r.property ? `/properties/${r.property.shortId}` : "/archive",
    })),
  ]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, LIST_CAP);

  const total = clients + properties;
  return {
    clients,
    properties,
    total,
    items,
    reason: total > 0 ? null : "Заявок на удаление, ждущих решения, нет.",
  };
}

// ─── День команды ────────────────────────────────────────────────────────────

export interface McTeamDayRow {
  agentId: string;
  name: string;
  calls: number;
  showings: number;
  tasksDone: number;
  messages: number;
  total: number;
}

export interface McTeamDay extends McEmptyable {
  rows: McTeamDayRow[];
  calls: number;
  showings: number;
  tasksDone: number;
  messages: number;
}

/**
 * «День команды» — звонки, показы, закрытые задачи и переписка за СЕГОДНЯ,
 * по каждому агенту.
 *
 * Всё считается ЧЕТЫРЬМЯ groupBy на всю команду, а не запросом на агента: при
 * десятке агентов запрос-в-цикле давал бы сорок обращений к базе на каждый
 * опрос пульта (правило «никаких await внутри map по списку из БД»).
 *
 * «Переписка» — записи хронологии типа MESSAGE: отдельной таблицы сообщений в
 * схеме нет, реплики лежат JSONB внутри диалога, и считать их по агенту нечем.
 */
export async function loadTeamDay(now: Date, viewerRole?: string): Promise<McTeamDay> {
  const { start, end } = dushanbeDayRange(now);
  const window = { gte: start, lt: end };

  const [agents, calls, showings, tasks, messages] = await Promise.all([
    prisma.agent.findMany({
      where: { isActive: true, role: { in: [...RATED_ROLES, "MANAGER"] } },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
      take: 100,
    }),
    // actorKind: "AGENT" — работа команды считает только живых людей (П-10,
    // 17.09.2026): SYSTEM/AI/BOT/CLIENT-следы в этих цифрах не в счёт, как и в
    // routes/team.ts/lib/kpi.ts.
    prisma.interaction.groupBy({
      by: ["agentId"],
      where: { ...visibleInteractionWhere(viewerRole), type: "CALL", createdAt: window, actorKind: "AGENT" },
      _count: { _all: true },
    }),
    prisma.interaction.groupBy({
      by: ["agentId"],
      where: {
        type: "SHOWING",
        ...visibleInteractionWhere(viewerRole),
        taskCancelledAt: null,
        createdAt: window,
        actorKind: "AGENT",
        NOT: { nextAction: null, declinedAt: { not: null } },
      },
      _count: { _all: true },
    }),
    prisma.interaction.groupBy({ by: ["agentId"], where: { ...visibleInteractionWhere(viewerRole), taskCancelledAt: null, completedAt: window, actorKind: "AGENT" }, _count: { _all: true } }),
    prisma.interaction.groupBy({
      by: ["agentId"],
      where: { ...visibleInteractionWhere(viewerRole), type: "MESSAGE", createdAt: window, actorKind: "AGENT" },
      _count: { _all: true },
    }),
  ]);

  const pick = (rows: { agentId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.filter((r): r is { agentId: string; _count: { _all: number } } => r.agentId !== null).map((r) => [r.agentId, r._count._all]));
  const byCalls = pick(calls);
  const byShowings = pick(showings);
  const byTasks = pick(tasks);
  const byMessages = pick(messages);

  const rows: McTeamDayRow[] = agents
    .map((a) => {
      const c = byCalls.get(a.id) ?? 0;
      const s = byShowings.get(a.id) ?? 0;
      const t = byTasks.get(a.id) ?? 0;
      const m = byMessages.get(a.id) ?? 0;
      return { agentId: a.id, name: a.fullName, calls: c, showings: s, tasksDone: t, messages: m, total: c + s + t + m };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const sum = (f: (r: McTeamDayRow) => number) => rows.reduce((acc, r) => acc + f(r), 0);
  const total = sum((r) => r.total);

  return {
    rows: rows.slice(0, 12),
    calls: sum((r) => r.calls),
    showings: sum((r) => r.showings),
    tasksDone: sum((r) => r.tasksDone),
    messages: sum((r) => r.messages),
    reason:
      rows.length === 0
        ? "Активных агентов в системе нет."
        : total > 0
          ? null
          : "С начала суток по Душанбе ни звонков, ни показов, ни закрытых задач.",
  };
}

// ─── Показы сегодня ──────────────────────────────────────────────────────────

export interface McShowingRow {
  id: string;
  at: string;
  clientName: string;
  clientHref: string;
  propertyTitle: string | null;
  agentName: string;
  /** Подтвердил ли клиент присутствие. */
  confirmed: boolean;
}

export interface McShowingsToday extends McEmptyable {
  count: number;
  confirmed: number;
  items: McShowingRow[];
}

/**
 * «Показы сегодня» — назначенные на сегодня встречи (`nextActionDate` внутри
 * суток по Душанбе), а не проведённые: карточка на пульте отвечает на вопрос
 * «что у команды сегодня», и вчерашние состоявшиеся показы в ней бесполезны.
 * Отменённые (declinedAt при пустом nextAction) исключены тем же условием, что
 * и в календаре, — COUNTED_SHOWING_WHERE.
 */
export async function loadShowingsToday(now: Date, viewerRole?: string): Promise<McShowingsToday> {
  const { start, end } = dushanbeDayRange(now);
  const where = {
    type: "SHOWING",
    ...visibleInteractionWhere(viewerRole),
    taskCancelledAt: null,
    nextActionDate: { gte: start, lt: end },
    NOT: { nextAction: null, declinedAt: { not: null } },
  } satisfies Prisma.InteractionWhereInput;

  const [count, confirmed, rows] = await Promise.all([
    prisma.interaction.count({ where }),
    // «Подтвердили» считаем отдельным запросом по тем же условиям суток, а не по строкам
    // превью (take: LIST_CAP): иначе при 10 подтверждённых показах плитка печатала
    // «10 · подтвердили 6» (аудит Codex 04.10, CHANNEL-CROSSCHECK02).
    prisma.interaction.count({ where: { ...where, confirmedAt: { not: null } } }),
    prisma.interaction.findMany({
      where,
      orderBy: { nextActionDate: "asc" },
      take: LIST_CAP,
      select: {
        id: true,
        nextActionDate: true,
        confirmedAt: true,
        client: { select: { shortId: true, fullName: true } },
        property: { select: { title: true } },
        agent: { select: { fullName: true } },
      },
    }),
  ]);

  return {
    count,
    confirmed,
    items: rows.map((r) => ({
      id: r.id,
      at: (r.nextActionDate ?? start).toISOString(),
      clientName: r.client?.fullName ?? "Клиент",
      clientHref: r.client ? `/clients/${r.client.shortId}` : "/clients",
      propertyTitle: r.property?.title ?? null,
      agentName: r.agent?.fullName ?? "—",
      confirmed: Boolean(r.confirmedAt),
    })),
    reason: count > 0 ? null : "На сегодня показов не назначено.",
  };
}

// ─── Объекты: объект недели, простаивающие, районы ───────────────────────────

export interface McPropertyInterest {
  id: string;
  shortId: number;
  title: string;
  showings: number;
  matches: number;
}

export interface McDistrictRow {
  id: string;
  name: string;
  available: number;
  showingsMonth: number;
}

export interface McPropertiesExtra {
  /** «Объект дня» — объект с наибольшим интересом за неделю. */
  topOfWeek: (McPropertyInterest & McEmptyable) | (McEmptyable & { id: null });
  /** «Объекты месяц без показов». */
  idle: McEmptyable & { count: number; items: { id: string; shortId: number; title: string; idleDays: number }[] };
  /** «Разбивка по районам». */
  districts: McEmptyable & { rows: McDistrictRow[] };
}

const IDLE_DAYS = 30;

export async function loadPropertiesExtra(now: Date, viewerRole?: string): Promise<McPropertiesExtra> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - IDLE_DAYS * 86_400_000);

  const [weekShowings, monthShowings, available, districts] = await Promise.all([
    prisma.interaction.groupBy({
      by: ["propertyId"],
      where: { ...visibleInteractionWhere(viewerRole), taskCancelledAt: null, type: "SHOWING", createdAt: { gte: weekAgo }, propertyId: { not: null } },
      _count: { _all: true },
    }),
    prisma.interaction.findMany({
      where: { ...visibleInteractionWhere(viewerRole), taskCancelledAt: null, type: "SHOWING", createdAt: { gte: monthAgo }, propertyId: { not: null } },
      select: { propertyId: true },
      take: 5000,
    }),
    prisma.property.findMany({
      where: { deletedAt: null, status: "AVAILABLE" },
      select: { id: true, shortId: true, title: true, stageEnteredAt: true, createdAt: true, districtId: true },
      take: 2000,
    }),
    prisma.district.findMany({ select: { id: true, name: true }, take: 100 }),
  ]);

  // Объект недели
  const top = weekShowings
    .filter((r): r is typeof r & { propertyId: string } => Boolean(r.propertyId))
    .sort((a, b) => b._count._all - a._count._all)[0];
  const topProperty = top ? available.find((p) => p.id === top.propertyId) : undefined;
  const topOfWeek: McPropertiesExtra["topOfWeek"] =
    top && topProperty
      ? {
          id: topProperty.id,
          shortId: topProperty.shortId,
          title: topProperty.title,
          showings: top._count._all,
          matches: 0,
          reason: null,
        }
      : { id: null, reason: "За неделю показов ни по одному объекту не было." };

  // Простаивающие
  const shownThisMonth = new Set(monthShowings.map((r) => r.propertyId));
  const idleRows = available
    .filter((p) => !shownThisMonth.has(p.id))
    .map((p) => ({
      id: p.id,
      shortId: p.shortId,
      title: p.title,
      idleDays: Math.max(0, Math.floor((now.getTime() - (p.stageEnteredAt ?? p.createdAt).getTime()) / 86_400_000)),
    }))
    .sort((a, b) => b.idleDays - a.idleDays);

  // Районы
  const availableByDistrict = new Map<string, number>();
  // Закрытый объект (offSite) может остаться без района вовсе — в разрезе по
  // районам ему считаться не с чем, пропускаем.
  for (const p of available) {
    if (!p.districtId) continue;
    availableByDistrict.set(p.districtId, (availableByDistrict.get(p.districtId) ?? 0) + 1);
  }
  const districtOfProperty = new Map(available.filter((p) => p.districtId).map((p) => [p.id, p.districtId as string]));
  const showingsByDistrict = new Map<string, number>();
  for (const s of monthShowings) {
    const d = s.propertyId ? districtOfProperty.get(s.propertyId) : undefined;
    if (d) showingsByDistrict.set(d, (showingsByDistrict.get(d) ?? 0) + 1);
  }
  const districtRows: McDistrictRow[] = districts
    .map((d) => ({
      id: d.id,
      name: d.name,
      available: availableByDistrict.get(d.id) ?? 0,
      showingsMonth: showingsByDistrict.get(d.id) ?? 0,
    }))
    .filter((d) => d.available > 0 || d.showingsMonth > 0)
    .sort((a, b) => b.available - a.available || b.showingsMonth - a.showingsMonth)
    .slice(0, 8);

  return {
    topOfWeek,
    idle: {
      count: idleRows.length,
      items: idleRows.slice(0, LIST_CAP),
      reason:
        idleRows.length > 0
          ? null
          : available.length === 0
            ? "Объектов в продаже нет."
            : `Все объекты в продаже показывали за последние ${IDLE_DAYS} дней.`,
    },
    districts: {
      rows: districtRows,
      reason: districtRows.length > 0 ? null : "Ни в одном районе нет объектов в продаже.",
    },
  };
}

// ─── Вернулись после отказа ──────────────────────────────────────────────────

export interface McReturnedClients extends McEmptyable {
  count: number;
  items: { id: string; shortId: number; fullName: string; returnedAt: string; agentName: string | null }[];
}

const RETURNED_WINDOW_DAYS = 30;

/**
 * «Вернулись после отказа» — карточки с `returnedAt` за последний месяц.
 * Поле ставит ЛЮБОЕ повторное обращение по известному телефону (решение
 * владельца 19.08.2026) — ровно та сущность, которую спрашивает карточка.
 */
export async function loadReturnedClients(now: Date): Promise<McReturnedClients> {
  const cutoff = new Date(now.getTime() - RETURNED_WINDOW_DAYS * 86_400_000);
  const where = { deletedAt: null, returnedAt: { gte: cutoff } } satisfies Prisma.ClientWhereInput;

  const [count, rows] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      orderBy: { returnedAt: "desc" },
      take: LIST_CAP,
      select: {
        id: true,
        shortId: true,
        fullName: true,
        returnedAt: true,
        assignedAgent: { select: { fullName: true } },
      },
    }),
  ]);

  return {
    count,
    items: rows.map((r) => ({
      id: r.id,
      shortId: r.shortId,
      fullName: r.fullName,
      returnedAt: (r.returnedAt ?? now).toISOString(),
      agentName: r.assignedAgent?.fullName ?? null,
    })),
    reason: count > 0 ? null : `За ${RETURNED_WINDOW_DAYS} дней никто из отказавшихся не возвращался.`,
  };
}

// ─── Контроль: просроченные задачи, предел нагрузки, молчание после показа ───

export interface McAgentPhones extends McEmptyable {
  total: number;
  online: number;
  items: { agentId: string; name: string; extension: string; online: boolean }[];
}

export interface McControlGaps {
  /** «Телефоны агентов» в разделе «Звонки» — до 12.09.2026 блок стоял пустым. */
  phones: McAgentPhones;
  overdueTasks: McEmptyable & { count: number; items: { id: string; title: string; agentName: string; overdueDays: number; href: string }[] };
  atLimit: McEmptyable & { count: number; items: { agentId: string; name: string; taken: number; limit: number }[] };
  silentAfterShowing: McEmptyable & { count: number };
}

/**
 * Три плитки «Контроля», которые в артефакте стояли пустыми.
 *
 * «На пределе нагрузки» считается ТЕМ ЖЕ механизмом, что решает выдачу лидов
 * (lib/leadLimits.ts: activeLeadCounts + slotsTaken + взвешенные слоты) — своя
 * копия правила разошлась бы с распределением ровно в тот день, когда владелец
 * поменяет лимит.
 */
/**
 * «Телефоны агентов» — кто из сотрудников с внутренним номером сейчас на связи.
 *
 * ПОЧЕМУ В СЕКЦИИ «СИСТЕМА», А РИСУЕТСЯ В «ЗВОНКАХ». Данные берутся у самой АТС
 * (`getExtensionStatuses` → HTTP к ARI, с таймаутом внутри ariClient.ts), а
 * секция звонков на пульте живая, с кэшем 15 секунд: ходить на станцию четыре
 * раза в минуту ради надписи «3 из 5 на связи» — плохая сделка. Здесь кэш 60
 * секунд, и этого блоку достаточно.
 *
 * ЧЕСТНАЯ ПРИЧИНА ВМЕСТО НУЛЯ: станция сама отличает «телефония не настроена»
 * от «АТС недоступна» (ExtensionPoolProblem), и эта строка уходит на экран как
 * есть — «нет данных» здесь врало бы дважды, ведь трубки могут быть в порядке.
 */
async function loadAgentPhones(): Promise<McAgentPhones> {
  const [agents, report] = await Promise.all([
    prisma.agent.findMany({
      where: { isActive: true, sipExtension: { not: null } },
      select: { id: true, fullName: true, sipExtension: true },
      orderBy: { fullName: "asc" },
      take: 100,
    }),
    getExtensionStatuses(),
  ]);

  if (report.problem) {
    return { total: agents.length, online: 0, items: [], reason: `Состояние трубок не получено: ${report.problem}.` };
  }
  if (agents.length === 0) {
    return { total: 0, online: 0, items: [], reason: "Внутренние номера сотрудникам не выданы." };
  }

  const items = agents.map((a) => ({
    agentId: a.id,
    name: a.fullName,
    extension: a.sipExtension as string,
    online: report.statuses.get(a.sipExtension as string)?.online ?? false,
  }));
  return {
    total: items.length,
    online: items.filter((i) => i.online).length,
    items: items.slice(0, 12),
    reason: null,
  };
}

export async function loadControlGaps(now: Date, viewerRole?: string): Promise<McControlGaps> {
  const overdueWhere = {
    ...TASK_WHERE,
    ...visibleInteractionWhere(viewerRole),
    completedAt: null,
    nextActionDate: { lt: now },
  } satisfies Prisma.InteractionWhereInput;

  const [overdueCount, overdueRows, agents, limits] = await Promise.all([
    prisma.interaction.count({ where: overdueWhere }),
    prisma.interaction.findMany({
      where: overdueWhere,
      orderBy: { nextActionDate: "asc" },
      take: LIST_CAP,
      select: {
        id: true,
        nextAction: true,
        nextActionDate: true,
        client: { select: { shortId: true, fullName: true } },
        agent: { select: { fullName: true } },
      },
    }),
    prisma.agent.findMany({ where: { isActive: true, role: { in: [...RATED_ROLES] } }, select: { id: true, fullName: true }, take: 100 }),
    loadLeadLimits(),
  ]);

  const counts = await activeLeadCounts(agents.map((a) => a.id));
  const atLimitRows = agents
    .map((a) => ({ agentId: a.id, name: a.fullName, taken: slotsTaken(counts.get(a.id), limits), limit: limits.activeLimit }))
    .filter((r) => r.limit > 0 && r.taken >= r.limit)
    .sort((a, b) => b.taken - a.taken);

  const phones = await loadAgentPhones();

  const silenceCutoff = new Date(now.getTime() - 3 * 86_400_000);
  const silentAfterShowing = await prisma.client.count({
    where: {
      deletedAt: null,
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      lastContactAt: { lt: silenceCutoff },
      interactions: { some: { ...visibleInteractionWhere(viewerRole), taskCancelledAt: null, type: "SHOWING", createdAt: { gte: silenceCutoff } } },
    },
  });

  return {
    phones,
    overdueTasks: {
      count: overdueCount,
      items: overdueRows.map((r) => ({
        id: r.id,
        title: r.nextAction ?? "Задача",
        agentName: r.agent?.fullName ?? "—",
        overdueDays: Math.max(0, Math.floor((now.getTime() - (r.nextActionDate ?? now).getTime()) / 86_400_000)),
        href: r.client ? `/clients/${r.client.shortId}` : "/clients",
      })),
      reason: overdueCount > 0 ? null : "Просроченных задач нет.",
    },
    atLimit: {
      count: atLimitRows.length,
      items: atLimitRows.slice(0, LIST_CAP),
      reason:
        atLimitRows.length > 0
          ? null
          : agents.length === 0
            ? "Активных агентов нет."
            : limits.activeLimit <= 0
              ? "Лимит активных клиентов отключён."
              : `Ни один агент не достиг лимита в ${limits.activeLimit} активных клиентов.`,
    },
    silentAfterShowing: {
      count: silentAfterShowing,
      reason: silentAfterShowing > 0 ? null : "После показов все на связи.",
    },
  };
}
