import { prisma } from "../../db.js";
import { OCCUPIES_SLOT_WHERE, activeLeadCounts, loadLeadLimits, slotsTaken } from "../../lib/leadLimits.js";
import { agentsInCooldown } from "../../lib/inactiveTrafficLight.js";
import { agentsOnShowingOrCall, agentsWithUncalledAcceptedLead } from "../../lib/agentOccupancyShield.js";
import { dushanbeStartOfToday } from "../../lib/dushanbeTime.js";
import { LEAD_RECEIVING_ROLES, dushanbeWeekday } from "@royal-home/shared";

/**
 * Кому система вправе выдать новый лид прямо сейчас.
 *
 * Одним фрагментом на все места выбора агента: и честная очередь, и передача
 * горячего клиента сильнейшему. Разойтись им нельзя — иначе агент, выключивший
 * приём лидов, всё равно получал бы отказных клиентов, то есть самых сложных
 * (см. lib/agentAvailability.ts).
 *
 * ЛИЧНЫЙ ВЫХОДНОЙ (владелец 11.10.2026) — как пауза приёма: в свой день недели
 * (Agent.weeklyDaysOff, по Душанбе) агент новых ЧУЖИХ лидов не получает, их раздают тем,
 * кто на смене. Это фильтр только ВЫДАЧИ: закреплённые клиенты остаются за агентом,
 * переназначений из-за выходного нет (закон о владении), а шаги «свой объект»,
 * «клиент назвал агента» и «вернувшийся клиент» (assignment.ts, requestedAgent.ts,
 * returningClientRouting.ts) этим фрагментом не пользуются и выходного не видят —
 * намеренно. Общие выходные компании (Settings.companyDaysOff) раздачу не останавливают:
 * в зашитое воскресенье до 11.10 лиды тоже раздавались.
 */
export function acceptingLeadsWhere(now: Date = new Date()) {
  return {
    // Автораспределение: только LEAD_RECEIVING_ROLES (руководитель продаж лиды не получает).
    role: { in: [...LEAD_RECEIVING_ROLES] },
    isActive: true,
    frozenAt: null,
    OR: [{ leadsPausedUntil: null }, { leadsPausedUntil: { lte: now } }],
    NOT: { weeklyDaysOff: { has: dushanbeWeekday(now) } },
  };
}

/**
 * ЗДЕСЬ БЫЛ ОТСЕВ АГЕНТОВ С НЕЗАПОЛНЕННЫМ ИТОГОМ — выдача новых лидов
 * прекращалась, пока агент не отчитается в обязательном окне.
 *
 * Механизм окон удалён 13.09.2026 (владелец: «вообще убери»), а на паузе он
 * стоял с 08.09.2026 — то есть отсев и так уже пять дней не срабатывал ни разу.
 * Убран целиком, а не оставлен «на всякий случай»: правило, которое ничего не
 * проверяет, но выглядит работающим, дороже отсутствующего.
 */

// Условие жёсткого лимита (OCCUPIES_SLOT_WHERE) и сам подсчёт живут в
// lib/leadLimits.ts: то же число нужно дашборду и карточке агента, а три копии
// одного фолбэка уже разъехались однажды (в коде 5, в схеме 6).

/**
 * КОГДА АГЕНТУ ПОСЛЕДНИЙ РАЗ ДОСТАЛСЯ ЛИД — тай-брейк «кому дольше всех не
 * назначали» у всех очередей (round_robin, fair, kpi, кольца передачи).
 *
 * Раньше это был только max(assignedAt) по клиентам, которые у агента СЕЙЧАС.
 * Лид, который агент не принял, уходит дальше по кругу — и вместе с ним
 * пропадал след того, что очередь агента уже подходила: он снова оказывался
 * первым и получал следующий лид, а тот, кто принимает, уходил в конец
 * (владелец 23.09.2026, разбор ПР-000453: «По кругу» работало как «по кругу
 * среди тех, кто не берёт»). Теперь в расчёт идёт и журнал смены владельца
 * (`CLIENT_AGENT_CHANGE`, пишет changeClientAgent):
 *  - лид передан агенту (toAgentId) — даже если потом ушёл от него;
 *  - лид ушёл от агента кругом раздачи: не принял, отклонил, не позвонил
 *    (fromAgentId + источник reassignment./firstCall./decline.) — это покрывает
 *    и первую выдачу, записанную мимо changeClientAgent (intake).
 * Журнал берётся за LAST_OFFER_LOOKBACK_DAYS: очереди важен только порядок
 * между агентами, а старше недели решает прежний max(assignedAt).
 */
