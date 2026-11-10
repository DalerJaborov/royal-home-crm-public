import { canReadInvestigations, investigationViewerRole } from "../auth/investigations.js";
import { Router } from "express";
import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { canViewInvestigations } from "@royal-home/shared";
import { Prisma, type ClientStatus } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { loadMoneyContext, roundMoney, toTjs } from "../lib/money.js";
import { dushanbeStartOfMonth } from "../lib/dushanbeTime.js";
import { propertyOwnerWhere } from "../lib/propertyOwner.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "../lib/clientPhone.js";
import { sumPointsByAgent } from "../lib/pointsTotals.js";
import { activeLeadCounts, loadLeadLimits, NO_LEADS } from "../lib/leadLimits.js";
import { loadHotScoreThreshold } from "../lib/hotScoreThreshold.js";
import { findSellerPropertyMissing } from "../lib/sellerPropertyMissingAntifraud.js";
import { runLimited } from "../lib/concurrency.js";
import { RATED_ROLES } from "@royal-home/shared";
import { logSystemError } from "../lib/systemError.js";
import { loadStaffLive, ONLINE_WINDOW_MS } from "../lib/staffLive.js";
import {
  AGENT_LOSS_SERIES_WINDOW_MS,
  findAgentLossSeries,
  findEndlessNegotiations,
  findRefusedHighScore,
  findSilentAfterShowing,
  overdueTasksWhere,
  RECENT_EVENTS_DAYS,
  RECENT_EVENTS_MS,
  stalledClientsWhere,
} from "./oversight.js";

export const teamRouter = Router();

// Управленческий взгляд на команду — директор, админ, менеджер.
teamRouter.use(requireAuth, requirePermission("team.viewFull"));

/**
 * Потолок трёх выборок за месяц на экране «Команда» (22.09.2026, класс
 * «Пагинация»). Все три уже сужены до agentIds (максимум 500 работающих
 * агентов, см. take выше) и до текущего месяца, но само число строк ничем не
 * ограничено — компания, выросшая за месяц до тысяч взаимодействий, тянула бы
 * их одним запросом. 50 000 — с большим запасом над реальной месячной нагрузкой.
 */
const TEAM_MONTH_ROW_LIMIT = 50_000;

/** Порядок статусов на матрице «Команда по этапам» — тот же порядок, в котором
 *  enum объявлен в schema.prisma, чтобы колонки не прыгали местами между открытиями. */
const STAGE_STATUSES: ClientStatus[] = [
  "NEW",
  "CONTACTED",
  "HOT",
  "COLD",
  "UNRESPONSIVE",
  "LOST",
  "DEAL_CLOSED",
  "ARCHIVED",
];

/**
 * GET /team/stages — антифрод-экран «Команда по этапам» (мозговой штурм
 * владельца 20-21.08.2026): у какого агента сколько клиентов на каком статусе,
 * плюс сколько показов назначено и сколько сделок в работе — одним взглядом,
 * без открытия карточки каждого сотрудника.
 *
 * Три независимых groupBy вместо загрузки всех клиентов/сделок в память (как
 * делает сводка ниже за текущий месяц) — здесь считаем ЗА ВСЁ ВРЕМЯ, а не за
 * месяц, потому что «на каком этапе» — это снимок текущего портфеля, а не
 * динамика; агрегация на стороне базы дешевле, чем тянуть все строки в Node.
 */
