import WebSocket from "ws";
import { listActiveChannels, loadAriCredentials, readChannelVariable } from "./ariClient.js";
import type { AriCredentials } from "./ariClient.js";
import {
  applyStationDialResult,
  confirmClientAnswer,
  finishCall,
  getCall,
  reconcileOrphanedOutgoingCalls,
  setCallState,
  collectRecordingAfterFinish,
} from "./callTracker.js";
import type { StationDialResult } from "./callTracker.js";
import { forgetRecordingPath, ingestCallRecording, rememberRecordingPath } from "./callRecordings.js";
import {
  classifyInboundChannel,
  finishIncomingCall,
  isTrackedIncoming,
  markIncomingBridged,
  noteRejectedInbound,
  refreshInboundContexts,
  startIncomingCall,
} from "./incomingCalls.js";
import { reconcileFailoverOnReconnect } from "./failoverSync.js";
import { handleDeskTransferStart, isDeskTransferStart, noteDeskTransferDial } from "./deskTransfer.js";
import { startPingWatchdog } from "./ariPingWatchdog.js";

// Сторож соединения живёт отдельным модулем (24.09.2026): им пользуется и подписка
// живого голоса, и её импорт отсюда замыкал цикл через перевод звонка агенту.
export { startPingWatchdog };
import { reconcileRoutingModeOnReconnect } from "./routingModeSync.js";
import { logSystemError } from "../systemError.js";
import { closeNoAnswerPush } from "../noAnswerStreak.js";
import { prisma } from "../../db.js";
import type { AriEvent } from "./ariTypes.js";

export type { AriChannel, AriEvent } from "./ariTypes.js";

/**
 * Кто из операторов вошёл в мост, пока клиента там ещё не было.
 *
 * События входа в мост приходят по одному на канал, и порядок не гарантирован.
 * Когда оператор оказывается первым, его имя канала (а с ним и внутренний номер)
 * есть ТОЛЬКО в том событии, где мост ещё неполный, — а обрабатывать его рано.
 * Держим имя до второго события; после него забываем.
 *
 * Карта крошечная и живёт секунды, но чистить её всё равно надо: мост, который так
 * и не собрался (оператор снял и сразу положил), иначе оставался бы в ней навсегда.
 */
const operatorChannelByBridge = new Map<string, { name: string; at: number }>();
const OPERATOR_CHANNEL_TTL_MS = 60_000;

function rememberOperatorChannel(bridgeId: string, name: string): void {
  const now = Date.now();
  for (const [id, entry] of operatorChannelByBridge) {
    if (now - entry.at > OPERATOR_CHANNEL_TTL_MS) operatorChannelByBridge.delete(id);
  }
  operatorChannelByBridge.set(bridgeId, { name, at: now });
}

function operatorChannelFor(bridgeId: string): string | undefined {
  return operatorChannelByBridge.get(bridgeId)?.name;
}

function forgetOperatorChannel(bridgeId: string): void {
  operatorChannelByBridge.delete(bridgeId);
}

/**
 * Живая связь с АТС: CRM слушает события станции и знает, что происходит со звонком.
 *
 * До 07.08.2026 этого не было, и получалось странное: агент нажимал «Позвонить»,
 * видел «Сохранено», кнопка снова становилась активной — а звонит ли телефон, ответил
 * ли клиент, сколько идёт разговор, не знал никто. Всё, что CRM могла сказать, — что
 * станция приняла команду.
 *
 * Как это работает. Открывается WebSocket на `/ari/events` с `subscribeAll=true` —
 * тогда события приходят по ВСЕЙ станции, а не только по каналам, которые зашли в
 * Stasis-приложение. Это важно: наши звонки в Stasis не заходят вовсе, они идут
 * штатным диалпланом FreePBX (см. ariClient.ts), и без `subscribeAll` подписка
 * молчала бы.
 *
 * Соединение живёт постоянно и переподключается с нарастающей паузой: у АТС бывает
 * перезагрузка, у туннеля — обрыв, и в такие моменты CRM не должна ни падать, ни
 * заваливать сервер попытками.
 */

/** Имя приложения ARI. Каналы в него не заходят — оно нужно лишь как адрес подписки. */
const ARI_APP = "royal-home-crm";

/**
 * ПЕРВАЯ ПОПЫТКА — БЕЗ ОЖИДАНИЯ, ПОТОЛОК — СЕКУНДЫ, А НЕ МИНУТА (18.08.2026).
 *
 * Разбор станционного лога за неделю: подписка рвалась 30–46 раз в СУТКИ, и между
 * «Deactivating Stasis app 'royal-home-crm'» и «Activating» проходило 4–15 секунд.
 * Всё это время станция пишет «Inactive Stasis app missed message» и выбрасывает
 * событие НАВСЕГДА — ARI ничего не буферизует. Потерянное ChannelCreated — это
 * входящий, которого в CRM не было вовсе: ни карточки, ни перевода на закреплённого
 * агента, ни следа в журнале.
 *
 * Прежние 2 секунды старта и удвоение до минуты этот разрыв и создавали. Обрыв здесь
 * почти всегда единичный (станция готова принять подписку в ту же секунду), а мы
 * ждали — и чем чаще рвалось, тем разогнаннее была унаследованная пауза. Теперь
 * первая попытка идёт в том же тике, а нарастание упирается в 5 секунд: этого хватает,
 * чтобы не долбить лежачую станцию сотнями попыток в секунду, и мало, чтобы потерять
 * поток событий.
 *
 * Отдельной константой — «телефония ещё не настроена»: там спешить некуда, кредов в
 * базе не появится ни через секунду, ни через минуту, а опрос Settings раз в тик
 * впустую грузил бы Postgres.
 */
const RECONNECT_FIRST_MS = 0;
const RECONNECT_STEP_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const NOT_CONFIGURED_RETRY_MS = 60_000;

/**
 * Сколько ждём подъёма TCP+HTTP-рукопожатия до события "open" (13.09.2026).
 *
 * Без этого таймаута зависшее рукопожатие (турникет офис↔сервер уже отмечен
 * ненадёжным в других местах этого файла) не даёт НИ "open", НИ "error", НИ
 * "close" — сокет вечно в CONNECTING, guard на readyState (см. connect(), самое
 * начало) считает соединение живым и блокирует все новые попытки НАВСЕГДА, а
 * тревога (ariAlarm) реагирует только на close/error, не на «так и не открылось».
 * 15 секунд — с запасом над обычным TLS+HTTP upgrade по локальному туннелю, но
 * достаточно быстро, чтобы не держать телефонию слепой всю ночь. `ws` сам
 * закрывает сокет по истечении и эмитит "error" — штатные обработчики ниже
 * снимают guard и планируют переподключение как при любом другом обрыве.
 */
const ARI_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Как часто проверяем, что сокет ещё жив, помимо обычных событий станции.
 *
 * ARI шлёт события НЕРЕГУЛЯРНО — ночью часами может не быть ни одного, и это
 * нормально. Поэтому «нет событий N минут» само по себе не признак смерти;
 * признак — нет ответа на наш собственный ping.
 *
 * 10 СЕКУНД, А НЕ 30, — И ЭТО ГЛАВНАЯ ПРИЧИНА САМИХ ОБРЫВОВ (найдено 18.08.2026).
 *
 * В /etc/asterisk/http_additional.conf станции агентства стоит штатное значение
 * FreePBX `session_inactivity = 30000`: HTTP-сервер Asterisk закрывает сессию (в том
 * числе websocket ARI), если со стороны клиента 30 секунд НИЧЕГО не пришло. Наш ping
 * шёл ровно раз в 30 секунд — то есть мы играли в гонку с таймером станции и
 * регулярно её проигрывали.
 *
 * Доказательство — обратная зависимость числа обрывов от нагрузки: 12.08 при 7730
 * событиях 24 обрыва, 18.08 при 18 событиях — 46. Чем ТИШЕ на станции, тем ЧАЩЕ
 * рвётся: события сами по себе тоже трафик, и в загруженные часы они успевали
 * сбросить таймер бездействия раньше нашего ping. Туннель при этом не перезапускался
 * ни разу (один процесс ssh с 16.08), так что сеть здесь ни при чём.
 *
 * 10 секунд — треть порога станции: даже если один ping потеряется, следующий придёт
 * задолго до 30 секунд. Побочная выгода: худший случай обнаружения полуоткрытого TCP
 * стал 20 секунд вместо минуты.
 */
