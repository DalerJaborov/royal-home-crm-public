import { prisma } from "../../db.js";
import { extractIncomingCallLead, type IncomingCallLead } from "../../ai/incomingCallLead.js";
import { callSoundsLikeJobSeeker } from "../../ai/jobSeekerCall.js";
import { captureCandidateFromCall } from "../jobApplications.js";
import { publishCallUpdated } from "../livePublish.js";
import { classifyInbound } from "../../services/leads/intakePolicy.js";
import { DIRECTION_UNCONFIRMED_NOTE, DIRECTION_UNCONFIRMED_REASON } from "../../ai/leadKind.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { inactiveExitData } from "../clientLifecycle.js";
import { describeError } from "../describeError.js";
import { loadMoneyContext } from "../money.js";
import { SERVICE_NUMBER_IRRELEVANT_MARKS } from "./incomingCallConstants.js";
import { loadIncomingSettings } from "./incomingSettings.js";
import { createClientForCall, qualifyIncomingCall } from "./qualifyIncoming.js";

/**
 * КАРТОЧКА ПО ВХОДЯЩЕМУ ЗВОНКУ ЗАВОДИТСЯ САМА (решение владельца 18.08.2026).
 *
 * Новая схема приёма: клиента, закреплённого за агентом, станция уводит прямо ему;
 * все остальные — незнакомый номер и клиент без ответственного — попадают на мобильный
 * оператора. Дословно: «оператор просто должен взять максимум информации и далее ничего
 * уже не делает ни в CRM, ничего, пусть всё автоматизировано будет максимально».
 *
 * ЧТО ЭТО ЗНАЧИТ ДЛЯ КОДА. Раньше входящий превращался в лида ровно одним способом —
 * оператор открывал окно разбора и руками выбирал «Покупатель/Продавец/Другое/Не по
 * делу». Теперь тот же разбор делает CRM по расшифровке разговора, а окно оператора
 * остаётся как запасной путь для того, что автоматика не поняла.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ВЕТКА В `qualifyIncoming.ts`. Здесь живёт РЕШЕНИЕ
 * («стоит ли вообще заводить лида по этому звонку и что мы о нём знаем»), а там —
 * ДЕЙСТВИЕ («завести и раздать»). Действие у человека и у автоматики обязано быть
 * одним и тем же: дедупликация по уникальному телефону, отказ раздавать «Другое»
 * агентам, однократное назначение через `pickAgentForLead`, пуши. Поэтому автоматика
 * зовёт `qualifyIncomingCall` с `operatorId: null`, а своей раздачи не имеет.
 *
 * ОТКУДА БЕРУТСЯ ДАННЫЕ. Из того же конвейера, что и всё остальное про разговор:
 * `ariEvents → ingestCallRecording → transcribeAndEnrich` (запись → расшифровка →
 * перевод → разбор). Второго конвейера нет; этот модуль подключается ПОСЛЕ разбора,
 * потому что расшифровка приходит не мгновенно — от десятков секунд до минут.
 *
 * ТРИ ТОЧКИ ЗАПУСКА, И ВСЕ НУЖНЫ (третья добавлена 18.08.2026 вместе с
 * автоответчиком — см. lib/telephony/voicemailIngest.ts: сообщение, наговоренное
 * в трубку, проходит ровно этот же путь, а не свой собственный):
 *  1. конец `transcribeAndEnrich` — обычный путь, карточка появляется через минуту;
 *  2. крон `sweepIncomingCallsForLeads` — для звонков, до которых конвейер не дошёл
 *     вовсе: записи на станции не оказалось, Gemini отказал на всех кусках, процесс
 *     перезапустился посреди обработки. Без него такие звонки молча пропадали бы;
 *  3. `ingestVoicemails` — сообщение на автоответчике: трубку не взяли, но человек
 *     наговорил, кто он и чего хочет.
 *
 * ИДЕМПОТЕНТНОСТЬ. Обе точки могут прийти к одному звонку (и не по одному разу:
 * догоняющая расшифровка проходит тот же путь). Замок — колонка `autoLeadAt`,
 * занимаемая условным `updateMany` ДО обращения к ИИ: второй проход не заводит вторую
 * карточку и не платит второй раз за разбор. Занимать замок до вызова ИИ, а не после,
 * означает, что оборвавшийся посреди работы процесс оставит звонок неразобранным, —
 * и это правильная сторона: неразобранный звонок видит человек в «Без разбора», а
 * вторая карточка на одного человека не видна никому, пока не станет проблемой.
 */

