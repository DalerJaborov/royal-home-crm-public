/**
 * КОГДА АУДИТОРИЯ АКТИВНА — карта недели по часам (владелец 21.09.2026:
 * «создать сначала общую карту… оно собирало в какой час нам пишут»).
 *
 * Карта в проекте УЖЕ БЫЛА: `GET /dashboard/heatmap` считал первое обращение
 * клиента за 90 дней и рисовал блок на /sources. Для вопроса «в какой час
 * публиковать» одного этого сигнала мало — он даёт РОВНО ОДНО событие на
 * клиента за всю его жизнь (написал полсотни раз — посчитан один), поэтому
 * клеток с единицей больше, чем клеток с числом, и карта скачет от пары лидов.
 * Здесь тот же счёт расширен на всю активность: входящие звонки, комментарии
 * под постами, начало и продолжение переписки. Прежний сигнал никуда не делся
 * — он остался отдельным пунктом ("contacts").
 *
 * ПЕРЕПИСКА — КАЖДОЕ СООБЩЕНИЕ (с 23.09.2026). Истории сообщений со временем
 * у нас нет (тексты лежат массивом JSON в `BotConversation.messages` без
 * отметок, а `ProcessedMessage` живёт три дня), поэтому заведён свой счётчик
 * `AudienceMessageHour` — (час, канал, число), прибавляется на каждое входящее
 * сообщение клиента (`recordAudienceMessage` ниже). Счётчик начался в день
 * правки, поэтому ДО первого его часа переписка считается по-старому, двумя
 * отметками на диалог (начало и последнее сообщение), а С него — по
 * счётчику. Одно и то же время по двум правилам не считается никогда.
 *
 * ПРЯМОЙ ИСТОЧНИК — СТАТИСТИКА INSTAGRAM (с 23.09.2026). Срез `followers`:
 * сколько наших подписчиков Instagram в сети в каждый час, по данным самой
 * Meta (суточный сбор, lib/instagramInsights.ts). Остальные срезы — наши
 * собственные сигналы, косвенный признак.
 *
 * ЧЕГО ЗДЕСЬ НЕТ — охватов и просмотров самих постов: это отклик на пост, а
 * не активность аудитории, и его место — статистика публикаций, а не карта.
 *
 * ВРЕМЯ ДУШАНБЕ, а не UTC контейнера: смещение берётся из lib/dushanbeTime.ts,
 * второго «+5 часов» здесь нет.
 */
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";

/**
 * `site` (24.09.2026) — посетители сайта royalhome.tj по часам: сайт сам
 * считает их и раз в час отдаёт CRM (lib/siteStats.ts → SiteVisitHour). В
 * «всё вместе» не складывается: людей, открывших сайт, в десятки раз больше,
 * чем звонков и сообщений, и они заглушили бы остальные сигналы.
 *
 * `followers` — не событие, а уровень: сколько подписчиков Instagram в
 * среднем было в сети в этот час (статистика самой Meta, суточный сбор в
 * InstagramOnlineFollowersHour). В «всё вместе» не складывается: число
 * людей в сети и число звонков — разные величины.
 */
export const HEATMAP_SIGNALS = ["all", "calls", "comments", "chats", "contacts", "followers", "site"] as const;
export type HeatmapSignal = (typeof HEATMAP_SIGNALS)[number];

export const HEATMAP_CHANNELS = ["ALL", "INSTAGRAM", "FACEBOOK", "WHATSAPP", "TELEGRAM", "WEBSITE", "PHONE"] as const;
export type HeatmapChannel = (typeof HEATMAP_CHANNELS)[number];

/** Три месяца — как было у прежней карты. Меньше — мало событий на 168 клеток,
 *  больше — в карту попадает прошлый сезон, а спрос на жильё сезонный. */
export const HEATMAP_DEFAULT_DAYS = 90;

/** Какие каналы вообще бывают у сигнала: звонок не бывает «в Instagram», а
 *  комментарий — «по телефону». Нужен и на сервере (пустой кусок вместо
 *  бессмысленного запроса), и на экране (не показывать невозможный выбор). */
