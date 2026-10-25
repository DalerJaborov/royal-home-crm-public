import { requireInvestigations } from "../auth/investigations.js";
import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  dateRangeQuerySchema,
  demandSupplyQuerySchema,
  monthlyReportNotesSchema,
  problemReportGenerateSchema,
  problemReportNotesSchema,
  problemReportQuerySchema,
  responseSpeedQuerySchema,
  REFUSAL_REASON_LABELS,
  CLIENT_SOURCE_LABELS,
  canViewInvestigations,
  postShowingCohortConfigSchema,
  type RefusalReason,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { loadMoneyContext, roundMoney, toTjs } from "../lib/money.js";
import { dushanbeStartOfMonth, dushanbeEndOfDay, dushanbeDayRange } from "../lib/dushanbeTime.js";
import { generateMonthlyReport } from "../lib/monthlyReport.js";
import { collectPostShowingCohort } from "../lib/postShowingCohort.js";
import { projectMonthlyPublicInteractions } from "../lib/monthlyPublicProjection.js";
import { generateProblemReport } from "../lib/problemReport.js";
import { buildMarketingFunnel } from "../lib/marketingFunnel.js";
import { clientNamePhoneSafe, phoneSafeText } from "../lib/clientPhone.js";
import type { ProblemReportMetrics } from "@royal-home/shared";

/**
 * Закрывает свободный текст в ссылках отчёта «Проблемы» (22.09.2026). Имя
 * клиента и вырезка из разговора живут в metrics.sections[].links[].{label,hint}
 * (lib/problemReport.ts). phoneSafeText трогает только телефонные цепочки, так
 * что метки объектов и имена агентов остаются как есть.
 */
function maskProblemReport<T extends { metrics: unknown }>(report: T): T {
  const metrics = report.metrics as ProblemReportMetrics | null;
  if (!metrics?.sections) return report;
  return {
    ...report,
    metrics: {
      ...metrics,
      sections: metrics.sections.map((sec) => ({
        ...sec,
        links: sec.links.map((l) => ({ ...l, label: phoneSafeText(l.label, false), hint: phoneSafeText(l.hint, false) })),
      })),
    },
  };
}

/** Одно правило для GET и PATCH (ACCESS-04): без clients.viewPhone ссылки отчёта маскируются. */
function presentProblemReport<T extends { metrics: unknown }>(req: Request, report: T): T {
  return can(req, "clients.viewPhone") ? report : maskProblemReport(report);
}
import { countStuckConversationsByChannel } from "../lib/stuckConversations.js";
import { buildMarketingInsights } from "../lib/marketingInsights.js";
import { COUNTED_SHOWING_WHERE } from "../lib/tasks.js";
import { hotPropertiesNow } from "../lib/propertyInterest.js";
import { loadDemandSupply } from "../lib/demandSupply.js";
import { loadResponseSpeed } from "../lib/responseSpeed.js";
import { buildSecurityReviewDigest } from "../lib/securityReviewDigest.js";
import { logSystemError } from "../lib/systemError.js";

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requirePermission("reports.view"));

reportsRouter.get("/post-showing-cohort/config", requireInvestigations, requirePermission("clients.securityReview"), async (_req, res) => {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { postShowingCohortConfig: true } });
  res.json({ config: postShowingCohortConfigSchema.parse(settings.postShowingCohortConfig), classification: "OBSERVED_FOLLOWUP_COMPARISON", automaticVerdict: false });
});
reportsRouter.put("/post-showing-cohort/config", requireInvestigations, requirePermission("clients.securityReview"), async (req, res) => {
  const parsed = postShowingCohortConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте период, размеры выборок и пороги сравнения" });
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", postShowingCohortConfig: parsed.data }, update: { postShowingCohortConfig: parsed.data } });
  res.json({ config: parsed.data, classification: "OBSERVED_FOLLOWUP_COMPARISON", automaticVerdict: false });
});
reportsRouter.get("/post-showing-cohort", requireInvestigations, requirePermission("clients.securityReview"), async (req, res) => {
  const parsed = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).strict().safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный период" });
  try {
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { postShowingCohortConfig: true } });
    const config = postShowingCohortConfigSchema.parse(settings.postShowingCohortConfig);
    const now = new Date();
    const result = await collectPostShowingCohort(new Date(now.getTime() - (parsed.data.days ?? config.windowDays) * 86400000), now, now);
    res.json(can(req, "clients.viewPhone") ? result : { ...result, agents: result.agents.map(row => ({ ...row, agentName: phoneSafeText(row.agentName, false) })) });
  } catch { res.status(503).json({ evaluation: "DATA_UNAVAILABLE", error: "Источники статистики временно недоступны. Это не нулевая доля." }); }
});