/**
 * Чем кончилась автоматика. Хранится строкой в `IncomingCall.autoLeadStatus` — по
 * ней «Без разбора» отличает «ИИ не справился, посмотрите глазами» от «звонок ещё
 * в очереди на разбор».
 */
export type AutoLeadStatus =
  /** Карточка заведена (или дополнена) и лид ушёл в обычную раздачу агентам. */
  | "qualified"
  /** Курьер, реклама, ошиблись номером, звонил сотрудник — лид не заводится. */
  | "irrelevant"
  /** Клиента ведёт агент: звонок ушёл прямо ему, разбирать нечего. */
  | "known_client"
  /** Звонил соискатель: анкета в «Вакансиях», карточка не заводится (Dan 02.10.2026). */
  | "candidate"
  /** Разбирать нечего или ИИ не понял — звонок остаётся человеку. */
  | "no_data"
  /** Разговора не было (не дозвонился) либо автоматика к звонку неприменима. */
  | "skipped";

export interface AutoLeadResult {
  status: AutoLeadStatus;
  /** Карточка, к которой всё привело. null — её нет и не должно быть. */
  clientId: string | null;
  /** Для журнала и тестов, наружу человеку не показывается. */
  reason?: string;
}

/**
 * Разговор кончился настолько недавно, что запись ещё может дойти. Крон берёт только
 * то, что старше: иначе он отобрал бы звонок у конвейера и разобрал бы его по пустому
 * месту за секунду до того, как придёт расшифровка.
 */
const RECORDING_GRACE_MS = 12 * 60_000;
/** Сколько звонков крон берёт за проход: каждый — платный вызов ИИ. */
const SWEEP_BATCH = 20;
/** Глубже недельной давности не возвращаемся: это уже не лид, а археология. */
const SWEEP_MAX_AGE_MS = 7 * 86_400_000;

/**
 * ЧЕРЕЗ СКОЛЬКО БРОШЕННЫЙ ЗАМОК СЧИТАЕТСЯ ПРОТУХШИМ (21.09.2026).
 *
 * `autoLeadAt` занимает звонок ДО обращения к ИИ и не снимается НИКОГДА — снятия
 * в коде просто нет. Пока процесс доживал до конца, это было незаметно: следом
 * ложился `autoLeadStatus`, и замок превращался в честную отметку «разобрано».
 * Но автовыкат перезапускает контейнеры по каждому мержу в main, и рестарт между
 * этими двумя записями оставлял звонок занятым навсегда: ночной подбор
 * (sweepIncomingCallsForLeads) ищет строго `autoLeadAt: null` и такой звонок не
 * подберёт уже никогда. Заявки по нему нет, и найти причину нечем — ни ошибки,
 * ни следа.
 *
 * Протухшим считается замок БЕЗ исхода (`autoLeadStatus: null`): исход пишется
 * последним действием разбора, поэтому его наличие означает «дошли до конца» —
 * и такой звонок повторно не трогаем ни при каком возрасте замка.
 *
 * Пятнадцать минут — с большим запасом: сам разбор это секунды (одна расшифровка
 * и один вызов модели). Цена ошибки в эту сторону — один лишний платный разбор
 * у звонка, чей процесс правда умер; цена ошибки в другую — потерянная заявка,
 * то есть живой клиент, который позвонил и до агентства не дошёл.
 */
const AUTO_LEAD_LOCK_STALE_MS = 15 * 60_000;

/** Условие «этот звонок можно занимать»: замка нет вовсе либо он протух без
 *  исхода. Одно на чтение, на захват и на ночной подбор — три копии этого
 *  условия разъехались бы молча, без единой ошибки сборки. */
function autoLeadClaimableWhere(now: number) {
  return {
    OR: [
      { autoLeadAt: null },
      { autoLeadAt: { lt: new Date(now - AUTO_LEAD_LOCK_STALE_MS) }, autoLeadStatus: null },
    ],
  };
}

/**
 * Точка входа конвейера: разговор расшифрован и разобран — можно заводить лида.
 * Принимает запись хронологии, потому что именно ею оперирует `transcribeAndEnrich`
 * и именно она может оказаться звонком агента, а не входящим.
 */