const LAST_OFFER_LOOKBACK_DAYS = 7;

async function lastAssignedById(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const since = new Date(Date.now() - LAST_OFFER_LOOKBACK_DAYS * 24 * 3600_000);
  const [lastAssigned, offered] = await Promise.all([
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      // Клиент из Корзины не должен отодвигать агента в конец очереди: удалённая
      // заявка — это не работа, которую ему выдали.
      where: { assignedAgentId: { in: ids }, deletedAt: null },
      _max: { assignedAt: true },
    }),
    prisma.$queryRaw<{ agentId: string; at: Date }[]>`
      SELECT t."agentId", MAX(t."createdAt") AS at FROM (
        SELECT meta->>'toAgentId' AS "agentId", "createdAt" FROM "AuditLog"
        WHERE action = 'CLIENT_AGENT_CHANGE' AND "createdAt" >= ${since}
          AND meta->>'toAgentId' = ANY(${ids})
        UNION ALL
        SELECT meta->>'fromAgentId' AS "agentId", "createdAt" FROM "AuditLog"
        WHERE action = 'CLIENT_AGENT_CHANGE' AND "createdAt" >= ${since}
          AND meta->>'fromAgentId' = ANY(${ids})
          AND (meta->>'source' LIKE 'reassignment.%' OR meta->>'source' LIKE 'firstCall.%' OR meta->>'source' LIKE 'decline.%')
      ) t
      GROUP BY t."agentId"`,
  ]);
  // where: {in: ids} гарантирует непустые ключи — фильтр только чтобы успокоить типы Prisma.
  const byId = new Map(
    lastAssigned
      .filter((l): l is typeof l & { assignedAgentId: string } => l.assignedAgentId !== null)
      .map((l) => [l.assignedAgentId, l._max.assignedAt?.getTime() ?? 0])
  );
  for (const o of offered) {
    const at = new Date(o.at).getTime();
    if (at > (byId.get(o.agentId) ?? 0)) byId.set(o.agentId, at);
  }
  return byId;
}

/**
 * Выбирает агента для нового лида по алгоритму из Настроек (Settings.leadDistributionStrategy):
 * - fair (по умолчанию) — наименьшая активная нагрузка, при равенстве честная очередь.
 * - round_robin — строго по кругу (кому дольше всех не назначали, без учёта нагрузки).
 * - random — случайный агент из активных.
 * - manual — не назначает автоматически (возвращает null, лид ждёт руководителя).
 * - kpi — среди агентов с KPI не ниже kpiMinThreshold, взвешенно по величине KPI
 *   (чем выше KPI — тем выше шанс получить лид); если после отсева никого не
 *   осталось, откатывается на fair среди ВСЕХ активных агентов (лид не должен
 *   зависать без исполнителя просто потому, что у всех временно низкий KPI).
 * Никто не выбирает клиентов руками — распределение только по этим правилам.
 */
/**
 * Передача «горячего» клиента (отказ/«Итог объекта»/Royal Score) следующему
 * агенту в очереди — решение владельца 04.08.2026: не «самому сильному» одному
 * и тому же (пункт спецификации «Путь продавца»/Royal Score, «распределение по
 * KPI»), а очередь с приоритетом по KPI. Заменяет прежний `pickStrongestAgent`
 * (просто максимум KPI без круговорота — при высоком KPI один агент получал
 * ВСЕ передачи подряд).
 *
 * Алгоритм: агенты группируются по KPI-«уровню» (округление вниз до кратного
 * `kpiTierSize`, по умолчанию 10 — то есть 91 и 97 в одном уровне, 89 в
 * соседнем), внутри уровня — честная очередь (кому дольше всех не назначали).
 * Уровень выше — приоритет выше: агент с KPI 95 в очереди впереди любого с KPI
 * 85, даже если тому не назначали давно. null KPI = 100 (новичка без истории
 * не наказываем — тот же принцип, что и везде в файле).
 */
