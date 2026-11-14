import { z } from "zod";
import { dateRangeQuerySchema, reportDateRangeError } from "@royal-home/shared";
import { prisma } from "../db.js";
import { visibleInteractionWhere } from "./investigationPrivacy.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { dushanbeStartOfMonth, dushanbeEndOfDay, dushanbeDayRange } from "./dushanbeTime.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { logSystemError } from "./systemError.js";

/**
 * ОТЧЁТЫ «ВОРОНКА», «ПО АГЕНТАМ», «ИСТОЧНИКИ» — один расчёт для экрана «Отчёты»
 * (GET /reports/funnel, /agents, /sources) и для PDF-отчёта по команде
 * (14.11.2026). Раньше тела жили прямо в routes/reports.ts; вынесены без
 * изменения логики, чтобы PDF не считал те же цифры второй раз по-своему.
 *
 * Кто смотрит — передаётся явно (ReportViewer), а не через req: тот же расчёт
 * зовёт и маршрут PDF, а там правила видимости обязаны быть те же самые.
 */
export interface ReportViewer {
  /** Роль для служебных записей проверки (investigationViewerRole); undefined — только публичное. */
  investigationRole: string | undefined;
  /** Право finance.view: без него денежные поля — null (аудит 23.09.2026, №44). */
  seesMoney: boolean;
}

// Потолок ширины периода from/to (22.09.2026, класс «Пагинация»): без него
// строку запроса можно было отправить с from=2000-01-01 — окно без верхней
// границы шириной, а не только без верхней границы ДАТ. Тот же потолок, что и
// months в expenses.ts (60 месяцев) — отчёты этого раздела не задуманы дальше.
const MAX_RANGE_MONTHS = 60;
const MAX_RANGE_MS = MAX_RANGE_MONTHS * 31 * 24 * 60 * 60 * 1000;

export function parseReportRange(query: Record<string, unknown>) {
  const parsed = dateRangeQuerySchema.parse(query);
  const to = parsed.to ?? new Date();
  // "from"/"to" приходят как YYYY-MM-DD (полночь UTC при разборе строки в Date) —
  // сдвигаем оба конца на границы суток по ДУШАНБЕ, иначе теряется 5-часовое окно
  // (19:00–00:00 UTC), которое в Душанбе уже следующий день: «с 1 августа» на деле
  // начинался в 05:00 по Душанбе, и Отчёты с Главной (которая считает через
  // dushanbeStartOfMonth) расходились в цифрах за один и тот же месяц.
  const to_ = dushanbeEndOfDay(to);
  let from = parsed.from ? dushanbeDayRange(parsed.from).start : dushanbeStartOfMonth();
  const rangeError = reportDateRangeError(from, to_);
  if (rangeError) throw new z.ZodError([{ code: "custom", path: ["from"], message: rangeError }]);
  if (to_.getTime() - from.getTime() > MAX_RANGE_MS) {
    from = new Date(to_.getTime() - MAX_RANGE_MS);
  }
  return { from, to: to_ };
}

/** Потолок строк для агрегатов /funnel и /sources (22.09.2026, класс «Пагинация»).
 *  Период уже ограничен MAX_RANGE_MONTHS, но число строк в нём ничем не
 *  ограничено — с большим запасом над реальным темпом этого агентства. */
const REPORTS_ROW_LIMIT = 20_000;

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  commission?: number | null;
}