export async function autoLeadFromInteraction(
  interactionId: string,
  /**
   * `lateTranscript` — у разговора до этой расшифровки текста не было вовсе
   * (callRecordings.ts::transcribeAndEnrich знает это точно: читает поле до
   * записи). Аудит Codex 04.10.2026, №10: крон берёт звонок старше RECORDING_GRACE_MS
   * и без текста пишет терминальный `no_data` («нет расшифровки»); расшифровка
   * доезжала позже, но замок «автоматика уже отработала» не пускал разбор — карточка
   * оставалась без направления и без дозаполнения, пока человек не разберёт звонок.
   * Раз текста раньше не было, прежний `no_data` мог быть ТОЛЬКО про «нет расшифровки»
   * (отдельного значения в схеме нет, миграций ради этого не делаем): сбрасываем его и
   * разбираем звонок заново. «Модель не уверена» не сбрасывается — там текст был,
   * и платный повтор того же разбора ничего бы не изменил. Разобранный (`qualifiedAt`)
   * звонок не трогаем: человек главнее ИИ.
   */
  opts: { lateTranscript?: boolean } = {}
): Promise<AutoLeadResult | null> {
  const call = await prisma.incomingCall.findFirst({
    where: { interactionId },
    select: { id: true },
  });
  // Это не входящий, а звонок агента — автоматике здесь делать нечего.
  if (!call) return null;
  if (opts.lateTranscript) {
    await prisma.incomingCall
      .updateMany({
        where: { id: call.id, autoLeadStatus: "no_data", qualifiedAt: null },
        data: { autoLeadAt: null, autoLeadStatus: null },
      })
      .catch((err) => logSystemError("telephony", `Сброс исхода «нет расшифровки» не удался: ${describeError(err)}`));
  }
  return autoLeadFromIncomingCall(call.id);
}

/**
 * Один звонок от расшифровки до лида. Наружу не бросает никогда: это фоновая работа
 * после разговора, и уронить ею конвейер записи или крон нельзя.
 */
export async function autoLeadFromIncomingCall(
  callId: string,
  /** Объект, который уже узнал робозвонок в разговоре (liveVoiceConsultant.ts). */
  opts: {
    propertyId?: string | null;
    /** Звонок записан пропущенным, но с ним говорил консультант (сбой робота, агент
     *  после перевода не взял): разговор есть, «не отвечен» его не отрезает. */
    ignoreAnswered?: boolean;
  } = {}
): Promise<AutoLeadResult> {
  try {
    return await run(callId, opts.propertyId ?? null, opts.ignoreAnswered ?? false);
  } catch (err) {
    void logSystemError("telephony", `Автоматическая карточка по входящему звонку не заведена: ${describeError(err)}`);
    // Звонок остаётся с занятым замком, но без исхода — то есть неразобранным, и
    // человек увидит его в «Без разбора». Молча потерять его нельзя, повторять
    // бесконечно тоже: обе крайности хуже одного разбора руками.
    return { status: "no_data", clientId: null, reason: describeError(err) };
  }
}

async function run(callId: string, knownPropertyId: string | null, ignoreAnswered = false): Promise<AutoLeadResult> {
  const call = await prisma.incomingCall.findUnique({
    where: { id: callId },
    select: {
      id: true,
      phone: true,
      answered: true,
      // Сообщение на автоответчике: непринятый звонок, у которого всё-таки есть
      // что разбирать (см. lib/telephony/voicemailIngest.ts).
      voicemailFile: true,
      irrelevant: true,
      qualifiedAt: true,
      autoLeadAt: true,
      autoLeadStatus: true,
      clientId: true,
      interactionId: true,
      // Внутренний номер того, кто снял трубку: по нему ниже находится агент,
      // ответивший сам, — такому лид отдаётся без очереди и сразу принятым.
      answeredBy: true,
      // Перевод с офисного телефона агенту объекта (deskTransfer.ts): кому и взял ли.
      routeDecision: true,
      routedToId: true,
      autoCreatedClient: true,
    },
  });
  if (!call) return { status: "skipped", clientId: null, reason: "звонка нет" };

  /**
   * Разговора не было — разбирать нечего. Пропущенным занимается notifyMissed:
   * там задача перезвонить и пуш, а не лид.
   *
   * КРОМЕ ЗВОНКА С СООБЩЕНИЕМ НА АВТООТВЕТЧИКЕ (18.08.2026). Человек не дождался
   * ответа, но наговорил, кто он и чего хочет, — материала для разбора у такого
   * звонка ровно столько же, сколько у состоявшегося разговора, и терять его
   * из-за формального признака «не отвечен» значит терять лида, который сам
   * рассказал о себе всё.
   */
  if (!call.answered && !call.voicemailFile && !ignoreAnswered) return { status: "skipped", clientId: null, reason: "не отвечен" };
  // Уже разобрано — человеком ли, автоматикой ли. Оператор, успевший нажать
  // «Покупатель» во время разговора, главнее любого ИИ.
  if (call.qualifiedAt) return { status: "skipped", clientId: null, reason: "уже разобран" };
  // Замок держит только разбор, который либо идёт прямо сейчас, либо дошёл до
  // конца (исход записан). Брошенный рестартом — не держит (см. AUTO_LEAD_LOCK_STALE_MS).
  if (call.autoLeadAt && (call.autoLeadStatus || call.autoLeadAt.getTime() > Date.now() - AUTO_LEAD_LOCK_STALE_MS)) {
    return { status: "skipped", clientId: null, reason: "автоматика уже отработала" };
  }
  if (call.irrelevant) return { status: "irrelevant", clientId: null, reason: "помечен не по делу" };

  /**
   * ЗАМОК — ДО ОБРАЩЕНИЯ К ИИ.
   *
   * Проверка `autoLeadAt` выше читает состояние, а не занимает его: конвейер и крон
   * могут дойти до одного звонка в одну секунду, оба увидят пусто, оба заплатят за
   * разбор и оба попробуют завести карточку. Условие прямо в `updateMany` делает
   * проход однократным — тот же приём, что у назначения агента в qualifyIncoming.ts.
   *
   * ЗАНИМАЕМ И ПРОТУХШИЙ ЗАМОК (21.09.2026) — тем же приёмом, что уже стоит у
   * улучшения фото (routes/properties/photos.ts, ENHANCE_LOCK_WINDOW_MS): звонок,
   * чей разбор оборвало рестартом, отпускает себя сам, без починки руками.
   */
  const claimed = await prisma.incomingCall.updateMany({
    where: { id: call.id, ...autoLeadClaimableWhere(Date.now()) },
    data: { autoLeadAt: new Date() },
  });
  if (claimed.count === 0) return { status: "skipped", clientId: null, reason: "автоматика уже отработала" };

  const result = await decide(call, knownPropertyId);
  await prisma.incomingCall
    .update({ where: { id: call.id }, data: { autoLeadStatus: result.status } })
    .catch((err) => logSystemError("telephony", `Исход автоматики по звонку не записан: ${describeError(err)}`));
  return result;
}

