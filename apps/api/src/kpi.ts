import { prisma } from "./db.js";
import { dushanbeDayRange } from "./lib/dushanbeTime.js";
import { isClientCardFilled, RATED_ROLES } from "@royal-home/shared";
import { computeRoyalScore } from "./lib/scoreJournal.js";
import { reportCronRowError } from "./lib/cronHeartbeat.js";
import { isInstagramLink } from "./lib/instagramLink.js";
import { incomingInteractionIds } from "./lib/telephony/incomingInteractions.js";

interface MetricScore {
  earned: number;
  max: number;
}

/**
 * Ключи метрик по ТЗ KPI Royal Home:
 *  Постоянные:  response 20, crm 20, discipline 20
 *  Ситуационные: photo 10, video 10, contract 20, personalLeads 10, cards 10
 * Метрика, недоступная агенту в этот день, возвращает null и полностью
 * исключается из расчёта (не входит ни в earned, ни в max).
 */
export type KpiMetricKey =
  | "response"
  | "crm"
  | "discipline"
  | "photo"
  | "video"
  | "contract"
  | "personalLeads"
  | "cards";

export type KpiBreakdown = Partial<Record<KpiMetricKey, MetricScore>>;

export interface KpiResult {
  score: number;
  breakdown: KpiBreakdown;
}

interface MetricContext {
  agentId: string;
  start: Date;
  end: Date;
  /** Кэш опубликованных за день объектов агента: метрики «фото» и «видео» считают
   *  по одной и той же выборке, без него она поднималась из БД дважды на агента. */
  publishedCache?: Promise<{ instagramUrl: string | null; photos: { id: string }[] }[]>;
}

/** Описание метрики: вес и функция расчёта. Новую метрику добавляем одной
 * записью в METRICS — формула итога не меняется (требование ТЗ п.6). */
interface MetricDef {
  key: KpiMetricKey;
  weight: number;
  /** null → метрика в этот день недоступна агенту и исключается из расчёта. */
  compute: (ctx: MetricContext) => Promise<number | null>; // возвращает долю 0..1
}

/**
 * Скорость первого ответа на новый лид (20%). Активна только если агенту в этот
 * день назначались лиды. Прокси «ответил» — первая Interaction агента по клиенту
 * после assignedAt; нет ответа → Infinity, проваливает порог без отдельного if.
 */
async function computeResponse({ agentId, start, end }: MetricContext): Promise<number | null> {
  const leads = await prisma.client.findMany({
    // deletedAt — за удалённую заявку агента не штрафуем: «нет ответа» по клиенту,
    // которого убрали в Корзину, обнуляло бы метрику скорости за весь день.
    where: { assignedAgentId: agentId, assignedAt: { gte: start, lt: end }, deletedAt: null },
    select: { id: true, assignedAt: true },
  });
  if (leads.length === 0) return null;

  // Первые ответы по всем лидам дня — одним запросом вместо запроса на каждый лид:
  // берём взаимодействия агента по этим клиентам и оставляем самое раннее после
  // назначения (лидов за день единицы, сортировка в памяти дешевле N обращений к БД).
  const interactions = await prisma.interaction.findMany({
    where: { investigationOnly: false, agentId, clientId: { in: leads.map((l) => l.id) }, createdAt: { gt: start } },
    orderBy: { createdAt: "asc" },
    select: { id: true, clientId: true, createdAt: true },
  });

  /**
   * ВХОДЯЩИЙ ЗВОНОК ОТВЕТОМ АГЕНТА НЕ СЧИТАЕТСЯ. Он пишется в хронологию от имени
   * ответственного агента (у Interaction автор обязателен, оператора в карточке
   * нет), и без этой строки агент получал полный балл за скорость ответа только
   * потому, что клиент позвонил в офис сам, — включая случай, когда до агента
   * вообще никто не дозвонился. То же правило уже действует в leads.ts для
   * обязанности «первый звонок»; здесь оно применяется к оценке скорости.
   */
  const incoming = await incomingInteractionIds(interactions.map((i) => i.id));
  // Ответом считается первое взаимодействие ПОСЛЕ назначения лида — записи, сделанные
  // раньше (лид уже был у агента и его переназначили обратно), пропускаем, а не
  // засчитываем как «не ответил». Запросы отсортированы по времени, поэтому первое
  // подходящее по каждому клиенту и есть искомое.
  const assignedAtById = new Map(leads.map((l) => [l.id, l.assignedAt]));
  const firstResponseAt = new Map<string, Date>();
  for (const i of interactions) {
    if (incoming.has(i.id)) continue;
    if (firstResponseAt.has(i.clientId)) continue;
    const assignedAt = assignedAtById.get(i.clientId);
    if (assignedAt && i.createdAt > assignedAt) firstResponseAt.set(i.clientId, i.createdAt);
  }

  const responseMinutes = leads.map((lead) => {
    const responded = firstResponseAt.get(lead.id);
    return responded ? (responded.getTime() - lead.assignedAt.getTime()) / 60_000 : Infinity;
  });
  const avgMinutes = responseMinutes.reduce((s, m) => s + m, 0) / responseMinutes.length;
  return avgMinutes <= 5 ? 1 : avgMinutes <= 15 ? 0.5 : 0;
}