/**
 * ЧЕМ ИНТЕРЕСУЮТСЯ ПРЯМО СЕЙЧАС (владелец 09.09.2026).
 *
 * Дословно: «я хочу видеть, каким объектом интересуются на данный момент больше
 * всего, чтобы запустить его на таргетинг». Это решение про деньги на рекламу,
 * принимается сегодня — поэтому окно короткое (по умолчанию неделя), а не месяц:
 * месячный срез отвечает на другой вопрос и живёт в отчёте (districtDemand).
 *
 * Считается по событиям интереса (lib/propertyInterest.ts), в выдаче — только
 * объекты в продаже: запускать рекламу на проданное незачем.
 */
const hotQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  // Предел выборки обязателен на любом роуте, отдающем массив.
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

reportsRouter.get("/hot-properties", async (req: Request, res: Response) => {
  const parsed = hotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Некорректные параметры", details: parsed.error.flatten() });
  }
  try {
    const items = await hotPropertiesNow(parsed.data.days, parsed.data.limit);
    return res.json({ days: parsed.data.days, items });
  } catch (err) {
    console.error("[отчёты] интерес к объектам:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Не удалось посчитать интерес к объектам" });
  }
});

/**
 * СПРОС ПРОТИВ ПРЕДЛОЖЕНИЯ (владелец, 03.10.2026): матрица «район × комнаты» —
 * сколько ждущих покупателей ищут и сколько квартир в продаже, с выводом «не
 * хватает объектов» / «много предложения». Считается на лету по текущим желаниям
 * клиентов и объектам в продаже (истории спроса в базе нет — это срез «на сейчас»).
 */
reportsRouter.get("/demand-supply", async (req: Request, res: Response) => {
  const parsed = demandSupplyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Некорректные параметры", details: parsed.error.flatten() });
  }
  try {
    return res.json(await loadDemandSupply(parsed.data.unsoughtLimit));
  } catch (err) {
    console.error("[отчёты] спрос и предложение:", err instanceof Error ? err.message : err);
    void logSystemError("api", `Отчёт «Спрос и предложение»: не посчитан — ${err instanceof Error ? err.message : String(err)}`);
    return res.status(500).json({ error: "Не удалось посчитать спрос и предложение" });
  }
});

/**
 * СКОРОСТЬ ОТВЕТА ПРОТИВ ДОХОДА ДО ПОКАЗА (владелец, 03.10.2026): доля обращений,
 * дошедших до показа или сделки, по корзинам времени до первого ответа агента
 * (Client.firstContactAt). Ответы бота в метку не попадают — см. lib/responseSpeed.ts.
 */
reportsRouter.get("/response-speed", async (req: Request, res: Response) => {
  const parsed = responseSpeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Некорректные параметры", details: parsed.error.flatten() });
  }
  try {
    return res.json(await loadResponseSpeed(parsed.data.days));
  } catch (err) {
    console.error("[отчёты] скорость ответа:", err instanceof Error ? err.message : err);
    void logSystemError("api", `Отчёт «Скорость ответа»: не посчитан — ${err instanceof Error ? err.message : String(err)}`);
    return res.status(500).json({ error: "Не удалось посчитать скорость ответа" });
  }
});

// Потолок ширины периода from/to (22.09.2026, класс «Пагинация»): без него
// строку запроса можно было отправить с from=2000-01-01 — окно без верхней
// границы шириной, а не только без верхней границы ДАТ. Тот же потолок, что и
// months в expenses.ts (60 месяцев) — отчёты этого раздела не задуманы дальше.
const MAX_RANGE_MONTHS = 60;
const MAX_RANGE_MS = MAX_RANGE_MONTHS * 31 * 24 * 60 * 60 * 1000;