export const HEATMAP_CHANNELS_BY_SIGNAL: Record<HeatmapSignal, readonly HeatmapChannel[]> = {
  all: ["ALL", "INSTAGRAM", "FACEBOOK", "WHATSAPP", "TELEGRAM", "WEBSITE", "PHONE"],
  // У звонка нет соцсети — выбирать не из чего, поэтому только «все».
  calls: ["ALL"],
  comments: ["ALL", "INSTAGRAM", "FACEBOOK"],
  chats: ["ALL", "INSTAGRAM", "FACEBOOK", "WHATSAPP", "TELEGRAM", "WEBSITE"],
  contacts: ["ALL", "INSTAGRAM", "FACEBOOK", "WHATSAPP"],
  // Статистика есть только у Instagram — выбирать нечего.
  followers: ["ALL"],
  // Посетители сайта royalhome.tj — один источник, выбирать нечего.
  site: ["ALL"],
};

/** Смещение Душанбе в часах — из lib/dushanbeTime.ts, своей константы нет. */
const DUSHANBE_OFFSET_HOURS = DUSHANBE_OFFSET_MS / 3_600_000;

/**
 * Диалог, у которого последнее сообщение почти совпадает с созданием, — это
 * разговор из одной реплики: его нельзя считать дважды (и как «начался», и
 * как «последнее сообщение»), иначе одинокие обращения весят вдвое больше
 * настоящих разговоров. Час — с запасом: переписка с ботом идёт минутами.
 */
const CHAT_SECOND_POINT_GAP = Prisma.sql`INTERVAL '1 hour'`;

export interface HeatmapCell {
  /** День недели по Postgres EXTRACT(DOW): 0 — воскресенье. */
  dow: number;
  /** Час по Душанбе, 0-23. */
  hour: number;
  count: number;
}

/** Каналы счётчика сообщений — у звонка своя таблица, в счётчик он не пишется. */
export const AUDIENCE_MESSAGE_CHANNELS = ["INSTAGRAM", "FACEBOOK", "WHATSAPP", "TELEGRAM", "WEBSITE"] as const;
export type AudienceMessageChannel = (typeof AUDIENCE_MESSAGE_CHANNELS)[number];

const HOUR_MS = 60 * 60 * 1000;

/**
 * Прибавить одно входящее сообщение клиента к счётчику карты. Зовётся там же,
 * где отмечается касание в досье (`recordContactTurn`), — на каждое сообщение
 * клиента во всех каналах. Не бросает: карта не повод уронить приём сообщения,
 * но и молча терять отказ нельзя — он уходит в журнал ошибок.
 */
export async function recordAudienceMessage(channel: string, at: Date = new Date()): Promise<void> {
  if (!(AUDIENCE_MESSAGE_CHANNELS as readonly string[]).includes(channel)) return;
  const hourStart = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
  try {
    await prisma.$executeRaw`
      INSERT INTO "AudienceMessageHour" ("hourStart", "channel", "count")
      VALUES (${hourStart}, ${channel}, 1)
      ON CONFLICT ("hourStart", "channel") DO UPDATE SET "count" = "AudienceMessageHour"."count" + 1
    `;
  } catch (err) {
    void logSystemError("api", `Счётчик сообщений для тепловой карты не записан: ${(err as Error).message}`, {
      dedupKey: "audience-message-hour",
    });
  }
}

/** Первый час счётчика — граница «до неё по двум отметкам, после по счётчику». */
async function messageCounterStart(): Promise<Date | null> {
  const [row] = await prisma.$queryRaw<{ start: Date | null }[]>(Prisma.sql`
    SELECT MIN("hourStart") AS start FROM "AudienceMessageHour"
  `);
  return row?.start ?? null;
}