/**
 * Работа с CRM (20%) — доля задач (Interaction.nextAction) со сроком на этот
 * день, выполненных вовремя. Постоянная метрика: если задач не было — полный
 * балл (отсутствие задачи не штраф, презумпция невиновности).
 */
// The current task list hides cancelled work immediately. Historical KPI must
// retain tasks that were still active at that day's boundary, even after reassignment.
function taskVisibleAtDayEnd(end: Date) {
  return {
    nextAction: { not: null },
    investigationOnly: false,
    client: { deletedAt: null },
    AND: [
      { OR: [{ taskCancelledAt: null }, { taskCancelledAt: { gte: end } }] },
      { OR: [
        { completedAt: { not: null } },
        { client: { assignmentCompletedAt: null } },
        { client: { assignmentCompletedAt: { gte: end } } },
      ] },
    ],
  };
}

async function computeCrm({ agentId, start, end }: MetricContext): Promise<number> {
  const dueToday = await prisma.interaction.findMany({
    // subjectAgentId ?? agentId (П-10, 17.09.2026): задачу мог завести бот/система
    // от лица держателя карточки (agentId: null) — она остаётся ЕГО задачей для
    // KPI дисциплины, как и раньше, когда agentId всегда был держателем.
    where: { ...taskVisibleAtDayEnd(end), OR: [{ agentId }, { subjectAgentId: agentId }], nextActionDate: { gte: start, lt: end } },
    select: { completedAt: true },
  });
  if (dueToday.length === 0) return 1;
  const onTime = dueToday.filter((t) => t.completedAt && t.completedAt.getTime() < end.getTime()).length;
  return onTime / dueToday.length;
}

/**
 * Дисциплина (20%) — соблюдение регламентов. Автоматический прокси: нет
 * «хвостов» — просроченных незакрытых задач с прошлых дней. Постоянная метрика:
 * каждый висящий просроченный хвост снимает 25% дисциплины (4+ хвоста → 0).
 */
async function computeDiscipline({ agentId, start, end }: MetricContext): Promise<number> {
  // «Хвост висел в день X» — задача была просрочена к началу дня и не закрыта до его
  // конца. Условие по end делает пересчёт прошлых дней воспроизводимым: задача,
  // закрытая сегодня, не «обеляет» вчерашний снапшот задним числом.
  const overdue = await prisma.interaction.count({
    where: {
      // subjectAgentId ?? agentId (П-10, 17.09.2026): см. computeCrm выше — хвост
      // от бота/системы остаётся хвостом держателя карточки.
      ...taskVisibleAtDayEnd(end),
      AND: [...taskVisibleAtDayEnd(end).AND, { OR: [{ agentId }, { subjectAgentId: agentId }] }, { OR: [{ completedAt: null }, { completedAt: { gte: end } }] }],
      nextActionDate: { lt: start },
    },
  });
  return Math.max(0, 1 - overdue * 0.25);
}

