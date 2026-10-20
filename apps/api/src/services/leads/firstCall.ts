import { prisma } from "../../db.js";
import { inactiveLevelFields } from "../../lib/inactiveTrafficLight.js";
import { TERMINAL_CLIENT_STATUSES } from "../../lib/clientContact.js";
import { changeClientAgent } from "../../lib/changeClientAgent.js";
import { logTimeline } from "../../lib/timeline.js";
import { sendPushToAgents } from "../../push.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { notifyFeedOnly } from "../../lib/notifications.js";
import { sendLeadPush } from "../../lib/pushLeadActions.js";
import { loadMaxTransfers, transfersExhausted } from "../../lib/leadTransfers.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "../../lib/scoreJournal.js";
import { incomingInteractionIds } from "../../lib/telephony/incomingInteractions.js";
import { isStationDownLongerThan } from "../../lib/telephony/ariEvents.js";
import { outageOverlapMs, outagesBetween } from "../../lib/stationOutage.js";
import { pickAgentForLead } from "./selection.js";
import { candidateWindow, closedMsBeforeDue, leadHoursOf, widenAfterNight } from "./shared.js";
import { isDayOff, startOfWorkingDayAtOrAfter } from "@royal-home/shared";
import { calendarFor, loadCompanyDaysOff } from "../../lib/daysOffCalendar.js";
import type { Prisma, Settings } from "../../generated/prisma/client.js";
import { HANDOVER_ASSIGN_REASON } from "../../lib/leadReason.js";
import { holdsOwnPropertyLead } from "../../lib/propertyOwner.js";

/**
 * «Не позвонил за 15 минут» (спецификация 01.08.2026, часть 3) — снятие лида, а
 * при полном бездействии ещё и штраф, если агент принял клиента, но так с ним и
 * не поговорил.
 *
 * ЧТО СЧИТАЕТСЯ ПЕРВЫМ ЗВОНКОМ (решение владельца 09.08.2026: «по длительности
 * считай»). Состоявшийся разговор — не нажатая кнопка и не записанный итог, а
 * РАЗГОВОР ДЛИННЕЕ ПОРОГА (Settings.leadCallMinSeconds, по умолчанию 30 секунд).
 * Длительность приходит с самой АТС и лежит в записи хронологии
 * (Interaction.recordingDurationSec, пишет lib/telephony/callTracker.ts). Гудки,
 * сорвавшийся вызов и «алло, я перезвоню» обязанность не закрывают: до этого дня
 * её закрывал сохранённый «Итог разговора», то есть текст, набранный агентом, —
 * а клиент при этом мог не услышать никого.
 *
 * ВХОДЯЩИЙ ЗВОНОК КЛИЕНТА ОБЯЗАННОСТЬ НЕ ЗАКРЫВАЕТ. Он тоже попадает в хронологию
 * с длительностью (lib/telephony/incomingCalls.ts), но говорил с клиентом ОПЕРАТОР,
 * а не агент, — засчитать это агенту значило бы платить ему за чужую работу.
 * Такие записи отсеиваются по журналу входящих.
 *
 * ШТРАФ ТОЛЬКО ЗА БЕЗДЕЙСТВИЕ. Если разговора нет, но агент честно звонил и клиент
 * не взял трубку, лид всё равно уходит дальше — клиент не должен ждать, пока до
 * него дозвонятся, — но баллы не снимаются: не ответил клиент, а отвечает агент
 * (Fair Play). Штраф остаётся там, где его и задумывали: агент принял лид и не
 * сделал ни одной попытки.
 *
 * БЕЗ ТЕЛЕФОНИИ остаётся прежний критерий — сохранённый «Итог разговора»
 * (PendingSummary kind="call"). Иначе выключенная АТС штрафовала бы всех подряд за
 * то, чего CRM физически не может увидеть.
 *
 * Лид возвращается в состояние «ждёт принятия» у следующего агента — та же логика,
 * что у отказа (declineLead) и непринятого лида (reassignStaleLeads): не позвонил
 * вовремя — это то же самое нарушение обязанности, что и не принял вовремя.
 *
 * ПРАВИЛО ПРО СВЕЖИЙ ПРИЁМ, НЕ ПРО ЛЮБОЙ (найдено на проде 17.09.2026). Ручные
 * скрипты владельца вечером 16.09 (`revert-orphan-sellers`, `revert-carousel`,
 * `release-for-morning-wave`) вернули агентам 60+ старых карточек, переставив им
 * `acceptedAt`/`assignedAt` на «сейчас» — и первый же тик прочитал это как «только
 * что принял, а звонка нет», хотя карточки были отработаны или разговор с клиентом
 * уже состоялся месяц назад. Правку acceptedAt/assignedAt на старой карточке ПРАВКОЙ
 * РУКАМИ признавать безопасной можно по двум независимым причинам: (1) нижняя
 * граница окна кандидатов (`firstCallCandidateWindow`) не даёт карточке старше
 * нескольких циклов правила снова попасть в выборку вовсе, и (2) карточка, у
 * которой уже был реальный разговор с любым агентом до текущего приёма
 * (`collectPriorConversationClientIds`), пропускается независимо от возраста —
 * «первый звонок» этому клиенту уже состоялся, второй раз это не проверяется.
 */
// Пул «ничьих» и POST /clients/:id/claim-pool УДАЛЕНЫ ЦЕЛИКОМ (17.09.2026, П-4:
// «до контакта — не принял/не позвонил → следующему; пула «ничьих» и кнопки
// «Забрать из пула» нет»; Р-3 владельца: механизм добавлен 01.09.2026 по
// спецификации «гонка в пуле», владелец этого не заказывал). `leadPoolCutoff`
// сюда больше не экспортируется — единственный вызывающий (claim-pool) удалён
// вместе с ней.

/**
 * Окно кандидатов для правила первого звонка (17.09.2026, см. разбор в шапке файла).
 * `to` — прежняя верхняя граница («звонок должен был случиться минуты назад»),
 * `from` — новая нижняя: карточка, принятая раньше, чем несколько полных циклов
 * правила назад, уже решена прошлыми тиками или тронута рукой администратора,
 * а не находится в настоящем срыве. Один цикл здесь — окно звонка ПЛЮС окно пула
 * «ничьих» (`leadPoolAfterMinutes`): именно столько карточка может честно провисеть
 * в работе одного правила от приёма до настоящей передачи следующему.
 */
/**
 * Client.assignReason клиента, которого агент завёл САМ (мастер объекта, «Новый
 * клиент» на себя). Это не лид из очереди: агент уже говорил с человеком, и окно
 * «первый звонок за 15 минут» к нему не применяется. 22.09.2026 это окно отдало
 * другому агенту продавца, которого Ноза сама завела вместе с объектом.
 */
export const SELF_CREATED_ASSIGN_REASON = "self_created";

/**
 * Причины, при которых окна «первый звонок за N минут» нет: агент завёл клиента
 * сам или получил его «Передачей дел» от руководителя (B7, решение владельца
 * 02.10.2026 — переданный портфель принят сразу, штраф его не трогает).
 */
const NO_FIRST_CALL_WINDOW_REASONS = [SELF_CREATED_ASSIGN_REASON, HANDOVER_ASSIGN_REASON];