/** Куски UNION ALL — каждый отдаёт один столбец `ts` с моментом события. */
function eventSources(
  signal: Exclude<HeatmapSignal, "followers" | "site">,
  channel: HeatmapChannel,
  since: Date,
  /** С этого момента переписку считает счётчик — старые отметки только до него. */
  counterStart: Date | null = null
): Prisma.Sql[] {
  const allowed = HEATMAP_CHANNELS_BY_SIGNAL[signal];
  if (!allowed.includes(channel)) return [];

  const wants = (s: Exclude<HeatmapSignal, "all" | "contacts" | "followers" | "site">): boolean => signal === "all" || signal === s;
  const parts: Prisma.Sql[] = [];

  if (signal === "contacts") {
    // Прежний сигнал карты, слово в слово по смыслу: момент ПЕРВОГО обращения.
    // Точная отметка — создание диалога (заводится ровно на первом вебхуке),
    // откат на создание карточки там, где диалога нет вовсе (пришёл звонком
    // или заведён агентом руками). Фильтр по каналу сужает до клиентов,
    // которые писали именно оттуда, — тогда отката быть не может.
    const byChannel = channel !== "ALL";
    parts.push(
      byChannel
        ? Prisma.sql`
            SELECT MIN(bc."createdAt") AS ts
            FROM "Client" c
            JOIN "BotConversation" bc ON bc."clientId" = c.id AND bc."channel" = ${channel}
            WHERE c."deletedAt" IS NULL
            GROUP BY c.id
          `
        : Prisma.sql`
            SELECT COALESCE(MIN(bc."createdAt"), c."createdAt") AS ts
            FROM "Client" c
            LEFT JOIN "BotConversation" bc ON bc."clientId" = c.id
            WHERE c."deletedAt" IS NULL
            GROUP BY c.id, c."createdAt"
          `
    );
    return parts;
  }

  if (wants("calls") && (channel === "ALL" || channel === "PHONE")) {
    // `irrelevant` — помеченный персоналом мусор (ошиблись номером, спам).
    // В карте «когда живёт аудитория» ему не место: он рисует часы, в которые
    // нас беспокоят, а не в которые нами интересуются.
    parts.push(Prisma.sql`
      SELECT "startedAt" AS ts FROM "IncomingCall"
      WHERE "startedAt" >= ${since} AND "irrelevant" = false
    `);
  }

  if (wants("comments") && (channel === "ALL" || channel === "INSTAGRAM" || channel === "FACEBOOK")) {
    const byChannel = channel === "ALL" ? Prisma.empty : Prisma.sql`AND "channel" = ${channel}`;
    parts.push(Prisma.sql`
      SELECT "createdAt" AS ts FROM "InstagramComment"
      WHERE "createdAt" >= ${since} ${byChannel}
    `);
  }

  if (wants("chats")) {
    // ДО счётчика — две отметки на диалог; с первого часа счётчика эти отметки
    // не берутся вовсе (иначе то же время посчиталось бы дважды), переписку
    // дальше считает loadHeatmapCells по AudienceMessageHour.
    const beforeCounter = (col: string) =>
      counterStart ? Prisma.sql`AND ${Prisma.raw(`"${col}"`)} < ${counterStart}` : Prisma.empty;
    if (
      channel === "ALL" ||
      channel === "INSTAGRAM" ||
      channel === "FACEBOOK" ||
      channel === "WHATSAPP" ||
      channel === "WEBSITE"
    ) {
      const byChannel = channel === "ALL" ? Prisma.empty : Prisma.sql`AND "channel" = ${channel}`;
      parts.push(Prisma.sql`
        SELECT "createdAt" AS ts FROM "BotConversation"
        WHERE "createdAt" >= ${since} ${byChannel} ${beforeCounter("createdAt")}
      `);
      parts.push(Prisma.sql`
        SELECT "lastMessageAt" AS ts FROM "BotConversation"
        WHERE "lastMessageAt" >= ${since} ${byChannel}
          AND "lastMessageAt" > "createdAt" + ${CHAT_SECOND_POINT_GAP} ${beforeCounter("lastMessageAt")}
      `);
    }
    // Telegram живёт в своих таблицах (у BotConversation каналов всего три) —
    // без него «все каналы» врало бы, что в Telegram нам не пишут.
    if (channel === "ALL" || channel === "TELEGRAM") {
      parts.push(Prisma.sql`
        SELECT "createdAt" AS ts FROM "TelegramDirectConversation"
        WHERE "createdAt" >= ${since} ${beforeCounter("createdAt")}
      `);
      parts.push(Prisma.sql`
        SELECT "lastMessageAt" AS ts FROM "TelegramDirectConversation"
        WHERE "lastMessageAt" >= ${since}
          AND "lastMessageAt" > "createdAt" + ${CHAT_SECOND_POINT_GAP} ${beforeCounter("lastMessageAt")}
      `);
    }
  }

  return parts;
}