function parseRange(query: Record<string, unknown>) {
  const parsed = dateRangeQuerySchema.parse(query);
  const to = parsed.to ?? new Date();
  // "from"/"to" приходят как YYYY-MM-DD (полночь UTC при разборе строки в Date) —
  // сдвигаем оба конца на границы суток по ДУШАНБЕ, иначе теряется 5-часовое окно
  // (19:00–00:00 UTC), которое в Душанбе уже следующий день: «с 1 августа» на деле
  // начинался в 05:00 по Душанбе, и Отчёты с Главной (которая считает через
  // dushanbeStartOfMonth) расходились в цифрах за один и тот же месяц.
  const to_ = dushanbeEndOfDay(to);
  let from = parsed.from ? dushanbeDayRange(parsed.from).start : dushanbeStartOfMonth();
  if (to_.getTime() - from.getTime() > MAX_RANGE_MS) {
    from = new Date(to_.getTime() - MAX_RANGE_MS);
  }
  return { from, to: to_ };
}

/** Потолок строк для агрегатов /funnel и /sources (22.09.2026, класс «Пагинация»).
 *  Период уже ограничен MAX_RANGE_MONTHS, но число строк в нём ничем не
 *  ограничено — с большим запасом над реальным темпом этого агентства. */
const REPORTS_ROW_LIMIT = 20_000;

reportsRouter.get("/funnel", async (req, res) => {
  const { from, to } = parseRange(req.query);

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
      where: { ...visibleInteractionWhere(req.agent?.role), type: { in: ["CALL", "MESSAGE", "MEETING"] }, createdAt: { gte: from, lte: to }, client: { deletedAt: null } },
    }),
    // COUNTED_SHOWING_WHERE — отменённый показ не состоялся, и в воронке ему не
    // место: иначе шаг «Показы» шире шага «На контакте» на встречи, которых не было.
    prisma.interaction.count({
      where: { ...visibleInteractionWhere(req.agent?.role), type: "SHOWING", ...COUNTED_SHOWING_WHERE, createdAt: { gte: from, lte: to }, client: { deletedAt: null } },
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

  res.json({
    from,
    to,
    funnel: [
      { key: "leads", label: "Новые лиды", count: newLeads },
      { key: "contacted", label: "На контакте", count: contactedClientIds.length },
      { key: "showings", label: "Показы", count: showings },
      { key: "negotiations", label: "Переговоры", count: negotiations },
      // Деньги — только с правом на финансы (аудит 23.09.2026, №44): отчёты
      // открыты маркетингу и службе безопасности, комиссия им не положена.
      { key: "deals", label: "Сделки", count: dealsCount, commission: can(req, "finance.view") ? commission : null },
    ],
  });
});

reportsRouter.get("/agents", async (req, res) => {
  const { from, to } = parseRange(req.query);

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
        ...visibleInteractionWhere(req.agent?.role),
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
        ...visibleInteractionWhere(req.agent?.role),
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

  const seesMoney = can(req, "finance.view");
  const rows = agents.map((agent) => {
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
      commission: seesMoney ? roundMoney(stats?.commission ?? 0) : null,
    };
  });

  res.json(rows);
});

reportsRouter.get("/sources", async (req, res) => {
  const { from, to } = parseRange(req.query);

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

  res.json({
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
  });
});

/**
 * Полная воронка расход → лиды → показы → сделки → комиссия, по каналу
 * (01.09.2026, «один экран маркетолога» — план из 20.08.2026). Функция
 * buildMarketingFunnel уже год как готова и жила только внутри mission-control
 * (dashboardMissionControl.ts) урезанной до топ-3 каналов и четырёх полей —
 * там сам комментарий обещал «полная воронка — в /reports/sources», но роута
 * для неё не было вовсе. Здесь тот же builder, без урезания, под гейтом
 * reports.view (аудитория Sources.tsx — ADMIN/MANAGER), а не под
 * dashboard.analytics/ADMIN-DIRECTOR-only mission-control.
 *
 * Деньги — только когда seesMoney (finance.view), ровно как и everywhere else
 * в money-полях buildMarketingFunnel.
 */