async function decide(call: {
  id: string;
  phone: string;
  clientId: string | null;
  interactionId: string | null;
  /** Внутренний номер снявшего трубку — по нему ниже ищется ответивший агент. */
  answeredBy: string | null;
  /** Сообщение автоответчика: без расшифровки такой звонок карточку не заводит. */
  voicemailFile: string | null;
  routeDecision?: string | null;
  routedToId?: string | null;
  autoCreatedClient?: boolean;
}, knownPropertyId: string | null): Promise<AutoLeadResult> {
  /**
   * ЗВОНОК СОТРУДНИКА — НЕ ЛИД. Агент звонит в офис по своим делам, и карточка
   * «Входящий +992…» на собственного сотрудника — это не только мусор: она заняла
   * бы его номер уникальностью `Client.phone`, и настоящий клиент с этого номера уже
   * никогда бы не завёлся.
   */
  const employee = await prisma.agent.findFirst({ where: { phone: call.phone }, select: { id: true } });
  if (employee) return { status: "irrelevant", clientId: null, reason: "звонил сотрудник" };

  /**
   * НОМЕР, ДВАЖДЫ ПОМЕЧЕННЫЙ «НЕ ПО ДЕЛУ», — служебный (курьер, автообзвон). То же
   * правило и тот же порог, что у создания карточки в момент разговора
   * (createCardForUnknownCaller): второго источника правды про один и тот же факт не
   * заводим.
   */
  const marks = await prisma.incomingCall.count({ where: { phone: call.phone, irrelevant: true } });
  if (marks >= SERVICE_NUMBER_IRRELEVANT_MARKS) {
    return { status: "irrelevant", clientId: null, reason: "служебный номер" };
  }

  /**
   * У КЛИЕНТА УЖЕ ЕСТЬ АГЕНТ — ЗВОНОК УШЁЛ ПРЯМО ЕМУ, а не оператору (см.
   * inboundRouting.ts). Трогать такую карточку автоматикой нельзя: перезаписать
   * запрос давнего клиента одной фразой из разговора — значит стереть работу агента.
   * Что клиент звонил, в хронологии уже записано, и агенту об этом ушёл пуш.
   */
  /**
   * ПЕРЕВЕДЁН С ОФИСНОГО ТЕЛЕФОНА АГЕНТУ ОБЪЕКТА (24.09.2026, deskTransfer.ts). Агент
   * взял трубку, и клиент уже закреплён за ним принятым — но карточку завёл этот же
   * звонок, и в ней пока один номер. Её дозаполняет разбор разговора (имя, запрос,
   * бюджет), как у агента, снявшего трубку сам: переписывать тут нечего, кроме
   * заглушки. Карточка давнего клиента — по-прежнему не трогается.
   */
  const deskTransferred =
    call.routeDecision === "desk_transfer_answered" && !!call.routedToId && !!call.autoCreatedClient;

  if (call.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: call.clientId },
      select: { id: true, assignedAgentId: true, workStatus: true },
    });
    const enrichTransferred = deskTransferred && client?.assignedAgentId === call.routedToId;
    if (client?.assignedAgentId && !enrichTransferred) {
      /**
       * ДАВНИЙ КЛИЕНТ ЗВОНИТ НАСЧЁТ РАБОТЫ (Dan 02.10.2026) — единственное, ради чего
       * звонок клиента с агентом всё-таки разбирается. Сначала бесплатная проверка
       * слов расшифровки; платный разбор — только если она сработала, и снимаем с
       * агента, только если и модель не услышала покупки/продажи. Карточку со
       * сделкой или объектами в работе не трогает captureCandidateFromCall.
       */
      const candidate = await candidateFromAssignedClientCall(call);
      if (candidate) return candidate;
      /**
       * ПОЗВОНИЛ САМ — ВОЗВРАЩАЕМ В РАБОТУ (владелец 20.08.2026, тот же принцип,
       * что у возврата по сообщению в leads.ts). «Неактивный» — это слот,
       * освобождённый в лимите агента (отложил сам агент, либо лид, который никто
       * не подхватил до первого разговора, см. leads.ts), а не отказ от клиента:
       * живой звонок — то самое обращение, после которого клиента ждали.
       * Без этого шага звонок и так уже пришёл (или придёт следующий) мимо
       * агента в очередь — inboundRouting.ts не переводит INACTIVE напрямую,
       * пока карточка не выйдет из этого статуса.
       */
      if (client.workStatus === "INACTIVE") {
        // Поля светофора гасятся вместе с workStatus (23.09.2026) — тем же
        // набором, что у обычного возврата (clientLifecycle.ts::inactiveExitData):
        // иначе прошлый уровень, счётчик и inactiveSince оставались на живой
        // карточке. status не трогаем: судьбу LOST решает inboundRouting.ts.
        await prisma.client.update({ where: { id: client.id }, data: { ...inactiveExitData(), returnedAt: new Date() } });
        // Актор — сам клиент (его звонок вернул карточку в работу), не агент
        // (П-10, 17.09.2026): агент к этому решению не притрагивался.
        await logTimeline({
          clientId: client.id,
          actor: { kind: "client", source: "auto-lead-from-call", subjectAgentId: client.assignedAgentId },
          type: "SYSTEM",
          notes: "Клиент позвонил сам — возвращён в работу из Неактивных",
        });
      }
      return { status: "known_client", clientId: client.id, reason: "клиент ведётся агентом" };
    }
  }

  const transcript = call.interactionId ? await loadTranscript(call.interactionId) : null;
  const extract = transcript ? await extractIncomingCallLead(transcript) : null;

  /**
   * ЗВОНИЛ СОИСКАТЕЛЬ (Dan 02.10.2026) — анкета в «Вакансии», лида нет. Признак
   * разбора (модель + слова, ai/jobSeekerCall.ts); модель не ответила — одни слова
   * расшифровки. Раньше «Другого»: даже неуверенный разбор с фразой соискателя
   * честнее отдать HR, чем оставить в очереди оператора как безымянного лида.
   */
  const jobSeeker = extract ? extract.jobSeeker === true : callSoundsLikeJobSeeker(transcript);
  if (jobSeeker) return takeCandidate(call, extract, transcript);

  /**
   * РАЗОБРАТЬ НЕ ВЫШЛО: записи не оказалось, поставщик отказал, разговор пустой либо
   * модель сама сказала, что не поняла.
   *
   * Карточка по номеру всё равно нужна — человек звонил, это лид, пусть и без
   * подробностей. Но РАЗОБРАННЫМ звонок не помечаем: он остаётся в «Без разбора»,
   * где его увидит и дозаполнит человек. Придумать за клиента, покупатель он или
   * продавец, хуже, чем честно признаться, что мы не знаем: агент получил бы
   * уверенно заполненную карточку, в которой всё враньё.
   */
  if (!extract || !extract.confident) {
    /**
     * СООБЩЕНИЕ АВТООТВЕТЧИКА БЕЗ РАСШИФРОВКИ — КАРТОЧКУ НЕ ЗАВОДИМ (30.08.2026).
     *
     * Для ОТВЕЧЕННОГО разговора карточка по номеру всё равно нужна: человек дозвонился
     * и говорил с оператором, это лид, пусть и без подробностей. Но у автоответчика
     * без расшифровки не разобрано ни слова, и заводить по нему карточку — значит
     * плодить пустышки «Входящий +992…» на сообщениях в 13-26 секунд: их не разберёт
     * ни автоматика (нечего читать), ни человек (он видит один номер).
     *
     * Решение владельца принято в voicemailIngest.ts, и до этой правки два пути
     * расходились: там карточку не заводили, а здесь — сразу заводили обратно тем же
     * прогоном (autoLeadFromIncomingCall вызывается в конце ingestVoicemail).
     * Поймано тестом voicemail-ingest «расшифровать не удалось — карточки НЕТ».
     *
     * Сам звонок не теряется: он остаётся в «Только без разбора» с записью, которую
     * можно послушать, и с пушем руководству.
     */
    const voicemailWithoutTranscript = !!call.voicemailFile && !transcript;
    const clientId =
      call.clientId ?? (voicemailWithoutTranscript ? null : await ensureCardByPhone(call.phone));
    return { status: "no_data", clientId, reason: extract ? "модель не уверена" : "нет расшифровки" };
  }

  /**
   * Дальше — та же дверь, что и у оператора. `IRRELEVANT` там снимет карточку,
   * заведённую этим же звонком, и запомнит номер; всё остальное заведёт лида и
   * отдаст его в обычную раздачу по KPI.
   */
  /**
   * КТО СНЯЛ ТРУБКУ. В новой схеме (18.08.2026) звонок незнакомого человека
   * звонит сразу всем агентам, и ответивший забирает клиента себе — без очереди
   * по KPI и без окна «Принять/Отклонить»: он уже поговорил.
   *
   * Ищем по внутреннему номеру, который сообщила станция. Не нашли (ответили на
   * мобильном через переадресацию, номера в канале нет) — не беда: тогда лид
   * уходит в обычную раздачу, как и раньше.
   *
   * ОПЕРАТОР ПЕРВОЙ ЛИНИИ КЛИЕНТА СЕБЕ НЕ ЗАБИРАЕТ (владелец 23.09.2026).
   * С 20.09 незнакомые номера звонят только оператору (`takesUnknownCalls`,
   * очередь станции), и «кто снял — тот и ведёт» превращало КАЖДЫЙ такой
   * звонок в лида самого оператора, уже принятого: агенты не получали ничего.
   * Правило владельца: оператор слушает человека, ИИ разбирает разговор и
   * отдаёт лида агентам обычной раздачей. Поэтому ответивший с этим признаком
   * ответившим «с правом забрать» не считается.
   */
  /**
   * РОБОТ ПЕРЕВЁЛ ЗВОНОК АГЕНТУ, И ТОТ ОТВЕТИЛ (02.10.2026, liveVoiceTransfer.ts +
   * incomingCalls.ts, «consultant_transfer_answered»). Станция не всегда называет
   * внутренний номер ответившего (мобильный через транк) — без этой записи лид
   * уходил в общую раздачу, хотя клиента уже выслушал агент. Агент, который сейчас
   * не принимает лиды (уволен, заморожен, дежурный оператор первой линии), лида себе
   * не забирает — тем же правилом, что ответивший по добавочному ниже.
   */
  const consultantTransferAgent =
    call.routeDecision === "consultant_transfer_answered" && call.routedToId
      ? await prisma.agent.findFirst({
          where: { id: call.routedToId, isActive: true, frozenAt: null, takesUnknownCalls: false },
          select: { id: true },
        })
      : null;
  const answerer = deskTransferred
    ? { id: call.routedToId! }
    : consultantTransferAgent
      ? consultantTransferAgent
    : call.answeredBy && call.answeredBy.trim()
      ? await prisma.agent.findFirst({
          where: { sipExtension: call.answeredBy, isActive: true, takesUnknownCalls: false },
          select: { id: true },
        })
      : null;

  /**
   * П-13 (18.09.2026, item 4, `docs/audit/recon-17-09/07-routing-code.md` §E
   * находка #3): разбор звонка целиком на модели, без кодовых отсечек уровня
   * `ai/leadKind.ts` (город/услуги/не наш профиль/аренда по бюджету) — звонок
   * «сдаётся» аренда/чужой город/услуги мог распознаться моделью как BUYER,
   * если она не пометила `confident:false`. Прогоняем те же отсечки, что и у
   * переписки, через `classifyInbound(channel:"call")` — тот же код, не второй
   * вызов ИИ. Модель уже сказала BUYER/SELLER уверенно; отсечка ниже её только
   * ПОНИЖАЕТ до OTHER, никогда не повышает.
   */
  let kind = extract.kind;
  let requirementsNotes = extract.requirementsNotes;
  if (kind === "BUYER" || kind === "SELLER") {
    const guarded = classifyInbound({
      intent: kind === "BUYER" ? "buy" : "sell",
      confident: true,
      // Только слова из расшифровки, не пересказ модели (22.09.2026): проверять
      // направление по тексту, который написала сама модель, — это проверять
      // модель ею же. Нет расшифровки — нет и текстовых отсечек.
      clientText: transcript ?? "",
      budgetMin: extract.budgetMin ?? undefined,
      budgetMax: extract.budgetMax ?? undefined,
      channel: "call",
    });
    if (guarded.kind === "OTHER") {
      void logSystemError(
        "telephony",
        `Звонок распознан моделью как ${kind}, но код-отсечка нашла: ${guarded.reason ?? "причина не определена"}`
      );
      kind = "OTHER";
    } else if (guarded.reason === DIRECTION_UNCONFIRMED_REASON) {
      // Не отсекаем, а предупреждаем агента в требованиях карточки.
      requirementsNotes = [DIRECTION_UNCONFIRMED_NOTE, requirementsNotes].filter(Boolean).join("\n");
    }
  }

  /**
   * ЦЕНА ОБЪЯВЛЕНИЯ — В СОМОНИ КОДОМ (24.09.2026): модель пишет сумму как
   * прозвучала, курс берём из справочника, как подбор и робозвонок. Курс не
   * загрузился — цену объявления не передаём вовсе: доллары под видом сомони
   * вычеркнули бы нужный объект по цене. Бюджет в карточку идёт как раньше;
   * если бюджета не прозвучало, цена объявления и есть ориентир для агента.
   */
  const listingPriceTjs = await listingPriceInTjs(extract.propertyPrice ?? null, extract.propertyPriceCurrency ?? null);
  const budgetMax = extract.budgetMax ?? listingPriceTjs;

  const qualified = await qualifyIncomingCall({
    callId: call.id,
    operatorId: null,
    answeredByAgentId: answerer?.id ?? null,
    // Кого человек назвал в разговоре. Строку даёт та же модель разбора (лишнего
    // вызова нет), а решение — код по списку сотрудников (lib/requestedAgent.ts).
    requestedAgentText: extract.namedAgent,
    knownPropertyId,
    listingClues: {
      place: extract.propertyLandmark,
      floor: extract.propertyFloor,
      totalFloors: extract.propertyTotalFloors,
      areaSqm: extract.propertyAreaSqm,
      rooms: extract.propertyRooms ?? null,
      priceTjs: listingPriceTjs,
      landSotka: extract.propertyLandSotka ?? null,
    },
    data: {
      kind,
      ...(extract.fullName ? { fullName: extract.fullName } : {}),
      ...(requirementsNotes ? { requirementsNotes } : {}),
      ...(extract.budgetMin !== null ? { budgetMin: extract.budgetMin } : {}),
      ...(budgetMax !== null ? { budgetMax } : {}),
      ...(extract.desiredDistrictId ? { desiredDistrictId: extract.desiredDistrictId } : {}),
      ...(extract.desiredRooms !== null ? { desiredRooms: extract.desiredRooms } : {}),
      ...(extract.desiredType ? { desiredType: extract.desiredType } : {}),
      ...(extract.propertyHint ? { propertyHint: extract.propertyHint } : {}),
    },
  });

  if ("error" in qualified) {
    // Карточку завести не удалось (номер лежит в Корзине — её удалил человек, и
    // оживлять её разбором звонка не наше решение). Звонок уходит человеку.
    return { status: "no_data", clientId: null, reason: qualified.error };
  }
  if (extract.kind === "IRRELEVANT") return { status: "irrelevant", clientId: null, reason: "разговор не по делу" };
  return { status: "qualified", clientId: qualified.clientId };
}