/** Объекты, опубликованные в этот день и закреплённые за агентом (см. AuditLog
 * PUBLISH из properties.ts bulk-sync). Общая база для метрик «фото» и «видео». */
function publishedPropertiesOf(ctx: MetricContext) {
  ctx.publishedCache ??= fetchPublishedProperties(ctx.agentId, ctx.start, ctx.end);
  return ctx.publishedCache;
}

async function fetchPublishedProperties(agentId: string, start: Date, end: Date) {
  const publishLogs = await prisma.auditLog.findMany({
    where: { action: "PUBLISH", entityType: "Property", createdAt: { gte: start, lt: end } },
    select: { meta: true },
  });
  const propertyIds = new Set<string>();
  for (const log of publishLogs) {
    const ids = (log.meta as { ids?: unknown } | null)?.ids;
    if (Array.isArray(ids)) ids.forEach((id) => typeof id === "string" && propertyIds.add(id));
  }
  if (propertyIds.size === 0) return [];
  // Исполнитель — интейкер объекта (кто принял и упаковывал), а не риелтор:
  // риелтор появляется позже, в момент сделки, и к качеству упаковки отношения не имеет.
  return prisma.property.findMany({
    where: { id: { in: [...propertyIds] }, intakeAgentId: agentId },
    select: { instagramUrl: true, photos: { select: { id: true } } },
  });
}

/** Качество фотографий объекта (10%) — активна только в день публикации объекта
 * агента. Чек: у всех опубликованных объектов ≥15 фото. */
async function computePhoto(ctx: MetricContext): Promise<number | null> {
  const properties = await publishedPropertiesOf(ctx);
  if (properties.length === 0) return null;
  return properties.every((p) => p.photos.length >= 15) ? 1 : 0;
}

/** Качество видеосъёмки (10%) — активна в день публикации. Чек: у всех
 * опубликованных объектов есть ссылка на видео-обзор (instagramUrl), и она ведёт
 * именно на Instagram — телеграм-ссылка обзором не считается (см. lib/instagramLink.ts). */
async function computeVideo(ctx: MetricContext): Promise<number | null> {
  const properties = await publishedPropertiesOf(ctx);
  if (properties.length === 0) return null;
  return properties.every((p) => isInstagramLink(p.instagramUrl)) ? 1 : 0;
}

/**
 * Заключение договора (20%) — активна только если агент в этот день закрыл
 * сделку. Полный балл при корректно оформленной сделке (комиссия заполнена).
 */
async function computeContract({ agentId, start, end }: MetricContext): Promise<number | null> {
  const closed = await prisma.deal.findMany({
    where: { agentId, stage: "COMPLETED", closedAt: { gte: start, lt: end } },
    select: { commissionAmount: true },
  });
  if (closed.length === 0) return null;
  return closed.every((d) => Number(d.commissionAmount ?? 0) > 0) ? 1 : 0;
}

/**
 * Личные лиды (10%) — решение владельца 30.07: агент привёл клиента сам (галочка
 * «личный лид» при создании) и заполнил карточку — KPI в плюс. Ситуационная:
 * активна только в день, когда агент завёл личный лид. Заполненной считается
 * карточка с бюджетом, районом и сутью запроса (комнаты или заметки) — ровно то,
 * по чему работает подбор объектов; галочка без данных баллов не приносит.
 */
async function computePersonalLeads({ agentId, start, end }: MetricContext): Promise<number | null> {
  const created = await prisma.client.findMany({
    where: { assignedAgentId: agentId, isPersonalLead: true, createdAt: { gte: start, lt: end }, deletedAt: null },
    select: { budgetMin: true, budgetMax: true, desiredDistrictId: true, desiredRooms: true, requirementsNotes: true },
  });
  if (created.length === 0) return null;
  return created.filter(isClientCardFilled).length / created.length;
}

/**
 * Заполнение карточек (10%) — решение владельца 30.07: незаполненная карточка бьёт
 * по KPI. Активна, если агенту в этот день принадлежали ПРИНЯТЫЕ лиды, у которых
 * с момента принятия прошёл хотя бы час: раньше требовать заполнение нечестно —
 * агент как раз разговаривает с клиентом.
 *
 * Отметка «Я в работе» переносит точку отсчёта: клиент, по которому агент честно
 * нажал кнопку меньше часа назад, в расчёт не берётся.
 */