teamRouter.get("/stages", async (req, res) => {
  const agents = await prisma.agent.findMany({
    where: { role: { in: [...RATED_ROLES] } },
    select: { id: true },
    take: 500,
  });
  const agentIds = agents.map((a) => a.id);
  if (agentIds.length === 0) {
    return res.json({ statuses: STAGE_STATUSES, agents: [] });
  }

  const [statusRows, showingRows, showingRowsBySubject, dealRows] = await Promise.all([
    prisma.client.groupBy({
      by: ["assignedAgentId", "status"],
      where: { assignedAgentId: { in: agentIds }, deletedAt: null },
      _count: { _all: true },
    }),
    // «Показов назначено» — живая задача показа: не отменена (declinedAt пуст),
    // ещё не отмечена выполненной (completedAt пуст) и остаётся в календаре
    // (nextAction не снят). Тот же смысл, что у findActiveShowing в
    // lib/showingBooking.ts, только сразу по всем агентам одним groupBy.
    prisma.interaction.groupBy({
      by: ["agentId"],
      where: {
        agentId: { in: agentIds },
        ...visibleInteractionWhere(investigationViewerRole(req)),
        type: "SHOWING",
        nextAction: { not: null },
        completedAt: null,
        declinedAt: null,
        client: { deletedAt: null },
      },
      _count: { _all: true },
    }),
    // subjectAgentId (П-10, 17.09.2026): показ, назначенный ботом/системой от
    // лица клиента (agentId: null), по-прежнему задача держателя карточки —
    // groupBy по agentId выше её теряет, складываем со второй группировкой ниже.
    prisma.interaction.groupBy({
      by: ["subjectAgentId"],
      where: {
        subjectAgentId: { in: agentIds },
        ...visibleInteractionWhere(investigationViewerRole(req)),
        agentId: null,
        type: "SHOWING",
        nextAction: { not: null },
        completedAt: null,
        declinedAt: null,
        client: { deletedAt: null },
      },
      _count: { _all: true },
    }),
    prisma.deal.groupBy({
      by: ["agentId"],
      where: { agentId: { in: agentIds }, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
      _count: { _all: true },
    }),
  ]);

  const byStatusMap = new Map<string, Record<string, number>>();
  for (const row of statusRows) {
    if (!row.assignedAgentId) continue;
    const bucket = byStatusMap.get(row.assignedAgentId) ?? {};
    bucket[row.status] = row._count._all;
    byStatusMap.set(row.assignedAgentId, bucket);
  }
  const showingsMap = new Map(showingRows.map((r) => [r.agentId, r._count._all]));
  for (const r of showingRowsBySubject) {
    if (!r.subjectAgentId) continue;
    showingsMap.set(r.subjectAgentId, (showingsMap.get(r.subjectAgentId) ?? 0) + r._count._all);
  }
  const dealsMap = new Map(dealRows.map((r) => [r.agentId, r._count._all]));

  const agentsOut = agentIds.map((id) => ({
    id,
    byStatus: byStatusMap.get(id) ?? {},
    showingsScheduled: showingsMap.get(id) ?? 0,
    dealsInProgress: dealsMap.get(id) ?? 0,
  }));

  res.json({ statuses: STAGE_STATUSES, agents: agentsOut });
});


/**
 * GET /team — сводка по каждому сотруднику за текущий месяц:
 * активность (онлайн/последний вход), лиды, взаимодействия, показы,
 * закрытые сделки, комиссия, конверсия лид→сделка, среднее время принятия лида.
 */
teamRouter.get("/", async (req, res) => {
  // Месяц — по Душанбе, а не по часовому поясу процесса (контейнер в UTC): иначе
  // сделки и лиды первых пяти часов 1-го числа уезжали в прошлый месяц.
  const startOfMonth = dushanbeStartOfMonth();
  // Комиссия месяца — только с finance.view (ночная проверка 24.09.2026, №159/М4):
  // экран открыт правом team.viewFull, которое есть и у менеджера, а деньги —
  // отдельное право, то же самое, что гейтит их в отчётах (routes/reports.ts).
  const seesMoney = can(req, "finance.view");

  /**
   * Список агентов — ОТДЕЛЬНЫМ запросом, до остальных.
   *
   * Он нужен, чтобы сузить журнал начислений баллов по своим агентам: этот
   * журнал только растёт (дозапись, см. royalScoreEvents.ts), а экран «Команда»
   * открывают постоянно — без сужения каждое открытие поднимало ВСЕ начисления
   * за всю историю агентства, включая уволенных и удалённых. Лишний обход к базе
   * дешевле растущей без предела выборки.
   */
  const agents = await prisma.agent.findMany({
    // Только работающие агентами: директор/админ/менеджер в командной статистике
    // не участвуют — им лиды не назначаются, сравнение было бы нечестным.
    where: { role: { in: [...RATED_ROLES] } },
    select: {
      id: true,
      fullName: true,
      role: true,
      isActive: true,
      avatarUrl: true,
      lastSeenAt: true,
      createdAt: true,
      frozenAt: true,
      frozenReason: true,
      frozenReasonVoiceUrl: true,
      frozenReasonVoiceTranscript: true,
      // Вид и срок отсутствия (владелец 09.09.2026): руководителю в списке команды
      // нужно не «заморожен», а «в отпуске до 20-го» — от вида зависит и то, что
      // будет с вернувшимся клиентом этого агента.
      absenceKind: true,
      absenceUntil: true,
      // Пауза приёма лидов (24.09.2026): карточка сотрудника показывает её и даёт
      // руководителю поставить или снять (routes/agents.ts, /:id/lead-pause).
      leadsPausedUntil: true,
      leadsPausedReason: true,
      leadsPausedBy: { select: { fullName: true } },
      // Личные выходные (11.10.2026) — карточка сотрудника показывает и правит их.
      weeklyDaysOff: true,
    },
    // Действующие агенты — первым блоком (владелец 19.08.2026): раньше сортировка
    // шла только по дате найма, и уволенные болтались вперемешку с работающими,
    // а не «внизу списка», где их и ждут увидеть.
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    // Потолок обязателен даже там, где агентов десяток — см. hallOfFame.ts.
    take: 500,
  });
  const agentIds = agents.map((a) => a.id);

  const [interactions, deals, clients, pointsTotals, money, loadCounts, limits] = await Promise.all([
    prisma.interaction.findMany({
      // agentId: { in } / subjectAgentId: { in } обязателен: без него выборка
      // тянула взаимодействия ВСЕЙ компании за месяц, включая руководителей и
      // уволенных, — впустую. client: { deletedAt: null } (27.08.2026) —
      // /team/stages (строка выше) этот фильтр уже имеет, а месячные показы и
      // активность считались без него: показ по клиенту из Корзины засчитывался
      // агенту как проведённый.
      //
      // subjectAgentId (П-10, 17.09.2026): запись бота/системы от лица держателя
      // карточки (agentId: null) по-прежнему его активность — иначе показатели
      // «Команды» падали ровно в тот момент, когда Б1/Б2 сделали подпись честной
      // (см. docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md). Держатель
      // сведён ниже, при разборе по вёдрам (agentId ?? subjectAgentId).
      where: {
        createdAt: { gte: startOfMonth },
        ...visibleInteractionWhere(investigationViewerRole(req)),
        type: { not: "SYSTEM" },
        OR: [{ agentId: { in: agentIds } }, { agentId: null, subjectAgentId: { in: agentIds } }],
        client: { deletedAt: null },
      },
      // nextAction + declinedAt — по этой паре отличается отменённый показ (см.
      // lib/tasks.ts, COUNTED_SHOWING_WHERE). Отсечь его запросом нельзя: выборка
      // тянет ВСЕ типы взаимодействий, а условие относится только к показам,
      // поэтому фильтруем на месте, в счётчике показов.
      select: { agentId: true, subjectAgentId: true, type: true, nextAction: true, declinedAt: true },
      take: TEAM_MONTH_ROW_LIMIT,
    }),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: startOfMonth }, agentId: { in: agentIds } },
      select: { agentId: true, commissionAmount: true, currency: true },
      take: TEAM_MONTH_ROW_LIMIT,
    }),
    prisma.client.findMany({
      where: { assignedAt: { gte: startOfMonth }, deletedAt: null, assignedAgentId: { in: agentIds } },
      select: { assignedAgentId: true, assignedAt: true, acceptedAt: true, status: true },
      take: TEAM_MONTH_ROW_LIMIT,
    }),
    // Баллы за всё время, не только за месяц, и ТОЛЬКО по агентам этого экрана:
    // начисления уволенным и удалённым в таблице всё равно не показываются, а
    // журнал только растёт. Складывает их база (одна строка на агента вместо всех
    // записей журнала в памяти) — см. lib/pointsTotals.ts.
    sumPointsByAgent(agentIds),
    loadMoneyContext(),
    /**
     * Нагрузка «сейчас» для карточки «Нагрузка» и колонки в таблице (макет
     * владельца, экран «Команда»): те же счётчик и лимит, по которым раздача
     * решает, дать ли агенту следующий лид (lib/leadLimits.ts). Считать здесь
     * иначе нельзя: полоса «у лимита, лиды не идут» обязана совпадать с тем,
     * что реально останавливает раздачу.
     */
    activeLeadCounts(agentIds),
    loadLeadLimits(),
  ]);
  if (
    interactions.length >= TEAM_MONTH_ROW_LIMIT ||
    deals.length >= TEAM_MONTH_ROW_LIMIT ||
    clients.length >= TEAM_MONTH_ROW_LIMIT
  ) {
    void logSystemError("api", `Команда: месячная выборка упёрлась в потолок ${TEAM_MONTH_ROW_LIMIT} строк`);
  }

  /**
   * ОДИН ПРОХОД ПО КАЖДОЙ ВЫБОРКЕ, А НЕ filter НА КАЖДОГО АГЕНТА (26.08.2026).
   * Прежний agents.map × interactions.filter — это O(агенты × строки): при
   * десятках тысяч взаимодействий за месяц и десятках агентов каждое открытие
   * «Команды» крутило миллионы итераций синхронного JS, блокируя event loop.
   * Теперь строки раскладываются по вёдрам за один проход.
   */
  interface MonthBucket {
    interactions: number;
    showings: number;
    deals: number;
    commission: number;
    leads: number;
    acceptedCount: number;
    acceptSumMinutes: number;
  }
  const buckets = new Map<string, MonthBucket>();
  const bucketOf = (id: string): MonthBucket => {
    let b = buckets.get(id);
    if (!b) {
      b = { interactions: 0, showings: 0, deals: 0, commission: 0, leads: 0, acceptedCount: 0, acceptSumMinutes: 0 };
      buckets.set(id, b);
    }
    return b;
  };
  for (const i of interactions) {
    const holderId = i.agentId ?? i.subjectAgentId;
    if (!holderId) continue;
    const b = bucketOf(holderId);
    b.interactions += 1;
    // Отменённый показ (нет задачи + есть отказ) агенту не засчитывается —
    // ровно как в Отчётах и на доске почёта.
    if (i.type === "SHOWING" && !(i.nextAction === null && i.declinedAt !== null)) b.showings += 1;
  }
  for (const d of deals) {
    const b = bucketOf(d.agentId);
    b.deals += 1;
    // Комиссия месяца в сомони — сделки в разных валютах иначе складывались 1:1.
    b.commission += toTjs(d.commissionAmount, d.currency, money);
  }
  for (const c of clients) {
    if (!c.assignedAgentId) continue;
    const b = bucketOf(c.assignedAgentId);
    b.leads += 1;
    if (c.acceptedAt) {
      b.acceptedCount += 1;
      b.acceptSumMinutes += (c.acceptedAt.getTime() - c.assignedAt.getTime()) / 60000;
    }
  }

  const now = Date.now();
  const team = agents.map((a) => {
    const b = buckets.get(a.id);
    return {
      id: a.id,
      fullName: a.fullName,
      role: a.role,
      isActive: a.isActive,
      avatarUrl: a.avatarUrl,
      lastSeenAt: a.lastSeenAt,
      online: !!a.lastSeenAt && now - a.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
      frozen: a.frozenAt !== null,
      // frozenAt — момент начала отсутствия (имя из main). Свой синоним
      // frozenSince не заводим: два имени одного значения расходятся молча.
      frozenAt: a.frozenAt,
      // Вид и срок (владелец 09.09.2026): руководителю в списке нужно не
      // «заморожен», а «в отпуске до 20-го».
      absenceKind: a.absenceKind,
      absenceUntil: a.absenceUntil,
      frozenReason: a.frozenReason,
      frozenReasonVoiceUrl: a.frozenReasonVoiceUrl,
      frozenReasonVoiceTranscript: a.frozenReasonVoiceTranscript,
      // Истёкшая пауза отдаётся как null: срок в прошлом ничего не значит.
      leadsPausedUntil: a.leadsPausedUntil && a.leadsPausedUntil.getTime() > now ? a.leadsPausedUntil : null,
      leadsPausedByName: a.leadsPausedBy?.fullName ?? null,
      leadsPausedReason: a.leadsPausedReason,
      weeklyDaysOff: a.weeklyDaysOff,
      points: pointsTotals.get(a.id) ?? 0,
      // Активные покупатели в работе (продавцы слот не занимают) и общий лимит;
      // лимит 0 = раздача без предела, полоса тогда не рисуется.
      activeLoad: (loadCounts.get(a.id) ?? NO_LEADS).total,
      leadLimit: limits.activeLimit,
      month: {
        leads: b?.leads ?? 0,
        interactions: b?.interactions ?? 0,
        showings: b?.showings ?? 0,
        dealsCompleted: b?.deals ?? 0,
        commission: seesMoney ? roundMoney(b?.commission ?? 0) : null,
        conversion: b && b.leads > 0 ? Math.round((b.deals / b.leads) * 100) : null,
        avgAcceptMinutes: b && b.acceptedCount > 0 ? Math.round(b.acceptSumMinutes / b.acceptedCount) : null,
      },
    };
  });

  res.json(team);
});