export async function loadHeatmapCells(params: {
  signal: HeatmapSignal;
  channel: HeatmapChannel;
  days?: number;
  /** Конец окна (не включительно); по умолчанию — сейчас. Нужен сравнению
   *  «эти N дней против прошлых N дней» (loadChannelActivity). */
  endAt?: Date;
}): Promise<HeatmapCell[]> {
  const days = params.days ?? HEATMAP_DEFAULT_DAYS;
  const endAt = params.endAt ?? new Date();
  const since = new Date(endAt.getTime() - days * 24 * 60 * 60 * 1000);
  if (params.signal === "followers") {
    return params.channel === "ALL" ? loadInstagramOnlineCells(since) : [];
  }
  if (params.signal === "site") {
    return params.channel === "ALL" ? loadSiteVisitCells(since, endAt) : [];
  }
  if (!HEATMAP_CHANNELS_BY_SIGNAL[params.signal].includes(params.channel)) return [];

  // Переписка по счётчику: каждая строка — час и число сообщений в нём.
  const wantsChats = params.signal === "all" || params.signal === "chats";
  const counterChannel = params.channel === "ALL" ? null : params.channel;
  const countsChats =
    wantsChats && (counterChannel === null || (AUDIENCE_MESSAGE_CHANNELS as readonly string[]).includes(counterChannel));
  const counterStart = countsChats ? await messageCounterStart() : null;

  // Каждое событие — строка (ts, n): у обычных событий n = 1, у часа счётчика
  // n — число сообщений в этом часе.
  const parts: Prisma.Sql[] = eventSources(params.signal, params.channel, since, counterStart).map(
    (part) => Prisma.sql`SELECT ts, 1::bigint AS n FROM (${part}) AS one`
  );
  if (countsChats && counterStart) {
    const byChannel = counterChannel ? Prisma.sql`AND "channel" = ${counterChannel}` : Prisma.empty;
    parts.push(Prisma.sql`
      SELECT "hourStart" AS ts, "count"::bigint AS n FROM "AudienceMessageHour"
      WHERE "hourStart" >= ${since} ${byChannel}
    `);
  }
  // Невозможная пара сигнал+канал — пустая карта, а не запрос без источников
  // (UNION ALL из нуля кусков — синтаксическая ошибка, а не пустой результат).
  if (parts.length === 0) return [];

  const rows = await prisma.$queryRaw<{ dow: number; hour: number; count: bigint }[]>(Prisma.sql`
    WITH events AS (${Prisma.join(parts, " UNION ALL ")}),
    local AS (
      SELECT ts + (${DUSHANBE_OFFSET_HOURS}::int * INTERVAL '1 hour') AS ts, n
      FROM events
      WHERE ts IS NOT NULL AND ts >= ${since} AND ts < ${endAt}
    )
    SELECT
      EXTRACT(DOW  FROM ts)::int AS dow,
      EXTRACT(HOUR FROM ts)::int AS hour,
      SUM(n)::bigint AS count
    FROM local
    GROUP BY 1, 2
  `);

  // bigint не сериализуется в JSON — приводим здесь, а не на клиенте.
  return rows.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) }));
}

/**
 * Аккаунт последнего сбора: сменили основной аккаунт Instagram — карта
 * показывает новый, а не среднее двух разных аудиторий.
 */
const LATEST_IG_ACCOUNT = Prisma.sql`(
  SELECT "igUserId" FROM "InstagramOnlineFollowersHour" ORDER BY "fetchedAt" DESC LIMIT 1
)`;

/**
 * ПОДПИСЧИКИ INSTAGRAM В СЕТИ: среднее по каждой клетке недели. Среднее, а не
 * сумма: за три месяца вторник встречается тринадцать раз, а за две недели
 * сбора — дважды, и сумма рисовала бы не аудиторию, а длину истории.
 */