/** `notIn` в Prisma не пропускает строки с пустым полем — отсюда OR с null. */
const NOT_SELF_CREATED = {
  OR: [{ assignReason: null }, { assignReason: { notIn: NO_FIRST_CALL_WINDOW_REASONS } }],
} satisfies Prisma.ClientWhereInput;

/** Поля карточки для holdsOwnPropertyLead (lib/propertyOwner.ts). */
const OWN_PROPERTY_SELECT = {
  ownPropertyLead: true,
  assignReason: true,
  matchedProperty: {
    select: { shortId: true, deletedAt: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  },
} satisfies Prisma.ClientSelect;

export function firstCallCandidateWindow(
  settings:
    | (Pick<Settings, "leadCallMinutes" | "leadPoolAfterMinutes"> &
        Partial<Pick<Settings, "workHoursStart" | "workHoursEnd">>)
    | null
    | undefined,
  now: Date
): { from: Date; to: Date } {
  const leadCallMinutes = settings?.leadCallMinutes ?? 15;
  const leadPoolAfterMinutes = settings?.leadPoolAfterMinutes ?? 25;
  const { from, to } = candidateWindow(leadCallMinutes + leadPoolAfterMinutes, leadCallMinutes, now);
  // Срок стоит ночью (closedMsBeforeDue): лид, принятый вечером, истекает утром
  // и к тому моменту старше обычного окна. Та же поправка, что у круга «не принял».
  return { from: widenAfterNight(from, leadHoursOf(settings ?? null), now), to };
}

export async function penalizeMissedFirstCalls(now: Date = new Date()): Promise<{ penalized: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const minutes = settings?.leadCallMinutes ?? 15;
  const { from: candidateFrom, to: cutoff } = firstCallCandidateWindow(settings, now);
  const telephonyOn = !!(settings?.asteriskAriUrl && settings.asteriskAriUsername && settings.asteriskAriPassword);
  /**
   * ТЕЛЕФОНИЯ ВКЛЮЧЕНА, НО СТАНЦИЯ НЕ НА СВЯЗИ ДОЛЬШЕ ОКНА ПЕРВОГО ЗВОНКА
   * (найдено на проде 15.09.2026) — до этой правки решало только `telephonyOn`,
   * то есть «настроена ли АТС», а не «видит ли CRM её события прямо сейчас».
   * Обрыв подписки (ariEvents.ts → isStationConnected/код 1006) означает, что
   * ChannelDestroyed от станции не долетает — Interaction(type=CALL) не
   * появляется в базе, даже если агент реально позвонил. Крон читал это как
   * «не позвонил» и штрафовал, отбирал лид и передавал дальше по кругу вплоть
   * до эскалации — по вине связи, а не агента.
   *
   * Порог намеренно тот же `minutes` (leadCallMinutes), что и у самого окна
   * первого звонка: если станция не на связи не дольше него, факт звонка мог
   * ещё не долететь по обычной причине (событие в пути), и это не повод менять
   * поведение. Если дольше — окно первого звонка целиком прошло вслепую, и
   * CRM физически не могла увидеть попытку, даже удачную.
   */
  const stationBlind = telephonyOn && isStationDownLongerThan(minutes * 60_000);
  // Тумблер владельца 19.08.2026 (режим обучения) — см. подробный разбор ниже,
  // у ветки, которую он включает.
  const reassignOnMissedCall = settings?.leadReassignOnMissedCallEnabled ?? false;
  const escalateAfter = settings?.leadEscalateAfter ?? 3;
  const maxTransfers = reassignOnMissedCall ? await loadMaxTransfers() : 0;

  const candidates = await prisma.client.findMany({
    where: {
      // Нижняя граница (17.09.2026) — см. firstCallCandidateWindow в шапке файла:
      // без неё ручная правка acceptedAt на старой карточке снова делала её
      // «свежепринятой» для этого правила.
      acceptedAt: { not: null, gte: candidateFrom, lte: cutoff },
      assignedAgentId: { not: null },
      kind: { not: "OTHER" },
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      deletedAt: null,
      /**
       * Уже эскалированные — не трогаем: они висят «требует внимания» у
       * руководителя, и дальше решает человек (тот же щиток, что в
       * reassignStaleLeads выше по файлу).
       *
       * Без этого условия эскалация повторялась КАЖДЫЙ ТИК крона: клиент после
       * `escalatedAt: now` по-прежнему подходил под выборку, и раз в пять минут
       * заново получал SYSTEM-запись в хронологию и пуш руководству. 13.08.2026
       * владелец открыл карточку клиента и увидел хронологию, забитую часами
       * одинаковых «эскалация руководителю», — при единственном активном агенте
       * (он сам) свободных исполнителей не было никогда, и цикл не кончался.
       * Ручное назначение (routes/clients.ts, POST /:id/assign) сбрасывает
       * escalatedAt — после вмешательства руководителя цикл честно начинается
       * заново.
       */
      escalatedAt: null,
      /**
       * ЗАМОРОЖЕННЫЙ АГЕНТ СВОИХ КЛИЕНТОВ НЕ ТЕРЯЕТ (владелец 23.09.2026:
       * «заморозка — только чтобы не приходили новые»). Лид, принятый до
       * заморозки, без этого условия через минуты снимался «первый звонок не
       * совершён» и уходил другому, а агенту шёл штраф за то, что работать ему
       * запретили.
       */
      assignedAgent: { frozenAt: null },
      ...NOT_SELF_CREATED,
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      acceptedAt: true,
      reassignCount: true,
      triedAgentIds: true,
      declinedAgentIds: true,
      // kind — лимит активных лидов действует только на покупателей (20.08.2026).
      kind: true,
      // Лид по своему объекту хозяина не покидает (P0-1, 10.10.2026) — см. ownLeadKept ниже.
      ...OWN_PROPERTY_SELECT,
    },
    // Тот же потолок за проход, что у соседних джобов распределения — сотня не
    // держит колом весь цикл, а очередь и так движется каждый тик.
    orderBy: { acceptedAt: "asc" },
    take: 100,
  });
  if (candidates.length === 0) return { penalized: 0 };

  const points = await loadEventPoints();
  const supervisors = await findAgentsWithPermission("clients.assign");
  /**
   * Звонки по всем кандидатам сразу: поштучный запрос внутри цикла дал бы сотню
   * обращений к базе на каждый тик распределения (он идёт каждую минуту).
   *
   * ВСЕГДА, а не только при telephonyOn (переработка 12.08.2026): раньше без АТС
   * решение принималось по PendingSummary kind="call" («Итог разговора» через час
   * после принятия) — то окно снято вместе со всем механизмом ради единого окна
   * call_result. Facts из Interaction type=CALL телефонии не требуют вовсе (см.
   * collectFirstCallFacts — recordingDurationSec у ручной записи просто null), и
   * решают обе ветки decideFirstCall: talked/tried для АТС, tried как «attempted»
   * без неё.
   */
  const pauses = await firstCallPauses(candidates, telephonyOn, now, minutes);
  const callFacts = await collectFirstCallFacts(candidates, settings?.leadCallMinSeconds ?? 30, minutes, pauses);
  /**
   * КАРТОЧКА, У КОТОРОЙ УЖЕ БЫЛ РАЗГОВОР, ВТОРОЙ РАЗ НЕ ПРОВЕРЯЕТСЯ (17.09.2026,
   * см. разбор в шапке файла) — перевод карточки между агентами (в том числе
   * ручной, вечер 16.09) не обнуляет факт, что клиент уже разговаривал. Один
   * запрос на всю пачку, тем же приёмом, что и callFacts выше.
   */
  const priorConversationIds = await collectPriorConversationClientIds(candidates, settings?.leadCallMinSeconds ?? 30);

  let penalized = 0;

  for (const client of candidates) {
    if (priorConversationIds.has(client.id)) continue; // уже разговаривали — правило первого звонка не применяется
    // Срок, продлённый на простой станции, ещё не вышел (firstCallPauses).
    if (firstCallDueAt(client.acceptedAt!, minutes, pauses.get(client.id)) > now) continue;
    const agentId = client.assignedAgentId!;
    const facts = callFacts.get(client.id);
    const verdict = decideFirstCall({
      telephonyOn,
      stationBlind,
      attempted: !!facts?.tried,
      tried: !!facts?.tried,
    });
    if (verdict.keepLead) continue;

    if (!verdict.penalize) continue;

    /**
     * ПРИНЯТЫЙ ЛИД ПО УМОЛЧАНИЮ БОЛЬШЕ НЕ ПЕРЕНАЗНАЧАЕТСЯ АВТОМАТИЧЕСКИ (решение
     * владельца 18.08.2026, после случая с Нурмухаммадом: агент принял клиента,
     * а карточка сама ушла другому — владелец не мог понять, сделал это он сам
     * или система, а агенты жаловались на бесконечный круг «прими → 20 минут →
     * снова прими у следующего» между всеми сотрудниками). Штраф за бездействие
     * остаётся всегда (Fair Play: агент принял и не позвонил) — управляется этим
     * тумблером только САМА передача лида дальше.
     *
     * Владелец 19.08.2026 (режим обучения новых агентов) явно попросил вернуть
     * именно это поведение временно — leadReassignOnMissedCallEnabled включает
     * передачу обратно, признавая тот же риск, что и до 18.08. Дедуп на sourceId
     * балла ниже остаётся общим для обеих веток — иначе один и тот же случай
     * штрафовал бы дважды при повторном тике.
     */
    /**
     * ЛИД ПО СВОЕМУ ОБЪЕКТУ ТУМБЛЕР ОБУЧЕНИЯ НЕ УВОДИТ (10.10.2026, аудит
     * docs/audit-bots-2026-10-10-object-routing.md, P0-1). С 14.09 этот путь отдал
     * другим агентам 15 лидов с объектом, 9 из них — «свой объект»: хозяин принял
     * лид утренней волной, не позвонил за 15 минут, и клиент, пришедший по ЕГО
     * объекту, уезжал по очереди к постороннему. Решение владельца 11.09 (Пачка 1
     * п.6) — «не переназначать автоматически»: круг «не принял» уже держит его
     * напоминанием и эскалацией (reassignment.ts, `lead.ownPropertyLead`), отказ —
     * эскалацией (declineLead). Здесь та же логика, а не новая: лид остаётся у
     * хозяина ровно как при выключенном тумблере (ветка ниже) — штраф, запись,
     * сигнал руководителю, — плюс пуш самому хозяину. Признак общий с законом
     * (lib/propertyOwner.ts::holdsOwnPropertyLead).
     */
    const ownLeadKept = reassignOnMissedCall && holdsOwnPropertyLead(client);
    const sourceId = `call-missed-${client.id}-${client.acceptedAt!.getTime()}`;
    const already = await prisma.royalScoreEvent.findFirst({ where: { sourceId }, select: { id: true } });
    // Штраф — один раз на конкретный срыв (дедуп по sourceId), а не один раз
    // на весь оставшийся простой лида. Если владелец включил передачу ПОСЛЕ
    // того как лид уже был оштрафован и заморожен по старому правилу (18.08),
    // баллы повторно не начисляем, но лид всё равно должен уйти в круг на этом
    // же тике — иначе застрявшие ДО включения тумблера лиды так и остались бы
    // висеть до следующего срыва звонка, которого у принятого лида уже не будет.
    if (!already) {
      await recordScoreEvent({
        agentId,
        kind: "call_15min_missed",
        delta: points.call_15min_missed,
        reason: `Не позвонил за ${minutes} минут: ${client.fullName}`,
        sourceId,
      });
    } else if (!reassignOnMissedCall || ownLeadKept) {
      continue; // уже оштрафован и лид остаётся у агента — писать в хронологию каждый тик нечего
    }

    if (!reassignOnMissedCall || ownLeadKept) {
      const objectNo = client.matchedProperty?.shortId;
      // Крон-событие подписывается SYSTEM, а не агентом, которого оно же и
      // обвиняет (П-10, 17.09.2026, дефект «крон подписан тем, кого обвиняют»).
      await logTimeline({
        clientId: client.id,
        actor: { kind: "system", source: "first-call-missed", subjectAgentId: agentId },
        type: "SYSTEM",
        notes: ownLeadKept
          ? `Первый звонок не совершён за ${minutes} мин — клиент пришёл по объекту №${objectNo} этого агента и остаётся у хозяина объекта: автоматически передать его другому агенту нельзя, решает руководитель`
          : `Первый звонок не совершён за ${minutes} мин — лид остаётся у того же агента, автоматической передачи больше нет`,
      });
      // Руководству — в колокольчик и на дашборд, без звонка телефона
      // (владелец 20.09.2026, см. lib/notifications.ts::notifyFeedOnly).
      await notifyFeedOnly(supervisors, {
        kind: "lead",
        title: ownLeadKept ? "Первый звонок по объекту сорван" : "Первый звонок сорван",
        body: ownLeadKept
          ? `${client.fullName}: хозяин объекта №${objectNo} не позвонил за ${minutes} мин — переназначить может только руководитель`
          : `${client.fullName}: агент не позвонил за ${minutes} мин`,
        url: `/clients/${client.shortId}`,
        tag: `lead-call-missed-${client.id}`,
      });
      if (ownLeadKept) {
        sendPushToAgents([agentId], {
          title: "⏰ Клиент по вашему объекту ждёт звонка",
          body: `${client.fullName}: позвоните сейчас — объект №${objectNo} ваш, другому агенту лид не уйдёт`,
          url: `/clients/${client.shortId}`,
          tag: `lead-call-due-${client.id}`,
        }).catch((err) => console.error("[push] срыв первого звонка по своему объекту:", err));
      }
      penalized++;
      continue;
    }

    // Тумблер включён — лид снимается и уходит дальше, как до 18.08.2026.
    const tried = Array.isArray(client.triedAgentIds) ? (client.triedAgentIds as string[]) : [];
    const triedNow = tried.includes(agentId) ? tried : [...tried, agentId];
    const kind = client.kind === "SELLER" ? "SELLER" : "BUYER";
    // ОТКАЗАВШИЕСЯ ОТ ЛИДА — НАВСЕГДА (ПР-000477, 25.09.2026, см. шапку
    // Client.declinedAgentIds) — свой круг, тот же, что и в reassignment.ts.
    const declined = Array.isArray(client.declinedAgentIds) ? (client.declinedAgentIds as string[]) : [];
    const withDeclined = (ids: string[]) => [...new Set([...ids, ...declined])];

    // Пул «ничьих» УДАЛЁН ЦЕЛИКОМ (17.09.2026, П-4/Р-3 — см. комментарий у
    // `leadPoolCutoff` в шапке файла). До этой правки здесь стояла отсрочка на
    // `leadPoolAfterMinutes` с приглашением двум следующим агентам «заберите,
    // если успеете» — тумблер `leadReassignOnMissedCallEnabled`, включив
    // который, теперь сразу передаёт лид следующему по закону П-4 («не
    // позвонил за leadCallMinutes → следующему»), без промежуточного этапа.
    // (Ветка Б1 переводила этот же блок на logTimeline — не нужно, блок удалён
    // целиком законом П-4/Р-3, а не переписан.)

    const nextAgentId = await pickAgentForLead(withDeclined(triedNow), kind);
    if (client.reassignCount >= escalateAfter || !nextAgentId) {
      /**
       * ДВА РАЗНЫХ ДИАГНОЗА — ДВА РАЗНЫХ ТЕКСТА (найдено на проде 15.09.2026).
       * До этой правки оба случая делили одну фразу «свободных исполнителей не
       * осталось», и руководитель читал «людей нет», когда люди на самом деле
       * были:
       *  - лимит передач исчерпан (`reassignCount >= escalateAfter`) — про
       *    занятость агентов вообще ничего не говорит, лид просто обошёл
       *    разрешённое число рук;
       *  - `pickAgentForLead` не нашёл кандидата — вот это как раз «свободных
       *    исполнителей не осталось».
       * Если сработали оба условия разом, лимит передач — более точный и более
       * ранний диагноз (он же обычно и есть причина, по которой кандидат не
       * ищется на практике), поэтому при совпадении показываем его.
       */
      const limitExhausted = client.reassignCount >= escalateAfter;
      const escalationReason = limitExhausted
        ? `лимит передач исчерпан (${client.reassignCount} из ${escalateAfter})`
        : "свободных исполнителей не осталось";
      // «Неактивный», не «Потерянный» — см. разбор у первого becameInactive выше в файле.
      const becameInactive = transfersExhausted(client.reassignCount, maxTransfers);
      const trafficFields = becameInactive ? await inactiveLevelFields(client.id, client.kind, "OTHER", undefined, now) : {};
      /**
       * ЖЁСТКАЯ ИНТЕГРАЦИЯ ЗАКОНА (17.09.2026) — раньше здесь стоял прямой
       * `prisma.$transaction([client.update, interaction.create])` мимо
       * `changeClientAgent`: агент формально не менялся (`toAgentId` —
       * тот же держатель), поэтому старый сторож `assigned-agent-single-writer`
       * (он ищет только литерал `assignedAgentId:`) этого не ловил, но по духу
       * закона ЛЮБАЯ запись по клиенту обязана идти через единую точку — она
       * же сама пишет AuditLog, и его незачем дублировать руками.
       *
       * skipInteraction: true — хронологию пишем сами, ниже: эскалация не
       * должна подписываться агентом, которого сама же обвиняет (П-10,
       * 17.09.2026, дефект «крон подписан тем, кого обвиняет») —
       * `interactionAgentId` тут исказил бы авторство точно так же, как раньше
       * искажал прямой `agentId` в `interaction.create`.
       */
      /**
       * ВЛАДЕЛЕЦ И acceptedAt ИЗ СНИМКА — В WHERE ЗАПИСИ (аудит Codex 04.10.2026,
       * №17). Снимок читался один раз, а до сюда лид успевал пройти штраф и
       * `pickAgentForLead`: руководитель за эти секунды мог отдать карточку Б
       * через `/assign`, и эскалация без условия откатывала владельца к прежнему
       * агенту, писала «эскалация руководителю» и слала руководству пуш по лиду,
       * который у него только что отобрали. Тот же `guardWhere`, что у ветки
       * `firstCall.reassign` ниже, плюс `escalatedAt: null` (уже эскалированного
       * не трогаем). Отказ (`ok: false`) — «уже отработано кем-то другим»: ни
       * хронологии, ни пуша, ни штрафа в счётчик.
       */
      const escalation = await prisma.$transaction(async (tx) => {
        const changed = await changeClientAgent({
          clientId: client.id,
          toAgentId: client.assignedAgentId, // агент не меняется — только эскалация
          reason: `Первый звонок не совершён за ${minutes} мин — ${escalationReason}, эскалация руководителю${becameInactive ? `. Предел передач (${maxTransfers}) исчерпан — карточка переведена в Неактивные` : ""}`,
          actorId: null,
          source: "firstCall.escalate",
          skipInteraction: true,
          data: {
            escalatedAt: now,
            triedAgentIds: triedNow,
            ...(becameInactive
              ? { workStatus: "INACTIVE" as const, ...trafficFields, ...(client.assignedAgentId ? { lastAgentId: client.assignedAgentId } : {}) }
              : {}),
          },
          guardWhere: { assignedAgentId: agentId, acceptedAt: client.acceptedAt, escalatedAt: null,
            workStatus: "ACTIVE", status: { notIn: [...TERMINAL_CLIENT_STATUSES] } },
          tx,
        });
        if (changed.ok) {
          // SYSTEM, а не агент, которого эскалация обвиняет (П-10, 17.09.2026).
          await logTimeline({
            clientId: client.id,
            actor: { kind: "system", source: "first-call-escalation", subjectAgentId: agentId },
            type: "SYSTEM",
            notes: `Первый звонок не совершён за ${minutes} мин — ${escalationReason}, эскалация руководителю${becameInactive ? `. Предел передач (${maxTransfers}) исчерпан — карточка переведена в Неактивные` : ""}`,
            tx,
          });
        }
        return changed;
      });
      if (!escalation.ok) continue;
      // Руководству — в колокольчик и на дашборд, без звонка телефона
      // (владелец 20.09.2026, см. lib/notifications.ts::notifyFeedOnly).
      await notifyFeedOnly(supervisors, {
        kind: "lead",
        title: "Первый звонок сорван",
        body: `${client.fullName}: агент не позвонил за ${minutes} мин, ${escalationReason}`,
        url: `/clients/${client.shortId}`,
        tag: `lead-call-escalated-${client.id}`,
      });
      penalized++;
      continue;
    }

    // changeClientAgent — единственная точка записи assignedAgentId (аудит владения
    // 11.09.2026, docs/ownership-audit-11-09.md). Своя Interaction пишется отдельно.
    //
    // РЕЗУЛЬТАТ ОБЯЗАН ПРОВЕРЯТЬСЯ — см. подробный разбор у первой такой же
    // правки выше в этой функции (ветка «эскалация выключена»): живой случай
    // на проде 18.09.2026, тот же класс дефекта, что и там.
    const reassignResult = await prisma.$transaction(async (tx) => {
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: nextAgentId,
        reason: `Первый звонок не совершён за ${minutes} мин`,
        source: "firstCall.reassign",
        tx,
        skipInteraction: true,
        data: {
          assignedAt: now,
          acceptedAt: null,
          reassignCount: { increment: 1 },
          triedAgentIds: triedNow,
          poolCandidateIds: [],
        },
        // Владелец и acceptedAt из снимка — см. ту же правку в ветке обучения выше.
        guardWhere: { assignedAgentId: agentId, acceptedAt: client.acceptedAt },
      });
      if (changed.ok) {
        // SYSTEM, а не новый агент (П-10, 17.09.2026, дефект «лид снят и
        // переназначен подписан новым агентом», recon 04 §b.2).
        await logTimeline({
          clientId: client.id,
          actor: { kind: "system", source: "first-call-reassign", subjectAgentId: nextAgentId },
          type: "SYSTEM",
          notes: `Лид снят и переназначен: первый звонок не совершён за ${minutes} мин`,
          tx,
        });
      }
      return changed;
    });
    if (reassignResult.ok) {
      sendLeadPush(nextAgentId, client.id, {
        title: "🔔 Новый лид",
        body: `${client.fullName} — передан вам`,
        url: `/clients/${client.shortId}`,
        tag: `lead-${client.id}`,
      }).catch((err) => console.error("[push] передача после срыва звонка:", err));
      // «📤 Карточка передана» прежнему агенту убрана (владелец 02.10.2026):
      // ни пуша, ни записи в ленту. «🔔 Новый лид» новому агенту остаётся.
    }
    penalized++;
  }
  return { penalized };
}

