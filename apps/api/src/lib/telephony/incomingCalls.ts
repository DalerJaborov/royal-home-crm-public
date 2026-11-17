import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { attachContactProfile } from "../contactProfiles.js";
import { formatClientName, type ClientKind } from "@royal-home/shared";
import { findClientByPhoneDigits } from "../whatsappPhone.js";
import { findAgentsWithPermission } from "../recipients.js";
import { sendPushToAgent, sendPushToAgents } from "../../push.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { closeStaleNextActions } from "../nextActionAutoClose.js";
import { claimAutoTaskSlot, closeAutoTasks, CALLBACK_AUTO_TASK_KINDS } from "../autoTasks.js";
import { loadIncomingSettings, incomingHoursOpen } from "./incomingSettings.js";
import { maskClientPhone } from "../clientPhone.js";
import { INCOMING_INBOUND_CONTEXTS } from "../settingsConstants.js";
import {
  routeIncomingToAssignedAgent,
  releaseChannelToOperator,
  holdKnownClientAwayFromOperator,
} from "./inboundRouting.js";
import { routeUnknownCallByKpiQueue } from "./kpiQueueRouting.js";
import { routeUnknownCallByDutyRoster } from "./dutyRosterRouting.js";
import { loadAriCredentials, answerChannel, startMoh } from "./ariClient.js";
// Из ariTypes.js, а НЕ из ariEvents.js: тот импортирует функции этого файла, и
// импорт в обратную сторону — пусть даже только типа — замыкает цикл, который
// правило no-circular считает ошибкой (CI 10.08.2026).
import type { AriChannel } from "./ariTypes.js";
import { SERVICE_NUMBER_IRRELEVANT_MARKS } from "./incomingCallConstants.js";
import { publishCallUpdated } from "../livePublish.js";
import { findStaffPhone } from "../staffPhoneGuard.js";
import { CONSULTANT_SESSION_WAIT_MS } from "./liveVoiceTimings.js";
// Реэкспорт — эта константа жила здесь до 03.09.2026 (аудит циклов), переехала
// в incomingCallConstants.ts, чтобы её мог взять autoLeadFromCall.ts, не
// замыкая цикл через весь этот файл. Реэкспорт сохраняет прежнюю точку входа.
export { SERVICE_NUMBER_IRRELEVANT_MARKS } from "./incomingCallConstants.js";

/**
 * Входящие звонки: клиент звонит сам.
 *
 * МАРШРУТИЗАЦИЯ: ПРАВИЛО ОТМЕНЕНО ВЛАДЕЛЬЦЕМ 16.08.2026.
 *
 * КАК БЫЛО (08.08.2026). Входящий маршрут ведёт в очередь 1000, где сидят операторы
 * 1001–1002; агентов в очереди нет, и CRM их туда не добавляет — «звонки по-прежнему
 * только одному оператору должны идти, а не агентам». Модуль ничего не набирал и
 * никуда не переводил: он слушал события АТС и записывал случившееся.
 *
 * КАК СТАЛО (16.08.2026). Если звонящий — известный клиент со СВОИМ ответственным
 * агентом, звонок сначала уводится этому агенту и только потом, если тот не взял
 * трубку за отведённые секунды, возвращается в ту же очередь 1000. Прежнее решение
 * оставлено выше не из вежливости: оно объясняет, почему весь остальной модуль
 * устроен как наблюдатель, и почему новый перевод сделан отдельным файлом
 * (inboundRouting.ts), а не размазан по обработке событий.
 *
 * ЧТО НЕ ИЗМЕНИЛОСЬ. Возможность выключена по умолчанию (Settings →
 * incomingRouteToAssignedAgent) и без контекста `royalhome-agent-route` на станции
 * не делает ничего вовсе. Звонок незнакомого номера, клиента без ответственного,
 * клиента из Корзины и лида, который агент ещё не принял, идёт в очередь ровно как
 * раньше. Сам возврат в очередь исполняет СТАНЦИЯ, а не CRM: запасной путь обязан
 * работать и тогда, когда CRM недоступна.
 *
 * ЗАЧЕМ ТОГДА ОН НУЖЕН. До сих пор входящий звонок не оставлял в CRM ни следа.
 * Клиент, которому агент не дозвонился утром, мог перезвонить сам в обед — и
 * агент об этом не узнавал никогда; в карточке оставался только его собственный
 * недозвон. А звонок, до которого оператор не дошёл, не существовал вовсе: узнать,
 * сколько обращений агентство потеряло, было неоткуда.
 *
 * ЧТО СЧИТАЕТСЯ ОТВЕЧЕННЫМ. Только соединение с оператором — момент, когда каналы
 * оказались в одном мосту. Очередь отвечает на звонок раньше, чтобы играть музыку
 * ожидания: в журнале станции брошенный звонок выглядит как ANSWERED с длительностью
 * в одиннадцать секунд, хотя человек просто не дождался. Считать такое обслуженным
 * значит спрятать ровно ту потерю, ради которой всё это и пишется.
 */

/**
 * Контексты диалплана, из которых звонок приходит СНАРУЖИ. Наши исходящие идут
 * через `from-internal` (проверено по журналу станции) и сюда не попадают, поэтому
 * второй проверки «это не наш звонок» не требуется — но она всё равно есть ниже,
 * потому что цена ошибки здесь несимметрична: чужой звонок в журнале входящих
 * заметят, а свой, принятый за входящий, поставит агенту задачу перезвонить
 * клиенту, с которым он только что говорил.
 */
/**
 * СРАВНЕНИЕ ПО ПРЕФИКСУ, А НЕ ПО ТОЧНОМУ СОВПАДЕНИЮ — и это не запас «на всякий
 * случай», а исправление бага, из-за которого CRM не записала НИ ОДНОГО живого
 * входящего звонка с самого запуска телефонии (обнаружено 11.08.2026 сверкой
 * журнала станции с журналом CRM: на АТС звонки есть, в `IncomingCall` — ноль).
 *
 * FreePBX даёт транку контекст вида `from-trunk-sip-<имя транка>`: у нас это
 * `from-trunk-sip-out`, а список принимал только голое `from-trunk`. Каждый
 * входящий отсеивался первой же проверкой, и вместе с ним молча выключались
 * панель оператора, уведомление о звонке, карточка по незнакомому номеру, запись
 * разговора и разбор — то есть всё рабочее место оператора целиком.
 *
 * Точное совпадение оставлено для `ext-queues`: это контекст очереди, а не транка,
 * и имя у него ровно одно.
 */
/**
 * ЭТО ЛИШЬ УМОЛЧАНИЕ. Замена — константа INCOMING_INBOUND_CONTEXTS (lib/settingsConstants.ts, с 01.11.2026; раньше Settings.incomingInboundContexts):
 * контекст транка — конфигурация ЧУЖОЙ системы (FreePBX), и она меняется без выката
 * CRM. Пустая настройка означает «берём встроенный набор» — безопасное состояние
 * «ничего не настроено».
 *
 * КАК СНЯТЬ РЕАЛЬНЫЙ КОНТЕКСТ С ЖИВОЙ СТАНЦИИ, если входящие перестали доходить:
 *  1. `ssh rh-pbx 'asterisk -rx "sip show peers"'` — имя транка, затем
 *     `asterisk -rx "dialplan show from-trunk-sip-<имя>"`;
 *  2. по факту прошлых звонков — CDR FreePBX:
 *     `mysql asteriskcdrdb -e "SELECT dcontext, COUNT(*) c FROM cdr
 *      WHERE calldate > NOW() - INTERVAL 14 DAY GROUP BY dcontext ORDER BY c DESC"`;
 *  3. во время живого звонка — `asterisk -rx "core show channels concise"` (поле
 *     Context) либо GET /ari/channels, поле `dialplan.context`;
 *  4. проще всего — позвонить на офисный номер и посмотреть счётчик отбраковок на
 *     дашборде телефонии: он сам назовёт контекст, которого нет в списке.
 */
const DEFAULT_INBOUND_CONTEXT_PREFIXES = ["from-trunk", "from-pstn", "from-did-direct", "from-sip-external"];
const DEFAULT_INBOUND_CONTEXTS_EXACT = ["ext-queues"];

/**
 * Список из настроек, если он там задан. null — действуют умолчания выше.
 *
 * Кэш в памяти процесса намеренный: `isInboundContext` стоит на горячем пути
 * событий станции, и ходить за настройкой в базу на каждое событие ChannelCreated
 * нельзя. Обновляется при каждом открытии подписки и раз в пять минут
 * (см. refreshInboundContexts и ariEvents.ts).
 */
let inboundContextsOverride: string[] | null = null;

/**
 * ТРЕВОГА — ПО ДЛИТЕЛЬНОСТИ, А НЕ ПО ОДНОЙ НЕУДАЧНОЙ ПОПЫТКЕ (12.08.2026).
 *
 * Список перечитывается раз в пять минут, и при просадке Postgres запись уходила
 * в журнал каждый тик — при том, что просадка базы и без того видна из десятка
 * других источников, а по строчке «список контекстов не прочитан» человеку делать
 * нечего: CRM остаётся на прежнем списке и входящие принимает.
 *
 * Новостью это становится только тогда, когда настройку не удаётся прочитать
 * УСТОЙЧИВО: значит, следующий выкат или правка списка контекстов до телефонии не
 * доедут. Порог тот же, что у тревоги связи с АТС и Telegram-поллера, — три
 * минуты; при пятиминутном опросе это означает «сорвались две попытки подряд».
 * Одиночный отказ остаётся в консоли контейнера.
 *
 * Хелпер намеренно свой и маленький, а не общий с ariEvents: тот живёт в соседней
 * ветке, и общий модуль сейчас дал бы конфликт слияния вместо пользы.
 */
const CONTEXTS_ALARM_AFTER_MS = 3 * 60_000;
const CONTEXTS_ALARM_PREFIX = "Список входящих контекстов не читается";

export function createInboundContextsAlarm(alarmAfterMs: number = CONTEXTS_ALARM_AFTER_MS): {
  ok(): void;
  failed(reason: string): void;
} {
  /** Когда началась ТЕКУЩАЯ серия отказов. null — последняя попытка удалась. */
  let failingSince: number | null = null;
  let alarmed = false;

  return {
    /** Настройка прочиталась. Гасит тревогу, если она поднималась. */
    ok(): void {
      failingSince = null;
      if (!alarmed) return;
      alarmed = false;
      console.log("[телефония] список входящих контекстов снова читается");
      void prisma.errorLog
        .updateMany({
          where: { source: "telephony", resolvedAt: null, message: { startsWith: CONTEXTS_ALARM_PREFIX } },
          data: { resolvedAt: new Date() },
        })
        .catch((err) => console.error("[телефония] тревога не снята:", err instanceof Error ? err.message : err));
    },

    /** Настройка не прочиталась. В журнал — только если это длится дольше порога. */
    failed(reason: string): void {
      const now = Date.now();
      // Отсчёт от ПЕРВОГО отказа серии, а не от последнего успеха: иначе первая же
      // сорвавшаяся попытка после долгого затишья считалась бы устойчивой.
      if (failingSince === null) failingSince = now;
      const failingSec = Math.round((now - failingSince) / 1000);
      console.warn(
        `[телефония] ${new Date().toISOString()} список входящих контекстов не прочитан (${failingSec} с подряд): ${reason}`
      );
      if (alarmed || now - failingSince < alarmAfterMs) return;
      alarmed = true;
      void logSystemError("telephony", `${CONTEXTS_ALARM_PREFIX} ${failingSec} с подряд: ${reason}`);
    },
  };
}

const inboundContextsAlarm = createInboundContextsAlarm();

/** Перечитать список входящих контекстов. С 01.11.2026 это константа
 *  (lib/settingsConstants.ts, на проде список пуст — действует встроенный набор),
 *  колонка Settings.incomingInboundContexts не читается. Подпись и вызовы
 *  оставлены: список по-прежнему ставится на старте процесса. */
export async function refreshInboundContexts(): Promise<void> {
  const list = INCOMING_INBOUND_CONTEXTS.map((c) => c.trim()).filter(Boolean);
  inboundContextsOverride = list.length > 0 ? list : null;
  inboundContextsAlarm.ok();
}

/** Только для тестов: подменить список контекстов, не трогая базу. */
export function setInboundContextsForTest(list: string[] | null): void {
  inboundContextsOverride = list && list.length > 0 ? list : null;
}

/** Пришёл ли звонок снаружи, судя по контексту диалплана. */
export function isInboundContext(context: string): boolean {
  // Переопределение ПОЛНОЕ: семантика одна для всех записей (точное имя покрывается
  // первым сравнением), поэтому ext-queues при своём списке вписывают руками.
  if (inboundContextsOverride) {
    return inboundContextsOverride.some((entry) => context === entry || context.startsWith(`${entry}-`));
  }
  if (DEFAULT_INBOUND_CONTEXTS_EXACT.includes(context)) return true;
  return DEFAULT_INBOUND_CONTEXT_PREFIXES.some(
    (prefix) => context === prefix || context.startsWith(`${prefix}-`)
  );
}

