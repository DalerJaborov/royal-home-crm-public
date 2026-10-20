/**
 * СУТОЧНЫЙ БЮДЖЕТ ХОДОВ ИИ НА ОДИН ДИАЛОГ (решение владельца 21.08.2026:
 * «чтобы люди не использовали нейросеть в своих целях»).
 *
 * До этого предела на КЛИЕНТА не было вовсе. Дебаунс (25 сек) ограничивает только
 * темп: один человек мог легально получать до ~30 ходов модели в час, круглосуточно,
 * и пользоваться нашим ботом как бесплатным ChatGPT — за наши деньги и в наш лимит
 * сообщений у Meta.
 *
 * ПОЧЕМУ СЧЁТЧИК В ДИАЛОГЕ, А НЕ В ПАМЯТИ ПРОЦЕССА. Разговор тянется сутками и
 * переживает перезапуск контейнера; предел, живущий в памяти, снимался бы каждым
 * деплоем — то есть ровно тогда, когда его проще всего обойти.
 *
 * ПОЧЕМУ СУТКИ ПО ДУШАНБЕ. Контейнер живёт в UTC, и «полночь» по UTC — это 05:00
 * по-местному. Сброс в пять утра означал бы, что ночной злоупотребляющий получает
 * второй бюджет посреди своей же ночной сессии, а настоящий клиент, написавший в
 * 8 утра, продолжает вчерашний счётчик. Границы суток — только через
 * lib/dushanbeTime.ts (правило CLAUDE.md).
 *
 * ГДЕ ЛЕЖАТ СЧЁТЧИКИ — ДВА ХРАНИЛИЩА, ОДНИ ПРАВИЛА (аудит 22.08.2026).
 *
 * Решение владельца от 21.08 закрыло дыру ровно в ОДНОМ канале из трёх: счётчики
 * жили колонками BotConversation, то есть только в переписке Meta. В Telegram и в
 * комментариях под публикациями предела не было вовсе — там человек мог получать
 * неограниченное число ходов модели в сутки, и единственным тормозом оставался
 * дебаунс. Дыра была не в правилах, а в том, что у этих каналов негде было
 * хранить счёт: у TelegramConversation таких колонок нет, а у комментария вообще
 * нет «диалога» — есть автор.
 *
 * Поэтому хранилища два, и оба ходят через один и тот же расчёт:
 *
 *  • "conversation" — колонки BotConversation (переписка Meta, как было);
 *  • "peer" — общая таблица AiBudgetCounter по ключу «канал + идентификатор
 *    собеседника» (Telegram — chatId, комментарии — автор комментария, дальше
 *    ИИ-чат на сайте royalhome.tj).
 *
 * ПОЧЕМУ НЕ РАЗМНОЖИЛИ КОЛОНКИ ПО ТАБЛИЦАМ КАНАЛОВ. Семь колонок на каждый новый
 * канал — это семь мест, где предел через месяц придётся править синхронно, и
 * ровно так расходятся правила (см. историю ai/inboundScreen.ts). У комментариев
 * же собственной строки-диалога нет вообще: заводить ради счётчика фальшивый
 * BotConversation нельзя — он тут же появится в инбоксе «Сообщения» как живая
 * переписка, которой не существует.
 */

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import type { ClientLanguage } from "../ai/clientLanguage.js";

/**
 * ОТКУДА ЧИСЛА.
 *
 * Обычный покупатель доходит от «салом» до показа за 10–15 реплик — это видно по
 * живым перепискам. Пределы ниже подняты НАМЕРЕННО ВЫСОКО (владелец 21.08.2026:
 * «первый месяц, я не знаю ни один расход — лимиты не должны ограничивать людей»):
 * они рассчитаны так, чтобы живой человек не мог их достичь физически, а упирался
 * только автоматический перебор. Точные числа появятся из отчёта по расходам через
 * месяц работы — тогда границу поставим по факту, а не наугад.
 */
export const AI_TURNS_PER_DAY_STRANGER = 200;
export const AI_TURNS_PER_DAY_KNOWN = 400;

