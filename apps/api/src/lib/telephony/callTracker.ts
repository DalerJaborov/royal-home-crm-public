import type { CallState } from "@royal-home/shared";
import { prisma } from "../../db.js";
// Импорт напрямую из services/leads/firstCall.js, а не из бочки-реэкспорта
// leads.js (01.09.2026, найдено проверкой циклов импортов в CI): leads.js
// реэкспортирует и services/leads/selection.js, тот тянет agentOccupancyShield.js,
// а он — этот же файл callTracker.js. Через бочку это замыкалось в цикл
// leads.js → selection.js → agentOccupancyShield.js → callTracker.js → leads.js;
// прямой импорт того же самого экспорта разрывает цикл, не меняя поведения.
import { rewardFirstCallIfOnTime } from "./rewardFirstCallHook.js";
import { refreshClientStatus } from "../clientAutoStatus.js";
import { markAgentAttempt } from "../clientWorkStalled.js";
import { notifyNoAnswerEscalation, planNoAnswerStep } from "../noAnswerStreak.js";
import { checkNoAnswerStreakForTrafficLight } from "../noAnswerTrafficLight.js";
import { closeStaleNextActions } from "../nextActionAutoClose.js";
import { claimAutoTaskSlot, closeAutoTasks, CALLBACK_AUTO_TASK_KINDS } from "../autoTasks.js";
import { logSystemError } from "../systemError.js";
import { findAgentsWithPermission } from "../recipients.js";
import { sendPushToAgents } from "../../push.js";
import { forgetRecordingPath, ingestCallRecording, recordingFetchConfig } from "./callRecordings.js";
import { pauseConversationsAfterRealContact } from "../conversationDelivery.js";
import { mapWithConcurrency } from "../concurrency.js";
import { dushanbeDateTimeString } from "../dushanbeTime.js";
import { recordAgentCallAttempt, resetAgentNoPickupGuard } from "./agentNoPickupGuard.js";
import { ACTIVE_CHANNELS_LIMIT, listActiveChannels, loadAriCredentials } from "./ariClient.js";

/**
 * Состояние живых звонков — то, что видит агент на экране, пока говорит.
 *
 * Зачем понадобилось. До 07.08.2026 CRM знала о звонке ровно одно: станция приняла
 * команду. Кнопка писала «Сохранено» и снова становилась активной, а что происходит
 * дальше — звонит ли телефон, ответил ли клиент, сколько идёт разговор — не знал
 * никто. Владелец сформулировал это так: «нажимаешь позвонить, пишет сохранено, и
 * непонятно, что происходит».
 *
 * Теперь состояние приходит событиями с самой АТС (см. ariEvents.ts) и живёт здесь.
 *
 * Почему в памяти процесса, а не в базе. Звонок живёт минуты, интересен только тому,
 * кто его ведёт, и умирает вместе с разговором; писать его в БД — значит держать
 * таблицу, которая пишется каждую секунду и не нужна назавтра. В базу попадает
 * ИТОГ звонка (запись в хронологии клиента), и это делается здесь же, при завершении.
 * Процесс API один (PM2 без кластера, см. DEPLOY.md) — переживать за синхронизацию
 * между копиями не нужно; если копий станет больше, состояние переедет в Redis.
 */

// Стадии звонка описаны один раз в @royal-home/shared: их же читает экран вызова,
// и раньше список был объявлен дважды — сервером и веб-клиентом порознь.
export type { CallState };

export interface ActiveCall {
  channelId: string;
  agentId: string;
  clientId: string;
  /** Короткий номер карточки: именно по нему открывается клиент (GET /clients/:id
   *  ждёт shortId). По внутреннему uuid страница честно отвечает «клиент не найден» —
   *  на этом попались сразу после первого живого звонка. */
  clientShortId: number;
  clientName: string;
  /** Номер, на который станция звонит самому агенту (его мобильный или внутренний).
   *  Показывается на экране звонка: если вызов уходит не туда, это видно сразу, а не
   *  через журнал станции — на этом уже потеряли вечер 07.08.2026. */
  dialingTo: string;
  /** Запись в хронологии клиента, заведённая при начале звонка. К ней по завершении
   *  привязываются исход, длительность и файл разговора. */
  interactionId?: string;
  /** Внутренний номер агента и телефон клиента — по ним ищется файл записи в
   *  каталоге станции: имя файла станция не сообщает (см. callRecordings.ts). */
  agentExtension?: string;
  clientPhone?: string;
  state: CallState;
  startedAt: Date;
  /**
   * Дошёл ли вызов до телефона КЛИЕНТА.
   *
   * Отслеживаемый канал — канал АГЕНТА: станция сначала звонит ему (ariClient.ts
   * делает originate на agentEndpoint) и только после того, как агент снял свою
   * трубку, набирает клиента. Поэтому «звонок кончился без ответа» само по себе НЕ
   * значит «клиент не ответил»: агент мог не взять трубку, телефон мог быть
   * выключен, SIP — не зарегистрирован, и телефон клиента не звонил вовсе.
   *
   * Признак нужен отдельным полем, потому что к моменту finishCall состояние уже
   * "ended" и по нему пройденные стадии не восстановить.
   */
  clientRang?: boolean;
  /**
   * Агент нажал «Отменить» на полосе звонка: случайно набрал или передумал.
   *
   * Пометка НЕ решает исход сама — она лишь говорит, как читать то, что произошло
   * дальше. Правда остаётся за станцией: если клиент успел ответить в ту же секунду,
   * когда нажали отмену, это короткий, но настоящий разговор, и записывается он как
   * разговор (см. finishCall). Иначе кнопка задним числом стирала бы состоявшуюся
   * связь.
   */
  cancelledByAgent?: boolean;
  /**
   * Агент нажал «Позвонить через мобильный» посреди разговора (плохая связь в
   * браузере) — этот канал доживает последние мгновения, новый уже набирается.
   * Пока флаг стоит, канал не считается «живым» для hasLiveCall — иначе второй
   * (мобильный) звонок отбился бы правилом «сначала завершите текущий разговор».
   * См. POST /me/active-call/retry-mobile в routes/me.ts.
   */
  retiring?: boolean;
  /** Момент ответа клиента — от него считается длительность разговора. */
  answeredAt?: Date;
  /**
   * Ответ КЛИЕНТА доказан, а не предположен.
   *
   * Доказательством считается одно из двух: в событии Dial станция явно назвала
   * набранный номер, и он совпал с телефоном клиента, — либо переменная канала
   * DIALSTATUS=ANSWER. Всё остальное (Dial с ANSWER, но без dialstring) — догадка:
   * ответить мог и сам агент на первом плече, ради чего вся эта машинерия и заведена.
   *
   * Догадка НЕ отменяется отсутствием доказательств: если станцию спросить не
   * удалось, разговор остаётся разговором (иначе состоявшийся звонок пропал бы из
   * учёта и из Royal Score — самая дорогая из возможных ошибок). Флаг нужен для
   * другого: положительное доказательство недозвона его перебивает, а завершение
   * звонка с неподтверждённым ответом попадает в журнал как сигнал «переменные
   * станции не читаются, надо разбираться».
   */
  answerConfirmed?: boolean;
  endedAt?: Date;
  /** Итог для человека: «поговорили 1:12», «клиент не ответил». */
  outcome?: string;
}

/** channelId → звонок. Один агент за раз ведёт один звонок (см. activeCallFor). */
const calls = new Map<string, ActiveCall>();

/** Сколько держим завершённый звонок, чтобы агент успел увидеть итог на экране. */
const KEEP_ENDED_MS = 20_000;

/** Повтор записи исхода звонка в хронологию после временного сбоя базы (CHANNEL-NEW-38):
 *  пауза (растёт с попыткой) и число повторов. Изменяемый объект — ради тестов. */
export const callOutcomeRetry = { delayMs: 30_000, maxAttempts: 2 };

/**
 * Как часто неподтверждённый ответ клиента попадает в журнал.
 *
 * Это индикатор, а не ошибка звонка: раз в час достаточно, чтобы заметить, что
 * переменные станции перестали читаться, и мало, чтобы залить журнал (при поломке
 * такой звонок был бы КАЖДЫМ). Остальные случаи видны в консоли контейнера — тем же
 * приёмом, что у «пути вне каталога записей» в callRecordings.ts.
 */