const PING_INTERVAL_MS = 10_000;

/**
 * Сколько ждём ответа станции на запрос живых каналов после переподписки.
 *
 * Держим коротким намеренно: досинхронизация ценна только пока звонок ещё идёт.
 * Медленный ответ здесь хуже отсутствующего — он задержал бы и следующую попытку.
 */
const RESYNC_TIMEOUT_MS = 5_000;

/**
 * Сколько звонков максимум подхватываем за одну досинхронизацию.
 *
 * Разрыв длится секунды, за них начинается один-два звонка. Десятки — это либо
 * первый запуск процесса после долгого простоя, либо шторм на станции; в обоих
 * случаях заводить сотню карточек разом нельзя.
 */
const RESYNC_PICKUP_LIMIT = 20;

/** Не чаще раза в час одна и та же запись о неудавшейся досинхронизации: обрывы
 *  идут пачками, и журнал забился бы одинаковыми строками (образец — callTracker.ts). */
const RESYNC_LOG_INTERVAL_MS = 60 * 60_000;
let resyncLoggedAt: number | null = null;

/**
 * ТРЕВОГА — ПО ДЛИТЕЛЬНОСТИ ПОТЕРИ СВЯЗИ, А НЕ ПО КАЖДОМУ ОБРЫВУ (12.08.2026).
 *
 * Логирование обрыва завели сегодня осознанно: до него телефония могла лежать
 * сутками молча, и агентство теряло входящие, не зная об этом. Но писалось оно
 * на КАЖДЫЙ обрыв — а обрыв лечится следующей же строкой, переподпиской через
 * две секунды. Гашения не было вовсе, поэтому мёртвые записи копились в журнале
 * и будили директора утренней сводкой каждый день.
 *
 * Считаем то, что важно человеку: сколько времени CRM не видит событий станции.
 * Три минуты без связи — это уже пропущенные входящие, их обязано быть видно.
 * Моргнувший туннель, после которого подписка открылась заново через две
 * секунды, человеку знать не нужно — но в консоли контейнера он остаётся, со
 * временем и причиной, чтобы сетевые проблемы по-прежнему было по чему разбирать.
 *
 * Порог намеренно тот же, что у Telegram-поллера (`telegram/poller.ts`): единый
 * смысл «связи нет дольше трёх минут» понятнее двух разных чисел.
 */
const ALARM_AFTER_SILENCE_MS = 3 * 60_000;

/**
 * Стабильное начало текста тревоги. По нему ищется незакрытая запись при
 * гашении — менять нельзя, иначе тревога перестанет гаснуть.
 */
const ALARM_MESSAGE_PREFIX = "Нет связи с событиями АТС";

/**
 * Куда смотреть по тексту причины — CRM видит только симптом (сокет не
 * открылся/закрылся), а не что именно на станции или в офисе сломалось.
 * Разобрано вживую 19.08.2026 (docs/pbx-tunnel-outage-19-08-2026.md):
 * `ECONNREFUSED` на локальный докер-шлюз VPS означает, что туннель со
 * станции не поднят — виновата станция/сеть офиса, не сама CRM (CRM ничего
 * наружу не открывает, входящих соединений не ждёт). Код 1006 — станция сама
 * оборвала сокет, причина та же категория (обрыв на стороне туннеля).
 */
const SIDE_HINTS: { match: string; label: string }[] = [
  { match: "ECONNREFUSED", label: "туннель со станции не поднят (сторона офиса, не CRM)" },
  { match: "код 1006", label: "станция оборвала соединение (сторона офиса, не CRM)" },
  { match: "ETIMEDOUT", label: "станция/сеть офиса не отвечает (сторона офиса, не CRM)" },
];
const SIDE_HINT_DEFAULT = "причина неясна, разбирать по тексту выше";

/**
 * Сторож связи со станцией: решает, когда обрыв становится поводом для записи в
 * журнал, и гасит тревогу при восстановлении.
 *
 * Вынесен фабрикой (как startPingWatchdog) — проверяется тестами без сети.
 */
export function createAriAlarm(alarmAfterMs: number = ALARM_AFTER_SILENCE_MS): {
  connected(): void;
  lost(reason: string): void;
} {
  /**
   * Начало текущего отказа — первый lost() после последнего connected().
   * Раньше тишина считалась от момента ОТКРЫТИЯ подписки (lastConnectedAt):
   * связь держалась три часа, потом обрыв на две секунды — и первый же lost()
   * видел «три часа без связи», тревога и пуш директорам уходили сразу
   * (E5 глубокой проверки 02.10.2026). Образец — telegram/poller.ts.
   */
  let lostSince: number | null = null;
  let alarmed = false;

  return {
    /** Подписка открыта. Гасит тревогу, если она поднималась. */
    connected(): void {
      const silentSec = lostSince === null ? 0 : Math.round((Date.now() - lostSince) / 1000);
      lostSince = null;
      if (!alarmed) return;
      alarmed = false;
      console.log(`[телефония] связь со станцией восстановлена после ${silentSec} с без событий`);
      void prisma.errorLog
        .updateMany({
          where: { source: "telephony", resolvedAt: null, message: { startsWith: ALARM_MESSAGE_PREFIX } },
          data: { resolvedAt: new Date() },
        })
        .catch((err) => console.error("[телефония] тревога не снята:", err instanceof Error ? err.message : err));
    },

    /** Связь потеряна: обрыв сокета, ошибка сокета, убитый сторожем полуоткрытый TCP. */
    lost(reason: string): void {
      lostSince ??= Date.now();
      const silentMs = Date.now() - lostSince;
      const silentSec = Math.round(silentMs / 1000);
      // Каждый обрыв виден в консоли контейнера — включая те, что до журнала не доходят.
      console.warn(
        `[телефония] ${new Date().toISOString()} связи со станцией нет (${silentSec} с): ${reason} — переподключаемся`
      );
      if (alarmed || silentMs < alarmAfterMs) return;
      alarmed = true;
      // CRM слушает станцию только через обратный туннель со стороны офиса
      // (см. docs/pbx-tunnel-outage-19-08-2026.md) — сама CRM ничего наружу не
      // открывает и не может быть причиной отказа с этой стороны. Причина
      // называется явно в тексте тревоги, чтобы не разбирать заново при каждом
      // повторе, кто виноват: станция/интернет офиса или сама CRM.
      const side = SIDE_HINTS.find((hint) => reason.includes(hint.match))?.label ?? SIDE_HINT_DEFAULT;
      // dedupKey — САМ ALARM_MESSAGE_PREFIX, без числа секунд простоя. Без этого
      // ключ дедупликации строился по первым DEDUP_TEXT_LEN символам текста, а
      // счётчик секунд стоит В НАЧАЛЕ сообщения и растёт на каждый вызов — каждая
      // тревога получалась «новой» и уходила директору заново (15 раз за минуту
      // на проде 15.09.2026). Текст самого сообщения не меняется, ключ — только
      // для сравнения дублей.
      void logSystemError(
        "telephony",
        `${ALARM_MESSAGE_PREFIX} ${silentSec} с подряд: ${reason} — ${side}`,
        { dedupKey: ALARM_MESSAGE_PREFIX }
      );
    },
  };
}

const ariAlarm = createAriAlarm();

let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_FIRST_MS;
let stopped = false;
/** Номер «поколения» подписки: растёт при каждой остановке. connect() сверяет его
 *  после чтения настроек и не открывает сокет по настройкам, прочитанным до остановки
 *  или перезапуска (CHANNEL-NEW-37). */
