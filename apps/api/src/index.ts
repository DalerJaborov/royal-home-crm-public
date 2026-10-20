import "./loadEnv.js";
import { assertProductionEnv } from "./env-check.js";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { backgroundEnabled, startBackgroundWork } from "./worker.js";
import { startRouteHitFlusher, flushRouteHits } from "./lib/routeHits.js";
import { startAriEvents } from "./lib/telephony/ariEvents.js";
import { recoverInterruptedTranscriptionStages } from "./lib/telephony/callRecordings.js";
import {
  LIVE_VOICE_SHUTDOWN_WAIT_MS,
  setLiveVoiceCallResolver,
  shutdownLiveVoiceListener,
  startLiveVoiceListener,
} from "./lib/telephony/liveVoiceBridge.js";
import { onConsultantCallEnded, resolveConsultantCall } from "./lib/telephony/liveVoiceConsultant.js";
import { startLiveVoiceScenarioTicks } from "./lib/telephony/liveVoiceScenarioTicks.js";
import { startCallMemoryTicks } from "./lib/telephony/callMemoryTicks.js";
import { sweepStaleLiveCalls } from "./lib/telephony/callTracker.js";
import { releaseInterruptedSiteEditClaims } from "./routes/siteNotifications.js";
import { activeTickCount, reportCronTickError, scheduleTracked, stopNewTicks } from "./lib/cronHeartbeat.js";
import { API_PROCESS_TICKS } from "./lib/apiProcessTicks.js";
import { onNewSystemError } from "./lib/systemError.js";
import { resolveGeminiRuntime } from "./ai/geminiSettings.js";
import { notifyDirectorsAboutNewError } from "./push.js";
import { closeOrphanedIncomingCalls, liveIncomingByRecordId, setConsultantCallEndedHook } from "./lib/telephony/incomingCalls.js";
import { setLiveIncomingLookup } from "./lib/telephony/liveIncomingLookupHook.js";
import { rewardFirstCallIfOnTime } from "./services/leads/firstCall.js";
import { setRewardFirstCallHook } from "./lib/telephony/rewardFirstCallHook.js";
import { pickAgentForLead } from "./services/leads/selection.js";
import { setPickAgentForLeadHook } from "./lib/telephony/pickAgentForLeadHook.js";
import { assignAgentForLead, recordAssignReason } from "./services/leads/assignment.js";
import { setAssignAgentForLeadHook, setRecordAssignReasonHook } from "./lib/telephony/assignAgentForLeadHook.js";
import { beginShutdown, drainBackgroundTasks } from "./lib/shutdownState.js";
import { closeAllStreams } from "./lib/eventBus.js";
import { resetIncompleteProcessedMessages } from "./lib/webhookDedupe.js";

assertProductionEnv();

// Крючок вместо прямого импорта push.ts из systemError.ts — тот уже импортирует
// logSystemError оттуда же, и обратный импорт дал бы цикл (см. systemError.ts,
// onNewSystemError). index.ts — единственная точка, где оба модуля встречаются
// без цикла: он не импортируется никем внутри API.
onNewSystemError(notifyDirectorsAboutNewError);

// Тот же приём для qualifyIncoming.ts ↔ incomingCalls.ts (аудит циклов
// 03.09.2026, см. liveIncomingLookupHook.ts).
setLiveIncomingLookup(liveIncomingByRecordId);
// И для callTracker.ts ↔ services/leads/firstCall.ts (см. rewardFirstCallHook.ts).
setRewardFirstCallHook(rewardFirstCallIfOnTime);
// И для qualifyIncoming.ts ↔ services/leads/selection.ts (см. pickAgentForLeadHook.ts).
setPickAgentForLeadHook(pickAgentForLead);
// Консультант на телефоне (24.09.2026): мост живого голоса спрашивает у него
// задание на звонок, не импортируя прикладную часть CRM (см. liveVoiceConsultant.ts).
setLiveVoiceCallResolver(resolveConsultantCall);
// Итог входящего, который брал консультант, — ему же: разговор в карточку, звонок
// в раздачу (правка 5 робозвонка, 24.09.2026).
setConsultantCallEndedHook(onConsultantCallEnded);
// И для qualifyIncoming.ts ↔ services/leads/assignment.ts (Пачка 1, 11.09.2026 —
// звонки теперь тоже проходят через правило «свой объект», см. assignAgentForLeadHook.ts).
setAssignAgentForLeadHook(assignAgentForLead);
setRecordAssignReasonHook(recordAssignReason);

// Последний рубеж: без этого необработанный reject из fire-and-forget промиса
// (void someAsyncCall() без .catch(), например в siteSync/loginLog) по умолчанию
// в Node роняет весь процесс — все агенты теряют сессию из-за одного сбоя БД
// в фоновой задаче. Логируем и продолжаем работу вместо падения.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack ?? reason.message : reason);
});

