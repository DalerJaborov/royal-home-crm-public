import { GEMINI_FUNCTION_DECLARATION_PROTOCOL, managedGeminiFunctionDeclarations } from "./geminiFunctionDeclarations.js";
import { prisma } from "../db.js";
import { traceModelStart, traceModelFinish, traceModelCache, traceKnownSecrets } from "../lib/botTurnTrace.js";
import { emptyUsage, extractJson, logAiCall, type ChatMessage, type ImageInput } from "./shared.js";
import {
  GEMINI_MODEL,
  GEMINI_RETRY_DELAYS_MS,
  geminiGenerateUrlFor,
  geminiModelFamily,
  geminiProxyHeaders,
  geminiStreamUrlFor,
  geminiThinkingConfig,
  isRetryableGeminiStatus,
  sleep,
} from "./geminiTransport.js";
import { logSystemError } from "../lib/systemError.js";
import { resolveGeminiRuntime, type GeminiRuntime } from "./geminiSettings.js";
import { resolveGeminiCache } from "./geminiCache.js";
import { ProviderOperationError, isProviderOperationError, type ProviderOperation, type ProviderAttempt } from "./providerContract.js";
import { resolveGeminiOperationRuntime as providerRuntime, assertBoundGeminiRuntimeKey as assertBoundRuntimeKey, boundGeminiCountContext } from "./geminiOperationRuntime.js";
import { countGeminiToolsRequest, consumeGeminiToolsCount } from "./geminiCountedTools.js";
import { GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL, managedGeminiMediaFeatures } from "./geminiManagedMedia.js";
import { createSseDataReader, createToolStreamAccumulator, GeminiStreamFormatError, type GeminiStreamChunk } from "./geminiStream.js";

function managedThinking(model: string): false | "budget" | "level" {
  return thinkingConfigRejected[model] ? false : "thinkingBudget" in geminiThinkingConfig(model) ? "budget" : "level";
}

/**
 * Ключи Gemini по порядку: основной — из Настроек (БД, зашифрован), приоритетнее,
 * или из .env как запасной, — затем второй ключ, который берётся так же (сперва
 * Настройки, потом `GEMINI_API_KEY_2`), а после них СКОЛЬКО УГОДНО дополнительных
 * ключей из Настроек (geminiApiKeysExtra, каждый зашифрован) в том порядке, в каком
 * их завёл владелец. Следующий ключ подключается автоматически после того, как
 * предыдущий исчерпал все повторы и резервную модель (см. callGemini) — страхует от
 * отказов, специфичных именно этому ключу/проекту (лимит, блокировка, удаление при
 * ротации), а не только от общей перегрузки модели.
 *
 * УСТОЙЧИВОСТЬ ДАЁТ НЕ ЧИСЛО КЛЮЧЕЙ, А РАЗНЫЕ ПРОЕКТЫ GOOGLE. Суточная квота
 * считается на ПРОЕКТ и модель, а не на ключ: выяснено живой проверкой 20.08.2026 —
 * в отказе Google назвал метрику `generate_requests_per_model_per_day` с limit 100.
 * Значит десять ключей одного проекта делят одну и ту же сотню запросов и кончаются
 * в одну и ту же минуту, а два ключа из двух разных проектов дают две квоты. Перебор
 * здесь спасает от смерти КЛЮЧА (удалён при ротации, заблокирован) всегда, а от
 * исчерпания квоты — только если ключи заведены в разных проектах.
 *
 * Все ключи читаются одним запросом к БД намеренно: это горячий путь (каждый ход
 * диалога, каждое голосовое), и второй запрос ради одного поля здесь лишний.
 */
export async function resolveGeminiKeys(): Promise<string[]> {
  return (await resolveGeminiRuntime()).keys;
}

/** Первый доступный ключ — для мест, которым второй не нужен (проверка «настроен ли
 *  Gemini вообще», путь загрузки файла с одним и тем же ключом на всех шагах). */
export async function resolveGeminiKey(): Promise<string | undefined> {
  return (await resolveGeminiKeys())[0];
}

/**
 * Пределы времени читаются из окружения с разумными умолчаниями: когда основная
 * модель перегружена (503 на стороне Google), крутить эти цифры приходится в
 * проде и быстрее, чем проходит выкат. Значение из .env — только рычаг, поведение
 * без него ровно прежнее.
 */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Тестовый провайдер для текстового чата бота (A/B против Claude, см. callAiText
 *  в client.ts). Адрес, модель и прокси-Worker (геоблок VPS) — общие для всех
 *  вызовов Gemini, живут в ai/geminiTransport.ts. */
const TIMEOUT_MS = envMs("GEMINI_ATTEMPT_TIMEOUT_MS", 30_000);

/**
 * ОБЩИЙ ПОТОЛОК ВРЕМЕНИ НА ВЕСЬ ВЫЗОВ, а не только на одну попытку.
 *
 * Перебор «2 ключа × 2 модели × 4 попытки» с таймаутом 30 с и паузами 1/2/4 с в
 * худшем случае занимал больше пяти минут — и всё это время ход диалога считался
 * незаконченным: клиент ждал ответа, которого уже не будет, а следующие его
 * сообщения копились в буфере. Отказ за минуту с небольшим лучше отказа за пять:
 * повторы всё равно исчерпаны, а признать это раньше — значит раньше отдать
 * человека живому агенту.
 */
const TOTAL_BUDGET_MS = envMs("GEMINI_TOTAL_BUDGET_MS", 75_000);

/**
 * НЕПРИКОСНОВЕННЫЙ ЗАПАС ВРЕМЕНИ ПОД РЕЗЕРВНУЮ МОДЕЛЬ (16.08.2026).
 *
 * Общий бюджет тратился строго по порядку: сначала все попытки основной модели,
 * потом — что останется — резервной. Пока основная отказывала быстро (503
 * приходит мгновенно), остатка хватало. 16.08 основная модель перестала отвечать
 * ВОВСЕ: каждая попытка выедала полный таймаут, три попытки с паузами занимали
 * весь бюджет, и до резервной — той единственной, которая в этот день отвечала, —
 * очередь не доходила никогда. В журнале это новая строка «Gemini не ответил за
 * отведённые 75 с», появившаяся ровно в день перегрузки основной модели.
 *
 * Поэтому кусок бюджета режется заранее и основной модели не отдаётся: сколько бы
 * она ни висела, резервная получит своё окно. Половина общего бюджета — потолок:
 * запас, съедающий у основной больше половины, лечил бы одну болезнь другой.
 */
const FALLBACK_RESERVE_MS = Math.min(envMs("GEMINI_FALLBACK_RESERVE_MS", 35_000), Math.floor(TOTAL_BUDGET_MS / 2));

/**
 * Сколько раз пробуем ОДНУ модель: первая попытка плюс по одной на каждую паузу.
 *
 * ОДИНАКОВО ДЛЯ ОСНОВНОЙ И РЕЗЕРВНОЙ (16.08.2026). Раньше резервной полагалась
 * ровно одна попытка — «раз уж дошли до неё, то либо сейчас, либо никак». Пока
 * основная работала, это было незаметно. В день, когда работала ТОЛЬКО резервная,
 * это означало вот что: её единственный ответ с finishReason=MALFORMED_FUNCTION_CALL
 * (модель собрала битый вызов инструмента — сбой вероятностный, на следующей
 * попытке проходит) убивал ход диалога целиком. Повтор для MALFORMED_FUNCTION_CALL,
 * добавленный тем же утром, на резервном пути не работал вовсе: повторять было
 * некуда, попытка была последней. 16 таких отказов на квалификации и 14 на
 * дозакрытии — это 30 живых диалогов, где боту оставалось попробовать ещё раз.
 */
const ATTEMPTS_PER_MODEL = GEMINI_RETRY_DELAYS_MS.length + 1;

/**
 * Насколько расширяем потолок ответа на каждом повторе после «обрыва на полуслове»
 * (MALFORMED_FUNCTION_CALL / MAX_TOKENS) и до какого предела.
 *
 * Повтор тем же запросом лечит только случайный сбой; если модели не хватило места
 * дописать вызов инструмента, второй такой же запрос упрётся ровно в тот же потолок.
 * Бюджеты у диалоговых вызовов короткие нарочно (200–500 токенов на реплику), и
 * трогать их насовсем незачем: платим за сгенерированное, а не за разрешённое, —
 * значит расширять надо только там, где узко, и только на повторе.
 */
const WIDEN_STEP_TOKENS = 1000;
const WIDEN_MAX_TOKENS = 2000;

/**
 * ВНЕШНЯЯ ОТМЕНА ВЫЗОВА (31.10.2026, пачка П1 задача 1.1 помощника CRM).
 *
 * Помощник отдаёт свой AbortSignal: клиент закрыл соединение или истёк общий срок
 * диалога (25 с). Отмена — не отказ модели: её не повторяют, не переводят на
 * резервную модель и не засчитывают в предохранитель. Причина отмены (signal.reason)
 * пробрасывается как есть, чтобы вызывающий отличил «клиент ушёл» от «срок вышел».
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Вызов Gemini отменён", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Пауза перед повтором, которую прерывает внешняя отмена: ждать четыре секунды
 *  ответа, который уже некому показать, незачем. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Связать внешнюю отмену с контроллером одной попытки. Возвращает отвязку —
 *  вызывать в finally, иначе долгий сигнал копит слушателей по числу попыток. */