let connectEpoch = 0;
/**
 * ОТКРЫТИЕ СОЕДИНЕНИЯ ИДЁТ ПРЯМО СЕЙЧАС — ЗАЩИТА ОТ ДВУХ ПАРАЛЛЕЛЬНЫХ ПОДПИСОК.
 *
 * Проверки `socket.readyState` для этого мало: между входом в connect() и
 * присвоением `socket` стоит `await loadAriCredentials()` — поход в Postgres, то есть
 * миллисекунды, за которые успевает пройти второй вызов. А вызовов действительно два
 * и они пересекаются: ws эмитит и `error`, и `close`, плюс тикает таймер переподписки
 * и рядом может лежать restartAriEvents после правки Настроек.
 *
 * Цена ошибки — не лишний сокет, а ДВОЙНАЯ ОБРАБОТКА КАЖДОГО СОБЫТИЯ: две карточки
 * на один входящий, две выгрузки записи со станции, два платных разбора у Gemini.
 * Идемпотентность ниже по течению часть этого гасит (уникальный channelId в
 * IncomingCall), но полагаться на неё как на единственную защиту нельзя.
 *
 * Флаг ставится СИНХРОННО, до первого await, и снимается в finally.
 */
let connecting = false;
/**
 * Сокеты, закрытые НАМЕРЕННО (stopAriEvents, перезапуск после правки Настроек).
 * Их close приходит асинхронно — уже после того, как restartAriEvents снова
 * поставил stopped=false и открыл новый сокет, — и считался обрывом: тревога
 * «нет связи со станцией» и начало окна «не на связи» при живой подписке на
 * каждое сохранение Настроек (E5 глубокой проверки 02.10.2026).
 */
const retiredSockets = new WeakSet<WebSocket>();
/** Таймер запланированной переподписки. Нужен, чтобы close и catch(connect) не
 *  запланировали её дважды — ws эмитит close и после error. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Плечо к САМОМУ СОТРУДНИКУ отдельной функцией больше не ищется: решение принимает
 * classifyDialLeg ниже, и оно одно — «набран клиент или нет».
 * Прежняя функция isAgentLegDial снята 18.08.2026 вместе с логикой «раз не агент —
 * значит клиент»: она и была причиной того, что ответ сотрудника записывался
 * разговором с клиентом.
 */

/**
 * Сравнение набранного номера с номером из CRM по последним девяти цифрам.
 *
 * CRM хранит номера международными (`+992930001001`), станция набирает местные девять
 * (см. normalizeDialNumber). Внутренний номер короче девяти и сравнивается целиком.
 */
function sameNumber(dialed: string | null, stored: string | undefined | null): boolean {
  if (!dialed || !stored) return false;
  const target = stored.replace(/\D/g, "");
  if (!target) return false;
  const tail = (value: string): string => value.slice(-9);
  return dialed === target || tail(dialed) === tail(target);
}

/**
 * Чьё это плечо: клиента, кого-то другого (сотрудника) или непонятно чьё.
 *
 * Решает ТОЛЬКО dialstring — то, что станция явно сообщила как набранное. Запасной
 * источник `peer.dialplan.exten` здесь запрещён намеренно: у отслеживаемого канала
 * (половинка Local) там лежит номер клиента ОБА раза — и когда станция звонит
 * клиенту, и когда она ещё только звонит агенту. Именно на этом ломалась прежняя
 * защита: событие без dialstring считалось «раз не агент — значит клиент», и ответ
 * агента становился разговором.
 *
 *  - "client"  — доказано: набран номер клиента, разговор начался;
 *  - "other"   — доказано обратное: набран кто-то ещё (мобильный или внутренний
 *                сотрудника), это первое плечо, и разговором оно не является;
 *  - "unknown" — станция набранного не назвала. Доказательств нет НИКАКИХ, и
 *                трактовать это как недозвон нельзя: пропавший разговор не увидит
 *                никто, а агент лишится и записи, и балла. Поведение остаётся
 *                прежним (разговор), но помечается неподтверждённым — правду скажет
 *                DIALSTATUS при завершении канала.
 */
export function classifyDialLeg(event: AriEvent, clientPhone: string | undefined): "client" | "other" | "unknown" {
  const raw = event.dialstring ?? "";
  if (!raw) return "unknown";
  /**
   * У LOCAL-КАНАЛА ЗА КОНТЕКСТОМ ИДУТ ФЛАГИ, И РЕЗАТЬ ПО ПОСЛЕДНЕМУ «/» НЕЛЬЗЯ
   * (22.09.2026).
   *
   * Сам originate из CRM набирает `Local/900001042@from-internal/n` (суффикс /n
   * обязателен, см. originateCall в ariClient.ts). Прежний разбор брал всё после
   * ПОСЛЕДНЕГО «/» — то есть букву «n», из неё выходило пустое `dialed`, и плечо к
   * САМОМУ АГЕНТУ объявлялось «непонятно чьим». А «непонятно чьё» + ANSWER — это по
   * нашему же правилу разговор: ответ агента снова становился разговором с клиентом.
   * Ровно это и видно на проде 21–22.09.2026 — пятнадцать «разговоров» по 3–13
   * секунд, у которых плечо к клиенту в CDR станции стоит NO ANSWER.
   *
   * Номер лежит ПЕРЕД «@»: сначала отрезаем контекст с флагами, потом технологию.
   * `SIP/out/910001039` (@ нет) разбирается как и раньше.
   */
  const beforeContext = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  const fromDialstring = beforeContext.includes("/")
    ? beforeContext.slice(beforeContext.lastIndexOf("/") + 1)
    : beforeContext;
  const dialed = fromDialstring.replace(/\D/g, "");
  if (!dialed) return "unknown";
  if (!clientPhone) return "unknown";
  return sameNumber(dialed, clientPhone) ? "client" : "other";
}

/**
 * ANSWEREDTIME в секунды. Asterisk обычно отдаёт целые секунды, но встречается и
 * запись «мм:сс» — без разбора она превратилась бы в минуты, то есть в разговор
 * длиной в одну шестидесятую от настоящего.
 *
 * Отрицательное и абсурдное (больше суток) не берём вовсе: лучше не знать
 * длительность и посчитать её от события, чем записать заведомую чушь.
 */
export function parseAnsweredSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const parts = raw.trim().split(":");
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number.parseInt(part, 10), 0);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 60 * 60) return null;
  return seconds;
}

/**
 * Спросить станцию, чем кончился дозвон клиенту.
 *
 * Отказ ARI (туннель лёг, станция не ответила за таймаут) — в журнал: без этих
 * переменных исход звонка снова становится догадкой, и человек должен об этом знать.
 * Отсутствие переменной или самого канала (он мог исчезнуть раньше, чем мы спросили)
 * — штатный исход, возвращаем пустой результат молча.
 */
/**
 * DIALSTATUS/ANSWEREDTIME, пойманные ЖИВЫМИ — из событий ChannelVarset, пока канал
 * ещё существует (26.08.2026).
 *
 * Послезвонковый опрос переменных (readStationDialResult ниже) почти всегда
 * опаздывает: наши исходящие не заходят в Stasis, приходит только ChannelDestroyed,
 * а к этому моменту GET /channels/{id}/variable отвечает 404 — в журнале десятки
 * записей «DIALSTATUS не прочитан» за день. При этом станция сама объявляет обе
 * переменные событиями Varset в момент завершения Dial — канал жив, значение в руках.
 *
 * ВАЖНО: применять Varset НЕМЕДЛЕННО нельзя. В режиме «на мобильный» Dial
 * выполняется дважды (сначала агенту, потом клиенту), и первый DIALSTATUS=ANSWER —
 * это ответ АГЕНТА: немедленное применение вернуло бы баг «ответ агента записан
 * разговором» (см. историю 18.08 в classifyDialLeg). Поэтому значения только
 * запоминаются — последнее пишется поверх, и к концу канала здесь лежит исход
 * ИМЕННО ВТОРОГО плеча, как и в самой переменной канала. Применение — один раз,
 * в ChannelDestroyed.
 *
 * Запоминаем только для отслеживаемых исходящих (getCall) — карта не растёт на
 * чужих каналах; запись удаляется при завершении канала.
 */
const liveDialVars = new Map<string, { status: string | null; answeredRaw: string | null; at: number }>();

/** Страховка от утечки: если конец канала потерялся (обрыв вебсокета), запись старше
 *  часа никому уже не нужна — ни один звонок столько не длится. */