/**
 * ПЕРВЫЙ МЕСЯЦ ПРЕДЕЛЫ НАБЛЮДАЮТ, А НЕ ОТСЕКАЮТ (владелец 21.08.2026: «это первый
 * месяц, я не знаю ни один расход — нужно, чтобы лимиты никак не ограничивали людей»).
 *
 * Ставить границу, не зная нормы, — это гадание: слишком низкая обрывает живого
 * клиента, слишком высокая не защищает ни от чего. Поэтому пока предел работает
 * мягко: он НЕ останавливает бота, а помечает диалог и зовёт агента — то есть
 * работает счётчиком и сигналом. Через месяц в отчёте по расходам будут настоящие
 * числа, и границу можно будет поставить по факту, а не наугад.
 *
 * АВАРИЙНЫЙ ПОТОЛОК ОСТАЁТСЯ ЖЁСТКИМ. Мягкий режим без верхней границы означал бы,
 * что защиты нет вовсе: один автоматический скрипт за ночь выберет любой бюджет.
 * Поэтому выше мягкого предела есть жёсткий — впятеро больше, — и он останавливает
 * бота в любом режиме. Между ними лежит всё разумное поведение живого человека.
 */
export const AI_HARD_LIMIT_MULTIPLIER = 5;

/**
 * ФАЙЛЫ СЧИТАЮТСЯ ДВУМЯ РАЗНЫМИ СЧЁТЧИКАМИ (владелец 21.08.2026: «зачем боту файлы
 * и почему так много — сделай минимум»).
 *
 * Потому что «файл» здесь — это две совершенно разные вещи.
 *
 * ГОЛОСОВОЕ — НЕ ВЛОЖЕНИЕ, А РЕПЛИКА. Половина клиентов в Душанбе вместо текста
 * наговаривает сообщение: для них это обычный способ разговора. Поэтому у речи счёт
 * почти как у реплик — предел здесь обязан быть недостижим для живого человека.
 *
 * ВИДЕО И ДОКУМЕНТЫ — НАСТОЯЩАЯ НАГРУЗКА: ролик и PDF дороже голосового в десятки
 * раз, а законных поводов слать их подряд почти нет. Здесь счёт заметно строже, но
 * всё равно с запасом: продавец, снявший квартиру восемью короткими роликами,
 * проходит целиком.
 */
export const AI_VOICE_PER_DAY_STRANGER = 120;
export const AI_VOICE_PER_DAY_KNOWN = 240;
export const AI_PHOTO_PER_DAY_STRANGER = 80;
export const AI_PHOTO_PER_DAY_KNOWN = 160;
/** Видео: квартиру показывают одним-двумя роликами, а не двадцатью. */
export const AI_VIDEO_PER_DAY_STRANGER = 8;
export const AI_VIDEO_PER_DAY_KNOWN = 20;
/**
 * Документы у незнакомца ИИ не разбирает ВООБЩЕ (владелец 21.08.2026: «зачем нам
 * вообще их отправлять»). Разбор почти ничего не даёт — агент откроет файл сам, —
 * а внутри PDF можно спрятать текст, который бот прочтёт как указание. Клиент при
 * этом не игнорируется: файл сохраняется в переписке и его видит агент.
 */
export const AI_DOC_PER_DAY_STRANGER = 0;
export const AI_DOC_PER_DAY_KNOWN = 10;

/** Во что обходится разбор — по этому виду выбирается счётчик. */
export type AiFileKind = "voice" | "photo" | "video" | "document";

/** Колонка счётчика для вида файла — одна таблица соответствий на весь модуль. */
export const AI_FILE_COLUMN: Record<AiFileKind, "aiVoiceToday" | "aiPhotoToday" | "aiVideoToday" | "aiDocToday"> = {
  voice: "aiVoiceToday",
  photo: "aiPhotoToday",
  video: "aiVideoToday",
  document: "aiDocToday",
};

