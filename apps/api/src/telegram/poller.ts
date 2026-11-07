import { getUpdates, isTelegramEnabled, telegramUpdateChatId, type TelegramUpdate } from "./api.js";
import { ASSISTANT_DEADLINE_SEC } from "@royal-home/shared";
import { logSystemError } from "../lib/systemError.js";
import { isAlbumPart, startTelegramUpdate, telegramRepliesInFlight } from "./bot.js";
import {
  isDuplicateDelivery,
  markProcessedMessageComplete,
  releaseProcessedMessage,
  resetIncompleteProcessedMessages,
} from "../lib/webhookDedupe.js";
import { prisma } from "../db.js";
import { withTelegramUpdateRetry } from "./updateRetry.js";

let running = false;
let pollingTask: Promise<void> | null = null;

/**
 * Long polling — запасной режим (19.08.2026). Вебхук (routes/webhooks.ts →
 * POST /api/v1/webhooks/telegram) теперь основной способ доставки апдейтов;
 * polling включается сам, только если TELEGRAM_WEBHOOK_SECRET не задан —
 * так локальная разработка без публичного домена продолжает работать без
 * ручного переключения.
 *
 * Оба режима разом Telegram не отдаёт (setWebhook отключает getUpdates на
 * своей стороне), но polling локально при настроенном вебхуке нам самим не
 * нужен — просто впустую опрашивал бы API.
 */
export function startTelegramBot() {
  if (!isTelegramEnabled()) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN не задан — бот выключен");
    return;
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.log("[telegram] TELEGRAM_WEBHOOK_SECRET задан — работаем через вебхук, long polling не запущен");
    return;
  }
  if (pollingTask) return;
  running = true;
  console.log("[telegram] Бот запущен (long polling)");
  pollingTask = (async () => {
    // Незавершённые отметки канала TELEGRAM на этот момент — от мёртвого
    // предыдущего процесса (этот только что стартовал и ничего ещё не
    // обрабатывал), см. докстринг resetIncompleteProcessedMessages. ДО первого
    // опроса — иначе первая же повторная доставка может упереться в отметку,
    // которую мы сами вот-вот бы снесли.
    await resetIncompleteProcessedMessages(["TELEGRAM"], "telegram").catch((err) =>
      console.error("[telegram] сброс незавершённых отметок при старте:", err instanceof Error ? err.message : err)
    );
    await pollLoop();
  })().finally(() => { pollingTask = null; });
}

/**
 * Останавливает цикл опроса. Нужен и тесту (чтобы не оставлять за собой вечно
 * живой цикл с таймерами), и мягкой остановке worker-процесса по SIGTERM
 * (worker.ts) — перестать брать новые апдейты, не обрывая уже начатую
 * обработку текущей пачки. Ответ уже начатого HTTP-опроса можно оставить Telegram.
 */
export function stopTelegramBot() {
  running = false;
}

/**
 * Идёт ли прямо сейчас обработка апдейта (24.09.2026, мягкая остановка
 * worker-процесса). `running=false` останавливает только ЗАБОР новых апдейтов
 * — если в моменте SIGTERM воркер как раз качает/копирует ролик монтажёра
 * внутри `handleTelegramUpdate`, `stopBackgroundJobs`/`isBackgroundJobRunning`
 * (jobs/runner.ts) этого не видят вовсе: поллер — не задание из очереди, а
 * свой независимый цикл. Без этого флага мягкая остановка ждала бы фиктивно
 * пустую очередь заданий и падала на grace-таймауте прямо посреди копирования
 * (ровно авария 24.09.2026 — обрыв на 27 МБ из 85).
 */
let processingBatch = false;
/**
 * Апдейты с ходом помощницы, вынесенным из очереди (08.11.2026): приняты, но ещё не отвечены.
 * Offset за них не продвигается (Telegram пришлёт их снова после перезапуска), а повторный опрос
 * их пропускает — двойной обработки нет.
 */
const assistantInFlight = new Set<number>();
export function isTelegramPollerBusy(): boolean {
  // Ответы, ждущие окно склейки (01.10.2026, находка №132), идут уже после
  // апдейта, вне этого цикла, — но это тоже работа, которую нельзя оборвать.
  return processingBatch || telegramRepliesInFlight() > 0 || assistantInFlight.size > 0;
}

/**
 * Потолок ожидания ответа помощницы на один апдейт: самый длинный срок хода из Настроек
 * (ASSISTANT_DEADLINE_SEC.max) плюс минута на доставку. Дольше — апдейт отмечается завершённым.
 */