/**
 * ПУШ АГЕНТУ ЗА 5 МИНУТ ДО СРОКА (задание 17.09.2026): до этой правки агент
 * узнавал о дедлайне только из окна приёма (IncomingLeadWindow) и только один
 * раз — дальше он должен был сам держать в голове 15 минут. Тот же тик крона,
 * что распределяет накопленные лиды ("lead-distribution" в cron.ts, каждые
 * пять минут) — окно выборки ниже (5 минут) совпадает с частотой тика, так
 * каждая подошедшая карточка попадает ровно в одно окно и не проверяется дважды.
 *
 * ДЕДУП — ТЕМ ЖЕ ПРИЁМОМ, ЧТО poolMarker ВЫШЕ В ЭТОМ ФАЙЛЕ: SYSTEM-запись в
 * хронологию с createdAt >= acceptedAt, без миграции схемы (отдельного поля
 * «пуш отправлен» нет и не нужно — один прошедший цикл принятия не бывает
 * прозвонен дважды).
 */
export async function remindDueFirstCalls(now: Date = new Date()): Promise<{ reminded: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const minutes = settings?.leadCallMinutes ?? 15;
  // Окно [dueAt-5мин, dueAt] выражено через acceptedAt: dueAt = acceptedAt + minutes,
  // значит acceptedAt лежит в [now - minutes, now - (minutes - 5)].
  // Простой станции сдвигает срок вперёд (firstCallPauses) — окно выборки
  // расширяется назад на весь недавний простой, а точный отбор «до срока ≤5 мин»
  // делается ниже по уже продлённому dueAt.
  const telephonyOn = !!(settings?.asteriskAriUrl && settings.asteriskAriUsername && settings.asteriskAriPassword);
  const lookback = new Date(now.getTime() - 4 * 3_600_000);
  const recentOutageMs = telephonyOn ? outageOverlapMs(lookback, now, await outagesBetween(lookback, now)) : 0;
  // Срок, простоявший ночь, наступает утром — окно отодвигается к вечеру, как у
  // firstCallCandidateWindow; точный отбор ниже по продлённому dueAt.
  const windowStart = widenAfterNight(
    new Date(now.getTime() - minutes * 60_000 - recentOutageMs),
    leadHoursOf(settings),
    now
  );
  const windowEnd = new Date(now.getTime() - Math.max(0, minutes - 5) * 60_000);

  const candidates = await prisma.client.findMany({
    where: {
      acceptedAt: { gte: windowStart, lte: windowEnd },
      assignedAgentId: { not: null },
      kind: { not: "OTHER" },
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      deletedAt: null,
      escalatedAt: null,
      ...NOT_SELF_CREATED,
    },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true, acceptedAt: true, ...OWN_PROPERTY_SELECT },
    take: 100,
  });
  if (candidates.length === 0) return { reminded: 0 };

  const status = await firstCallStatus(candidates, {
    leadCallMinutes: settings?.leadCallMinutes ?? null,
    leadCallMinSeconds: settings?.leadCallMinSeconds ?? null,
    asteriskAriUrl: settings?.asteriskAriUrl ?? null,
    asteriskAriUsername: settings?.asteriskAriUsername ?? null,
    asteriskAriPassword: settings?.asteriskAriPassword ?? null,
  }, now);

  const reminderMarker = "Напоминание о первом звонке отправлено";
  // Что будет после срока — по настройке, а не «лид уйдёт» всегда (23.09.2026,
  // проверка раздачи, пункт 15): по умолчанию лид остаётся у агента, пишется
  // минус и сигнал руководителю; дальше лид уходит только в режиме обучения.
  const afterDue = settings?.leadReassignOnMissedCallEnabled
    ? "потом лид уйдёт"
    : "потом минус к Royal Score";
  let reminded = 0;
  for (const client of candidates) {
    const s = status.get(client.id);
    if (!s || s.done) continue; // уже поговорил или (без АТС) хоть что-то записал — предупреждать не о чем
    // Срок продлён простоем станции и до него ещё больше 5 минут — рано; уже вышел — поздно.
    const leftMs = s.dueAt.getTime() - now.getTime();
    if (leftMs > 5 * 60_000 || leftMs < 0) continue;
    const agentId = client.assignedAgentId!;

    const already = await prisma.interaction.findFirst({
      where: {
        clientId: client.id,
        type: "SYSTEM",
        notes: { startsWith: reminderMarker },
        createdAt: { gte: client.acceptedAt! },
      },
      select: { id: true },
    });
    if (already) continue;

    const minutesLeft = Math.max(0, Math.round((s.dueAt.getTime() - now.getTime()) / 60_000));
    // Лид по своему объекту не уходит и в режиме обучения (P0-1) — не пугать хозяина неправдой.
    const after = holdsOwnPropertyLead(client) ? "потом минус к Royal Score" : afterDue;
    await logTimeline({
      clientId: client.id,
      actor: { kind: "system", source: "first-call-reminder", subjectAgentId: agentId },
      type: "SYSTEM",
      notes: `${reminderMarker}: осталось ${minutesLeft} мин, ${after}`,
    });
    sendPushToAgents([agentId], {
      title: "⏱ Позвонить клиенту",
      body: `${client.fullName}: осталось ${minutesLeft} мин, ${after}`,
      url: `/clients/${client.shortId}`,
      tag: `lead-call-due-${client.id}`,
    }).catch((err) => console.error("[push] напоминание о первом звонке:", err));
    reminded++;
  }
  return { reminded };
}

