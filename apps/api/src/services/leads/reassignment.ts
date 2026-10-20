import { prisma } from "../../db.js";
import { sendPushToAgent } from "../../push.js";
import { sendLeadPush } from "../../lib/pushLeadActions.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { loadEventPoints, recordScoreEvent } from "../../lib/scoreJournal.js";
import { incomingInteractionIds } from "../../lib/telephony/incomingInteractions.js";
import { pickAgentForLead, acceptingLeadsWhere } from "./selection.js";
import { candidateWindow, leadHoursOf, widenAfterNight, dushanbePrevOccurrence, openMsBetween } from "./shared.js";
import { assignAgentForLead, recordAssignReason } from "./assignment.js";
import { changeClientAgent } from "../../lib/changeClientAgent.js";
import { notifyFeedOnly } from "../../lib/notifications.js";
import { hasContactAttempt } from "./ownershipPolicy.js";
import { loadOwnershipSnapshot, escalateInsteadOfTransfer } from "./ownershipLoad.js";
import { logTimeline } from "../../lib/timeline.js";
import { isWithinDushanbeWindow } from "../../lib/dushanbeTime.js";
import { isDayOff, type DaysOffCalendar } from "@royal-home/shared";
import { loadDaysOffCalendar } from "../../lib/daysOffCalendar.js";
import { reportCronRowError } from "../../lib/cronHeartbeat.js";

/**
 * Переназначает лиды, не принятые агентом за отведённое время (Настройки → leadAcceptMinutes).
 * После leadEscalateAfter кругов лид не крутится дальше, а ЭСКАЛИРУЕТСЯ: помечается
 * «требует внимания» (escalatedAt) и о нём уведомляются руководители — чтобы непринятые
 * заявки становились видимыми, а не терялись в бесконечном переназначении.
 * Вызывается кроном; каждое действие логируется системным взаимодействием.
 *
 * НИЖНЯЯ ГРАНИЦА ОКНА (17.09.2026, тот же класс, что и в `firstCall.ts` —
 * `penalizeMissedFirstCalls`): если руками выставить `assignedAt` на старой
 * карточке с `acceptedAt: null`, она без нижней границы снова выглядела бы как
 * свежий непринятый лид и ушла бы по кругу. `candidateWindow` — общая функция
 * с правилом первого звонка; здесь цикл ровно один — само окно принятия
 * (`leadAcceptMinutes`), у карусели нет отдельной фазы пула.
 */