/**
 * Звонок клиента, которого ведёт агент: соискатель ли это. null — нет (или не
 * уверены), и звонок идёт прежним путём `known_client`.
 */
async function candidateFromAssignedClientCall(call: {
  id: string;
  phone: string;
  clientId: string | null;
  interactionId: string | null;
}): Promise<AutoLeadResult | null> {
  const transcript = call.interactionId ? await loadTranscript(call.interactionId) : null;
  if (!callSoundsLikeJobSeeker(transcript)) return null;
  // Здесь одних слов мало: снимать с агента живого клиента без подтверждения
  // модели нельзя. Модель не ответила — оставляем как было.
  const extract = await extractIncomingCallLead(transcript!);
  if (!extract?.jobSeeker) return null;
  return takeCandidate(call, extract, transcript);
}

/** Анкета кандидата по звонку и отметка «разобран» на самом звонке. */
async function takeCandidate(
  call: { id: string; phone: string; clientId: string | null },
  extract: IncomingCallLead | null,
  transcript: string | null
): Promise<AutoLeadResult> {
  const captured = await captureCandidateFromCall({
    phone: call.phone,
    knownClientId: call.clientId,
    name: extract?.fullName ?? null,
    summary: extract?.requirementsNotes ?? transcript?.slice(0, 1000) ?? null,
  });
  if (!captured.applicationId) {
    // Анкета не записалась (ошибка уже в журнале) — звонок остаётся человеку.
    return { status: "no_data", clientId: call.clientId, reason: "кандидат не принят" };
  }
  // Разобран без человека: в «Без разбора» звонку больше делать нечего.
  await prisma.incomingCall.update({ where: { id: call.id }, data: { qualifiedAt: new Date(), qualifiedById: null } });
  publishCallUpdated({ callId: call.id, clientId: call.clientId });
  return {
    status: "candidate",
    clientId: captured.clientId,
    reason: captured.detached ? "соискатель, карточка снята с агента" : "соискатель",
  };
}