/**
 * Детальная карточка сотрудника для руководства (монтируется как
 * GET /agents/:id/overview, см. app.ts — файл agents.ts занят CRUD-ролями ADMIN):
 * контакты, объекты (счётчики + последние), клиенты, сделки, история KPI.
 */
/**
 * СКОЛЬКО ЗАПРОСОВ КАРТОЧКА СОТРУДНИКА ВПРАВЕ ДЕРЖАТЬ ОДНОВРЕМЕННО.
 *
 * Здесь было голое `Promise.all` на двадцать веток, и пять из них —
 * общекомандные хелперы антифрода, каждый из которых внутри делает ещё 2-4
 * запроса. Пик получался около 25 соединений на ОДИН http-запрос при пуле в 15
 * (`connection_limit=15` в docker-compose.prod.yml). Пока такая карточка
 * открыта, всё остальное в процессе — дашборд, чаты, список клиентов — стоит в
 * очереди за соединением и падает по `pool_timeout`, а снаружи это неотличимо
 * от «раздел не загрузился» (разбор 19.09.2026,
 * docs/sections-not-loading-19-09.md).
 *
 * Четыре — то же число, что у «Контроля руководителя»
 * (SUMMARY_QUERY_CONCURRENCY в routes/oversight.ts), который собирает те же
 * пять хелперов и уже давно идёт через runLimited. Приём был, сюда его просто
 * не применили.
 */