const LIVE_DIAL_VARS_TTL_MS = 60 * 60 * 1000;

/**
 * ВТОРОЕ ПЛЕЧО → НАШ КАНАЛ (27.08.2026).
 *
 * Асимметрия, из-за которой живой перехват DIALSTATUS срабатывал не всегда: в
 * событии Dial наш канал ищется по ТРЁМ идентификаторам (сам канал, его peer,
 * caller_id) — станция называет инициатором то одно, то другое, в том числе
 * половинку Local-канала. А ChannelVarset искал только по одному, `channelId`.
 * Переменную, объявленную станцией на плече к клиенту, мы в этом случае просто
 * не узнавали своей и выбрасывали — исход звонка снова оставался догадкой по
 * событию Dial, и в журнал ложилось «DIALSTATUS не прочитан» (7 записей в сутки
 * на проде, каждая — час, в котором был хотя бы один такой звонок).
 *
 * Соответствие берём из того же Dial, где обе стороны названы разом. Живёт
 * ровно столько же, сколько запись в liveDialVars, и стирается вместе с ней.
 */
const legOwner = new Map<string, { owner: string; at: number }>();

function rememberLeg(ourChannelId: string, event: AriEvent): void {
  // Тем же приёмом, что и liveDialVars: чистим протухшее на записи, а не таймером —
  // конец канала может и не прийти (обрыв вебсокета), и карта росла бы вечно.
  const cutoff = Date.now() - LIVE_DIAL_VARS_TTL_MS;
  for (const [id, e] of legOwner) if (e.at < cutoff) legOwner.delete(id);
  // `caller` — штатное поле события Dial (см. DIAL_EVENT_HAS_NO_CHANNEL ниже);
  // без него плечо к провайдеру не попадало в карту и DIALSTATUS, объявленный на
  // нём, мы своим не узнавали.
  for (const id of [event.channel?.id, event.caller?.id, event.peer?.id]) {
    if (id && id !== ourChannelId) legOwner.set(id, { owner: ourChannelId, at: Date.now() });
  }
}

/** Чей это канал: наш отслеживаемый или плечо нашего звонка. */
function ownerChannelFor(channelId: string): string | undefined {
  if (getCall(channelId)) return channelId;
  const owner = legOwner.get(channelId)?.owner;
  return owner && getCall(owner) ? owner : undefined;
}

function forgetLegsOf(ourChannelId: string): void {
  for (const [leg, e] of legOwner) if (e.owner === ourChannelId) legOwner.delete(leg);
}

function rememberLiveDialVar(channelId: string, variable: string, value: string): void {
  const cutoff = Date.now() - LIVE_DIAL_VARS_TTL_MS;
  for (const [id, e] of liveDialVars) if (e.at < cutoff) liveDialVars.delete(id);
  const entry = liveDialVars.get(channelId) ?? { status: null, answeredRaw: null, at: Date.now() };
  entry.at = Date.now();
  if (variable === "DIALSTATUS") {
    entry.status = value;
    // ANSWEREDTIME от ПРЕДЫДУЩЕГО плеча к новому исходу не относится.
    entry.answeredRaw = null;
  } else {
    entry.answeredRaw = value;
  }
  liveDialVars.set(channelId, entry);
}

/** Забрать (и забыть) пойманный живьём итог дозвона; null — Varset не приходил. */
function takeLiveDialResult(channelId: string): StationDialResult | null {
  const entry = liveDialVars.get(channelId);
  liveDialVars.delete(channelId);
  if (!entry || !entry.status) return null;
  return {
    status: entry.status,
    answeredSeconds: entry.status === "ANSWER" ? parseAnsweredSeconds(entry.answeredRaw) : null,
  };
}

/** Каналы, чей конец уже обрабатывается (между проверкой «звонок идёт» и `ended`). */
const finishingChannels = new Set<string>();

/** Пауза перед единственным повтором запроса DIALSTATUS — см. readStationDialResult. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStationDialResult(channelId: string): Promise<StationDialResult> {
  const empty: StationDialResult = { status: null, answeredSeconds: null };
  try {
    const creds = await loadAriCredentials();
    if (!creds) return empty;
    /**
     * ОДИН БЫСТРЫЙ ПОВТОР (15.09.2026).
     *
     * К моменту этого опроса канал почти закрыт (событие пришло уже после
     * ChannelDestroyed/StasisEnd) — GET /channels/{id}/variable у станции
     * нередко падает не потому, что переменной нет, а потому, что канал в
     * этот самый миг дочищается. Без повтора итог звонка засчитывался по
     * менее надёжному признаку (откат ниже вызывающим кодом — не менялся)
     * чаще, чем нужно. Пауза короткая и всего одна: если канал правда ушёл,
     * повтор его не вернёт, а ждать дольше здесь бессмысленно.
     */
    let status: string | null;
    try {
      status = await readChannelVariable(creds, channelId, "DIALSTATUS");
    } catch {
      await sleep(200);
      status = await readChannelVariable(creds, channelId, "DIALSTATUS");
    }
    if (!status) return empty;
    if (status !== "ANSWER") return { status, answeredSeconds: null };
    // ANSWEREDTIME спрашиваем только у состоявшегося разговора — лишний запрос к
    // станции на каждом недозвоне не нужен.
    const answered = await readChannelVariable(creds, channelId, "ANSWEREDTIME");
    return { status, answeredSeconds: parseAnsweredSeconds(answered) };
  } catch (err) {
    void logSystemError(
      "telephony",
      `Итог дозвона у станции не спрошен (DIALSTATUS канала ${channelId}): ${err instanceof Error ? err.message : err}`, { dedupKey: "Итог дозвона у станции не спрошен (DIALSTATUS канала …): …" }
    );
    return empty;
  }
}

/**
 * Разбор одного события. Вынесен отдельно от сокета, чтобы проверяться тестами на
 * образцах событий, без живой станции.
 *
 * Что чем считается:
 *  - наш канал перешёл в Up — агент снял трубку, станция набирает клиента;
 *  - Dial завершился с ANSWER — клиент ответил, пошёл разговор;
 *  - канал уничтожен — звонок кончился, считаем итог и дописываем в хронологию.
 *
 * Здесь же ловятся ВХОДЯЩИЕ звонки — те, что CRM не начинала (см. incomingCalls.ts).
 * С 16.08.2026 звонок известного клиента может быть уведён его ответственному агенту
 * (incomingCalls.ts → inboundRouting.ts) — но решает это отдельный модуль, а не
 * обработчик событий: здесь по-прежнему только разбор того, что сообщила станция.
 */