/** Минимум цифр, при котором номер считается настоящим телефоном, а не служебным. */
const MIN_PHONE_DIGITS = 7;

/** Через сколько бросаем «зависший» РАЗГОВОР, о конце которого станция не сообщила. */
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * То же для звонка, которого никто не снял. Полчаса — с большим запасом: в очереди
 * не ждут и десяти минут. Отдельный срок нужен потому, что висящий неотвеченный
 * звонок держит на экране оператора панель с бегущим таймером по разговору,
 * которого не было.
 */
const STALE_UNANSWERED_MS = 30 * 60 * 1000;

/**
 * Сколько держим ЗАВЕРШЁННЫЙ звонок в памяти, чтобы окно оператора не исчезло из-под
 * рук. Человек кладёт трубку и только тогда дописывает, что услышал: панель, гаснущая
 * в ту же секунду, означала бы, что разбор звонка теряется ровно у того, кто говорил.
 * Столько же, сколько живёт полоса исходящего звонка (callTracker), только длиннее —
 * там агент видит итог, здесь оператор его вводит.
 */
const KEEP_ENDED_MS = 90_000;

/**
 * Открытая строка журнала, которой нет в живой памяти, старше этого срока —
 * сирота рестарта (№222 ночной проверки 24.09). Звонок, который ведёт этот
 * процесс, всегда в памяти; разговор дольше двух часов без памяти о нём —
 * значит, его вёл прошлый процесс, и конца уже никто не запишет.
 */
const ORPHAN_AFTER_MS = 2 * 60 * 60 * 1000;

interface LiveIncoming {
  channelId: string;
  /**
   * Имя канала на станции (`SIP/out-00000012`). Хранится ради ОДНОГО потребителя —
   * перевода на ответственного агента: AMI адресует действия по имени канала, а не
   * по его идентификатору ARI.
   */
  channelName?: string;
  /** Номер в виде CRM (+992…). */
  phone: string;
  startedAt: Date;
  /** Момент соединения с оператором. Пусто — разговора так и не было. */
  bridgedAt?: Date;
  /**
   * Момент, когда трубку взял консультант на телефоне (ИИ, 24.09.2026, робозвонок,
   * правка 5). Отдельно от bridgedAt нарочно: консультант не оператор — звонок не
   * пропущен, но и человек с клиентом не говорил. Если консультант потом соединил с
   * агентом и тот взял трубку, bridgedAt ставит уже мост агента.
   */
  consultantAt?: Date;
  /**
   * Агент, которому консультант перевёл звонок (02.10.2026, liveVoiceTransfer.ts).
   * Нужен, чтобы засчитать разговор тому, кто его провёл, когда станция не назвала
   * внутренний номер (агент ответил на мобильном): без этого автор записи —
   * «система», а лид уходил в общую раздачу. Снимается, если звонок вернулся к
   * консультанту (агент не взял).
   */
  transferAgent?: { id: string; extension: string | null };
  /** Консультант не смог принять звонок (сбой, тишина) и отдал его станции — в
   *  автоответчик. Такой звонок не «отвечен»: до человека не дошёл никто. */
  consultantHandedBack?: boolean;
  /** Звонящий сказал консультанту хоть слово — минимальный признак разговора,
   *  без которого карточку и лид не заводим (режим «Всегда первым», 02.10.2026). */
  consultantSpoke?: boolean;
  /** Робот сказал в линию хоть слово (итог сессии, 09.10.2026). false — сессия
   *  отчиталась, а речи робота не было ни в одной части звонка: человек слышал тишину,
   *  звонок пропущенный. undefined — итог этого не сообщил (прежние сценарии). */
  consultantBotSpoke?: boolean;
  /** Резолвится, когда сессия консультанта отчиталась о звонке (noteConsultantSession).
   *  `settled` — этот ожидатель уже снят отчётом: вернувшийся от агента звонок заводит
   *  новый (noteConsultantReturned), иначе конец звонка не дождался бы второго итога. */
  consultantSessionDone?: { promise: Promise<void>; resolve: () => void; settled: boolean };
  /** Момент окончания. Заполнен — звонок уже разобран, но ещё показывается оператору. */
  endedAt?: Date;
  answeredBy?: string;
  /** id записи журнала — она заводится сразу, чтобы живой звонок был виден. */
  recordId?: string;
  clientId?: string;
  /** Имя и короткий номер карточки — для окна оператора, чтобы оно не ходило в базу. */
  clientName?: string;
  clientShortId?: number;
  /**
   * Ведущий агент клиента — тот, с кем клиент уже разговаривал раньше. С 16.08.2026
   * звонок такого клиента сначала пробуют увести самому агенту (см. inboundRouting.ts),
   * но перевод срабатывает не всегда: возможность может быть выключена, агент — без
   * трубки, лид — ещё не принят. Поэтому имя остаётся в пуше оператору: сняв трубку,
   * он сразу говорит «сейчас соединю вас с Мадиной», а не выясняет это, открывая
   * карточку.
   */
  assignedAgentName?: string;
  /**
   * id того же ведущего агента. Хранится рядом с именем, а не добывается запросом:
   * по нему решается, показывать ли звонок ДЕЖУРНОМУ оператору (решение владельца
   * 17.08.2026 — «пусть агенты сами управляют и видят свои пропущенные»), а этот
   * вопрос задаётся на каждом опросе панели, то есть раз в секунду на вкладку.
   */
  assignedAgentId?: string;
  /** Карточку завёл этот звонок: имя в ней временное, запрос пустой. */
  autoCreatedClient?: boolean;
  /**
   * Резолвится, когда поиск клиента и запись в журнал закончены.
   *
   * АТС шлёт события потоком, и обработчик не дожидается предыдущего
   * (`void handleAriEvent(...)` в ariEvents.ts). У очень короткого звонка — не туда
   * попали и сразу бросили трубку — конец успевает прийти раньше, чем закончатся
   * эти два обращения к базе. Без ожидания finishIncomingCall прочитал бы clientId
   * пустым (руководству ушёл бы пуш «звонил незнакомый номер» про известного
   * клиента) и дописал бы итог в строку, которой ещё нет: звонок навсегда остался
   * бы в журнале висящим — без конца и вечно непринятым, даже если разговор был.
   */
  ready: Promise<void>;
  /**
   * Попытка увести звонок ответственному агенту — тоже ОТДЕЛЬНО от ready, по той же
   * причине, что и push: итог звонка не должен ждать поход к станции. Перевод
   * меняет маршрут звонка, а не его запись в CRM; если он не удался, звонок просто
   * остаётся в очереди — то есть в поведении, которое было до 16.08.2026.
   */
  routing?: Promise<void>;
}

const live = new Map<string, LiveIncoming>();

/** Номер станции — девять местных цифр — в тот вид, в каком номера лежат в CRM. */
export function toCrmPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return `+992${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) return `+992${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("992")) return `+${digits}`;
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * Внутренний номер из имени канала: `SIP/1001-00000012` → `1001`;
 * `Local/1001@from-queue-000000aa;1` → `1001`.
 *
 * Local-канал — как отвечает оператор через очередь: очередь 1000 дозванивается
 * до операторов НЕ их SIP-каналом напрямую, а Local-каналом вида
 * `Local/1001@from-queue-…;1` — и именно этот канал (не второй, `;2`, где живёт
 * настоящий SIP оператора) входит в мост с клиентом (см. ariEvents.ts,
 * rememberOperatorChannel/operatorChannelFor). Старая регулярка требовала дефис
 * сразу после номера и на `Local/1001@…` не совпадала — answeredBy оставался
 * пустым НА КАЖДОМ звонке через очередь, а без него не находился ни автор
 * записи в хронологии клиента, ни сам оператор (finishIncomingCall).
 */
export function extensionFromChannelName(name: string | undefined): string | undefined {
  const local = /^Local\/(\d{3,5})@/.exec(name ?? "");
  if (local) return local[1];
  /**
   * Браузерная трубка: `PJSIP/rh-web-1001-00000012` → `1001`. Аппарат в браузере
   * зовётся `rh-web-<внутренний номер>`, и без этой ветки
   * ответ из CRM оставлял журнал входящих без оператора: в колонке «кто снял»
   * пусто, разбор звонка не привязывался к человеку — при том, что трубку сняли
   * ровно из этой же CRM.
   */
  const browser = /^PJSIP\/rh-web-(\d{3,5})-/.exec(name ?? "");
  if (browser) return browser[1];
  const match = /^[A-Za-z0-9]+\/(\d{3,5})-/.exec(name ?? "");
  return match?.[1];
}

/**
 * Почему кандидат во входящие не был им признан.
 *
 *  • `context` — контекст диалплана не в списке входящих. САМАЯ ОПАСНАЯ причина:
 *    именно так CRM однажды потеряла 100% входящих, ничего никому не сказав.
 *  • `local-channel` — Local-канал очереди до оператора. Штатная отбраковка, по два
 *    на каждый звонок; в счётчике полезна как признак «очередь жива».
 *  • `short-number` — в определителе не телефон (служебный вызов, скрытый номер).
 */
export type InboundRejectReason = "context" | "local-channel" | "short-number";

export type InboundVerdict = { inbound: true } | { inbound: false; reason: InboundRejectReason };

/**
 * Звонок снаружи — или нет, и если нет, то почему. Чистая функция: у неё нет ни базы,
 * ни сокета, поэтому её можно проверить на образцах событий, снятых с живой станции.
 *
 * null — канала в событии не было вовсе: считать и логировать нечего.
 */
export function classifyInboundChannel(channel: AriChannel | undefined): InboundVerdict | null {
  if (!channel) return null;
  const context = channel.dialplan?.context ?? "";
  if (!isInboundContext(context)) return { inbound: false, reason: "context" };
  // Local-каналы очередь создаёт сама, чтобы дозвониться до операторов; звонок
  // снаружи — это канал транка, и считать его надо ровно один раз. Порядок проверок
  // важен: Local отсеивается ПОСЛЕ контекста, иначе в счётчике пропал бы сигнал
  // «очередь работает».
  if (channel.name?.startsWith("Local/")) return { inbound: false, reason: "local-channel" };
  const digits = (channel.caller?.number ?? "").replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return { inbound: false, reason: "short-number" };
  return { inbound: true };
}

/** Звонок снаружи — или нет. Обёртка над classifyInboundChannel для читаемости. */
export function isInboundChannel(channel: AriChannel | undefined): boolean {
  return classifyInboundChannel(channel)?.inbound === true;
}

/**
 * ОТБРАКОВКА ОБЯЗАНА ОСТАВЛЯТЬ СЛЕД.
 *
 * До этого счётчика по журналам нельзя было отличить «звонков не было» от «все
 * звонки отброшены»: канал с неопознанным контекстом просто возвращал false. Ровно
 * так CRM неделю не записывала НИ ОДНОГО входящего (11.08.2026), и выяснилось это
 * сверкой с журналом станции по SSH, а не из CRM.
 *
 * ПОЧЕМУ В ПАМЯТИ, А НЕ В БАЗЕ. Это диагностика «здесь и сейчас», а не отчётность:
 * ответ на вопрос «почему звонки не доходят прямо сейчас». Счётчик обнуляется
 * рестартом и деплоем — и дашборд обязан честно об этом сказать
 * (`sinceProcessStart`), иначе обнуление примут за «проблема ушла».
 */
interface RejectStat {
  reason: InboundRejectReason;
  context: string;
  count: number;
  lastAt: Date;
  sampleChannelName: string;
}

/** Ключ — причина+контекст. Потолок ключей защищает память от станции, которая
 *  генерирует уникальные контексты: лишнее сворачивается в общий ключ. */
const REJECT_STATS_MAX_KEYS = 50;
const REJECT_OTHER_CONTEXT = "<прочие>";
/** Реже одного раза в минуту на ключ: Local-каналы очереди отбраковываются по два на
 *  каждый звонок, и без дросселя журнал контейнера утонул бы в них. */
const REJECT_LOG_THROTTLE_MS = 60_000;

const rejectStats = new Map<string, RejectStat>();
const rejectLoggedAt = new Map<string, number>();