function linkAbort(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort(abortReason(signal));
    return () => {};
  }
  const onAbort = () => controller.abort(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Поставщик отверг блок thinkingConfig — больше его не шлём этому СЕМЕЙСТВУ моделей
 * (до перезапуска). Живёт в памяти процесса намеренно: это не настройка, а разовое
 * приспособление к ответу API, и переживать перезапуск ему незачем — после
 * обновления модели форма параметра может снова стать поддерживаемой.
 *
 * ПОЧЕМУ ПО МОДЕЛИ, А НЕ ОДНИМ ФЛАГОМ НА ВСЁ. До 16.08.2026 флаг был один общий, и
 * отказ резервной модели (линейка 2.x, параметр thinkingBudget) навсегда гасил
 * thinkingConfig и у основной (линейка 3.x, параметр thinkingLevel) — хотя её отказ
 * не касался вовсе. Тогда флаг развели по семействам, но 18.08.2026 выяснилось, что
 * и этого мало: внутри одной линейки 3.x у `gemini-3.7-flash` нижний уровень
 * размышления другой, чем у `gemini-3.6-flash`, и отказ 3.7 глушил размышление
 * заодно у 3.6, которая его принимает. Форма параметра — свойство КОНКРЕТНОЙ модели
 * (см. geminiThinkingConfig в geminiTransport.ts), значит и отказ должен быть её.
 */
const thinkingConfigRejected: Record<string, boolean> = {};

/**
 * О каких ключах уже сказано «отклонён» — чтобы сказать это один раз, а не на
 * каждый ход диалога. Как и thinkingConfigRejected, живёт в памяти процесса: после
 * замены ключа и перезапуска отчёт должен начаться с чистого листа.
 */
const rejectedKeysReported = new Set<string>();

/**
 * Ключ ОТКЛОНЁН (а не перегружен) — записать это в журнал ошибок один раз.
 *
 * ЗАЧЕМ. Перебор ключей молча вытягивал запрос на резервном, и мёртвый основной был
 * не виден никак: 12.08.2026 выяснилось, что ключ из .env удалён при ротации ещё в
 * начале августа, а узнали об этом случайно. Это та же болезнь, что и с фолбэком на
 * Claude 02.08: страховка, срабатывающая беззвучно, превращает отказ в невидимый —
 * и он всплывает, только когда кончается второй поставщик.
 *
 * 401/403 — это «такого ключа нет» или «ему запрещено»; ни то, ни другое не лечится
 * повтором и не проходит само. 429 (лимит) и 503 (перегрузка) сюда не попадают
 * намеренно: они временные, и строка о них в журнале была бы шумом.
 */
export function reportRejectedKey(
  apiKey: string,
  index: number,
  total: number,
  status: number,
  detail: string
): void {
  if (rejectedKeysReported.has(apiKey)) return;
  rejectedKeysReported.add(apiKey);
  const tail = apiKey.length > 4 ? apiKey.slice(-4) : "????";
  const position = index === 0 ? "основной" : `резервный №${index + 1}`;
  const rest =
    index + 1 < total
      ? "запрос вытянул следующий ключ — на людях это пока не сказалось, но резерв израсходован"
      : "это был последний ключ, запасных больше нет";
  void logSystemError(
    "ai",
    `Ключ Gemini (${position}, ••••${tail}) отклонён Google: HTTP ${status}. Скорее всего он удалён ` +
      `при ротации или заблокирован — повторы не помогут, нужно заменить его в Настройках → ИИ. ${rest}. Ответ: ${detail}`
  );
}

/**
 * ПРЕДОХРАНИТЕЛЬ НА МЁРТВУЮ МОДЕЛЬ + ТРЕВОГА ПО ПОРОГУ (30.08.2026, по аварии того дня).
 *
 * ЧТО СЛУЧИЛОСЬ. Основная модель `gemini-3.7-flash` больше СУТОК отдавала жёсткий
 * 503 «high demand»; резервная работала и каждый раз вытягивала запрос — снаружи всё
 * «работало». По журналу AiLog за шесть часов до починки: 716 неудачных вызовов
 * основной против 2 удачных, при 26 удачных резервной. Средний успешный вызов занимал
 * 29,6 с; после смены основной модели — 9,8 с. Разницу съедал сам перебор: 503 —
 * повторяемый статус (isRetryableGeminiStatus), поэтому КАЖДЫЙ ход диалога сначала
 * сжигал ATTEMPTS_PER_MODEL попыток и 7 секунд пауз на заведомо мёртвой модели и
 * только потом уходил на резерв. И так на каждый ответ бота, целые сутки.
 *
 * ДВА ЛЕКАРСТВА, И ОБА НУЖНЫ.
 * 1) Предохранитель: несколько отказов 503/429 подряд — и следующие вызовы идут сразу
 *    на резерв, не тратя попытки и паузы. Раз в BREAKER_OPEN_MS пропускаем одну
 *    пробную попытку на основную: починился Google — вернулись сами, без человека.
 * 2) Тревога: предохранитель экономит время, но делает простой ЕЩЁ незаметнее (было
 *    716 отказов в журнале, станет 20). Поэтому отдельная, явно тревожная запись по
 *    порогу отказов за час — с цифрой, именем модели и тем, чем это чинится.
 *
 * СОСТОЯНИЕ — В ПАМЯТИ ПРОЦЕССА, И ЭТО НАРОЧНО. Это не настройка, а наблюдение за
 * поставщиком прямо сейчас; переживать перезапуск ему незачем — после рестарта
 * честнее начать с чистой пробы. ПРОЦЕССОВ ДВА (api и worker): каждый ведёт свой
 * счёт и свой предохранитель, они не знают друг о друге. Это допустимо — оба придут
 * к одному выводу за считанные минуты, а тревожных записей будет не вдвое больше:
 * logSystemError дедуплицирует одинаковый текст (окно 10 минут).
 */
interface GeminiModelHealth {
  /** Отказов 503/429 подряд в текущем коротком окне — по ним взводится предохранитель. */
  streak: number;
  /** Когда начался короткий счёт: разрозненные отказы раз в час не должны копиться в серию. */
  streakStartedAt: number;
  /** До этого момента модель пропускаем совсем (0 — предохранитель снят). */
  openUntil: number;
  /** Начало часового окна для тревоги и число отказов в нём. */
  hourStartedAt: number;
  hourFailures: number;
  /** Когда последний раз поднимали тревогу по этой модели. */
  alarmedAt: number;
}

const modelHealth = new Map<string, GeminiModelHealth>();

/**
 * Сколько отказов подряд считаем «модель лежит». Три, а не один: 503 у Google бывает
 * и разовым, а демотировать основную модель на ровном месте — значит отвечать клиенту
 * не той моделью, которую выбрал владелец (эта беда уже была 17–18.08, см.
 * MINIMAL_THINKING_UNSUPPORTED в geminiTransport.ts). Три отказа в коротком окне —
 * это уже не совпадение.
 */
const BREAKER_FAILURE_STREAK = 3;

/** Окно, в котором отказы считаются «подряд». Шире — и редкие одиночные 503 за день
 *  слепятся в мнимую серию; уже — и настоящая авария не успеет набрать три. */
const BREAKER_STREAK_WINDOW_MS = 2 * 60 * 1000;

/**
 * Насколько модель отправляется в простой. Пять минут — компромисс после аудита
 * 03.09: три минуты давали слишком частые пробные попытки при затяжной перегрузке
 * (каждая проба — полный цикл ATTEMPTS_PER_MODEL с паузами), а дольше ждать значит
 * лишний раз не заметить, что всё уже починилось. За час это 12 пробных попыток —
 * по одной на ход, а не четыре с паузами на каждый ход.
 */
const BREAKER_OPEN_MS = 5 * 60 * 1000;

/**
 * ПОРОГ ТРЕВОГИ: сколько отказов основной модели за час — уже авария, а не рябь.
 *
 * ПОЧЕМУ 12. Снизу порог держит шум: один невезучий вызов при разовой перегрузке
 * стоит до 4 отказов (ATTEMPTS_PER_MODEL), два подряд — 8; будить директора на этом
 * нельзя, иначе тревогу перестанут читать (та же болезнь, из-за которой запись
 * «ответил на резервной» и сделана разовой). Сверху порог держит скорость: при
 * настоящей аварии предохранитель даёт 3 отказа сразу и по пробе каждые 3 минуты —
 * 12 набирается примерно за полчаса. То есть вместо суток тишины владелец узнаёт
 * об этом в течение получаса, и ровно один раз.
 */
const PRIMARY_ALARM_FAILURES_PER_HOUR = 12;

/** Повторять тревогу не чаще раза в 6 часов: авария, которую не починили, обязана
 *  напомнить о себе за сутки несколько раз — но не превратиться в поток. */
const ALARM_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function healthOf(model: string): GeminiModelHealth {
  let state = modelHealth.get(model);
  if (!state) {
    state = { streak: 0, streakStartedAt: 0, openUntil: 0, hourStartedAt: 0, hourFailures: 0, alarmedAt: 0 };
    modelHealth.set(model, state);
  }
  return state;
}

/**
 * 429 — это квота КОНКРЕТНОГО ключа/проекта («prepayment credits depleted» у
 * одного ключа, у второго кредиты есть), а 503 — перегрузка у Google, общая для
 * всех ключей. Ревью 03.09.2026: предохранитель хранил серию по имени модели и
 * истощённый ключ на 5 минут закрывал основную модель и здоровым ключам тоже.
 * Поэтому серия по 429 живёт под парой (модель, ключ), по 503 — под моделью.
 */
function breakerKey(model: string, status: number, keyIndex: number): string {
  return status === 429 ? `${model}@key${keyIndex}` : model;
}

/**
 * Модель ответила — предохранитель снимается немедленно, счёт серии обнуляется.
 * Часовой счётчик отказов НЕ трогаем: он про то, сколько всего стоила нам авария,
 * и один удачный ответ посреди неё её не отменяет.
 */
export function noteGeminiModelSuccess(model: string, keyIndex = 0): void {
  for (const state of [healthOf(model), healthOf(breakerKey(model, 429, keyIndex))]) {
    state.streak = 0;
    state.openUntil = 0;
  }
}

/**
 * Модель отказала перегрузкой/квотой (503/429) ИЛИ прокси не дождался апстрима
 * (502/504/524/408 — правка ревью 24.09.2026, добавлены сюда). 500 сюда намеренно
 * не входит (бывает разовым), 400/401/404 предохранителем не лечатся вовсе — на
 * них перебор и так уходит дальше без повторов.
 *
 * 502/504/524/408 добавлены в isRetryableGeminiStatus (geminiTransport.ts)
 * 24.09.2026 — та же природа, что у AbortError: лежащий прокси, а не отказ самой
 * модели. Но ПРЕДОХРАНИТЕЛЬ до этой правки видел только 503/429 — лежащий прокси
 * (например 524 у Cloudflare-воркера) раз за разом жёг ATTEMPTS_PER_MODEL попыток
 * НА КАЖДЫЙ ход бота, вместо того чтобы после серии открыться и сразу уйти на
 * резерв/следующую модель, как и было задумано для 503/429.
 *
 * @param isPrimary модель — основная (не резерв и не дешёвая ступень): тревога по
 *   порогу поднимается только за неё, отказ резервной — не та новость, ради которой
 *   стоит будить человека ночью.
 */
export function noteGeminiModelFailure(model: string, status: number, isPrimary: boolean, keyIndex = 0): void {
  const isBreakerStatus =
    status === 503 || status === 429 || status === 502 || status === 504 || status === 524 || status === 408;
  if (!isBreakerStatus) return;
  const now = Date.now();
  const series = healthOf(breakerKey(model, status, keyIndex));

  if (now - series.streakStartedAt > BREAKER_STREAK_WINDOW_MS) {
    series.streak = 0;
    series.streakStartedAt = now;
  }
  series.streak += 1;
  if (series.streak >= BREAKER_FAILURE_STREAK) series.openUntil = now + BREAKER_OPEN_MS;

  // Часовой счёт и тревога — по модели в целом: директору важно «основная не
  // отвечает», а не под каким ключом.
  const state = healthOf(model);
  if (now - state.hourStartedAt > 60 * 60 * 1000) {
    state.hourStartedAt = now;
    state.hourFailures = 0;
  }
  state.hourFailures += 1;

  if (!isPrimary) return;
  if (state.hourFailures < PRIMARY_ALARM_FAILURES_PER_HOUR) return;
  if (now - state.alarmedAt < ALARM_COOLDOWN_MS) return;
  state.alarmedAt = now;
  void logSystemError(
    "ai",
    `ТРЕВОГА: основная модель Gemini «${model}» отказала ${state.hourFailures} раз за час (последний ответ Google — ` +
      `HTTP ${status}). Снаружи бот отвечает — его вытягивает резервная модель, — но каждый ответ идёт медленнее ` +
      `и не той моделью, которую выбрали вы. 30.08.2026 ровно это прожило сутки незамеченным. ` +
      `Чинится БЕЗ выката кода: сменить основную модель в Настройках → ИИ либо переменную GEMINI_MODEL ` +
      `в .env.production и перезапустить api и worker.`
  );
}

/**
 * Пропустить ли модель, не тратя на неё попытки. Пропускаем только когда впереди
 * есть кому ответить: если предохранитель взведён у ВСЕХ моделей, последняя всё
 * равно пробуется — молчащий бот хуже медленного.
 *
 * Истёкший срок простоя пропуском не считается: это и есть пробная попытка, которой
 * предохранитель снимается сам (см. noteGeminiModelSuccess).
 */
function skipModelForNow(model: string, index: number, total: number, keyIndex = 0): boolean {
  if (index >= total - 1) return false;
  const now = Date.now();
  return healthOf(model).openUntil > now || healthOf(breakerKey(model, 429, keyIndex)).openUntil > now;
}

/**
 * Про какие имена моделей уже сказано «Google не знает такой». Один раз на модель за
 * жизнь процесса — как и с отклонёнными ключами (rejectedKeysReported выше).
 */
const unknownModelsReported = new Set<string>();

/**
 * HTTP 404 — модели с таким именем у Google нет: опечатка в Настройках либо модель
 * закрыли. Ни то, ни другое не проходит само и не лечится повтором, а перебор молча
 * вытянет запрос резервной моделью — ровно так 404 уже прожил два месяца незамеченным
 * (см. комментарий у GEMINI_MODEL в geminiTransport.ts). Проверка имени на входе
 * (checkGeminiModelNames в geminiSettings.ts) ловит только известные нам имена;
 * здесь — ответ самого Google, и он всегда прав.
 */
function reportUnknownModel(model: string, isPrimary: boolean, detail: string): void {
  if (unknownModelsReported.has(model)) return;
  unknownModelsReported.add(model);
  void logSystemError(
    "ai",
    `ТРЕВОГА: Google не знает модель «${model}» (${isPrimary ? "основная" : "резервная"}) — HTTP 404 на каждый ` +
      `вызов. Это либо опечатка в имени, либо модель закрыта Google. Запрос вытягивает следующая модель в списке, ` +
      `поэтому снаружи не видно ничего. Чинится без выката кода: Настройки → ИИ или GEMINI_MODEL/` +
      `GEMINI_FALLBACK_MODEL в .env.production, затем перезапуск api и worker. Ответ Google: ${detail}`
  );
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: unknown; id?: string; [key: string]: unknown };
  thoughtSignature?: string;
  [key: string]: unknown;
}

/** Only the managed text/image wire is cost-profiled here. Inspect the actual
 * parts (including tool result parts), without rewriting provider signatures or
 * guessing that an arbitrary file is an image. Legacy wire remains unchanged. */