/** Что известно про первый звонок агента этому клиенту в отведённое окно. */
export interface FirstCallFacts {
  /** Разговор состоялся и был не короче порога. */
  talked: boolean;
  /** Попытка была: агент звонил клиенту, написал ему из CRM или записал разговор руками. */
  tried: boolean;
  /**
   * РАЗГОВОР состоялся, но ПОЗЖЕ отведённого срока (найдено 19.09.2026, жалоба
   * владельца «клиент 00059 стоит на дашборде, как будто ему срочно надо
   * звонить, хотя не должно»).
   *
   * Для крона это по-прежнему не считается выполненной обязанностью — срок
   * пропущен, и задним числом он не возвращается, иначе смысл срока пропал бы:
   * `decideFirstCall` это поле не видит вовсе, штраф и передача лида дальше
   * решаются ровно как раньше. Но экрану агента («Мой фокус» на Главной,
   * таймер в карточке) факт нужен отдельно: там вопрос не «штрафовать ли», а
   * «надо ли ещё звонить», и состоявшийся разговор отвечает на него независимо
   * от того, уложился агент в пятнадцать минут или нет. Пока поля не было,
   * карточка с настоящим, но поздним звонком висела в «срочно позвонить» — и
   * висела ПЕРВОЙ строкой, потому что список сортируется по самому
   * просроченному сроку.
   *
   * ИМЕННО РАЗГОВОР, А НЕ ЛЮБАЯ ПОПЫТКА, и это строже, чем правило внутри
   * срока (вопрос владельца 19.09.2026: «почему теперь позже 15 минут можно
   * звонить?»). В срок обязанность закрывает сама попытка — клиент мог не взять
   * трубку, и Fair Play не велит спрашивать с агента чужое молчание. После
   * срока послабления нет: снять с экрана напоминание о клиенте, которого так и
   * не услышали, значит разрешить «набрал в гудок — и отстали». Поэтому здесь
   * требуется длительность не короче `leadCallMinSeconds`, ровно как у `talked`.
   */
  talkedLate: boolean;
}