export async function buildFunnelReport(range: { from: Date; to: Date }, viewer: ReportViewer): Promise<FunnelStep[]> {
  const { from, to } = range;
  const visible = visibleInteractionWhere(viewer.investigationRole);
  const [newLeads, contactedClientIds, showings, negotiations, completedDeals, money] = await Promise.all([
    prisma.client.count({ where: { createdAt: { gte: from, lte: to }, deletedAt: null } }),
    // groupBy, а НЕ findMany({ distinct }) (тот же приём и причина, что в
    // dashboard.ts, GET /summary): Prisma схлопывает distinct не в SQL, а в
    // памяти движка — то есть вычитывает ВСЕ взаимодействия периода, а take-потолок
    // здесь тихо занизил бы «На контакте» вместо честного числа. Ниже берётся
    // только длина результата — группировка в SQL даёт то же число без выборки
    // всех строк в память и без риска ложного усечения.
    prisma.interaction.groupBy({
      by: ["clientId"],
      // client.deletedAt — иначе «На контакте» считалось по удалённым клиентам, и
      // воронка расширялась вместо того, чтобы сужаться: 10 лидов, 12 на контакте.
      where: { ...visible, type: { in: ["CALL", "MESSAGE", "MEETING"] }, createdAt: { gte: from, lte: to }, client: { deletedAt: null } },
    }),
    // COUNTED_SHOWING_WHERE — отменённый показ не состоялся, и в воронке ему не
    // место: иначе шаг «Показы» шире шага «На контакте» на встречи, которых не было.
    prisma.interaction.count({
      where: { ...visible, type: "SHOWING", ...COUNTED_SHOWING_WHERE, createdAt: { gte: from, lte: to }, client: { deletedAt: null } },
    }),
    prisma.deal.count({ where: { startedAt: { gte: from, lte: to }, client: { deletedAt: null } } }),
    // Сумма по валютам считается базой — одна строка на валюту вместо списка
    // всех закрытых сделок периода.
    prisma.deal.groupBy({
      by: ["currency"],
      where: { stage: "COMPLETED", closedAt: { gte: from, lte: to } },
      // _count обязателен: строк тут по одной на валюту, и без него «сделок» в
      // воронке считалось бы столько, сколько валют.
      _count: { _all: true },
      _sum: { commissionAmount: true },
    }),
    loadMoneyContext(),
  ]);

  // В сомони: долларовые сделки иначе прибавлялись к сомони как есть.
  const commission = roundMoney(
    completedDeals.reduce((sum, row) => sum + toTjs(row._sum.commissionAmount, row.currency, money), 0)
  );
  const dealsCount = completedDeals.reduce((sum, row) => sum + row._count._all, 0);

  return [
    { key: "leads", label: "Новые лиды", count: newLeads },
    { key: "contacted", label: "На контакте", count: contactedClientIds.length },
    { key: "showings", label: "Показы", count: showings },
    { key: "negotiations", label: "Переговоры", count: negotiations },
    // Деньги — только с правом на финансы (аудит 23.09.2026, №44): отчёты
    // открыты маркетингу и службе безопасности, комиссия им не положена.
    { key: "deals", label: "Сделки", count: dealsCount, commission: viewer.seesMoney ? commission : null },
  ];
}

export interface AgentReportRow {
  agentId: string;
  agentName: string;
  isActive: boolean;
  avatarUrl: string | null;
  showings: number;
  dealsClosed: number;
  commission: number | null;
}