function managedPartsHaveImages(parts: readonly GeminiPart[]): boolean {
  let images = false;
  const allowed = new Set(["text", "inline_data", "inlineData", "fileData", "file_data", "functionCall", "functionResponse", "thoughtSignature", "thought"]);
  for (const part of parts) {
    if (Object.keys(part).some(key => !allowed.has(key))) throw new ProviderOperationError("unsupported");
    for (const key of ["inline_data", "inlineData", "fileData", "file_data"] as const) {
      if (!(key in part)) continue;
      const carrier = part[key];
      if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) throw new ProviderOperationError("unsupported");
      const fields = carrier as Record<string, unknown>;
      const mime = fields.mimeType ?? fields.mime_type;
      if (typeof mime !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(mime)) throw new ProviderOperationError("unsupported");
      images = true;
    }
    const response = part.functionResponse;
    if (response && typeof response === "object" && "parts" in response) {
      const nested = (response as { parts: unknown }).parts;
      if (!Array.isArray(nested) || nested.some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new ProviderOperationError("unsupported");
      images = managedPartsHaveImages(nested) || images;
    }
  }
  return images;
}

/**
 * БЛОКИРОВКА ПРОМТА GOOGLE — С АДРЕСОМ (аудит ботов 10.10.2026, P1-8).
 *
 * 226 блокировок PROHIBITED_CONTENT за месяц (card-fill, off-crm-pause-check,
 * score-client, bot-audit…), и ни у одной не было видно, ЧЕЙ текст: причину
 * установить было нельзя, а менять содержимое запросов вслепую — нельзя тем
 * более. Пишем только идентификаторы (диалог, клиент) и тип задачи, без слов
 * переписки и номеров. Одна строка в неделю на задачу и клиента: off-crm-pause-check
 * каждый день бился об один и тот же текст и каждый день писал в «Здоровье системы»
 * то же самое — тот же текст получит тот же ответ, напоминать чаще незачем.
 */
const PROMPT_BLOCKED_DEDUP_MS = 7 * 24 * 60 * 60 * 1000;

export function logPromptBlocked(
  endpoint: string,
  reason: string,
  conversationId: string | null | undefined,
  clientId: string | null | undefined
): void {
  const subject = [conversationId ? `диалог ${conversationId}` : "", clientId ? `клиент ${clientId}` : ""]
    .filter(Boolean)
    .join(", ");
  void logSystemError(
    "ai",
    `Gemini заблокировал промт (${endpoint}): blockReason=${reason}; ${subject || "id не передан вызывающим"}. ` +
      "Это решение Google по содержимому, не сбой: повтор того же текста получит тот же ответ.",
    {
      dedupKey: `gemini-blocked:${endpoint}`,
      dedupScope: subject || undefined,
      dedupWindowMs: PROMPT_BLOCKED_DEDUP_MS,
      silent: true,
    }
  );
}