/**
 * Судьба лида и агента по итогам отведённого времени. Чистая функция: сюда
 * приходят уже собранные факты, поэтому всё правило видно целиком и проверяется
 * тестами на любых сочетаниях, не поднимая ни базы, ни АТС.
 *
 * П-2 (закон о владении клиентом, 17.09.2026, `docs/law/lead-ownership.md`,
 * `services/leads/ownershipPolicy.ts::hasContactAttempt`) — ЛЮБАЯ попытка
 * связаться снимает обязанность первого звонка, дозвонился агент или нет.
 * ДО этой правки лид уходил дальше (`keepLead: false`), если разговор был
 * короче `leadCallMinSeconds` — притом что штраф уже и так не начислялся
 * (Fair Play: трубку не взял клиент). Разница была ТОЛЬКО в передаче лида: за
 * настоящую, полноценную попытку карточку всё равно отбирали и отдавали
 * дальше — ровно то же нарушение П-3, что и у остальных 11 механизмов
 * (`docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`, механизм №4).
 * Теперь `talked`/длительность разговора не участвуют в этом решении вовсе —
 * только факт попытки (`tried`, без АТС — `attempted`); штраф Royal Score за
 * ОТСУТСТВИЕ попытки остаётся как был.
 */
export function decideFirstCall(input: {
  telephonyOn: boolean;
  /**
   * Телефония настроена, но станция не на связи дольше окна первого звонка
   * (см. `stationBlind` в penalizeMissedFirstCalls) — CRM физически не видела
   * событий станции всё это время, значит факт звонка (`tried`, приходит
   * только из Interaction type=CALL, которую пишет ChannelDestroyed) не
   * заслуживает доверия. Ведём себя так же, как при полностью выключенной
   * телефонии — единственное, что CRM в этом случае действительно видит, это
   * ручная запись через AddInteractionModal.
   */
  stationBlind: boolean;
  /**
   * Записал ли агент ХОТЬ ЧТО-ТО о попытке связаться — раньше это было закрытое
   * окно «Итог разговора» (kind="call", снято 12.08.2026 вместе со всем окном), а
   * это единственный сигнал, что оставался у CRM без АТС: ручная запись
   * взаимодействия через AddInteractionModal. Переименовано из summaryDone под
   * новый источник факта, смысл параметра прежний — «агент хоть что-то сделал».
   */
  attempted: boolean;
  tried: boolean;
}): { keepLead: boolean; penalize: boolean } {
  // Без АТС, а также с АТС, чья подписка ослепла на весь срок окна, видно только
  // одно — записал ли агент вообще какую-то попытку связаться руками.
  if (!input.telephonyOn || input.stationBlind) {
    return input.attempted ? { keepLead: true, penalize: false } : { keepLead: false, penalize: true };
  }
  // Любая попытка (дозвонился или нет) закрывает обязанность и оставляет лид —
  // тот же критерий, что и в ветке без АТС выше, просто источник факта другой.
  return input.tried ? { keepLead: true, penalize: false } : { keepLead: false, penalize: true };
}