const AGENT_OVERVIEW_QUERY_CONCURRENCY = 4;

export const agentOverviewRouter = Router();
agentOverviewRouter.get("/:id/overview", requireAuth, requirePermission("team.viewFull"), async (req, res) => {
  const seesInvestigations = canReadInvestigations(req);
  const { id } = req.params;
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      role: true,
      isActive: true,
      avatarUrl: true,
      lastSeenAt: true,
      createdAt: true,
      kpi: true,
      // Внутренний номер — чтобы из карточки сотрудника можно было позвонить ему
      // через офисную АТС, а не с личного мобильного по ссылке tel:.
      sipExtension: true,
      // Заморозка/отпуск/больничный — те же поля, что отдаёт список /team
      // (см. выше): карточка одного сотрудника должна уметь то же самое
      // «Отпуск / больничный» / «Вернуть в строй», не только строка в таблице.
      frozenAt: true,
      frozenReason: true,
      frozenReasonVoiceUrl: true,
      frozenReasonVoiceTranscript: true,
      absenceKind: true,
      absenceUntil: true,
    },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });

  // Объект «его» — по единому правилу хозяина (lib/propertyOwner.ts, 28.09.2026):
  // принял → ведёт → завёл, ступенями. Раньше здесь стоял OR трёх полей, и у
  // сотрудника после передачи дел в профиле всё ещё висели «4 объекта» —
  // созданные им, но уже принятые другим; список «Мои» при этом говорил «0».
  const propertyWhere = { deletedAt: null, ...propertyOwnerWhere(id) };

  // «Проблемы» (владелец 16.09.2026, второй заход: «по-крупному, чтобы не
  // искать что где когда») — те же 5 красных флагов антифрода, что «Контроль
  // руководителя» (routes/oversight.ts), сужены на этого агента. WHERE-условия
  // и хелперы переиспользуются оттуда напрямую (export), второй копии логики
  // не заводим — тот же приём, что уже применён к findSilentAfterShowing и
  // соседям для mission-control.
  const now = new Date();
  const hotScoreThreshold = await loadHotScoreThreshold();
  // subjectAgentId ?? agentId (П-10, 17.09.2026): просроченная задача, заведённая
  // ботом/системой от лица держателя карточки (agentId: null), остаётся ЕГО
  // хвостом — тот же приём, что computeDiscipline в kpi.ts.
  const overdueTasksAgentWhere = { ...overdueTasksWhere(now), ...visibleInteractionWhere(investigationViewerRole(req)), OR: [{ agentId: id }, { subjectAgentId: id }] };
  const stalledClientsAgentWhere = { ...stalledClientsWhere(now, hotScoreThreshold), assignedAgentId: id };

  const [
    propertiesTotal,
    propertiesAvailable,
    propertiesCreated,
    lastProperties,
    clientsTotal,
    lastClients,
    dealStages,
    lastDeals,
    kpiHistory,
    flaggedSurveyCalls,
    recentInteractions,
    waitingClients,
    overdueTasksItems,
    overdueTasksTotal,
    stalledClientsItems,
    silentAfterShowing,
    refusedHighScore,
    endlessNegotiations,
    sellerPropertyMissing,
    agentLossSeries,
  ] = await runLimited(
    [
      () => prisma.property.count({ where: propertyWhere }),
      () => prisma.property.count({ where: { ...propertyWhere, status: "AVAILABLE" } }),
      () => prisma.property.count({ where: { createdById: id, deletedAt: null } }),
      () => prisma.property.findMany({
        where: propertyWhere,
        orderBy: { createdAt: "desc" },
        take: 7,
        select: { id: true, shortId: true, title: true, price: true, currency: true, status: true, createdAt: true },
      }),
      () => prisma.client.count({ where: { assignedAgentId: id, deletedAt: null } }),
      () => prisma.client.findMany({
        where: { assignedAgentId: id, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 7,
        select: {
          id: true,
          shortId: true,
          fullName: true,
          phone: true,
          status: true,
          createdAt: true,
          kind: true,
          firstContactAt: true,
          workStatus: true,
        },
      }),
      () => prisma.deal.groupBy({ by: ["stage"], where: { agentId: id }, _count: { _all: true } }),
      () => prisma.deal.findMany({
        where: { agentId: id },
        orderBy: { startedAt: "desc" },
        take: 7,
        select: {
          id: true,
          stage: true,
          commissionAmount: true,
          currency: true,
          startedAt: true,
          closedAt: true,
          // Метка «аннулирована» в списке сделок сотрудника (C10, 02.10.2026).
          annulledAt: true,
          client: { select: { fullName: true } },
          property: { select: { shortId: true, title: true } },
        },
      }),
      () => prisma.kpiDailyScore.findMany({
        where: { agentId: id },
        orderBy: { date: "desc" },
        take: 30,
        select: { date: true, score: true },
      }),
      // Красные флаги антифрода — звонки-опросы после показа с находками
      // (routes/oversight.ts, GET /showing-survey-calls): единственное место,
      // где эти находки видны сейчас, и владелец видел их только пуш-уведомлением
      // в момент эскалации, а не собранными по конкретному сотруднику.
      () => seesInvestigations ? prisma.showingSurveyCall.findMany({
        where: { agentId: id, NOT: { redFlags: { equals: Prisma.DbNull } } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, createdAt: true, redFlags: true, escalatedAt: true, clientId: true },
      }) : Promise.resolve([]),
      // Последние действия этого агента по клиентам — звонки, встречи, показы,
      // смены статуса (owner 16.09.2026: «его звонки последние»). client: { deletedAt: null }
      // — та же оговорка, что и у месячной сводки /team: без неё показ по клиенту
      // из Корзины попадал бы в ленту действующего сотрудника.
      () => prisma.interaction.findMany({
        where: { agentId: id, type: { not: "SYSTEM" }, client: { deletedAt: null }, ...visibleInteractionWhere(investigationViewerRole(req)) },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          type: true,
          notes: true,
          outcome: true,
          createdAt: true,
          client: { select: { id: true, shortId: true, fullName: true } },
          property: { select: { shortId: true, title: true } },
        },
      }),
      // «Клиент писал — агент не отвечал» (owner 16.09.2026: «если он не позвонил»).
      // Тот же признак, что и в lib/agentUnansweredAlarm.ts (lastClientMessageAt
      // против lastAgentAttemptAt), но здесь — снимок для карточки, а не тревога
      // с порогом и пушем: директору важно увидеть сам факт, не ждать эскалации.
      () => prisma.client.findMany({
        where: {
          assignedAgentId: id,
          deletedAt: null,
          workStatus: "ACTIVE",
          status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
          lastClientMessageAt: { not: null },
        },
        orderBy: { lastClientMessageAt: "desc" },
        take: 20,
        select: { id: true, shortId: true, fullName: true, lastClientMessageAt: true, lastAgentAttemptAt: true },
      }),
      // Просроченные задачи — тот же красный флаг, что «Контроль руководителя»,
      // сужен на agentId.
      () => prisma.interaction.findMany({
        where: overdueTasksAgentWhere,
        orderBy: { nextActionDate: "asc" },
        take: 5,
        select: {
          id: true,
          notes: true,
          nextAction: true,
          nextActionDate: true,
          client: { select: { id: true, shortId: true, fullName: true } },
        },
      }),
      () => prisma.interaction.count({ where: overdueTasksAgentWhere }),
      // Горячие клиенты без прогресса (высокий ИИ-скоринг, давно без контакта).
      () => prisma.client.findMany({
        where: stalledClientsAgentWhere,
        orderBy: { aiScore: "desc" },
        take: 5,
        select: { id: true, shortId: true, fullName: true, status: true, aiScore: true, lastContactAt: true },
      }),
      // Остальные красные флаги — общекомандные хелперы, отфильтрованные на этого
      // агента после загрузки (капы take(500) внутри них те же, что у «Контроля
      // руководителя»: фильтр в памяти на уже маленьком списке дешевле второго
      // запроса к базе под каждого агента отдельно).
      () => findSilentAfterShowing(now),
      () => seesInvestigations ? findRefusedHighScore(new Date(Date.now() - RECENT_EVENTS_MS)) : Promise.resolve({ threshold: 0, items: [] }),
      () => findEndlessNegotiations(now),
      () => seesInvestigations ? findSellerPropertyMissing(now) : Promise.resolve({ warnDays: 0, criticalDays: 0, items: [] }),
      () => seesInvestigations ? findAgentLossSeries(new Date(Date.now() - AGENT_LOSS_SERIES_WINDOW_MS)) : Promise.resolve({ threshold: 0, windowDays: 0, items: [] }),
    ],
    AGENT_OVERVIEW_QUERY_CONCURRENCY
  );

  const silentAfterShowingForAgent = silentAfterShowing.items.filter((c) => c.assignedAgent?.id === id);
  const refusedHighScoreForAgent = refusedHighScore.items.filter((r) => r.agent?.id === id);
  const endlessNegotiationsForAgent = endlessNegotiations.items.filter((n) => n.agent.id === id);
  const sellerPropertyMissingForAgent = sellerPropertyMissing.items.filter((s) => s.assignedAgent?.id === id);
  const agentLossSeriesForAgent = agentLossSeries.items.find((a) => a.agentId === id) ?? null;

  const flaggedCallClientIds = [...new Set(flaggedSurveyCalls.map((c) => c.clientId))];
  const flaggedCallClients = flaggedCallClientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: flaggedCallClientIds } },
        select: { id: true, shortId: true, fullName: true },
      })
    : [];
  const flaggedCallClientById = new Map(flaggedCallClients.map((c) => [c.id, c]));

  // Prisma не умеет сравнивать два столбца одной строки в `where`, поэтому
  // фильтр — на месте: клиент писал (lastClientMessageAt есть), а агент с тех
  // пор либо не пытался вовсе, либо пытался ДО этого сообщения.
  const waitingForReply = waitingClients
    .filter((c) => !c.lastAgentAttemptAt || c.lastAgentAttemptAt < c.lastClientMessageAt!)
    .slice(0, 5);

  const dealsByStage = Object.fromEntries(dealStages.map((s) => [s.stage, s._count._all]));
  // Не _sum по колонке: суммировать комиссии в разных валютах на стороне БД нельзя,
  // приводим каждую к сомони по курсу из Настроек.
  const [completedCommissionDeals, money] = await Promise.all([
    prisma.deal.findMany({
      where: { agentId: id, stage: "COMPLETED" },
      select: { commissionAmount: true, currency: true },
    }),
    loadMoneyContext(),
  ]);
  const commissionTotal = roundMoney(
    completedCommissionDeals.reduce((s, d) => s + toTjs(d.commissionAmount, d.currency, money), 0)
  );

  /**
   * КАРТОЧКА СОТРУДНИКА ТОЖЕ ЗАКРЫВАЕТ НОМЕР (22.09.2026, ночной обход по классу
   * «номер уходит мимо прав»). Экран открыт правом team.viewFull (менеджер), а
   * `clients.viewPhone` у менеджера нет. `phone` здесь закрывался, а имя карточки,
   * `notes`, `nextAction`, причина скоринга и находки антифрода — нет: тот же
   * обход, что везде, только собранный по одному агенту. Правило — lib/clientPhone.ts.
   */
  const canSeePhone = can(req, "clients.viewPhone");
  const maskName = <T extends { fullName: string } | null | undefined>(c: T): T =>
    !c || canSeePhone ? c : { ...c, fullName: clientNamePhoneSafe(c.fullName, false) };
  const maskText = <T extends string | null>(t: T): T => (canSeePhone ? t : phoneSafeText(t, false));
  // Комиссия сотрудника — тем же правом, что и в /team и в отчётах (ночная
  // проверка 24.09.2026, №159/М4): карточка открыта team.viewFull (у менеджера
  // оно есть), а деньги — отдельное finance.view.
  const seesMoney = can(req, "finance.view");

  res.json({
    agent,
    properties: { total: propertiesTotal, available: propertiesAvailable, created: propertiesCreated, last: lastProperties },
    // Карточка сотрудника открыта руководству (team.viewFull), но телефоны его
    // клиентов — отдельное право: раздел «кто как работает» не обязан быть выгрузкой
    // контактов. См. lib/clientPhone.ts.
    clients: {
      total: clientsTotal,
      last: lastClients.map((c) => ({
        ...maskName(c),
        phone: clientPhoneFor(c.phone, canSeePhone),
      })),
    },
    deals: {
      total: dealStages.reduce((s, g) => s + g._count._all, 0),
      completed: dealsByStage["COMPLETED"] ?? 0,
      cancelled: dealsByStage["CANCELLED"] ?? 0,
      commissionTotal: seesMoney ? commissionTotal : null,
      last: lastDeals.map((d) => ({ ...d, commissionAmount: seesMoney ? d.commissionAmount : null, client: maskName(d.client) })),
    },
    // История KPI — по убыванию даты (свежие первыми), максимум месяц.
    kpiHistory,
    // «Проступки»: то, что раньше видел только раздел «Контроль руководителя»
    // отдельными журналами по всей компании, а по одному сотруднику собрать
    // было нельзя ниоткуда (владелец 16.09.2026). Здесь — то же честное «нет
    // данных», если находок не было, без выдумывания категорий сверх того,
    // что реально хранит ShowingSurveyCall.redFlags.
    violations: {
      flaggedShowingCalls: flaggedSurveyCalls.length,
      lastFlags: flaggedSurveyCalls.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        escalatedAt: c.escalatedAt,
        flags: canSeePhone
          ? ((c.redFlags as { category: string; detail: string }[] | null) ?? [])
          : ((c.redFlags as { category: string; detail: string }[] | null) ?? []).map((f) => ({
              ...f,
              detail: phoneSafeText(f.detail, false),
            })),
        client: maskName(flaggedCallClientById.get(c.clientId) ?? null),
      })),
    },
    // «Его звонки последние» + «если он не позвонил» (владелец 16.09.2026):
    // реальная история действий по клиентам и живой список тех, кто написал,
    // а ответа от агента с тех пор не было — не тревога с порогом, а снимок.
    activity: {
      recentInteractions: recentInteractions.map((i) => ({
        ...i,
        notes: maskText(i.notes),
        client: maskName(i.client),
      })),
      waitingForReply: waitingForReply.map((c) => ({
        id: c.id,
        shortId: c.shortId,
        fullName: maskName(c).fullName,
        lastClientMessageAt: c.lastClientMessageAt,
      })),
    },
    // «По-крупному, чтобы не искать что где когда» (владелец 16.09.2026): все
    // красные флаги «Контроля руководителя» (routes/oversight.ts), сужены на
    // этого агента, в одном месте. Каждый флаг — честное число: находок нет,
    // если сигнал не сработал, а не пустая заглушка.
    problems: {
      overdueTasks: {
        total: overdueTasksTotal,
        items: overdueTasksItems.map((t) => ({ ...t, notes: maskText(t.notes), nextAction: maskText(t.nextAction), client: maskName(t.client) })),
      },
      stalledClients: { total: stalledClientsItems.length, items: stalledClientsItems.map(maskName) },
      silentAfterShowing: { total: silentAfterShowingForAgent.length, days: silentAfterShowing.days, items: silentAfterShowingForAgent.slice(0, 5).map(maskName) },
      refusedHighScore: {
        total: refusedHighScoreForAgent.length,
        windowDays: RECENT_EVENTS_DAYS,
        items: refusedHighScoreForAgent.slice(0, 5).map((r) => ({
          ...r,
          client: r.client
            ? { ...r.client, fullName: clientNamePhoneSafe(r.client.fullName, canSeePhone), aiScoreReason: phoneSafeText(r.client.aiScoreReason, canSeePhone) }
            : r.client,
        })),
      },
      endlessNegotiations: {
        total: endlessNegotiationsForAgent.length,
        items: endlessNegotiationsForAgent.slice(0, 5).map((n) => ({
          ...n,
          subjectName: canSeePhone ? n.subjectName : clientNamePhoneSafe(n.subjectName, false),
          client: maskName(n.client),
        })),
      },
      sellerPropertyMissing: { total: sellerPropertyMissingForAgent.length, items: sellerPropertyMissingForAgent.slice(0, 5).map(maskName) },
      lossSeries: agentLossSeriesForAgent
        ? { count: agentLossSeriesForAgent.count, windowDays: agentLossSeries.windowDays, threshold: agentLossSeries.threshold }
        : null,
    },
  });
});

/**
 * «Сейчас» + «с кем общается» + «звонки за неделю» — верх карточки сотрудника.
 * Тело — lib/staffLive.ts (10.11.2026): его же читает помощница.
 */
agentOverviewRouter.get("/:id/live", requireAuth, requirePermission("team.viewFull"), async (req, res) => {
  const live = await loadStaffLive(req.params.id, req.agent!);
  if (!live) return res.status(404).json({ error: "Сотрудник не найден" });
  res.json(live);
});