export async function reassignStaleLeads(now: Date = new Date()): Promise<{ moved: number; escalated: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const minutes = settings?.leadAcceptMinutes ?? 15;
  const { from: windowFrom, to: cutoff } = candidateWindow(minutes, minutes, now);
  const hours = leadHoursOf(settings);
  const staleFrom = widenAfterNight(windowFrom, hours, now);

  // escalatedAt: null — уже эскалированные не трогаем (они висят как «требует внимания»).
  // kind=OTHER исключаем совсем: такие обращения никогда не назначаются агенту
  // (assignedAgentId=null) и не должны затягиваться в круговое переназначение/эскалацию.
  const stale = await prisma.client.findMany({
    // assignedAgentId not null — режим "Вручную" (или момент без активных агентов)
    // может оставить лид без агента вовсе; такие ждут ручного назначения, это не
    // "просрочка принятия", крутить их через реассайн/эскалацию нечего.
    where: {
      acceptedAt: null,
      escalatedAt: null,
      // Нижняя граница (17.09.2026) — см. комментарий у объявления функции выше.
      assignedAt: { gte: staleFrom, lt: cutoff },
      kind: { not: "OTHER" },
      assignedAgentId: { not: null },
      // Клиент в Корзине не «протухший лид», а удалённая запись: без этого фильтра
      // крон вечно гонял его по агентам с пушами и в итоге эскалировал руководителям.
      deletedAt: null,
      /**
       * П-2/П-3 (закон о владении клиентом, 17.09.2026, `docs/law/lead-ownership.md`).
       * Клиент, с которым УЖЕ был контакт, не должен крутиться каруселью «не
       * принял», даже если `acceptedAt` сейчас `null` — таким его делает
       * отказ от прежнего агента, «Передать», уход сотрудника, возврат из
       * Корзины. Аудит 30 дней (`docs/audit/lead-ownership-17-09.md` §1.2): 20
       * из 52 передач `reassignment.stale` ушли ПОСЛЕ состоявшегося разговора.
       *
       * Раньше такие лиды отсекались здесь же фильтром `firstContactAt: null` —
       * и повисали «Ждёт принятия» навсегда: ни передачи, ни сигнала
       * руководителю (владелец 23.09.2026, разбор раздачи, пункт 5). Теперь они
       * в выборке, а цикл ниже (`escalateIfAlreadyContacted`) не передаёт их,
       * а один раз поднимает руководителю: `escalatedAt` выводит лид из круга и
       * ставит в «требует внимания» с напоминаниями (remindEscalatedLeads).
       */
    },
    select: {
      id: true,
      shortId: true,
      assignedAgentId: true,
      assignedAt: true,
      fullName: true,
      reassignCount: true,
      triedAgentIds: true,
      declinedAgentIds: true,
      kind: true,
      // Пачка 1 п.6 (11.09.2026): лид по своему объекту просрочку переживает
      // иначе — см. ветку ниже.
      ownPropertyLead: true,
      // П-13 (18.09.2026): первая ступень (напоминание) уже отправлена или нет.
      ownPropertyReminderSentAt: true,
    },
    /**
     * Сначала те, кто ждёт дольше всех, и не больше сотни за проход.
     *
     * Предела здесь не было вовсе, а на каждый лид в цикле идёт подбор агента —
     * это пять-шесть запросов. После долгого простоя или массового импорта триста
     * непринятых лидов давали под две тысячи запросов в одном тике, и всё это время
     * замок распределения (isDistributionRunning) держал раздачу новых лидов.
     * Сотня за тик разбирает очередь так же быстро — крон тикает часто, — но не
     * встаёт колом. Тот же потолок стоит у соседнего assignPendingLeads.
     */
    orderBy: { assignedAt: "asc" },
    take: 100,
  });

  let moved = 0;
  let escalated = 0;
  // Кому уходит уведомление об эскалации — тем, кто может назначить риелтора,
  // то есть по праву, а не по роли. Находим один раз на цикл.
  const supervisors = await findAgentsWithPermission("clients.assign");
  const points = await loadEventPoints();
  // Потолок карусели (аудит владения 11.09.2026, дыра №4) — см. комментарий
  // у carouselExhausted внутри цикла.
  const availableAgentsCount = await prisma.agent.count({ where: acceptingLeadsWhere() });

  /**
   * ЗАХВАТ ЛИДА ПЕРЕД ЛЮБЫМ ДЕЙСТВИЕМ (аудит №4, 27.08) — через единую точку
   * записи `changeClientAgent` (аудит владения 11.09.2026, дыра №6/№1):
   * тот же арбитр гонки (`guardWhere`), что и раньше, плюс Interaction и
   * AuditLog гарантированно пишутся при каждом успешном захвате.
   *
   * Между снимком `stale` и решением по конкретному лиду проходят секунды и
   * десятки секунд (подбор агента — пять-шесть запросов на лид). Агент в это
   * окно жмёт «Принять» у самого дедлайна — и безусловный update переставлял
   * assignedAgentId на другого, не глядя на acceptedAt: клиент уезжал у
   * принявшего агента из-под рук, а новому доставалась карточка «принятая»,
   * которую он не принимал. Условие сверяет и acceptedAt, и то, что назначение
   * не сменилось с момента снимка; `ok:false` — лид уже не наш, пропускаем без
   * штрафа. Тот же приём, что в починенном declineLead.
   */
  const claimLead = async (
    lead: { id: string; assignedAgentId: string | null; assignedAt: Date },
    toAgentId: string | null,
    data: Record<string, unknown>,
    reason: string,
    source: string,
    interactionAgentId: string
  ): Promise<boolean> => {
    const result = await changeClientAgent({
      clientId: lead.id,
      toAgentId,
      reason,
      actorId: null,
      interactionAgentId,
      source,
      data,
      guardWhere: {
        acceptedAt: null,
        escalatedAt: null,
        assignedAgentId: lead.assignedAgentId,
        assignedAt: lead.assignedAt,
      },
    });
    return result.ok;
  };

  /**
   * СНИМОК-ПРОВЕРКА ПЕРЕД РЕАЛЬНОЙ ПЕРЕДАЧЕЙ (закон П-2/П-3, 17.09.2026) — см.
   * комментарий у фильтра `firstContactAt: null` в выборке `stale` выше.
   * `firstContactAt: null` в `where` убирает основной объём на уровне SQL;
   * здесь — вторая, более медленная, но более точная проверка: клиент мог
   * вернуться (`reassignStaleReturns`) или быть тронут вручную уже ПОСЛЕ того,
   * как снимок `stale` был прочитан в начале тика, а `firstContactAt` могло
   * не проставиться на каком-то историческом пути (контакт всё равно виден по
   * `lastAgentAttemptAt`/`contactAttempts`). Возвращает `true`, если контакт
   * уже был — в этом случае вызывающий обязан эскалировать, а не передавать.
   */
  const escalateIfAlreadyContacted = async (
    lead: { id: string; fullName: string; shortId: number | null; assignedAgentId: string | null; assignedAt: Date },
    mechanism: string
  ): Promise<"escalated" | "gone" | false> => {
    const snapshot = await loadOwnershipSnapshot(lead.id);
    if (!snapshot || !hasContactAttempt(snapshot)) return false;
    /**
     * Метка `escalatedAt` — тем же захватом по снимку, что и у остальных веток:
     * лид вне круга с этой минуты, иначе каждый тик снова брал бы его в выборку
     * и снова «эскалировал». Приняли, пока шла проверка, — эскалировать нечего.
     */
    const marked = await prisma.client.updateMany({
      where: {
        id: lead.id,
        acceptedAt: null,
        escalatedAt: null,
        assignedAgentId: lead.assignedAgentId,
        assignedAt: lead.assignedAt,
      },
      data: { escalatedAt: new Date() },
    });
    if (marked.count === 0) return "gone";
    await escalateInsteadOfTransfer({
      clientId: lead.id,
      mechanism,
      reason: "клиент уже был на связи (контакт состоялся) — карусель «не принял» не передаёт его дальше, хотя формально не принят",
    });
    return "escalated";
  };

  /** Royal Score: агент промолчал — не принял и не отклонил (голосовое владельца
   *  12.08.2026: «пуш пришёл, он ничего не сделал»). Начисляется ТОЛЬКО после
   *  успешного захвата (аудит №4): раньше штраф писался до действия, и агенту,
   *  который на самом деле успел принять лид, оставался незаслуженный минус.
   *  sourceId привязан к конкретному циклу назначения — новый круг того же лида
   *  получит свой штраф, а не задвоит этот.
   *
   *  Вызывающий обязан ждать этот промис (27.08.2026): без await запись в базу
   *  оставалась висеть после того, как reassignStaleLeads() уже вернул управление
   *  — редкий, но настоящий race. Крон это не замечал (следующий тик просто
   *  видел событие с опозданием), а тест на идемпотентность sourceId иногда ловил
   *  гонку напрямую: второй тик успевал начаться раньше, чем первая запись
   *  долетала до базы. */
  // Календарь выходных держателя — по разу на агента за тик (без N+1 по лидам).
  const calendars = new Map<string, Promise<DaysOffCalendar>>();
  const calendarOf = (agentId: string) => {
    let cal = calendars.get(agentId);
    if (!cal) calendars.set(agentId, (cal = loadDaysOffCalendar(agentId)));
    return cal;
  };
  const penalizeIgnored = async (lead: (typeof stale)[number]) => {
    /**
     * СРОК ИСТЁК НОЧЬЮ — ШТРАФА НЕТ (владелец 23.09.2026, ПР-000453). Лид,
     * выданный в 20:55, «истекает» в 21:10, когда круг уже стоит до утра
     * (staleLeadCircleOpen). Утром он уходит следующему агенту, но
     * вечерний держатель не «промолчал»: его четверть часа съела ночь.
     */
    // «Во время остановки» = вне часов раздачи И раньше начала текущего
    // рабочего отрезка. Вторая половина условия держит правило честным и при
    // прямом вызове вне часов (тесты): там срок «сегодня вечером» — не ночь.
    const deadline = new Date(lead.assignedAt.getTime() + minutes * 60_000);
    const expiredWhileStopped =
      !isWithinDushanbeWindow(hours.start, hours.end, deadline) && deadline < dushanbePrevOccurrence(hours.start, now);
    if (expiredWhileStopped) return;
    // СРОК ИСТЁК В ВЫХОДНОЙ ДЕРЖАТЕЛЯ — ШТРАФА НЕТ (владелец 11.10.2026): общий выходной
    // или личный агента. Наказание за нерабочий день ломает доверие к системе.
    if (isDayOff(deadline, await calendarOf(lead.assignedAgentId!))) return;
    return recordScoreEvent({
      agentId: lead.assignedAgentId!,
      kind: "lead_ignored",
      delta: points.lead_ignored,
      reason: `Не принял и не отклонил за ${minutes} мин: ${lead.fullName}`,
      sourceId: `lead-ignored-${lead.id}-${lead.assignedAgentId}-${lead.assignedAt.getTime()}`,
    });
  };

  for (const lead of stale) {
    try {
      // Кто уже не принял этот лид — карусель к ним не возвращается (текущий агент
      // тоже «не принял», раз лид снова протух у него на руках).
      const tried = Array.isArray(lead.triedAgentIds) ? (lead.triedAgentIds as string[]) : [];
      const triedNow = tried.includes(lead.assignedAgentId!) ? tried : [...tried, lead.assignedAgentId!];
      const leadKind = lead.kind === "SELLER" ? "SELLER" : "BUYER";
      // ОТКАЗАВШИЕСЯ ОТ ЛИДА — НАВСЕГДА (ПР-000477, 25.09.2026, см. шапку
      // Client.declinedAgentIds). В отличие от triedNow, этот список не
      // сбрасывается ни одним из подборов ниже — ни при полном круге карусели
      // (carouselExhausted), ни при рестарте на держателя.
      const declined = Array.isArray(lead.declinedAgentIds) ? (lead.declinedAgentIds as string[]) : [];
      const withDeclined = (ids: string[]) => [...new Set([...ids, ...declined])];

      /**
       * ПОТОЛОК КАРУСЕЛИ (аудит владения 11.09.2026, дыра №4,
       * `docs/ownership-audit-11-09.md`). Раньше при leadEscalationEnabled=false
       * (режим обучения, владелец 19.08.2026) лид крутился между агентами
       * бесконечно — leadEscalateAfter вообще не читался. Больше кругов, чем
       * агентов в очереди, ничего не даёт (все уже видели лид), а руководитель
       * обязан узнать о зависшей заявке независимо от режима обучения — потолок
       * теперь считается от числа реально доступных агентов, а не от настройки.
       */
      const carouselExhausted = lead.reassignCount >= availableAgentsCount;

      /**
       * ПРОСРОЧКА СВОЕГО ЛИДА АГЕНТОМ ОБЪЕКТА (Пачка 1 п.6, 11.09.2026; уточнено
       * П-13, 18.09.2026): владелец — «НЕ переназначать автоматически»; ДВЕ
       * ступени, не одна: «сначала напоминание хозяину, при продолжающемся
       * молчании — эскалация руководителю». Обычная карусель ниже отдала бы
       * клиента следующему по очереди KPI — постороннему для этого объекта
       * агенту, а именно так лид «уходил без логичной причины» (86% случаев за
       * 30 дней, `docs/audit/recon-17-09/06-chats-misrouting-30d.md` §3) —
       * правда, не из-за автоматики, а из-за РУЧНОГО `LEAD_ASSIGN` директора
       * сразу по первому сигналу «эскалация». Раздельные ступени с задержкой
       * дают хозяину реальный второй шанс до того, как руководитель об этом
       * вообще узнает: первый тик после 15 мин — только напоминание агенту,
       * сигнал руководителю уходит лишь если агент молчит ЕЩЁ minutes спустя.
       * Действует независимо от leadEscalationEnabled — режим обучения тоже не
       * должен крутить чужого клиента по чужим объектам.
       */
      if (lead.ownPropertyLead) {
        if (!lead.ownPropertyReminderSentAt) {
          // Ступень 1: только напоминание хозяину, без эскалации и без штрафа —
          // агент ещё не «промолчал», ему только что напомнили в первый раз.
          const claimed = await claimLead(
            lead,
            lead.assignedAgentId, // агент объекта остаётся — эскалации ещё нет
            { ownPropertyReminderSentAt: new Date() },
            `Клиент по вашему объекту не принят за ${minutes} мин — напоминание хозяину, эскалация только при продолжающемся молчании`,
            "reassignment.ownPropertyRemind",
            lead.assignedAgentId!
          );
          if (!claimed) continue;
          sendPushToAgent(lead.assignedAgentId!, {
            title: "⏰ Клиент по вашему объекту ждёт",
            body: `${lead.fullName} — примите заявку, автоматической передачи другому агенту не будет`,
            url: `/clients/${lead.shortId}`,
            tag: `lead-${lead.id}`,
          }).catch((err) => console.error("[push] напоминание о лиде по своему объекту:", err));
          continue;
        }

        // Ступень 2: напоминание уже отправлено — эскалируем, только если с
        // него прошло ещё не меньше minutes (тот же интервал, что и до первого
        // напоминания — простое и предсказуемое правило, без отдельной настройки).
        const sinceReminderMs = now.getTime() - lead.ownPropertyReminderSentAt.getTime();
        if (sinceReminderMs < minutes * 60_000) continue;

        const claimed = await claimLead(
          lead,
          lead.assignedAgentId, // агент объекта остаётся — только эскалация
          { escalatedAt: new Date() },
          `Клиент по вашему объекту не принят за ${minutes * 2} мин (напоминание было) — переназначить автоматически нельзя, ждём решения руководителя`,
          "reassignment.ownPropertyEscalate",
          lead.assignedAgentId!
        );
        if (!claimed) continue;
        await penalizeIgnored(lead);
        escalated++;
        // Руководству — в колокольчик и на дашборд, без звонка телефона
        // (владелец 20.09.2026, см. lib/notifications.ts::notifyFeedOnly).
        await notifyFeedOnly(supervisors, {
          kind: "lead",
          title: "Лид по объекту не принят вовремя",
          body: `${lead.fullName}: хозяин объекта не принял заявку за ${minutes * 2} мин — переназначить может только руководитель`,
          url: `/clients/${lead.shortId}`,
          tag: `lead-escalated-${lead.id}`,
        });
        continue;
      }

      /**
       * КАРУСЕЛЬ НЕ ОСТАНАВЛИВАЕТСЯ И НЕ БУДИТ РУКОВОДИТЕЛЯ ПРОСТО ПОТОМУ, ЧТО
       * ПОДРЯД НЕСКОЛЬКО АГЕНТОВ НЕ УСПЕЛИ (владелец 17.09.2026, дословно: «даже
       * если клиента никто не принял — не надо, пусть крутится, может кто-то да
       * и примет»). Раньше здесь стояла эскалация руководителю после escalateAfter
       * кругов ИЛИ когда карусель прошла всех доступных агентов — оба случая
       * теперь просто идут на новый круг: полный круг (`carouselExhausted`)
       * сбрасывает список уже предложенных агентов и пробует заново, вместо того
       * чтобы останавливаться. Единственный случай, когда лид всё-таки уходит
       * руководителю, — когда агентов, принимающих лиды, не осталось ВООБЩЕ ни
       * одного (авария, а не «пара агентов проспала пуш»).
       */
      const contacted = await escalateIfAlreadyContacted(lead, "reassignment.stale");
      if (contacted) {
        if (contacted === "escalated") {
          await penalizeIgnored(lead);
          escalated++;
        }
        continue;
      }

      /**
       * НОВЫЙ КРУГ НЕ ВКЛЮЧАЕТ ТЕКУЩЕГО ДЕРЖАТЕЛЯ (23.09.2026, ПР-000453: лид
       * каждые 16 минут «переназначался» Сурайё от неё же самой). Раньше список
       * пробованных здесь очищался целиком, и подбор без исключений возвращал
       * того, у кого лид только что истёк: при «По кругу» — если остальные
       * агенты отсеяны паузой после «Неактивных», при «Честной очереди» —
       * новичка с наименьшей загрузкой. Держатель остаётся в списке, и если
       * кроме него отдать некому, ниже срабатывает эскалация руководителю — та
       * же, что для единственного кандидата-держателя (22.09.2026).
       */
      if (carouselExhausted) {
        triedNow.length = 0;
        triedNow.push(lead.assignedAgentId!);

        /**
         * ОДИН СИГНАЛ РУКОВОДИТЕЛЮ НА ПОЛНЫЙ КРУГ, КАРУСЕЛЬ НЕ ОСТАНАВЛИВАЕТСЯ
         * (решение владельца, разбор ПР-000477, 25.09.2026). `carouselExhausted`
         * остаётся истинным на каждом следующем тике (reassignCount только растёт),
         * поэтому без проверки «уже уведомляли» колокольчик обновлялся бы каждые
         * пять минут вечно — тот же приём, что и у `remindEscalatedLeads` ниже в
         * этом файле (проверка по тегу перед отправкой). Тег постоянный и не несёт
         * номера круга — один раз на лид, а не на каждый новый оборот.
         */
        const fullCircleTag = `lead-full-circle-${lead.id}`;
        const alreadyNotifiedFullCircle = await prisma.notification.findFirst({
          where: { tag: fullCircleTag },
          select: { id: true },
        });
        if (!alreadyNotifiedFullCircle) {
          await notifyFeedOnly(supervisors, {
            kind: "lead",
            title: "Лид прошёл всех агентов",
            body: `${lead.fullName}: никто не принял за полный круг — назначьте вручную, карусель продолжает крутиться`,
            url: `/clients/${lead.shortId}`,
            tag: fullCircleTag,
          });
        }
      }
      let nextAgentId = await pickAgentForLead(withDeclined(triedNow), leadKind);

      /**
       * НОВЫЙ КРУГ СЧИТАЕТСЯ ПО СПИСКУ УЖЕ ПРОБОВАННЫХ, А НЕ ПО reassignCount
       * (починено 20.09.2026; правило владельца 17.09.2026 «пусть крутится» —
       * см. комментарий выше).
       *
       * `carouselExhausted` выше сравнивает `reassignCount` с числом доступных
       * агентов — и ошибается на единицу: САМОЕ ПЕРВОЕ назначение агента уже
       * делает его «пробованным», но `reassignCount` не увеличивает. При двух
       * агентах после одного переназначения в `triedAgentIds` лежат оба, а
       * `reassignCount` равен всего единице — потолок «1 >= 2» не срабатывает,
       * список пробованных не сбрасывается, `pickAgentForLead` исключает
       * ВСЕХ и возвращает null. Дальше лид уходил руководителю с текстом
       * «свободных агентов, принимающих лиды, не осталось вовсе» — при живых и
       * свободных агентах. Ровно тот случай, который владелец запретил: пара
       * агентов проспала пуш, а карусель встала и разбудила руководителя.
       *
       * Поэтому пустой подбор сам по себе ещё не «некому отдать»: если кого-то
       * исключал список пробованных — сбрасываем его и пробуем заново: сначала
       * любой, кроме текущего держателя, и лишь если в очереди вообще один
       * агент — он же. Эскалация
       * остаётся только на настоящий тупик: пустая очередь при пустом списке
       * исключений.
       */
      if (!nextAgentId && triedNow.length > 0) {
        const restarted = await pickAgentForLead(withDeclined([lead.assignedAgentId!]), leadKind);
        if (restarted) {
          triedNow.length = 0;
          triedNow.push(lead.assignedAgentId!);
          nextAgentId = restarted;
        } else {
          const onlyOne = await pickAgentForLead(withDeclined([]), leadKind);
          /**
           * ЕДИНСТВЕННЫЙ КАНДИДАТ — ТЕКУЩИЙ ДЕРЖАТЕЛЬ (22.09.2026). Без этой
           * проверки лид «переназначался» сам себе: держателю уходил пуш
           * «🤝 Лид переназначен вам» от него же, счётчик передач рос без конца,
           * а до эскалации руководителю дело не доходило никогда — карусель
           * молча крутилась вхолостую. Тот же тупик, для которого этот файл
           * заводит эскалацию ниже (агентов, принимающих лиды, не осталось), —
           * держатель как единственный кандидат не отличается от их отсутствия.
           */
          if (onlyOne && onlyOne !== lead.assignedAgentId) {
            triedNow.length = 0;
            nextAgentId = onlyOne;
          }
        }
      }

      if (!nextAgentId) {
        /**
         * ДВА РАЗНЫХ ДИАГНОЗА — ДВА РАЗНЫХ ТЕКСТА (ПР-000477, 25.09.2026, тот же
         * приём, что уже применён в firstCall.ts у `escalationReason`). «Некому
         * отдать» — это НЕ то же самое, что «агентов не осталось вовсе»: отдать
         * действительно некому и тогда, когда все доступные агенты, кроме
         * держателя, УЖЕ ОТКАЗАЛИСЬ от этого самого лида (declinedAgentIds).
         * Прежний безусловный текст «свободных агентов… не осталось» в этом
         * случае был бы неправдой — агенты есть, просто все отказались.
         */
        const allDeclined =
          declined.length > 0 && !(await pickAgentForLead(withDeclined([lead.assignedAgentId!]), leadKind));
        const escalationReason = allDeclined
          ? "Все доступные агенты отказались от лида — эскалация руководителю, требует внимания"
          : "Свободных агентов, принимающих лиды, не осталось вовсе — эскалация руководителю, требует внимания";
        const escalationNotifyBody = allDeclined
          ? `${lead.fullName}: все доступные агенты отказались от лида — назначьте вручную`
          : `${lead.fullName}: свободных агентов, принимающих лиды, не осталось — назначьте вручную`;
        const claimed = await claimLead(
          lead,
          lead.assignedAgentId, // агент не меняется — только эскалируем
          { escalatedAt: new Date() },
          escalationReason,
          "reassignment.escalate",
          // kind=OTHER исключён выше из выборки — assignedAgentId здесь всегда задан.
          lead.assignedAgentId!
        );
        // Лид приняли, пока шёл подбор — эскалировать уже нечего.
        if (!claimed) continue;
        await penalizeIgnored(lead);
        escalated++;
        // Руководству — в колокольчик и на дашборд, без звонка телефона
        // (владелец 20.09.2026, см. lib/notifications.ts::notifyFeedOnly).
        await notifyFeedOnly(supervisors, {
          kind: "lead",
          title: "Заявку некому предложить",
          body: escalationNotifyBody,
          url: `/clients/${lead.shortId}`,
          tag: `lead-escalated-${lead.id}`,
        });
        continue;
      }

      const claimed = await claimLead(
        lead,
        nextAgentId,
        { assignedAt: new Date(), reassignCount: { increment: 1 }, triedAgentIds: triedNow },
        `Лид переназначен автоматически: не принят за ${minutes} мин`,
        "reassignment.stale",
        nextAgentId
      );
      // Приняли, пока подбирался следующий агент, — лид остаётся у принявшего.
      if (!claimed) continue;
      await penalizeIgnored(lead);
      moved++;

      /**
       * sendLeadPush, А НЕ ГОЛЫЙ ПУШ (владелец 23.09.2026, разбор раздачи, пункт 8).
       * Первый агент получал лид через sendLeadPush — с кнопками «Принять» /
       * «Отклонить» и всплывающим окном новой заявки (publishLeadPending). Со
       * второго агента круг слал обычный пуш: без кнопок, и окно не всплывало, а
       * минус за «не принял» через 15 минут писался как обычно.
       *
       * ОСТАВЛЕН при чистке уведомлений 02.10.2026: это не «напоминание», а
       * предложение лида с таймером принятия — агент не в сети иначе не узнает о
       * нём и получит минус. Убрано только «📤 Карточка передана» прежнему агенту.
       */
      sendLeadPush(nextAgentId, lead.id, {
        title: "🤝 Лид переназначен вам",
        body: `${lead.fullName} — предыдущий агент не принял заявку вовремя`,
        url: `/clients/${lead.shortId}`,
        tag: `lead-${lead.id}`,
      }).catch((err) => console.error("[push] переназначение лида:", err));
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Переназначение протухшей заявки", lead.shortId, err);
    }
  }
  return { moved, escalated };
}

