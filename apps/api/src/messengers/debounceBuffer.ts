import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * ОКНО СКЛЕЙКИ БЫСТРЫХ СООБЩЕНИЙ — ОДНО НА ВСЕ КАНАЛЫ (01.10.2026, находка №132).
 *
 * Живой человек часто пишет короткими сообщениями подряд («Салом», «квартира»,
 * «3 комн»), и без окна бот отвечал бы на КАЖДЫЙ обрывок отдельно — три ответа и
 * тройной расход модели. До этой правки механизм жил только в переписке Meta
 * (messengers/conversation.ts), а Telegram отвечал на каждое сообщение. Теперь
 * буфер, окно и захват пачки живут здесь, а каналы различаются только таблицей
 * диалога: BotConversation (Instagram/Facebook/WhatsApp) и TelegramConversation
 * (личка с ботом, telegram/bot.ts).
 */

/** Окно дебаунса: сколько ждать после последнего сообщения, прежде чем отвечать. */
// Значения по умолчанию снижены 01.08.2026 после живой проверки: ответ приходил
// примерно через минуту, и это ощущалось не как «человек думает», а как «зависло».
// Правится в Настройках → Бот («Когда бот пишет») без выкатки.
//
// ЭТО ТОЛЬКО ЗАПАСНОЙ ВАРИАНТ — на случай, когда база не отвечает. Рабочие значения
// живут в Settings, и там же стоят умолчания колонок (schema.prisma: 25 и 90). Пока
// цифры здесь и в схеме расходились, правка 01.08 выглядела применённой, а на деле
// не меняла ничего: строка Settings давно создана, и бот читал из неё 25 секунд.
const DEFAULT_DEBOUNCE_MS = 25_000;
const DEFAULT_MAX_WAIT_MS = 90_000;
/** Окно для фото у принятой заявки: фото приходят очередью доставок по одной,
 *  и 12 секунд хватает, чтобы вся очередь легла в одну пачку, а потолок не даёт
 *  ждать ответа дольше 45. */
const MEDIA_BURST_DELAY_MS = 12_000;
const MEDIA_BURST_MAX_WAIT_MS = 45_000;

export interface ReplyTiming {
  delayMs: number;
  maxWaitMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Сколько ждать этой пачке: обычная пауза, но не выходя за потолок от её начала.
 *  Пока клиент дописывает, каждое новое сообщение начинает ожидание заново — и без
 *  потолка человек, пишущий каждые 20 секунд, откладывал бы ответ бесконечно. */
export function replyWaitMs(
  now: number,
  pendingSince: number,
  delayMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS
): number {
  const spent = Math.max(0, now - pendingSince);
  return Math.max(0, Math.min(delayMs, maxWaitMs - spent));
}

/** Пауза и потолок из Настроек; при недоступной базе — разумные значения по умолчанию. */
async function replyTiming(): Promise<ReplyTiming> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
    });
    return {
      delayMs: (s?.botReplyDelaySec ?? DEFAULT_DEBOUNCE_MS / 1000) * 1000,
      maxWaitMs: (s?.botReplyMaxWaitSec ?? DEFAULT_MAX_WAIT_MS / 1000) * 1000,
    };
  } catch {
    return { delayMs: DEFAULT_DEBOUNCE_MS, maxWaitMs: DEFAULT_MAX_WAIT_MS };
  }
}

/**
 * Своё окно вместо настройки бота — одно правило для всех каналов.
 *
 * ЗАЯВКА УЖЕ ПРИНЯТА — БЕЗ РЕАЛЬНОГО ОЖИДАНИЯ (владелец 19.08.2026, «не
 * переписываться пятьдесят раз ещё»): клиент, который уже оставил номер, ждёт
 * ответа так же быстро, как ждал бы «агент свяжется». `delayMs: 0` — не ждём
 * НАРОЧНО, `maxWaitMs` небольшой — потолок на случай, если несколько доставок всё
 * же пришли не совсем одновременно. Окно при этом остаётся ради атомарного захвата
 * буфера: две почти одновременные доставки не отвечают дважды.
 *
 * ФОТО ЖДУТ ВСЕГДА, И У ПРИНЯТОЙ ЗАЯВКИ ТОЖЕ (владелец 25.09.2026): фото приходят
 * очередью доставок по одной, и с нулевым окном каждая выигрывала свой ход —
 * продавец получал восемь «аксҳоро гирифтем» подряд.
 *
 * ГОЛОЕ ПРИВЕТСТВИЕ ПЕРВЫМ СООБЩЕНИЕМ — КОРОЧЕ ОКНО, НЕ БЕЗ ОКНА: если за три
 * секунды ничего не дописали, отвечаем сразу (см. greetingFast в conversation.ts).
 *
 * undefined — обычное окно из Настроек.
 */
