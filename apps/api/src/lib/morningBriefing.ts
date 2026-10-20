import path from "node:path";
import fs from "node:fs";
import {
  pluralizeRu,
  type BriefingNumbers,
  type BriefingSource,
  type MorningBriefing,
} from "@royal-home/shared";
import { callAiText } from "../ai/client.js";
import { loadMorningNumbers, type MorningNumbers } from "./morningNumbers.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { ensureCachedWav, privateVoiceRoot, voiceCacheKey } from "./voiceCache.js";

/**
 * Утренний брифинг директору внутри CRM: те же числа, что уходят push-сводкой в
 * 08:00 (cron.ts → sendDirectorDigest), но связным текстом и голосом.
 *
 * Числа берутся из loadMorningNumbers() — третьего запроса к базе про одно и то
 * же утро в репозитории быть не должно (см. шапку lib/morningNumbers.ts: две
 * копии уже однажды разошлись).
 *
 * Текст пишет модель дешёвого уровня (callAiText simple: true). Модель НИЧЕГО не
 * считает: числа приходят ей готовыми, а инструкция запрещает придумывать те,
 * которых нет. Отказ модели — не ошибка экрана: собирается тот же текст по
 * шаблону, отказ уходит в журнал через logSystemError.
 */

/** Голос брифинга — тот же, что у приветствия: один голос у лица ИИ. */
export const BRIEFING_VOICE = process.env.GEMINI_GREETING_VOICE || "Aoede";

/** Кеш озвучки брифинга — рядом с остальной озвучкой, в приватном каталоге. */
const briefingsRoot = path.join(privateVoiceRoot, "briefings");

/** "YYYY-MM-DD" по Душанбе — ключ суток и для кеша, и для фронта. */
export function briefingDateKey(at: Date = new Date()): string {
  return dushanbeWallClock(at).toISOString().slice(0, 10);
}

const NO_DATA = "данных нет";