const UNCONFIRMED_ANSWER_LOG_INTERVAL_MS = 60 * 60_000;
let unconfirmedAnswerLoggedAt: number | null = null;

export function trackCall(call: Omit<ActiveCall, "state" | "startedAt">): ActiveCall {
  const entry: ActiveCall = { ...call, state: "ringing_agent", startedAt: new Date() };
  calls.set(call.channelId, entry);
  return entry;
}

export function getCall(channelId: string): ActiveCall | undefined {
  return calls.get(channelId);
}

/** Звонок, который сейчас ведёт этот агент, — его и показывает интерфейс. */
export function activeCallFor(agentId: string): ActiveCall | undefined {
  for (const call of calls.values()) {
    if (call.agentId === agentId) return call;
  }
  return undefined;
}

/** Есть ли у агента звонок, который ещё не закончился, — тогда кнопки «Позвонить»
 *  на других карточках заблокированы: нельзя начать второй разговор, не закончив первый.
 *  Звонок в процессе замены на мобильный (retiring) не считается — его СВОЙ новый
 *  звонок как раз и набирается сейчас, ждать нечего. */
export function hasLiveCall(agentId: string): boolean {
  const call = activeCallFor(agentId);
  return !!call && call.state !== "ended" && !call.retiring;
}

/**
 * Бронь на время между «проверили hasLiveCall» и «trackCall звонка записан»
 * (найдено ревью 19.08.2026). originateCallToClient проверяет hasLiveCall
 * синхронно, а сам trackCall происходит только после нескольких await —
 * ARI-кредов, resolveAgentDialTarget (тоже поход к станции), originateCall,
 * записи Interaction. Двойной клик или повторный запрос после медленного
 * ответа успевает проскочить оба раза до первого trackCall и уводит агенту
 * ДВА живых канала разом. Бронь синхронна и живёт только до первого await —
 * ставится и снимается в одном тике event loop, гонки внутри неё нет.
 */
const originating = new Set<string>();

/** true — бронь легла, вызывающий продолжает. false — у агента уже идёт
 *  origination, вызывающий обязан отказать без похода к станции. */
export function beginOrigination(agentId: string): boolean {
  if (originating.has(agentId)) return false;
  originating.add(agentId);
  return true;
}

/** Снять бронь — ОБЯЗАТЕЛЬНО в finally вызывающего, успехом или отказом. */
export function endOrigination(agentId: string): void {
  originating.delete(agentId);
}

/**
 * Пометить канал «доживающим» — см. `retiring` в ActiveCall. Возвращает звонок,
 * если пометка легла (или снимается, `on: false`, если новый звонок не набрался
 * и старый разговор нужно оставить как есть).
 */
export function markCallRetiring(channelId: string, on: boolean): ActiveCall | undefined {
  const call = calls.get(channelId);
  if (!call || call.state === "ended") return undefined;
  call.retiring = on;
  return call;
}

/**
 * Пометить звонок отменённым агентом. Возвращает звонок, если пометка легла.
 *
 * Отдельно от `finishCall`: сброс на станции может не пройти (туннель к АТС отвалился),
 * и тогда вызов продолжает идти — объявлять его завершённым было бы враньём. Поэтому
 * сначала помечаем, потом просим станцию сбросить, а итог по-прежнему пишет обработчик
 * её событий.
 */
export function markCallCancelled(channelId: string): ActiveCall | undefined {
  const call = calls.get(channelId);
  if (!call || call.state === "ended") return undefined;
  call.cancelledByAgent = true;
  return call;
}

/**
 * Ответ клиента ДОКАЗАН: станция явно назвала набранный номер, и он совпал с
 * телефоном клиента (см. classifyDialLeg в ariEvents.ts). Ставится сразу после
 * setCallState(..., "talking") — отдельным вызовом, чтобы у самого setCallState
 * остался один смысл: «стадия звонка сменилась».
 */
export function confirmClientAnswer(channelId: string): void {
  const call = calls.get(channelId);
  if (!call || call.state === "ended") return;
  call.answerConfirmed = true;
}

export function setCallState(channelId: string, state: CallState): void {
  const call = calls.get(channelId);
  if (!call || call.state === "ended") return;
  call.state = state;
  // Обе стадии означают, что агент уже на линии и станция набирает клиента:
  // "ringing_client" — телефон клиента звонит, "talking" — он ответил. Отмечаем и на
  // "talking" тоже: событие Dial/ANSWER иногда приходит без предшествующего
  // ChannelStateChange, и тогда состоявшийся разговор выглядел бы недошедшим.
  if (state === "ringing_client" || state === "talking") call.clientRang = true;
  if (state === "talking" && !call.answeredAt) call.answeredAt = new Date();
}

/**
 * Итог дозвона КЛИЕНТУ, как его видит сама станция (переменные канала DIALSTATUS и
 * ANSWEREDTIME, читаются в ariEvents.ts при завершении канала).
 */
export interface StationDialResult {
  /** DIALSTATUS: ANSWER | BUSY | NOANSWER | CONGESTION | CHANUNAVAIL | CANCEL | null. */
  status: string | null;
  /** ANSWEREDTIME — сколько секунд длился разговор с клиентом (null, если не сообщено). */
  answeredSeconds: number | null;
}

/** Исходы, при которых телефон клиента звонил (или был занят), но разговора не было. */
const NO_ANSWER_STATUSES = new Set(["BUSY", "NOANSWER", "CONGESTION", "CHANUNAVAIL"]);

/**
 * НАДЁЖНЫЙ ИСТОЧНИК ПРАВДЫ О ВТОРОМ ПЛЕЧЕ (18.08.2026).
 *
 * До этого CRM решала «разговор состоялся» по событию Dial с ANSWER. В режиме «на
 * мобильный» плеч два: сначала станция звонит САМОМУ АГЕНТУ, и только когда тот снял
 * трубку — клиенту. Ответ агента приходил таким же Dial/ANSWER, и недозвон
 * записывался разговором: в карточке «разговор 0:37» при клиенте NO ANSWER, файл
 * записи в 44 байта, платная расшифровка гудков и ни одного исхода «Клиент не
 * ответил» в базе за неделю — при десятках на станции.
 *
 * Переменная канала DIALSTATUS относится ровно ко второму плечу и врать не умеет.
 * Поэтому она сильнее всего, что насчитали события: BUSY/NOANSWER — стираем отметку
 * об ответе, ANSWER — ставим её, даже если ни одного пригодного Dial не пришло, и
 * отсчитываем разговор назад от конца звонка по ANSWEREDTIME.
 *
 * Идемпотентно: у уже завершённого звонка (повторная доставка события конца канала)
 * ничего не трогаем — итог записан.
 */
export function applyStationDialResult(channelId: string, result: StationDialResult): void {
  const call = calls.get(channelId);
  if (!call || call.state === "ended" || !result.status) return;

  if (NO_ANSWER_STATUSES.has(result.status)) {
    // Телефон клиента звонил (станция дошла до второго плеча) — значит это именно
    // недозвон клиенту, а не «агент не снял трубку».
    call.clientRang = true;
    call.answeredAt = undefined;
    return;
  }

  if (result.status === "ANSWER") {
    call.clientRang = true;
    call.answerConfirmed = true;
    if (!call.answeredAt) {
      const seconds = result.answeredSeconds ?? 0;
      call.answeredAt = new Date(Date.now() - Math.max(0, seconds) * 1000);
    }
  }
}