async function computeCards({ agentId, start, end }: MetricContext): Promise<number | null> {
  const hourBeforeEnd = new Date(end.getTime() - 60 * 60 * 1000);
  const clients = await prisma.client.findMany({
    where: {
      assignedAgentId: agentId,
      deletedAt: null,
      kind: { not: "OTHER" },
      status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
      acceptedAt: { not: null, lt: hourBeforeEnd, gte: new Date(start.getTime() - 30 * 24 * 60 * 60 * 1000) },
    },
    select: {
      budgetMin: true,
      budgetMax: true,
      desiredDistrictId: true,
      desiredRooms: true,
      requirementsNotes: true,
      workingMarkedAt: true,
    },
  });
  const counted = clients.filter((c) => !c.workingMarkedAt || c.workingMarkedAt < hourBeforeEnd);
  if (counted.length === 0) return null;
  return counted.filter(isClientCardFilled).length / counted.length;
}

const METRICS: MetricDef[] = [
  { key: "response", weight: 20, compute: computeResponse },
  { key: "crm", weight: 20, compute: computeCrm },
  { key: "discipline", weight: 20, compute: computeDiscipline },
  { key: "photo", weight: 10, compute: computePhoto },
  { key: "video", weight: 10, compute: computeVideo },
  { key: "contract", weight: 20, compute: computeContract },
  { key: "personalLeads", weight: 10, compute: computePersonalLeads },
  { key: "cards", weight: 10, compute: computeCards },
];

/** Зашитые веса — то, что действует, пока владелец не переопределил их в Настройках. */
export const DEFAULT_KPI_WEIGHTS: Record<KpiMetricKey, number> = Object.fromEntries(
  METRICS.map((m) => [m.key, m.weight])
) as Record<KpiMetricKey, number>;

/**
 * Действующие веса: Настройки поверх зашитых (решение владельца 01.08.2026 —
 * ни одно число не живёт в коде).
 *
 * Незнакомые ключи из базы отбрасываются, не-числа и отрицательные тоже: колонка
 * Json, и доверять её форме нельзя. Отказ базы или пустая настройка — зашитые
 * значения: KPI обязан посчитаться в любом случае, ночной пересчёт не должен
 * падать из-за настройки.
 */
export async function loadKpiWeights(): Promise<Record<KpiMetricKey, number>> {
  try {
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { kpiWeights: true } });
    const raw = s?.kpiWeights;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_KPI_WEIGHTS;
    const result = { ...DEFAULT_KPI_WEIGHTS };
    for (const key of Object.keys(DEFAULT_KPI_WEIGHTS) as KpiMetricKey[]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
    }
    return result;
  } catch {
    return DEFAULT_KPI_WEIGHTS;
  }
}

/** Считает KPI агента (0-100) за календарный день (по Душанбе). Знаменатель
 * динамический: суммируются только активные метрики, итог нормируется к 100.
 * Если ни одна метрика не активна (теоретически невозможно — crm/discipline
 * активны всегда) — 100, чтобы не делить на 0. */
export async function calculateDailyKPI(
  agentId: string,
  day: Date,
  // Ночной пересчёт (calculateDailyKpiForAllAgents) передаёт веса один раз на весь
  // прогон — без этого запрос Settings уходил на КАЖДОГО агента (тот же приём уже
  // применён в computeWeakLink, см. lib/dashboardInsights.ts).
  presetWeights?: Record<KpiMetricKey, number>
): Promise<KpiResult> {
  const { start, end } = dushanbeDayRange(day);
  const ctx: MetricContext = { agentId, start, end };

  // Веса — из Настроек (решение владельца 01.08.2026). Вес 0 выключает метрику
  // целиком: она не считается и не попадает в разбор, а не «считается и весит ноль».
  const weights = presetWeights ?? (await loadKpiWeights());
  const active = METRICS.filter((m) => weights[m.key] > 0);
  const results = await Promise.all(active.map(async (m) => ({ def: m, ratio: await m.compute(ctx) })));

  const breakdown: KpiBreakdown = {};
  let earned = 0;
  let max = 0;
  for (const { def, ratio } of results) {
    if (ratio === null) continue;
    const weight = weights[def.key];
    const score = { earned: Math.round(ratio * weight), max: weight };
    breakdown[def.key] = score;
    earned += score.earned;
    max += score.max;
  }

  const score = max === 0 ? 100 : Math.round((earned / max) * 100);
  return { score, breakdown };
}