/**
 * Срок и статус первого звонка для карточек, которые ЕЩЁ висят на агенте
 * (задание 17.09.2026, «клиент теряется, если вовремя не позвонить»): то же
 * решение, что принимает крон (`decideFirstCall`) выше, но заранее и без
 * штрафа — агенту и его Главной нужно не «оштрафовать», а «предупредить».
 *
 * НЕ КОПИЯ ЛОГИКИ КРОНА, А ЕЁ ПЕРЕИСПОЛЬЗОВАНИЕ: те же факты одним пакетным
 * запросом (`collectFirstCallFacts`, уже без N+1 — один `Interaction.findMany`
 * на весь список карточек, кем бы их ни звали) и тот же вердикт
 * (`decideFirstCall`) — иначе экран агента и крон рано или поздно разошлись бы
 * в том, что считать «дозвонился», и разница всплыла бы только на живом лиде.
 *
 * `done=true` — то же самое, что `verdict.keepLead` у крона: обязанность
 * закрыта (разговор состоялся дольше порога, а без телефонии — хоть какая-то
 * ручная запись попытки), таймер/баннер можно прятать. Карточки без
 * `acceptedAt` в ответ не попадают — для них самого срока ещё нет.
 */
export async function firstCallStatus(
  candidates: { id: string; assignedAgentId: string | null; acceptedAt: Date | null }[],
  settings: {
    leadCallMinutes: number | null;
    leadCallMinSeconds: number | null;
    asteriskAriUrl: string | null;
    asteriskAriUsername: string | null;
    asteriskAriPassword: string | null;
  },
  now: Date = new Date()
): Promise<Map<string, { dueAt: Date; done: boolean; tried: boolean }>> {
  const result = new Map<string, { dueAt: Date; done: boolean; tried: boolean }>();
  const accepted = candidates.filter(
    (c): c is typeof c & { acceptedAt: Date } => c.acceptedAt !== null
  );
  if (accepted.length === 0) return result;
  // Своему клиенту экран не показывает отсчёт «позвоните за 15 минут» — тот же
  // щиток, что у крона (SELF_CREATED_ASSIGN_REASON).
  const selfCreated = new Set(
    (
      await prisma.client.findMany({
        where: { id: { in: accepted.map((c) => c.id) }, assignReason: { in: NO_FIRST_CALL_WINDOW_REASONS } },
        select: { id: true },
      })
    ).map((c) => c.id)
  );
  const withAccepted = accepted.filter((c) => !selfCreated.has(c.id));
  if (withAccepted.length === 0) return result;

  const minutes = settings.leadCallMinutes ?? 15;
  const minSeconds = settings.leadCallMinSeconds ?? 30;
  const telephonyOn = !!(settings.asteriskAriUrl && settings.asteriskAriUsername && settings.asteriskAriPassword);
  // Тот же щиток «станция ослепла», что и у крона (см. penalizeMissedFirstCalls
  // выше) — иначе баннер на Главной честно отсчитал бы дедлайн, который сам
  // крон в это же время не собирается проверять по вине связи, а не агента.
  const stationBlind = telephonyOn && isStationDownLongerThan(minutes * 60_000);
  const pauses = await firstCallPauses(withAccepted, telephonyOn, now, minutes);
  const facts = await collectFirstCallFacts(withAccepted, minSeconds, minutes, pauses);

  for (const c of withAccepted) {
    const f = facts.get(c.id);
    const verdict = decideFirstCall({
      telephonyOn,
      stationBlind,
      attempted: !!f?.tried,
      tried: !!f?.tried,
    });
    result.set(c.id, {
      dueAt: firstCallDueAt(c.acceptedAt, minutes, pauses.get(c.id)),
      // `|| f.talkedLate` — ЕДИНСТВЕННОЕ отличие от вердикта крона, и оно
      // намеренное (19.09.2026, см. talkedLate в FirstCallFacts): агенту, который
      // уже ПОГОВОРИЛ с клиентом — пусть и позже срока, — экран больше не
      // говорит «срочно позвоните». Штраф и передача лида по-прежнему решаются
      // строго по сроку, и одного набора без разговора здесь не хватит.
      done: verdict.keepLead || !!f?.talkedLate,
      tried: !!f?.tried || !!f?.talkedLate,
    });
  }
  return result;
}