/** Длительность разговора в секундах (0, если клиент так и не ответил). */
export function talkSeconds(call: ActiveCall): number {
  if (!call.answeredAt) return 0;
  const end = call.endedAt ?? new Date();
  return Math.max(0, Math.round((end.getTime() - call.answeredAt.getTime()) / 1000));
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Звонок закончился: считаем итог, дописываем его в хронологию клиента и оставляем
 * запись в памяти ненадолго, чтобы агент увидел результат.
 *
 * Запись в хронологии заводится ОДНА на звонок — она создаётся при старте
 * (routes/clients.ts) и здесь дополняется исходом. Две записи на один разговор
 * читались бы как два звонка и портили бы и хронологию, и счёт агента.
 */
export async function finishCall(channelId: string): Promise<ActiveCall | undefined> {
  const call = calls.get(channelId);
  if (!call || call.state === "ended") return call;

  call.endedAt = new Date();
  const seconds = talkSeconds(call);
  call.state = "ended";
  // Три разных итога, а не два: «агент не снял трубку» — это НЕ недозвон клиенту,
  // телефон клиента в этом случае не звонил (см. поле clientRang).
  /**
   * Отмена засчитывается, ТОЛЬКО если разговор так и не начался. Если клиент ответил
   * в ту же секунду, когда агент нажал «Отменить», связь состоялась — и записывается
   * она как разговор. Кнопка не может задним числом отменить то, что уже случилось.
   */
  const cancelled = !!call.cancelledByAgent && !call.answeredAt;
  call.outcome = call.answeredAt
    ? `Поговорили ${formatDuration(seconds)}`
    : cancelled
      ? "Вызов отменён"
      : call.clientRang
        ? "Клиент не ответил"
        : "Агент не снял трубку";

  // Запись исхода — замыканием, чтобы её можно было повторить после временного сбоя
  // базы (CHANNEL-NEW-38): `ended` выше ставится до обращения к базе, и без повтора
  // отказ оставлял звонок без callAttempt, NO_ANSWER и всех хуков.
  let outcomeWritten = false;
  const persistOutcome = async (): Promise<void> => {
    // Дописываем итог в ту же запись, что завели при начале звонка (её id известен —
    // см. routes/clients.ts). Поиск «по последней подходящей» был бы лотереей, если
    // агент за минуту звонил одному клиенту дважды.
    // Недозвон КЛИЕНТУ — только когда его телефон правда звонил. Иначе (агент не
    // снял свою трубку) это событие про агента, и клиент к нему непричастен.
    /**
     * ОТМЕНА — НЕ НЕДОЗВОН, и путать их нельзя. Клиент трубку не «не поднял», это
     * агент передумал. Записать отмене исход NO_ANSWER значило бы, что три случайных
     * нажатия объявляют живого клиента «Не отвечает» (clientAutoStatus), запускают
     * цепочку перезвонов и дёргают руководителя — за то, чего клиент не делал.
     */
    const clientDidNotAnswer = !call.answeredAt && !!call.clientRang && !cancelled;
    /**
     * Серия считается ДО того, как в эту запись ляжет исход NO_ANSWER: `streak`
     * считает предыдущие подряд неудачные звонки, а текущая попытка — `streak + 1`.
     * После обновления запись сама вошла бы в серию и попытки сдвинулись бы на одну
     * (см. тот же порядок в routes/me.ts и комментарий в planNoAnswerStep).
     */
    const noAnswerStep = clientDidNotAnswer ? await planNoAnswerStep(call.clientId, call.endedAt) : null;
    // Дедуп «Перезвонить — клиент не ответил (попытка N из M)» (21.09.2026,
    // lib/autoTasks.ts): если у клиента уже открыта такая задача с предыдущей
    // попытки, эта запись её не получает — claimAutoTaskSlot обновит текст/срок
    // существующей (актуальный номер попытки), а не заведёт вторую.
    const noAnswerRetrySlot =
      clientDidNotAnswer && noAnswerStep && !noAnswerStep.escalated
        ? await claimAutoTaskSlot(call.clientId, "no_answer_retry", noAnswerStep.nextAction!, noAnswerStep.nextActionDate!)
        : null;

    /**
     * ОТМЕНА ДО ТОГО, КАК ТЕЛЕФОН КЛИЕНТА ЗАЗВОНИЛ, — СЛЕДА НЕ ОСТАВЛЯЕТ.
     *
     * Решение владельца 13.08.2026. Запись в хронологии заводится по факту команды
     * (routes/clients.ts), то есть ещё до того, как станция дозвонилась хоть кому-то.
     * Для клиента этого звонка не было: его телефон молчал, он ничего не знает.
     * История клиента — про то, что происходило С КЛИЕНТОМ, и случайное нажатие
     * агента ей не принадлежит. Оставлять строку значило бы засорять карточку ровно
     * тем, ради чего кнопку и просили.
     *
     * `deleteMany` вместо `delete` — повторное нажатие «Отменить» не должно падать
     * на отсутствующей записи.
     */
    if (cancelled && !call.clientRang && call.interactionId) {
      await prisma.interaction.deleteMany({ where: { id: call.interactionId } });
      outcomeWritten = true;
    } else if (call.interactionId) {
      /**
       * НЕ ЗАТИРАТЬ «ЗВОНОК ПОТЕРЯН» МОЛЧА (24.09.2026, найдено ревью —
       * противоречие в ленте). Если checkStuckCallStubs уже пометил эту
       * заготовку тревогой (LOST_CALL_NOTE_PREFIX выше) и отправил пуш
       * руководству, а ChannelDestroyed всё же дошёл ПОЗЖЕ (станция просто
       * задержалась) — обычный текст «Звонок через CRM, разговор X:XX» тихо
       * стирал тревогу, будто её и не было. Руководитель, среагировавший на
       * пуш, находил в карточке как ни в чём не бывало обычную запись и не
       * понимал, ложной была тревога или связь правда терялась.
       */
      const existingNote = await prisma.interaction.findUnique({
        where: { id: call.interactionId },
        select: { notes: true },
      });
      const wasMarkedLost = existingNote?.notes?.startsWith(LOST_CALL_NOTE_PREFIX) ?? false;
      const outcomeText = call.answeredAt
        ? `разговор ${formatDuration(seconds)}`
        : cancelled
          ? "звонок отменён агентом — телефон клиента уже звонил"
          : clientDidNotAnswer
            ? "клиент не ответил"
            : "агент не снял трубку, клиенту не звонили";
      // Одна и та же классификация нужна и записи ниже (callAttempt), и
      // троттлингу/счётчику AGENT_NO_PICKUP (agentNoPickupGuard.ts) — считаем
      // её один раз, а не дублируем ту же цепочку тернарников дважды.
      const callAttempt: "TALKED" | "CANCELLED" | "NO_ANSWER" | "AGENT_NO_PICKUP" = call.answeredAt
        ? "TALKED"
        : cancelled
          ? "CANCELLED"
          : clientDidNotAnswer
            ? "NO_ANSWER"
            : "AGENT_NO_PICKUP";
      if (wasMarkedLost) {
        // ОТЗЫВ ТРЕВОГИ — сама тревога (пуш + запись в журнал ошибок) не
        // отзывается автоматически нигде в интерфейсе, поэтому запись в
        // хронологии обязана сказать словами, что произошло: канал не
        // потерян, станция просто подтвердила это позже обычного.
        void logSystemError(
          "telephony",
          `Звонок НЕ потерян: станция подтвердила завершение позже обычного (клиент ${call.clientName} №${call.clientShortId}, ${outcomeText}) — предыдущая тревога «звонок потерян» по этой же заготовке ложная`,
          // Ключ — вид события, а не заготовка (E11, 02.10.2026): id в ключе давал
          // пуш «Новая проблема» директорам на каждый такой звонок.
          { dedupKey: "Звонок НЕ потерян: станция подтвердила завершение позже обычного" }
        );
      }
      await prisma.interaction.update({
        where: { id: call.interactionId },
        data: {
          notes: wasMarkedLost
            ? `Станция подтвердила завершение позже: ${outcomeText}`
            : call.answeredAt
            ? `Звонок через CRM, разговор ${formatDuration(seconds)}`
            : cancelled
              ? // Сюда попадает только отмена, когда телефон клиента УЖЕ звонил
                // (иначе запись удалена выше). Клиент увидит пропущенный и может
                // перезвонить — значит в его истории это событие есть, и написано
                // должно быть честно: отменил агент, а не «клиент не ответил».
                "Звонок через CRM отменён агентом — телефон клиента уже звонил"
              : clientDidNotAnswer
                ? "Звонок через CRM: клиент не ответил"
                : // Честный текст вместо прежнего «клиент не ответил»: до клиента вызов
                  // не дошёл, и в карточке это должно читаться именно так.
                  "Звонок через CRM не состоялся: агент не снял трубку, клиенту не звонили",
          recordingDurationSec: seconds || null,
          /**
           * ЧЕМ КОНЧИЛСЯ ДОЗВОН — машиночитаемо, рядом с текстом для человека.
           *
           * Ровно те же четыре ветки, что и у notes выше, но не строкой: по тексту
           * заметки отличить недозвон клиенту от «агент не снял трубку» можно лишь
           * догадкой, а первая правка формулировки эту догадку ломает. На различии
           * держится гейт перевода в Неактивные (lib/inactiveTrafficLight.ts):
           * попытка дозвониться — след работы, несостоявшийся звонок агента — нет.
           */
          callAttempt,
          /**
           * НЕДОЗВОН ЧЕРЕЗ CRM — ТАКОЙ ЖЕ НЕДОЗВОН, КАК ОТМЕЧЕННЫЙ РУКАМИ.
           *
           * До 12.08.2026 звонок, на который клиент не ответил, оставлял в
           * карточке только строку «клиент не ответил»: ни исхода, ни задачи
           * перезвонить. Тот же факт, записанный агентом вручную через
           * POST /clients/:id/interactions, ставил и то и другое — то есть
           * последствие зависело от способа записи, а не от того, что произошло.
           * Без исхода недозвон не видели ни `clientAutoStatus` («Не отвечает»
           * после трёх подряд), ни выборки по исходам.
           *
           * НО ТОЛЬКО ЕСЛИ ТЕЛЕФОН КЛИЕНТА ЗВОНИЛ. Отслеживаемый канал — канал
           * АГЕНТА, и звонок, оборвавшийся до стадии `ringing_client`, значит
           * «агент не взял трубку», а не «клиент не ответил». Записывать такое
           * клиенту нельзя вдвойне: три подряд — и `clientAutoStatus` объявит
           * живого клиента «Не отвечает» за то, чего он не делал.
           *
           * ЦЕПОЧКА ПЕРЕЗВОНОВ СЧИТАЕТСЯ ЗДЕСЬ ЖЕ, БЕЗ УЧАСТИЯ АГЕНТА (13.08.2026).
           * Раньше здесь стоял фиксированный перезвон через 15 минут
           * (lib/noAnswerFollowUp.ts, удалён 14.08.2026), а настраиваемая серия попыток с эскалацией
           * руководителю (lib/noAnswerStreak.ts, ТЗ п.23) запускалась только когда
           * агент подтверждал исход руками. Ради этого подтверждения после недозвона
           * открывалось окно «Как прошёл звонок» — и владелец справедливо возразил:
           * спрашивать «как прошло» там, где трубку не подняли, значит приучить
           * закрывать окно не глядя. Теперь серия считается сама, окна нет.
           */
          ...(clientDidNotAnswer && noAnswerStep
            ? {
                outcome: "NO_ANSWER",
                // На последней разрешённой попытке задачи агенту НЕ ставим: дальше
                // решает руководитель (см. notifyNoAnswerEscalation ниже), и лишняя
                // задача «перезвонить» спорила бы с этим решением.
                ...(noAnswerStep.escalated || !noAnswerRetrySlot?.assignToNewRecord
                  ? {}
                  : { nextAction: noAnswerStep.nextAction, nextActionDate: noAnswerStep.nextActionDate, autoTaskKind: "no_answer_retry" }),
              }
            : {}),
        },
      });
      // Дальше только хуки: их сбой повторять не нужно, исход уже лежит в базе.
      outcomeWritten = true;

      // Троттлинг повторного набора + счётчик серии недозвонов АГЕНТА
      // (24.09.2026, agentNoPickupGuard.ts) — состояние в памяти процесса, не
      // ждём и не проверяем результат здесь по той же причине, что и весь
      // остальной finishCall: обработчик событий АТС не должен стоять.
      recordAgentCallAttempt(call.agentId, call.clientId, callAttempt, call.endedAt);

      /**
       * ПОПЫТКА АГЕНТА СВЯЗАТЬСЯ — ЗАСЧИТАНА (владелец 08.09.2026, фундамент
       * контроля без всплывающих окон, см. lib/clientWorkStalled.ts).
       *
       * И когда клиент взял трубку, и когда не ответил: главное правило новой
       * схемы — «агент звонит, клиент не берёт» это НЕ тишина, а работа. Не
       * засчитывать недозвон значило бы обвинять агента ровно за то, в чём он не
       * виноват.
       *
       * CANCELLED и AGENT_NO_PICKUP не в счёт: до телефона клиента вызов не
       * дошёл, попытки связаться не было.
       */
      if (call.answeredAt || clientDidNotAnswer) {
        // Звонок делал сам агент карточки — но проверку оставляем общей: если
        // набирал не он, счётчик его тишины двигать не за что.
        void markAgentAttempt(call.clientId, call.endedAt, call.agentId);
      }
      // Три недозвона подряд — «Не отвечает» (см. lib/clientAutoStatus.ts). Пересчёт
      // ровно там же, где его делает ручная отметка, иначе статус двигался бы только
      // от записей, сделанных руками. Не ждём: обработчик событий АТС не должен стоять.
      if (clientDidNotAnswer) {
        void refreshClientStatus(call.clientId).catch((err) =>
          console.error("[звонок] автостатус:", err instanceof Error ? err.message : err)
        );
      }
      // Раздел C (план 19-plan-03-09-evening.md): 3 недозвона подряд без единого
      // разговора между ними — автоматический вход в светофор неактивных. Не ждём:
      // та же причина, что и у автостатуса выше.
      if (clientDidNotAnswer) {
        void checkNoAnswerStreakForTrafficLight(call.clientId).catch((err) =>
          console.error("[звонок] авто-неактивность по недозвонам:", err instanceof Error ? err.message : err)
        );
      }
      // ЗАКРЫТЬ СТАРЫЕ ПОДСКАЗКИ КЛИЕНТА (18.08.2026, см. lib/nextActionAutoClose.ts):
      // звонок через CRM — новое реальное взаимодействие, только если телефон
      // клиента правда звонил (разговор состоялся ИЛИ подтверждённый недозвон
      // клиенту, call.clientRang) — «агент не снял свою трубку» клиента не
      // касается вовсе, закрывать по нему нечего. Своя же подсказка (если только
      // что заведена, escalated=false) исключена по excludeInteractionId — иначе
      // она гасила бы сама себя в этой же операции.
      if (call.answeredAt || (call.clientRang && !cancelled)) {
        void closeStaleNextActions(call.clientId, call.interactionId).catch((err) =>
          console.error("[звонок] закрытие старых подсказок:", err instanceof Error ? err.message : err)
        );
      }
      // Состоявшийся разговор снимает все открытые «перезвонить» этого клиента
      // (21.09.2026, lib/autoTasks.ts) — недозвон САМ ПО СЕБЕ (clientDidNotAnswer)
      // сюда не попадает: это как раз событие, которое заводит/продлевает
      // no_answer_retry несколькими строками выше.
      if (call.answeredAt) {
        void closeAutoTasks(call.clientId, CALLBACK_AUTO_TASK_KINDS).catch((err) =>
          console.error("[звонок] автозакрытие «перезвонить»:", err instanceof Error ? err.message : err)
        );
      }
      // Попытки кончились — задача и пуш руководителю. Не ждём по той же причине.
      if (clientDidNotAnswer && noAnswerStep?.escalated) {
        const clientForEscalation = await prisma.client.findFirst({
          where: { id: call.clientId, deletedAt: null },
          // kind — чтобы в пуше о недозвонах стояли роль перед именем и правильная
          // приставка номера («Продавец ПР-000058», а не «ПК-000058»).
          select: { id: true, fullName: true, shortId: true, kind: true },
        });
        if (clientForEscalation) {
          void notifyNoAnswerEscalation(clientForEscalation, call.agentId, noAnswerStep.maxAttempts).catch((err) =>
            console.error("[звонок] уведомление о недозвонах:", err instanceof Error ? err.message : err)
          );
        }
      }
    }
  };
  const retryOutcome = (attempt: number): void => {
    if (attempt > callOutcomeRetry.maxAttempts) return;
    setTimeout(() => {
      if (outcomeWritten) return;
      persistOutcome().catch((err) => {
        void logSystemError("telephony", `Исход звонка ${channelId} не записан и после повтора ${attempt}: ${err instanceof Error ? err.message : err}`, {
          dedupKey: "call-outcome-not-persisted",
        });
        retryOutcome(attempt + 1);
      });
    }, callOutcomeRetry.delayMs * attempt).unref?.();
  };
  try {
    await persistOutcome();
  } catch (err) {
    // Хронология важна, но не ценой падения обработчика событий: следующий звонок
    // должен отслеживаться, даже если запись не обновилась. Но отказ виден в журнале
    // (раньше catch был пустым), а запись исхода повторяется.
    void logSystemError("telephony", `Исход звонка ${channelId} не записан в хронологию: ${err instanceof Error ? err.message : err}`, {
      dedupKey: "call-outcome-not-persisted",
    });
    if (!outcomeWritten) retryOutcome(1);
  }

  /**
   * СОСТОЯВШИЙСЯ РАЗГОВОР — ЭТО КОНТАКТ (то же правило, что у входящего звонка,
   * см. incomingCalls.ts). Без этой отметки агент, работающий только через
   * CRM-телефонию, выглядел забросившим клиентов: `clientAutoStatus.ts` остужал
   * статус, а `cardReminders.ts` слал «вы забыли про клиента» — про того, кому
   * звонят ежедневно. Недозвон контактом не считаем: связи не случилось.
   *
   * `firstContactAt` проставляется ОДИН РАЗ — условие в `where` делает это без
   * чтения карточки и без гонки между двумя звонками подряд.
   *
   * Обе отметки — ОДНОЙ транзакцией: это один факт «состоялся разговор», и
   * записаться он должен целиком либо никак. Порознь обрыв связи между запросами
   * оставлял бы карточку с последним контактом, но без первого.
   *
   * `deletedAt: null` — как в lib/clientMessageAlert.ts: клиент в Корзине не
   * оживает от того, что по его старому номеру кто-то дозвонился.
   *
   * НЕ ЖДЁМ РЕЗУЛЬТАТА, как и всё остальное в этой функции: она вызывается из
   * обработчика событий АТС, и он не должен стоять на записи в базу. Отказ уходит
   * в журнал через logSystemError, а не теряется молча.
   */
  if (call.answeredAt) {
    const contactedAt = call.endedAt;
    void prisma
      .$transaction([
        prisma.client.updateMany({
          where: { id: call.clientId, deletedAt: null },
          data: { lastContactAt: contactedAt },
        }),
        prisma.client.updateMany({
          where: { id: call.clientId, deletedAt: null, firstContactAt: null },
          data: { firstContactAt: contactedAt },
        }),
      ])
      .catch((err) =>
        logSystemError("telephony", `Отметка контакта по звонку не записана: ${err instanceof Error ? err.message : err}`, { dedupKey: "Отметка контакта по звонку не записана: …" })
      );

    /**
     * РАЗГОВОР СОСТОЯЛСЯ — БОТ БОЛЬШЕ НЕ ВЕДЁТ ДИАЛОГ (владелец 18.09.2026, см.
     * lib/conversationDelivery.ts::pauseConversationsAfterRealContact). До этого
     * звонка бот отвечал клиенту полноценно, как до приёма заявки, — само
     * назначение агента больше не гасит его. Голосовой контакт — тот же сигнал,
     * что и ручной ответ агента в переписке, и гасит бота той же паузой.
     */
    void pauseConversationsAfterRealContact(call.clientId).catch((err) =>
      logSystemError("telephony", `Пауза бота после разговора не выставлена: ${err instanceof Error ? err.message : err}`, { dedupKey: "Пауза бота после разговора не выставлена: …" })
    );
  }

  /* Окно «Итог разговора» здесь больше не заводится: механизм обязательных
     окон удалён 13.09.2026. Сам звонок, его запись и разбор ИИ остаются —
     они писались в хронологию независимо от окна. */

  // Royal Score: первый звонок по лиду засчитывается по РЕАЛЬНОЙ длительности
  // разговора (решение владельца 09.08.2026), а не по записанному итогу. Здесь
  // единственное место, где длительность известна сразу и точно. Не ждём
  // результата: балл не должен задерживать обработку следующего события с АТС.
  if (seconds > 0) {
    void rewardFirstCallIfOnTime(call.clientId, call.agentId, seconds).catch((err) =>
      console.error("[звонок] балл за первый звонок:", err instanceof Error ? err.message : err)
    );
  }

  /**
   * РАЗГОВОР ЗАПИСАН ПО ДОГАДКЕ — ЭТО НАДО ВИДЕТЬ.
   *
   * Сюда попадает звонок, у которого ответ клиента ничем не доказан: пригодного Dial
   * не было, а DIALSTATUS у станции не прочитался. Такой звонок мы намеренно
   * засчитываем разговором (потерять настоящий разговор дороже, чем изредка
   * посчитать лишний), но молчать об этом нельзя: если такие записи посыпались, значит
   * переменные канала не читаются вовсе и вся защита от «ответил агент, а не клиент»
   * держится на одном dialstring.
   *
   * РАЗБОР 21.09.2026 («поговорили 0:36», клиент трубку не брал: 1014 в 12:16,
   * 12:34, 12:37; 1013 в 16:16–16:31). Ровно этот случай: по CDR у таких звонков
   * есть только плечо АГЕНТА (originateCall всегда идёт через Local-канал в
   * дальплан, см. ariClient.ts, и в режиме «на мобильный» И в режиме «на
   * внутренний» станция сначала звонит самому агенту — classifyDialLeg это уже
   * различает, когда dialstring есть). Здесь его НЕТ ни на одном из двух Dial —
   * ни станция не назвала набранный номер агенту, ни впоследствии клиенту, —
   * поэтому leg остаётся "unknown" оба раза, и первый же ANSWER (агент поднял
   * трубку) молча становится «talking» через setCallState.
   *
   * ПОЧЕМУ ЭТО НЕ ИСПРАВЛЕНО ЗДЕСЬ. Единственный способ отличить такой звонок от
   * настоящего разговора без dialstring — считать ПОРЯДОК Dial-событий (первое
   * терминальное — всегда агент, второе — всегда клиент, раз originate всегда
   * двухэтапный). Это предположение о дальплане станции, а не о коде CRM, и
   * подтвердить его можно только чтением реального extensions_custom.conf на
   * станции (вне apps/api, ops/asterisk) — без этого подтверждения менять здесь
   * поведение по умолчанию с «разговор» на «недозвон» значило бы рисковать той
   * самой потерей настоящих разговоров, ради которой это поведение и выбрано
   * (см. докстринг answerConfirmed выше). ЧТО НУЖНО ДЛЯ НАСТОЯЩЕГО ФИКСА: либо
   * станция начинает передавать dialstring на обоих Dial (тогда classifyDialLeg
   * решает вопрос сам, без правки здесь), либо кто-то подтверждает по
   * extensions_custom.conf, что originate ВСЕГДА двухэтапный без исключений —
   * тогда leg можно определять по номеру подряд идущих терминальных Dial того же
   * канала, не трогая dialstring вовсе.
   *
   * ЧТО СДЕЛАНО ВМЕСТО ЭТОГО (21.09.2026) — сообщение обогащено именем и
   * коротким номером карточки клиента и длительностью «разговора»: до этого в
   * журнале был только channelId, по которому карточку без похода в CDR станции
   * найти нельзя было вовсе — то, чем ровно эта тревога и должна была помочь.
   */
  if (call.answeredAt && !call.answerConfirmed) {
    const now = Date.now();
    const due =
      unconfirmedAnswerLoggedAt === null || now - unconfirmedAnswerLoggedAt >= UNCONFIRMED_ANSWER_LOG_INTERVAL_MS;
    const message =
      `Ответ клиента не подтверждён станцией (клиент ${call.clientName} №${call.clientShortId}, ` +
      `агент ${call.agentId}, канал ${channelId}, засчитано «поговорили ${formatDuration(seconds)}»): ` +
      `DIALSTATUS не прочитан, разговор засчитан по событию Dial`;
    if (due) {
      unconfirmedAnswerLoggedAt = now;
      // dedupKey ЯВНО, СВОЙ ЛИТЕРАЛЬНЫЙ ПРЕФИКС СООБЩЕНИЯ (20.09.2026, тот же
      // класс, что уже чинили в ariEvents.ts — см. докстринг dedupKey в
      // systemError.ts). Без него channelId (а теперь ещё и имя клиента),
      // стоящий В НАЧАЛЕ текста, делал бы каждую запись «впервые виденной»:
      // everSeen никогда не совпадал бы сам с собой, и владельцу уходил бы пуш
      // на КАЖДЫЙ часовой тик этой поломки — ровно то, что владелец прямо
      // просил прекратить. Сам факт в журнале остаётся (раз в час, как и было),
      // пуш — только один раз, на первое появление этого класса поломки вообще.
      void logSystemError("telephony", message, { dedupKey: "Ответ клиента не подтверждён станцией" });
    } else {
      console.warn(`[звонок] ${new Date().toISOString()} ${message} (о том же уже записано в журнал)`);
    }
  }

  setTimeout(() => calls.delete(channelId), KEEP_ENDED_MS).unref?.();
  return call;
}

/** Только для тестов: полностью очистить состояние. */
/**
 * Все живые исходящие — для дашборда телефонии (руководитель видит всю станцию,
 * а не только свой звонок, как в `activeCallFor`). Завершённые, но ещё не забытые
 * (они висят KEEP_ENDED_MS ради экрана итога), сюда не попадают: «сейчас в эфире»
 * должно означать ровно это.
 */
export function liveOutgoingCalls(): ActiveCall[] {
  return [...calls.values()].filter((call) => !call.endedAt);
}

/**
 * Досинхронизация ИСХОДЯЩИХ звонков после обрыва подписки на события АТС
 * (владелец 19.08.2026: «нажимаю позвонить — звонок не идёт»).
 *
 * ПОЧЕМУ НУЖНА. `calls` живёт только в памяти процесса (см. шапку файла) и
 * снимается ЕДИНСТВЕННЫМ путём — событием ChannelDestroyed из ariEvents.ts.
 * Если подписка на события рвётся (см. `Нет связи с событиями АТС` в
 * ariEvents.ts) РОВНО в момент, когда чей-то звонок уже идёт, и разговор
 * заканчивается ДО того, как подписка восстановится, — событие о завершении
 * канала теряется навсегда: ariEvents.ts переоткрывает сокет и подписывается
 * заново, но прошлое событие никто не пришлёт повторно. Запись в `calls`
 * остаётся висеть с состоянием `!== "ended"`, и `hasLiveCall(agentId)`
 * блокирует агенту вообще ЛЮБОЙ следующий звонок из CRM («У вас уже идёт
 * звонок») — до перезапуска процесса, единственного, что раньше чистило
 * карту. checkStuckCallStubs (ниже) чинит ЗАПИСЬ В БАЗЕ через 20 минут, но
 * carточку `calls` не трогает вовсе — эти два намеренно разных механизма
 * закрывают разные дыры и ни один не подменяет другой.
 *
 * ЧТО ДЕЛАЕТ. Подписка переоткрылась — `resyncActiveChannels` в ariEvents.ts
 * и так спрашивает станцию о живых каналах ради пропущенных входящих; тот же
 * список сверяется и здесь: канал живого (по нашей памяти) исходящего
 * звонка, которого в свежем ответе станции больше нет, — точно закончился,
 * пока связи не было. Дописываем ему исход, как будто ChannelDestroyed всё
 * же дошёл (finishCall безопасен без реального события — считает то, что
 * успело накопиться в записи: ответил ли клиент, звонил ли ему телефон).
 */
export async function reconcileOrphanedOutgoingCalls(liveStationChannelIds: ReadonlySet<string>): Promise<number> {
  const orphaned = liveOutgoingCalls().filter((call) => !liveStationChannelIds.has(call.channelId) && !call.retiring);
  for (const call of orphaned) {
    console.warn(
      `[звонок] ${new Date().toISOString()} канал ${call.channelId} (агент ${call.agentId}) закончился в разрыв ` +
        `связи с АТС — событие потеряно, исход досчитан по переподписке`
    );
    // Запись забирается и здесь (E1 глубокой проверки 02.10.2026): настоящий
    // ChannelDestroyed после этого выйдет по «уже ended», и без этой строки
    // разговор, кончившийся в разрыв связи, оставался без записи навсегда.
    collectRecordingAfterFinish(call.channelId, await finishCall(call.channelId), Boolean(call.answerConfirmed));
  }
  return orphaned.length;
}

/**
 * Забрать запись завершённого исходящего — ОДИН путь на все способы закрыть
 * звонок (E1 глубокой проверки 02.10.2026).
 *
 * Раньше запись забирал только обработчик ChannelDestroyed (ariEvents.ts), а
 * подметалка и сверка после переподписки звали голый finishCall. Звонок после
 * них уже `ended`, и пришедший следом настоящий ChannelDestroyed выходил сразу:
 * разговор оставался без записи, расшифровки и разбора, а заготовка уже
 * переписана — сторож зависших её тоже не подбирал.
 *
 * Запись ищем только у состоявшихся разговоров: у недозвона файла нет.
 * `clientAnswered` — ответ клиента подтверждён станцией: только тогда пустая
 * запись повод тревожить людей.
 */
export function collectRecordingAfterFinish(
  channelId: string,
  call: ActiveCall | undefined,
  clientAnswered: boolean
): void {
  if (call?.interactionId && call.answeredAt && call.agentExtension && call.clientPhone) {
    void ingestCallRecording({
      channelId,
      interactionId: call.interactionId,
      durationSec: talkSeconds(call),
      clientAnswered,
      search: {
        startedAt: call.startedAt,
        agentExtension: call.agentExtension,
        clientPhone: call.clientPhone,
        direction: "outgoing",
      },
    }).catch((err) => console.error("[звонок] запись после закрытия звонка:", err));
  } else {
    forgetRecordingPath(channelId);
  }
}

export function resetCalls(): void {
  calls.clear();
  unconfirmedAnswerLoggedAt = null;
  // Троттлинг/счётчик AGENT_NO_PICKUP (agentNoPickupGuard.ts) — тоже память
  // процесса, тесты, чистящие `calls` этой функцией, ждут чистого состояния
  // и здесь, иначе один тест видит троттлинг, заведённый другим.
  resetAgentNoPickupGuard();
}

/**
 * Сколько звонок должен висеть, чтобы подметалка вообще спросила о нём станцию.
 * Короче STUCK_CALL_MINUTES ниже: снять блокировку «у вас уже идёт звонок» с
 * МЁРТВОГО канала надо раньше, чем БД-сторож заметит пустую заготовку.
 */
const STALE_LIVE_CALL_MINUTES = 10;

/**
 * Станция не ответила, жив ли канал, — тогда закрываем только то, что висит
 * дольше любого мыслимого разговора (тот же порог, что у входящих,
 * incomingCalls.ts). Живой часовой разговор — самый ценный (callRecordings.ts),
 * и обрывать его учёт из-за недоступной станции нельзя.
 */
const STALE_LIVE_CALL_UNVERIFIED_HOURS = 4;

/** Сколько ждать ответа станции о живых каналах. */
const STATION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Какие каналы живы на станции прямо сейчас. null — спросить не удалось
 * (станция не настроена, не ответила, или список упёрся в предел выдачи и
 * отсутствие канала в нём ничего не доказывает).
 */
export async function stationLiveChannelIds(): Promise<ReadonlySet<string> | null> {
  try {
    const creds = await loadAriCredentials();
    if (!creds) return null;
    const channels = await listActiveChannels(creds, STATION_PROBE_TIMEOUT_MS);
    if (channels.length >= ACTIVE_CHANNELS_LIMIT) return null;
    return new Set(channels.map((c) => c.id));
  } catch {
    return null;
  }
}

/**
 * Подстраховка ВТОРОГО уровня для потерянного ChannelDestroyed (найдено
 * ревью 19.08.2026 в день, когда чинили первый случай этой же беды).
 *
 * reconcileOrphanedOutgoingCalls (выше) закрывает дыру, когда подписка на
 * события АТС ПЕРЕОТКРЫВАЕТСЯ — но если Asterisk уронит канал (краш, OOM)
 * БЕЗ разрыва самого websocket-соединения CRM к станции, переподписки не
 * будет вовсе, и та функция не вызовется никогда. Запись в `calls` тогда
 * висит с состоянием ≠"ended" до перезапуска процесса — тот самый
 * «У вас уже идёт звонок» на пустом месте, просто без обрыва связи как
 * триггера.
 *
 * Здесь — по расписанию, а не по событию (index.ts, live-calls-sweep).
 *
 * ЗАКРЫВАЕТСЯ ТОЛЬКО МЁРТВЫЙ КАНАЛ (E1 глубокой проверки 02.10.2026). Раньше
 * всё, что старше 10 минут, закрывалось без вопросов — и живой 25-минутный
 * разговор о сделке обрывался в учёте на десятой минуте: без записи, без
 * расшифровки, а агенту посреди разговора могли выдать лид. Теперь станцию
 * спрашивают, жив ли канал; закрытый звонок забирает запись тем же путём,
 * что и ChannelDestroyed (collectRecordingAfterFinish).
 */
export async function sweepStaleLiveCalls(
  deps: { liveChannelIds?: () => Promise<ReadonlySet<string> | null> } = {}
): Promise<number> {
  const now = Date.now();
  const candidates = liveOutgoingCalls().filter(
    (call) => !call.retiring && call.startedAt.getTime() < now - STALE_LIVE_CALL_MINUTES * 60_000
  );
  if (candidates.length === 0) return 0;
  const live = await (deps.liveChannelIds ?? stationLiveChannelIds)();
  const unverifiedCutoff = now - STALE_LIVE_CALL_UNVERIFIED_HOURS * 3_600_000;
  const stale = candidates.filter((call) =>
    live ? !live.has(call.channelId) : call.startedAt.getTime() < unverifiedCutoff
  );
  for (const call of stale) {
    console.warn(
      `[звонок] ${new Date().toISOString()} канал ${call.channelId} (агент ${call.agentId}) ` +
        (live
          ? "станция больше не знает, а события «канал закончен» не было — досчитан по сверке"
          : `висит дольше ${STALE_LIVE_CALL_UNVERIFIED_HOURS} ч, станция не отвечает — досчитан по таймауту`)
    );
    // И в журнал ошибок (28.09.2026): всё это время агент видел «Линия занята»
    // и не мог набрать никого, а причина жила только в консоли сервера.
    void logSystemError(
      "telephony",
      `Звонок агента висел дольше ${STALE_LIVE_CALL_MINUTES} минут без события «канал закончен» — кнопка «Позвонить» у него была заблокирована; снят по таймауту`,
      { dedupKey: `stale-live-call:${call.agentId}` }
    );
    collectRecordingAfterFinish(call.channelId, await finishCall(call.channelId), Boolean(call.answerConfirmed));
  }
  return stale.length;
}

/**
 * Тексты заготовки звонка (routes/clients/communications.ts) — ровно то, чем
 * finishCall её заменяет по завершении. Если запись всё ещё содержит один из
 * них спустя STUCK_CALL_MINUTES — событие с АТС о завершении канала не дошло
 * вовсе.
 *
 * НАЙДЕНО 18.09.2026 (П-10 §b.10, docs/audit/recon-17-09/04-timeline-authorship.md):
 * звонок «на дополнительный номер» заводит заготовку с ДИНАМИЧЕСКИМ текстом
 * (`Звонок инициирован из CRM на дополнительный номер (${номер})`) — точное
 * сравнение `notes: { in: STUB_NOTES }` его никогда не находило, такие
 * зависшие звонки молча выпадали из восстановления файла записи. Сравниваем
 * ПРЕФИКСОМ: массив хранит начала строк, а не сами заготовки целиком.
 */
const STUB_NOTE_PREFIXES = ["Звонок инициирован из CRM", "Звонок продолжен через мобильный — плохая связь в браузере"];
const STUCK_CALL_MINUTES = 20;

/**
 * Заготовка автоматического обратного звонка дежурного оператора
 * (callbackConnect.ts). Тот же звонок из CRM, и finishCall так же заменяет её
 * исходом (E3 глубокой проверки 02.10.2026).
 *
 * В обход зависших она входит ТОЛЬКО свежей, за последние CALLBACK_STUB_LOOKBACK:
 * до 02.10.2026 автопрозвон шёл из worker, где событий станции нет, и ВСЕ его
 * старые заготовки остались без итога навсегда. Поднимать сегодня тревогу
 * «звонок потерян» по месячной давности разговору — шум, а не помощь.
 */
export const CALLBACK_CALL_NOTE_PREFIX = "Обратный звонок по просьбе клиента";
const CALLBACK_STUB_LOOKBACK_MS = 48 * 3_600_000;

/**
 * Сколько свежая заготовка без итога считается живым разговором для щита
 * занятости (agentOccupancyShield.ts). Мёртвую заготовку сторож зависших
 * переписывает через STUCK_CALL_MINUTES; предел — чтобы сломанный сторож не
 * держал агента «занятым» вечно.
 */
const OPEN_STUB_BUSY_MINUTES = 120;

/**
 * Кто из агентов прямо сейчас в звонке через CRM — ПО БАЗЕ (E4 глубокой
 * проверки 02.10.2026).
 *
 * hasLiveCall смотрит в карту `calls`, а она есть только в процессе api.
 * Раздача и переназначение лидов идут из worker, где карта пуста, — и агенту
 * посреди 20-минутного разговора доставался новый лид с таймером первого
 * касания. Заготовка звонка лежит в базе с начала звонка до его итога
 * (finishCall заменяет текст), поэтому её и читаем.
 */
export async function agentsWithOpenCallStub(agentIds: string[], now: Date = new Date()): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await prisma.interaction.findMany({
    where: {
      type: "CALL",
      agentId: { in: agentIds },
      createdAt: { gte: new Date(now.getTime() - OPEN_STUB_BUSY_MINUTES * 60_000), lte: now },
      OR: [...STUB_NOTE_PREFIXES, CALLBACK_CALL_NOTE_PREFIX].map((prefix) => ({ notes: { startsWith: prefix } })),
    },
    select: { agentId: true },
    distinct: ["agentId"],
  });
  return new Set(rows.map((r) => r.agentId).filter((id): id is string => Boolean(id)));
}