/**
 * Общий тай-брейк «отсев → сортировка по Royal Score → кольцо внутри уровня»
 * (спецификация владельца, «Алгоритм распределения лидов», п. 2-3) — агенты
 * группируются по KPI-«уровню» (округление вниз до кратного `tierSize`,
 * например 91 и 97 в одном уровне, 89 в соседнем), внутри уровня побеждает тот,
 * кому дольше всех не назначали. Уровень выше — приоритет выше: агент с KPI 95
 * впереди любого с KPI 85, даже если тому не назначали давно. Используется и
 * при ПЕРВИЧНОМ распределении лида (`pickAgentForLead`, стратегия "kpi"), и
 * при передаче отказного/горячего клиента (`pickNextAgentByKpiQueue`) — один
 * и тот же тай-брейк, а не две разные, случайно разошедшиеся реализации.
 *
 * `tierOrder` разворачивает ТОЛЬКО порядок уровней, не трогая кольцо внутри
 * уровня: при раздаче объектов уходящего сотрудника (решение владельца
 * 11.08.2026) первым идёт агент с НИЗКИМ Royal Score — объект это не начатый
 * разговор, а материал для работы, и он нужнее тому, у кого работы мало. Кольцо
 * внутри уровня при этом обязано остаться прежним, иначе один слабый агент
 * забрал бы весь освободившийся фонд.
 */
function sortByKpiTierQueue<T extends { id: string; kpi: number | null }>(
  agents: T[],
  tierSize: number,
  lastById: Map<string, number>,
  tierOrder: "desc" | "asc" = "desc"
): T[] {
  return [...agents].sort((a, b) => {
    const tierA = Math.floor((a.kpi ?? 100) / tierSize);
    const tierB = Math.floor((b.kpi ?? 100) / tierSize);
    if (tierA !== tierB) return tierOrder === "asc" ? tierA - tierB : tierB - tierA;
    return (lastById.get(a.id) ?? 0) - (lastById.get(b.id) ?? 0); // внутри уровня — круговая очередь
  });
}

/**
 * Расставить ГОТОВЫЙ список агентов в порядке очереди по KPI.
 *
 * Тонкая обёртка над тем же тай-брейком — нужна там, где кандидаты уже отобраны
 * по другому признаку (например, все они хозяева подходящих объектов) и остаётся
 * только решить спор между ними. Копировать сортировку в такое место нельзя:
 * файл прямо выше объясняет, чем кончаются две разошедшиеся реализации одного
 * тай-брейка.
 */
export async function orderByKpiQueue(agentIds: string[]): Promise<string[]> {
  if (agentIds.length <= 1) return agentIds;
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, kpi: true },
  });
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const tierSize = Math.max(1, settings?.kpiQueueTierSize ?? 10);
  const lastById = await lastAssignedById(agentIds);
  return sortByKpiTierQueue(agents, tierSize, lastById).map((a) => a.id);
}

/**
 * Общее тело обеих очередей передачи: отбор свободных (не на паузе, не
 * замороженных, не должников по итогам) и один и тот же тай-брейк. Отличается
 * только направление уровней — см. `sortByKpiTierQueue`.
 *
 * `respectLimit` (найдено код-ревью 13.08.2026, по умолчанию false — сохраняет
 * поведение всех остальных вызывающих без изменений): при передаче раздачи
 * портфеля увольняющегося (`agentHandover.ts`) человеку ОБЯЗАН достаться клиент,
 * даже если он уже на лимите — иначе клиент просто повиснет ничьим. У «Передачи»
 * (`clientTransfer.ts`) такой необходимости нет — получатель не единственный
 * возможный, поэтому именно там лимит стоит уважать, а не просто пуш-уведомлять
 * постфактум, как раньше.
 */
async function pickByKpiQueue(
  excludeAgentIds: string[],
  tierOrder: "desc" | "asc",
  respectLimit = false
): Promise<string | null> {
  const agents = await prisma.agent.findMany({
    where: { ...acceptingLeadsWhere(), ...(excludeAgentIds.length ? { id: { notIn: excludeAgentIds } } : {}) },
    select: { id: true, kpi: true },
  });
  if (agents.length === 0) return null;
  // Должник по итогам не получает и передаваемого клиента — он сложнее обычного,
  // и отдавать его тому, кто не дописал предыдущий разговор, бессмысленно.
  let free = [...agents];
  if (free.length === 0) return null;

  if (respectLimit) {
    const limits = await loadLeadLimits();
    if (limits.activeLimit > 0) {
      const counts = await activeLeadCounts(free.map((a) => a.id));
      const underLimit = free.filter((a) => slotsTaken(counts.get(a.id), limits) < limits.activeLimit);
      // Все свободные агенты уже на лимите — лучше отдать самому свободному по
      // очереди (прежнее поведение), чем не найти вообще никого для передачи.
      if (underLimit.length > 0) free = underLimit;
    }
  }

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const tierSize = Math.max(1, settings?.kpiQueueTierSize ?? 10);
  const lastById = await lastAssignedById(free.map((a) => a.id));
  return sortByKpiTierQueue(free, tierSize, lastById, tierOrder)[0].id;
}