/** Учесть отброшенного кандидата во входящие: счётчик + лог с дросселем. */
export function noteRejectedInbound(channel: AriChannel, reason: InboundRejectReason): void {
  const context = channel.dialplan?.context ?? "";
  const name = channel.name ?? "";
  let key = `${reason}|${context}`;
  if (!rejectStats.has(key) && rejectStats.size >= REJECT_STATS_MAX_KEYS) {
    key = `${reason}|${REJECT_OTHER_CONTEXT}`;
  }
  const existing = rejectStats.get(key);
  const at = new Date();
  if (existing) {
    existing.count += 1;
    existing.lastAt = at;
    existing.sampleChannelName = name;
  } else {
    rejectStats.set(key, {
      reason,
      context: key.endsWith(REJECT_OTHER_CONTEXT) ? REJECT_OTHER_CONTEXT : context,
      count: 1,
      lastAt: at,
      sampleChannelName: name,
    });
  }

  const last = rejectLoggedAt.get(key) ?? 0;
  if (at.getTime() - last < REJECT_LOG_THROTTLE_MS) return;
  rejectLoggedAt.set(key, at.getTime());
  // ТОЛЬКО console: это не ошибка (Local-каналы отбраковываются штатно), а номер
  // звонящего не должен оседать в ErrorLog — его читает экран «Здоровье системы»
  // без права clients.viewPhone.
  console.log(
    `[телефония] кандидат во входящие отброшен (${reason}): context=${context || "<пусто>"} name=${name || "<пусто>"} number=${channel.caller?.number ?? "<пусто>"}`
  );
}

/** Счётчики отбраковок — для дашборда телефонии. Самое частое сверху. */
export function rejectedInboundStats(): RejectStat[] {
  return [...rejectStats.values()].sort((a, b) => b.count - a.count);
}

/** Только для тестов: забыть счётчики отбраковок. */
export function resetRejectedInboundStats(): void {
  rejectStats.clear();
  rejectLoggedAt.clear();
}

/**
 * Новый входящий: заводим запись журнала сразу, не дожидаясь конца разговора.
 *
 * Запись создаётся с `answered = false` — то есть звонок сначала считается
 * потерянным и становится обслуженным, только когда оператор действительно снял
 * трубку. Обратный порядок («сначала считаем принятым») означал бы, что при
 * перезапуске API посреди разговора потерянный звонок навсегда остался бы в
 * журнале принятым.
 */
export async function startIncomingCall(channel: AriChannel): Promise<void> {
  if (live.has(channel.id)) return;
  // ТИШИНА ПЕРВЫХ СЕКУНД (04.09.2026) — не ждём поиск клиента и перевод на
  // агента (ниже — запросы к базе и, для известного клиента, две команды AMI
  // через туннель офис↔VPS): звонящий должен услышать хоть что-то СРАЗУ, а не
  // после этого. Fire-and-forget: основная функция её не ждёт, конвейер ниже
  // не задерживается, а неудача (станция недоступна, звонок уже брошен) — не
  // повод сорвать сам звонок.
  void (async () => {
    try {
      const creds = await loadAriCredentials();
      if (!creds) return;
      await answerChannel(creds, channel.id);
      await startMoh(creds, channel.id);
    } catch (err) {
      // Не через logSystemError: это best-effort попытка на каждом входящем,
      // а не отказ интеграции — шуметь в «Здоровье системы» из-за неё не нужно.
      // answerChannel/startMoh сами не бросают (см. ariClient.ts), но мок в
      // тестах и будущие правки могут — ловим здесь, а не роняем звонок.
      console.error("[телефония] МОН на новом входящем не включилась:", err);
    }
  })();
  const phone = toCrmPhone(channel.caller?.number ?? "");
  // Запись кладём в живую карту СИНХРОННО, до первого await: иначе конец короткого
  // звонка не найдёт в ней ничего и уйдёт в никуда. Работа с базой — отдельной
  // промисой в поле ready, за которую и держится finishIncomingCall.
  const entry: LiveIncoming = {
    channelId: channel.id,
    channelName: channel.name,
    phone,
    startedAt: new Date(),
    ready: Promise.resolve(),
  };
  entry.ready = setupIncomingCall(entry);
  live.set(channel.id, entry);
  sweepStale();
  await entry.ready;
}

/** Поиск клиента и запись в журнал — асинхронная часть начала звонка (см. ready). */
async function setupIncomingCall(entry: LiveIncoming): Promise<void> {
  const match = await findClientByPhoneDigits(entry.phone);
  // Карточку из Корзины за клиента не считаем: её удалил человек, и оживлять её
  // звонком (а тем более ставить по ней задачу) — не наше решение.
  const known = match && !match.deletedAt ? match : null;
  entry.clientId = known?.id;
  if (known) {
    // Имя и короткий номер — отдельным запросом: findClientByPhoneDigits ищет по
    // хвосту номера сырым SQL и возвращает только то, что нужно для сверки. Окну
    // оператора этого мало, а ходить в базу на каждый опрос состояния незачем.
    const card = await prisma.client.findUnique({
      where: { id: known.id },
      select: { fullName: true, shortId: true, assignedAgent: { select: { id: true, fullName: true } } },
    });
    entry.clientName = card?.fullName;
    entry.clientShortId = card?.shortId;
    entry.assignedAgentName = card?.assignedAgent?.fullName;
    entry.assignedAgentId = card?.assignedAgent?.id;
  }

  try {
    const record = await prisma.incomingCall.create({
      data: {
        channelId: entry.channelId,
        phone: entry.phone,
        clientId: known?.id ?? null,
        startedAt: entry.startedAt,
      },
    });
    entry.recordId = record.id;
    /**
     * ДОСЬЕ СОБЕСЕДНИКА (21.09.2026) — то же, что у мессенджеров.
     *
     * Номер звонящего определила станция, то есть это признак, подтверждённый
     * каналом, и именно он сводит звонок с перепиской в WhatsApp в одно досье
     * САМ, без участия человека: там телефон выводится из wa_id тем же хвостом
     * из девяти цифр (lib/contactProfiles.ts).
     *
     * Без await нарочно: начало звонка обслуживает живой разговор, и лишний
     * запрос в базу до ответа оператора здесь не нужен — отказ уйдёт в журнал
     * сам (внутри всё обёрнуто).
     */
    void attachContactProfile({
      existingProfileId: null,
      identities: [{ kind: "PHONE", value: entry.phone, trust: "TRANSPORT" }],
      name: entry.clientName ?? null,
      /**
       * `crm`, А НЕ `self` (правка 22.09.2026). Это ФИО из карточки клиента,
       * вбитое агентом, — со словами самого человека оно не связано никак. С
       * `self` оно становилось липким и печаталось боту как «имя, которым он
       * представился», а в карточках сплошь и рядом стоит служебная пометка
       * («Далер (брат Умеда, звонить после 18)»). Ровно та жалоба, ради которой
       * написан clientSelfStatedName.
       */
      nameSource: "crm",
      link: async (profileId) => {
        await prisma.incomingCall.update({
          where: { id: record.id },
          data: { contactProfileId: profileId },
        });
      },
    });
    // Строка журнала входящих создана — журнал и лента звонков протухли.
    publishCallUpdated({ callId: record.id, clientId: known?.id ?? null, agentId: entry.assignedAgentId ?? null });
  } catch (err) {
    if (isUniqueViolation(err)) {
      /**
       * ПОВТОРНАЯ ДОСТАВКА ПОСЛЕ ТОГО, КАК ЗВОНОК УЖЕ ЗАБЫТ, — И ЭТО НЕ БЕЗОБИДНО.
       *
       * Строка с таким channelId в базе уже есть, значит начало звонка мы записали.
       * Но живой записи в памяти к этому моменту могло не остаться: завершённый
       * звонок удаляется через KEEP_ENDED_MS. Проверка `live.has` в startIncomingCall
       * такое событие не отсекает — оно заводит НОВУЮ живую запись, и раз create
       * упал, она навсегда остаётся без recordId и без endedAt. Панель оператора
       * показывала по ней несуществующий звонок с бегущим таймером до получаса
       * (пока не сработает sweepStale), а разобрать его было нечего и негде.
       *
       * Поэтому фантом убираем сразу. Сверка по ссылке обязательна: за время
       * ожидания базы в карте мог оказаться уже другой звонок с тем же id.
       */
      if (live.get(entry.channelId) === entry) live.delete(entry.channelId);
      /**
       * А ЕСЛИ СТРОКА ЕЩЁ ОТКРЫТА — ЭТО РЕСТАРТ ПОСРЕДИ РАЗГОВОРА (№222 ночной
       * проверки 24.09). Память прошлого процесса пропала вместе с ним, конец
       * звонка нашёл пустоту, и строка оставалась без endedAt навсегда — на
       * состоявшемся разговоре висел «Пропущенный входящий». Досинхронизация
       * после рестарта (ariEvents.ts) присылает начало того же канала сюда же:
       * закрываем строку здесь. Был ли ответ — по отметке, которую
       * markIncomingBridged пишет в момент соединения.
       */
      await closeOpenIncomingRows({ channelId: entry.channelId }, new Date()).catch((closeErr) =>
        logSystemError(
          "telephony",
          `Открытая строка входящего после рестарта не закрыта: ${closeErr instanceof Error ? closeErr.message : closeErr}`
        )
      );
      return;
    }
    // Всё остальное записываем: журнал входящих не должен молча пустеть.
    void logSystemError("telephony", `Не записан входящий звонок: ${err instanceof Error ? err.message : err}`);
    // Дальше не идём НИ ПРИ КАКОЙ ошибке записи. Уникальный channelId — единственный
    // ключ идемпотентности во всём этом пути: пропустив его, повторно доставленное
    // событие завело бы вторую карточку на тот же звонок. Именно так плодятся
    // дубликаты клиентов, которые потом сливают руками.
    return;
  }

  /**
   * ПУША НА ГУДОК БОЛЬШЕ НЕТ (владелец 20.09.2026): «пуш только про пропущенные,
   * а в истории звонков пусть просто появляется номер, кто звонил».
   *
   * Уведомление на гудок появилось 11.08.2026 как ЗАМЕНА звонящей трубке: агенты
   * сидели на мобильных, до которых звонок физически не доходил, и пуш был
   * единственным способом узнать о звонке вообще. Эта причина отпала 20.09.2026,
   * когда починили саму телефонию (станция подставляла провайдеру номер звонящего
   * вместо номера агентства, и тот отбивал все переадресации как подмену —
   * HANGUPCAUSE 21). Теперь телефон звонит по-настоящему, и пуш на гудок стал
   * вторым сигналом о том же событии — причём таким, который на iPhone часто
   * оставался висеть в шторке уже после разговора.
   *
   * Пропущенные по-прежнему будят кого надо — см. notifyMissed в конце звонка.
   */
  /**
   * Перевод на ответственного — ПОСЛЕ успешной записи в журнал, и это не порядок
   * ради порядка. Уникальный `channelId` строки журнала — единственный ключ
   * идемпотентности на всём пути: повторно доставленное событие станции падает на
   * нём выше и до перевода не доходит вовсе. Иначе один и тот же звонок можно было
   * бы перевести дважды.
   */
  entry.routing = routeIncoming(entry);
}

/** Попытка увести звонок ответственному агенту. Отдельная функция — ради поля routing. */
async function routeIncoming(entry: LiveIncoming): Promise<void> {
  if (!entry.channelName) return;
  // Консультант тоже «снял трубку»: увести канал агенту посреди его разговора
  // значило бы оборвать человека на полуслове.
  const isAnswered = () => !!entry.bridgedAt || !!entry.consultantAt || !!entry.endedAt;
  const outcome = await routeIncomingToAssignedAgent({
    channelId: entry.channelId,
    channelName: entry.channelName,
    phone: entry.phone,
    clientId: entry.clientId,
    recordId: entry.recordId,
    // Функцией, а не значением: между решением и действием лежит поход к станции,
    // и оператор мог снять трубку ровно в этот промежуток. Перевод соединённого
    // звонка оборвал бы живой разговор.
    isAnswered,
  });
  /**
   * ЗВОНИТЬ ВООБЩЕ НЕКОМУ (не "не получилось", а "нет ответственного") — пробуем
   * альтернативный режим, если владелец его включил (Settings.incomingRoutingMode).
   * Сама функция режима первым делом проверяет, что это ЕЁ режим, и молча
   * отказывает иначе — вызывать можно обе подряд, лишней работы не будет.
   * Остальные причины отказа (занят, не в сети, не принял, закрыт, несколько
   * карточек) сюда НЕ попадают нарочно — см. заголовки kpiQueueRouting.ts и
   * dutyRosterRouting.ts.
   */
  if (!outcome.routed && (outcome.reason === "no_client" || outcome.reason === "no_agent")) {
    const params = { channelName: entry.channelName, phone: entry.phone, recordId: entry.recordId, isAnswered };
    const kpi = await routeUnknownCallByKpiQueue(params);
    // Перевод по KPI удался — дежурного не зовём: его запись в журнале стёрла бы
    // маршрут и адресата (CHANNEL-NEW-33, 04.10.2026).
    if (kpi.routed) return;
    const duty = await routeUnknownCallByDutyRoster(params);
    if (duty.routed) return;
  }
  /**
   * ВЕРДИКТ СТАНЦИИ: «этот звонок не наш, отдавайте оператору».
   *
   * Решение владельца 21.09.2026: «свои клиенты звонят агентам прямо, чужих
   * обслуживаю я; один звонок одному человеку, никакой гонки».
   *
   * До этого станция и CRM работали наперегонки: диалплан ставил звонок в
   * очередь через фиксированную паузу (шесть секунд музыки), а CRM параллельно
   * выясняла, чей это клиент, и уводила его агенту. Кто успел — тот и взял.
   * Замер 20.09 показал цену такой схемы: оператор снимал трубку раньше перевода
   * на трёх звонках известных клиентов за день (`already_answered`, один
   * разговор 80 секунд), а под нагрузкой сервера CRM не укладывалась и в шесть
   * секунд вовсе.
   *
   * Теперь очередь не стартует по таймеру: диалплан ждёт ЭТУ переменную и
   * начинает звонить оператору ровно тогда, когда CRM сказала, что клиент чужой.
   * Выигрыш обоюдный — свой клиент не может попасть к оператору в принципе, а
   * чужой попадает к нему за секунду вместо шести.
   *
   * Верхняя граница ожидания живёт на станции, а не здесь: если CRM молчит
   * (перезапуск, обрыв туннеля), диалплан досчитывает свои секунды и отдаёт
   * звонок очереди сам — отказ CRM делает схему прежней, а не немой.
   */
  if (outcome.routed) return; // канал уже уведён из royalhome-inbound — отпускать нечего
  // Свой клиент (есть назначенный агент) оператору не отдаётся НИКОГДА (владелец
  // 22.09.2026): занят/не в сети/лид не принят/станция отказала — мобильный агента,
  // потом голосовая почта + «перезвонить» ему же. См. holdKnownClientAwayFromOperator.
  const held = await holdKnownClientAwayFromOperator(
    {
      channelId: entry.channelId,
      channelName: entry.channelName,
      phone: entry.phone,
      clientId: entry.clientId,
      recordId: entry.recordId,
      isAnswered,
    },
    outcome.reason
  );
  if (held) return;
  await releaseChannelToOperator(entry.channelName, outcome.reason);
}