function money(n: number): string {
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(n))} сомони`;
}

/** Только те числа, что действительно уходят в текст и на экран. */
export function pickBriefingNumbers(n: MorningNumbers): BriefingNumbers {
  return {
    tasksToday: n.tasksToday,
    leadsYesterday: n.leadsYesterday,
    dealsYesterday: n.dealsYesterday,
    commissionMonth: n.commissionMonth,
    errorsYesterday: n.errorsYesterday,
    incomingYesterday: n.incomingYesterday,
    missedYesterday: n.missedYesterday,
    unqualifiedNow: n.unqualifiedNow,
    firstTouchMedianMin: n.firstTouchMedianMin,
    firstTouchSlowCount: n.firstTouchSlowCount,
    firstTouchNoneCount: n.firstTouchNoneCount,
    showingSummariesOverdue48h: n.showingSummariesOverdue48h,
    sellersWithoutPropertyOver7Days: n.sellersWithoutPropertyOver7Days,
  };
}

/**
 * Шаблонный брифинг по числам — и запасной вариант при отказе ИИ, и то, что
 * модель получает на вход как «сырьё». Никаких оценок и прогнозов: только факты
 * из базы, а где данных нет — так и написано.
 */
export function buildFallbackBriefingText(n: BriefingNumbers): string {
  const sentences: string[] = [];

  sentences.push(
    `Сегодня у команды ${n.tasksToday} ${pluralizeRu(n.tasksToday, ["задача", "задачи", "задач"])}.`
  );
  sentences.push(
    `Вчера пришло ${n.leadsYesterday} ${pluralizeRu(n.leadsYesterday, ["новый лид", "новых лида", "новых лидов"])}` +
      ` и закрыто ${n.dealsYesterday} ${pluralizeRu(n.dealsYesterday, ["сделка", "сделки", "сделок"])}.`
  );
  sentences.push(`Комиссия с начала месяца — ${money(n.commissionMonth)}.`);

  sentences.push(
    n.incomingYesterday > 0
      ? `Звонков вчера ${n.incomingYesterday}, из них потеряно ${n.missedYesterday}.`
      : `Звонков вчера не было.`
  );

  if (n.firstTouchMedianMin === null) {
    sentences.push(`Первое касание по вчерашним лидам: ${NO_DATA}.`);
  } else {
    sentences.push(
      `Первое касание вчера в среднем за ${n.firstTouchMedianMin} ${pluralizeRu(n.firstTouchMedianMin, ["минуту", "минуты", "минут"])}` +
        (n.firstTouchNoneCount > 0 ? `, без ответа осталось ${n.firstTouchNoneCount}.` : ".")
    );
  }

  if (n.errorsYesterday > 0) {
    sentences.push(
      `Система поймала ${n.errorsYesterday} ${pluralizeRu(n.errorsYesterday, ["ошибку", "ошибки", "ошибок"])} — детали в Настройках.`
    );
  }

  return sentences.join(" ");
}

const SYSTEM_PROMPT = [
  "Ты помощник директора агентства недвижимости в Душанбе.",
  "Тебе дают готовые числа за утро. Перескажи их директору по-русски: 3-5 коротких предложений, спокойно, по делу, без приветствий и без вопросов.",
  "СТРОГО ЗАПРЕЩЕНО придумывать числа, проценты, сравнения с прошлой неделей и прогнозы: используй только те числа, что даны.",
  "Если по показателю данных нет, так и скажи словами «данных нет».",
  "Сначала главное (потери и просрочки), потом остальное. Без списков, без эмодзи, без markdown — сплошной текст. Ответ передавай через инструмент submit_reply.",
].join(" ");

/** Явный предел на весь вызов модели поверх собственных таймаутов ai/client. */
const AI_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

async function generateBriefingText(n: BriefingNumbers): Promise<{ text: string; source: BriefingSource }> {
  const facts = [
    `Задач у команды сегодня: ${n.tasksToday}`,
    `Новых лидов вчера: ${n.leadsYesterday}`,
    `Закрытых сделок вчера: ${n.dealsYesterday}`,
    `Комиссия с начала месяца, сомони: ${Math.round(n.commissionMonth)}`,
    `Входящих звонков вчера: ${n.incomingYesterday}, потеряно: ${n.missedYesterday}`,
    `Разговоров, не разобранных оператором: ${n.unqualifiedNow}`,
    `Медиана первого касания, минут: ${n.firstTouchMedianMin === null ? NO_DATA : n.firstTouchMedianMin}`,
    `Лидов вчера без первого касания: ${n.firstTouchNoneCount}`,
    `Первых касаний дольше часа: ${n.firstTouchSlowCount}`,
    `Итогов показов просрочено больше 48 часов: ${n.showingSummariesOverdue48h}`,
    `Продавцов без объекта дольше 7 дней: ${n.sellersWithoutPropertyOver7Days}`,
    `Неразобранных ошибок системы за вчера: ${n.errorsYesterday}`,
  ].join("\n");

  // Ответ через инструмент (schema), а не сплошным текстом: callGemini разбирает
  // ответ через extractJson и прозу без схемы считает пустым ответом.
  const raw = await withTimeout(
    callAiText<{ text?: string }>({
      endpoint: "morning-briefing",
      simple: true,
      systemStable: SYSTEM_PROMPT,
      system: SYSTEM_PROMPT,
      user: facts,
      maxTokens: 600,
      schema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", description: "Брифинг директору, 3-5 предложений по-русски" } },
      },
    }),
    AI_TIMEOUT_MS
  );

  const text = (raw?.text ?? "").trim();
  if (!text) {
    void logSystemError(
      "ai",
      "Утренний брифинг: модель не ответила, показан текст по шаблону (morning-briefing)"
    );
    return { text: buildFallbackBriefingText(n), source: "fallback" };
  }
  return { text, source: "ai" };
}

/** Имя WAV — по хешу текста: сменился текст, сменился и файл, старый не отдаётся. */
function audioFileName(text: string): string {
  return `${voiceCacheKey(text, BRIEFING_VOICE)}.wav`;
}

export interface CachedBriefing {
  dushanbeDate: string;
  text: string;
  source: BriefingSource;
  numbers: BriefingNumbers;
  /** Момент сборки — нужен, чтобы запасной текст не залипал на сутки. */
  builtAt: number;
}

/**
 * Кеш на сутки в памяти процесса: брифинг генерируется один раз в день, все
 * повторные запросы (директор обновил вкладку, открыл телефон) отдают его же.
 * Отдельной таблицы нет намеренно — текст восстановим из чисел в любой момент,
 * а перезапуск API за сутки случается чаще, чем стоит одна генерация Haiku.
 */
let cached: CachedBriefing | null = null;
let inFlight: Promise<CachedBriefing> | null = null;

/**
 * Шаблонный текст в кеше держим не сутки, а десять минут: отказ модели обычно
 * временный (квота, сеть), и запирать директора до завтра на запасном тексте
 * незачем — следующее открытие главной попробует ещё раз.
 */
const FALLBACK_RETRY_MS = 10 * 60 * 1000;

/** Только для тестов: сбросить дневной кеш. */
export function resetBriefingCache(): void {
  cached = null;
  inFlight = null;
}

function cacheUsable(entry: CachedBriefing | null, dushanbeDate: string, now: number): boolean {
  if (!entry || entry.dushanbeDate !== dushanbeDate) return false;
  if (entry.source === "fallback" && now - entry.builtAt > FALLBACK_RETRY_MS) return false;
  return true;
}

export async function loadBriefing(at: Date = new Date()): Promise<CachedBriefing> {
  const dushanbeDate = briefingDateKey(at);
  if (cacheUsable(cached, dushanbeDate, at.getTime())) return cached!;
  // Директор открывает главную на ПК и телефоне почти одновременно — второй
  // запрос обязан ждать первый, а не платить за вторую генерацию.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<CachedBriefing> => {
    try {
      const numbers = pickBriefingNumbers(await loadMorningNumbers());
      const { text, source } = await generateBriefingText(numbers);
      cached = { dushanbeDate, text, source, numbers, builtAt: Date.now() };
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * WAV брифинга: из кеша либо синтез. null — озвучка недоступна.
 *
 * timeoutMs увеличен до 60с (15.09.2026): брифинг синтезируется ЗАРАНЕЕ (кеш
 * по хешу текста — loadBriefing/buildBriefingResponse выше) и никогда не
 * стоит на пути живой реплики бота, поэтому общий предел voiceCache.ts
 * (VOICE_TTS_TIMEOUT_MS = 15с, рассчитан на живой разговор) здесь только
 * срезал озвучку раньше времени. Сам предел по умолчанию не тронут — он
 * защищает именно живые реплики.
 */
export async function ensureBriefingAudio(text: string): Promise<string | null> {
  return ensureCachedWav({
    dir: briefingsRoot,
    filePath: path.join(briefingsRoot, audioFileName(text)),
    speechInput: `Say calmly and clearly, like a premium assistant reporting to a director: ${text}`,
    voice: BRIEFING_VOICE,
    label: "утреннего брифинга",
    timeoutMs: 60_000,
  });
}

/** Существующий файл озвучки для отдачи по роуту — null, если не сгенерирован. */
export function existingBriefingAudioPath(text: string): string | null {
  const filePath = path.join(briefingsRoot, audioFileName(text));
  return fs.existsSync(filePath) ? filePath : null;
}

/** Готовый ответ эндпоинта, включая ссылку на озвучку. */
export async function buildBriefingResponse(at: Date = new Date()): Promise<MorningBriefing> {
  const briefing = await loadBriefing(at);
  const audioPath = await ensureBriefingAudio(briefing.text);
  return {
    dushanbeDate: briefing.dushanbeDate,
    text: briefing.text,
    source: briefing.source,
    numbers: briefing.numbers,
    // ВАЖНО: без префикса "/api/v1" — фронтовый api() добавляет его сам
    // (та же грабля, что была у озвучки приветствия, см. routes/greeting.ts).
    audioUrl: audioPath ? "/dashboard/briefing/audio" : null,
  };
}
