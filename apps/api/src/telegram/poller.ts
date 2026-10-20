import { getUpdates, isTelegramEnabled } from "./api.js";
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
  if (running) return;
  running = true;
  console.log("[telegram] Бот запущен (long polling)");
  void (async () => {
    // Незавершённые отметки канала TELEGRAM на этот момент — от мёртвого
    // предыдущего процесса (этот только что стартовал и ничего ещё не
    // обрабатывал), см. докстринг resetIncompleteProcessedMessages. ДО первого
    // опроса — иначе первая же повторная доставка может упереться в отметку,
    // которую мы сами вот-вот бы снесли.
    await resetIncompleteProcessedMessages(["TELEGRAM"], "telegram").catch((err) =>
      console.error("[telegram] сброс незавершённых отметок при старте:", err instanceof Error ? err.message : err)
    );
    await pollLoop();
  })();
}

/**
 * Останавливает цикл опроса. Нужен и тесту (чтобы не оставлять за собой вечно
 * живой цикл с таймерами), и мягкой остановке worker-процесса по SIGTERM
 * (worker.ts) — перестать брать НОВЫЕ апдейты, не обрывая уже начатую
 * обработку текущей пачки (проверяется `while (running)` в начале каждой
 * итерации `pollLoop`, а не внутри неё — см. isTelegramPollerBusy ниже).
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
let processingUpdate = false;
export function isTelegramPollerBusy(): boolean {
  // Ответы, ждущие окно склейки (01.10.2026, находка №132), идут уже после
  // апдейта, вне этого цикла, — но это тоже работа, которую нельзя оборвать.
  return processingUpdate || telegramRepliesInFlight() > 0;
}

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
  let failures = 0;
  let lastSuccessAt = Date.now();
  let alarmed = false;
  while (running) {
    try {
      const updates = await getUpdates(offset);
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
      for (const update of updates) {
        offset = update.update_id + 1;
        /**
         * ЗАЩИТА ОТ ПОВТОРНОЙ ОБРАБОТКИ ПОСЛЕ ПЕРЕЗАПУСКА.
         *
         * Новый offset уходит в Telegram только СЛЕДУЮЩИМ запросом getUpdates.
         * Упал контейнер (выкат, перезапуск) в середине пачки — Telegram отдаст
         * неподтверждённые апдейты заново, и клиент получит второй ответ на то
         * же сообщение, а история диалога — дубль реплики. Для каналов Meta это
         * закрыто отметкой в базе с уникальным ключом (lib/webhookDedupe.ts),
         * Telegram оставался без неё вовсе.
         *
         * Отметка ставится ДО обработки: арбитром служит уникальный индекс в
         * базе, а не порядок выполнения.
         */
        // Часть альбома дедупится при СКЛЕЙКЕ (bufferAlbum): отметка при приёме +
        // рестарт в окне буфера теряли пачку фото безвозвратно (26.08.2026).
        const albumPart = isAlbumPart(update);
        if (!albumPart && (await isDuplicateDelivery("TELEGRAM", String(update.update_id)))) {
          console.log(`[telegram] апдейт ${update.update_id} уже обработан — пропускаем`);
          continue;
        }
        processingUpdate = true;
        try {
          /**
           * ОТВЕТ БОТА НЕ ЖДЁМ (01.10.2026, находка №132). Он идёт после окна
           * склейки быстрых сообщений (по умолчанию 25 секунд, Настройки → Бот), а
           * этот цикл разбирает апдейты ВСЕХ чатов по одному: ожидание здесь
           * задержало бы остальных клиентов, а второе сообщение того же клиента
           * не попало бы в одну пачку с первым. Апдейт принят, как только
           * сообщение легло в переписку; сбой ответа пишет в журнал сам бот.
           */
          // Повтор приёма (JOB-06): сбой не должен выбросить апдейт, который Telegram
          // уже не отдаст. Новый offset уходит в Telegram следующим getUpdates, то есть
          // только после успеха или после исчерпания попыток.
          await withTelegramUpdateRetry(() => startTelegramUpdate(update));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error("[telegram] Ошибка обработки апдейта:", reason);
          void logSystemError("telegram", `Апдейт не обработан: ${reason}`);
          // Замок дубля снимаем (как в вебхуке /telegram и у Meta): иначе транзиентный
          // сбой съедает сообщение клиента навсегда — повторная доставка при следующем
          // перезапуске отбросится как «уже обработан». У части альбома отметки нет.
          if (!albumPart) void releaseProcessedMessage("TELEGRAM", String(update.update_id));
        } finally {
          // Отметка завершения (21.09.2026) — см. docstring lib/webhookDedupe.ts.
          if (!albumPart) void markProcessedMessageComplete("TELEGRAM", String(update.update_id));
          processingUpdate = false;
        }
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