export async function buildAgentsReport(range: { from: Date; to: Date }, viewer: ReportViewer): Promise<AgentReportRow[]> {
  const { from, to } = range;
  const visible = visibleInteractionWhere(viewer.investigationRole);

  // Порядок задан явно: без orderBy строки приходили в физическом порядке
  // таблицы, и он менялся сам по себе после правок в карточках сотрудников —
  // отчёт при каждом открытии выглядел перетасованным.
  //
  // Не только работающие (C17, 02.10.2026): воронка на этой же странице считает
  // ВСЕ сделки периода, и сделки агента, уволенного после них, пропадали из строк —
  // сумма «Сделок» по агентам не сходилась с итогом воронки. Ушедший агент со
  // сделками в периоде остаётся строкой с пометкой «не работает».
  const agents = await prisma.agent.findMany({
    where: {
      OR: [{ isActive: true }, { deals: { some: { stage: "COMPLETED", closedAt: { gte: from, lte: to } } } }],
    },
    select: { id: true, fullName: true, avatarUrl: true, isActive: true },
    orderBy: { fullName: "asc" },
    // Потолок обязателен даже там, где агентов десяток — см. hallOfFame.ts.
    take: 500,
  });
  const agentIds = agents.map((a) => a.id);

  // Три запроса на весь отчёт вместо трёх на КАЖДОГО агента: при команде из 20
  // человек это было 60 обращений к БД на одно открытие вкладки «Отчёты».
  const [showingCounts, showingCountsBySubject, deals, money] = await Promise.all([
    prisma.interaction.groupBy({
      by: ["agentId"],
      // Отменённые показы агенту не засчитываются: он на них не ездил. deletedAt:
      // null (27.08.2026) — воронка на этой же странице (строка выше) этот
      // фильтр имеет, а счётчик показов по агентам его не наследовал: два
      // счётчика в одном ответе API считали по разным правилам.
      where: {
        agentId: { in: agentIds },
        ...visible,
        type: "SHOWING",
        ...COUNTED_SHOWING_WHERE,
        createdAt: { gte: from, lte: to },
        client: { deletedAt: null },
      },
      _count: { _all: true },
    }),
    // subjectAgentId (П-10, 17.09.2026): показ, записанный ботом/системой от
    // лица клиента (agentId: null), groupBy по agentId выше теряет — держатель
    // карточки лежит в subjectAgentId, отдельной группировкой и складываем ниже.
    prisma.interaction.groupBy({
      by: ["subjectAgentId"],
      where: {
        subjectAgentId: { in: agentIds },
        ...visible,
        agentId: null,
        type: "SHOWING",
        ...COUNTED_SHOWING_WHERE,
        createdAt: { gte: from, lte: to },
        client: { deletedAt: null },
      },
      _count: { _all: true },
    }),
    // Количество и сумма считаются базой: по строке на пару «агент + валюта»
    // вместо строки на каждую сделку периода. Арифметика та же — сумма сумм.
    prisma.deal.groupBy({
      by: ["agentId", "currency"],
      where: { agentId: { in: agentIds }, stage: "COMPLETED", closedAt: { gte: from, lte: to } },
      _count: { _all: true },
      _sum: { commissionAmount: true },
    }),
    loadMoneyContext(),
  ]);

  const showingsByAgent = new Map(showingCounts.map((s) => [s.agentId, s._count._all]));
  for (const s of showingCountsBySubject) {
    if (!s.subjectAgentId) continue;
    showingsByAgent.set(s.subjectAgentId, (showingsByAgent.get(s.subjectAgentId) ?? 0) + s._count._all);
  }

  const dealStats = new Map<string, { count: number; commission: number }>();
  for (const row of deals) {
    const entry = dealStats.get(row.agentId) ?? { count: 0, commission: 0 };
    entry.count += row._count._all;
    entry.commission += toTjs(row._sum.commissionAmount, row.currency, money);
    dealStats.set(row.agentId, entry);
  }

  return agents.map((agent) => {
    const stats = dealStats.get(agent.id);
    return {
      agentId: agent.id,
      agentName: agent.isActive ? agent.fullName : `${agent.fullName} (не работает)`,
      isActive: agent.isActive,
      avatarUrl: agent.avatarUrl,
      showings: showingsByAgent.get(agent.id) ?? 0,
      dealsClosed: stats?.count ?? 0,
      // Суммы в сомони (долларовые сделки пересчитаны по курсу из Настроек).
      // Без права на финансы — null (аудит 23.09.2026, №44).
      commission: viewer.seesMoney ? roundMoney(stats?.commission ?? 0) : null,
    };
  });
}

export interface SourcesReport {
  sources: { source: string; total: number; closed: number; wrote: number }[];
  avgDaysNewToClosed: number | null;
}