export function aiFileLimitFor(kind: AiFileKind, known: boolean): number {
  switch (kind) {
    case "voice":
      return known ? AI_VOICE_PER_DAY_KNOWN : AI_VOICE_PER_DAY_STRANGER;
    case "photo":
      return known ? AI_PHOTO_PER_DAY_KNOWN : AI_PHOTO_PER_DAY_STRANGER;
    case "video":
      return known ? AI_VIDEO_PER_DAY_KNOWN : AI_VIDEO_PER_DAY_STRANGER;
    default:
      return known ? AI_DOC_PER_DAY_KNOWN : AI_DOC_PER_DAY_STRANGER;
  }
}

// Сутки по Душанбе как ключ "YYYY-MM-DD". Правило живёт в общем пакете: до
// 22.09.2026 оно было написано дважды и РАЗНЫМИ способами — здесь через сдвиг
// времени, на сайте через toLocaleDateString("en-CA"). Ответы сходились (в
// Таджикистане нет перевода часов), но это были два независимых куска кода под
// одним именем. Разбор — в шапке packages/shared/src/dushanbeDay.ts (#752).
// Переизлучается отсюда, чтобы вызовы по серверу остались прежними.
import { dushanbeDayKey } from "@royal-home/shared";
export { dushanbeDayKey };

/**
 * Где физически лежат счётчики этой записи.
 *
 * "conversation" — колонки самого диалога Meta (BotConversation), как с 21.08.2026.
 * "peer" — общая таблица AiBudgetCounter по ключу «канал + собеседник»: ею живут
 * каналы, у которых своей колонки нет (Telegram, комментарии, ИИ-чат сайта).
 */
export type AiBudgetStore = "conversation" | "peer";

/**
 * Имя таблицы подставляется в SQL из ЗАКРЫТОГО списка, а не из данных: Postgres не
 * принимает идентификатор параметром, и любая другая подстановка была бы дырой.
 */
const STORE_TABLE: Record<AiBudgetStore, string> = {
  conversation: "BotConversation",
  peer: "AiBudgetCounter",
};

/** Ровно те поля диалога, которые нужны бюджету, — чтобы модуль не зависел от того,
 *  как именно вызывающий загрузил запись. */
export interface AiBudgetRow {
  id: string;
  /** Хранилище счётчиков. Не задано — колонки BotConversation (поведение до 22.08.2026). */
  store?: AiBudgetStore;
  clientId: string | null;
  aiBudgetDate: string | null;
  aiTurnsToday: number;
  aiVoiceToday: number;
  aiPhotoToday: number;
  aiVideoToday: number;
  aiDocToday: number;
  aiLimitNoticeAt: Date | null;
}

export interface AiDailyBudget {
  /** Сутки, к которым относится этот расчёт (по Душанбе). */
  dayKey: string;
  /** Диалог привязан к карточке клиента — предел больше. */
  known: boolean;
  /**
   * Сколько ходов модели этому диалогу ещё положено сегодня ДО АВАРИЙНОГО потолка.
   * Пока действует мягкий режим, бот останавливается только здесь — то есть впятеро
   * позже мягкого предела.
   */
  turnsLeft: number;
  /** Сколько файлов каждого вида ещё разрешено разобрать сегодня (до потолка). */
  filesLeft: Record<AiFileKind, number>;
  /**
   * Мягкий предел уже перейдён — самое время позвать агента и записать это в отчёт,
   * но бота НЕ останавливать. Первый месяц пределы наблюдают, а не отсекают.
   */
  softExceeded: boolean;
  /**
   * Мягкий предел перейдён ИМЕННО СЕЙЧАС — этим ходом. По этому признаку агент
   * зовётся один раз за сутки: условие истинно ровно на одном ходу, и второго пуша
   * не будет, сколько бы реплик человек ни написал дальше.
   */
  softJustExceeded: boolean;
  /** Вежливый ответ «подключится агент» сегодня уже уходил — второй раз не шлём. */
  noticeSentToday: boolean;
}

/** Начало строки журнала «голосовые на сегодня кончились» — см. aiDailyBudgetOf. */
export const VOICE_BUDGET_EXHAUSTED_LOG_PREFIX =
  "Суточный предел голосовых исчерпан — новые голосовые в этом диалоге сегодня не расшифровываются";

