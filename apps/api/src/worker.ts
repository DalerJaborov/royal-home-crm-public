import "./loadEnv.js";
import { pathToFileURL } from "node:url";
import { assertProductionEnv } from "./env-check.js";
import { prisma } from "./db.js";
import { startCronJobs } from "./cron.js";
import { startTelegramBot, stopTelegramBot, isTelegramPollerBusy } from "./telegram/poller.js";
import { isBackgroundJobRunning, stopBackgroundJobs } from "./jobs/runner.js";
import { activeTickCount, catchUpMissedTicks, stopNewTicks } from "./lib/cronHeartbeat.js";
import { onNewSystemError } from "./lib/systemError.js";
import { notifyDirectorsAboutNewError } from "./push.js";
import { liveIncomingByRecordId } from "./lib/telephony/incomingCalls.js";
import { setLiveIncomingLookup } from "./lib/telephony/liveIncomingLookupHook.js";
import { rewardFirstCallIfOnTime } from "./services/leads/firstCall.js";
import { setRewardFirstCallHook } from "./lib/telephony/rewardFirstCallHook.js";
import { pickAgentForLead } from "./services/leads/selection.js";
import { setPickAgentForLeadHook } from "./lib/telephony/pickAgentForLeadHook.js";
import { assignAgentForLead, recordAssignReason } from "./services/leads/assignment.js";
import { setAssignAgentForLeadHook, setRecordAssignReasonHook } from "./lib/telephony/assignAgentForLeadHook.js";
import { settleBackgroundHandoffDispatches } from "./lib/videoHandoff.js";

/**
 * ФОНОВЫЙ ПРОЦЕСС (26.08.2026, чертёж каркаса, этап А2/А3).
 *
 * Один Node-процесс держал на себе HTTP для агентов, 44 крон-тика,
 * Telegram-поллер и две ARI-подписки: тяжёлый тик (ffmpeg, разбор звонков)
 * душил интерфейс живым людям. Фон выносится сюда двумя шагами:
 *
 *  - А2 (этот файл): вся фоновая работа собрана в startBackgroundWork();
 *    index.ts зовёт её за флагом ENABLE_BACKGROUND (по умолчанию ВКЛЮЧЕНО —
 *    поведение прода не меняется, пока compose не скажет иначе).
 *  - А3: второй контейнер тем же образом, CMD = node dist/worker.js;
 *    у api-контейнера ENABLE_BACKGROUND=0.
 *
 * ⚠️ Telegram-поллер и ARI-подписки обязаны жить РОВНО В ОДНОМ процессе:
 * два поллера дерутся за getUpdates (409), двойная подписка на события АТС
 * задваивает карточки звонков. Поэтому флаг по умолчанию включён и
 * выключается ТОЛЬКО там, где рядом гарантированно работает worker-контейнер.
 */