/**
 * Русский перевод предпочитается оригиналу: разговоры идут по-таджикски, а модель
 * разбирает русский точнее. Оригинал остаётся запасным — перевода может не быть.
 */
async function loadTranscript(interactionId: string): Promise<string | null> {
  const interaction = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { transcript: true, transcriptRu: true },
  });
  const text = (interaction?.transcriptRu || interaction?.transcript || "").trim();
  return text ? text : null;
}

/**
 * Карточка хотя бы по номеру — на случай, когда её не завёл момент разговора
 * (`createCardForUnknownCaller`): база моргнула, звонок пришёл до включения
 * автосоздания, запись начала звонка не успела появиться.
 *
 * Уважает ту же настройку, что и основной путь: выключенное автосоздание означает
 * «незнакомые номера в базу не кладём», и обходить это решение владельца через
 * чёрный ход нельзя.
 */
async function ensureCardByPhone(phone: string): Promise<string | null> {
  const settings = await loadIncomingSettings();
  if (!settings.autoCreateClient) return null;
  return createClientForCall(phone);
}

/**
 * Подбор кроном: отвеченные звонки, до которых конвейер расшифровки не дошёл.
 *
 * Отбор ограничен и по количеству, и по глубине — иначе первый же запуск после
 * простоя выгреб бы всю историю входящих и оплатил бы разбор каждого.
 */