// То же самое, но для СИНХРОННОГО throw, не пойманного вообще нигде (13.09.2026,
// разбор надёжности живого голоса — необёрнутый callback вроде
// rtpSocket.on("message", ...) в liveVoiceBridge.ts, где такой throw уже
// перехватывается отдельно, но это последний рубеж для ЛЮБОГО другого места).
// В отличие от unhandledRejection здесь процесс НЕ продолжает работу: раз
// синхронный throw прошёл мимо всех try/catch, состояние процесса непредсказуемо
// (могли остаться недо-закрытые сокеты, недо-обновлённые Map) — контролируемо
// падаем кодом 1, чтобы супервизор/докер перезапустил чистый процесс, а не
// пытаемся жить дальше в неизвестном состоянии.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => {
  console.log(`Royal Home API запущен на порту ${port}`);

  /**
   * ИМЯ МОДЕЛИ ИИ — ПРОВЕРИТЬ НА СТАРТЕ, А НЕ ПРИ ПЕРВОМ КЛИЕНТЕ (30.08.2026).
   *
   * `resolveGeminiRuntime` зовёт `checkGeminiModelNames` сама, но только когда до ИИ
   * дойдёт первое обращение. Разница видна ровно в тот день, когда она нужна: 30.08
   * основная модель сутки отдавала 503, и авария жила незамеченной, потому что резерв
   * молча вытягивал каждый запрос (716 отказов против 2 успехов за шесть часов).
   * До этого закрытая моделью Google `gemini-2.5-flash` прожила два месяца, отвечая
   * 404 на каждый вызов.
   *
   * Дёргаем runtime вхолостую: побочный эффект (запись в «Здоровье системы» о мёртвом
   * или незнакомом имени) — это и есть то, что нам нужно. Результат не используется.
   * Отказ глушим: настройки ИИ не должны мешать HTTP-процессу подняться.
   */
  void resolveGeminiRuntime().catch(() => {});

  /**
   * ТЕЛЕФОНИЯ ЖИВЁТ ЗДЕСЬ, В HTTP-ПРОЦЕССЕ, — НЕ В WORKER (аудит №4, 27.08).
   *
   * Живое состояние звонков (`calls` в callTracker.ts) — память ЭТОГО процесса:
   * trackCall зовут роуты /call и /dial, и события АТС обязаны попадать в ту же
   * карту. Первая версия разделения (этап А3) унесла подписки в worker — агент
   * жал «Позвонить», трекинг ложился в память api, событие «канал закончен»
   * прилетало в worker, и звонок висел «идёт разговор» навсегда.
   */
  startAriEvents();
  // Живой голос — СВОЯ подписка ARI, независимая от startAriEvents(). Пока
  // Settings.liveVoiceEnabled=false, сокет не открывается вовсе.
  startLiveVoiceListener();
  // Исходящие звонки робота — здесь же, рядом с мостом: задание разговора
  // живёт в памяти процесса, который слушает станцию (28.09.2026).
  startLiveVoiceScenarioTicks();
  // Зависшие заготовки звонков и автопрозвон по просьбам — тоже здесь: оба
  // читают или пишут карту живых звонков этого процесса (02.10.2026).
  startCallMemoryTicks();

  /**
   * ДОСЧЁТ РАЗГОВОРОВ, У КОТОРЫХ КОНВЕЙЕР ОБОРВАЛО РЕСТАРТОМ (21.09.2026).
   *
   * Здесь же, где живёт сам конвейер, и ровно по той же причине, что и
   * live-calls-sweep ниже: и стадия «Ищем запись на станции», и очередь
   * расшифровок — память ЭТОГО процесса, и подобрать её за собой может только
   * тот, кто её потерял. В worker обход видел бы чужие живые стадии и снимал
   * честные.
   *
   * РАЗОВО НА СТАРТЕ, А НЕ ТИКОМ. Обход отличает зависшее от живого по наличию
   * задания в очереди, а не по возрасту (у Interaction нет updatedAt — разбор в
   * докстринге самой функции). Живая работа без задания существует ровно двух
   * видов: поиск файла у НЕОТВЕЧЕННОГО разговора и очередь расшифровок, — и
   * обе живут в памяти этого процесса. На старте их заведомо нет, поэтому
   * решение однозначно; тик посреди работы снимал бы стадию у разговора,
   * которым прямо сейчас занимаются.
   *
   * Отказ глушим: не подобрали — не повод не подняться.
   */
  void recoverInterruptedTranscriptionStages()
    .then(({ cleared, requeued }) => {
      if (cleared > 0) {
        console.log(
          `[запись] зависших стадий разговоров снято: ${cleared}, отправлено догонять запись или расшифровку: ${requeued}`
        );
      }
    })
    .catch((err) => console.error("[запись] досчёт зависших стадий:", err instanceof Error ? err.message : err));

  /**
   * КАРТА ОБСЛЕДОВАННОГО — сброс накопленных посещений раз в минуту.
   *
   * Только в HTTP-процессе и по той же причине, что и телефония выше: буфер
   * посещений — память ИМЕННО этого процесса, наполняет его middleware на
   * каждый ответ. В worker сбрасывать было бы нечего — он увидел бы пустой
   * буфер и исправно писал в базу ноль.
   */
  /**
   * СНЯТЬ ЗАХВАТЫ ПРАВОК САЙТА, ОБОРВАННЫЕ ПРЕДЫДУЩИМ ПРОЦЕССОМ (21.09.2026).
   *
   * Разбор уведомления с сайта берёт отметку «разбор начат» в базе, а снимает
   * её тот же самый запрос. Автовыкат перезапускает контейнеры по каждому
   * мержу в main: рестарт посреди синка оставлял правку с отметкой навсегда —
   * повторный «Принять» честно отвечал 409 на то, что никто не разбирал.
   * Досчёт стоит здесь, в процессе, который эти отметки и берёт.
   */
  void releaseInterruptedSiteEditClaims()
    .then((released) => {
      if (released > 0) console.log(`[сайт] Снято оборванных захватов правок: ${released}`);
    })
    .catch((err) => {
      console.error("[сайт] Снятие оборванных захватов правок:", err instanceof Error ? err.message : err);
    });

  /**
   * СБРОС НЕЗАВЕРШЁННЫХ ОТМЕТОК ВЕБХУКОВ ПРИ СТАРТЕ (24.09.2026).
   *
   * Этот процесс (api) — единственный, где смонтирован routes/webhooks.ts, то
   * есть единственный владелец каналов Meta (WhatsApp/Instagram/Facebook),
   * сайта (лид, чат, изменения объявления, обложка) и, когда включён вебхук
   * Telegram (TELEGRAM_WEBHOOK_SECRET задан — прод), самого Telegram. Когда
   * вебхук не настроен, TELEGRAM обслуживает long-polling поллер — тот
   * сбрасывает свою часть сам, см. telegram/poller.ts::startTelegramBot,
   * чтобы не снести отметку, которую как раз ставит ОН, а не HTTP-путь.
   * Разбор и общий принцип — docstring resetIncompleteProcessedMessages.
   */
  const webhookOwnedChannels = [
    "WHATSAPP",
    "INSTAGRAM",
    "FACEBOOK",
    "WEBSITE_LEAD",
    "WEBSITE_CHAT_DELIVERY",
    "SITE_LISTING_CHANGED",
    "SITE_LISTING_DELETED",
    "SITE_COVER_IMAGE",
  ];
  if (process.env.TELEGRAM_WEBHOOK_SECRET) webhookOwnedChannels.push("TELEGRAM");
  void resetIncompleteProcessedMessages(webhookOwnedChannels, "api").catch((err) =>
    console.error("[webhook] сброс незавершённых отметок при старте:", err instanceof Error ? err.message : err)
  );

  startRouteHitFlusher();
  // Досчёт зависших живых звонков — рядом с картой, которую он чистит (в worker
  // этот обход видел бы пустую карту и не снимал бы ни одного «идёт разговор»).
  // Расписание — из общего списка тиков api: по нему сторож пульса в worker
  // знает, что этот тик надо ждать (№171 ночной проверки 24.09).
  scheduleTracked("live-calls-sweep", API_PROCESS_TICKS["live-calls-sweep"], async () => {
    try {
      const stale = await sweepStaleLiveCalls();
      if (stale > 0) console.log(`[cron] Зависших живых звонков в памяти снято: ${stale}`);
    } catch (err) {
      console.error("[cron] Ошибка досчёта живых звонков:", err instanceof Error ? err.message : err);
    }
    // Входящие, конец которых потерял прошлый процесс (рестарт посреди
    // разговора, №222 ночной проверки 24.09): строка журнала без endedAt
    // иначе висит «пропущенным» навсегда. Здесь же — рядом с памятью звонков.
    try {
      const orphans = await closeOrphanedIncomingCalls();
      if (orphans > 0) console.log(`[cron] Входящих без конца после рестарта закрыто: ${orphans}`);
    } catch (err) {
      reportCronTickError("Уборка входящих без конца", err);
    }
  });

  // Кроны, Telegram-поллер — в worker.ts (чертёж каркаса, этап А2). Флаг по
  // умолчанию ВКЛЮЧЁН: без явного ENABLE_BACKGROUND=0 процесс ведёт себя как
  // раньше. Выключается только в compose, где рядом работает контейнер worker:
  // Telegram-поллер обязан жить ровно в одном процессе.
  if (backgroundEnabled()) {
    startBackgroundWork();
  } else {
    console.log("[api] ENABLE_BACKGROUND=0 — кроны и Telegram живут в worker-контейнере");
  }
});