/**
 * Незнакомый номер — заводим карточку, КОГДА РАЗГОВОР НАЧАЛСЯ.
 *
 * ЗАЧЕМ. До этого оператор говорил с человеком, о котором CRM не узнавала ничего,
 * кроме номера и длительности: имя, запрос и район оставались в голове у оператора,
 * а звонок — строкой в журнале. Записывать это ПОСЛЕ разговора поздно вдвойне —
 * разговор может оборваться, и тогда не остаётся даже номера в работе.
 *
 * НЕ НА ГУДОК, А НА ОТВЕТ ОПЕРАТОРА. Первая версия заводила карточку в момент
 * звонка — и тем самым складывала в базу КАЖДЫЙ непринятый звонок: курьеров,
 * рекламу, ошибшихся номером, автообзвон. Именно от этого предостерегало решение
 * 09.08.2026 («карточка по незнакомому номеру не заводится»), и оно право: пока
 * трубку никто не снял, о звонящем не известно ничего, а разбирать нечего. Карточка
 * нужна ровно тогда, когда начался разговор, — с этого момента её и заводим.
 *
 * ОТВЕТСТВЕННОГО НЕ НАЗНАЧАЕМ. Пока не спрошено, покупатель это или продавец,
 * распределять нечего: лид, ушедший агенту до квалификации, стартует таймер первого
 * звонка по человеку, с которым прямо сейчас говорит оператор. Агент появится на
 * шаге квалификации (см. qualifyIncomingCall).
 *
 * ИМЯ ВРЕМЕННОЕ. «Входящий +992…» — честная заглушка: видно, что имя ещё не
 * спросили, и видно, кого спрашивать. Оператор заменяет его в окне разговора.
 */