const DEFAULT_DEFERRED_REPLY_CEILING_MS = ASSISTANT_DEADLINE_SEC.max * 1000 + 60_000;
let deferredReplyCeilingMs = DEFAULT_DEFERRED_REPLY_CEILING_MS;
/** Для тестов: короткий потолок (null — вернуть обычный). */
export function setDeferredReplyCeilingForTests(ms: number | null): void {
  deferredReplyCeilingMs = ms ?? DEFAULT_DEFERRED_REPLY_CEILING_MS;
}

/** Пауза, если в ответе Telegram нет ничего нового (только ждущие ответа помощницы). */
const NOTHING_NEW_PAUSE_MS = 1_000;

/**
 * ТРЕВОГА — ПО ДЛИТЕЛЬНОСТИ МОЛЧАНИЯ, А НЕ ПО ЧИСЛУ НЕУДАЧ (12.08.2026).
 *
 * Раньше порогом были «три неудачных опроса подряд» — предполагалось, что это
 * около минуты без связи. Но длительность трёх неудач зависит от того, КАК они
 * провалились: штатный long polling рвётся по таймауту через 35 секунд, а вот
 * `fetch failed` (ECONNREFUSED, сорванный DNS) возвращается мгновенно — и три
 * таких неудачи с паузами 5 и 10 секунд укладываются в 15 секунд. То есть
 * секундная сетевая икота на VPS, которую бот переживал сам, писала директору
 * в журнал «Бот не получает сообщения». Именно эти записи и составляли шум.
 *
 * Считаем то, что на самом деле важно человеку: сколько времени бот не может
 * получить сообщения. Три минуты молчания клиент уже замечает (написал — не
 * ответили), икота в десять секунд — нет. Отсчёт идёт от последнего УДАЧНОГО
 * опроса, а не от первой неудачи: время, потраченное на зависший запрос до его
 * обрыва, — это тоже молчание.
 */
const ALARM_AFTER_SILENCE_MS = 3 * 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