/**
 * Звонки всех кандидатов одним заходом — два запроса на весь проход.
 *
 * Учитываются только записи, попавшие в окно «принял → отведённые минуты»: звонок,
 * сделанный на час позже срока, обязанность вовремя не закрывает, иначе срок
 * зависел бы от того, когда именно проснулся крон.
 */
/**
 * СРОК ПЕРВОГО ЗВОНКА СТОИТ, ПОКА СТАНЦИЯ ЛЕЖИТ (23.09.2026).
 *
 * Станция не отвечала 11:57–13:06: агенты жали «Позвонить» и получали «Нет связи
 * с телефонной станцией», а срок шёл — в 12:50 крон снял двух клиентов «за то,
 * что не позвонили». Щиток `stationBlind` не спас: он лишь менял источник факта на
 * ручную запись, а её никто не делал — люди ждали связь, а не писали заметки.
 *
 * Теперь к сроку прибавляется время простоя из журнала StationOutage (зонд раз в
 * 5 минут, lib/stationOutage.ts) — в базе, а не в памяти процесса, поэтому
 * переживает перезапуск API посреди простоя. Один запрос на весь список.
 *
 * ВЫХОДНОЙ АГЕНТА (владелец 11.10.2026). Срок, выпавший на выходной — общий
 * (Settings.companyDaysOff) или личный агента карточки (Agent.weeklyDaysOff), — не
 * истекает в выходной: он переносится на начало ЕГО следующего рабочего дня плюс полное
 * окно первого звонка. Ни штрафа, ни ухода лида в выходной. Пустые списки — без поправки.
 */
export async function firstCallPauses(
  candidates: { id: string; acceptedAt: Date | null; assignedAgentId?: string | null }[],
  telephonyOn: boolean,
  now: Date,
  minutes: number
): Promise<Map<string, number>> {
  const pauses = new Map<string, number>();
  const accepted = candidates.filter(
    (c): c is { id: string; acceptedAt: Date; assignedAgentId?: string | null } => c.acceptedAt !== null
  );
  if (accepted.length === 0) return pauses;
  // Ночь: срок идёт только в часы раздачи (closedMsBeforeDue в shared.ts).
  const hoursRow = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  const hours = leadHoursOf(hoursRow);
  for (const c of accepted) {
    const ms = closedMsBeforeDue(c.acceptedAt, minutes, hours);
    if (ms > 0) pauses.set(c.id, ms);
  }
  // Выходные: компания — одним чтением, агенты — одним запросом на весь список (без N+1).
  const agentIds = [...new Set(accepted.map((c) => c.assignedAgentId).filter((id): id is string => !!id))];
  const [companyDaysOff, agentRows] = await Promise.all([
    loadCompanyDaysOff(),
    agentIds.length
      ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, weeklyDaysOff: true } })
      : Promise.resolve([] as { id: string; weeklyDaysOff: number[] }[]),
  ]);
  const agentDays = new Map(agentRows.map((a) => [a.id, a]));
  for (const c of accepted) {
    const cal = calendarFor(companyDaysOff, c.assignedAgentId ? agentDays.get(c.assignedAgentId) : null);
    const due = firstCallDueAt(c.acceptedAt, minutes, pauses.get(c.id));
    if (!isDayOff(due, cal)) continue;
    const back = startOfWorkingDayAtOrAfter(due, cal, hours.start);
    pauses.set(c.id, (pauses.get(c.id) ?? 0) + (back.getTime() - due.getTime()) + minutes * 60_000);
  }
  if (!telephonyOn) return pauses; // без АТС звонить через CRM и так нельзя — простой станции не в счёт
  const earliest = new Date(Math.min(...accepted.map((c) => c.acceptedAt.getTime())));
  const outages = await outagesBetween(earliest, now);
  if (outages.length === 0) return pauses;
  for (const c of accepted) {
    const ms = outageOverlapMs(c.acceptedAt, now, outages);
    if (ms > 0) pauses.set(c.id, (pauses.get(c.id) ?? 0) + ms);
  }
  return pauses;
}

/** Срок первого звонка с учётом ночи и простоя станции. */
export function firstCallDueAt(acceptedAt: Date, minutes: number, pausedMs = 0): Date {
  return new Date(acceptedAt.getTime() + minutes * 60_000 + pausedMs);
}