export async function callGemini<T>(params: {
  endpoint: string;
  system: string;
  /**
   * Стабильная часть системного промта — ОТДЕЛЬНО от переменной (см. buildStableSystem
   * в leadQualifier.ts). Когда включён тумблер явного кэша (Settings →
   * geminiExplicitCachingEnabled), эта часть кэшируется у Google и в запросе заменяется
   * ссылкой cachedContent; переменная часть уходит служебным ходом в contents, потому
   * что Google запрещает systemInstruction рядом с cachedContent. Выключен тумблер или
   * поле не передано — части просто склеиваются, побайтово как раньше.
   */
  systemStable?: string;
  user?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  images?: ImageInput[];
  schema?: Record<string, unknown>;
  /**
   * Задача простая — классификация, извлечение полей, перевод, — а не разговор с
   * клиентом. Если владелец настроил дешёвую ступень (Настройки → ИИ), такие вызовы
   * начинают с неё, а обычная модель становится следующей в переборе: отказ дешёвой
   * не роняет задачу, а поднимает её на ступень выше. Пока ступень не настроена,
   * признак не меняет ничего — ровно как было до 22.08.2026.
   */
  simple?: boolean;
  /**
   * Модель, с которой начать перебор (21.09.2026, фоновый разбор фактов продавца,
   * lib/sellerFacts.ts). Нужна задачам, у которых своя дешёвая ступень через
   * переменную окружения, а не через Настройки. Отказ её не роняет вызов: дальше
   * идёт обычный перебор, как у simple.
   */
  preferModel?: string;
  /** Диалог/звонок, в рамках которого сделан вызов — см. logAiCall в ./shared.js. */
  conversationId?: string | null;
  /**
   * Карточка клиента, по которой сделан вызов — ТОЛЬКО id, для журнала блокировки
   * промта (аудит ботов 10.10.2026, P1-8: 226 блокировок за месяц, и ни у одной
   * не было видно, чей это текст, — причину нельзя было установить).
   */
  clientId?: string | null;
  /**
   * ЯВНЫЙ ПРИЗНАК БЛОКИРОВКИ ПРОМТА (15.09.2026).
   *
   * Вызывается СИНХРОННО, один раз, ровно тогда, когда Google вернул
   * promptFeedback.blockReason (например PROHIBITED_CONTENT) — до того, как
   * функция закончит перебор и вернёт `null`. Перебор моделей/ключей в этом
   * случае бессмысленен: промт один и тот же, блокировка повторится у любой
   * модели и с любым ключом того же проекта. Колбэк, а не общее поле у модуля,
   * — чтобы сигнал не утёк между параллельными вызовами (скоринг разных
   * клиентов идёт одновременно, см. scoreAllActiveClients).
   */
  onBlocked?: (reason: string) => void;
  providerOperation?: ProviderOperation;
}): Promise<T | null> {
  params.providerOperation?.check();
  const start = Date.now();
  let ok = false;
  const spent = emptyUsage();
  let lastError: unknown;
  /** Причина блокировки промта Google, если была, — для журнала (logPromptBlocked). */
  let blockedReason: string | null = null;
  /** Модель, которая реально израсходовала токены, — в журнал вызовов идёт она, а не
   *  основная по умолчанию: иначе расход резервной модели записан чужим именем. */
  let usedModel = GEMINI_MODEL;

  try {
    // Ключи и имена моделей — одним запросом к Настройкам: они нужны одному и тому
    // же вызову в одну и ту же секунду (см. ai/geminiSettings.ts).
    const runtime = await providerRuntime(params.providerOperation);
    const apiKeys = runtime.keys;
    const chatModel = runtime.model;
    // Пока перебор не начался, «израсходовала токены» — настроенная основная модель,
    // а не константа из .env: иначе полный отказ записался бы чужим именем.
    usedModel = chatModel;
    if (apiKeys.length === 0) {
      lastError = new Error("Ключ Gemini не настроен (Настройки → AI, или GEMINI_API_KEY в .env)");
    } else {
      const rawMessages = params.messages ?? [{ role: "user" as const, content: params.user ?? "" }];
      // Тот же хвост, что и у Claude (см. ai/client.ts): разговор обязан
      // заканчиваться репликой клиента. Gemini на этом не падает, но повторять
      // историю в двух разных видах у двух поставщиков нельзя — ответы разъедутся.
      const baseMessages =
        rawMessages.length > 0 && rawMessages[rawMessages.length - 1].role === "assistant"
          ? [...rawMessages, { role: "user" as const, content: "(продолжи по задаче из системного промта)" }]
          : rawMessages;
      // Gemini называет роль ассистента "model", а не "assistant" — остальное совместимо.
      const contents = baseMessages.map((m, i) => {
        const parts: GeminiPart[] = [];
        if (params.images && i === baseMessages.length - 1 && m.role === "user") {
          for (const img of params.images) parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
        }
        if (m.content) parts.push({ text: m.content });
        return { role: m.role === "assistant" ? "model" : "user", parts };
      });

      // ЗАЧЕМ ГЛУШИТЬ «РАЗМЫШЛЕНИЕ». Оно включено по умолчанию, а его токены
      // списываются из maxOutputTokens: на нашем длинном промте модель выжигала весь
      // лимит на мысли и возвращала ПУСТОЙ ответ (finishReason=MAX_TOKENS, ни текста,
      // ни tool-call). В журнале это выглядело как «Gemini не вернул tool-call/JSON
      // (raw="")», а клиент получал заглушку «сейчас занят, оставьте номер» — 31.07
      // так оборвалось несколько живых диалогов.
      //
      // ПОЧЕМУ ПАРАМЕТР РАЗНЫЙ. У 2.5 это `thinkingBudget: 0`, у линейки 3.x —
      // `thinkingLevel` со значением "minimal" (см. ai.google.dev/gemini-api/docs/thinking,
      // таблица уровней). Имя параметра — не то, что стоит угадывать: неизвестный
      // ключ означает 400 на КАЖДЫЙ вызов, то есть ровно тот молчаливый простой, из-за
      // которого мы сюда и пришли. Поэтому при отказе с упоминанием thinking модуль
      // один раз пробует без этого блока и дальше не шлёт его вовсе, а факт пишет в
      // журнал: пусть ответы станут дороже, чем бот замолчит.
      /**
       * ЗАПАС ПОД МЫСЛИ (16.08.2026, по живым диалогам первого дня).
       *
       * «minimal» — это не ноль: в проде модель потратила 765 токенов на мысли при
       * лимите ответа 400 и вернула finishReason=MAX_TOKENS вообще без tool-call.
       * Клиент в этот момент не получил НИЧЕГО: три подряд отказа на квалификации и
       * два на разговоре после заявки, а последнее сообщение человека осталось без
       * ответа совсем.
       *
       * Мысли списываются из ТОГО ЖЕ maxOutputTokens, что и ответ, — значит запас
       * под них обязан быть заложен, ровно как у Claude (ai/client.ts: +800 к
       * бюджету, когда включены инструменты). Здесь этого не было вовсе, и короткие
       * бюджеты (400 у done-режима, 500 у квалификатора) не оставляли ответу ни
       * одного токена.
       *
       * 1500, а не 800: наблюдали 765 при «minimal», и это только один замер.
       * Потолок ничего не стоит, пока модель его не расходует, — платим за
       * сгенерированное, а не за разрешённое. Дешевле держать запас, чем молчать.
       */
      // Тело запроса собирается НА КАЖДУЮ модель отдельно (buildBody ниже), а не один
      // раз на весь вызов: у резервной модели может быть другое семейство (2.x против
      // 3.x основной), и у него своя форма generationConfig.thinkingConfig — см.
      // geminiThinkingConfig и комментарий у thinkingConfigRejected.
      // Промт целиком — для обычного пути (кэш выключен/недоступен): склейка та же,
      // что жила в ai/client.ts до появления явного кэша, побайтово.
      const fullSystem = (params.systemStable ?? "") + params.system;
      /**
       * ПОРОГ БЕЗОПАСНОСТИ (16.09.2026, по ложному PROHIBITED_CONTENT на нейтральном
       * бытовом тексте на таджикском — жалоба клиента про ошибочное списание денег в
       * такси). Без явного `safetySettings` действуют дефолтные (строгие) пороги
       * Google по всем категориям, и обычный бытовой текст иногда попадает под
       * блокировку. BLOCK_ONLY_HIGH, а не BLOCK_NONE: это внутренние потоки (скоринг,
       * генерация тренировочных вариантов), не публичный чат с клиентом, полная
       * отмена фильтра здесь избыточна — снимаем только ложные срабатывания на
       * контенте с высокой вероятностью безопасности.
       */
      const safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ];
      const buildBody = (model: string, widenTokens = 0, cacheName: string | null = null): Record<string, unknown> => {
        const thinkingHeadroom = params.schema && !thinkingConfigRejected[model] ? 1500 : 0;
        const generationConfig: Record<string, unknown> = {
          maxOutputTokens: (params.maxTokens ?? 4096) + thinkingHeadroom + widenTokens,
        };
        if (!thinkingConfigRejected[model]) generationConfig.thinkingConfig = geminiThinkingConfig(model);
        if (cacheName) {
          /**
           * ПУТЬ С ЯВНЫМ КЭШЕМ. Google запрещает systemInstruction/tools/toolConfig
           * рядом с cachedContent (400 на каждый вызов) — стабильный текст и схема
           * инструмента уже лежат ВНУТРИ кэша (см. ai/geminiCache.ts). Переменная
           * часть промта уходит служебным ходом в начало contents: единственное
           * место, куда её можно положить. Gemini принимает подряд идущие user-ходы.
           * `safetySettings` в этот запрет не входит (не привязан к содержимому
           * кэша) — передаём как обычно.
           */
          return {
            cachedContent: cacheName,
            contents: [
              {
                role: "user",
                parts: [{ text: `СЛУЖЕБНЫЙ КОНТЕКСТ ЭТОГО ХОДА (дополняет системные правила, клиенту не виден):\n${params.system}` }],
              },
              ...contents,
            ],
            generationConfig,
            safetySettings,
          };
        }
        const body: Record<string, unknown> = {
          contents,
          systemInstruction: { parts: [{ text: fullSystem }] },
          generationConfig,
          safetySettings,
        };
        if (params.schema) {
          body.tools = [
            {
              functionDeclarations: [
                {
                  name: "submit_reply",
                  description: "Отправить структурированный ответ клиенту. Всегда используй этот инструмент для ответа.",
                  parameters: params.schema,
                },
              ],
            },
          ];
          body.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_reply"] } };
        }
        return body;
      };
      /**
       * Кэш имеет смысл только для достаточно длинной стабильной части: Google не
       * принимает кэши короче 2048 токенов, а короткому промту он и не нужен.
       * 8000 символов ≈ 2000+ токенов на нашем русско-таджикском тексте — порог с
       * запасом; короче — обычный путь без единого лишнего запроса.
       */
      const wantExplicitCache =
        runtime.explicitCaching && !!params.systemStable && params.systemStable.length >= 8000;

      // Модели, которые пробуем по очереди: сперва основная, и только если она
      // исчерпала все повторы на 503/429 — резервная (если задана в .env). Ключи —
      // так же по очереди: второй (GEMINI_API_KEY_2), если задан, подключается,
      // когда первый исчерпал и модели, и повторы, — страхует от отказов конкретно
      // этого ключа/проекта (лимит, блокировка), а не только от общей перегрузки.
      // Один и тот же поставщик (Google) — владелец решил не прятать отказ за
      // Claude (см. geminiTransport.ts), но перегрузку/квоту одной модели можно
      // пережить, не показывая клиенту заглушку.
      // Дешёвая ступень идёт ПЕРЕД основной, а не вместо неё: так экономия не стоит
      // нам отказа. Если ступени нет (обычный случай), список тот же, что и был.
      const baseModels =
        params.simple && runtime.liteModel
          ? [runtime.liteModel, chatModel, ...runtime.fallbackModels]
          : [chatModel, ...runtime.fallbackModels];
      const modelsToTry = params.preferModel
        ? [params.preferModel, ...baseModels.filter((m) => m !== params.preferModel)]
        : baseModels;

      /**
       * ПОЧЕМУ МОДЕЛЬ НЕ ОТВЕТИЛА — HTTP-КОД В ЗАПИСЬ ЖУРНАЛА (22.08.2026).
       *
       * Запись «основная модель недоступна» не отличала перегрузку Google (503,
       * пройдёт сама), кончившуюся квоту (429, лечится деньгами) и закрытую модель
       * (404, лечится только правкой кода). Три разные беды выглядели одинаково, и
       * закрытая gemini-2.5-pro прожила незамеченной трое суток, переплачивая нам
       * вдвое на каждом голосовом. Причина ПЕРВОГО отказа ближе всего к настоящей:
       * дальше идут те же грабли следующим ключом.
       */
      const modelFailure = new Map<string, string>();
      const noteFailure = (model: string, reason: string): void => {
        if (!modelFailure.has(model)) modelFailure.set(model, reason);
      };
      const failureNote = (model: string): string => {
        const reason = modelFailure.get(model);
        return reason ? ` (${reason})` : "";
      };

      const deadline = Math.min(start + TOTAL_BUDGET_MS, params.providerOperation?.deadlineAt ?? Infinity);
      const outOfTime = () => {
        lastError = new Error(
          `Gemini не ответил за отведённые ${Math.round(TOTAL_BUDGET_MS / 1000)} с — перебор ключей и моделей прерван` +
            (lastError instanceof Error ? `; последняя причина: ${lastError.message}` : "")
        );
      };

      // Промт заблокирован по содержимому: остальные КЛЮЧИ того же проекта дадут
      // тот же вердикт, а остальные МОДЕЛИ — нет (свой фильтр). Поэтому флаг
      // гасит перебор ключей после того, как модели под текущим отработали.
      let promptBlocked = false;
      keys: for (const [keyIndex, apiKey] of apiKeys.entries()) {
        for (const [modelIndex, model] of modelsToTry.entries()) {
          // Модель только что лежала — не жжём на ней четыре попытки и семь секунд
          // пауз, идём сразу к следующей (см. предохранитель выше). Причину
          // записываем в modelFailure, чтобы строка «основная недоступна» не выглядела
          // так, будто модель вообще не пробовали.
          if (skipModelForNow(model, modelIndex, modelsToTry.length, keyIndex)) {
            noteFailure(model, "предохранитель: подряд 503/429, вызовы временно идут мимо неё");
            continue;
          }
          // Пока впереди есть резервная модель, эта работает по УРЕЗАННОМУ сроку:
          // остаток бюджета — не её, он занят под резерв (см. FALLBACK_RESERVE_MS).
          const phaseDeadline =
            modelIndex < modelsToTry.length - 1 ? deadline - Math.min(FALLBACK_RESERVE_MS, Math.max(0, Math.floor((deadline - start) / 2))) : deadline;
          // Расширение потолка ответа накапливается в пределах одной модели: у
          // следующей свой характер расхода, и переносить ей чужую надбавку незачем.
          let widenTokens = 0;
          const operation = params.providerOperation;
          const profileSpec = { provider: "google" as const, api: "generateContent" as const, adapter: "text" as const, model,
            profileRevision: operation?.profileRevision ?? "legacy", pricingRevision: operation?.pricingRevision,
            endpoint: params.endpoint, maxOutputTokens: (params.maxTokens ?? 4096) + (params.schema && !thinkingConfigRejected[model] ? 1500 : 0),
            features: { functions: !!params.schema, structuredReply: !!params.schema, thinking: managedThinking(model), images: !!params.images?.length } };
          operation?.assertCompatible(profileSpec);
          const cacheCompatible = !operation || (operation.supports({ ...profileSpec, features: { ...profileSpec.features, cache: true } }) &&
            operation.supports({ ...profileSpec, api: "cachedContents", adapter: "cache", maxOutputTokens: 0,
              features: { cache: true, functions: !!params.schema } }));
          /**
           * Явный кэш — ТОЛЬКО с первым ключом. Кэш живёт в проекте Google, а ключи
           * перебора могут быть из разных проектов (это и есть их смысл, см.
           * resolveGeminiKeys): ссылка на кэш чужого проекта — гарантированный отказ.
           * Резолв здесь, внутри цикла модели: у кэша в связке участвует имя модели.
           * Отказ резолва (null) просто оставляет обычный путь — как до кэша.
           */
          let cacheName =
            wantExplicitCache && cacheCompatible && keyIndex === 0
              ? await resolveGeminiCache(apiKey, {
                  model,
                  systemStable: params.systemStable as string,
                  toolSchema: params.schema,
                  providerOperation: params.providerOperation,
                })
              : null;
          for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
            // Пауза перед повтором тоже укладывается в бюджет — ждать четыре секунды,
            // когда до потолка осталась одна, значит просто отдать их впустую.
            if (attempt > 0) {
              const pause = Math.min(GEMINI_RETRY_DELAYS_MS[attempt - 1], Math.max(0, phaseDeadline - Date.now()));
              if (params.providerOperation) await params.providerOperation.sleep(pause); else await sleep(pause);
            }
            // Бюджет на весь вызов исчерпан — дальше не пробуем ни этой моделью, ни
            // следующим ключом: диалог занят ровно столько, сколько мы его держим.
            if (deadline - Date.now() <= 0) {
              outOfTime();
              break keys;
            }
            // Своё время эта модель выбрала, но общий бюджет ещё есть — он и был
            // отложен под резервную модель, к ней и переходим.
            const left = phaseDeadline - Date.now();
            if (left <= 0) break;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, left));
            let providerAttempt: ProviderAttempt | undefined;
            let attemptOutcome: Parameters<ProviderAttempt["finish"]>[0] = "error";
            const traceStarted = performance.now();
            if (params.endpoint === "lead-qualify") traceKnownSecrets([apiKey]);
            const traceAttempt = params.endpoint === "lead-qualify" ? traceModelStart(model, null) : null;
            let traceResult: Parameters<typeof traceModelFinish>[1] = "error";
            let traceRaw: unknown;
            try {
              const family = geminiModelFamily(model);
              providerAttempt = await params.providerOperation?.begin({ provider: "google", api: "generateContent", adapter: "text", model,
                profileRevision: params.providerOperation.profileRevision, pricingRevision: params.providerOperation.pricingRevision,
                features: { functions: !!params.schema, structuredReply: !!params.schema, thinking: managedThinking(model), cache: !!cacheName, images: !!params.images?.length },
                endpoint: params.endpoint, maxOutputTokens: (params.maxTokens ?? 4096) + (params.schema && !thinkingConfigRejected[model] ? 1500 : 0) + widenTokens }, Math.min(TIMEOUT_MS, left));
              params.providerOperation?.check();
              const res = await fetch(geminiGenerateUrlFor(model), {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
                body: JSON.stringify(buildBody(model, widenTokens, cacheName)),
                signal: providerAttempt?.signal ?? controller.signal,
              });
              if (!res.ok) {
                const detail = (await res.text()).slice(0, 300);
                // Отказ, связанный с кэшем (протух между резолвом и вызовом, чужой
                // проект, изменившиеся правила Google), — снимаем кэш ДЛЯ ЭТОГО вызова
                // и пробуем обычным телом: клиент не должен платить ответом за нашу
                // оптимизацию. Свою запись чистим, чтобы следующий ход пересоздал кэш.
                if (cacheName && (res.status === 400 || res.status === 403 || res.status === 404) && /cach/i.test(detail)) {
                  void prisma.geminiCache.deleteMany({ where: { name: cacheName } }).catch(() => null);
                  cacheName = null;
                  lastError = new Error(`Gemini отверг cachedContent (${model}): ${detail}`);
                  continue;
                }
                // Отказ именно из-за формы thinkingConfig — снимаем его навсегда для ЭТОГО
                // семейства моделей и даём циклу повторить попытку уже без него (иначе
                // первый же ход клиента ушёл бы в отказ на пустом месте). Другое семейство
                // (например основная 3.x модель, когда отказала резервная 2.x) этот отказ
                // не трогает — см. комментарий у thinkingConfigRejected.
                if (res.status === 400 && /thinking/i.test(detail) && !thinkingConfigRejected[model]) {
                  thinkingConfigRejected[model] = true;
                  void logSystemError(
                    "ai",
                    `Gemini (${model}, семейство ${family}) отверг thinkingConfig, дальше шлём без него для этой ` +
                      `модели (ответы дороже, но бот отвечает): ${detail}`
                  );
                }
                // Ключ отклонён — сказать об этом вслух до того, как перебор молча
                // вытянет запрос на резервном (см. reportRejectedKey).
                if (res.status === 401 || res.status === 403) {
                  reportRejectedKey(apiKey, keyIndex, apiKeys.length, res.status, detail);
                }
                // Такого имени модели у Google нет — сказать вслух до того, как перебор
                // молча вытянет ход резервной моделью (см. reportUnknownModel).
                if (res.status === 404) reportUnknownModel(model, model === chatModel, detail);
                // Перегрузка/квота — в счёт предохранителя и часовой тревоги.
                noteGeminiModelFailure(model, res.status, model === chatModel, keyIndex);
                lastError = new Error(`Gemini HTTP ${res.status} (${model}): ${detail}`);
                // Причина отказа ЭТОЙ модели — чтобы запись «основная недоступна» ниже
                // называла HTTP-код, а не оставляла гадать (см. modelFailure).
                noteFailure(model, `HTTP ${res.status}: ${detail.replace(/\s+/g, " ").slice(0, 160)}`);
                // Не тот статус — ждать и повторять бессмысленно (400/401/404 не
                // исчезнут от паузы), но модель или ключ могут быть ни при чём
                // (400 из-за thinkingConfig — как раз про конкретную модель, а 401 —
                // про конкретный ключ) — переходим к следующей комбинации, не сдаёмся сразу.
                if (!isRetryableGeminiStatus(res.status)) break;
                continue;
              }
              // HTTP 200 — модель жива, предохранитель снимается сразу. Пустой ответ или
              // битый вызов инструмента (MALFORMED_FUNCTION_CALL/MAX_TOKENS ниже) — это
              // про содержание ответа, а не про доступность модели: их повтор той же
              // моделью сделан намеренно и предохранителя не касается.
              noteGeminiModelSuccess(model, keyIndex);
              const data = (await res.json()) as {
                candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
                promptFeedback?: { blockReason?: string };
                usageMetadata?: {
                  promptTokenCount?: number;
                  candidatesTokenCount?: number;
                  thoughtsTokenCount?: number;
                  cachedContentTokenCount?: number;
                };
              };
              providerAttempt?.reportUsage(data.usageMetadata);
              providerAttempt?.check();
              // У 2.5 неявное кэширование префикса включено по умолчанию, и скидка
              // начисляется сама — но в журнале её не было видно вовсе. Без этой цифры
              // вопрос «нужен ли нам явный кэш» решался бы рассуждениями, а не своими
              // же данными.
              //
              // ВЫЧИТАЕМ из inputTokens: promptTokenCount у Gemini включает кэшированные
              // токены целиком, и без вычитания они посчитались бы дважды — сначала как
              // обычный вход, потом как чтение кэша. Расход в отчёте вырос бы на пустом
              // месте. Max(0) — на случай, если поставщик однажды начнёт считать иначе:
              // отрицательный расход в отчёте хуже неточного.
              /**
               * ОТВЕТИЛА НЕ ОСНОВНАЯ МОДЕЛЬ — СКАЗАТЬ ВСЛУХ (16.08.2026).
               *
               * Резерв обязан спасать, но не обязан молчать. Ровно так уже вышло с
               * ключами: перебор молча вытягивал запрос на резервном, и мёртвый
               * основной жил незамеченным (см. reportRejectedKey). С моделью цена
               * ошибки та же: 404 закрытой модели прожил два месяца, потому что
               * снаружи всё «работало». Одна запись в «Здоровье системы» превращает
               * скрытый отказ в задачу, которую видно утром.
               *
               * Пишем ОДИН раз на вызов и только при успехе: журнал, куда сыплется
               * строка на каждый ход, перестают читать, а это ровно то, что мы
               * пытаемся предотвратить.
               */
              // Дешёвая ступень — это НЕ отказ основной модели, а штатный порядок:
              // жаловаться на неё в «Здоровье системы» значит будить директора утром
              // тем, что владелец сам и включил.
              //
              // ПИШЕМ ТОЛЬКО ПРИ НАСТОЯЩЕМ ОТВЕТЕ (аудит ботов 10.10.2026, P1-9). Раньше
              // запись стояла здесь, на любом HTTP 200 — ДО проверки blockReason и разбора
              // ответа: блокировка промта на основной → попытка на резервной → 200 с той
              // же блокировкой → «работаем на запасной». 233 такие записи за месяц, а
              // резерв реально ответил ~25 раз. Теперь — только когда ответ разобран.
              const noteFallbackAnswered = (): void => {
                if (model !== chatModel && model !== runtime.liteModel && model !== params.preferModel) {
                  void logSystemError(
                    "ai",
                    `Gemini ответил на РЕЗЕРВНОЙ модели ${model} — основная ${chatModel} ` +
                      `недоступна${failureNote(chatModel)}. Пока так, бот работает, но на запасном пути.`
                  );
                }
              };
              usedModel = model;
              const cached = data.usageMetadata?.cachedContentTokenCount ?? 0;
              traceModelCache(traceAttempt, data.usageMetadata ? cached > 0 : null);
              spent.inputTokens += Math.max(0, (data.usageMetadata?.promptTokenCount ?? 0) - cached);
              spent.cacheReadTokens += cached;
              spent.outputTokens += data.usageMetadata?.candidatesTokenCount ?? 0;
              const parts = data.candidates?.[0]?.content?.parts ?? [];
              const fnCall = parts.find((p) => p.functionCall)?.functionCall;
              if (fnCall) {
                traceRaw = fnCall.args;
                const calls = parts.filter((part) => part.functionCall);
                traceResult = calls.length !== 1 ? "multiple_calls" : fnCall.name !== "submit_reply" ? "wrong_tool" : "parsed";
                if (calls.length !== 1 || fnCall.name !== "submit_reply") {
                  throw new Error("Gemini returned an unexpected structured response tool");
                }
                ok = true;
                attemptOutcome = "success";
                noteFallbackAnswered();
                return fnCall.args as T;
              }
              const text = parts.map((p) => p.text ?? "").join("");
              const parsed = text ? extractJson<T>(text) : null;
              if (parsed !== null) {
                traceRaw = parsed;
                traceResult = "parsed";
                ok = true;
                attemptOutcome = "success";
                noteFallbackAnswered();
                return parsed;
              }
              // finishReason и счётчик «мыслей» — в текст ошибки: без них пустой ответ
              // выглядел загадкой (raw=""), хотя причина всегда написана прямо в ответе.
              const finish = data.candidates?.[0]?.finishReason ?? "нет";
              const thoughts = data.usageMetadata?.thoughtsTokenCount ?? 0;
              // Без candidates[0] вовсе (finishReason=нет) код раньше не мог отличить
              // «Google заблокировал промт» от «пришёл пустой мусор» — раскрытие ответа
              // не включало promptFeedback (найдено 25.08.2026 по журналу card-fill/
              // score-client: два пустых ответа резервной модели за один вечер, оба
              // finishReason=нет, мыслей=0, raw=""). blockReason тут — прямая причина.
              const blockReason = data.promptFeedback?.blockReason;
              /**
               * BLOCKREASON — СРАЗУ СТОП, БЕЗ ПЕРЕБОРА (15.09.2026).
               *
               * Блокировка (например PROHIBITED_CONTENT) — решение Google по
               * СОДЕРЖИМОМУ промта, а не по модели или ключу: следующая модель и
               * следующий ключ того же проекта увидят тот же промт и получат тот
               * же blockReason. ЗАПАСНАЯ МОДЕЛЬ — ИСКЛЮЧЕНИЕ: у неё свой фильтр,
               * одна попытка на ней осмысленна, и это закреплено тестом
               * gemini-fallback-budget («ровно одна попытка на модель»). Поэтому
               * блокировка гасит ПЕРЕБОР КЛЮЧЕЙ (они одного проекта — тот же
               * вердикт), но оставшиеся модели под текущим ключом пробуются.
               * `onBlocked` — явный сигнал вызывающему коду (ai/client.ts →
               * ai/scoring.ts): он вправе мягко деградировать (безопасный
               * дефолт/пропуск), а не считать это отказом поставщика.
               */
              if (blockReason) {
                attemptOutcome = "blocked";
                traceResult = "blocked";
                params.onBlocked?.(blockReason);
                lastError = new Error(`Gemini заблокировал промт (${model}): blockReason=${blockReason}`);
                promptBlocked = true;
                blockedReason = blockReason;
                break;
              }
              lastError = new Error(
                `Gemini не вернул tool-call/JSON (${model}, finishReason=${finish}, мыслей=${thoughts}, ` +
                  `raw="${text.slice(0, 300).replace(/\n/g, "\\n")}")`
              );
              traceResult = "empty";
              attemptOutcome = "invalid";
              /**
               * ПОВТОР ПРИ MALFORMED_FUNCTION_CALL / MAX_TOKENS (16.08.2026, по журналу
               * ошибок первого дня). До этой правки ЛЮБОЙ ответ с HTTP 200, но без
               * tool-call/JSON, обрывал попытки этой моделью НАВСЕГДА — код сразу уходил
               * к резервной модели (а без неё в .env — к отказу), хотя бюджет ретраев
               * (GEMINI_RETRY_DELAYS_MS) для основной модели был выделен и просто не
               * использовался.
               *
               * Два finishReason стоит повторить: MALFORMED_FUNCTION_CALL — модель
               * иногда собирает битый вызов инструмента и на следующей попытке отвечает
               * нормально (вероятностный сбой, не системный); MAX_TOKENS — при коротких
               * бюджетах (400–500 у qualify/done-режимов) даже с запасом под «мысли»
               * модель может выжечь лимит не всегда, и повтор — тот же случай.
               * Остальные причины (SAFETY, RECITATION, OTHER) от повтора не изменятся —
               * там `break` как раньше, чтобы не жечь бюджет времени впустую.
               */
              if (finish === "MALFORMED_FUNCTION_CALL" || finish === "MAX_TOKENS") {
                // Повторяем НЕ тем же самым запросом: обе причины означают «не хватило
                // места дописать», и второй запрос с тем же потолком упрётся в него же.
                // Растёт только число токенов — состав промта, схема инструмента и
                // обязательные правила остаются ровно теми же (менять их на повторе
                // значило бы отвечать клиенту по другим правилам, чем с первой попытки).
                widenTokens = Math.min(widenTokens + WIDEN_STEP_TOKENS, WIDEN_MAX_TOKENS);
                continue;
              }
              /**
               * ПОВТОР ПРИ ПУСТОМ candidates БЕЗ БЛОКИРОВКИ (25.08.2026, по журналу
               * ошибок: card-fill и score-client отказали два раза за вечер ровно так).
               *
               * finishReason=нет значит, что candidates[0] не пришёл вовсе — не «модель
               * ответила пусто», а «Google не вернул кандидата». Если это явная блокировка
               * промта (blockReason есть), повтор не поможет: промт тот же, ответ будет
               * тем же — уходим на `break`, как раньше. Но без blockReason это неотличимо
               * от разового сетевого/серверного сбоя (пустой ответ без причины), и раньше
               * такой случай сразу обрывал попытки этой моделью — ровно на нём резервная
               * модель отказала без единого повтора, хотя бюджет ретраев для неё был.
               * Токены не расширяем — дело не в лимите, это MALFORMED_FUNCTION_CALL/
               * MAX_TOKENS уже покрывают.
               */
              if (finish === "нет" && !blockReason && !data.candidates?.length) {
                continue;
              }
              break;
            } catch (err) {
              if (isProviderOperationError(err)) throw err;
              lastError = err;
              // Таймаут/сетевой сбой — тоже стоит повторить, они не отличаются от 503
              // по сути («сейчас не получилось»), просто без HTTP-статуса.
              noteFailure(model, err instanceof Error ? err.message.slice(0, 160) : "сетевой отказ");
            } finally {
              traceModelFinish(traceAttempt, traceResult, traceStarted, traceRaw);
              clearTimeout(timeout);
              await providerAttempt?.finish(attemptOutcome);
            }
          }
        }
        // Модели под этим ключом отработали; блокировка промта — вердикт по
        // содержимому, остальные ключи того же проекта повторят его дословно.
        if (promptBlocked) break keys;
      }
    }
    console.error(`[ai:${params.endpoint}:gemini]`, lastError instanceof Error ? lastError.message : lastError);
    if (blockedReason) {
      logPromptBlocked(params.endpoint, blockedReason, params.conversationId, params.clientId);
      return null;
    }
    void logSystemError(
      "ai",
      `Gemini не ответил (${params.endpoint}): ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
    return null;
  } finally {
    // Стоимость останется null: Gemini тарифицируется у другого поставщика и в
    // нашей таблице цен его нет. Ноль вместо null читался бы как «бесплатно».
    if (!params.providerOperation) await logAiCall({
      endpoint: `${params.endpoint}:gemini`,
      model: usedModel,
      spent,
      ms: Date.now() - start,
      ok,
      conversationId: params.conversationId,
    });
  }
}

/**
 * Один ход диалога С ИНСТРУМЕНТАМИ: модель либо отвечает текстом, либо просит
 * вызвать функции CRM, и тогда ход повторяется с их результатами.
 *
 * Отдельно от callGemini, потому что задача другая. callGemini — это «дай мне JSON
 * по схеме», один выстрел; здесь же нужен цикл: спросили → модель попросила данные →
 * сходили в базу → отдали результат → модель ответила. Пытаться обслужить оба случая
 * одной функцией значило бы завести в ней флаг режима, а следом две ветки, которые
 * расходятся при первой же правке.
 *
 * Формат вызова функций у Gemini отличается от Anthropic: инструмент описывается
 * ключом `parameters` (а не input_schema), ответ инструмента возвращается частью
 * `functionResponse` в реплике роли "user". Перевод между двумя формами живёт здесь,
 * чтобы вызывающий (ai/assistant.ts) не знал ни про одного поставщика.
 */
export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface GeminiToolTurn {
  /** Текст ответа, если модель закончила. Пусто, когда она просит инструменты. */
  text: string;
  /** Что модель просит вызвать. Пусто, когда она ответила текстом. */
  calls: GeminiToolCall[];
  /** Реплика модели целиком — её обязательно вернуть в историю следующего хода,
   *  иначе модель не увидит собственной просьбы и запросит инструменты заново. */
  modelParts: GeminiPart[];
  tokens: number;
}

type ManagedToolTurnStopCause = "model_prompt_blocked" | "model_candidate_missing" | "model_output_incomplete" |
  "model_function_call_malformed" | "model_output_blocked" | "model_finish_not_stop";
class ManagedToolTurnStopError extends Error {
  constructor(cause: ManagedToolTurnStopCause) { super(cause); this.name = "ManagedToolTurnStopError"; }
}
const blockedToolFinishReasons = new Set([
  "SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_OTHER", "ESCALATION", "PUP_LIMITED_DISABLED",
]);
const malformedToolFinishReasons = new Set([
  "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MISSING_THOUGHT_SIGNATURE", "MALFORMED_RESPONSE", "TOO_MANY_TOOL_CALLS",
]);

export interface GeminiToolDefinition {
  name: string;
  description: string;
  /** Отсутствует у функции без аргументов: пустую схему объекта Gemini отвергает
   *  с 400 «properties: should be non-empty for OBJECT type». */
  parameters?: Record<string, unknown>;
}

/** Тело запроса с инструментами — одно на обычный и потоковый вызов. */
function toolsRequestBody(
  params: { system: string; contents: unknown; requiredFunctionName?: string; maxTokens?: number; model: string },
  declarations: unknown,
  counted: { thinkingLevel: unknown } | undefined,
): Record<string, unknown> {
  return {
    contents: params.contents,
    systemInstruction: { parts: [{ text: params.system }] },
    tools: [{ functionDeclarations: declarations }],
    ...(params.requiredFunctionName ? { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [params.requiredFunctionName] } } } : {}),
    generationConfig: {
      maxOutputTokens: params.maxTokens ?? 1500,
      // Та же глушилка «размышления», что в callGemini, и по той же причине: мысли
      // списываются из maxOutputTokens и способны выжечь весь лимит до ответа. Форма
      // параметра — по семейству модели (см. geminiThinkingConfig).
      ...(counted ? { thinkingConfig: { thinkingLevel: counted.thinkingLevel } }
        : thinkingConfigRejected[params.model] ? {} : { thinkingConfig: geminiThinkingConfig(params.model) }),
    },
  };
}

/**
 * Отказ Google по HTTP на пути инструментов — запись в журнал и ошибка со статусом.
 * Одна реализация на обычный и потоковый вызов (у потокового managed не бывает).
 */
async function toolsHttpError(res: Response, model: string, managedFailure: boolean): Promise<Error> {
  // Managed: тело читаем только ради безопасных полей (status/code/reason/field);
  // сырой текст и error.message наружу не уходят. Сбой чтения — просто без деталей.
  const managedSummary = managedFailure ? await readManagedGeminiErrorSummary(res) : "";
  const rawDetail = managedFailure ? "" : (await res.text()).slice(0, 300);
  // Bound/managed failures may echo prompt, tool args or credentials. Keep
  // legacy diagnostics unchanged, but never export their raw body here.
  const detail = managedFailure ? "managed_provider_http_error" : rawDetail;
  const logDetail = managedFailure && managedSummary ? `${detail} (${managedSummary})` : detail;
  if (!managedFailure && res.status === 400 && /thinking/i.test(rawDetail) && !thinkingConfigRejected[model]) {
    thinkingConfigRejected[model] = true;
    void logSystemError(
      "ai",
      `Gemini (${model}, семейство ${geminiModelFamily(model)}) отверг thinkingConfig в вызове с инструментами: ${detail}`
    );
  }
  // В журнал CRM, а не только в исключение: слепота к отказам поставщика — это
  // ровно то, из-за чего 404 Gemini прожил два месяца незамеченным.
  void logSystemError("ai", `Gemini не ответил (ассистент, ${model}): HTTP ${res.status}: ${logDetail}`);
  const err = new Error(`Gemini HTTP ${res.status}: ${detail}`);
  (err as Error & { status?: number }).status = res.status;
  return err;
}

/** Просьбы модели об инструментах из частей реплики. */
function toolCallsOf(modelParts: GeminiPart[]): GeminiToolCall[] {
  return modelParts
    .filter((p) => p.functionCall)
    .map((p) => ({
      name: p.functionCall!.name,
      args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      ...(typeof p.functionCall!.id === "string" ? { id: p.functionCall!.id } : {}),
    }));
}

/** Пустой ответ и ответ резервной модели — в журнал, одинаково для обоих путей. */
function reportToolTurnOddities(turn: {
  text: string;
  calls: GeminiToolCall[];
  finishReason: string | undefined;
  blockReason: string | undefined;
  thoughts: number | undefined;
  model: string;
  primaryModel: string;
}): void {
  // Ни текста, ни просьбы об инструментах — причина всегда написана в ответе, и без
  // неё пустота выглядит загадкой. Ровно так 31.07 выглядело выжигание лимита
  // «размышлением»: finishReason=MAX_TOKENS при пустом содержимом.
  if (!turn.text && turn.calls.length === 0) {
    void logSystemError(
      "ai",
      `Gemini вернул пустой ответ (ассистент): finishReason=${turn.finishReason ?? "нет"}${
        turn.blockReason ? `, blockReason=${turn.blockReason}` : ""
      }, мыслей=${turn.thoughts ?? 0}`
    );
  }
  if (turn.model !== turn.primaryModel) {
    void logSystemError(
      "ai",
      `Ассистент ответил на РЕЗЕРВНОЙ модели ${turn.model} — основная ${turn.primaryModel} недоступна.`
    );
  }
}

async function callGeminiToolsOnce(params: {
  apiKey: string;
  system: string;
  contents: { role: "user" | "model"; parts: GeminiPart[] }[];
  tools: GeminiToolDefinition[];
  /** Qualified media extraction only; main customer decisions keep AUTO. */
  requiredFunctionName?: string;
  maxTokens?: number;
  timeoutMs?: number;
  model: string;
  /** Какая модель считается основной СЕЙЧАС — берётся из Настроек вызывающим, чтобы
   *  запись «ответил на резервной» сравнивала с настроенной, а не с константой .env. */
  primaryModel: string;
  providerOperation?: ProviderOperation;
  /** Внешняя отмена (помощник CRM): прерывает запрос к Google на лету. */
  signal?: AbortSignal;
}): Promise<GeminiToolTurn> {
  throwIfAborted(params.signal);
  const countContext = params.providerOperation ? boundGeminiCountContext(params.providerOperation) : null;
  const mediaFeatures = params.providerOperation?.managed && countContext?.usageProtocol === GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL
    ? managedGeminiMediaFeatures(params.contents.flatMap(content => content.parts))
    : { images: params.providerOperation?.managed ? managedPartsHaveImages(params.contents.flatMap(content => content.parts)) : false };
  const declarations = countContext?.policy.functionDeclarationProtocol === GEMINI_FUNCTION_DECLARATION_PROTOCOL
    ? managedGeminiFunctionDeclarations(params.tools) : params.tools;
  if (params.requiredFunctionName && (countContext?.usageProtocol !== GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL ||
      params.tools.length !== 1 || params.tools[0].name !== params.requiredFunctionName)) throw new ProviderOperationError("unsupported");
  const body = toolsRequestBody(params, declarations, countContext ? { thinkingLevel: countContext.policy.thinkingLevel } : undefined);
  // Only explicitly counted profiles use this immutable snapshot. Legacy wire
  // keeps its old serialization/settings behavior. No model/body field binds it.
  const target = countContext?.selectTarget(params.model, params.apiKey);
  if (countContext && !target) throw new ProviderOperationError("unsupported");
  const counted = target ? { model: target.model, serializedBody: JSON.stringify(body),
    generateUrl: target.generateUrl, headers: target.headers } : null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 60_000);
  const unlinkAbort = linkAbort(controller, params.signal);
  let providerAttempt: ProviderAttempt | undefined;
  let attemptOutcome: Parameters<ProviderAttempt["finish"]>[0] = "error";
  let traceAttempt: number | null = null, traceStarted = 0;
  let traceResult: Parameters<typeof traceModelFinish>[1] = "error";
  try {
    providerAttempt = await params.providerOperation?.begin({ provider: "google", api: "generateContent", adapter: "tools", model: params.model,
      profileRevision: params.providerOperation.profileRevision, pricingRevision: params.providerOperation.pricingRevision,
      features: { functions: true, thinking: countContext ? "level" : managedThinking(params.model), ...mediaFeatures },
      endpoint: "assistant-tools", maxOutputTokens: params.maxTokens ?? 1500 }, params.timeoutMs ?? 60_000);
    params.providerOperation?.check();
    let countedBody: string | undefined;
    if (counted) {
      if (!params.providerOperation || !providerAttempt) throw new ProviderOperationError("unsupported");
      attemptOutcome = "unknown"; // Count metadata is NOT generation usage/refund.
      const request = { ...counted, operation: params.providerOperation, attempt: providerAttempt };
      const witness = await countGeminiToolsRequest(request);
      countedBody = consumeGeminiToolsCount(witness, request);
    }
    // Count/reservation failure is NOT a physical generation attempt. Record
    // only after exact body/count witness passes, immediately before fetch.
    traceStarted = performance.now();
    traceAttempt = traceModelStart(params.model, null, "assistant-tools");
    const res = await fetch(counted?.generateUrl ?? geminiGenerateUrlFor(params.model), {
      method: "POST",
      headers: counted?.headers ?? { "Content-Type": "application/json", "x-goog-api-key": params.apiKey, ...geminiProxyHeaders() },
      body: countedBody ?? JSON.stringify(body),
      signal: providerAttempt?.signal ?? controller.signal,
      ...(counted ? { redirect: "error" as const } : {}),
    });
    if (!res.ok) {
      traceResult = res.status >= 400 && res.status < 500 && res.status !== 429 ? "blocked" : "error";
      throw await toolsHttpError(res, params.model, params.providerOperation?.managed === true);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    const traceCache = data.usageMetadata ? Reflect.get(data.usageMetadata, "cachedContentTokenCount") : undefined;
    traceModelCache(traceAttempt, typeof traceCache === "number" && Number.isFinite(traceCache) && traceCache >= 0 ? traceCache > 0 : null);
    providerAttempt?.reportUsage(data.usageMetadata);
    providerAttempt?.check();
    const candidate = data.candidates?.[0];
    if (params.providerOperation?.managed) {
      let stopCause: ManagedToolTurnStopCause | undefined;
      if (data.promptFeedback?.blockReason) stopCause = "model_prompt_blocked";
      else if (!candidate) stopCause = "model_candidate_missing";
      else if (!candidate.finishReason || candidate.finishReason === "MAX_TOKENS" || candidate.finishReason === "CONTINUATION") {
        // Empty finishReason means generation did not finish. MAX_TOKENS and
        // CONTINUATION are explicitly incomplete; their parts never reach tool execution.
        stopCause = "model_output_incomplete";
      } else if (candidate.finishReason !== "STOP") {
        stopCause = malformedToolFinishReasons.has(candidate.finishReason) ? "model_function_call_malformed"
          : blockedToolFinishReasons.has(candidate.finishReason) ? "model_output_blocked" : "model_finish_not_stop";
      }
      if (stopCause) {
        const blocked = stopCause === "model_prompt_blocked" || stopCause === "model_output_blocked";
        attemptOutcome = blocked ? "blocked" : "invalid";
        traceResult = blocked ? "blocked" : candidate ? "invalid" : "empty";
        // A valid-looking partial functionCall is still not an authorized
        // completed model turn. The stop code is closed/safe; provider payload
        // and finish-reason strings never become diagnostic text.
        throw new ManagedToolTurnStopError(stopCause);
      }
    }
    const modelParts = candidate?.content?.parts ?? [];
    const calls = toolCallsOf(modelParts);
    const text = modelParts
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    reportToolTurnOddities({
      text,
      calls,
      finishReason: data.candidates?.[0]?.finishReason,
      blockReason: data.promptFeedback?.blockReason,
      thoughts: data.usageMetadata?.thoughtsTokenCount,
      model: params.model,
      primaryModel: params.primaryModel,
    });
    attemptOutcome = data.promptFeedback?.blockReason ? "blocked" : !text && calls.length === 0 ? "invalid" : "success";
    // JSON/provider return is not customer decision-schema validation. The
    // coordinator records validated decision kind separately after Core.
    traceResult = data.promptFeedback?.blockReason ? "blocked" : !text && calls.length === 0 ? "empty" : "returned";
    return {
      text,
      calls,
      modelParts,
      tokens: (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0),
    };
  } finally {
    traceModelFinish(traceAttempt, traceResult, traceStarted); // NEVER raw provider/tool payload
    clearTimeout(timeout);
    unlinkAbort();
    await providerAttempt?.finish(attemptOutcome);
  }
}

/**
 * ФОЛЛБЕК НА РЕЗЕРВНУЮ МОДЕЛЬ (18.08.2026).
 *
 * У обычных ответов бота (callGemini) переход на GEMINI_FALLBACK_MODELS при отказе
 * основной модели есть с 16.08 — именно после дня, когда основная модель не отвечала
 * ВООБЩЕ. У этого пути (вызовы инструментов CRM — ассистент) фоллбека не было: одна
 * модель, одна попытка, при 429/503/таймауте сразу throw. В такой же день ассистент
 * отказывал бы на каждом ходу без единого шанса ответить с резервной модели — той
 * самой, что в тот день прекрасно работала для обычных реплик бота.
 */
/**
 * Безопасная сводка отказа Google для managed-пути: ТОЛЬКО error.status, error.code,
 * error.details[].reason и error.details[].fieldViolations[].field, и то после проверки
 * формата. error.message/description и любые значения (там бывает эхо промта, телефонов,
 * аргументов инструментов) не берутся никогда. Битый JSON — пустая строка.
 */
export function summarizeManagedGeminiError(text: string): string {
  try {
    const error = (JSON.parse(text) as { error?: unknown } | null)?.error as
      | { status?: unknown; code?: unknown; details?: unknown }
      | undefined;
    if (!error || typeof error !== "object") return "";
    const parts: string[] = [];
    if (typeof error.status === "string" && /^[A-Z_]{1,40}$/.test(error.status)) parts.push(`status=${error.status}`);
    if (typeof error.code === "number" && Number.isInteger(error.code)) parts.push(`code=${error.code}`);
    const reasons = new Set<string>();
    const fields = new Set<string>();
    if (Array.isArray(error.details)) {
      for (const d of error.details.slice(0, 10) as Record<string, unknown>[]) {
        if (!d || typeof d !== "object") continue;
        if (typeof d.reason === "string" && /^[A-Za-z0-9_]{1,60}$/.test(d.reason)) reasons.add(d.reason);
        if (Array.isArray(d.fieldViolations)) {
          for (const v of d.fieldViolations.slice(0, 10) as Record<string, unknown>[]) {
            if (v && typeof v.field === "string" && /^[\w.[\]]{1,80}$/.test(v.field)) fields.add(v.field);
          }
        }
      }
    }
    if (reasons.size) parts.push(`reason=${[...reasons].slice(0, 5).join(",")}`);
    if (fields.size) parts.push(`field=${[...fields].slice(0, 5).join(",")}`);
    return parts.join(" ");
  } catch {
    return "";
  }
}

async function readManagedGeminiErrorSummary(res: Response): Promise<string> {
  try {
    return summarizeManagedGeminiError((await res.text()).slice(0, 16_000));
  } catch {
    return "";
  }
}

export async function callGeminiTools(params: {
  apiKey: string;
  system: string;
  contents: { role: "user" | "model"; parts: GeminiPart[] }[];
  tools: GeminiToolDefinition[];
  requiredFunctionName?: string;
  maxTokens?: number;
  /** Потолок ОДНОЙ попытки. На непривязанном пути дополнительно режется сроком. */
  timeoutMs?: number;
  providerOperation?: ProviderOperation;
  /** Внешняя отмена (помощник CRM: клиент закрыл соединение, истёк срок диалога).
   *  Только для непривязанного пути — у providerOperation своя отмена. */
  signal?: AbortSignal;
  /** Абсолютный срок по часам Date.now(): позже него не начинаются ни попытка, ни
   *  пауза. Без него — прежний общий потолок TOTAL_BUDGET_MS. */
  deadlineAt?: number;
  /** Уже прочитанные ключи и модели (кэш помощника, ai/assistant/runtime.ts) —
   *  без чтения Settings на каждом раунде. С providerOperation не используется:
   *  там runtime привязан к операции. */
  runtime?: GeminiRuntime;
}): Promise<GeminiToolTurn> {
  params.providerOperation?.check();
  throwIfAborted(params.signal);
  const runtime =
    params.runtime && !params.providerOperation ? params.runtime : await providerRuntime(params.providerOperation);
  assertBoundRuntimeKey(params.providerOperation, runtime, params.apiKey);
  const modelsToTry = [runtime.model, ...runtime.fallbackModels];
  if (!params.providerOperation) return callGeminiToolsWithRetries(params, runtime, modelsToTry);
  let lastErr: unknown;
  for (const [modelIndex, model] of modelsToTry.entries()) {
    // Тот же предохранитель, что и у обычных ответов бота, и состояние у них общее:
    // модель, которая только что легла для диалогов, лежит и для ассистента.
    if (skipModelForNow(model, modelIndex, modelsToTry.length)) continue;
    try {
      const turn = await callGeminiToolsOnce({ ...params, model, primaryModel: runtime.model });
      noteGeminiModelSuccess(model);
      return turn;
    } catch (err) {
      if (isProviderOperationError(err)) throw err;
      if (err instanceof ManagedToolTurnStopError) throw err;
      lastErr = err;
      const status = (err as Error & { status?: number })?.status;
      if (status != null) {
        if (status === 404) {
          reportUnknownModel(model, model === runtime.model, (err as Error).message.slice(0, 300));
        }
        noteGeminiModelFailure(model, status, model === runtime.model);
      }
      // 404 — снята/опечатана ИМЕННО ЭТА модель, а не запрос: следующая в списке
      // может быть жива, и callGemini с callGeminiGrounded идут к ней (CHANNEL-NEW-05).
      if (status === 404) continue;
      // Не тот статус — следующая модель тоже не поможет (400 — про сам запрос,
      // не про перегрузку конкретной модели): не тратим время на весь список.
      if (status != null && !isRetryableGeminiStatus(status)) throw err;
    }
  }
  throw lastErr;
}

/**
 * ПОВТОРЫ И РЕЗЕРВНАЯ МОДЕЛЬ НА ПУТИ ИНСТРУМЕНТОВ (31.10.2026, пачка П1 задача 1.2
 * помощника CRM, docs/design/internal-assistant-architecture-2026-10-31.md §1.2 №5).
 *
 * До этого непривязанный путь (помощник CRM) делал ОДНУ попытку на модель и без
 * пауз: первый же 429/503/таймаут у основной модели при пустом
 * GEMINI_FALLBACK_MODEL означал отказ всего ответа, хотя классификатор рядом в том
 * же запросе делал четыре попытки. Теперь политика та же, что у callGemini:
 *  - на модель до ATTEMPTS_PER_MODEL попыток с паузами GEMINI_RETRY_DELAYS_MS, но
 *    только на повторяемых отказах (429/5xx, сеть, таймаут попытки);
 *  - 404 — эта модель снята, сразу к следующей; прочие 4xx — сам запрос неверен,
 *    сразу наверх (следующая модель не поможет);
 *  - пока впереди есть резервная модель, основная работает в урезанном окне
 *    (FALLBACK_RESERVE_MS), чтобы зависшая основная не съела время резервной;
 *  - ВСЁ укладывается в срок: min(deadlineAt, TOTAL_BUDGET_MS) — пауза не длиннее
 *    остатка, попытка не длиннее остатка, после срока новых попыток нет.
 * Внешняя отмена (signal) прерывает и попытку, и паузу и пробрасывается как есть.
 *
 * Привязанный путь (providerOperation — клиентский агент) сюда не ходит: у него
 * свой учёт попыток и денег, и менять его этой пачкой нельзя.
 */
/** Параметры одной попытки на пути инструментов (обычной или потоковой). */
type ToolsAttemptParams = Parameters<typeof callGeminiToolsOnce>[0];

async function callGeminiToolsWithRetries(
  params: Parameters<typeof callGeminiTools>[0],
  runtime: GeminiRuntime,
  modelsToTry: string[],
  /** Одна попытка: обычный generateContent или поток (callGeminiToolsStream). */
  attemptOnce: (attempt: ToolsAttemptParams) => Promise<GeminiToolTurn> = callGeminiToolsOnce,
): Promise<GeminiToolTurn> {
  const start = Date.now();
  const deadline = Math.min(start + TOTAL_BUDGET_MS, params.deadlineAt ?? Infinity);
  const attemptCap = params.timeoutMs ?? 60_000;
  let lastErr: unknown;
  for (const [modelIndex, model] of modelsToTry.entries()) {
    // Тот же предохранитель, что и у обычных ответов бота, и состояние у них общее:
    // модель, которая только что легла для диалогов, лежит и для ассистента.
    if (skipModelForNow(model, modelIndex, modelsToTry.length)) continue;
    const phaseDeadline =
      modelIndex < modelsToTry.length - 1
        ? deadline - Math.min(FALLBACK_RESERVE_MS, Math.max(0, Math.floor((deadline - start) / 2)))
        : deadline;
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      if (attempt > 0) {
        await sleepUnlessAborted(
          Math.min(GEMINI_RETRY_DELAYS_MS[attempt - 1], Math.max(0, phaseDeadline - Date.now())),
          params.signal,
        );
      }
      throwIfAborted(params.signal);
      const left = phaseDeadline - Date.now();
      if (left <= 0) break;
      try {
        const turn = await attemptOnce({
          apiKey: params.apiKey,
          system: params.system,
          contents: params.contents,
          tools: params.tools,
          requiredFunctionName: params.requiredFunctionName,
          maxTokens: params.maxTokens,
          timeoutMs: Math.min(attemptCap, left),
          model,
          primaryModel: runtime.model,
          signal: params.signal,
        });
        noteGeminiModelSuccess(model);
        return turn;
      } catch (err) {
        // Отмена снаружи — не отказ модели: не повторяем и не считаем в предохранитель.
        if (params.signal?.aborted) throw abortReason(params.signal);
        if (isProviderOperationError(err)) throw err;
        if (err instanceof ManagedToolTurnStopError) throw err;
        // Поток оборвался после показанного слова — повтор дал бы второй текст поверх.
        if (err instanceof GeminiStreamInterruptedError) throw err;
        lastErr = err;
        const status = (err as Error & { status?: number })?.status;
        if (status == null) continue; // сеть или таймаут попытки — как 503, повторяем
        if (status === 404) {
          reportUnknownModel(model, model === runtime.model, (err as Error).message.slice(0, 300));
        }
        noteGeminiModelFailure(model, status, model === runtime.model);
        if (status === 404) break; // снята ИМЕННО эта модель — к следующей
        if (!isRetryableGeminiStatus(status)) throw err;
      }
    }
    // Срок вышел целиком — к резервной модели идти уже не с чем.
    if (deadline - Date.now() <= 0) break;
  }
  throw lastErr ?? new Error("Gemini (ассистент): нет доступной модели — все пропущены предохранителем или вышел срок");
}

/**
 * ПОТОК ОБОРВАЛСЯ ПОСЛЕ ПЕРВОГО ПОКАЗАННОГО СЛОВА (31.10.2026, помощник CRM, задача 1.6).
 *
 * Пока человеку не ушло ни одного слова, сбой потока — обычный сбой попытки: её
 * повторяют и переводят на резервную модель по той же политике, что и обычный
 * вызов. После первого слова повтор означал бы второй, другой текст поверх уже
 * показанного — поэтому не повторяем, а заканчиваем ошибкой с кодом, по которому
 * интерфейс предлагает «Повторить» (retryable).
 */
export class GeminiStreamInterruptedError extends Error {
  readonly code = "stream_interrupted" as const;
  readonly retryable = true;
  constructor(readonly original: unknown) {
    super(`Поток Gemini оборвался после начала ответа: ${original instanceof Error ? original.message : String(original)}`);
    this.name = "GeminiStreamInterruptedError";
  }
}

/** Одна потоковая попытка. Те же параметры, что у callGeminiToolsOnce, плюс onToken. */
async function callGeminiToolsStreamOnce(
  params: ToolsAttemptParams & { onToken: (delta: string) => void },
): Promise<GeminiToolTurn> {
  throwIfAborted(params.signal);
  const body = toolsRequestBody(params, params.tools, undefined);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 60_000);
  const unlinkAbort = linkAbort(controller, params.signal);
  const traceStarted = performance.now();
  const traceAttempt = traceModelStart(params.model, null, "assistant-tools");
  let traceResult: Parameters<typeof traceModelFinish>[1] = "error";
  let emitted = false;
  const acc = createToolStreamAccumulator();
  const emit = (delta: string) => {
    if (!delta) return;
    emitted = true;
    try {
      params.onToken(delta);
    } catch (err) {
      // Сбой показа (закрытый сокет) — не сбой модели: ответ всё равно собирается.
      console.warn("[ai:gemini-stream] onToken бросил:", err instanceof Error ? err.message : err);
    }
  };
  try {
    const res = await fetch(geminiStreamUrlFor(params.model), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": params.apiKey, ...geminiProxyHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      traceResult = res.status >= 400 && res.status < 500 && res.status !== 429 ? "blocked" : "error";
      throw await toolsHttpError(res, params.model, false);
    }
    if (!res.body) throw new GeminiStreamFormatError("ответ без тела");
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      // Без alt=sse (прокси потерял строку запроса) Google отдаёт весь поток одним
      // JSON-массивом: ответ правильный, только приходит целиком в конце.
      const all = (await res.json()) as unknown;
      for (const chunk of Array.isArray(all) ? all : [all]) emit(acc.push(chunk as GeminiStreamChunk));
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const sse = createSseDataReader();
      // Отмена (срок попытки, срок диалога, уход клиента) обязана остановить и
      // ЧТЕНИЕ, а не только запрос: тело, которое не слушает сигнал, иначе держало
      // бы цикл до конца генерации. cancel() завершает ожидающий read() пустым.
      const stopReading = () => void reader.cancel(controller.signal.reason).catch(() => undefined);
      controller.signal.addEventListener("abort", stopReading, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          // Пустой read() после отмены — не конец ответа, а его обрыв.
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Поток Gemini прерван");
          const payloads = done ? [...sse.push(decoder.decode()), ...sse.end()] : sse.push(decoder.decode(value, { stream: true }));
          for (const payload of payloads) emit(acc.pushData(payload));
          if (done) break;
        }
      } finally {
        controller.signal.removeEventListener("abort", stopReading);
        void reader.cancel().catch(() => undefined);
      }
    }
    const streamed = acc.result();
    // Поток кончился без finishReason — это обрыв, а не ответ: вызовы инструментов
    // из такого потока не исполняются никогда.
    if (!streamed.finishReason && !streamed.blockReason) {
      throw new GeminiStreamFormatError("поток кончился без finishReason");
    }
    const traceCache = streamed.usage ? Reflect.get(streamed.usage, "cachedContentTokenCount") : undefined;
    traceModelCache(traceAttempt, typeof traceCache === "number" && Number.isFinite(traceCache) && traceCache >= 0 ? traceCache > 0 : null);
    const modelParts = streamed.parts as GeminiPart[];
    const calls = toolCallsOf(modelParts);
    const text = modelParts
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    reportToolTurnOddities({
      text,
      calls,
      finishReason: streamed.finishReason,
      blockReason: streamed.blockReason,
      thoughts: streamed.usage?.thoughtsTokenCount,
      model: params.model,
      primaryModel: params.primaryModel,
    });
    traceResult = streamed.blockReason ? "blocked" : !text && calls.length === 0 ? "empty" : "returned";
    return {
      text,
      calls,
      modelParts,
      tokens: (streamed.usage?.promptTokenCount ?? 0) + (streamed.usage?.candidatesTokenCount ?? 0),
    };
  } catch (err) {
    // Отмена снаружи пробрасывается как есть (её разбирает вызывающий).
    if (params.signal?.aborted) throw abortReason(params.signal);
    if (emitted) throw new GeminiStreamInterruptedError(err);
    throw err;
  } finally {
    traceModelFinish(traceAttempt, traceResult, traceStarted);
    clearTimeout(timeout);
    unlinkAbort();
  }
}

/**
 * ПОТОКОВЫЙ ВЫЗОВ С ИНСТРУМЕНТАМИ (31.10.2026, помощник CRM, задача 1.6,
 * docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 * `streamGenerateContent?alt=sse`: текст уходит человеку по мере генерации через
 * onToken(delta), вызовы инструментов собираются целиком и отдаются только после
 * конца потока. Результат тот же GeminiToolTurn, что у callGeminiTools, — цикл
 * раундов помощника не различает два пути.
 *
 * Политика та же, что у непривязанного callGeminiTools (callGeminiToolsWithRetries):
 * ключ, модели и резервная, повторы с паузами, предохранитель, срок deadlineAt,
 * внешняя отмена signal. Отличие одно: сбой ПОСЛЕ первого показанного слова не
 * повторяется (GeminiStreamInterruptedError). Привязанного пути (providerOperation,
 * клиентский агент) здесь нет намеренно: его учёт денег на поток не рассчитан.
 */
export async function callGeminiToolsStream(params: {
  apiKey: string;
  system: string;
  contents: { role: "user" | "model"; parts: GeminiPart[] }[];
  tools: GeminiToolDefinition[];
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  runtime?: GeminiRuntime;
  /** Текстовая дельта — сразу, как пришла от Google. Размышления сюда не попадают. */
  onToken: (delta: string) => void;
}): Promise<GeminiToolTurn> {
  throwIfAborted(params.signal);
  const runtime = params.runtime ?? (await providerRuntime(undefined));
  return callGeminiToolsWithRetries(params, runtime, [runtime.model, ...runtime.fallbackModels], (attempt) =>
    callGeminiToolsStreamOnce({ ...attempt, onToken: params.onToken }),
  );
}

/** Один источник, на который сослалась модель при grounded-поиске. */
export interface GeminiGroundedSource {
  url: string;
  title?: string;
}

export interface GeminiGroundedResult {
  text: string;
  sources: GeminiGroundedSource[];
}

/**
 * GROUNDING С GOOGLE SEARCH — ОТДЕЛЬНЫЙ ПУТЬ, НЕ ЕЩЁ ОДИН ПУНКТ TOOLS (23.08.2026,
 * пункт 4 очереди ИИ).
 *
 * ПОЧЕМУ НЕ ЧЕРЕЗ callGeminiTools. У обычных инструментов (search_properties и
 * т.п.) вызов явный: модель просит функцию по имени, мы сами её исполняем
 * (runTool в ai/assistant.ts) и возвращаем результат следующим ходом. Grounding
 * устроен иначе: поиск в живом вебе делает САМА модель на своей стороне в момент
 * генерации, а нам возвращается уже готовый текст плюс `groundingMetadata` с
 * источниками — исполнять и возвращать здесь нечего, значит и цикл раундов
 * (MAX_TOOL_ROUNDS в assistant.ts) этому вызову не нужен.
 *
 * ИМЯ ИНСТРУМЕНТА И СТРУКТУРА ОТВЕТА — проверено живой документацией 23.08.2026
 * (ai.google.dev/gemini-api/docs/generate-content/google-search, REST для
 * generateContent — того же метода, которым уже ходит весь этот файл):
 *   tools: [{ google_search: {} }]  — пустой объект, без dynamicRetrievalConfig
 *     (та форма была у СТАРОГО google_search_retrieval для линейки 1.x, нам не нужна).
 *   candidates[0].groundingMetadata.groundingChunks[].web.{uri,title} — источники.
 *   candidates[0].groundingMetadata.webSearchQueries[] — какими запросами искала.
 * Документация также подтверждает, что у моделей линейки 3.x google_search можно
 * смешивать с functionDeclarations в одном запросе — но здесь всё равно отдельный
 * путь: grounding нужен узкому кругу справочных вопросов (см. REFERENCE_REAL_ESTATE
 * в assistant.ts), а не вперемешку с поиском данных CRM.
 *
 * Обычная модель (не дешёвая ступень) — справочный ответ с источниками не то место,
 * где экономия на качестве уместна (см. задачу).
 */
export async function callGeminiGrounded(params: {
  apiKey: string;
  system?: string;
  query: string;
  maxTokens?: number;
  timeoutMs?: number;
  providerOperation?: ProviderOperation;
  /** Внешняя отмена (помощник CRM). Прерывает попытку и паузу и пробрасывается
   *  наверх как есть — это не «Google не ответил», в журнал отказом не пишется. */
  signal?: AbortSignal;
  /** Абсолютный срок по часам Date.now(): позже него не начинаются ни попытка, ни
   *  пауза, и попытка не длиннее остатка. Без него поведение прежнее. */
  deadlineAt?: number;
  /** Уже прочитанные ключи и модели (кэш помощника); с providerOperation не используется. */
  runtime?: GeminiRuntime;
}): Promise<GeminiGroundedResult | null> {
  params.providerOperation?.check();
  throwIfAborted(params.signal);
  const start = Date.now();
  let ok = false;
  const spent = emptyUsage();
  let lastError: unknown;
  let usedModel = GEMINI_MODEL;
  const deadline = params.deadlineAt ?? Infinity;

  try {
    const runtime =
      params.runtime && !params.providerOperation ? params.runtime : await providerRuntime(params.providerOperation);
    assertBoundRuntimeKey(params.providerOperation, runtime, params.apiKey);
    usedModel = runtime.model;
    const modelsToTry = [runtime.model, ...runtime.fallbackModels];

    models: for (const [modelIndex, model] of modelsToTry.entries()) {
      // Предохранитель общий со всеми путями Gemini: лежачую модель не пробуем вовсе,
      // пока впереди есть кому ответить.
      if (skipModelForNow(model, modelIndex, modelsToTry.length)) continue;
      for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
        if (attempt > 0) {
          const pause = Math.min(GEMINI_RETRY_DELAYS_MS[attempt - 1], Math.max(0, deadline - Date.now()));
          if (params.providerOperation) await params.providerOperation.sleep(pause);
          else await sleepUnlessAborted(pause, params.signal);
        }
        throwIfAborted(params.signal);
        const left = deadline - Date.now();
        if (left <= 0) {
          lastError = new Error(
            "Срок вызова grounded-поиска истёк" + (lastError instanceof Error ? `; последняя причина: ${lastError.message}` : "")
          );
          break models;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.min(params.timeoutMs ?? 45_000, left));
        const unlinkAbort = linkAbort(controller, params.signal);
        let providerAttempt: ProviderAttempt | undefined;
        let attemptOutcome: Parameters<ProviderAttempt["finish"]>[0] = "error";
        try {
          const body: Record<string, unknown> = {
            contents: [{ role: "user", parts: [{ text: params.query }] }],
            tools: [{ google_search: {} }],
            generationConfig: {
              maxOutputTokens: params.maxTokens ?? 2048,
              ...(thinkingConfigRejected[model] ? {} : { thinkingConfig: geminiThinkingConfig(model) }),
            },
          };
          if (params.system) body.systemInstruction = { parts: [{ text: params.system }] };

          providerAttempt = await params.providerOperation?.begin({ provider: "google", api: "generateContent", adapter: "grounded", model,
            profileRevision: params.providerOperation.profileRevision, pricingRevision: params.providerOperation.pricingRevision,
            endpoint: "assistant-grounded", maxOutputTokens: params.maxTokens ?? 2048,
            features: { grounding: true, thinking: managedThinking(model) } }, params.timeoutMs ?? 45_000);
          params.providerOperation?.check();

          const res = await fetch(geminiGenerateUrlFor(model), {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": params.apiKey, ...geminiProxyHeaders() },
            body: JSON.stringify(body),
            signal: providerAttempt?.signal ?? controller.signal,
          });

          if (!res.ok) {
            const detail = (await res.text()).slice(0, 300);
            if (res.status === 400 && /thinking/i.test(detail) && !thinkingConfigRejected[model]) {
              thinkingConfigRejected[model] = true;
              void logSystemError(
                "ai",
                `Gemini (${model}) отверг thinkingConfig в grounded-запросе, дальше шлём без него: ${detail}`
              );
            }
            lastError = new Error(`Gemini HTTP ${res.status} (${model}, grounded): ${detail}`);
            if (res.status === 404) reportUnknownModel(model, model === runtime.model, detail);
            noteGeminiModelFailure(model, res.status, model === runtime.model);
            // Тот же принцип, что и в callGemini: не тот статус (400/401/404) не
            // лечится ни паузой, ни повтором — переходим к следующей модели сразу.
            if (!isRetryableGeminiStatus(res.status)) continue models;
            continue;
          }

          const data = (await res.json()) as {
            candidates?: {
              content?: { parts?: { text?: string }[] };
              groundingMetadata?: {
                webSearchQueries?: string[];
                groundingChunks?: { web?: { uri?: string; title?: string } }[];
              };
              finishReason?: string;
            }[];
            promptFeedback?: { blockReason?: string };
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              cachedContentTokenCount?: number;
            };
          };

          providerAttempt?.reportUsage(data.usageMetadata);
          providerAttempt?.check();

          noteGeminiModelSuccess(model);
          const cached = data.usageMetadata?.cachedContentTokenCount ?? 0;
          spent.inputTokens += Math.max(0, (data.usageMetadata?.promptTokenCount ?? 0) - cached);
          spent.cacheReadTokens += cached;
          spent.outputTokens += data.usageMetadata?.candidatesTokenCount ?? 0;

          const candidate = data.candidates?.[0];
          const text = (candidate?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("")
            .trim();

          if (!text) {
            attemptOutcome = data.promptFeedback?.blockReason ? "blocked" : "invalid";
            const finish = candidate?.finishReason ?? "нет";
            const blockReason = data.promptFeedback?.blockReason;
            lastError = new Error(
              `Gemini не вернул текст (grounded, ${model}, finishReason=${finish}${
                blockReason ? `, blockReason=${blockReason}` : ""
              })`
            );
            break;
          }

          // Дедуп по URL: одна и та же страница нередко встречается в нескольких
          // groundingChunks (модель цитирует её несколько раз по ходу ответа).
          const seenUrls = new Set<string>();
          const sources: GeminiGroundedSource[] = [];
          for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
            const url = chunk.web?.uri;
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            sources.push({ url, title: chunk.web?.title });
          }

          usedModel = model;
          ok = true;
          attemptOutcome = "success";
          return { text, sources };
        } catch (err) {
          if (isProviderOperationError(err)) throw err;
          if (params.signal?.aborted) throw abortReason(params.signal);
          lastError = err;
        } finally {
          clearTimeout(timeout);
          unlinkAbort();
          await providerAttempt?.finish(attemptOutcome);
        }
      }
    }

    console.error("[ai:assistant-grounded:gemini]", lastError instanceof Error ? lastError.message : lastError);
    void logSystemError(
      "ai",
      `Grounded-поиск Gemini не ответил: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
    return null;
  } finally {
    if (!params.providerOperation) await logAiCall({ endpoint: "assistant-grounded:gemini", model: usedModel, spent, ms: Date.now() - start, ok });
  }
}