/** ENABLE_BACKGROUND=0/false — фон в этом процессе выключен (только явно). */
export function backgroundEnabled(): boolean {
  const raw = (process.env.ENABLE_BACKGROUND ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/**
 * Вся фоновая работа worker-процесса: кроны и Telegram-поллер.
 *
 * ⚠️ ARI-подписок здесь НЕТ НАРОЧНО (аудит №4, 27.08 — критика): живое
 * состояние звонков (`calls` в lib/telephony/callTracker.ts) — память
 * HTTP-процесса: trackCall зовут роуты /call и /dial, а события АТС должны
 * попадать В ТУ ЖЕ карту, иначе агент жмёт «Позвонить», а событие «канал
 * закончен» прилетает в другой процесс и звонок висит навсегда. Поэтому
 * подписки на АТС живут в index.ts рядом с картой — см. там же
 * live-calls-sweep. Досев расшифровок после рестарта больше не нужен:
 * очередь повторов персистентная (jobs/transcriptionRetry.ts).
 */
export function startBackgroundWork(): void {
  startCronJobs();
  startTelegramBot();
  // Суточный тик, чья минута пришлась на выкат, догоняется сразу после старта
  // (E7/Ф8 глубокой проверки 02.10.2026): node-cron пропущенное не повторяет.
  // Минута задержки — дать процессу подняться и не толкаться с первыми тиками.
  setTimeout(() => {
    void catchUpMissedTicks().catch((err) =>
      console.error("[cron] догон пропущенных тиков:", err instanceof Error ? err.message : err)
    );
  }, CATCH_UP_DELAY_MS).unref();
}

const CATCH_UP_DELAY_MS = 60_000;

/**
 * Запуск отдельным процессом: node dist/worker.js (контейнер worker, этап А3).
 * При импорте из index.ts этот блок не выполняется — двойного старта не бывает.
 */
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  assertProductionEnv();
  // Тот же крючок, что в index.ts: push о новой ошибке — без циклического импорта
  // (см. комментарий там). Точек входа теперь две, крючок нужен обеим.
  onNewSystemError(notifyDirectorsAboutNewError);
  // Тот же приём для qualifyIncoming.ts ↔ incomingCalls.ts (аудит циклов
  // 03.09.2026, см. liveIncomingLookupHook.ts) — по той же причине, обеим точкам входа.
  setLiveIncomingLookup(liveIncomingByRecordId);
  setRewardFirstCallHook(rewardFirstCallIfOnTime);
  setPickAgentForLeadHook(pickAgentForLead);
  setAssignAgentForLeadHook(assignAgentForLead);
  setRecordAssignReasonHook(recordAssignReason);
  // Последний рубеж fire-and-forget промисов — как в index.ts: один необработанный
  // reject из фоновой задачи не имеет права уронить все тики разом.
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason instanceof Error ? reason.stack ?? reason.message : reason);
  });

  console.log("[worker] фоновый процесс запущен");
  startBackgroundWork();

  /**
   * МЯГКАЯ СМЕРТЬ, КОТОРАЯ ДЕЙСТВИТЕЛЬНО ЖДЁТ (починено 27.08.2026, аудит №4;
   * расширено 24.09.2026 на Telegram-поллер).
   *
   * Прежняя версия обещала «тикам даётся 15 секунд», а на деле сразу рвала
   * Prisma и выходила: каждый деплой (их несколько в день) обрывал
   * исполняющееся задание посреди работы. Отметка статуса не записывалась —
   * задание висело RUNNING до подбора через 15 минут, а при обрыве между
   * side-effect'ом (сообщение клиенту уже ушло) и отметкой DONE работа
   * повторялась целиком.
   *
   * 24.09.2026: ждали только `isBackgroundJobRunning()` (очередь заданий,
   * jobs/runner.ts) — Telegram-поллер НЕ задание из очереди, а свой цикл
   * (telegram/poller.ts), и его обрыв ждать не умели вовсе. Ровно это уронило
   * приём ролика монтажёра: рестарт пришёлся на копирование файла из тома Bot
   * API, `stop_grace_period` 20с не хватило на скачивание+копию 85 МБ, и
   * `isBackgroundJobRunning()` всё это время честно отвечал «нечего ждать».
   *
   * Теперь: перестаём брать новые задания И новые Telegram-апдейты, ждём то,
   * что уже в работе (задание очереди ИЛИ текущий апдейт поллера) до грейса, и
   * только потом отключаемся. Потолок поднят с 15 до 85с — под самый долгий
   * путь (getFile 180с общего таймаута исключение, но сама СКАЧКА+копия
   * рядового ролика укладывается в минуту с большим запасом; 85с оставляет
   * 5с до `stop_grace_period: 90s` в docker-compose.prod.yml, где Docker
   * пришлёт SIGKILL, если процесс не вышел сам).
   */
  const SHUTDOWN_GRACE_MS = 85_000;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker][shutdown] получен ${signal} — новых заданий и апдейтов не берём, ждём текущее`);
    const forceExit = setTimeout(() => {
      console.error(`[worker][shutdown] фон не дозавершился за ${SHUTDOWN_GRACE_MS / 1000}с — выходим жёстко`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();
    stopBackgroundJobs();
    stopTelegramBot();
    // Новые тики по расписанию не начинаются, идущие ждём ниже (№172).
    stopNewTicks();
    const waitUntil = Date.now() + SHUTDOWN_GRACE_MS - 1_000;
    /**
     * ФОНОВАЯ ОТПРАВКА МОНТАЖЁРУ (25.09.2026, А6, раздел 6 спецификации) —
     * releaseQueueIfClear/смена монтажёра в Настройках уезжают монтажёру через
     * dispatchInBackground, не дожидаясь ответа: без этого ожидания здесь
     * SIGTERM обрывал передачу тяжёлых исходников на середине точно так же,
     * как раньше обрывал приём (см. докстринг SHUTDOWN_GRACE_MS выше) — сторож
     * lib/videoHandoffRedelivery.ts дошлёт, но честнее не обрывать раньше
     * времени, если процесс всё равно ещё жив. Тот же потолок, что и у
     * остального фона ниже.
     */
    await Promise.race([
      settleBackgroundHandoffDispatches(),
      new Promise((r) => setTimeout(r, Math.max(0, waitUntil - Date.now()))),
    ]);
    // Идущие тики по расписанию — тоже (№172 ночной проверки 24.09): просьба
    // подтвердить показ или напоминание бота, оборванные между отправкой и
    // отметкой, уходили клиенту второй раз после рестарта.
    while ((isBackgroundJobRunning() || isTelegramPollerBusy() || activeTickCount() > 0) && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isBackgroundJobRunning()) {
      console.warn("[worker][shutdown] задание не успело — оно будет подобрано как зависшее");
    }
    if (activeTickCount() > 0) {
      console.warn("[worker][shutdown] тик по расписанию не успел дойти — следующий запуск продолжит");
    }
    if (isTelegramPollerBusy()) {
      console.warn("[worker][shutdown] апдейт Telegram не успел обработаться — отметка снимется при следующем старте");
    }
    await prisma.$disconnect().catch(() => {});
    console.log("[worker][shutdown] завершились чисто");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