/**
 * Пересчитывает KPI за день для всех активных агентов, пишет KpiDailyScore
 * (история/разбор) и обновляет Agent.kpi (кэш для распределения лидов/дашборда).
 * Вызывается ночным кроном за прошедший день, см. cron.ts.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 03.08.2026 (отменяет решение от 01.08, см. scoreJournal.ts):
 * ОФИЦИАЛЬНЫЙ счёт — `computeRoyalScore` (сумма событий Royal Score в скользящем
 * окне), а не взвешенная модель ниже. `Agent.kpi` и `KpiDailyScore.score` теперь
 * пишутся ИЗ НЕЁ, а не из `calculateDailyKPI`.
 *
 * `calculateDailyKPI` (восемь показателей) при этом не выброшена: её разбор
 * остаётся в `KpiDailyScore.breakdown` как ДИАГНОСТИКА активности дня для
 * панели руководителя (RadarTile/AgentOverviewModal) — «чем агент был занят»,
 * а не «сколько за это дали баллов». Числа двух моделей больше НЕ обязаны
 * сходиться: событийный счёт бьёт по конкретным нарушениям и достижениям,
 * взвешенный разбор — по среднедневной активности, и это разные вопросы.
 */
export async function calculateDailyKpiForAllAgents(day: Date): Promise<number> {
  // ЗАМОРОЖЕННЫЕ ПРОПУСКАЮТСЯ: им не выдают работу вовсе, и падение счёта означало
  // бы наказание за то, что человеку запретили работать. Его KPI остаётся на
  // последнем значении, место в рейтинге сохраняется — это остановка работы, а не
  // взыскание. Пауза «не принимаю лиды» здесь, наоборот, НЕ учитывается: текущие
  // клиенты никуда не делись, и обнуляя просрочки, тумблер стал бы способом их прятать.
  const agents = await prisma.agent.findMany({
    where: { role: { in: [...RATED_ROLES] }, isActive: true, frozenAt: null },
    select: { id: true },
  });
  const { start, end } = dushanbeDayRange(day);
  // Один раз на прогон: веса за ночь не меняются, а перечитывать Settings на
  // каждого агента — чистое дублирование.
  const weights = await loadKpiWeights();

  let done = 0;
  for (const agent of agents) {
    // СБОЙ ОДНОГО АГЕНТА НЕ ОБРЫВАЕТ ОСТАЛЬНЫХ (E8 глубокой проверки 02.10.2026,
    // тот же класс, что №173). Битый разбор или deadlock на upsert у одного
    // раньше оставлял всех после него без счёта за день и со старым Agent.kpi.
    try {
      // Разбор — для диагностики дня (см. докстрин выше), счёт — из событийного
      // журнала. `computeRoyalScore` считается на конец пересчитываемых суток
      // (`end`), а не на текущий момент запуска крона: иначе пересчёт за ВЧЕРА
      // задним числом захватил бы события, случившиеся уже СЕГОДНЯ.
      const { breakdown } = await calculateDailyKPI(agent.id, day, weights);
      const score = await computeRoyalScore(agent.id, end);
      await prisma.$transaction([
        prisma.kpiDailyScore.upsert({
          where: { agentId_date: { agentId: agent.id, date: start } },
          create: { agentId: agent.id, date: start, score, breakdown: breakdown as object },
          update: { score, breakdown: breakdown as object },
        }),
        prisma.agent.update({ where: { id: agent.id }, data: { kpi: score } }),
      ]);
      done++;
    } catch (err) {
      reportCronRowError("Ночной пересчёт KPI агента", agent.id, err);
    }
  }
  return done;
}