/**
 * МЯГКАЯ СМЕРТЬ ПО SIGTERM (26.08.2026, совет архитектурного ревью).
 *
 * Docker при stop/restart шлёт SIGTERM, а ловился только SIGINT (Ctrl+C в
 * терминале): каждый деплой — а их по несколько в день — рубил запросы на лету
 * без ответа, транзакции откатывались, prisma.$disconnect() не вызывался. Эти
 * «странные одноразовые ошибки» затем всплывали в журнале и будили директора.
 *
 * Порядок: перестать принимать новые соединения → дать текущим запросам
 * дозавершиться (потолок 15 секунд — дольше живут только выгрузки, их не
 * жалко оборвать ради выката) → отключить Prisma → выйти. stop_grace_period
 * в docker-compose.prod.yml обязан быть не меньше этого потолка.
 */
const SHUTDOWN_GRACE_MS = 15_000;
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // повторный сигнал — уже выходим
  shuttingDown = true;
  // ПЕРВАЯ строка обработчика, до всего остального (17.09.2026, shutdownState.ts):
  // фоновые void-задачи (публикация живых событий, пульс кронов, lastContactAt
  // после переписки) проверяют этот флаг и решают «дождаться / тихо пропустить»
  // вместо того, чтобы гонка с закрытием пула Prisma улетала в журнал как баг.
  beginShutdown();
  // Новые тики по расписанию после сигнала не начинаются — ждём только идущие (ниже).
  stopNewTicks();
  console.log(`[shutdown] получен ${signal} — перестаём принимать запросы`);
  const forceExit = setTimeout(() => {
    console.error(`[shutdown] запросы не дозавершились за ${SHUTDOWN_GRACE_MS / 1000}с — выходим жёстко`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();
  // Срок ожидания тиков — от сигнала, а не от закрытия сервера: место под
  // досброс посещений и отключение базы должно остаться (см. ниже).
  const tickWaitUntil = Date.now() + SHUTDOWN_GRACE_MS - 3_000;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Потоки живых событий не кончаются сами — без этого close выше ждал бы
  // все 15 секунд до жёсткого выхода (круг 3, №76, lib/eventBus.ts).
  const streams = closeAllStreams();
  if (streams > 0) console.log(`[shutdown] закрыто потоков живых событий: ${streams}`);
  // Разговоры консультанта — до отключения Prisma и параллельно с закрытием
  // сервера (02.10.2026): звонящего, которого станция прислала вместо
  // автоответчика, отдаём назад станции, остальным кладём трубку. Без этого
  // выкат оставлял человека в мосте без звука. Потолок 5 с — см.
  // shutdownLiveVoiceListener.
  const liveVoice = shutdownLiveVoiceListener(LIVE_VOICE_SHUTDOWN_WAIT_MS).catch(() => 0);
  await closed;
  const liveVoiceEnded = await liveVoice;
  if (liveVoiceEnded > 0) console.log(`[shutdown] разговоров консультанта закрыто: ${liveVoiceEnded}`);
  /**
   * ДОЖДАТЬСЯ ИДУЩИХ ТИКОВ (№172 ночной проверки 24.09). Здесь живут робозвонки
   * живым голосом (lib/telephony/liveVoiceScenarioTicks.ts): номер набран, а
   * отметка «звоним» ещё не записана — обрыв в этот миг означал второй звонок
   * тому же человеку после рестарта. Ждём так же, как worker ждёт задание
   * очереди, но в пределах своего потолка: жёсткий выход выше всё равно сработает.
   */
  while (activeTickCount() > 0 && Date.now() < tickWaitUntil) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (activeTickCount() > 0) console.warn("[shutdown] тик по расписанию не успел дойти — выходим без него");
  // Досбросить накопленные посещения ДО отключения Prisma: иначе на каждом
  // выкате (а их несколько в день) терялась бы последняя минута наблюдений —
  // как раз та, в которую кто-то мог зайти в редкий раздел.
  await flushRouteHits().catch(() => {});
  // Дать фоновым задачам (публикации живых событий и т.п.), начатым ДО сигнала
  // остановки, честно доехать до базы, а не гарантированно словить закрытый
  // пул. Потолок короткий: сама остановка не должна виснуть из-за одной
  // публикации, а SHUTDOWN_GRACE_MS всё равно жёстко оборвёт процесс.
  await drainBackgroundTasks(2_500);
  await prisma.$disconnect().catch(() => {});
  console.log("[shutdown] завершились чисто");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