/**
 * Остаток бюджета — БЕЗ обращения к базе: все поля уже пришли вместе с диалогом.
 * Отметка о вчерашних сутках читается как «сегодня потрачено ноль»: физически
 * счётчики обнулит первый же расход (см. spendAiTurns/spendAiFiles), а до него
 * старые числа просто не учитываются. Единственная запись отсюда — строка журнала
 * о кончившихся голосовых (в отрыве, ответа не задерживает).
 */
export function aiDailyBudgetOf(conversation: AiBudgetRow, at: Date = new Date()): AiDailyBudget {
  const dayKey = dushanbeDayKey(at);
  const sameDay = conversation.aiBudgetDate === dayKey;
  const known = !!conversation.clientId;
  const turnsUsed = sameDay ? conversation.aiTurnsToday : 0;
  const used = (column: (typeof AI_FILE_COLUMN)[AiFileKind]) => (sameDay ? conversation[column] : 0);
  const softTurns = known ? AI_TURNS_PER_DAY_KNOWN : AI_TURNS_PER_DAY_STRANGER;
  /**
   * Остаток считается до АВАРИЙНОГО потолка, а не до мягкого предела: пока идёт
   * первый месяц, мягкий предел только сигналит. Документы — исключение: там ноль
   * означает «незнакомцу не разбираем вовсе», и умножать ноль не на что.
   */
  const roomTo = (limit: number) => (limit === 0 ? 0 : limit * AI_HARD_LIMIT_MULTIPLIER);
  const voiceLeft = Math.max(0, roomTo(aiFileLimitFor("voice", known)) - used(AI_FILE_COLUMN.voice));
  /**
   * ГОЛОСОВЫЕ КОНЧИЛИСЬ — СТРОКА В ЖУРНАЛ (25.09.2026). Дальше этого места
   * голосовое клиента просто не отдаётся в расшифровку (takeFileBudget("voice")
   * в messengers/conversation.ts и в Telegram отвечает «нет»), бот извиняется
   * «паёми овозиро кушода наметавонам», а владелец не видел ни строки о причине.
   * Пишем здесь, а не у вызывающих, — одно место на все каналы. Начало текста
   * постоянное и совпадает с dedupKey: одна строка за десять минут, сколько бы
   * ходов ни шло.
   */
  if (voiceLeft === 0 && used(AI_FILE_COLUMN.voice) > 0) {
    void logSystemError("ai", `${VOICE_BUDGET_EXHAUSTED_LOG_PREFIX} (диалог ${conversation.id}, ${dayKey})`, {
      dedupKey: VOICE_BUDGET_EXHAUSTED_LOG_PREFIX,
    });
  }

  return {
    dayKey,
    known,
    turnsLeft: Math.max(0, roomTo(softTurns) - turnsUsed),
    filesLeft: {
      voice: voiceLeft,
      photo: Math.max(0, roomTo(aiFileLimitFor("photo", known)) - used(AI_FILE_COLUMN.photo)),
      video: Math.max(0, roomTo(aiFileLimitFor("video", known)) - used(AI_FILE_COLUMN.video)),
      document: Math.max(0, roomTo(aiFileLimitFor("document", known)) - used(AI_FILE_COLUMN.document)),
    },
    softExceeded: turnsUsed >= softTurns,
    softJustExceeded: turnsUsed === softTurns,
    noticeSentToday:
      !!conversation.aiLimitNoticeAt && conversation.aiLimitNoticeAt.getTime() >= dushanbeStartOfToday(at).getTime(),
  };
}

/**
 * Расход одним UPDATE, без чтения перед записью.
 *
 * Смена суток обрабатывается тем же запросом: дата в записи не сегодняшняя —
 * счётчики начинаются с нуля, а «соседний» счётчик обнуляется заодно, иначе
 * вчерашние файлы дожили бы до сегодняшних суток. Читать-и-писать двумя запросами
 * здесь нельзя: два сообщения клиента обрабатываются параллельно (каждое своим
 * вебхуком), и между чтением и записью счётчик успевает уехать.
 *
 * Приведение `::int` обязательно: без него параметр уезжает в Postgres как double
 * precision, а колонка целочисленная.
 */