/**
 * Метка «Звонок потерян» (24.09.2026, найдено ревью — противоречие в ленте).
 *
 * checkStuckCallStubs пишет её, когда за STUCK_CALL_MINUTES событие АТС о
 * завершении канала не пришло и файла записи на станции не нашлось. Если
 * ChannelDestroyed всё же приходит ПОЗЖЕ (станция просто задержалась, а не
 * потеряла канал), finishCall не имеет права молча стереть эту тревогу тем же
 * текстом, что пишет для обычного звонка, — руководитель уже получил пуш
 * «звонок потерян», и запись должна честно сказать, что тревога снята, а не
 * исчезнуть без следа. Общая константа — чтобы finishCall узнавал СВОЮ же
 * заготовку по тому же префиксу, которым она была написана.
 */
const LOST_CALL_NOTE_PREFIX = "⚠️ Звонок начат, но станция не подтвердила его завершение";

/**
 * НАЙДЕНО 24.09.2026 (заготовка #478: заведена 10:45, запись «Звонок потерян»
 * появилась только в 16:10, хотя порог 20 минут и тик крона раз в 5 минут).
 * Станция моргала с 13:50 — на КАЖДУЮ из до 50 заготовок ingestCallRecording
 * ждёт до 23 с поиска + до 120 с скачивания (см. callRecordings.ts), и
 * строго последовательный обход при неудачной станции растягивает один тик
 * на часы. `isStuckCallCheckRunning` в cron.ts тем временем просто пропускает
 * следующие тики — новые заготовки копятся, а не обгоняют старую.
 * Ограниченный параллелизм (тот же приём, что в callRecordings.ts —
 * transcribeAndEnrich) сокращает тик примерно втрое, не превращая пул станции
 * в толпу запросов разом.
 */