async function loadInstagramOnlineCells(since: Date): Promise<HeatmapCell[]> {
  const rows = await prisma.$queryRaw<{ dow: number; hour: number; count: number }[]>(Prisma.sql`
    WITH local AS (
      SELECT "at" + (${DUSHANBE_OFFSET_HOURS}::int * INTERVAL '1 hour') AS ts, "count"
      FROM "InstagramOnlineFollowersHour"
      WHERE "igUserId" = ${LATEST_IG_ACCOUNT} AND "at" >= ${since}
    )
    SELECT
      EXTRACT(DOW  FROM ts)::int AS dow,
      EXTRACT(HOUR FROM ts)::int AS hour,
      ROUND(AVG("count"))::int AS count
    FROM local
    GROUP BY 1, 2
  `);
  return rows.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) }));
}

/**
 * ПОСЕТИТЕЛИ САЙТА: сумма разных посетителей по каждой клетке недели. Сумма,
 * как у остальных событий, а не среднее, как у подписчиков в сети: посетитель
 * — это событие («зашёл»), а не уровень («сколько сейчас онлайн»).
 */
async function loadSiteVisitCells(since: Date, endAt: Date): Promise<HeatmapCell[]> {
  const rows = await prisma.$queryRaw<{ dow: number; hour: number; count: bigint }[]>(Prisma.sql`
    WITH local AS (
      SELECT "hourStart" + (${DUSHANBE_OFFSET_HOURS}::int * INTERVAL '1 hour') AS ts, "visitors"
      FROM "SiteVisitHour"
      WHERE "hourStart" >= ${since} AND "hourStart" < ${endAt}
    )
    SELECT
      EXTRACT(DOW  FROM ts)::int AS dow,
      EXTRACT(HOUR FROM ts)::int AS hour,
      SUM("visitors")::bigint AS count
    FROM local
    GROUP BY 1, 2
  `);
  return rows.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) }));
}

/** За сколько разных суток (по Душанбе) собрана статистика Instagram в окне —
 *  по ней расписание решает, хватает ли её, чтобы ей верить. */