export function batchWindowFor(p: {
  accepted: boolean;
  hasMedia: boolean;
  greetingFast?: boolean;
}): ReplyTiming | undefined {
  if (p.accepted) {
    return p.hasMedia
      ? { delayMs: MEDIA_BURST_DELAY_MS, maxWaitMs: MEDIA_BURST_MAX_WAIT_MS }
      : { delayMs: 0, maxWaitMs: 3_000 };
  }
  return p.greetingFast ? { delayMs: 3_000, maxWaitMs: 8_000 } : undefined;
}

/** Таблицы диалогов, у которых есть буфер окна (pendingMessages/pendingAttachments/pendingSince). */
export type DebounceTable = "BotConversation" | "TelegramConversation";

/** Имя таблицы в сыром SQL нельзя передать параметром — только из этого закрытого списка. */
const TABLE_SQL: Record<DebounceTable, Prisma.Sql> = {
  BotConversation: Prisma.raw('"BotConversation"'),
  TelegramConversation: Prisma.raw('"TelegramConversation"'),
};

/** Что забрал победитель окна: тексты всех доставок пачки и их отметки — по порядку. */
export interface CapturedBatch<E> {
  texts: string[];
  entries: E[];
}

/**
 * Регистрирует текст в буфере диалога и ждёт окно. Если за это время не пришло
 * более новое сообщение — забирает и очищает буфер, возвращая тексты и отметки
 * всех доставок окна (этот вызов «выиграл» и отвечает за всю пачку). Если пришло
 * более новое — возвращает null: этот вызов остаётся молчаливым, а более свежий
 * (уже дожидающийся своего окна) ответит за всех.
 *
 * `timingOverride` — своё окно вместо настройки бота (см. batchWindowFor). Тот же
 * механизм захвата буфера, просто быстрее: если за это время подтянулось что-то
 * ещё, оно всё равно попадёт в пачку, а не потеряется.
 */