/**
 * КОЛЬЦО ПОЛУЧАТЕЛЕЙ ДЛЯ РАЗДАЧИ ЦЕЛОГО ПОРТФЕЛЯ (владелец 18.09.2026, дословно:
 * «по одному лиду и по кругу, неважно, в каком они разделе, начинаем с сильного»).
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ pickByKpiQueue И ЗАЧЕМ НУЖНО ОТДЕЛЬНО. Та очередь сортирует
 * сначала по УРОВНЮ Royal Score (шаг Settings.kpiQueueTierSize, по умолчанию 10) и
 * только внутри уровня крутит агентов по кругу. Для ОДНОГО лида это правильно:
 * горячий разговор достаётся сильному. Для раздачи целого портфеля — нет: если в
 * верхнем уровне один человек, крутить внутри уровня некого, и каждая итерация
 * снова выбирает его. Ровно так 16 продавцов уволенного сотрудника ушли одному
 * агенту — очередь не сломалась, она отработала как написана.
 *
 * Здесь уровней нет вовсе: агенты выстраиваются по Royal Score один раз, и карточки
 * раздаются по кругу — по одной каждому. Первым идёт сильнейший (order="desc") или
 * слабейший (order="asc", раздача объектов, решение владельца 11.08.2026).
 *
 * При равном счёте вперёд идёт тот, кому дольше не назначали, — тот же тай-брейк,
 * что у обычной очереди: одинаковые агенты не должны выстраиваться по алфавиту id.
 */
export async function receiverRingByKpi(excludeAgentIds: string[], order: "desc" | "asc"): Promise<string[]> {
  const agents = await prisma.agent.findMany({
    where: { ...acceptingLeadsWhere(), ...(excludeAgentIds.length ? { id: { notIn: excludeAgentIds } } : {}) },
    select: { id: true, kpi: true },
  });
  if (agents.length === 0) return [];
  const lastById = await lastAssignedById(agents.map((a) => a.id));
  return [...agents]
    .sort((a, b) => {
      const kpiA = a.kpi ?? 100;
      const kpiB = b.kpi ?? 100;
      if (kpiA !== kpiB) return order === "asc" ? kpiA - kpiB : kpiB - kpiA;
      return (lastById.get(a.id) ?? 0) - (lastById.get(b.id) ?? 0);
    })
    .map((a) => a.id);
}

export async function pickNextAgentByKpiQueue(excludeAgentIds: string[], respectLimit = false): Promise<string | null> {
  return pickByKpiQueue(excludeAgentIds, "desc", respectLimit);
}

/**
 * Доступен ли КОНКРЕТНЫЙ агент для лида прямо сейчас — тот же набор отсевов,
 * что несёт общая очередь (pickByKpiQueue: не на паузе, не заморожен, не
 * должник по итогам, не на лимите активных лидов), но для одного уже
 * выбранного кандидата, а не для отбора из всех.
 *
 * Нужна «Передаче по причине» (мозговой штурм 20-21.08.2026, «рубеж 2: дверь
 * передачи, которой сейчас нет» — см. lib/clientTransfer.ts): там получателя
 * называет не очередь, а конкретный признак (чей объект подходит клиенту, у
 * кого выше счёт), и после такого выбора остаётся проверить его тем же
 * критерием доступности, которым живёт вся остальная раздача, — иначе
 * получатель мог бы оказаться в отпуске, заморожен или уже на лимите.
 */
export async function isAgentAvailableForLead(agentId: string, respectLimit = false): Promise<boolean> {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, ...acceptingLeadsWhere() }, select: { id: true } });
  if (!agent) return false;
  if (!respectLimit) return true;
  const limits = await loadLeadLimits();
  if (limits.activeLimit <= 0) return true;
  const counts = await activeLeadCounts([agentId]);
  return slotsTaken(counts.get(agentId), limits) < limits.activeLimit;
}