/** Все счётчики суток — растёт один, остальные обнуляются на новых сутках. */
const COUNTERS = ["aiTurnsToday", "aiVoiceToday", "aiPhotoToday", "aiVideoToday", "aiDocToday"] as const;
type CounterColumn = (typeof COUNTERS)[number];

async function bump(
  conversationId: string,
  dayKey: string,
  column: CounterColumn,
  n: number,
  store: AiBudgetStore = "conversation"
) {
  if (n <= 0) return;
  // Пустой идентификатор — строку счётчиков не удалось создать (отказ базы, см.
  // loadPeerAiBudget). Писать некуда, но и падать здесь нельзя: предел мягкий,
  // и потеря счёта не должна стоить клиенту ответа.
  if (!conversationId) return;
  // Все остальные счётчики на новых сутках обязаны обнулиться ТЕМ ЖЕ запросом:
  // иначе вчерашние голосовые дожили бы до сегодняшнего дня и съели чужой предел.
  const others = COUNTERS.filter((name) => name !== column);
  try {
    // К13 (аудит безопасности 11.09.2026): $executeRawUnsafe → $executeRaw с
    // Prisma.sql. Имена таблицы/колонок по-прежнему подставляются текстом —
    // Postgres не принимает идентификатор параметром, — но ТОЛЬКО через
    // Prisma.raw и ТОЛЬКО из закрытых списков выше (STORE_TABLE, COUNTERS), а не
    // из внешних данных; сами значения ($2/$3 раньше) идут обычными
    // параметрами $executeRaw — та же защита от инъекции, что у остального кода,
    // без ручной нумерации плейсхолдеров.
    const table = Prisma.raw(`"${STORE_TABLE[store]}"`);
    const columnRaw = Prisma.raw(`"${column}"`);
    const othersSql = Prisma.join(
      others.map((name) => Prisma.sql`"${Prisma.raw(name)}" = CASE WHEN "aiBudgetDate" = ${dayKey} THEN "${Prisma.raw(name)}" ELSE 0 END`),
      ",\n              "
    );
    await prisma.$executeRaw(Prisma.sql`
      UPDATE ${table}
         SET ${columnRaw} = CASE WHEN "aiBudgetDate" = ${dayKey} THEN ${columnRaw} + ${n}::int ELSE ${n}::int END,
             ${othersSql},
             "aiBudgetDate" = ${dayKey}
       WHERE "id" = ${conversationId}
    `);
  } catch (err) {
    // Молчать нельзя: не записанный расход означает, что предела фактически нет.
    void logSystemError("ai", `Счётчик суточного бюджета ИИ не обновлён (${conversationId}): ${describeError(err)}`);
  }
}

/** Засчитать РЕАЛЬНО состоявшееся обращение к модели.
 *  @param store где лежат счётчики: диалог Meta (по умолчанию) или общая таблица. */
export async function spendAiTurns(
  conversationId: string,
  dayKey: string,
  n = 1,
  store: AiBudgetStore = "conversation"
): Promise<void> {
  await bump(conversationId, dayKey, "aiTurnsToday", n, store);
}

/** Засчитать РЕАЛЬНО начатый разбор файла — в счёт своего вида (голос/фото/видео/документ). */
export async function spendAiFiles(
  conversationId: string,
  dayKey: string,
  kind: AiFileKind,
  n = 1,
  store: AiBudgetStore = "conversation"
): Promise<void> {
  await bump(conversationId, dayKey, AI_FILE_COLUMN[kind], n, store);
}

/** Счётчики собеседника вместе с расчётом остатка — всё, что нужно каналу на ход. */
export interface AiPeerBudget {
  /** Строка счётчиков: её же передавать в noticeAiBudgetHandover и в spendAi*. */
  row: AiBudgetRow;
  /** Остаток на сегодня, посчитанный тем же aiDailyBudgetOf, что и у переписки Meta. */
  budget: AiDailyBudget;
}