export async function debounceAndMerge<E>(
  table: DebounceTable,
  conversationId: string,
  text: string,
  entry?: E,
  timingOverride?: ReplyTiming
): Promise<CapturedBatch<E> | null> {
  const t = TABLE_SQL[table];
  // Буфер дописывается АТОМАРНО (jsonb «||» на стороне БД), а не через
  // findUnique → [...before, text] → update. Два сообщения клиента подряд приходят
  // почти одновременно, оба вызова читали пустой буфер и оба писали по одному
  // элементу — второй затирал первый, и сообщение пропадало целиком.
  // lastMessageAt пишем тем же запросом — по нему определяется победитель окна.
  // pendingSince — начало пачки; ставится только у первого сообщения (COALESCE),
  // от него считается потолок ожидания, и тот же запрос его и возвращает.
  // followUpsSent = 0 (только у BotConversation, где живут напоминания): клиент
  // ответил — все запланированные напоминания отменяются, и следующая цепочка
  // начнётся с нуля, если он снова замолчит.
  const arrivedAt = new Date();
  // Отметку доставки кладём ВСЕГДА, когда она есть, даже без вложений: в ней ещё и
  // идентификаторы сообщения, без которых победитель окна не сможет ни пометить
  // свою реплику, ни показать, на что человек отвечал.
  const batchEntry: E[] = entry !== undefined ? [entry] : [];
  const resetFollowUps = table === "BotConversation" ? Prisma.sql`, "followUpsSent" = 0` : Prisma.empty;
  const started = await prisma.$queryRaw<{ pendingSince: Date | null }[]>`
    UPDATE ${t}
    SET "pendingMessages" = COALESCE("pendingMessages", '[]'::jsonb) || ${JSON.stringify([text])}::jsonb,
        "pendingAttachments" = COALESCE("pendingAttachments", '[]'::jsonb) || ${JSON.stringify(batchEntry)}::jsonb,
        "lastMessageAt" = ${arrivedAt},
        "pendingSince" = COALESCE("pendingSince", ${arrivedAt})
        ${resetFollowUps}
    WHERE "id" = ${conversationId}
    RETURNING "pendingSince"`;

  const { delayMs, maxWaitMs } = timingOverride ?? (await replyTiming());
  const pendingSince = started[0]?.pendingSince?.getTime() ?? arrivedAt.getTime();
  await sleep(replyWaitMs(Date.now(), pendingSince, delayMs, maxWaitMs));

  /**
   * ПРОВЕРКА И ОЧИСТКА БУФЕРА — ОДНИМ ЗАПРОСОМ, а не «прочитал → решил → очистил».
   *
   * Раньше здесь стояли findUnique (не опередили ли меня) и следом update (забрать
   * буфер). Сообщение, пришедшее МЕЖДУ ними, дописывалось в буфер и тут же
   * стиралось очисткой: его слова не видели ни модель, ни переписка.
   *
   * Тем же условием закрыт и второй случай: победитель определялся равенством
   * lastMessageAt с точностью до миллисекунды, и две доставки, попавшие в одну
   * миллисекунду, объявляли победителями ОБЕ. Здесь победитель ровно один — тот,
   * чей UPDATE изменил строку первым: он гасит pendingSince, и второму условие
   * `pendingSince IS NOT NULL` уже не подходит.
   *
   * FOR UPDATE в CTE обязателен: без него второй вызов сравнивал бы условие со
   * снимком, снятым до чужой правки, и прошёл бы тоже. С ним он ждёт на строке и
   * перепроверяет условие по свежему значению.
   *
   * RETURNING отдаёт значение из CTE — то есть буфер ДО очистки; из самой таблицы
   * вернулся бы уже пустой массив.
   */
  const captured = await prisma.$queryRaw<{ pending: unknown; attach: unknown }[]>`
    WITH taken AS (
      SELECT "id", "pendingMessages", "pendingAttachments"
      FROM ${t}
      WHERE "id" = ${conversationId}
        AND "lastMessageAt" = ${arrivedAt}
        AND "pendingSince" IS NOT NULL
      FOR UPDATE
    )
    UPDATE ${t} b
    SET "pendingMessages" = '[]'::jsonb, "pendingAttachments" = '[]'::jsonb, "pendingSince" = NULL
    FROM taken
    WHERE b."id" = taken."id"
    RETURNING taken."pendingMessages" AS "pending", taken."pendingAttachments" AS "attach"`;

  if (captured.length === 0) return null; // нас опередили — за пачку ответит более свежий вызов

  return {
    texts: Array.isArray(captured[0].pending) ? (captured[0].pending as string[]) : [text],
    entries: Array.isArray(captured[0].attach) ? (captured[0].attach as E[]) : [],
  };
}

/**
 * Забирает и очищает буферы, зависшие дольше `olderThan` — победитель окна умер
 * посреди ожидания (перезапуск процесса при выкате), и забрать пачку больше
 * некому. Захват — тем же условием по pendingSince, что и у живого хода: если
 * настоящий вызов успел забрать буфер раньше, строка не тронется. Что делать с
 * текстами, решает канал (см. recoverStuckPendingMessages в conversation.ts).
 */
export async function takeStuckBuffers(
  table: DebounceTable,
  olderThan: Date,
  limit: number
): Promise<Array<{ id: string; texts: string[]; since: Date }>> {
  const t = TABLE_SQL[table];
  const rows = await prisma.$queryRaw<{ id: string; pending: unknown; since: Date }[]>`
    WITH taken AS (
      SELECT "id", "pendingMessages", "pendingSince"
      FROM ${t}
      WHERE "pendingSince" < ${olderThan}
      ORDER BY "pendingSince"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${t} b
    SET "pendingMessages" = '[]'::jsonb, "pendingAttachments" = '[]'::jsonb, "pendingSince" = NULL
    FROM taken
    WHERE b."id" = taken."id"
    RETURNING taken."id" AS "id", taken."pendingMessages" AS "pending", taken."pendingSince" AS "since"`;
  return rows.map((r) => ({
    id: r.id,
    texts: Array.isArray(r.pending) ? (r.pending as string[]).filter(Boolean) : [],
    since: r.since,
  }));
}