/**
 * «Сильный по счёту» среди доступных — для передачи со сложным клиентом
 * (причина NEEDS_DIFFERENT_APPROACH, см. lib/clientTransfer.ts). В отличие от
 * обычной очереди (pickByKpiQueue), которая внутри уровня крутит агентов по
 * кругу ради равномерной нагрузки, здесь нужен буквально МАКСИМУМ Agent.kpi —
 * владелец дословно просил «сильному агенту», а не «следующему по очереди
 * среди сильных».
 */
export async function pickStrongestAvailableAgent(excludeAgentIds: string[]): Promise<string | null> {
  const agents = await prisma.agent.findMany({
    where: { ...acceptingLeadsWhere(), ...(excludeAgentIds.length ? { id: { notIn: excludeAgentIds } } : {}) },
    select: { id: true, kpi: true },
  });
  if (agents.length === 0) return null;
  const free = [...agents];
  if (free.length === 0) return null;

  const limits = await loadLeadLimits();
  let eligible = free;
  if (limits.activeLimit > 0) {
    const counts = await activeLeadCounts(free.map((a) => a.id));
    const underLimit = free.filter((a) => slotsTaken(counts.get(a.id), limits) < limits.activeLimit);
    // Все свободные уже на лимите — лучше отдать самому сильному из них (прежний
    // принцип pickByKpiQueue), чем не найти вообще никого.
    if (underLimit.length > 0) eligible = underLimit;
  }
  eligible.sort((a, b) => (b.kpi ?? 0) - (a.kpi ?? 0));
  return eligible[0].id;
}

/**
 * Кому отдать ОБЪЕКТ из портфеля уходящего сотрудника — очередь наоборот.
 *
 * Решение владельца 11.08.2026, дословно: «его объекты распределяются между
 * другими агентами начиная с тех у кого низкий KPI, а клиенты (в том числе и
 * горячие) тем у кого высокий KPI».
 *
 * Почему правила разные. Клиент — это начатый разговор: человек уже ждёт ответа,
 * и ставить его на паузу, пока в нём разбирается слабый агент, нельзя. Объект —
 * материал для работы: он ничего не ждёт, и он нужнее тому, у кого работы мало,
 * то есть как раз агенту с низким Royal Score. Это и способ дать слабому шанс
 * подняться, а не только отбирать у него.
 *
 * Всё остальное — ровно то же, что в `pickNextAgentByKpiQueue`: те же отсевы
 * (пауза «в отпуске», заморозка, долг по итогам) и то же кольцо внутри уровня.
 */
export async function pickAgentForPropertyByKpiAscending(excludeAgentIds: string[]): Promise<string | null> {
  return pickByKpiQueue(excludeAgentIds, "asc");
}

/**
 * `kind` — чей это лид. ЛИМИТ ДЕЙСТВУЕТ ТОЛЬКО НА ПОКУПАТЕЛЕЙ (владелец
 * 20.08.2026: «лимита нет на продавцов»). Подробное «почему» — в шапке
 * OCCUPIES_SLOT_WHERE (lib/leadLimits.ts).
 *
 * Умолчание "BUYER", а не «без ограничений»: забытый аргумент должен давать
 * ПРЕЖНЕЕ, более строгое поведение, а не молча открывать портфель без края.
 * Места, где приходит продавец, передают kind явно.
 */