export async function sweepIncomingCallsForLeads(): Promise<number> {
  const now = Date.now();
  const calls = await prisma.incomingCall.findMany({
    where: {
      // Сообщения автоответчика подбираются наравне с разговорами: у них тот же
      // конвейер и та же цена пропуска.
      OR: [{ answered: true }, { voicemailFile: { not: null } }],
      // Не «замка нет», а «можно занимать»: иначе звонок с брошенным замком
      // ночной подбор не увидит НИКОГДА (та самая потеря заявки, 21.09.2026).
      // Через AND, а не россыпью: у отбора выше уже есть свой OR, и два ключа
      // `OR` в одном объекте молча затирают друг друга.
      AND: [autoLeadClaimableWhere(now)],
      qualifiedAt: null,
      irrelevant: false,
      startedAt: { gte: new Date(now - SWEEP_MAX_AGE_MS), lte: new Date(now - RECORDING_GRACE_MS) },
    },
    orderBy: { startedAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true },
  });

  let handled = 0;
  // Последовательно, а не Promise.all: каждый проход — платный вызов ИИ и запись в
  // базу, а очередь расшифровок рядом и так занимает поставщика.
  for (const call of calls) {
    const result = await autoLeadFromIncomingCall(call.id);
    if (result.status !== "skipped") handled += 1;
  }
  return handled;
}

async function listingPriceInTjs(price: number | null, currency: "TJS" | "USD" | null): Promise<number | null> {
  if (!price || price <= 0) return null;
  if (currency !== "USD") return Math.round(price);
  try {
    const { usdToTjs } = await loadMoneyContext();
    return Math.round(price * usdToTjs);
  } catch (err) {
    void logSystemError("telephony", `Курс доллара не загрузился, цена объявления из звонка не сверяется: ${describeError(err)}`);
    return null;
  }
}