/**
 * ТИК КРУГА «НЕ ПРИНЯЛ ЗА N МИНУТ» — ТОЛЬКО В ЧАСЫ РАЗДАЧИ (владелец
 * 23.09.2026). Раньше круг шёл круглосуточно (cron.ts, 14.09.2026: чтобы
 * таймер на экране не «врал»), а после правила 17.09 «пусть крутится» он
 * перестал останавливаться вовсе: лид, не принятый в 20:50, всю ночь каждые
 * 15 минут будил следующего агента и штрафовал предыдущего. Настройка
 * обещает обратное: «чтобы время ответа не шло, пока агент спит». Ночью лид
 * остаётся у того, кому выдан, и его по-прежнему можно принять; в начале
 * рабочего дня круг продолжает с него (widenAfterNight).
 *
 * cron.ts зовёт эту проверку и `reassignStaleLeads` двумя вызовами, а не одной
 * обёрткой: карта продукта раскрывает вызовы из задачи по расписанию на один
 * уровень, и за обёрткой развилки круга пропали бы с карты.
 */
export async function staleLeadCircleOpen(now: Date = new Date()): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  const hours = leadHoursOf(settings);
  return isWithinDushanbeWindow(hours.start, hours.end, now);
}

/**
 * НАПОМИНАНИЙ ПО ЭСКАЛИРОВАННОМУ ЛИДУ БОЛЬШЕ НЕТ (решение владельца 02.10.2026:
 * «Эскалированный лид всё ещё не разобран» — ни пуша, ни записи в ленту).
 * Функция делала ТОЛЬКО это (никакой задачи, штрафа или отметки в карточке она
 * не создавала; дедуп жил на самой строке уведомления), поэтому тело убрано
 * целиком, вместе с запросами в БД. Сигнал руководителю в момент самой
 * эскалации («Заявку некому предложить», «Лид по объекту не принят вовремя»,
 * «Лид прошёл всех агентов») остался в `reassignStaleLeads` без изменений.
 * Экспорт и сигнатура сохранены: cron.ts и leads.ts ещё зовут функцию.
 */