const STUCK_CALL_RECOVERY_CONCURRENCY = 3;

/**
 * Сторожевой обход заготовок звонка, которые НЕ дописались исходом (18.08.2026).
 *
 * ПОЧЕМУ НУЖЕН. finishCall дописывает заготовку по событию АТС «канал закончен» —
 * состояние живого звонка живёт только в памяти процесса (см. шапку файла), и если
 * событие потерялось (обрыв канала к станции, гонка при заведении заготовки), запись
 * так и остаётся пустой болванкой навсегда: ни исхода, ни длительности, ни записи —
 * без единого сигнала, что что-то пошло не так. Карточка при этом выглядит так, будто
 * разговора не было вовсе — 17.08.2026 на этом потерялся звонок Баходура.
 *
 * ЧТО ДЕЛАЕТ. Раз в тик крона (см. cron.ts) находит заготовки старше 20 минут (дольше
 * любого настоящего разговора). Само СОБЫТИЕ «канал закончен» не восстановить, но
 * ФАЙЛ записи на станции почти всегда жив — MixMonitor пишет его независимо от того,
 * дошло ли до CRM уведомление об этом. Поэтому прежде чем сдаться, крон пробует ту же
 * логику поиска, что и обычный звонок (ingestCallRecording с search по телефону
 * клиента, добавочному агента и времени начала) — если файл находится, заготовка
 * дописывается настоящей записью и расшифровкой, как будто событие всё же дошло.
 * Только если файла на станции правда нет, крон один раз предупреждает — руководству
 * и в журнал ошибок — и помечает заготовку, чтобы не сигналить о ней повторно.
 */