/**
 * Счётчики канала, у которого нет своей колонки: Telegram, комментарии, ИИ-чат сайта.
 *
 * ОДНИМ ЗАПРОСОМ, а не «поискали — не нашли — создали»: два сообщения одного
 * человека обрабатываются параллельно (каждое своим вебхуком), и между чтением и
 * вставкой второй запрос успевает создать ту же строку — уникальный ключ
 * (channel, peerId) отвечает на это отказом, то есть потерянным ходом на ровном
 * месте. ON CONFLICT снимает вопрос вовсе.
 *
 * Запрос СЫРОЙ, а не через prisma.aiBudgetCounter: миграцию на прод накатывают
 * отдельно, и сгенерированный клиент в момент сборки может её ещё не знать.
 *
 * ОТКАЗ БАЗЫ НЕ ЛИШАЕТ КЛИЕНТА ОТВЕТА. Предел мягкий и первый месяц только
 * наблюдает; молчать из-за того, что не удалось посчитать, — хуже, чем не
 * посчитать. Поэтому при отказе возвращаем пустой счёт (бюджет полон) и пишем в
 * журнал: расход в таком ходу просто не запишется (см. bump с пустым id).
 *
 * @param channel метка канала: TELEGRAM | INSTAGRAM_COMMENTS | ...
 * @param peerId  идентификатор собеседника внутри канала (chatId, автор комментария)
 * @param clientId карточка клиента, если она есть, — от неё зависит размер предела
 */
export async function loadPeerAiBudget(
  channel: string,
  peerId: string,
  clientId: string | null,
  at: Date = new Date()
): Promise<AiPeerBudget> {
  const empty: AiBudgetRow = {
    id: "",
    store: "peer",
    clientId,
    aiBudgetDate: null,
    aiTurnsToday: 0,
    aiVoiceToday: 0,
    aiPhotoToday: 0,
    aiVideoToday: 0,
    aiDocToday: 0,
    aiLimitNoticeAt: null,
  };
  try {
    const rows = await prisma.$queryRawUnsafe<
      {
        id: string;
        aiBudgetDate: string | null;
        aiTurnsToday: number;
        aiVoiceToday: number;
        aiPhotoToday: number;
        aiVideoToday: number;
        aiDocToday: number;
        aiLimitNoticeAt: Date | null;
      }[]
    >(
      `INSERT INTO "AiBudgetCounter" ("id", "channel", "peerId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, now(), now())
       ON CONFLICT ("channel", "peerId") DO UPDATE SET "updatedAt" = now()
       RETURNING "id", "aiBudgetDate", "aiTurnsToday", "aiVoiceToday", "aiPhotoToday",
                 "aiVideoToday", "aiDocToday", "aiLimitNoticeAt"`,
      channel,
      peerId
    );
    const found = rows[0];
    const row: AiBudgetRow = found ? { ...found, store: "peer", clientId } : empty;
    return { row, budget: aiDailyBudgetOf(row, at) };
  } catch (err) {
    void logSystemError(
      "ai",
      `Счётчик суточного бюджета ИИ не прочитан (${channel}/${peerId}): ${describeError(err)} — ` +
        `ход разрешён без учёта, предел на этом сообщении не действует`
    );
    return { row: empty, budget: aiDailyBudgetOf(empty, at) };
  }
}

/**
 * ЧТО ВИДИТ КЛИЕНТ, КОГДА БЮДЖЕТ КОНЧИЛСЯ.
 *
 * Не «вы исчерпали лимит» и не тишина. Первое — прямая подсказка тому, кто нас и
 * обкатывал: он поймёт, где граница, и заведёт второй диалог. Второе — обида
 * настоящему клиенту, которого предел зацепил по ошибке.
 *
 * Поэтому — обычная фраза передачи живому человеку. Даже ложное срабатывание при
 * ней ничего не ломает: клиент не теряется, а попадает к агенту (которому в ту же
 * секунду уходит push), то есть ровно туда, куда бот его и должен привести.
 */
const HANDOVER_REPLY: Record<"tg" | "ru", string> = {
  tg: "Раҳмат барои саволҳо! Ҳозир агенти мо ба сӯҳбат ҳамроҳ мешавад ва ҳама чизро мефаҳмонад 🙂",
  ru: "Спасибо за вопросы! Сейчас к диалогу подключится наш агент и всё подробно расскажет 🙂",
};