export async function remindEscalatedLeads(_now: Date = new Date()): Promise<{ reminded: number }> {
  return { reminded: 0 };
}

/** Маркер в notes записи-задачи «Связаться с вернувшимся клиентом» — ключ дедупа (раз на возврат). */
const RETURN_REMINDER_MARKER = "[returnDueReminder]";

/**
 * ТАЙМЕР ВОЗВРАТА — ПЕРЕДАЧИ БОЛЬШЕ НЕТ (Р-5, закон о владении клиентом,
 * 17.09.2026, `docs/audit/lead-ownership-17-09.md` §4). Потерянный/Неактивный
 * клиент, написавший сам, идёт прежнему агенту без перераспределения (решение
 * владельца 19.08.2026 — см. resumeExistingChannelLead выше, поле
 * `returnAcceptDueAt` ставится там же). ДО 17.09.2026 не тронул за
 * `lostReturnAcceptMinutes` — лид уходил в общую очередь KPI, СБРАСЫВАЯ
 * `acceptedAt`; ровно этот путь дал 20 из 52 передач `reassignment.stale`
 * ПОСЛЕ состоявшегося разговора (§1.2 отчёта) — вернувшийся клиент, с которым
 * реально говорили, уезжал постороннему агенту тем же таймером, что и
 * свежий, никем не тронутый лид.
 *
 * ВЛАДЕЛЕЦ (Р-5, дословно): «таймер убрать; остаётся у прежнего агента, ему
 * напоминание». Таймер `returnAcceptDueAt` НЕ убран из схемы (поле остаётся —
 * без него не от чего считать «скоро уйдёт»/«прошёл срок»), убрана ТОЛЬКО
 * ПЕРЕДАЧА: по достижении срока клиент остаётся за прежним агентом, ему
 * заводится задача в делах (пуш и строка в ленте убраны 02.10.2026),
 * `acceptedAt` не трогаем вовсе.
 * Не тронул ещё `lostReturnAcceptMinutes` СВЕРХ срока — эскалация
 * руководителю (`escalateInsteadOfTransfer`, тот же общий приём, что и у
 * остального закона: клиент остаётся, решает человек).
 *
 * НАМЕРЕННО ПРОЩЕ reassignStaleLeads: один переход, не карусель — вернувшийся
 * клиент уже не «горячий вход», давить эскалацией через несколько кругов незачем.
 * «Тронул» — любое взаимодействие НЕ типа SYSTEM после returnedAt: автоматическая
 * запись о самом возврате не считается работой агента, иначе таймер снимался бы
 * тем же событием, которое его и завело.
 */