export async function checkStuckCallStubs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_CALL_MINUTES * 60_000);
  const stuck = await prisma.interaction.findMany({
    where: {
      type: "CALL",
      OR: [
        ...STUB_NOTE_PREFIXES.map((prefix) => ({ notes: { startsWith: prefix } })),
        {
          notes: { startsWith: CALLBACK_CALL_NOTE_PREFIX },
          createdAt: { gte: new Date(Date.now() - CALLBACK_STUB_LOOKBACK_MS) },
        },
      ],
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      clientId: true,
      agentId: true,
      createdAt: true,
      client: { select: { shortId: true, fullName: true, phone: true } },
      agent: { select: { sipExtension: true } },
    },
    // САМАЯ СТАРАЯ ЗАГОТОВКА — ПЕРВОЙ (24.09.2026, заготовка #478 — см.
    // комментарий у STUCK_CALL_RECOVERY_CONCURRENCY выше). Без сортировки
    // `take: 50` берёт первые 50 строк в порядке, который Postgres сочтёт
    // удобным — не обязательно по возрасту, и при более чем 50 висящих
    // заготовках самая старая могла НЕ попадать в выборку тик за тиком,
    // пока не истекут более молодые.
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  if (stuck.length === 0) return 0;

  /**
   * ЖИВОЙ КАНАЛ — НЕ ЗАВИСШИЙ (24.09.2026, найдено ревью: противоречие в
   * ленте между «Звонок потерян» и последующим тихим «Звонок через CRM,
   * разговор X:XX»). Заготовка старше STUCK_CALL_MINUTES обычно значит, что
   * ChannelDestroyed потерялся (см. докстринг выше), — но если канал этого же
   * звонка ещё жив в памяти процесса (`calls` в этом файле, например
   * `retiring`-звонок, который sweepStaleLiveCalls намеренно не трогает, см.
   * его докстринг), разговор просто продолжается дольше обычного, а не
   * потерян станцией. Помечать его «потерянным» и слать пуш руководству —
   * ложная тревога: finishCall рано или поздно допишет настоящий итог сам,
   * когда канал действительно закроется. Такую заготовку в этом тике просто
   * пропускаем — не трогаем вовсе, ни восстановлением, ни меткой.
   */
  const liveInteractionIds = new Set(
    [...calls.values()]
      .filter((call) => call.state !== "ended")
      .map((call) => call.interactionId)
      .filter((id): id is string => Boolean(id))
  );
  const candidates = stuck.filter((call) => !liveInteractionIds.has(call.id));
  if (candidates.length === 0) return 0;

  const config = recordingFetchConfig();

  // ПАРАЛЛЕЛЬНЫЙ ПОИСК НА СТАНЦИИ, ОГРАНИЧЕННЫЙ ПУЛОМ (см. комментарий у
  // STUCK_CALL_RECOVERY_CONCURRENCY). Сам поиск (ingestCallRecording) уже
  // подстрахован `.catch` — падение одного элемента даёт `{ ok: false }`,
  // а не рвёт мапу для остальных.
  const attempts = await mapWithConcurrency(candidates, STUCK_CALL_RECOVERY_CONCURRENCY, async (call) => {
    const found =
      config &&
      (await ingestCallRecording({
        interactionId: call.id,
        search: {
          startedAt: call.createdAt,
          clientPhone: call.client.phone,
          agentExtension: call.agent?.sipExtension ?? undefined,
          // Заготовки этого обхода заводятся ТОЛЬКО текстом из STUB_NOTE_PREFIXES
          // (см. выше) — обе строки описывают звонок, инициированный ИЗ CRM, то
          // есть исходящий; входящая заготовка сюда попасть не может.
          direction: "outgoing",
        },
      }).catch(() => ({ ok: false as const })));
    return { call, recovered: Boolean(found && found.ok) };
  });

  let recovered = 0;
  const unresolved: typeof stuck = [];

  for (const { call, recovered: found } of attempts) {
    if (found) {
      recovered++;
      // ЗАПИСЬ ОДНОЙ ВОССТАНОВЛЕННОЙ ЗАГОТОВКИ — В СВОЁМ try/catch (24.09.2026,
      // найдено вместе с заготовкой #478). Раньше `update` ничем не был
      // прикрыт: отказ базы (пул исчерпан, гонка) на ОДНОЙ заготовке рвал всю
      // функцию исключением ДО того, как цикл ниже успевал записать/запушить
      // остальные unresolved — молчаливая потеря сигнала для всех, кто шёл
      // следом в том же тике. Теперь падение одной заготовки не мешает
      // остальным: предупреждаем и продолжаем.
      try {
        await prisma.interaction.update({
          where: { id: call.id },
          data: { notes: `Звонок через CRM — запись найдена постфактум (событие АТС о завершении не дошло)` },
        });
        void logSystemError(
          "telephony",
          `Звонок восстановлен постфактум по поиску на станции: клиент ${call.client.fullName} (#${call.client.shortId})`, { dedupKey: "Звонок восстановлен постфактум по поиску на станции: клиент … (#…)" }
        );
      } catch (err) {
        console.warn(
          `[звонок] заготовка #${call.client.shortId} (${call.id}) — запись найдена, но обновить карточку не удалось:`,
          err
        );
        void logSystemError(
          "telephony",
          `Запись найдена постфактум, но заготовку не удалось обновить в базе: клиент ${call.client.fullName} (#${call.client.shortId})`,
          { dedupKey: "stuck-call-update-failed" }
        );
      }
      continue;
    }
    unresolved.push(call);
  }

  for (const call of unresolved) {
    /**
     * СВОЙ try/catch, КАК И У ВЕТКИ recovered ВЫШЕ (найдено ревью 24.09.2026,
     * вместе с заготовкой #478 — см. комментарий у STUCK_CALL_RECOVERY_CONCURRENCY).
     * Раньше `update` здесь ничем не был прикрыт: отказ базы на ПЕРВОЙ же
     * заготовке рвал исключением весь цикл, и ни пуш руководству ниже, ни
     * отметка остальных зависших заготовок не происходили вовсе — тот же
     * класс потери сигнала, который уже чинили для recovered.
     */
    try {
      await prisma.interaction.update({
        where: { id: call.id },
        data: {
          notes: `${LOST_CALL_NOTE_PREFIX} — исход и запись не сохранились (заведён ${dushanbeDateTimeString(call.createdAt)})`,
        },
      });
      void logSystemError(
        "telephony",
        `Звонок потерян: канал не закрылся событием АТС, файла на станции тоже нет. Клиент ${call.client.fullName} (#${call.client.shortId}), заготовка от ${dushanbeDateTimeString(call.createdAt)}`, { dedupKey: "Звонок потерян: канал не закрылся событием АТС, файла на станции тоже нет. Клиент … (#…), заготовка от …" }
      );
    } catch (err) {
      console.warn(`[звонок] заготовка #${call.client.shortId} (${call.id}) — не удалось пометить как потерянную:`, err);
      void logSystemError(
        "telephony",
        `Заготовку не удалось пометить «звонок потерян» — сама поломка станции ещё жива: клиент ${call.client.fullName} (#${call.client.shortId})`,
        { dedupKey: "stuck-call-mark-lost-failed" }
      );
    }
  }

  if (unresolved.length > 0) {
    const supervisors = await findAgentsWithPermission("clients.assign");
    await sendPushToAgents(supervisors, {
      title: "⚠️ Звонок потерян станцией",
      body: `${unresolved.length} ${unresolved.length === 1 ? "звонок завис" : "звонка(ов) зависли"} без исхода — запись и итог не сохранились, проверьте телефонию`,
      url: "/settings",
      tag: "stuck-call-stubs",
    }).catch((err) => console.error("[push] зависшие звонки:", err));
  }

  if (recovered > 0) console.log(`[звонок] заготовок восстановлено постфактум: ${recovered}`);
  return unresolved.length;
}