async function pollLoop() {
  let offset = 0;
  // Апдейты другого чата могли завершиться за сбоем в текущей пачке.
  // При повторном опросе пропускаем их, пока offset не сможет пройти этот разрыв.
  const settledIds = new Set<number>();
  let failures = 0;
  let lastSuccessAt = Date.now();
  let alarmed = false;
  while (running) {
    try {
      const updates = await getUpdates(offset);
      if (!running) break;
      if (alarmed) {
        const silentSec = Math.round((Date.now() - lastSuccessAt) / 1000);
        console.log(`[telegram] Связь восстановлена после ${silentSec} с молчания (${failures} неудачных опросов)`);
        /**
         * ТРЕВОГА ГАСНЕТ САМА. Раньше восстановление писалось только в консоль
         * контейнера, а запись в журнале ошибок оставалась неразобранной
         * НАВСЕГДА — и будила директора утренней сводкой каждый день, хотя связь
         * вернулась через минуту. За неделю так накопилось шесть таких записей,
         * все про обрывы, которых давно нет.
         */
        void prisma.errorLog
          .updateMany({
            where: { source: "telegram", resolvedAt: null, message: { startsWith: "Бот не получает сообщения" } },
            data: { resolvedAt: new Date() },
          })
          .catch((err) => console.error("[telegram] тревога не снята:", err instanceof Error ? err.message : err));
      }
      failures = 0;
      lastSuccessAt = Date.now();
      alarmed = false;
      processingBatch = true;
      try {
        await processBatch(updates, settledIds);
        // В пачке только апдейты, чей ответ помощницы ещё готовится: Telegram вернёт их сразу же —
        // без паузы цикл крутился бы вхолостую весь долгий ход.
        if (updates.length > 0 && updates.every((u) => settledIds.has(u.update_id) || assistantInFlight.has(u.update_id))
            && updates.some((u) => assistantInFlight.has(u.update_id))) {
          await new Promise((r) => setTimeout(r, NOTHING_NEW_PAUSE_MS));
        }
      } finally {
        // Telegram подтверждает всё ниже offset. Продвигаем его только до первого
        // незавершённого апдейта в порядке полученной пачки, даже если ID идут с пропусками.
        for (const update of updates) {
          if (!settledIds.has(update.update_id)) break;
          offset = update.update_id + 1;
        }
        for (const id of settledIds) if (id < offset) settledIds.delete(id);
        processingBatch = false;
      }
    } catch (err) {
      failures += 1;
      const silentMs = Date.now() - lastSuccessAt;
      const silentSec = Math.round(silentMs / 1000);
      const reason = err instanceof Error ? err.message : String(err);
      // Каждая неудача видна в консоли контейнера — включая те, что до журнала
      // не доходят: разбирать сетевые проблемы по-прежнему есть по чему.
      console.error(`[telegram] Ошибка long polling (подряд ${failures}, молчание ${silentSec} с):`, reason);
      // Оборванный поллинг = бот не отвечает клиентам вообще. Это обязано быть видно —
      // но только когда обрыв устойчивый, иначе журнал ошибок теряет доверие.
      if (silentMs >= ALARM_AFTER_SILENCE_MS && !alarmed) {
        alarmed = true;
        void logSystemError(
          "telegram",
          `Бот не получает сообщения ${silentSec} с подряд: ${reason} (неудачных опросов: ${failures})`
        );
      }
      // Пауза растёт: при долгом отказе Telegram не имеет смысла ломиться каждые 5 секунд.
      const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const POLL_CHAT_CONCURRENCY = 4;

async function processBatch(updates: TelegramUpdate[], settledIds: Set<number>): Promise<void> {
  const lanes = new Map<number, TelegramUpdate[]>();
  const processOnce = async (update: TelegramUpdate) => {
    if (settledIds.has(update.update_id) || assistantInFlight.has(update.update_id)) return;
    const deferred = await acceptUpdate(update);
    if (!deferred) {
      settledIds.add(update.update_id);
      return;
    }
    // Ход помощницы идёт вне пачки: соседние чаты и следующий опрос его не ждут.
    assistantInFlight.add(update.update_id);
    void deferred.done.finally(() => {
      settledIds.add(update.update_id);
      assistantInFlight.delete(update.update_id);
    });
  };
  const drainLanes = async () => {
    if (!lanes.size) return;
    const remaining = lanes.values();
    const workers = Array.from({ length: Math.min(POLL_CHAT_CONCURRENCY, lanes.size) }, async () => {
      for (const lane of remaining) {
        for (const update of lane) await processOnce(update);
      }
    });
    // Ошибка одной очереди не должна запускать повторный опрос, пока другие ещё работают.
    const results = await Promise.allSettled(workers);
    lanes.clear();
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  for (const update of updates) {
    const chatId = telegramUpdateChatId(update);
    if (chatId == null || isAlbumPart(update)) {
      // Альбомы имеют отдельный буфер и дедуп; кнопка без чата не имеет ключа порядка.
      await drainLanes();
      await processOnce(update);
    } else {
      const lane = lanes.get(chatId);
      if (lane) lane.push(update);
      else lanes.set(chatId, [update]);
    }
  }
  await drainLanes();
}

/** Принять апдейт. Возвращает ответ помощницы, если он вынесен из очереди: апдейт завершится с ним. */
async function acceptUpdate(update: TelegramUpdate): Promise<{ done: Promise<void> } | null> {
  const id = String(update.update_id);
  const albumPart = isAlbumPart(update);
  // Альбом дедупится при склейке. Остальные апдейты ставят отметку до обработки.
  if (!albumPart && await isDuplicateDelivery("TELEGRAM", id, { requireClaim: true })) {
    console.log(`[telegram] апдейт ${id} уже обработан — пропускаем`);
    return null;
  }

  let accepted: Awaited<ReturnType<typeof startTelegramUpdate>> | undefined;
  try {
    // Внутри очереди чата ждём весь приём с повторами. Ответ клиента после окна
    // склейки остаётся отдельной задачей, чтобы следующее сообщение попало в буфер.
    accepted = await withTelegramUpdateRetry(() => startTelegramUpdate(update));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[telegram] Ошибка обработки апдейта:", reason);
    void logSystemError("telegram", `Апдейт не обработан: ${reason}`);
    if (!albumPart) await releaseProcessedMessage("TELEGRAM", id);
    return null;
  }

  if (accepted?.assistantDeferred) {
    // Отметка «готово» — когда ответ помощницы ушёл (он сам ловит свои ошибки и не отклоняется).
    // Обёртка, а не сам промис: async-функция иначе дождалась бы ответа и держала пачку.
    // Потолок ожидания: зависший ответ не держит offset вечно (при полной пачке в 100 апдейтов
    // новые сообщения иначе не пришли бы вовсе). По потолку апдейт отмечается завершённым.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deferredReplyCeilingMs);
    });
    const done = Promise.race([accepted.reply.then(() => "replied" as const), ceiling]).then(async (how) => {
      if (timer) clearTimeout(timer);
      if (how === "timeout") {
        void logSystemError(
          "telegram",
          `Ответ помощницы на апдейт ${id} не готов за ${Math.round(deferredReplyCeilingMs / 1000)} с — апдейт отмечен завершённым, чтобы не держать остальные сообщения`,
        );
      }
      if (albumPart) return;
      try {
        await markProcessedMessageComplete("TELEGRAM", id);
      } catch (err) {
        void logSystemError("telegram", `Не удалось отметить апдейт ${id} завершённым: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return { done };
  }
  if (!albumPart) await markProcessedMessageComplete("TELEGRAM", id);
  return null;
}