export async function reassignStaleReturns(): Promise<{ reminded: number; escalated: number; cleared: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const minutes = settings?.lostReturnAcceptMinutes ?? 120;
  /**
   * РАБОЧИЕ МИНУТЫ (решение владельца 02.10.2026, проверка B4). Срок ставится
   * в рабочих минутах (workingDueAt), и «сколько осталось»/«сколько прошло
   * после срока» здесь считаются так же — по открытым часам раздачи. Раньше
   * клиент, вернувшийся в 19:00, к первому утреннему тику был «просрочен на
   * 10 часов» и сразу уходил руководителю — без предупреждения и напоминания.
   */
  const hours = leadHoursOf(settings);
  const nowAt = new Date();

  // Предупреждение «за 25% до срока» (пуш + строка в ленте) УБРАНО — владелец
  // 02.10.2026: напоминания агенту про вернувшегося клиента не нужны. Задача в
  // делах и эскалация руководителю ниже остаются.

  const due = await prisma.client.findMany({
    where: { returnAcceptDueAt: { lte: nowAt }, deletedAt: null, assignedAgentId: { not: null } },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      returnedAt: true,
      returnAcceptDueAt: true,
      kind: true,
      lastAgentAttemptAt: true,
    },
    // Самые давние первыми: без порядка сотая карточка могла не дойти до
    // обработки никогда (аудит 23.09.2026, №22).
    orderBy: { returnAcceptDueAt: "asc" },
    take: 100,
  });
  if (due.length === 0) return { reminded: 0, escalated: 0, cleared: 0 };

  let reminded = 0;
  let escalated = 0;
  let cleared = 0;

  for (const lead of due) {
    try {
      /**
       * «ТРОНУЛ» — только запись, за которой стоит живой агент, а не автоматика.
       *
       * НАЙДЕНО АДВЕРСАРИАЛЬНОЙ ПРОВЕРКОЙ 21.08.2026: `type: { not: "SYSTEM" }`
       * снимает таймер и на автоматических записях — clientAutoStatus.ts пишет
       * type="STATUS_CHANGE" от имени ответственного агента при автосмене статуса
       * (агент не делал ничего), а автоответчик (voicemailIngest.ts) заводит
       * type="CALL" от имени «технического автора», когда звонил САМ клиент. Оба
       * случая давали бы «агент отреагировал», хотя карточку никто не трогал —
       * ровно та лазейка, которую и должен был закрыть таймер возврата.
       *
       * STATUS_CHANGE исключаем всегда (даже ручная смена статуса — это не
       * «связался с клиентом», а клик по уже открытой карточке). Входящие звонки
       * отсеиваем тем же общим правилом, что и везде в CRM, где нужно отличить
       * работу агента от факта «клиент позвонил сам» — см. документацию
       * incomingInteractionIds (lib/telephony/incomingInteractions.ts).
       */
      let touched = 0;
      // Сообщение агента клиенту не ложится отдельной записью в хронологию — оно
      // в переписке и в отметке попытки связаться (Client.lastAgentAttemptAt).
      // Без неё агент, ответивший в чате, считался «не тронувшим» клиента
      // (аудит 23.09.2026, №22).
      if (lead.returnedAt && lead.lastAgentAttemptAt && lead.lastAgentAttemptAt > lead.returnedAt) touched = 1;
      if (!touched && lead.returnedAt) {
        const candidates = await prisma.interaction.findMany({
          where: { clientId: lead.id, createdAt: { gt: lead.returnedAt }, type: { notIn: ["SYSTEM", "STATUS_CHANGE"] } },
          select: { id: true },
        });
        if (candidates.length > 0) {
          const incoming = await incomingInteractionIds(candidates.map((c) => c.id));
          touched = candidates.filter((c) => !incoming.has(c.id)).length;
        }
      }

      if (touched > 0) {
        // Агент реально поработал с клиентом — таймер снят.
        await prisma.client.update({ where: { id: lead.id }, data: { returnAcceptDueAt: null } });
        cleared++;
        continue;
      }

      /**
       * ВТОРОЙ ПОРОГ — ЕЩЁ `minutes` (lostReturnAcceptMinutes) СВЕРХ САМОГО
       * `returnAcceptDueAt` (Р-5): агент не тронул карточку ни к первому сроку,
       * ни ещё столько же времени после напоминания — решение уходит
       * руководителю, `escalateInsteadOfTransfer` дедупит сама (раз в 24 ч).
       */
      const overdueMs = openMsBetween(lead.returnAcceptDueAt!, nowAt, hours);
      if (overdueMs >= minutes * 60_000) {
        await escalateInsteadOfTransfer({
          clientId: lead.id,
          mechanism: "reassignment.returns",
          reason: `вернувшийся клиент не тронут прежним агентом ещё ${minutes} мин после срока (Р-5) — передачи не будет, решение за руководителем`,
        });
        // Решение теперь за руководителем — таймер снят, иначе та же эскалация
        // повторялась бы раз в сутки без конца (аудит 23.09.2026, №22).
        await prisma.client.update({ where: { id: lead.id }, data: { returnAcceptDueAt: null } });
        escalated++;
        continue;
      }

      /**
       * ЗАДАЧА ПРЕЖНЕМУ АГЕНТУ ВМЕСТО ПЕРЕДАЧИ (Р-5). `acceptedAt` не трогаем —
       * клиент остаётся у того же агента. Пуш и строка в ленте УБРАНЫ (владелец
       * 02.10.2026: напоминания про вернувшегося клиента не нужны); задача в делах
       * остаётся.
       *
       * Дедуп задачи — по маркеру в notes у существующей записи Interaction не
       * старше возврата (раньше единственной отметкой была строка уведомления с
       * тегом `return-due-reminder-<id>`; без отметки задача создавалась бы на
       * каждом 5-минутном тике до самой эскалации). Новый возврат (`returnedAt`
       * свежее) заводит новую задачу.
       */
      const alreadyTasked = await prisma.interaction.findFirst({
        where: {
          clientId: lead.id,
          notes: { startsWith: RETURN_REMINDER_MARKER },
          ...(lead.returnedAt ? { createdAt: { gte: lead.returnedAt } } : {}),
        },
        select: { id: true },
      });
      if (!alreadyTasked) {
        // SYSTEM, а не держатель (П-10, 17.09.2026) — это напоминание крона, а не
        // действие агента; subjectAgentId сохраняет задачу в его списке дел.
        await logTimeline({
          clientId: lead.id,
          actor: { kind: "system", source: "reassignment.returns-reminder", subjectAgentId: lead.assignedAgentId! },
          type: "SYSTEM",
          notes: `${RETURN_REMINDER_MARKER} Вернувшийся клиент: срок ответа вышел, клиент остаётся у вас (Р-5 — автопередачи по таймеру больше нет)`,
          nextAction: "Связаться с вернувшимся клиентом",
          nextActionDate: new Date(Date.now() + 3600_000),
        });
      }
      reminded++;
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Таймер вернувшегося клиента", lead.shortId, err);
    }
  }

  return { reminded, escalated, cleared };
}