async function createCardForUnknownCaller(entry: LiveIncoming): Promise<void> {
  // Строки журнала нет — начало звонка не записалось (см. setupIncomingCall). Без
  // неё карточку не к чему привязать, а update по несуществующему channelId упадёт.
  if (!entry.recordId) return;
  const settings = await loadIncomingSettings();
  // Выключено — прежнее поведение целиком: незнакомый номер живёт только в журнале
  // входящих и базу не засоряет.
  if (!settings.autoCreateClient) return;

  /**
   * СЛУЖЕБНЫЙ НОМЕР — НЕ ТО ЖЕ САМОЕ, ЧТО «ОДНАЖДЫ ОТМЕТИЛИ НЕ ПО ДЕЛУ».
   *
   * Замысел верный: курьер звонит каждый день, и без памяти оператор помечал бы
   * его ежедневно — а обязательное действие, которое делают не глядя, хуже
   * отсутствующего. Но одной пометки для вывода «это навсегда не клиент» мало.
   * Побочный эффект был тяжелее пользы: человек, чей звонок один раз оказался не
   * по делу (ошибся номером, спрашивал не то), при следующем — уже настоящем —
   * обращении не получал карточки, а без карточки нет `Interaction`, и вместе с
   * ним нет ни записи разговора, ни расшифровки, ни разбора. Вернувшийся клиент
   * молча выпадал из всего конвейера.
   *
   * Поэтому нужны ДВЕ пометки: курьеру они стоят одного лишнего разбора и дальше
   * он не беспокоит никого, а вернувшийся клиент карточку получает. Правило
   * самонастраивающееся — отдельного списка запрещённых номеров по-прежнему не
   * заводим: пометка лежит в журнале входящих, под неё есть индекс
   * (phone, irrelevant), и второй источник правды про один и тот же факт
   * неизбежно разошёлся бы с первым.
   */
  const markedIrrelevant = await prisma.incomingCall.count({
    where: { phone: entry.phone, irrelevant: true },
  });
  if (markedIrrelevant >= SERVICE_NUMBER_IRRELEVANT_MARKS) return;

  /**
   * ЗВОНИТ СВОЙ СОТРУДНИК — КАРТОЧКА НЕ НУЖНА ВООБЩЕ (найдено 20.08.2026).
   *
   * Разбор после разговора (`autoLeadFromCall.ts`) и так отбрасывает звонок
   * сотрудника как «не по делу», но НЕ через `markIrrelevant`, а прямым
   * возвратом — значит, `IncomingCall.irrelevant` не проставляется, счётчик
   * «дважды не по делу → служебный номер» для сотрудников не растёт никогда, и
   * заглушка «Входящий +992…» от createCardForUnknownCaller выше плодится
   * заново на КАЖДЫЙ звонок сотрудника в офис, а не один раз. Дешевле не
   * заводить её в принципе, чем убирать постфактум.
   *
   * ХВОСТ, А НЕ ТОЧНАЯ СТРОКА (17.09.2026, см. lib/staffPhoneGuard.ts) — точное
   * совпадение `Agent.phone` пропускало ЛЮБОЕ отличие формы записи (пробелы,
   * код страны без «+»), и именно эта ветка не поймала звонок Маъруфа: номер со
   * станции и номер в карточке сотрудника совпадали по цифрам, но не строкой.
   */
  const employee = await findStaffPhone([entry.phone]);
  if (employee) return;

  try {
    // КАРТОЧКА И ССЫЛКА НА НЕЁ — ОДНОЙ ТРАНЗАКЦИЕЙ (22.09.2026). Раньше это были
    // две отдельные записи, и перезапуск процесса между ними оставлял карточку-
    // заглушку в базе, а звонок — в очереди неразобранных БЕЗ ссылки на неё.
    // Оператор видел звонок «без клиента», а пометка «не по делу» такую заглушку
    // уже никогда не убирала: ветка удаления в qualifyIncoming.ts требует
    // `call.autoCreatedClient`, а он остался невыставленным. Мусорная карточка
    // с настоящим номером оставалась в базе навсегда.
    const client = await prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: {
          // МАСКА, А НЕ НОМЕР ЦЕЛИКОМ (владелец 20.08.2026: «номер не должен
          // выходить агенту даже после принятия лида»). Раньше здесь стояло
          // `Входящий ${entry.phone}` — и открытый номер оказывался в ИМЕНИ
          // карточки, мимо правила `clients.viewPhone`, которое закрывает поле
          // `phone`, но не текст имени. Маска оставляет последние две цифры —
          // ровно чтобы отличить двух незнакомых звонивших в списке, как и
          // объяснено в lib/clientPhone.ts. Настоящий номер лежит в `phone`
          // и открывается тому, у кого есть право.
          fullName: `Входящий ${maskClientPhone(entry.phone)}`,
          phone: entry.phone,
          source: "PHONE_CALL",
          kind: settings.defaultKind,
          status: "NEW",
          currency: "TJS",
        },
        select: { id: true, shortId: true, fullName: true },
      });
      await tx.incomingCall.update({
        where: { channelId: entry.channelId },
        data: { clientId: created.id, autoCreatedClient: true },
      });
      return created;
    });
    entry.clientId = client.id;
    entry.clientShortId = client.shortId;
    entry.clientName = client.fullName;
    entry.autoCreatedClient = true;
  } catch (err) {
    // Уникальный телефон: карточка с этим номером всё-таки есть — например, лежала
    // в Корзине (findClientByPhoneDigits её намеренно не считает). Разбираться с
    // удалённой карточкой посреди разговора не будем: звонок и так записан.
    if (!isUniqueViolation(err)) {
      void logSystemError("telephony", `Карточка по входящему звонку не заведена: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Канал звука консультанта на телефоне (externalMedia живого голоса): Asterisk
 * всегда называет такие каналы `UnicastRTP/…` (см. isOwnExternalMediaChannel в
 * liveVoiceBridge.ts). Мост с ним — это консультант, а не оператор.
 */
function isConsultantChannelName(name: string | undefined): boolean {
  return !!name && name.startsWith("UnicastRTP/");
}

/**
 * ОТМЕТКА «ОТВЕТИЛИ» В БАЗЕ — СРАЗУ, А НЕ ТОЛЬКО В КОНЦЕ (№222 ночной проверки
 * 24.09). Итог звонка пишет finishIncomingCall из живой памяти; рестарт процесса
 * посреди разговора эту память уносит, и узнать потом, был ли ответ, неоткуда.
 * Поэтому кто взял трубку (внутренний номер оператора или консультант) пишется
 * в строку журнала в момент соединения. Сам `answered` здесь НЕ ставится: по нему
 * ночной подбор лидов (autoLeadFromCall.ts) берёт законченные разговоры, и
 * идущий долгий разговор ушёл бы в разбор раньше своей записи. Отказ не роняет
 * звонок — это страховка на случай рестарта, итог всё равно пишется в конце.
 */
async function persistAnswerMark(entry: LiveIncoming): Promise<void> {
  const data = entry.bridgedAt
    ? entry.answeredBy
      ? { answeredBy: entry.answeredBy }
      : null
    : entry.consultantAt
      ? { answeredByConsultant: true }
      : null;
  if (!data) return;
  await prisma.incomingCall.updateMany({ where: { channelId: entry.channelId, endedAt: null }, data }).catch((err) => {
    console.error("[звонок] отметка ответа не записана:", err instanceof Error ? err.message : err);
  });
}

/**
 * Закрыть открытые строки журнала, конца которых никто уже не запишет (№222).
 * Был ли ответ — по отметке момента соединения (persistAnswerMark): с ней
 * звонок не «пропущенный». Длительность неизвестна и остаётся пустой.
 */
async function closeOpenIncomingRows(where: Prisma.IncomingCallWhereInput, endedAt: Date): Promise<number> {
  const answered = await prisma.incomingCall.updateMany({
    where: { AND: [where, { endedAt: null }, { OR: [{ answeredBy: { not: null } }, { answeredByConsultant: true }] }] },
    data: { endedAt, answered: true },
  });
  const rest = await prisma.incomingCall.updateMany({ where: { AND: [where, { endedAt: null }] }, data: { endedAt } });
  return answered.count + rest.count;
}

/**
 * УБОРКА СИРОТ РЕСТАРТА (№222 ночной проверки 24.09). Открытая строка журнала
 * старше ORPHAN_AFTER_MS, которой нет в живой памяти этого процесса, — звонок,
 * конец которого потерял прошлый процесс. Зовётся тиком live-calls-sweep в
 * index.ts: там же, где живёт память звонков.
 */
export async function closeOrphanedIncomingCalls(now: Date = new Date()): Promise<number> {
  return closeOpenIncomingRows(
    { startedAt: { lt: new Date(now.getTime() - ORPHAN_AFTER_MS) }, channelId: { notIn: [...live.keys()] } },
    now
  );
}

function newConsultantSessionDone(): NonNullable<LiveIncoming["consultantSessionDone"]> {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  const done = { promise, settled: false, resolve: () => {} };
  done.resolve = () => {
    done.settled = true;
    resolve();
  };
  return done;
}

/** Каналы соединились — с этого момента идёт разговор с оператором. */
export function markIncomingBridged(channelId: string, operatorChannelName?: string): void {
  const entry = live.get(channelId);
  if (!entry || entry.endedAt || entry.bridgedAt) return;
  if (isConsultantChannelName(operatorChannelName)) {
    // Консультант взял трубку. Второй раз (вернулся от агента) — уже отмечено.
    if (entry.consultantAt) return;
    entry.consultantAt = new Date();
    entry.consultantSessionDone = newConsultantSessionDone();
    // ОТМЕТКА «ОТВЕТИЛ КОНСУЛЬТАНТ» В БАЗУ — СРАЗУ (№222, третий аудит робота 02.10.2026,
    // п.2). Без неё рестарт посреди разговора с роботом оставлял строку без отметки, и
    // через ORPHAN_AFTER_MS уборщик закрывал её как пропущенную. Карточку это не создаёт:
    // persistAnswerMark пишет только answeredByConsultant.
    entry.ready = entry.ready.then(() => persistAnswerMark(entry));
    // КАРТОЧКУ НА СНЯТИЕ ТРУБКИ РОБОТОМ НЕ ЗАВОДИМ (02.10.2026, «Всегда первым»).
    // Робот берёт каждый звонок, в том числе сброшенный через секунду, — карточка на
    // каждого значила карточку на курьера, рекламу и случайный набор. Она заводится,
    // когда звонящий заговорил (noteConsultantSession) или проговорил достаточно
    // долго (finishIncomingCall, CONSULTANT_CARD_MIN_SECONDS).
    return;
  }
  entry.bridgedAt = new Date();
  entry.answeredBy = extensionFromChannelName(operatorChannelName);
  entry.ready = entry.ready.then(() => persistAnswerMark(entry));

  // Разговор начался — с этой секунды у незнакомого номера появляется карточка.
  // Продолжаем ЦЕПОЧКУ ready, а не заводим вторую промису: строка журнала пишется
  // параллельно (см. поле ready), и обновлять её раньше, чем она появится, нельзя.
  // Заодно finishIncomingCall дождётся и этой работы — он ждёт ready.
  if (!entry.clientId) {
    entry.ready = entry.ready.then(() => createCardForUnknownCaller(entry));
  }

  // Гасить пуш «Входящий звонок» больше не нужно: его не существует (см. выше).
}

/** Сколько консультант должен был говорить с человеком, чтобы карточка завелась без
 *  итога сессии (итог не пришёл вовсе). Сброс через секунду — не разговор. */
export const CONSULTANT_CARD_MIN_SECONDS = 20;
/** Робот снял трубку и не сказал ни слова: столько человек ждал в тишине, прежде чем
 *  незнакомому номеру заводится карточка с задачей «перезвонить» (09.10.2026, п.3
 *  аудита линии). Меньше — сброс сразу после ответа: курьер, реклама, ошибся номером. */
export const CONSULTANT_ROBOT_SILENT_CARD_MIN_SECONDS = 4;
/**
 * ЗВОНЯЩИЙ ПРОМОЛЧАЛ ПОСЛЕ ПРИВЕТСТВИЯ РОБОТА (11.10.2026, живой звонок 13:47, 9 с).
 * Робот поздоровался, человек не сказал ни слова и положил трубку — часто это живой
 * клиент, которому не понравилось говорить с роботом. У незнакомого номера (нет
 * ответственного агента) такой звонок короче этого срока — пропущенный: карточка и общая
 * задача «Перезвонить», а не «отвечен ИИ» без следа. Дольше — человек слушал робота
 * долго и сам решил не говорить; такой звонок остаётся «отвечен консультантом».
 */
export const SILENT_CALLER_AFTER_ROBOT_MAX_SECONDS = 60;
/**
 * Сколько агент должен был говорить после перевода от консультанта, чтобы разговор
 * засчитался ему (третий аудит робота 02.10.2026, п.1). Перевод на мобильный агента идёт
 * через транк: выключенный телефон отвечает оператор связи или голосовая почта, Dial
 * возвращает ANSWER, мост появляется — а человека, которому сказали «соединяю», никто не
 * слушал. Короче этого срока (и без внутреннего номера от станции) — «агент не взял».
 */
export const TRANSFER_ANSWER_MIN_SECONDS = 15;

/**
 * Консультант перевёл звонок агенту (liveVoiceTransfer.ts). Если агент возьмёт
 * трубку, разговор засчитается ему, даже когда станция не назвала его внутренний
 * номер (ответил на мобильном).
 */
export function noteConsultantTransfer(channelId: string, agent: { id: string; extension: string | null }): void {
  const entry = live.get(channelId);
  if (entry && !entry.endedAt) entry.transferAgent = agent;
}

/** Звонок вернулся от агента к консультанту: агент не взял, засчитывать некому. */
export function noteConsultantReturned(channelId: string): void {
  const entry = live.get(channelId);
  if (!entry) return;
  delete entry.transferAgent;
  // Вторая сессия на том же канале (третий аудит робота 02.10.2026, п.5): ожидатель
  // первого итога уже снят, и конец звонка не дождался бы итога второй части —
  // handedBack второй сессии мог не успеть. Заводим новый, если звонок ещё идёт.
  if (!entry.endedAt && entry.consultantAt && entry.consultantSessionDone?.settled) {
    entry.consultantSessionDone = newConsultantSessionDone();
  }
}

/**
 * Сессия консультанта отчиталась (liveVoiceConsultant.ts, конец сессии).
 *  - spoke — звонящий сказал хоть слово: с этого момента карточка незнакомому номеру
 *    нужна (в неё ляжет разговор, из неё уйдёт лид), и заводится она здесь;
 *  - handedBack — консультант не смог принять звонок и отдал его станции (сбой,
 *    тишина): звонок уйдёт на автоответчик и не должен считаться отвеченным;
 *  - botSpoke — робот сказал в линию хоть слово (09.10.2026, аудит линии, п.3). Не
 *    сказал ни в одной части звонка — звонок пропущенный, а не «отвечен ИИ».
 */
export async function noteConsultantSession(
  channelId: string,
  result: { spoke: boolean; handedBack: boolean; botSpoke?: boolean }
): Promise<void> {
  const entry = live.get(channelId);
  if (!entry) return;
  if (result.spoke) entry.consultantSpoke = true;
  entry.consultantHandedBack = result.handedBack;
  // Одна часть звонка, где робот говорил, — уже ответ (вернувшийся от агента звонок).
  if (result.botSpoke === true) entry.consultantBotSpoke = true;
  else if (result.botSpoke === false && entry.consultantBotSpoke === undefined) entry.consultantBotSpoke = false;
  if (result.spoke && !entry.clientId && !entry.endedAt) {
    try {
      await entry.ready;
      await createCardForUnknownCaller(entry);
    } catch (err) {
      void logSystemError("telephony", `Карточка по звонку консультанта не заведена: ${err instanceof Error ? err.message : err}`);
    }
  }
  entry.consultantSessionDone?.resolve();
}

/**
 * ИТОГ ЗВОНКА, КОТОРЫЙ БРАЛ КОНСУЛЬТАНТ, — ЕМУ ЖЕ (24.09.2026, робозвонок, правка 5).
 *
 * Разговор консультанта (расшифровка, запись, что обсуждали) живёт в
 * lib/telephony/liveVoiceConsultant.ts, а запись в хронологии и строка журнала —
 * здесь. Сойтись им нужно в момент, когда известны оба: консультант получает
 * отсюда id записи хронологии и кладёт в неё разговор, потом отдаёт звонок в
 * раздачу лидов. Крючок, а не импорт: этот модуль не тянет за собой ИИ-часть
 * (тот же приём, что setLiveVoiceCallResolver в liveVoiceBridge.ts).
 */
export interface ConsultantCallEnded {
  channelId: string;
  /** IncomingCall.id. */
  callId: string | null;
  interactionId: string | null;
  clientId: string | null;
  /** true — с человеком говорил только консультант; false — после него трубку
   *  взял агент (разговор агента идёт обычным путём: запись станции, разбор). */
  byConsultant: boolean;
  /**
   * Звонок записан ПРОПУЩЕННЫМ, хотя консультант с человеком говорил (третий аудит
   * робота 02.10.2026, п.1, 3, 6): робот отдал звонок станции после сбоя, либо агент
   * после перевода не взял по-настоящему (автоответчик сотового), либо клиент с агентом
   * молча бросил трубку. Задача «перезвонить» и пуш о пропущенном уже поставлены
   * finishIncomingCall — итог консультанта (расшифровка, лид) всё равно доводится, но
   * второй задачи агенту не ставит.
   */
  missed?: boolean;
  /** Звонящий сказал консультанту хоть слово (итог сессии, если он пришёл вовремя). */
  spoke?: boolean;
  /** Сколько секунд консультант держал трубку до конца звонка. */
  talkSeconds?: number;
}
let consultantCallEndedHook: ((ended: ConsultantCallEnded) => void) | null = null;
export function setConsultantCallEndedHook(fn: ((ended: ConsultantCallEnded) => void) | null): void {
  consultantCallEndedHook = fn;
}

/** Знает ли модуль про такой канал — нужно обработчику событий и тестам. */
export function isTrackedIncoming(channelId: string): boolean {
  return live.has(channelId);
}

/**
 * Звонок закончился: дописываем итог и, если до оператора не дошло, ставим задачу
 * перезвонить.
 */
/**
 * Итог завершённого входящего — ровно то, что нужно вызывающему, чтобы решить,
 * забирать ли запись разговора. Возвращается только на ПЕРВОМ событии конца:
 * повторная доставка отдаёт null, и повторной выгрузки файла не происходит.
 */
export interface FinishedIncoming {
  /** Запись в хронологии клиента. null — карточки не было, писать было некуда. */
  interactionId: string | null;
  answered: boolean;
  talkSeconds: number;
  /**
   * Чем искать файл записи на станции. Отдаётся ТЕМ ЖЕ единственным возвратом,
   * который гарантирует однократность выгрузки: после него запись из `live` уже
   * нельзя читать надёжно (её удаляет отложенный таймер).
   */
  phone: string;
  startedAt: Date;
  /** Момент ответа оператора — от него станция начинает писать разговор. */
  answeredAt: Date | null;
  /**
   * С человеком говорил только консультант на телефоне (ИИ): записи на станции нет
   * (разговор пишет сам консультант), и разбор звонка делает он же
   * (lib/telephony/liveVoiceConsultant.ts), когда получит итог.
   */
  byConsultant: boolean;
}

export async function finishIncomingCall(channelId: string): Promise<FinishedIncoming | null> {
  const entry = live.get(channelId);
  // Уже завершён — это повторная доставка события конца (станция шлёт и StasisEnd,
  // и ChannelDestroyed). Раньше защитой было удаление из карты; теперь запись живёт
  // ещё полторы минуты ради окна оператора, поэтому признак конца проверяется явно.
  if (!entry || entry.endedAt) return null;
  const endedAt = new Date();
  entry.endedAt = endedAt;
  // Забываем звонок не сразу: столько окно оператора ещё показывает разговор и даёт
  // дописать, что услышали (см. KEEP_ENDED_MS).
  setTimeout(() => live.delete(channelId), KEEP_ENDED_MS).unref?.();
  /**
   * Ждём, пока начало звонка допишется в базу: иначе итог уйдёт в updateMany по
   * строке, которой ещё нет, а клиент окажется «неизвестным» (см. поле ready).
   *
   * ОБЯЗАТЕЛЬНО В try/catch. В цепочке ready лежат обращения к базе (поиск клиента
   * сырым SQL, чтение настроек, создание карточки). Короткий обрыв связи с Postgres
   * в момент звонка реджектил бы её — и всё, что ниже, не выполнялось бы вовсе:
   * итог не записан, задача перезвонить не поставлена, пуш не ушёл. Состоявшийся
   * разговор навсегда остался бы в журнале пропущенным и накручивал бы счётчик
   * потерянных обращений, по которому меряют работу агентства.
   */
  try {
    await entry.ready;
  } catch (err) {
    void logSystemError("telephony", `Начало входящего звонка не записалось: ${err instanceof Error ? err.message : err}`);
  }

  /**
   * ИТОГ СЕССИИ КОНСУЛЬТАНТА — ДО РЕШЕНИЙ НИЖЕ (02.10.2026). Трубку взял только робот
   * (человек не подключался): сказал ли звонящий хоть слово и не отдал ли робот
   * звонок станции после сбоя — это приходит итогом сессии, и порядок «конец
   * звонка / итог сессии» не гарантирован. Ждём недолго; не дождались — решаем по
   * длительности.
   */
  const robotOnly = !entry.bridgedAt && !!entry.consultantAt;
  let sessionReported = true;
  if (robotOnly && entry.consultantSessionDone) {
    const timer = { id: undefined as NodeJS.Timeout | undefined };
    sessionReported = await Promise.race([
      entry.consultantSessionDone.promise.then(() => true),
      new Promise<boolean>((r) => {
        timer.id = setTimeout(() => r(false), CONSULTANT_SESSION_WAIT_MS);
        timer.id.unref?.();
      }),
    ]);
    if (timer.id) clearTimeout(timer.id);
  }
  // Робот не смог принять звонок и отдал его станции — человек ушёл на автоответчик:
  // звонок ПРОПУЩЕН, а не отвечен (иначе задачи «перезвонить» нет ни у кого, а
  // сообщение с автоответчика заводит вторую запись звонка, второго лида и второй
  // пуш — voicemailIngest.linkIncomingCall привязывается только к неотвеченному).
  // РОБОТ НЕ СКАЗАЛ НИ СЛОВА (09.10.2026, аудит линии, п.3): Gemini не подключился, звук
  // не дошёл, модель зависла — человек слушал тишину. Это не «отвечен ИИ», а
  // пропущенный: задача «перезвонить» и пуш, как при возврате станции.
  const robotSilent = robotOnly && sessionReported && entry.consultantBotSpoke === false;
  const handedBack = robotOnly && (!!entry.consultantHandedBack || robotSilent);
  const talkedFromRobot = robotOnly && entry.consultantAt
    ? Math.round((endedAt.getTime() - entry.consultantAt.getTime()) / 1000)
    : 0;
  // Карточка незнакомому номеру — когда звонящий заговорил (или, без итога сессии,
  // говорили достаточно долго): робот берёт и звонок, сброшенный через секунду.
  // Робот упал, но звонящий успел заговорить (handedBack + consultantSpoke) — это уже
  // лид, а не пустой звонок: карточка нужна, чтобы расшифровка легла в хронологию
  // (третий аудит, п.3).
  // Робот сломался (вернул звонок станции или промолчал) — карточка и общая задача
  // «перезвонить» и без слов (09.10.2026, п.3): в режиме консультанта звонили агентству,
  // ночью больше некому. Промолчавший робот и сброс через секунду — не повод: тогда
  // нужен хотя бы CONSULTANT_ROBOT_SILENT_CARD_MIN_SECONDS ожидания.
  const robotFailedUnknown =
    !!entry.consultantHandedBack || (robotSilent && talkedFromRobot >= CONSULTANT_ROBOT_SILENT_CARD_MIN_SECONDS);
  // Робот поздоровался, звонящий не сказал ни слова и недолго спустя положил трубку
  // (11.10.2026, см. SILENT_CALLER_AFTER_ROBOT_MAX_SECONDS). Отвечен ли он «по-новому»
  // (пропущенный) — решается ниже, когда известен ответственный: закреплённый клиент
  // остаётся на прежней ветке silentKnown. Итог сессии обязателен: без него неизвестно,
  // говорил ли человек.
  const robotGreetedSilent =
    robotOnly &&
    sessionReported &&
    !entry.consultantHandedBack &&
    entry.consultantBotSpoke === true &&
    !entry.consultantSpoke &&
    talkedFromRobot < SILENT_CALLER_AFTER_ROBOT_MAX_SECONDS;
  if (
    robotOnly &&
    !entry.clientId &&
    (entry.consultantSpoke ||
      (sessionReported && robotFailedUnknown) ||
      robotGreetedSilent ||
      (!handedBack && !sessionReported && talkedFromRobot >= CONSULTANT_CARD_MIN_SECONDS))
  ) {
    try {
      await createCardForUnknownCaller(entry);
    } catch (err) {
      void logSystemError("telephony", `Карточка по звонку консультанта не заведена: ${err instanceof Error ? err.message : err}`);
    }
  }

  const talkFrom = entry.bridgedAt ?? entry.consultantAt;
  const talkSeconds = talkFrom
    ? Math.max(0, Math.round((endedAt.getTime() - talkFrom.getTime()) / 1000))
    : Math.max(0, Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 1000));

  const client = entry.clientId
    ? await prisma.client.findUnique({
        where: { id: entry.clientId },
        // kind — роль перед именем в текстах пушей (formatClientName) и правильная
        // приставка номера карточки.
        // assignedAgent (isActive/frozenAt) — ночная проверка 24.09.2026 (№221/З2-2):
        // задача «перезвонить» и пуш о пропущенном звонке не должны уходить
        // уволенному/замороженному ответственному, см. assignedAgentUnavailable ниже.
        select: {
          id: true,
          shortId: true,
          fullName: true,
          kind: true,
          assignedAgentId: true,
          assignedAgent: { select: { isActive: true, frozenAt: true } },
        },
      })
    : null;

  // Кто снял трубку по внутреннему номеру от станции (подробно — «АВТОР ЗАПИСИ» ниже).
  // Нужен до решения «отвечен ли звонок»: ответивший по добавочному — живой человек.
  const operator = entry.answeredBy
    ? await prisma.agent.findFirst({ where: { sipExtension: entry.answeredBy }, select: { id: true } })
    : null;

  /**
   * ПЕРЕВОД АГЕНТУ, КОТОРЫЙ НИКТО НЕ СЛУШАЛ (третий аудит робота 02.10.2026, п.1). Мост с
   * агентом появляется на любой ANSWER от Dial — и когда у агента выключен телефон, а
   * оператор связи или голосовая почта «сняли трубку». Разговором это не было: короче
   * TRANSFER_ANSWER_MIN_SECONDS и без внутреннего номера от станции (по нему ответил бы
   * живой человек на офисном аппарате) — «агент не взял»: звонок пропущен, задача
   * «перезвонить» и пуш, лид — в общую раздачу, а не «принятым» агентом, который
   * человека не слышал.
   */
  const transferShort =
    !!entry.bridgedAt && !!entry.transferAgent && !entry.answeredBy && talkSeconds < TRANSFER_ANSWER_MIN_SECONDS;
  /** Разговор провёл агент после перевода консультантом, а станция не назвала его
   *  номер: кому его засчитать (см. LiveIncoming.transferAgent). Автор записи и владелец
   *  лида не должны расходиться (п.9): назвала станция другого человека (перехват,
   *  pickup-группа) — кредит не пишем, лид уйдёт ответившему по номеру. */
  const transferCredit =
    entry.bridgedAt && entry.transferAgent && !transferShort && (!operator || operator.id === entry.transferAgent.id)
      ? entry.transferAgent
      : null;
  /**
   * КЛИЕНТ С АГЕНТОМ ПОЗВОНИЛ, РОБОТ ОТВЕТИЛ, КЛИЕНТ МОЛЧА ПОЛОЖИЛ ТРУБКУ (п.6). Это не
   * «поговорил»: контакта не было, а агент о звонке своего клиента иначе не узнает
   * (askAgentToCallBack при молчании не зовётся). Ведём как пропущенный — задача и пуш
   * агенту. Незнакомый номер, промолчавший после приветствия робота, — отдельная ветка
   * silentUnknown выше (11.10.2026): общая задача руководству, а не агенту.
   */
  /**
   * НЕЗНАКОМЫЙ ПРОМОЛЧАЛ ПОСЛЕ ПРИВЕТСТВИЯ РОБОТА (11.10.2026). Карточка у номера есть
   * (заведена выше или найдена по номеру), ответственного у неё нет — перезвонить
   * должно руководство: общая задача «Перезвонить» и пуш о пропущенном. В статистике это
   * НЕ «отвечен ИИ» (answeredByConsultant=false): разговора с роботом не было.
   * Карточки нет (автосоздание выключено, служебный номер, сотрудник) — прежнее
   * поведение: задачу ставить некуда, а пуш по курьеру — шум.
   */
  const silentUnknown = robotGreetedSilent && !!client && !client.assignedAgentId;
  // Консультант взял, человек — нет: звонок НЕ пропущен (задача «перезвонить» и пуш
  // о пропущенном не нужны, консультант разобрал звонок сам), но и оператора не было.
  const robotAnswered = robotOnly && !handedBack && !silentUnknown;
  const silentKnown = robotAnswered && sessionReported && !entry.consultantSpoke && !!client?.assignedAgentId;
  const byConsultant = robotAnswered && !silentKnown;
  const answered = (!!entry.bridgedAt && !transferShort) || byConsultant;

  /**
   * АВТОР ЗАПИСИ — ОПЕРАТОР, ЕСЛИ ЕГО УДАЁТСЯ УЗНАТЬ, и только потом ответственный
   * агент.
   *
   * У Interaction автор обязателен, а раньше кандидат был один — ответственный
   * агент. Из-за этого у карточки, заведённой самим звонком (ответственного у неё
   * нет по замыслу), запись НЕ СОЗДАВАЛАСЬ ВОВСЕ: человек звонил, говорил минуту, а
   * в карточке оставался ноль записей — и вместе с ними терялась запись разговора,
   * потому что привязывать её было не к чему.
   *
   * Оператора узнаём по внутреннему номеру, который сообщила станция: то же
   * сопоставление `answeredBy` → `Agent.sipExtension`, что и в журнале входящих.
   * Что это чужой звонок, а не работа агента, помечено связью IncomingCall →
   * interactionId (см. lib/telephony/incomingInteractions.ts): по ней такие записи
   * отсеиваются везде, где считают работу агента.
   */
  /**
   * ПЕРЕАДРЕСАЦИЯ НА МОБИЛЬНЫЙ АГЕНТА — АВТОРА ПО ВНУТРЕННЕМУ НОМЕРУ НЕТ, НО
   * МАРШРУТ ИЗВЕСТЕН (17.09.2026, починка «звонки Баходура»).
   *
   * С 16.08.2026 звонок известного клиента сначала пробуют увести его ведущему
   * агенту (inboundRouting.ts), в том числе на мобильный через транк —
   * `routeDecision: 'routed_mobile'`. Станция в этом случае не сообщает
   * внутренний номер (`answeredBy` пуст), и `operator` выше не находится, хотя
   * известно ТОЧНО, кто на самом деле поговорил с клиентом: `IncomingCall.routedToId`,
   * записанный inboundRouting.ts::recordDecision по тому же `entry.recordId`.
   *
   * Раньше при пустом `answeredBy` авторство сразу падало на технический fallback
   * (дежурный директор), даже когда маршрутизация точно знала агента — самый
   * старый действующий директор (Баходур) становился автором и получателем KPI
   * за разговоры, которые вели Ноза и Умед (100% звонков «Баходура» на проде
   * 15-17.09 оказались чужими). Порядок ниже: сначала настоящий маршрут, и
   * только если его нет — старый технический fallback.
   */
  let routedAgentId: string | null = !operator && transferCredit ? transferCredit.id : null;
  // Только если трубку взял ЧЕЛОВЕК (bridgedAt): у звонка, который принял консультант,
  // «routed» означает лишь, что агенту звонили и он не ответил, — автором разговора
  // его делать нельзя (02.10.2026).
  if (!operator && !routedAgentId && entry.bridgedAt && !transferShort && entry.recordId) {
    try {
      const routed = await prisma.incomingCall.findUnique({
        where: { id: entry.recordId },
        select: { routeDecision: true, routedToId: true },
      });
      if (
        routed?.routedToId &&
        (routed.routeDecision === "routed" || routed.routeDecision === "routed_mobile")
      ) {
        routedAgentId = routed.routedToId;
      }
    } catch (err) {
      void logSystemError(
        "telephony",
        `Не удалось проверить маршрут входящего для авторства записи: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * Раньше оператор отвечал на внутреннем аппарате, и `answeredBy` совпадал с
   * `Agent.sipExtension`. Теперь неизвестные звонки уводятся на мобильный
   * +992 777 776 001 через транк: станция сообщает канал транка, внутреннего
   * номера в нём нет, и по sipExtension не находится никто. У самого мобильного
   * владельца-`Agent` тоже нет — это номер компании, а не человека.
   *
   * Без автора запись в хронологии не заводилась вовсе (`authorId === null`), а
   * вместе с ней терялись запись разговора и расшифровка — то есть отваливалась
   * ВСЯ цепочка «поговорили → карточка сама → лид агенту». Поэтому нужен запасной
   * автор.
   *
   * Только для ОТВЕЧЕННОГО звонка: у пропущенного оператора не было вовсе, и
   * приписывать разговор человеку, который трубку не брал, нельзя. И только
   * когда ни настоящий маршрут (routedAgentId), ни ведущий агент карточки
   * (client.assignedAgentId, ниже) не нашлись — это последний рубеж, а не
   * приоритетный кандидат.
   */
  /**
   * АВТОРСТВО (П-10, 17.09.2026, docs/audit/lead-ownership-17-09.md §2,
   * docs/audit/recon-17-09/04-timeline-authorship.md §b.1 — «директор-фолбэк как
   * автор разговора», дефект №1 по вреду). Единственные легитимные
   * человек-авторы — тот, кто ответил по добавочному (`operator`), и тот, кому
   * реально маршрутизировали звонок (`routedAgentId`). `incomingOperatorIds()`
   * ("дежурный оператор") НЕ годится в агент-автора, хотя название обманчиво:
   * это первая линия приёма (с 20.09.2026 — признак `takesUnknownCalls`, до того
   * руководители с правом `clients.assign`) — ПОЛУЧАТЕЛЬ уведомлений
   * (см. doc-comment самой функции), а не тот, кто физически взял трубку. Использовать его как автора — тот же самый директорский фолбэк,
   * просто под другим именем: он подписывал разговоры Нозы и Умеда самым
   * старым руководителем и превращал его в автора чужой работы и получателя
   * чужого KPI (100% звонков «Баходура» на проде 15-17.09 оказались чужими).
   * `client?.assignedAgentId` тоже НИКОГДА не используется как agent-автор —
   * владение карточкой не значит, что этот человек сейчас говорил.
   *
   * Без явного человека запись пишется как SYSTEM (раньше без автора её не
   * заводили вовсе — «Interaction.agentId обязателен» — этого ограничения
   * больше нет), а держатель карточки уходит в subjectAgentId: задача
   * «Перезвонить» у недозвонившегося клиента по-прежнему попадает в его
   * список дел, но запись не выглядит так, будто он лично не поднял трубку.
   */
  const agentAuthorId = operator?.id ?? routedAgentId ?? null;

  // След в хронологии клиента — то, ради чего всё и затевалось: агент видит, что
  // клиент звонил сам. Что звонок входящий и принял его не агент, сказано прямо в
  // тексте, иначе запись читалась бы как его собственный звонок.
  let interactionId: string | null = null;
  // Дедуп «Перезвонить — клиент звонил сам и не дозвонился» (21.09.2026): раньше
  // каждый пропущенный входящий заводил новую задачу без проверки, на проде это
  // 81 задача на 32 клиента (см. lib/autoTasks.ts). Если у клиента уже открыта
  // такая задача, эта запись звонка её не получает — существующая обновляется
  // ниже, claimAutoTaskSlot сам продлит срок.
  const missedCallCallback = {
    nextAction: silentUnknown
      ? "Перезвонить — клиент молчал после приветствия робота, возможно, положил трубку, услышав робота"
      : "Перезвонить — клиент звонил сам и не дозвонился",
    nextActionDate: new Date(Date.now() + 15 * 60 * 1000),
  };
  const missedCallSlot =
    client && !answered ? await claimAutoTaskSlot(client.id, "inbound_missed_callback", missedCallCallback.nextAction, missedCallCallback.nextActionDate) : null;
  if (client) {
    try {
      const interaction = await logTimeline({
        clientId: client.id,
        actor: agentAuthorId
          ? { kind: "agent", agentId: agentAuthorId }
          : {
              kind: "system",
              source: byConsultant ? "live-voice-consultant" : "incoming-call",
              subjectAgentId: client.assignedAgentId ?? null,
              // Клиент без агента позвонил сам: «Перезвонить» — задача руководства,
              // общая по замыслу (lib/timeline.ts, sharedTask), а не пропажа —
              // до 28.09 каждый такой звонок будил «Здоровье системы».
              ...(client.assignedAgentId ? {} : { sharedTask: true as const }),
            },
        type: "CALL",
        notes: byConsultant
            ? `Входящий звонок клиента: ответил консультант (ИИ), ${formatDuration(talkSeconds)}`
            : silentKnown
              ? `Входящий звонок клиента: ответил консультант (ИИ), клиент ничего не сказал и положил трубку (${formatDuration(talkSeconds)}) — перезвоните`
            : silentUnknown
              ? `Входящий звонок: робот (ИИ) поздоровался, звонящий ничего не сказал и положил трубку (${formatDuration(talkSeconds)}) — возможно, положил трубку, услышав робота. Перезвоните`
            : transferShort
              ? `Входящий звонок клиента: консультант (ИИ) соединил с агентом, но разговора не вышло (${formatDuration(talkSeconds)}, возможно, ответил автоответчик телефона) — перезвоните`
            : answered
            ? `Входящий звонок клиента: поговорил с ${entry.consultantAt ? "агентом после консультанта" : "оператором"}${entry.answeredBy ? ` (${entry.answeredBy})` : ""}, ${formatDuration(talkSeconds)}`
            : handedBack
              ? "Входящий звонок клиента: консультант (ИИ) не смог принять звонок из-за сбоя, звонок ушёл на автоответчик — перезвоните"
              : "Входящий звонок клиента: до оператора не дозвонился",
          /**
           * ИСХОД НЕ СТАВИМ ВООБЩЕ — ни у отвеченного, ни у пропущенного.
           *
           * Раньше у недозвонившегося клиента писался `NO_ANSWER`, и его читали
           * задом наперёд: `lib/clientAutoStatus.ts` считает три таких подряд и
           * объявляет клиента «Недоступным», а `routes/clients.ts` шлёт руководству
           * «агент не может дозвониться до клиента». То есть человек трижды пытался
           * дозвониться ДО НАС — и за это его же помечали недоступным, а агента
           * выставляли виноватым. Исход разговора описывает работу агента, а тут
           * агент не участвовал.
           *
           * Что клиент не дозвонился, видно из текста записи и из задачи
           * «Перезвонить» ниже — ровно там, где это нужно живому человеку.
           *
           * У СОСТОЯВШЕГОСЯ разговора исход, наоборот, обязателен, и это НЕЙТРАЛЬНО.
           * Пустой исход читается как «связи не было»: `clientAutoStatus.ts` требует
           * непустого, чтобы засчитать «клиент проявил себя сам», и без него человек,
           * позвонивший в офис и поговоривший десять минут, продолжал остывать в
           * статусах, а агенту летело напоминание «вы забыли про клиента». Чем
           * разговор кончился, знает только оператор — он и запишет это разбором.
           *
           * ЗАГЛУШКА, А НЕ РЕШЕНИЕ (24.09.2026, найдено ревью — см. lib/aiCallOutcome.ts).
           * `outcomeSource: "SYSTEM_STUB"` — не человек и не ИИ, а именно то, чем это
           * является: временная метка ради clientAutoStatus.ts. Без неё `applyAiCallOutcome`
           * видел здесь уже «занятый» outcome и НИКОГДА не переписывал его настоящим
           * разбором — у ВСЕХ отвеченных входящих (в отличие от исходящих через CRM)
           * итог, nextAction и напоминание callbackAt не долетали до карточки.
           * outcomeSource="HUMAN" (дефолт) здесь ставить нельзя: applyAiCallOutcome
           * обязан отличать эту заглушку от настоящего решения агента.
           */
          outcome: answered ? "NEUTRAL" : null,
          ...(answered ? { outcomeSource: "SYSTEM_STUB" } : {}),
          ...(answered || !missedCallSlot?.assignToNewRecord
            ? {}
            : {
                nextAction: missedCallCallback.nextAction,
                // Пятнадцать минут — тот же срок, что CRM даёт на перезвон после
                // собственного недозвона (см. POST /clients/:id/interactions).
                nextActionDate: missedCallCallback.nextActionDate,
                autoTaskKind: "inbound_missed_callback",
              }),
          recordingDurationSec: answered ? talkSeconds || null : null,
          /**
           * Состоявшийся входящий — такой же подтверждённый контакт, как исходящий
           * разговор: клиент и агентство поговорили, и гейт Неактивных обязан это
           * видеть (lib/inactiveTrafficLight.ts).
           *
           * НЕОТВЕЧЕННЫЙ ВХОДЯЩИЙ ОСТАЁТСЯ ПУСТЫМ — здесь пытались дозвониться ДО
           * НАС, а не мы до клиента. Записать это попыткой агента значило бы
           * зачесть ему в след работы то, чего он не делал, — та же ошибка, из-за
           * которой у этой записи выше не проставляется outcome.
           */
        callAttempt: answered ? "TALKED" : null,
      });
      interactionId = interaction.id;
    } catch (err) {
      void logSystemError("telephony", `Входящий звонок не попал в хронологию: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ЗАКРЫТЬ СТАРЫЕ ПОДСКАЗКИ КЛИЕНТА (18.08.2026, см. lib/nextActionAutoClose.ts):
  // клиент позвонил сам — новое реальное взаимодействие, независимо от того,
  // дозвонился ли он до оператора. Своя же подсказка «Перезвонить...» (заведена
  // выше, если не answered) исключена по interactionId.
  if (client && interactionId) {
    void closeStaleNextActions(client.id, interactionId).catch((err) =>
      console.error("[звонок] закрытие старых подсказок:", err instanceof Error ? err.message : err)
    );
  }
  // Состоявшийся разговор (оператор поговорил с клиентом) снимает все открытые
  // «перезвонить» этого клиента (21.09.2026, lib/autoTasks.ts) — повод исчез,
  // независимо от того, кто заводил задачу (сам этот файл, недозвон исходящего,
  // автоответчик). Непринятый звонок сюда не попадает: это как раз событие,
  // которое САМО заводит inbound_missed_callback чуть выше.
  // Консультант — не человек: «перезвонить» остаётся, агенту перезванивать всё равно.
  if (client && answered && !byConsultant) {
    void closeAutoTasks(client.id, CALLBACK_AUTO_TASK_KINDS).catch((err) =>
      console.error("[звонок] автозакрытие «перезвонить»:", err instanceof Error ? err.message : err)
    );
  }

  /**
   * ОТВЕТСТВЕННЫЙ УВОЛЕН ИЛИ ЗАМОРОЖЕН — ЗАДАЧА И ПУШ ЕМУ НЕ ИДУТ (24.09.2026,
   * ночная проверка №221/З2-2, решение владельца). Раньше `callbackAgentId`
   * ставился на `assignedAgentId` независимо от того, работает ли этот
   * человек сейчас: пропущенный звонок клиента уволенного/замороженного
   * агента заводил ЕМУ задачу «перезвонить» и пуш, хотя он клиентов больше не
   * ведёт. Тем же путём, что и у звонка «своему агенту» (см.
   * inboundRouting.ts::OPERATOR_REASONS), такой агент теперь приравнён к «нет
   * ответственного» — ниже в notifyMissed это уходит руководителям.
   */
  const assignedAgentUnavailable =
    !!client?.assignedAgent && (!client.assignedAgent.isActive || !!client.assignedAgent.frozenAt);
  const callbackAgentId = !answered && client?.assignedAgentId && !assignedAgentUnavailable ? client.assignedAgentId : null;

  try {
    await prisma.incomingCall.updateMany({
      where: { channelId },
      data: {
        endedAt,
        answered,
        talkSeconds,
        answeredBy: entry.answeredBy ?? transferCredit?.extension ?? null,
        answeredByConsultant: robotAnswered,
        interactionId,
        callbackAgentId,
        // Робот перевёл звонок агенту, и тот ответил: по этой записи разбор лида
        // отдаёт его ПРОВЕДШЕМУ разговор агенту, а не в общую раздачу
        // (autoLeadFromCall.ts, consultant_transfer_answered).
        ...(transferCredit ? { routeDecision: "consultant_transfer_answered", routedToId: transferCredit.id } : {}),
      },
    });
    // Звонок кончился: журнал, лента и счётчики пропущенных протухли разом.
    if (entry.recordId) {
      publishCallUpdated({ callId: entry.recordId, clientId: client?.id ?? null, agentId: client?.assignedAgentId ?? null });
    }
  } catch (err) {
    void logSystemError("telephony", `Итог входящего звонка не записан: ${err instanceof Error ? err.message : err}`);
  }

  /**
   * СОСТОЯВШИЙСЯ РАЗГОВОР — ЭТО КОНТАКТ. Без этой отметки CRM считала, что с
   * клиентом давно не общались: `clientAutoStatus.ts` остужал ему статус, а
   * `cardReminders.ts` слал агенту «вы забыли про клиента» — про того, кто звонит
   * в офис каждый день. Недозвон контактом не считаем: связи не случилось.
   */
  if (answered && client) {
    await prisma.client
      .update({ where: { id: client.id }, data: { lastContactAt: endedAt } })
      .catch((err) =>
        logSystemError("telephony", `Отметка контакта по входящему не записана: ${err instanceof Error ? err.message : err}`)
      );

    /**
     * «ВАШ КЛИЕНТ ЗВОНИЛ В ОФИС» — ОТВЕТСТВЕННОМУ АГЕНТУ.
     *
     * О ПРОПУЩЕННОМ звонке своего клиента агент узнавал пушем (notifyMissed ниже),
     * а о СОСТОЯВШЕМСЯ — никак: оставалась строка в хронологии, которую надо ещё
     * найти. Клиент говорил с оператором, договаривался о чём-то, а человек, который
     * ведёт сделку, об этом не знал. «Что дальше после контакта» для агента
     * начинается с того, что он вообще узнал о контакте.
     *
     * Себе не шлём: если трубку снял сам ответственный, уведомлять его о собственном
     * разговоре незачем.
     *
     * ЧАСАМИ ПРИЁМА НЕ ГЕЙТИМ, в отличие от notifyMissed: разговор
     * реально состоялся, это факт, а не ложный сигнал ночной настройки.
     *
     * Повторную доставку события конца звонка гасит не тег, а признак `entry.endedAt`
     * в начале finishIncomingCall: до этой ветки второй раз просто не доходит. Тег
     * нужен для другого — он схлопывает карточки уведомлений в шторке, чтобы
     * несколько звонков подряд не превращались в стопку. Таймаут
     * отправки ограничен внутри push.ts (PUSH_SEND_TIMEOUT_MS) — ждать безопасно.
     */
    // После консультанта агенту пишет сам консультант — с тем, что человек хотел
    // (lib/telephony/liveVoiceConsultant.ts): «звонил в офис» без сути был бы вторым,
    // пустым уведомлением об одном событии.
    if (client.assignedAgentId && client.assignedAgentId !== (operator?.id ?? transferCredit?.id) && !byConsultant) {
      /**
       * ОТВЕТСТВЕННЫЙ УВОЛЕН ИЛИ ЗАМОРОЖЕН — ПУШ РУКОВОДСТВУ, А НЕ ЕМУ (24.09.2026,
       * ночная проверка №221/З2-2, тот же класс, что у пропущенного звонка выше —
       * см. `assignedAgentUnavailable`/`notifyMissed`). До этой правки такой
       * сценарий почти не возникал: звонок клиента отключённого агента уходил в
       * автоответчик раньше, чем до оператора (см. inboundRouting.ts). Теперь он
       * доходит до оператора, и, если тот ответил, «Ваш клиент звонил в офис»
       * уходило бы человеку, который клиентов больше не ведёт.
       */
      if (assignedAgentUnavailable) {
        const supervisors = await findAgentsWithPermission("clients.assign");
        if (supervisors.length > 0) {
          await sendPushToAgents(supervisors, {
            title: "📞 Клиент говорил с оператором",
            body: `${formatClientName(client)} поговорил с оператором (${formatDuration(talkSeconds)}) — ответственный сейчас не работает (уволен/заморожен), назначьте того, кто продолжит`,
            url: `/clients/${client.shortId}`,
            tag: `incoming-answered-${entry.channelId}`,
          }).catch((err) =>
            logSystemError(
              "telephony",
              `Уведомление руководству о звонке клиента отключённого агента не ушло: ${err instanceof Error ? err.message : err}`
            )
          );
        }
      } else {
        await sendPushToAgent(client.assignedAgentId, {
          title: "📞 Ваш клиент звонил в офис",
          body: `${formatClientName(client)} поговорил с оператором (${formatDuration(talkSeconds)}) — загляните в карточку`,
          url: `/clients/${client.shortId}`,
          tag: `incoming-answered-${entry.channelId}`,
        }).catch((err) =>
          logSystemError(
            "telephony",
            `Уведомление агенту о звонке его клиента не ушло: ${err instanceof Error ? err.message : err}`
          )
        );
      }
    }
  }

  if (!answered) {
    await notifyMissed(entry, client, callbackAgentId, assignedAgentUnavailable);
  }

  if (entry.consultantAt && consultantCallEndedHook) {
    try {
      consultantCallEndedHook({
        channelId,
        callId: entry.recordId ?? null,
        interactionId,
        clientId: client?.id ?? null,
        byConsultant: robotAnswered,
        missed: handedBack || silentKnown || silentUnknown || transferShort,
        spoke: !!entry.consultantSpoke,
        talkSeconds: Math.max(
          0,
          Math.round(((entry.bridgedAt ?? endedAt).getTime() - entry.consultantAt.getTime()) / 1000)
        ),
      });
    } catch (err) {
      void logSystemError("telephony", `Итог звонка не передан консультанту: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    interactionId,
    answered,
    talkSeconds,
    phone: entry.phone,
    startedAt: entry.startedAt,
    answeredAt: entry.bridgedAt ?? null,
    byConsultant,
  };
}

/**
 * Пропущенный звонок обязан кого-то разбудить.
 *
 * Есть ответственный агент, и он работает — задача и пуш ему: это его клиент, и
 * перезванивать ему. Ответственного нет, лид ещё не распределён, ИЛИ
 * ответственный уволен/заморожен (`agentUnavailable`, 24.09.2026, ночная
 * проверка №221/З2-2) — пуш руководству: там решат, кому передать. Молчать
 * нельзя ни в одном из случаев — пропущенный звонок это несостоявшийся клиент,
 * и узнавать о нём из журнала задним числом поздно.
 */
async function notifyMissed(
  entry: LiveIncoming,
  client: { shortId: number; fullName: string; kind: ClientKind } | null,
  callbackAgentId: string | null,
  /** У карточки ЕСТЬ ответственный, но он уволен/заморожен — пуш руководству
   *  должен назвать эту причину, а не звучать как «у карточки нет
   *  ответственного» (что было бы неправдой). */
  agentUnavailable = false
): Promise<void> {
  /**
   * Вне часов приёма не будим НИКОГО — ни агента, ни руководителя.
   *
   * Ночью не дозвонились не потому, что кто-то проспал: в это время звонки никто и
   * не принимает, и пуш «пропущенный звонок» в три часа ночи сообщает не о потере,
   * а о работе настройки. Задача перезвонить при этом ставится как обычно (она
   * выше по коду) — утром её увидят, и клиент не потеряется.
   */
  const settings = await loadIncomingSettings();
  if (!incomingHoursOpen(settings)) return;

  if (callbackAgentId && client) {
    await sendPushToAgent(callbackAgentId, {
      title: "📞 Пропущенный звонок клиента",
      body: `${formatClientName(client)} звонил сам и не дозвонился — перезвоните`,
      url: `/clients/${client.shortId}`,
      tag: `incoming-missed-${entry.channelId}`,
    });
    return;
  }

  const supervisors = await findAgentsWithPermission("clients.assign");
  if (supervisors.length === 0) return;
  /**
   * Про переадресацию говорим прямо в тексте. «Пропущенный» звучит как «клиент
   * потерян», а если на станции настроен запасной номер, человек мог спокойно
   * дозвониться туда — и руководитель, поднятый пушем среди дня, должен знать это
   * сразу, а не выяснять у оператора.
   */
  const tail = settings.forwardPhone ? ` Звонок мог уйти на ${settings.forwardPhone}.` : "";
  await sendPushToAgents(supervisors, {
    title: "📞 Пропущенный звонок",
    body:
      (client
        ? agentUnavailable
          ? `${formatClientName(client)} звонил и не дозвонился — ответственный сейчас не работает (уволен/заморожен), назначьте того, кто перезвонит`
          : `${formatClientName(client)} звонил и не дозвонился — у карточки нет ответственного`
        : `Звонили с номера ${entry.phone} — в базе такого клиента нет`) + tail,
    url: "/calls",
    tag: `incoming-missed-${entry.channelId}`,
  });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * Каналы, о конце которых станция не сообщила (обрыв туннеля, перезапуск АТС).
 *
 * Два разных срока, потому что это два разных случая. Разговор может идти долго —
 * там четыре часа. А звонок, до которого оператор так и не дошёл, столько не ждёт:
 * в очереди не сидят полчаса, и висящая панель с бегущим таймером по звонку,
 * которого давно нет, — это не «неточность», это требование разобрать пустоту.
 *
 * Брошенную запись ЗАКРЫВАЕМ В ЖУРНАЛЕ. Просто забыть её означало бы оставить в
 * базе звонок без конца навсегда: он вечно числился бы пропущенным и накручивал
 * счётчик потерянных обращений, по которому меряют работу агентства.
 */
function sweepStale(): void {
  const now = Date.now();
  for (const [id, entry] of live) {
    const limit = entry.bridgedAt || entry.consultantAt ? STALE_AFTER_MS : STALE_UNANSWERED_MS;
    if (now - entry.startedAt.getTime() < limit) continue;
    live.delete(id);
    if (entry.endedAt) continue;
    void prisma.incomingCall
      .updateMany({
        where: { channelId: id, endedAt: null },
        data: {
          endedAt: new Date(),
          answered: !!entry.bridgedAt || !!entry.consultantAt,
          answeredByConsultant: !entry.bridgedAt && !!entry.consultantAt,
          talkSeconds:
            entry.bridgedAt || entry.consultantAt
              ? Math.round((now - (entry.bridgedAt ?? entry.consultantAt)!.getTime()) / 1000)
              : null,
          answeredBy: entry.answeredBy ?? null,
        },
      })
      .catch((err) =>
        logSystemError("telephony", `Брошенный входящий звонок не закрыт: ${err instanceof Error ? err.message : err}`)
      );
  }
}

/** Живой звонок по id записи журнала — им пользуется разбор, чтобы обновить память. */
export function liveIncomingByRecordId(recordId: string): LiveIncoming | undefined {
  for (const entry of live.values()) {
    if (entry.recordId === recordId) return entry;
  }
  return undefined;
}

/**
 * ЗВОНОК, КОТОРЫЙ ОПЕРАТОР ПЕРЕВОДИТ С ОФИСНОГО ТЕЛЕФОНА (24.09.2026, deskTransfer.ts).
 *
 * В Stasis попадает не канал транка, по которому звонок записан в `live`, а тот,
 * что был в мосте с оператором: при звонке через очередь это половинка
 * `Local/10xx@from-queue;2`. Своё у неё — только linkedid: он равен id канала,
 * с которого начался звонок, то есть ключу в `live`. Поэтому ищем по списку id
 * (сам канал, его linkedid), а не нашли — по номеру звонящего, если такой живой
 * звонок ровно один. Дожидаемся ready: карточку незнакомому номеру заводит мост
 * оператора, и перевод не должен её обогнать.
 */
export async function liveIncomingForTransfer(
  ids: (string | null | undefined)[],
  callerPhone: string | null | undefined
): Promise<{ channelId: string; recordId: string | null; clientId: string | null; answeredBy: string | null } | null> {
  let entry = ids.map((id) => (id ? live.get(id) : undefined)).find((e) => e && !e.endedAt);
  if (!entry && callerPhone) {
    const phone = toCrmPhone(callerPhone);
    const same = [...live.values()].filter((e) => !e.endedAt && e.phone === phone);
    if (same.length === 1) entry = same[0];
  }
  if (!entry) return null;
  try {
    await entry.ready;
  } catch {
    // Отказ начала звонка уже записан в журнал тем, кто его ждёт (finishIncomingCall).
  }
  return {
    channelId: entry.channelId,
    recordId: entry.recordId ?? null,
    clientId: entry.clientId ?? null,
    answeredBy: entry.answeredBy ?? null,
  };
}

/**
 * Только для тестов: дождаться, пока начало звонка и карточка допишутся в базу.
 *
 * В проде этого ждать некому и не нужно: обработчик событий АТС не стоит из-за
 * записи, а finishIncomingCall дожидается той же цепочки сам. Тесту, который
 * проверяет состояние ПОСРЕДИ разговора, ждать больше нечего.
 */
export async function awaitIncomingReady(channelId: string): Promise<void> {
  const entry = live.get(channelId);
  await entry?.ready;
  await entry?.routing;
}

/**
 * Все живые входящие — для дашборда телефонии.
 *
 * Не фильтруем ни по кому: дашборд смотрит руководитель, и ему нужна вся картина
 * станции. Уже завершённые (но ещё не забытые) звонки отсеиваем — на дашборде «сейчас
 * в эфире» должно означать ровно то, что написано.
 */
export function liveIncomingCalls(): {
  channelId: string;
  phone: string;
  startedAt: Date;
  answeredAt: Date | undefined;
  answeredBy: string | undefined;
  /** Трубку держит консультант (ИИ), до оператора звонок не дошёл. */
  answeredByConsultant: boolean;
  clientName: string | undefined;
  clientShortId: number | undefined;
  talkSeconds: number;
}[] {
  sweepStale();
  const now = Date.now();
  return [...live.values()]
    .filter((entry) => !entry.endedAt)
    .map((entry) => ({
      channelId: entry.channelId,
      phone: entry.phone,
      startedAt: entry.startedAt,
      answeredAt: entry.bridgedAt ?? entry.consultantAt,
      answeredBy: entry.answeredBy ?? (entry.consultantAt && !entry.bridgedAt ? "ИИ" : undefined),
      answeredByConsultant: !!entry.consultantAt && !entry.bridgedAt,
      clientName: entry.clientName,
      clientShortId: entry.clientShortId,
      talkSeconds: Math.max(0, Math.round((now - (entry.bridgedAt ?? entry.consultantAt ?? entry.startedAt).getTime()) / 1000)),
    }));
}

/** Только для тестов: забыть все живые входящие. */
export function resetIncomingCalls(): void {
  live.clear();
}

/** Только для тестов: положить в память готовый живой звонок. */
export function seedLiveIncoming(entry: {
  channelId: string;
  phone: string;
  startedAt?: Date;
  bridgedAt?: Date;
  consultantAt?: Date;
  endedAt?: Date;
  answeredBy?: string;
  recordId?: string;
  clientId?: string;
  clientName?: string;
  clientShortId?: number;
  assignedAgentId?: string;
  autoCreatedClient?: boolean;
}): void {
  live.set(entry.channelId, { ...entry, startedAt: entry.startedAt ?? new Date(), ready: Promise.resolve() });
}