export async function pickAgentForLead(
  excludeAgentIds?: string | string[],
  kind: "BUYER" | "SELLER" = "BUYER",
  now: Date = new Date()
): Promise<string | null> {
  const exclude = excludeAgentIds ? (Array.isArray(excludeAgentIds) ? excludeAgentIds : [excludeAgentIds]) : [];
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const strategy = settings?.leadDistributionStrategy ?? "fair";

  if (strategy === "manual") return null;

  let allAgents = await prisma.agent.findMany({
    where: { ...acceptingLeadsWhere(), ...(exclude.length ? { id: { notIn: exclude } } : {}) },
    select: { id: true, kpi: true, lastSeenAt: true },
  });
  if (allAgents.length === 0) return null;

  // ОБЯЗАТЕЛЬНЫЕ ОКНА: агент с незаписанным итогом временно вне очереди. Если
  // должны ВСЕ — правило уступает: клиент без агента хуже неидеального порядка.
  // Ровно так же ниже ведёт себя лимит активных лидов.
  const notOwing = [...allAgents];
  if (notOwing.length > 0) allAgents = notOwing;

  /**
   * «РАБОЧИЙ ДЕНЬ НАЧАЛСЯ — ЗНАЧИТ ЗАХОДИЛ СЕГОДНЯ» (владелец, разбор ПР-000477,
   * 24-25.09.2026). Маъруф не открывал CRM с 11:51, а лид доставался ему ДЕВЯТЬ
   * раз подряд — каждый раз 15 минут впустую плюс штраф lead_ignored (карусель
   * не видит разницы между «занят» и «физически не увидит уведомление»).
   *
   * МЯГКИЙ ФИЛЬТР, тем же приёмом, что и остальные ниже: если отсеет всех —
   * откатывается, клиент без агента хуже отсутствующего.
   *
   * СТОИТ ПЕРВЫМ СРЕДИ МЯГКИХ ФИЛЬТРОВ — раньше cooldown/занятости/лимита, а не
   * после них. Фильтры работают последовательно, каждый видит уже суженный
   * список предыдущего, и порядок решает исход при малом числе кандидатов: два
   * агента, один занят показом, но заходил сегодня, второй свободен, но не
   * заходил с утра, — если сначала отсеять занятых, останется только
   * отсутствующий и лид уйдёт ему; если сначала отсеять отсутствующих (как
   * здесь), из занятости выше уже выбирать не из кого — фильтр занятости сам
   * откатится, и лид получит присутствующий, хоть и занятый агент. Порядок
   * буквально воплощает правило владельца: «отсутствующий хуже занятого».
   */
  const startOfToday = dushanbeStartOfToday(now);
  const seenToday = allAgents.filter((a) => a.lastSeenAt && a.lastSeenAt >= startOfToday);
  if (seenToday.length > 0) allAgents = seenToday;

  /**
   * ПОРЯДОК ФИЛЬТРОВ НАМЕРЕННО ПОСЛЕДОВАТЕЛЬНЫЙ, А НЕ ОДНОВРЕМЕННЫЙ (уточнено
   * адверсариальной проверкой 21.08.2026). Каждый фильтр видит уже суженный
   * список от предыдущего и, если исключил бы вообще всех — откатывает себя
   * (клиент без агента хуже неидеального порядка). Из-за этого приоритет между
   * фильтрами реален: агент, отсеянный на шаге «должен итог», в шаге cooldown
   * уже не участвует, даже если сам по себе он не под cooldown. Порядок такой:
   * долг по итогам важнее cooldown важнее лимита — потому что незаписанный
   * итог означает, что агент прямо сейчас должен закрыть содержательный вопрос
   * по другому клиенту, а cooldown — просто «недавно освободился», более мягкая
   * причина подождать.
   */

  /**
   * COOLDOWN ПОСЛЕ СЛИВА (мозговой штурм 21.08.2026, «рубеж 3»): агент, только
   * что переведший клиента в Неактивные, не получает свежий лид сразу — иначе
   * слив стал бы способом ускорить получение нового клиента, ровно та лазейка,
   * которую cooldown и закрывает (см. lib/inactiveTrafficLight.ts). Уступает
   * так же, как долг по итогам и лимит: если под кулдауном все, клиент важнее.
   */
  const inCooldown = await agentsInCooldown(allAgents.map((a) => a.id));
  const notInCooldown = allAgents.filter((a) => !inCooldown.has(a.id));
  if (notInCooldown.length > 0) allAgents = notInCooldown;

  /**
   * ЩИТОК ЗАНЯТОСТИ (мозговой штурм 20-21.08.2026, «рубеж 1: вход»): агент прямо
   * сейчас на показе или ведёт живой звонок через CRM новых лидов не получает —
   * тикающий таймер на приём/звонок посреди работы и есть вероятный корень
   * случая 18.08.2026 с Нурмухаммадом (см. комментарий у
   * Settings.leadReassignOnMissedCallEnabled в schema.prisma и разбор в
   * lib/agentOccupancyShield.ts). Тот же порядок уступки, что у долга по итогам
   * и cooldown выше: если заняты все — клиент без агента хуже.
   */
  const busy = await agentsOnShowingOrCall(allAgents.map((a) => a.id));
  const notBusy = allAgents.filter((a) => !busy.has(a.id));
  if (notBusy.length > 0) allAgents = notBusy;

  /**
   * ТРЕТИЙ ПРИЗНАК ТОГО ЖЕ ЩИТКА (14.09.2026, живая проверка владельца):
   * принял лид, ещё не позвонил (окно `leadCallMinutes`) — новый лид ждёт,
   * пока агент закроет обязанность по текущему. См. разбор и происхождение
   * окна в lib/agentOccupancyShield.ts::agentsWithUncalledAcceptedLead.
   */
  const uncalled = await agentsWithUncalledAcceptedLead(allAgents.map((a) => a.id));
  const notUncalled = allAgents.filter((a) => !uncalled.has(a.id));
  if (notUncalled.length > 0) allAgents = notUncalled;

  // «Лимит активных лидов» (решение владельца 30.07, число приведено к спецификации
  // — 6 — коммитом 136adf2): агент с полным портфелем активных лидов
  // (NEW/CONTACTED/HOT) новых не получает — пусть сначала закроет текущие. Если на
  // лимите ВСЕ, лимит уступает: клиент без агента хуже перегруженного агента, и
  // дальше выбор идёт обычной стратегией по наименьшей загрузке.
  const limits = await loadLeadLimits();
  const { activeLimit } = limits;
  let agents = allAgents;
  // Продавец лимит не проверяет вовсе: он не занимает слот (OCCUPIES_SLOT_WHERE
  // считает только покупателей) и не должен из-за чужой занятости пролетать мимо
  // агента — объект нужен агентству независимо от того, сколько у человека
  // покупателей в работе.
  if (activeLimit > 0 && kind === "BUYER") {
    const countById = await activeLeadCounts(allAgents.map((a) => a.id));
    const underLimit = allAgents.filter((a) => slotsTaken(countById.get(a.id), limits) < activeLimit);
    if (underLimit.length > 0) agents = underLimit;
  }
  const ids = agents.map((a) => a.id);

  if (strategy === "random") {
    return ids[Math.floor(Math.random() * ids.length)];
  }

  if (strategy === "round_robin") {
    const lastById = await lastAssignedById(ids);
    return [...ids].sort((a, b) => (lastById.get(a) ?? 0) - (lastById.get(b) ?? 0))[0];
  }

  if (strategy === "kpi") {
    const threshold = settings?.kpiMinThreshold ?? 70;
    // Отсев (спецификация, «Алгоритм распределения лидов», п. 1-2): null = ещё не
    // считался — не штрафуем новичка без истории, пропускаем порог.
    const eligible = agents.filter((a) => (a.kpi ?? 100) >= threshold);
    if (eligible.length > 0) {
      // Сортировка по уровню Royal Score + кольцо внутри уровня (п. 2-3) — тот же
      // тай-брейк, что у передачи отказного клиента (pickNextAgentByKpiQueue),
      // а не отдельная взвешенно-случайная реализация, разошедшаяся бы с ним.
      const tierSize = Math.max(1, settings?.kpiQueueTierSize ?? 10);
      const lastById = await lastAssignedById(eligible.map((a) => a.id));
      return sortByKpiTierQueue(eligible, tierSize, lastById)[0].id;
    }
    // Никто не прошёл порог KPI — не блокируем распределение, откатываемся на fair.
  }

  // fair (по умолчанию) и откат из kpi при пустом eligible-списке.
  const [loads, lastById] = await Promise.all([
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      // deletedAt — удалённые клиенты не создают агенту реальной нагрузки, иначе
      // «справедливое» распределение обходит агента из-за записей в Корзине.
      /**
       * ЗАГРУЗКА — ТЕМ ЖЕ ПРАВИЛОМ, ЧТО ЛИМИТ И ДАШБОРД (B14, решение владельца
       * 02.10.2026): активные покупатели (OCCUPIES_SLOT_WHERE, lib/leadLimits.ts).
       * Раньше здесь считались все клиенты со статусами NEW/CONTACTED/HOT/COLD —
       * вместе с продавцами и неактивными: агент с 15 продавцами считался самым
       * загруженным и не получал лидов, хотя дашборд показывал ему свободные места.
       */
      where: { assignedAgentId: { in: ids }, deletedAt: null, ...OCCUPIES_SLOT_WHERE },
      _count: { _all: true },
    }),
    lastAssignedById(ids),
  ]);
  const loadById = new Map(loads.map((l) => [l.assignedAgentId, l._count._all]));

  const sorted = [...ids].sort((a, b) => {
    const loadDiff = (loadById.get(a) ?? 0) - (loadById.get(b) ?? 0);
    if (loadDiff !== 0) return loadDiff;
    return (lastById.get(a) ?? 0) - (lastById.get(b) ?? 0);
  });

  return sorted[0];
}