export async function handleAriEvent(event: AriEvent): Promise<void> {
  const channelId = event.channel?.id;

  switch (event.type) {
    case "ChannelCreated": {
      // Звонок снаружи. Наши исходящие сюда не попадают: они идут контекстом
      // `from-internal`, а входящие — транковым (см. incomingCalls.ts).
      if (!event.channel) return;
      // Наш собственный исходящий — норма, а не отбраковка: в счётчик не идёт,
      // иначе он показывал бы работу CRM как проблему станции.
      if (getCall(event.channel.id)) return;
      const verdict = classifyInboundChannel(event.channel);
      if (!verdict) return;
      if (!verdict.inbound) {
        // Раньше здесь стоял молчаливый `return`, и отброшенный звонок не оставлял
        // следа НИГДЕ — ни в журнале, ни на дашборде (см. noteRejectedInbound).
        noteRejectedInbound(event.channel, verdict.reason);
        return;
      }
      await startIncomingCall(event.channel);
      return;
    }
    case "ChannelEnteredBridge": {
      // Единственный надёжный признак, что до оператора дошло: каналы соединили.
      // Сам по себе ответ станции им не является — очередь отвечает на звонок,
      // чтобы играть музыку ожидания, и брошенный в очереди звонок иначе
      // выглядел бы обслуженным.
      //
      // Событие приходит на КАЖДЫЙ вошедший канал, и порядок не гарантирован:
      // первым в мост попадает то клиент, то оператор. Поэтому ищем свой звонок
      // среди всех участников моста, а вошедшим считаем того, о ком событие, —
      // если это не сам клиент, значит трубку снял оператор, и его имя канала
      // говорит, кто именно.
      const participants = (event.bridge as { channels?: string[] } | undefined)?.channels ?? [];

      /**
       * Имя канала оператора запоминаем СРАЗУ, даже когда мост ещё неполный.
       *
       * Оператор нередко попадает в мост первым: его событие приходит с одним
       * участником и отсеивается проверкой ниже, а во втором событии речь уже о
       * канале клиента — имени оператора в нём нет. Так терялся внутренний номер:
       * в журнале пустела колонка «кто снял», а из записи в хронологии пропадало
       * «(1001)». Исправить это вторым событием нельзя — мешает признак bridgedAt.
       */
      const bridgeId = (event.bridge as { id?: string } | undefined)?.id;
      if (bridgeId && channelId && !isTrackedIncoming(channelId) && event.channel?.name) {
        rememberOperatorChannel(bridgeId, event.channel.name);
      }

      const inbound = participants.find((id) => isTrackedIncoming(id));
      if (!inbound || participants.length < 2) return;
      const operatorName =
        channelId === inbound ? (bridgeId ? operatorChannelFor(bridgeId) : undefined) : event.channel?.name;
      markIncomingBridged(inbound, operatorName);
      if (bridgeId) forgetOperatorChannel(bridgeId);
      return;
    }
    case "ChannelStateChange": {
      if (!channelId || !getCall(channelId)) return;
      if (event.channel?.state === "Up") setCallState(channelId, "ringing_client");
      return;
    }
    case "StasisStart": {
      // Оператор перевёл звонок с офисного телефона кодом 7+номер объекта
      // (24.09.2026, deskTransfer.ts): станция отдала канал звонящего сюда.
      if (isDeskTransferStart(event)) await handleDeskTransferStart(event);
      return;
    }
    case "Dial": {
      // Звонок агенту после перевода с офисного телефона — свой разбор исхода.
      if (await noteDeskTransferDial(event)) return;
      // Событие Dial приходит и на начало, и на завершение дозвона. Начальное —
      // без dialstatus вовсе (станция ещё звонит); нас интересует именно завершение
      // второго плеча, тем или иным исходом.
      if (!event.dialstatus) return;
      /**
       * DIAL_EVENT_HAS_NO_CHANNEL — У СОБЫТИЯ Dial ПОЛЯ `channel` НЕТ ВООБЩЕ
       * (22.09.2026, сверено со схемой САМОЙ СТАНЦИИ: /var/lib/asterisk/rest-api/events.json,
       * событие Dial → поля `caller` (необязательное), `peer` (обязательное),
       * `forward`, `forwarded`, `dialstring`, `dialstatus`).
       *
       * Инициатор дозвона называется полем `caller`, а не `channel`. Прежний список
       * искал наш канал в `channel` (которого тут не бывает) и в `caller_id` (такого
       * поля у ARI нет ни у одного события) — то есть фактически ТОЛЬКО в `peer`.
       *
       * Чем это кончалось на исходящем звонке CRM. Отслеживаемый канал — половинка
       * `Local/<агент>@from-internal;1`, которую вернул originate:
       *  1. Dial самого originate: `peer` = наша половинка → звонок узнан, но
       *     dialstring — `Local/900001042@from-internal/n`, и это плечо К АГЕНТУ;
       *  2. Dial к КЛИЕНТУ станция выполняет НА нашей же половинке: `caller` = наш
       *     канал, `peer` = `SIP/out-XXXX` (плечо провайдера, ни разу не наше). Наш
       *     канал искался только в `peer` — не находился, и обработка обрывалась
       *     первой же строкой. Ни ANSWER, ни NOANSWER клиента до callTracker не
       *     доходили НИКОГДА, отсюда и «DIALSTATUS не прочитан» в утреннем отчёте.
       *
       * Оба поля оставлены: `channel` — на случай сборок, где оно всё-таки приходит,
       * `peer` — это по-прежнему наш канал у Dial самого originate.
       */
      const ours = [event.channel?.id, event.caller?.id, event.peer?.id].find(
        (id) => id && getCall(id)
      );
      if (!ours) return;
      // Пока станция назвала обе стороны разом — запоминаем, чьё это плечо: дальше
      // DIALSTATUS может прийти именно на него (см. legOwner).
      rememberLeg(ours, event);
      /**
       * РАЗГОВОР НАЧИНАЕТСЯ ТОЛЬКО ПРИ ПОЛОЖИТЕЛЬНОМ СОВПАДЕНИИ С НОМЕРОМ КЛИЕНТА.
       *
       * ПЛЕЧО К САМОМУ СОТРУДНИКУ — ЭТО НЕ РАЗГОВОР С КЛИЕНТОМ.
       *
       * В режиме «на мобильный» станция тратит на один звонок ДВА вызова наружу:
       * сначала звонит сотруднику, и только когда тот снял трубку — клиенту. На
       * каждый приходит свой Dial с ANSWER, и первый из них — ответ сотрудника.
       *
       * Пока разницы не было, ответ сотрудника засчитывался как ответ клиента, и
       * дальше разваливалось всё: недозвон записывался «поговорили», в карточку
       * шла запись из одних гудков, за её расшифровку платили, серия перезвонов не
       * заводилась. Живой случай 13.08.2026: клиент не ответил 41 секунду, а в CRM
       * звонок лежит разговором на 42 секунды.
       *
       * Сравниваем по НАБРАННОМУ номеру: `dialingTo` — это то, куда станция звонит
       * сотруднику (его мобильный или внутренний), и оно известно с момента команды.
       * Если набранное совпало — молчим и ждём следующего Dial, к клиенту.
       *
       * ПРАВИЛО «РАЗ ЭТО НЕ АГЕНТ — ЗНАЧИТ КЛИЕНТ» УБРАНО 18.08.2026. Оно и было
       * дырой: событие без dialstring не опознавалось как плечо к агенту (номер
       * брался из peer.dialplan.exten, а там номер клиента в обоих плечах) и
       * проваливалось в «разговор». За неделю на станции десятки BUSY/NO ANSWER, а в
       * базе — ни одного исхода «Клиент не ответил»; длительности в карточках ровно
       * совпадали с плечом к агенту.
       *
       * Теперь неопознанный Dial не даёт ничего, и это безопасно: настоящий ответ
       * клиента всё равно не потеряется — при завершении канала исход берётся из
       * DIALSTATUS/ANSWEREDTIME самой станции (см. ChannelDestroyed ниже).
       */
      const leg = classifyDialLeg(event, getCall(ours)?.clientPhone);
      // Набран сотрудник — ждём следующего Dial, к клиенту.
      if (leg === "other") return;
      if (event.dialstatus === "ANSWER") {
        setCallState(ours, "talking");
        // Совпал номер клиента — это доказательство. Неопознанное плечо остаётся
        // догадкой: разговор засчитан (как и раньше), но перебивается положительным
        // доказательством недозвона из DIALSTATUS и попадает в журнал как сигнал.
        if (leg === "client") {
          confirmClientAnswer(ours);
          // Подтверждаем ответ станцией СРАЗУ, тем же путём, что и итоговый DIALSTATUS
          // (applyStationDialResult) — не дожидаясь послезвонкового опроса канала,
          // который читает переменные уже после ChannelDestroyed (см. ниже).
          applyStationDialResult(ours, { status: "ANSWER", answeredSeconds: null });
          // Клиент ответил — серия недозвонов оборвана, эскалация руководству
          // (если была) больше не актуальна (владелец 19.08.2026).
          const clientId = getCall(ours)?.clientId;
          if (clientId) {
            void closeNoAnswerPush(clientId).catch((err) =>
              void logSystemError("telephony", `Не удалось закрыть пуш «не отвечает»: ${err instanceof Error ? err.message : err}`, { dedupKey: "Не удалось закрыть пуш «не отвечает»: …" })
            );
          }
        }
        return;
      }
      /**
       * ТЕРМИНАЛЬНЫЙ Dial БЕЗ ОТВЕТА — ЭТО И ЕСТЬ DIALSTATUS ВТОРОГО ПЛЕЧА (19.08.2026).
       *
       * До сих пор исход недозвона (BUSY/NOANSWER/CONGESTION/CHANUNAVAIL/CANCEL) не
       * читался отсюда вовсе — старая проверка `if (event.dialstatus !== "ANSWER") return`
       * в начале case отбрасывала ЛЮБОЕ такое событие, и единственным источником
       * оставался послезвонковый `readStationDialResult` (см. ниже), который спрашивает
       * переменную канала ПОСЛЕ события ChannelDestroyed/StasisEnd. А наши исходящие
       * никогда не заходят в Stasis-приложение (originate сразу в диалплан, см.
       * ariClient.ts) — StasisEnd для них не приходит вовсе, приходит только
       * ChannelDestroyed, и по семантике ARI канал к этому моменту УЖЕ уничтожен:
       * GET /channels/{id}/variable почти всегда отвечает 404, readChannelVariable
       * трактует это как «переменной нет» и результат уходит в лог «DIALSTATUS не
       * прочитан» — что и происходило практически на каждом звонке (десятки записей в
       * журнале за один день). Событие Dial несёт этот же исход НАПРЯМУЮ, канал в этот
       * момент ещё жив — читать переменную позже не нужно вовсе.
       */
      if (leg === "client" && event.dialstatus) {
        applyStationDialResult(ours, { status: event.dialstatus, answeredSeconds: null });
      }
      return;
    }
    case "ChannelVarset": {
      // Asterisk сам сообщает, куда пишет разговор. Угадывать имя файла по дате и
      // номеру нельзя: FreePBX собирает его из внутреннего uniqueid канала, и
      // совпадение подсунуло бы в карточку чужой разговор (см. callRecordings.ts).
      if (!channelId || typeof event.value !== "string") return;
      if (event.variable === "MIXMONITOR_FILENAME") {
        rememberRecordingPath(channelId, event.value);
        return;
      }
      // Итог дозвона ловим живьём — после ChannelDestroyed переменную уже не спросить
      // (см. liveDialVars). Только запоминаем: применять сразу нельзя, первый
      // DIALSTATUS=ANSWER — это ответ агента, а не клиента.
      if ((event.variable === "DIALSTATUS" || event.variable === "ANSWEREDTIME") && event.value) {
        // Переменная приходит и на канал агента, и на плечо к клиенту — оба наши
        // (см. legOwner). Складываем под идентификатором отслеживаемого канала:
        // разбирать их порознь нечего, к концу звонка нужен последний исход.
        const owner = ownerChannelFor(channelId);
        if (owner) rememberLiveDialVar(owner, event.variable, event.value);
      }
      return;
    }
    case "ChannelDestroyed":
    case "StasisEnd": {
      if (!channelId) return;
      // Входящий и исходящий — разные звонки с разными итогами; один и тот же
      // канал обоими быть не может, поэтому ветки не мешают друг другу.
      if (isTrackedIncoming(channelId)) {
        /**
         * КОНЕЦ ВХОДЯЩЕГО — ТОЛЬКО ChannelDestroyed (24.09.2026, робозвонок).
         * Входящий канал в Stasis-приложении этой подписки не бывает никогда, и
         * StasisEnd у него раньше не приходил вовсе. Теперь его берёт консультант
         * (приложение royalhome-live-voice): StasisEnd приходит, когда консультант
         * соединяет человека с агентом или отдаёт станции, — звонок при этом идёт
         * дальше, и закрыть его здесь значило бы потерять разговор с агентом.
         */
        if (event.type === "StasisEnd") return;
        const finished = await finishIncomingCall(channelId);
        /**
         * РАЗГОВОР ОПЕРАТОРА ИДЁТ ПО ТОМУ ЖЕ КОНВЕЙЕРУ, ЧТО И ЗВОНОК АГЕНТА:
         * запись → расшифровка → перевод → предложение по карточке → разбор
         * качества → ночные сводки → обучение бота.
         *
         * До этого входящие уходили отсюда сразу, и всё перечисленное их не
         * касалось. А это самый чистый материал «как у нас отвечают»: клиент
         * позвонил сам, значит говорит по делу, и половина таких разговоров — это
         * первое касание с агентством.
         *
         * ФАЙЛ ИЩЕТСЯ ПО КАТАЛОГУ — ЭТО ОСНОВНОЙ ПУТЬ, А НЕ ЗАПАСНОЙ.
         *
         * Здесь долго стояло обратное утверждение: «FreePBX сама сообщает путь
         * переменной MIXMONITOR_FILENAME, поиск не нужен». На живых событиях
         * 11.08.2026 этой переменной не оказалось — станция шлёт только
         * TOUCH_MONITOR с внутренним uniqueid (см. шапку callRecordings.ts). Пока
         * комментарий считался правдой, запись ВХОДЯЩЕГО разговора не находилась
         * НИКОГДА: у входящих не было ни имени файла, ни поиска.
         *
         * Путь из переменной по-прежнему предпочитается, если он всё-таки пришёл
         * (на других сборках Asterisk приходит, и он точнее любого поиска) — этим
         * занимается сам ingestCallRecording. Отдельная причина не полагаться на
         * него у очереди: Varset может прийти на канал Local или SIP оператора, а
         * не на канал транка, по которому запомнен путь.
         *
         * Внутренний номер агента в поиск НЕ передаётся: в именах записей очереди
         * его нет. Данные берутся из возврата finishIncomingCall, а не из живой
         * карты: она к этому моменту уже может быть очищена.
         *
         * Только у состоявшихся разговоров: у недозвона файла нет и не будет.
         */
        // Разговор консультанта пишет и разбирает сам консультант (запись в R2,
        // расшифровка из разговора): на станции файла нет, искать нечего.
        if (finished?.interactionId && finished.answered && !finished.byConsultant) {
          void ingestCallRecording({
            channelId,
            interactionId: finished.interactionId,
            durationSec: finished.talkSeconds,
            // У входящего «ответил» означает соединённый мост оператора с клиентом —
            // разговор действительно был, и пустая запись здесь правда странность.
            clientAnswered: true,
            search: {
              startedAt: finished.startedAt,
              answeredAt: finished.answeredAt ?? undefined,
              clientPhone: finished.phone,
              direction: "incoming",
            },
          });
        } else {
          // Иначе путь остался бы в карте pendingPaths навсегда: до этой строки
          // входящие её только наполняли, и на каждый непринятый звонок в памяти
          // процесса оставалась запись.
          forgetRecordingPath(channelId);
        }
        return;
      }
      // Завершённый звонок живёт в памяти ещё 20 секунд (KEEP_ENDED_MS) — чтобы
      // агент увидел итог на экране. Поэтому «звонок ещё в карте» не значит «звонок
      // ещё идёт»: второе событие конца того же канала (станция прислала оба, или
      // оборвался и переподключился вебсокет) проходило проверку заново и запускало
      // выгрузку записи повторно — лишняя закачка файла со станции, второй платный
      // разбор у Gemini и второе предложение по карточке на один разговор.
      const tracked = getCall(channelId);
      if (!tracked || tracked.state === "ended") return;
      // Но `ended` finishCall ставит только после await ниже (опрос станции), и второе
      // событие конца, пришедшее за это время, проходило ту же проверку: запись
      // забиралась дважды (CALL-02, 04.10.2026). Канал занимается синхронно.
      if (finishingChannels.has(channelId)) return;
      finishingChannels.add(channelId);
      try {
        /**
         * ИТОГ ВТОРОГО ПЛЕЧА СПРАШИВАЕМ У СТАНЦИИ, А НЕ ВЫВОДИМ ИЗ СОБЫТИЙ.
         *
         * Основной источник — DIALSTATUS/ANSWEREDTIME, пойманные живыми Varset-событиями
         * (liveDialVars): к последнему из них в записи лежит исход именно второго плеча.
         * Послезвонковый HTTP-опрос оставлен запасным путём — по семантике ARI канал в
         * этот момент уже уничтожен и почти всегда отвечает 404, отчего журнал заполняли
         * записи «DIALSTATUS не прочитан, разговор засчитан по событию Dial».
         */
        const dialResult = takeLiveDialResult(channelId) ?? (await readStationDialResult(channelId));
        forgetLegsOf(channelId);
        applyStationDialResult(channelId, dialResult);
        // Запись забирается после звонка и в фоне: разговор уже кончился, торопиться
        // некуда, а обработчик событий должен оставаться свободным для следующих.
        // Тот же путь, что у подметалки и сверки после переподписки (callTracker.ts).
        // Тревожить людей пустой записью можно, только когда клиент ТОЧНО ответил —
        // это подтверждает сама станция, а не наша догадка по событиям.
        collectRecordingAfterFinish(channelId, await finishCall(channelId), dialResult.status === "ANSWER");
      } finally {
        finishingChannels.delete(channelId);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Как часто перечитывается список входящих контекстов из Настроек.
 *
 * Одного чтения при открытии подписки мало: соединение с исправной станцией живёт
 * сутками, и настройка, сохранённая директором, не применилась бы до ближайшего
 * обрыва — то есть, возможно, никогда.
 */
const INBOUND_CONTEXTS_REFRESH_MS = 5 * 60_000;
let contextsTimer: ReturnType<typeof setInterval> | null = null;

/** Подписку хоть раз открывали в этом процессе. Тесты и разовые скрипты её не
 *  запускают — им и перезапускать нечего. */
let everStarted = false;

/** Открыть подписку. Вызывается один раз при старте API. */
/**
 * Есть ли прямо сейчас живая подписка на события станции.
 *
 * Нужна интерфейсу: сотрудник должен видеть, дойдут ли до него звонки, а не
 * узнавать об обрыве по тишине в трубке. Смотрим на само соединение, а не на
 * время последнего события: ночью событий нет вовсе, но связь при этом рабочая.
 */
export function isStationConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/**
 * С какого момента станция не на связи — для решений, которым важно не «сейчас
 * отключено», а «отключено дольше N минут» (firstCall.ts, штраф за срыв первого
 * звонка, 15.09.2026).
 *
 * Отдельная переменная, а не переиспользование `lastConnectedAt` из createAriAlarm:
 * тот счётчик приватный внутри фабрики и существует для другой цели (гасить тревогу
 * по тексту сообщения). Здесь достаточно памяти процесса — при перезапуске подписка
 * открывается заново, а вместе с ней и это состояние, миграция схемы не нужна.
 *
 * Инициализируется моментом старта модуля: до первого успешного `open` станция
 * тоже официально «не на связи», и это должно быть видно тем же способом, а не
 * отдельным условием «подписка ещё не запускалась».
 */
let disconnectedSince: number | null = Date.now();

/** Сколько миллисекунд подряд станция не на связи. 0, если связь есть сейчас. */
export function stationDownForMs(now: number = Date.now()): number {
  if (isStationConnected()) return 0;
  return now - (disconnectedSince ?? now);
}

/** Не на связи дольше `ms` — то, что нужно вызывающему коду, без арифметики снаружи. */
export function isStationDownLongerThan(ms: number): boolean {
  return stationDownForMs() >= ms;
}

export function startAriEvents(): void {
  stopped = false;
  everStarted = true;
  // Лестница задержек начинается заново: после ручного перезапуска (правка Настроек)
  // ждать разогнанную с прошлого раза паузу незачем.
  reconnectDelay = RECONNECT_FIRST_MS;
  void refreshInboundContexts();
  if (!contextsTimer) {
    contextsTimer = setInterval(() => void refreshInboundContexts(), INBOUND_CONTEXTS_REFRESH_MS);
    contextsTimer.unref?.();
  }
  void connect();
}

/** Закрыть подписку (тесты, корректное завершение процесса). */
export function stopAriEvents(): void {
  stopped = true;
  connectEpoch += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (contextsTimer) {
    clearInterval(contextsTimer);
    contextsTimer = null;
  }
  if (socket) retiredSockets.add(socket);
  socket?.close();
  socket = null;
}

/**
 * Перезапустить подписку: настройки телефонии изменились (адрес ARI, логин, пароль,
 * список входящих контекстов). Без этого правка в Настройках подхватывалась только
 * при следующем обрыве соединения, то есть на исправной станции — никогда.
 */
export function restartAriEvents(): void {
  if (!everStarted) return;
  stopAriEvents();
  startAriEvents();
}

/**
 * ДОСИНХРОНИЗАЦИЯ ПОСЛЕ ОБРЫВА: СПРОСИТЬ СТАНЦИЮ, ЧТО У НЕЁ В ЭФИРЕ (18.08.2026).
 *
 * Быстрая переподписка сокращает окно слепоты, но НЕ ЗАКРЫВАЕТ его: даже за одну
 * секунду успевает прийти ChannelCreated, а ARI ничего не буферизует — событие,
 * выброшенное с пометкой «Inactive Stasis app missed message», не придёт уже никогда.
 * Единственный способ узнать о таком звонке — сразу после открытия подписки спросить
 * станцию, какие каналы живы, и сверить со своей памятью.
 *
 * ПОЧЕМУ ЭТО БЕЗОПАСНО ПОВТОРЯТЬ. Все три отсева — свои исходящие (`getCall`), уже
 * известные входящие (`isTrackedIncoming`), отбраковка по контексту
 * (`classifyInboundChannel`) — те же, что и в обычном пути ChannelCreated. А
 * `startIncomingCall` идемпотентен дважды: по живой карте (`live.has`) и по
 * уникальному `channelId` в таблице IncomingCall. Поэтому досинхронизация,
 * запущенная на КАЖДОМ открытии подписки (в том числе десятый раз подряд при
 * моргающем туннеле), второй карточки на один звонок не заводит.
 *
 * ПОЧЕМУ ПОДХВАТ, А НЕ ТОЛЬКО ЗАПИСЬ В ЖУРНАЛ. Полноценно подхватить можно: всё,
 * что нужно startIncomingCall, — это сам объект канала, и /ari/channels отдаёт его в
 * ТОЙ ЖЕ форме, что и события (см. AriChannelSnapshot). Разница ровно одна: началом
 * звонка считается момент подхвата, а не настоящий момент звонка — то есть отсчёт
 * ожидания в панели оператора занижен на длину разрыва (секунды). Это неизбежная
 * плата и она несопоставима с прежним «звонка не было вовсе».
 *
 * Отказ станции — в журнал с гашением: обрывы идут пачками, и без гашения одна
 * недоступная станция за ночь дала бы сотню одинаковых записей.
 */
export async function resyncActiveChannels(creds: AriCredentials): Promise<void> {
  let channels;
  try {
    channels = await listActiveChannels(creds, RESYNC_TIMEOUT_MS);
  } catch (err) {
    const message = `Живые каналы у станции не спрошены после переподписки: ${err instanceof Error ? err.message : err}`;
    const now = Date.now();
    if (resyncLoggedAt === null || now - resyncLoggedAt >= RESYNC_LOG_INTERVAL_MS) {
      resyncLoggedAt = now;
      void logSystemError("telephony", message);
    } else {
      console.warn(`[телефония] ${new Date().toISOString()} ${message} (о том же уже записано в журнал)`);
    }
    return;
  }

  // Обратное направление: наши ИСХОДЯЩИЕ звонки, которых станция среди живых
  // каналов больше не называет, — закончились, пока подписки не было, и без
  // этого блокировали бы агенту любой следующий звонок навсегда (см. докстринг
  // reconcileOrphanedOutgoingCalls). Перед сравнением, а не после раннего
  // return ниже — иначе при пустом missed эта сверка вообще не запускалась бы.
  void reconcileOrphanedOutgoingCalls(new Set(channels.map((c) => c.id))).catch((err) =>
    console.error("[телефония] сверка исходящих после переподписки:", err)
  );

  // Сначала ОТБИРАЕМ, потом обрабатываем: перебор списка в памяти дёшев, а к базе
  // ходит только подхват. В норме отобранных ноль, и ни одного запроса не будет.
  const missed = channels
    .filter((channel) => !getCall(channel.id) && !isTrackedIncoming(channel.id))
    .filter((channel) => classifyInboundChannel(channel)?.inbound === true)
    .slice(0, RESYNC_PICKUP_LIMIT);
  if (missed.length === 0) return;

  /**
   * Подхват ПОСЛЕДОВАТЕЛЬНЫЙ, и это осознанно, а не недосмотр про N+1.
   *
   * startIncomingCall пишет строку журнала, ищет клиента и шлёт push — параллельный
   * запуск двух десятков таких цепочек в момент восстановления связи ударил бы по
   * тому же Postgres, чья секундная просадка нередко и роняет подписку. Список
   * ограничен RESYNC_PICKUP_LIMIT, так что это не проход по выборке из базы, а
   * заведомо короткая очередь.
   */
  for (const channel of missed) {
    console.warn(
      `[телефония] ${new Date().toISOString()} звонок с ${channel.caller?.number ?? "неизвестного номера"} ` +
        `(канал ${channel.id}) начался в разрыв связи и подхвачен досинхронизацией`
    );
    try {
      await startIncomingCall(channel);
    } catch (err) {
      // Один сорвавшийся подхват не должен уносить с собой остальные: следующий
      // звонок в списке может быть тем самым, ради которого всё и затевалось.
      void logSystemError(
        "telephony",
        `Звонок ${channel.id} с ${channel.caller?.number ?? "?"} начался в разрыв связи, но не подхвачен: ` +
          `${err instanceof Error ? err.message : err}`, { dedupKey: "Звонок … с … начался в разрыв связи, но не подхвачен: …" }
      );
    }
  }
}

async function connect(): Promise<void> {
  if (stopped) return;
  // См. флаг connecting: параллельное открытие даёт ДВА сокета и двойную обработку
  // каждого события. Проверка обязана стоять до первого await.
  if (connecting) return;
  // Второй вызов при уже живом (или ещё открывающемся) сокете не должен плодить
  // параллельное соединение — connect() зовётся и из startAriEvents, и из
  // переподписки, и эти пути иногда пересекаются.
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

  connecting = true;
  const epoch = connectEpoch;
  // Перезапуск во время чтения настроек: его connect() отброшен флагом `connecting`,
  // значит, подключение нужно начать заново, уже по свежим настройкам.
  let startAgain = false;
  try {
    const creds = await loadAriCredentials();
    if (epoch !== connectEpoch) {
      startAgain = !stopped;
      return;
    }
    if (!creds) {
      // Телефония ещё не настроена — это не ошибка, просто ждём. Проверяем реже, чем
      // переподключаемся при обрыве: настройки появляются раз в жизни агентства.
      scheduleReconnect(NOT_CONFIGURED_RETRY_MS);
      return;
    }

    const url = new URL(`${creds.url}/ari/events`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("app", ARI_APP);
    // Без этого события приходили бы только по каналам внутри Stasis-приложения,
    // а наши звонки идут штатным диалпланом FreePBX и туда не заходят.
    url.searchParams.set("subscribeAll", "true");
    url.searchParams.set("api_key", `${creds.username}:${creds.password}`);

    const ws = new WebSocket(url.toString(), { handshakeTimeout: ARI_HANDSHAKE_TIMEOUT_MS });
    socket = ws;
    let watchdog: ReturnType<typeof startPingWatchdog> | undefined;

    ws.on("open", () => {
      // Связь поднялась — лестницу задержек сбрасываем в начало: следующий обрыв
      // снова получит мгновенную первую попытку, а не унаследует разогнанную паузу.
      reconnectDelay = RECONNECT_FIRST_MS;
      console.log("[телефония] подписка на события АТС открыта");
      // Связь восстановлена — окно «не на связи дольше N минут» закрыто.
      disconnectedSince = null;
      // Связь есть — гасим тревогу, если она успела подняться.
      ariAlarm.connected();
      // Пока связи не было, станция выбросила события начавшихся звонков — спрашиваем
      // её напрямую, что в эфире, и подхватываем пропущенное (см. resyncActiveChannels).
      void resyncActiveChannels(creds);
      // Каждое открытие подписки подхватывает свежий список входящих контекстов:
      // после перезапуска станции или правки в Настройках он мог измениться.
      void refreshInboundContexts();
      // И сверяем правила непринятого звонка: пока связи не было, их могли
      // поменять в Настройках, а сама станция — потерять при перезагрузке.
      void reconcileFailoverOnReconnect();
      // И режим маршрутизации незнакомых звонков — тот же повод и тот же приём.
      void reconcileRoutingModeOnReconnect();
      watchdog = startPingWatchdog(ws, PING_INTERVAL_MS);
    });

    ws.on("pong", () => watchdog?.markAlive());

    ws.on("message", (raw) => {
      // Событие — тоже доказательство, что сокет жив; отдельный ping в этот
      // интервал избыточен, но не вредит.
      watchdog?.markAlive();
      let event: AriEvent;
      try {
        event = JSON.parse(String(raw)) as AriEvent;
      } catch {
        return; // мусор в кадре — не повод рвать соединение
      }
      void handleAriEvent(event).catch((err) => {
        void logSystemError("telephony", `Ошибка обработки события АТС: ${err instanceof Error ? err.message : err}`, { dedupKey: "Ошибка обработки события АТС: …" });
      });
    });

    ws.on("close", (code) => {
      watchdog?.stop();
      // Обнуляем ТОЛЬКО свой сокет. Голое `socket = null` затирало бы уже открытое
      // новое соединение, если close пришёл с опозданием (ws эмитит его и после
      // error, и после terminate) — и isStationConnected врал бы интерфейсу «связи
      // нет», а следующий connect() завёл бы второй сокет к живому первому.
      if (socket === ws) socket = null;
      // Намеренно закрытый сокет — не обрыв: ни окна «не на связи», ни тревоги,
      // ни переподписки (новый сокет уже открывает startAriEvents).
      if (retiredSockets.has(ws)) return;
      // Отсчёт «не на связи» стартует с первого обрыва, а не с каждого — иначе
      // моргающая подписка (открылась и тут же закрылась) переставляла бы начало
      // окна на каждый цикл и «отключено дольше N минут» не наступало бы никогда.
      if (disconnectedSince === null) disconnectedSince = Date.now();
      // Обрыв всегда виден в консоли; в журнал он попадёт, только если связь не
      // вернётся дольше порога (см. createAriAlarm). Штатная остановка подписки
      // (stopAriEvents, перезапуск после правки Настроек) обрывом не считается.
      if (!stopped) ariAlarm.lost(`подписка закрыта (код ${code})`);
      scheduleReconnect(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay + RECONNECT_STEP_MS, RECONNECT_MAX_MS);
    });

    ws.on("error", (err) => {
      if (retiredSockets.has(ws)) return;
      // Тот же сторож, что и у close: недоступная АТС даёт ошибку на каждой
      // попытке, и человеку нужна не каждая из них, а факт «станции нет уже
      // столько-то». Одна тревога на один отказ — её ставит первый же вызов,
      // перешагнувший порог, неважно, из error или из close.
      ariAlarm.lost(err instanceof Error ? err.message : String(err));
      ws.close();
    });
  } catch (err) {
    // ЗДЕСЬ ЖИЛ ГЛАВНЫЙ ДЕФЕКТ: loadAriCredentials (обращение к БД), new URL
    // (кривая ссылка в Настройках) и new WebSocket (невалидная схема) бросали ДО
    // того, как навешивались обработчики close/error, — connect() вызывается как
    // `void connect()`, реджект терялся, и переподписка не планировалась НИКОГДА.
    // Секундная просадка Postgres в момент реконнекта убивала телефонию до
    // рестарта процесса.
    console.error("[телефония] подписка на события АТС не открылась:", err);
    void logSystemError(
      "telephony",
      `Подписка на события АТС не открылась: ${err instanceof Error ? err.message : err}`, { dedupKey: "Подписка на события АТС не открылась: …" }
    );
    scheduleReconnect(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay + RECONNECT_STEP_MS, RECONNECT_MAX_MS);
  } finally {
    // Снимается ВСЕГДА и только здесь: к этому моменту либо `socket` присвоен и
    // дальше от параллельного открытия защищает readyState, либо мы упали и уже
    // запланировали переподписку.
    connecting = false;
    if (startAgain) void connect();
  }
}

function scheduleReconnect(delayMs: number): void {
  if (stopped) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
  reconnectTimer.unref?.();
}