export async function collectFirstCallFacts(
  candidates: { id: string; assignedAgentId: string | null; acceptedAt: Date | null }[],
  minSeconds: number,
  minutes: number,
  /** Сколько срок каждой карточки стоял из-за простоя станции (firstCallPauses). */
  pauses?: ReadonlyMap<string, number>
): Promise<Map<string, FirstCallFacts>> {
  const deadlineFor = new Map(
    candidates.map((c) => [c.id, firstCallDueAt(c.acceptedAt!, minutes, pauses?.get(c.id))] as const)
  );

  const calls = await prisma.interaction.findMany({
    where: {
      clientId: { in: candidates.map((c) => c.id) },
      type: "CALL",
      // Звонок, не дошедший до телефона клиента (агент не снял трубку или
      // отменил вызов), — не попытка связаться (23.09.2026, проверка раздачи,
      // пункт 12). Тот же отбор, что у markAgentAttempt в callTracker.ts.
      // Ручная запись исхода не имеет (null) и считается, как раньше.
      OR: [{ callAttempt: null }, { callAttempt: { notIn: [...NOT_REACHED_CLIENT] } }],
      // Окно у каждого клиента своё; общая нижняя граница — самое раннее принятие,
      // точная проверка ниже. Так выборка остаётся одним запросом и не тащит всю
      // историю звонков карточки.
      createdAt: { gte: new Date(Math.min(...candidates.map((c) => c.acceptedAt!.getTime()))) },
    },
    select: { id: true, clientId: true, agentId: true, createdAt: true, recordingDurationSec: true },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });

  // Входящие звонки клиента пишутся в хронологию от имени ответственного агента
  // (у Interaction автор обязателен, а оператора в CRM нет). Для этой обязанности
  // они не годятся: говорил оператор, а не агент. Правило вынесено в общий модуль —
  // оно нужно везде, где по хронологии судят о работе агента, и пока жило здесь,
  // в KPI агенту засчитывался чужой звонок как его собственный ответ.
  const incomingIds = await incomingInteractionIds(calls.map((c) => c.id));

  const facts = new Map<string, FirstCallFacts>();
  for (const call of calls) {
    if (incomingIds.has(call.id)) continue;
    const client = candidates.find((c) => c.id === call.clientId);
    if (!client || call.agentId !== client.assignedAgentId) continue;
    const deadline = deadlineFor.get(call.clientId);
    if (!deadline || call.createdAt < client.acceptedAt!) continue;

    const current = facts.get(call.clientId) ?? { talked: false, tried: false, talkedLate: false };
    // Звонок ПОСЛЕ срока обязанность вовремя не закрывает (иначе срок зависел бы
    // от того, когда проснулся крон) — но и бесследно исчезать не должен, см.
    // talkedLate в FirstCallFacts. Там же — почему после срока засчитывается
    // только состоявшийся разговор, а не любая попытка.
    if (call.createdAt > deadline) {
      if (call.recordingDurationSec !== null && call.recordingDurationSec >= minSeconds) {
        current.talkedLate = true;
        facts.set(call.clientId, current);
      }
      continue;
    }
    current.tried = true;
    // Длительность заполняет только телефония (см. callTracker.finishCall):
    // у недозвона там null, у ручной записи разговора её нет вовсе.
    if (call.recordingDurationSec !== null && call.recordingDurationSec >= minSeconds) {
      current.talked = true;
    }
    facts.set(call.clientId, current);
  }

  /**
   * СООБЩЕНИЕ КЛИЕНТУ ИЗ CRM — ТОЖЕ ПОПЫТКА (23.09.2026, проверка раздачи,
   * пункт 11; закон П-2: любая попытка агента связаться). Отправка из
   * переписки CRM ставит `lastAgentAttemptAt` только агенту карточки
   * (conversationDelivery.ts → markAgentAttempt), а в хронологию не пишется —
   * поэтому смотрим отметку. Она хранит ПОСЛЕДНЮЮ попытку: если агент написал в
   * срок и ещё раз после срока до ближайшего тика, первое сообщение не видно.
   * Тик идёт каждые 5 минут, так что это узкий край, а не правило.
   */
  const attempts = await prisma.client.findMany({
    where: { id: { in: candidates.map((c) => c.id) }, lastAgentAttemptAt: { not: null } },
    select: { id: true, lastAgentAttemptAt: true },
  });
  for (const a of attempts) {
    const client = candidates.find((c) => c.id === a.id);
    const deadline = deadlineFor.get(a.id);
    if (!client?.acceptedAt || !deadline) continue;
    if (a.lastAgentAttemptAt! < client.acceptedAt || a.lastAgentAttemptAt! > deadline) continue;
    const current = facts.get(a.id) ?? { talked: false, tried: false, talkedLate: false };
    current.tried = true;
    facts.set(a.id, current);
  }
  return facts;
}

/** Исходы звонка через CRM, при которых телефон клиента не звонил. */
const NOT_REACHED_CLIENT = ["AGENT_NO_PICKUP", "CANCELLED"] as const;

/**
 * У карточки уже был реальный разговор ДО текущего приёма — с ЛЮБЫМ агентом, не
 * только с текущим держателем (17.09.2026, см. разбор в шапке файла). Перевод
 * лида между агентами, ручной или автоматический, не отменяет то, что клиент уже
 * разговаривал: «первый звонок» этому клиенту физически уже состоялся, второй раз
 * его требовать от нового держателя карточки — и снимать за него баллы — не за что.
 *
 * Входящие звонки клиента сюда не считаются — тем же критерием, что и в
 * `collectFirstCallFacts`: трубку в этих записях снимает оператор, а не агент, и
 * звонок в поддержку не должен закрывать обязанность разговора с агентом.
 *
 * Один запрос на всю пачку кандидатов (не N+1): верхняя граница `createdAt` берёт
 * самый поздний `acceptedAt` среди кандидатов, точная проверка «раньше СВОЕГО
 * acceptedAt» — на выборке в памяти, тем же приёмом, что и в collectFirstCallFacts.
 */
export async function collectPriorConversationClientIds(
  candidates: { id: string; acceptedAt: Date | null }[],
  minSeconds: number
): Promise<Set<string>> {
  const withAcceptedAt = candidates.filter(
    (c): c is { id: string; acceptedAt: Date } => c.acceptedAt !== null
  );
  if (withAcceptedAt.length === 0) return new Set();

  const calls = await prisma.interaction.findMany({
    where: {
      clientId: { in: withAcceptedAt.map((c) => c.id) },
      type: "CALL",
      recordingDurationSec: { gte: minSeconds },
      createdAt: { lt: new Date(Math.max(...withAcceptedAt.map((c) => c.acceptedAt.getTime()))) },
    },
    select: { id: true, clientId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });
  if (calls.length === 0) return new Set();

  const incomingIds = await incomingInteractionIds(calls.map((c) => c.id));
  const acceptedAtById = new Map(withAcceptedAt.map((c) => [c.id, c.acceptedAt.getTime()] as const));

  const result = new Set<string>();
  for (const call of calls) {
    if (incomingIds.has(call.id)) continue;
    const acceptedAtMs = acceptedAtById.get(call.clientId);
    if (acceptedAtMs === undefined || call.createdAt.getTime() >= acceptedAtMs) continue;
    result.add(call.clientId);
  }
  return result;
}

/**
 * Балл за первый звонок, сделанный вовремя (Royal Score `call_on_time`).
 *
 * Вызывается в момент, когда разговор закончился и его длительность известна
 * (lib/telephony/callTracker.ts). До 09.08.2026 балл давали за сохранённый «Итог
 * разговора» — то есть за набранный текст; теперь его даёт сам факт разговора,
 * а дисциплина заполнения окна считается своим событием.
 *
 * Повторно не начисляется: sourceId привязан к циклу принятия лида, а уникальность
 * (kind, sourceId) в журнале не даст записать второе такое же событие — тот же
 * приём, что и у штрафа выше.
 */
export async function rewardFirstCallIfOnTime(
  clientId: string,
  agentId: string,
  talkedSeconds: number,
  now: Date = new Date()
): Promise<void> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      leadCallMinutes: true,
      leadCallMinSeconds: true,
      asteriskAriUrl: true,
      asteriskAriUsername: true,
      asteriskAriPassword: true,
    },
  });
  const minSeconds = settings?.leadCallMinSeconds ?? 30;
  if (talkedSeconds < minSeconds) return;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { fullName: true, acceptedAt: true, assignedAgentId: true },
  });
  // Балл — за звонок ПО СВОЕМУ лиду и в отведённый срок. Звонок чужому клиенту
  // или разговор через два часа после принятия обязанность не закрывают.
  if (!client?.acceptedAt || client.assignedAgentId !== agentId) return;
  const minutes = settings?.leadCallMinutes ?? 15;
  // Тот же срок, что у штрафа: с ночью и простоем станции (firstCallPauses).
  const telephonyOn = !!(settings?.asteriskAriUrl && settings.asteriskAriUsername && settings.asteriskAriPassword);
  const pauses = await firstCallPauses(
    [{ id: clientId, acceptedAt: client.acceptedAt, assignedAgentId: client.assignedAgentId }],
    telephonyOn,
    now,
    minutes
  );
  if (now > firstCallDueAt(client.acceptedAt, minutes, pauses.get(clientId))) return;

  const points = await loadEventPoints();
  const kind: ScoreEventKind = "call_on_time";
  await recordScoreEvent({
    agentId,
    kind,
    delta: points[kind],
    reason: `Первый звонок вовремя: ${client.fullName}`,
    sourceId: `call-ontime-${clientId}-${client.acceptedAt.getTime()}`,
  });
}