export async function instagramOnlineDaysCollected(days: number = HEATMAP_DEFAULT_DAYS): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [row] = await prisma.$queryRaw<{ days: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT date_trunc('day', "at" + (${DUSHANBE_OFFSET_HOURS}::int * INTERVAL '1 hour'))) AS days
    FROM "InstagramOnlineFollowersHour"
    WHERE "igUserId" = ${LATEST_IG_ACCOUNT} AND "at" >= ${since}
  `);
  return Number(row?.days ?? 0);
}

/**
 * НА СКОЛЬКО РАНЬШЕ ПИКА ПУБЛИКОВАТЬ. Пост собирает первые просмотры не
 * мгновенно, поэтому выкладывать ровно в час пика — значит попасть в ленту
 * уже на его спаде. Час — не измеренная величина, а разумный запас: измерить
 * её можно будет только по охватам, которых у нас пока нет (см. докстринг
 * файла). Если цифра окажется другой — менять здесь, в одном месте.
 */
export const PUBLISH_LEAD_HOURS = 1;
// С 23.09.2026 это значение по умолчанию: своё можно задать в Настройках
// (Settings.publishScheduleLeadHours) и передать вторым аргументом
// summarizeHeatmap — см. lib/publishScheduleRules.ts.

/** Сколько «живых часов» показываем — три, чтобы совет не превращался в
 *  «публикуй когда угодно» и при этом покрывал и обед, и вечер. */
const LIVELIEST_HOURS_SHOWN = 3;

export interface HeatmapSummary {
  total: number;
  /** Самая живая клетка недели; null — событий не было вовсе. */
  peak: HeatmapCell | null;
  /** Часы суток (0-23) по всей неделе сразу, от самого живого. */
  liveliestHours: number[];
  /** Во сколько ставить публикацию — те же часы минус PUBLISH_LEAD_HOURS. */
  publishHours: number[];
}

/**
 * Чистая функция — её и проверяет тест, без базы. Час берётся по всей неделе
 * сразу, а не по каждому дню: постов у нас единицы в день, и совет «во вторник
 * в 19, в среду в 13» был бы подгонкой под шум. День недели виден на самой
 * карте, если разница окажется настоящей.
 */
export function summarizeHeatmap(cells: HeatmapCell[], leadHours: number = PUBLISH_LEAD_HOURS): HeatmapSummary {
  const total = cells.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return { total: 0, peak: null, liveliestHours: [], publishHours: [] };

  const peak = cells.reduce((best, c) => (c.count > best.count ? c : best));

  const byHour = new Array<number>(24).fill(0);
  for (const c of cells) byHour[c.hour] += c.count;

  const liveliestHours = byHour
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    // При равном числе — ранний час первым: иначе порядок зависел бы от того,
    // как лёг результат запроса, и тест был бы плавающим.
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, LIVELIEST_HOURS_SHOWN)
    .map((h) => h.hour);

  const publishHours = [...new Set(liveliestHours.map((h) => (h - leadHours + 24) % 24))].sort(
    (a, b) => a - b
  );

  return { total, peak, liveliestHours, publishHours };
}

/**
 * АКТИВНОСТЬ ПО КАНАЛАМ (24.09.2026, владелец: «чтобы аналитикой и анализом и
 * статистиками работало по всем каналам и визуально, чтобы я всё видел»).
 *
 * Карта выше отвечает «когда», но по одному каналу за раз: чтобы сравнить
 * Instagram с WhatsApp, приходилось щёлкать срезы и держать в голове. Здесь —
 * все каналы сигнала рядом: сколько событий, куда движется (эти N дней против
 * прошлых N), часы по суткам полоской и свой лучший час публикации у каждого.
 *
 * Считается ТЕМ ЖЕ loadHeatmapCells, что и сама карта, — второго счёта нет,
 * поэтому сумма строки всегда равна сумме карты с этим каналом.
 */
export interface ChannelActivity {
  channel: Exclude<HeatmapChannel, "ALL">;
  total: number;
  /** Столько же дней перед окном — для «больше/меньше, чем раньше». */
  previousTotal: number;
  /** События по часам суток (0-23) за всё окно, все дни недели вместе. */
  byHour: number[];
  /** События по дням недели, 0 — воскресенье (как EXTRACT(DOW)). */
  byDow: number[];
  liveliestHours: number[];
  publishHours: number[];
  /** День недели, в который канал живее всего; null — событий нет. */
  busiestDow: number | null;
}

/** Чистая сводка одного канала — её проверяет тест без базы. */
export function summarizeChannelActivity(
  channel: Exclude<HeatmapChannel, "ALL">,
  cells: HeatmapCell[],
  previousCells: HeatmapCell[],
  leadHours: number = PUBLISH_LEAD_HOURS
): ChannelActivity {
  const summary = summarizeHeatmap(cells, leadHours);
  const byHour = new Array<number>(24).fill(0);
  const byDow = new Array<number>(7).fill(0);
  for (const c of cells) {
    byHour[c.hour] += c.count;
    byDow[c.dow] += c.count;
  }
  let busiestDow: number | null = null;
  for (let d = 0; d < 7; d++) {
    if (byDow[d] > 0 && (busiestDow === null || byDow[d] > byDow[busiestDow])) busiestDow = d;
  }
  return {
    channel,
    total: summary.total,
    previousTotal: previousCells.reduce((sum, c) => sum + c.count, 0),
    byHour,
    byDow,
    liveliestHours: summary.liveliestHours,
    publishHours: summary.publishHours,
    busiestDow,
  };
}

/**
 * Все каналы сигнала разом. Запросы идут по два на канал (окно и прошлое окно),
 * каналов не больше шести — по очереди, а не залпом в пул соединений: экран
 * аналитики не должен отнимать соединения у приёма сообщений.
 */
export async function loadChannelActivity(params: {
  signal: HeatmapSignal;
  days?: number;
  leadHours?: number;
}): Promise<ChannelActivity[]> {
  const days = params.days ?? HEATMAP_DEFAULT_DAYS;
  const now = new Date();
  const previousEnd = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const result: ChannelActivity[] = [];
  for (const channel of HEATMAP_CHANNELS_BY_SIGNAL[params.signal]) {
    if (channel === "ALL") continue;
    const current = await loadHeatmapCells({ signal: params.signal, channel, days, endAt: now });
    const previous = await loadHeatmapCells({ signal: params.signal, channel, days, endAt: previousEnd });
    result.push(summarizeChannelActivity(channel, current, previous, params.leadHours));
  }
  // Самый живой канал — первым: экран читается сверху вниз.
  return result.sort((a, b) => b.total - a.total);
}