reportsRouter.get("/marketing-funnel", async (req, res) => {
  const seesMoney = can(req, "finance.view");
  const result = await buildMarketingFunnel(seesMoney, new Date());
  res.json(result);
});

/** Сколько дней назад считаем «потерянных» — раздел «Потерянные клиенты»
 *  (GET /clients/lost) терминальный и без предела времени, здесь же нужен
 *  срез ЗА ПЕРИОД, сопоставимый с воронкой (месяц слишком редкое событие для
 *  большинства каналов — 90 дней даёт достаточно строк для вывода). */
const LOST_BY_CHANNEL_DAYS = 90;

/**
 * «Где теряем клиентов», по каналу (01.09.2026, «один экран маркетолога»).
 *
 * Статус LOST — предел передач исчерпан (см. документацию GET /clients/lost) —
 * терминальный факт, не оценка клиента. Здесь тот же признак, сведённый по
 * Client.source: канал с непропорционально высокой долей потерь — сигнал не
 * маркетингу «плохой канал», а компании «плохо обрабатываем этот канал».
 * Под reports.view (аудитория экрана), а не clients.assign, которым гейтится
 * сам полный список — маркетологу нужны цифры по каналу, не карточки поимённо.
 */
reportsRouter.get("/lost-by-channel", async (req, res) => {
  const since = new Date(Date.now() - LOST_BY_CHANNEL_DAYS * 24 * 60 * 60 * 1000);
  const [lostRows, totalRows] = await Promise.all([
    prisma.client.groupBy({
      by: ["source", "refusalReason"],
      where: { status: "LOST", deletedAt: null, escalatedAt: { gte: since } },
      _count: { _all: true },
    }),
    // Знаменатель для доли — все лиды канала за тот же период (не только потерянные),
    // иначе «5 потерь» ничего не говорит без «из скольки».
    prisma.client.groupBy({
      by: ["source"],
      where: { deletedAt: null, createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const totalBySource = new Map<string, number>(totalRows.map((r) => [r.source as string, r._count._all]));
  const bySource = new Map<string, { lost: number; reasons: Map<string, number> }>();
  for (const row of lostRows) {
    const entry = bySource.get(row.source) ?? { lost: 0, reasons: new Map<string, number>() };
    entry.lost += row._count._all;
    if (row.refusalReason) {
      entry.reasons.set(row.refusalReason, (entry.reasons.get(row.refusalReason) ?? 0) + row._count._all);
    }
    bySource.set(row.source, entry);
  }

  const channels = [...bySource.entries()]
    .map(([source, entry]) => {
      const topReason = [...entry.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const totalLeads = totalBySource.get(source) ?? 0;
      return {
        source,
        label: CLIENT_SOURCE_LABELS[source as keyof typeof CLIENT_SOURCE_LABELS] ?? source,
        lost: entry.lost,
        totalLeads,
        // Доля от лидов ТОГО ЖЕ периода — не от общего числа потерь, иначе канал
        // с одним лидом и одной потерей выглядел бы как «100% всех потерь».
        lostShare: totalLeads > 0 ? Math.round((entry.lost / totalLeads) * 100) : null,
        topReason: topReason ? (REFUSAL_REASON_LABELS[topReason as RefusalReason] ?? topReason) : null,
      };
    })
    .sort((a, b) => b.lost - a.lost);

  res.json({ days: LOST_BY_CHANNEL_DAYS, channels });
});

/**
 * «Сейчас ждут ответа», по каналу (01.09.2026, «один экран маркетолога»).
 *
 * ЧЕСТНАЯ ЗАМЕНА «СКОРОСТИ ОТВЕТА» — которую посчитать нельзя (BotConversation.
 * messages — JSON-блоб без времени на каждую реплику, per-message timestamp
 * в схеме нет, заводить его отдельной миграцией ради одной плитки на этом
 * экране — риск не по размеру задачи, формат используется много где).
 * Вместо исторической ССЫЛКА НА ФАКТ ПРЯМО СЕЙЧАС: те же диалоги, что находит
 * findStuckConversations (последнее сообщение — от клиента, бот его ещё не
 * обработал), сгруппированные по каналу — «где именно клиенты копятся без
 * ответа», не «средняя скорость за месяц». Живой снимок, не аналитика задним
 * числом — заголовок на фронте должен называть это правильно.
 */
reportsRouter.get("/waiting-now", async (_req, res) => {
  // COUNT по каналам, а не длина выборки (02.10.2026): findStuckConversations
  // режется на 200 строк, и в тяжёлый день «Сейчас ждут» упиралось в 200.
  const counts = await countStuckConversationsByChannel();
  const now = Date.now();
  const channels = counts
    .map((row) => ({
      source: row.channel,
      label: CLIENT_SOURCE_LABELS[row.channel as keyof typeof CLIENT_SOURCE_LABELS] ?? row.channel,
      waiting: row.count,
      longestMinutes: Math.max(0, Math.round((now - new Date(row.oldestAt).getTime()) / 60000)),
    }))
    .sort((a, b) => b.waiting - a.waiting);

  res.json({ channels, totalWaiting: channels.reduce((sum, c) => sum + c.waiting, 0) });
});

/**
 * ИИ-разбор маркетинга (см. lib/marketingInsights.ts) — читает воронку, потери
 * по каналам, очередь без ответа и дословные возражения клиентов, отдаёт
 * headline + 3-5 связанных наблюдений. Кэш на 6 часов; force=1 — «Обновить
 * разбор» пересобирает сейчас (та же кнопка, что у /ads/insights).
 */
reportsRouter.get("/marketing-insights", async (req, res) => {
  const seesMoney = can(req, "finance.view");
  const result = await buildMarketingInsights(seesMoney, req.query.force === "1");
  if (!result) return res.json({ headline: null, insights: [] });
  const parsed = JSON.parse(result.text) as { headline: string; insights: string[] };
  res.json({ ...parsed, builtAt: result.builtAt, cached: result.cached });
});

/**
 * Месячные отчёты руководству (примечание владельца от 30.07).
 *
 * Цифры — снапшот на момент составления, заметки владелец правит когда угодно.
 * Отдельное право не заводим: отчёты и так под reports.view, а видеть месячный
 * итог должны те же люди, что и остальную аналитику.
 */
/** Снимок месячного отчёта без денег: комиссия, расходы и комиссия по агентам — null. */
export function withoutMoney(metrics: unknown): unknown {
  if (!metrics || typeof metrics !== "object") return metrics;
  const m = metrics as Record<string, unknown>;
  return {
    ...m,
    commission: null,
    expenses: null,
    agents: Array.isArray(m.agents)
      ? m.agents.map((a) => (a && typeof a === "object" ? { ...(a as object), commission: null } : a))
      : m.agents,
  };
}

reportsRouter.get("/monthly", async (req, res) => {
  const reports = await prisma.monthlyReport.findMany({
    orderBy: { periodStart: "desc" },
    // Год истории: дальше отчёты интересны точечно, а не списком.
    take: 12,
    include: { updatedBy: { select: { fullName: true } } },
  });
  // Комиссия и расходы месяца — только с правом на финансы (аудит 23.09.2026, №44).
  res.json(await Promise.all(reports.map((r) => presentMonthlyReport(req, r))));
});

/** Комиссия и расходы месяца — только с правом на финансы. Одна функция и для
 *  GET, и для PATCH заметок: ответ записи отдавал строку целиком, и аналитик без
 *  finance.view получал деньги, закрытые в списке (аудит Codex 04.10.2026, ACCESS-04). */
async function presentMonthlyReport<T extends { metrics: unknown; periodStart: Date }>(req: Request, report: T): Promise<T> {
  let metrics = report.metrics;
  // Historical snapshots retain their source evidence. Strip it at every read boundary,
  // independently from finance grants and without hiding the ordinary monthly figures.
  if ((!canViewInvestigations(req.agent?.role) || !can(req, "clients.securityReview")) && metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
    const { postShowingSilence: _private, postShowingCohort: _cohort, ...ordinary } = metrics as Record<string, unknown>;
    metrics = await projectMonthlyPublicInteractions(ordinary, report.periodStart);
  }
  if (!can(req, "clients.viewPhone") && metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
    const source = { ...metrics } as Record<string, unknown>;
    for (const key of ["postShowingSilence", "postShowingCohort"]) {
      const section = source[key];
      if (section && typeof section === "object" && !Array.isArray(section)) {
        const value = section as Record<string, unknown>;
        if (Array.isArray(value.agents)) source[key] = { ...value, agents: value.agents.map(row => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return row;
          const agent = row as Record<string, unknown>;
          return typeof agent.agentName === "string" ? { ...agent, agentName: phoneSafeText(agent.agentName, false) } : row;
        }) };
      }
    }
    metrics = source;
    const section = source.postShowingSilence;
    if (section && typeof section === "object" && !Array.isArray(section)) {
      const sectionRecord = section as Record<string, unknown>;
      const evidence = sectionRecord.provableCase;
      if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
        const safeEvidence = { ...evidence } as Record<string, unknown>;
        for (const key of ["clientName", "agentName", "propertyTitle", "quote", "what"]) {
          if (typeof safeEvidence[key] === "string") safeEvidence[key] = phoneSafeText(safeEvidence[key], false);
        }
        metrics = { ...source, postShowingSilence: { ...sectionRecord, provableCase: safeEvidence } };
      }
    }
  }
  return { ...report, metrics: can(req, "finance.view") ? metrics : withoutMoney(metrics) };
}

/** Собрать отчёт за прошлый месяц немедленно — на случай, если ждать первого числа
 *  не хочется (например, первый запуск после внедрения). Повторный вызов ничего не
 *  дублирует и не трогает уже написанные заметки. */
reportsRouter.post("/monthly/generate", requirePermission("dashboard.analytics"), async (_req, res) => {
  const result = await generateMonthlyReport();
  res.json(result);
});

reportsRouter.patch("/monthly/:id", requirePermission("dashboard.analytics"), async (req, res) => {
  const parsed = monthlyReportNotesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const existing = await prisma.monthlyReport.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Отчёт не найден" });

  const updated = await prisma.monthlyReport.update({
    where: { id: existing.id },
    // Пустая строка — очистить заметки; undefined сюда не доходит (схема требует поле).
    data: { notes: parsed.data.notes.trim() || null, updatedById: req.agent!.id },
    include: { updatedBy: { select: { fullName: true } } },
  });
  res.json(await presentMonthlyReport(req, updated));
});

/**
 * РАЗБОР ПРОБЛЕМНЫХ МЕСТ (решение владельца 11.08.2026) — еженедельный и
 * ежемесячный. Отдельного права не заводим по той же причине, что и у месячного
 * отчёта: это управленческий документ, и видеть его должны те же люди, что и
 * остальную аналитику (reports.view стоит на всём роутере выше).
 *
 * Собирает и правит — только тот, кто отвечает за аналитику (dashboard.analytics),
 * ровно как у месячного отчёта.
 */
reportsRouter.get("/problems", async (req, res) => {
  const parsed = problemReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  const reports = await prisma.problemReport.findMany({
    where: { period: parsed.data.period },
    orderBy: { periodStart: "desc" },
    // Потолок обязателен. Двенадцать — год месячных отчётов или квартал недельных:
    // дальше в историю ходят точечно, а не листая список.
    take: 12,
    include: { updatedBy: { select: { fullName: true } } },
  });
  // Отчёт открыт правом reports.view (менеджер, маркетинг, СБ) — clients.viewPhone
  // из них нет ни у кого (22.09.2026). В ссылках раздела «Разговоры без
  // следующего шага» label — имя клиента, hint — вырезка из разговора
  // (lib/problemReport.ts): свободный текст с возможным номером. Метка объекта
  // (№12345) и имя агента под маску не попадают — порог 9 цифр.
  res.json(reports.map((r) => presentProblemReport(req, r)));
});

/** Собрать отчёт немедленно, не дожидаясь понедельника или первого числа (первый
 *  запуск после внедрения, проверка после правки настроек). Повторный вызов ничего
 *  не дублирует и не трогает заметки. Выключенный в Настройках отчёт не собирается
 *  и здесь — выключатель означает «не собирать», а не «не присылать пуш». */
reportsRouter.post("/problems/generate", requirePermission("dashboard.analytics"), async (req, res) => {
  const parsed = problemReportGenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Укажите период отчёта", details: parsed.error.flatten() });
  }
  // immediate:true — руководитель сам нажал «Собрать сейчас», ждать часов
  // алармов не нужно (владелец 07.09.2026, см. doc-comment у generateProblemReport).
  const result = await generateProblemReport(parsed.data.period, new Date(), true);
  if (result.reason === "disabled") {
    return res.status(409).json({ error: "Этот отчёт выключен в Настройках → Данные и система" });
  }
  res.json(result);
});

reportsRouter.patch("/problems/:id", requirePermission("dashboard.analytics"), async (req, res) => {
  const parsed = problemReportNotesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const existing = await prisma.problemReport.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Отчёт не найден" });

  const updated = await prisma.problemReport.update({
    where: { id: existing.id },
    // Пустая строка — очистить заметки (undefined сюда не доходит: схема требует поле).
    data: {
      notes: parsed.data.notes.trim() || null,
      notesVoiceUrl: parsed.data.notesVoiceUrl ?? null,
      notesVoiceTranscript: parsed.data.notesVoiceTranscript ?? null,
      updatedById: req.agent!.id,
    },
    include: { updatedBy: { select: { fullName: true } } },
  });
  res.json(presentProblemReport(req, updated));
});

/**
 * НЕДЕЛЬНАЯ СВОДКА СБ (03.09.2026, план §E, п. 2) — «43 отказа за неделю, 5 со
 * сделкой на стороне, из них 3 у Фарруха — у остальных агентов 0-1». Не
 * заменяет очередь по одной карточке (routes/security.ts, «Клиенты в СБ»/
 * «Потерянные объекты») — добавка сверху: аномалия видна сразу, не открывая
 * каждую карточку по очереди.
 *
 * Право — reports.view (то же, что у остального роутера), НЕ clients.securityReview:
 * «пока СБ нет отдельным человеком, сводку видит всё руководство» (решение
 * владельца, план §E). Кабинет routes/security.ts по-прежнему требует
 * clients.securityReview отдельно — это разные права для разных экранов.
 *
 * Без query-параметров — стандартная неделя (см. defaultWeeklyRange в
 * lib/securityReviewDigest.ts), НЕ месяц по умолчанию, как у /funnel и /agents
 * (parseRange выше): сводка по смыслу недельная, молчаливый месячный дефолт
 * удивил бы того, кто открыл её без параметров, ожидая неделю.
 */
reportsRouter.get("/security-review-digest", requireInvestigations, async (req, res) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  // Без параметров — buildSecurityReviewDigest сам берёт стандартную неделю
  // (defaultWeeklyRange). С параметрами — те же границы суток по Душанбе, что
  // и у parseRange выше (dushanbeDayRange/dushanbeEndOfDay), а не сырой UTC
  // из z.coerce.date(): «from=2026-09-01» обязан значить начало ЭТИХ суток в
  // Душанбе, а не UTC-полночь, съедающую первые пять часов дня.
  const range =
    parsed.data.from || parsed.data.to
      ? {
          to: dushanbeEndOfDay(parsed.data.to ?? new Date()),
          from: parsed.data.from
            ? dushanbeDayRange(parsed.data.from).start
            : new Date(dushanbeEndOfDay(parsed.data.to ?? new Date()).getTime() - 7 * 24 * 60 * 60 * 1000),
        }
      : undefined;
  const digest = await buildSecurityReviewDigest(range);
  // Тот же гейт reports.view без clients.viewPhone (22.09.2026): имя клиента и
  // дословная цитата из разговора — свободный текст, где клиент диктует номер.
  const canSeePhone = can(req, "clients.viewPhone");
  res.json(
    canSeePhone
      ? digest
      : {
          ...digest,
          cases: digest.cases.map((c) => ({
            ...c,
            clientFullName: c.clientFullName ? clientNamePhoneSafe(c.clientFullName, false) : c.clientFullName,
            quote: phoneSafeText(c.quote, false),
          })),
        }
  );
});