/**
 * Push тому, кто должен подхватить разговор: агенту клиента, если карточка есть,
 * иначе всем, кто работает с сообщениями (тот же выбор получателей, что у просьбы
 * о звонке — lib/callbackRequests.ts).
 *
 * БЕЗ `kind` НАМЕРЕННО: это служебный сигнал эскалации, а не «новое сообщение».
 * Уведомление без kind не отбирается личными настройками (см. isMuted в push.ts) —
 * сотрудник, отключивший себе пуши о сообщениях, всё равно узнает, что бот замолчал.
 */
async function notifyStaff(conversation: AiBudgetRow, channel: string, name: string | null): Promise<void> {
  const client = conversation.clientId
    ? await prisma.client.findUnique({
        where: { id: conversation.clientId },
        select: { shortId: true, fullName: true, assignedAgentId: true },
      })
    : null;
  const agentIds = client?.assignedAgentId
    ? [client.assignedAgentId]
    : await findAgentsWithPermission("messages.view");
  if (agentIds.length === 0) return;
  const who = client?.fullName ?? name ?? channel;
  await sendPushToAgents(agentIds, {
    title: "🤖 Бот передал диалог вам",
    body: `${who}: разговор упёрся в суточный предел ответов ИИ — бот дальше молчит. Ответьте, пожалуйста, сами.`,
    url: client?.shortId ? `/clients/${client.shortId}` : "/messages",
    // Тег на диалог: повторный сигнал по тому же разговору заменяет прежний в шторке.
    tag: `ai-budget-${conversation.id}`,
  });
}

/**
 * Отметить упёртый предел и вернуть текст для клиента — ИЛИ null, если сегодня
 * такой ответ уже уходил (тогда бот молчит совсем: одно вежливое сообщение в сутки,
 * а не заготовка на каждую реплику).
 *
 * Отметка ставится УСЛОВНЫМ UPDATE, а не «прочитали — решили — записали»: пока ход
 * ждал модель, соседнее сообщение того же клиента могло дойти до этой же ветки.
 * Ноль изменённых строк = кто-то уже занял сегодняшний слот, значит мы молчим.
 */
export async function noticeAiBudgetHandover(
  conversation: AiBudgetRow,
  channel: string,
  name: string | null,
  language: ClientLanguage,
  at: Date = new Date()
): Promise<string | null> {
  // Строки счётчиков нет вовсе (отказ базы при загрузке) — отмечать негде, и
  // ежесуточная «одна вежливая фраза» превратилась бы в фразу на каждый ход.
  if (!conversation.id) return null;
  // Таблица — из закрытого списка STORE_TABLE: у Telegram и комментариев счётчики
  // лежат в общей таблице, а не в колонках диалога Meta (аудит 22.08.2026).
  // К13 (11.09.2026): $executeRawUnsafe → $executeRaw + Prisma.sql/Prisma.raw —
  // тот же довод, что и в bump() выше.
  const table = Prisma.raw(`"${STORE_TABLE[conversation.store ?? "conversation"]}"`);
  const changed = await prisma
    .$executeRaw(
      Prisma.sql`
        UPDATE ${table}
           SET "aiLimitNoticeAt" = ${at}
         WHERE "id" = ${conversation.id}
           AND ("aiLimitNoticeAt" IS NULL OR "aiLimitNoticeAt" < ${dushanbeStartOfToday(at)})
      `
    )
    .catch((err: unknown) => {
      void logSystemError("ai", `Отметка о пределе ИИ не поставлена (${conversation.id}): ${describeError(err)}`);
      return 0;
    });
  if (changed === 0) return null;

  // Push не ждём и не даём ему уронить ответ клиенту: сообщение важнее уведомления
  // о нём (тот же принцип, что в lib/clientMessageAlert.ts).
  void notifyStaff(conversation, channel, name).catch((err) =>
    logSystemError("ai", `Push о пределе ИИ не отправлен (${conversation.id}): ${describeError(err)}`)
  );

  return HANDOVER_REPLY[language === "ru" ? "ru" : "tg"];
}