export async function buildSourcesReport(range: { from: Date; to: Date }): Promise<SourcesReport> {
  const { from, to } = range;

  // Считает база: по строке на пару «источник + статус» вместо строки на
  // каждого клиента периода. У агентства с историей это разница между десятком
  // строк и всей клиентской базой в памяти процесса.
  const clientCounts = await prisma.client.groupBy({
    by: ["source", "status"],
    where: { createdAt: { gte: from, lte: to }, deletedAt: null },
    _count: { _all: true },
  });

  const bySource = new Map<string, { total: number; closed: number }>();
  for (const row of clientCounts) {
    const entry = bySource.get(row.source) ?? { total: 0, closed: 0 };
    entry.total += row._count._all;
    if (row.status === "DEAL_CLOSED") entry.closed += row._count._all;
    bySource.set(row.source, entry);
  }

  /**
   * СКОЛЬКО ЛЮДЕЙ ВООБЩЕ НАПИСАЛО — а не только тех, кто дошёл до заявки.
   *
   * Отчёт считал по таблице клиентов, то есть по карточкам. Но карточка заводится,
   * только когда человек оставил номер: все, кто написал «сколько стоит?» и ушёл,
   * из отчёта исчезали. Получалось, что канал, приводящий сто обращений и десять
   * заявок, и канал, приводящий двенадцать обращений и десять заявок, выглядели
   * одинаково — а это разница между «дорогой канал с плохой обработкой» и
   * «золотая жила».
   *
   * Считает база, по строке на канал: диалогов за месяц тысячи, и тянуть их в
   * память ради подсчёта нельзя.
   */
  const [botConversations, telegramConversations] = await Promise.all([
    prisma.botConversation.groupBy({
      by: ["channel"],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.telegramConversation.count({ where: { createdAt: { gte: from, lte: to } } }),
  ]);

  const wroteBySource = new Map<string, number>();
  for (const row of botConversations) {
    // Канал диалога и источник клиента названы одинаково (INSTAGRAM, WHATSAPP,
    // FACEBOOK) — совпадение не случайное, оно заложено в toClientSource.
    wroteBySource.set(row.channel, (wroteBySource.get(row.channel) ?? 0) + row._count._all);
  }
  if (telegramConversations > 0) {
    wroteBySource.set("TELEGRAM", (wroteBySource.get("TELEGRAM") ?? 0) + telegramConversations);
  }

  const closedDeals = await prisma.deal.findMany({
    where: { stage: "COMPLETED", closedAt: { gte: from, lte: to } },
    select: { closedAt: true, startedAt: true, client: { select: { createdAt: true } } },
    take: REPORTS_ROW_LIMIT,
  });
  if (closedDeals.length >= REPORTS_ROW_LIMIT) {
    void logSystemError(
      "api",
      `Отчёт «Источники»: закрытых сделок за период больше потолка ${REPORTS_ROW_LIMIT} — средний срок закрытия посчитан по первым ${REPORTS_ROW_LIMIT}`
    );
  }
  const avgDaysToClose = closedDeals.length
    ? Math.round(
        closedDeals.reduce((sum, d) => sum + (d.closedAt!.getTime() - d.client.createdAt.getTime()) / 86400000, 0) /
          closedDeals.length
      )
    : null;

  return {
    // Крупные источники сверху, при равенстве — по названию. Раньше порядок
    // определяла база и он менялся сам по себе: список прыгал между открытиями.
    // В список попадают и каналы, где написали, но ни одной заявки не оставили:
    // именно они и были невидимы, а именно их и нужно чинить в первую очередь.
    sources: Array.from(new Set([...bySource.keys(), ...wroteBySource.keys()]))
      .map((source) => ({
        source,
        total: bySource.get(source)?.total ?? 0,
        closed: bySource.get(source)?.closed ?? 0,
        /** Сколько человек написало в этот канал за период. 0 — канал не
         *  переписочный (сайт, звонок, визит): там «написал» и «оставил заявку»
         *  это одно и то же событие, и вторая цифра была бы копией первой. */
        wrote: wroteBySource.get(source) ?? 0,
      }))
      .sort((a, b) => b.wrote - a.wrote || b.total - a.total || a.source.localeCompare(b.source)),
    avgDaysNewToClosed: avgDaysToClose,
  };
}