/**
 * Разбирает "утренний завал" — лиды, которые накопились без агента (созданы вне
 * рабочих часов, см. conversation.ts + createLeadFromChannel deferAssignment,
 * либо на минуту остались без агента по другой причине). Вызывается тем же
 * кроном, что и reassignStaleLeads, гейтится рабочим окном снаружи (cron.ts) —
 * поэтому первый тик после начала рабочего дня естественно разгребает всё сразу.
 * В режиме "manual" ничего не делает — там отсутствие агента осознанное,
 * руководитель назначает сам.
 */
export async function assignPendingLeads(): Promise<number> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if ((settings?.leadDistributionStrategy ?? "fair") === "manual") return 0;

  const pending = await prisma.client.findMany({
    // deletedAt — иначе утренняя волна назначала бы агентам клиентов из Корзины.
    // Фильтр по статусу не менее важен: без него волна раздавала ещё и ARCHIVED /
    // DEAL_CLOSED / UNRESPONSIVE, накопившиеся за время работы в режиме «Вручную» —
    // при переключении стратегии на «Честно» ближайший тик крона рассылал пуши
    // «Новый лид с ночи» разом по всему этому старью.
    where: {
      assignedAgentId: null,
      escalatedAt: null,
      kind: { not: "OTHER" },
      deletedAt: null,
      status: { in: ["NEW", "CONTACTED", "HOT", "COLD"] },
      // Раздел L (03.09.2026): карточка с открытой проверкой на дубль (см.
      // lib/duplicateReview.ts) намеренно без агента — не «забытая», а придержанная.
      // Без этого фильтра утренняя волна назначала бы её мимо агента, которого
      // ещё ждём с ответом «это ваш клиент?», убивая саму суть придержки.
      duplicateReviewOfClientId: null,
      /**
       * Карточка, предложенная прежнему агенту (возврат из Корзины или из
       * «Неактивных», lib/reactivationOffers.ts), тоже без агента НАМЕРЕННО:
       * ждём его «беру / не беру». Волна не ждала ответа и отдавала её другому,
       * а потом решение прежнего агента передавало карточку ещё раз (владелец
       * 23.09.2026, разбор раздачи, пункт 7). Не принял за
       * reactivationOfferTtlHours — expireStaleReactivationOffers раздаёт сам.
       */
      reactivationOfferedToAgentId: null,
      // A committed new-only customer intake has a required policy job. The
      // morning wave must not outrun fuzzy/requested-agent/OTHER decisions.
      customerIntakeActionId: null,
    },
    // Потолок на проход: очередь разгребается за несколько тиков, а не одним
    // залпом пушей, если записей накопились сотни. Самые давние — первыми
    // (№173 ночной проверки 24.09): без порядка срез был случайным.
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      requestedPropertyId: true,
      requirementsNotes: true,
      // Объект, по которому лид уже был отдан хозяину (P0-5, 10.10.2026) — см. waveProperty ниже.
      matchedPropertyId: true,
      assignReason: true,
    },
  });

  /**
   * ВОЛНА ЗНАЕТ ПЕРЕПИСКУ ЛИДА (P0-5, 10.10.2026). Шаг «бот показывал / клиент
   * прислал объект» (assignment.ts::pickByShownProperty) ищет след и по карточке, и
   * по паре «канал + собеседник» — а волна передавала только карточку, и пересланный
   * пост, записанный до появления карточки, утром не находился. Один запрос на всю
   * пачку, не по разу на лид.
   */
  const conversations = pending.length
    ? await prisma.botConversation.findMany({
        where: { clientId: { in: pending.map((p) => p.id) } },
        select: { clientId: true, channel: true, subscriberId: true, endpointScopeId: true },
        orderBy: { lastMessageAt: "desc" },
      })
    : [];
  const conversationOf = new Map<string, { channel: string; subscriberId: string; endpointScopeId: string | null }>();
  for (const c of conversations) if (c.clientId && !conversationOf.has(c.clientId)) conversationOf.set(c.clientId, c);

  let assigned = 0;
  /**
   * «АГЕНТОВ НЕТ ВООБЩЕ» ПРОВЕРЯЕТСЯ ОДИН РАЗ, А НЕ ПЕРВЫМ ЖЕ ЛИДОМ
   * (22.09.2026). Ниже стоял `break` с объяснением «нет активных агентов вообще
   * — остальные тоже не назначим»: рассуждение верное только для этой одной
   * причины. `assignAgentForLead` возвращает null и по причинам, СВОЙСТВЕННЫМ
   * ЭТОМУ лиду (предел активных заявок у подходящих агентов, отсев по своему
   * объекту, cooldown), — и тогда `break` обрывал всю утреннюю волну на первой
   * такой карточке: остальные лиды ночи ждали следующего тика, а при той же
   * карточке впереди — и следующего, и утра целиком.
   */
  const acceptingAgents = await prisma.agent.count({ where: acceptingLeadsWhere() });
  if (acceptingAgents === 0) return 0;
  for (const lead of pending) {
    try {
      // Правило «свой объект» работает и здесь: лид, пролежавший ночь, не должен
      // терять хозяина подходящего объекта только потому, что пришёл в неурочный час.
      //
      // Объект, названный ночью (Client.requestedPropertyId), и текст обращения со
      // ссылкой на пост Instagram — те же основания, что днём (24.09.2026): раньше
      // волна их не передавала, и названный объект утром терялся.
      //
      // Лид, снятый с хозяина объекта в очередь (заморозка, отключение учётки), объект
      // не теряет (P0-5, 10.10.2026): раньше волна знала только ночной
      // requestedPropertyId, и такой лид уходил по очереди постороннему. Объект
      // берётся, только если лид был отдан по ПРЯМОМУ указанию на него; совпадение
      // по описанию (own_property_match) шаг совпадения пересчитает сам.
      const conversation = conversationOf.get(lead.id);
      const assignment = await assignAgentForLead({
        clientId: lead.id,
        kind: lead.kind === "SELLER" ? "SELLER" : "BUYER",
        propertyId: waveProperty(lead),
        inquiryText: lead.requirementsNotes,
        ...(conversation ? { channel: conversation.channel, recipientId: conversation.subscriberId, endpointScopeId: conversation.endpointScopeId } : {}),
      });
      const agentId = assignment.agentId;
      // Этому лиду агента не нашлось — соседним это не приговор (см. проверку
      // acceptingAgents выше): идём дальше по очереди.
      if (!agentId) continue;

      const moved = await changeClientAgent({
        clientId: lead.id,
        toAgentId: agentId,
        reason: "Лид назначен утренней волной распределения (поступил вне рабочих часов)",
        actorId: null,
        interactionAgentId: agentId,
        source: "reassignment.wave",
        data: { assignedAt: new Date() },
        // Пока подбирали агента, руководитель мог нажать «Взять себе» или отдать
        // лида руками — волна не переписывает это молча (аудит 23.09.2026, №23).
        guardWhere: { assignedAgentId: null, customerIntakeActionId: null },
      });
      /**
       * РЕЗУЛЬТАТ ЗАПИСИ ПРОВЕРЯЕТСЯ (22.09.2026). Раньше `await` стоял без чтения
       * `ok`, а дальше безусловно шли причина назначения, счётчик и пуш. Запись
       * отказывает штатно: карточка ушла в Корзину, кто-то успел первым (гонка
       * guardWhere), закон П-3 заменил передачу эскалацией — и во всех трёх
       * случаях агент получал пуш «🔔 Новый лид с ночи» о лиде, которого у него
       * нет, а `assignReason`/`ownPropertyLead` ложились на карточку без
       * назначения. Рядом, в reassignStaleLeads, тот же вызов давно обёрнут в
       * claimLead с `if (!claimed) continue` — здесь этой половины не хватало.
       */
      if (!moved.ok) continue;
      await recordAssignReason(lead.id, agentId, assignment);
      assigned++;

      sendLeadPush(agentId, lead.id, {
        title: "🔔 Новый лид с ночи",
        body: `${lead.fullName} — примите заявку`,
        url: `/clients/${lead.shortId}`,
        tag: `lead-${lead.id}`,
      }).catch((err) => console.error("[push] утренняя волна:", err));
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Утренняя раздача заявки", lead.shortId, err);
    }
  }
  return assigned;
}

/** Причины, при которых объект на карточке назван клиентом прямо (не догадка по описанию). */
const DIRECT_PROPERTY_REASONS = new Set(["own_property_explicit", "own_property_shown", "instagram_post_link"]);

/** Объект для утренней волны: названный ночью, иначе тот, по которому лид уже отдавали хозяину. */
export function waveProperty(lead: {
  requestedPropertyId: string | null;
  matchedPropertyId: string | null;
  assignReason: string | null;
}): string | undefined {
  if (lead.requestedPropertyId) return lead.requestedPropertyId;
  if (lead.matchedPropertyId && DIRECT_PROPERTY_REASONS.has(lead.assignReason ?? "")) return lead.matchedPropertyId;
  return undefined;
}
