import {
  PROPERTY_PIPELINE_STATUSES,
  REFUSAL_REASON_LABELS,
  pluralizeRu,
  type ProblemBreakdown,
  type ProblemLink,
  type ProblemMetric,
  type ProblemPeriod,
  type ProblemReportMetrics,
  type ProblemSection,
  type ProblemSectionKey,
  type PropertyStatus,
  type RefusalReason,
  RATED_ROLES,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import {
  DUSHANBE_OFFSET_MS,
  dushanbeStartOfMonth,
  dushanbeStartOfToday,
  dushanbeWallClock,
} from "./dushanbeTime.js";
import { sendPushToAgent } from "../push.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { AWAITING_REVIEW_WHERE } from "./telephony/awaitingReview.js";
import {
  CATEGORY_OF,
  ROYAL_SCORE_CATEGORIES,
  loadEventPoints,
  SCORE_OVERRIDE_PREFIX,
  SCORE_OVERRIDE_REVERT_PREFIX,
  type RoyalScoreCategoryKey,
  type ScoreEventKind,
} from "./scoreJournal.js";
import { MIN_PROPERTY_PHOTOS, loadPipelineDeadlines, stageState } from "./propertyPipeline.js";
import { isInstagramLink } from "./instagramLink.js";
import { computeDemandCounts } from "../routes/matching.js";

/**
 * РАЗБОР ПРОБЛЕМНЫХ МЕСТ — еженедельный и ежемесячный.
 *
 * Решение владельца 11.08.2026: «крупный отчёт по всем проблемным местам агентов и
 * клиентов, чтобы понять, где происходит потеря контакта клиента, агента и так
 * далее… красиво оформленное».
 *
 * ЗДЕСЬ ПОЧТИ НИЧЕГО НЕ СЧИТАЕТСЯ ЗАНОВО. Все четыре раздела собраны из того, что
 * CRM уже пишет по ходу работы: разборы оборванных переписок (lostConversations.ts),
 * журнал Royal Score (scoreJournal.ts — он и есть летопись просрочек, отказов и
 * сорванных первых звонков), журнал входящих, разбор разговоров (CallAnalysis),
 * конвейер подготовки объектов и счётчик спроса. Своя арифметика поверх этих
 * источников означала бы, что отчёт и экраны CRM показывают разные числа про одну
 * и ту же неделю — так уже расходились Отчёты с Финансами.
 *
 * ЧТО ИМЕННО НУЖНО ВЛАДЕЛЬЦУ — НЕ ТАБЛИЦА. Поэтому у каждого раздела есть вывод
 * одной фразой, направление против прошлого периода той же длины и ссылки прямо на
 * проблемные карточки: из отчёта надо иметь возможность пойти и починить, а не
 * выписывать фамилии на бумажку.
 *
 * ЦИФРЫ — СНАПШОТ. Разобранный позже звонок и заполненное позже окно не должны
 * задним числом «исправлять» неделю, в которой они висели непрочитанными.
 */

/** Сколько карточек показываем ссылками в одном разделе. Шесть — это столько,
 *  сколько человек реально откроет за один заход; двадцать он пролистает. */
const LINKS_PER_SECTION = 6;
/** Потолок выборки отказов, из которых считается топ причин. Отказов за месяц
 *  десятки, но предел обязателен: маршрут без потолка однажды вернёт всё. */
const REFUSAL_SAMPLE = 1000;
/** Сколько объектов смотрим при подсчёте «застряли»/«без спроса». Каталог
 *  агентства меньше на порядок, а спрос считается перебором пар клиент×объект. */
const PROPERTY_SCAN_LIMIT = 500;

interface Range {
  from: Date;
  to: Date;
}

/** Контекст сборки: оба периода сразу и то, как называть прошлый период словами. */
interface BuildContext {
  period: ProblemPeriod;
  current: Range;
  previous: Range;
  /** «неделей раньше» / «месяцем раньше» — для фраз вывода. */
  ago: string;
}

function within(range: Range) {
  return { gte: range.from, lt: range.to };
}

/**
 * Границы отчётного периода по Душанбе и такой же по длине предыдущий.
 *
 * Только через dushanbeTime: контейнер живёт в UTC, и setHours сдвинул бы неделю на
 * пять часов — события вечера воскресенья уехали бы в соседний отчёт.
 *
 * Неделя — семь суток ДО сегодняшней полуночи (сегодняшний день ещё не кончился, и
 * включать его в отчёт значит сравнивать неполный день с полными). Месяц —
 * предыдущий календарный.
 */
export function problemPeriodRanges(period: ProblemPeriod, now: Date = new Date()): {
  current: Range;
  previous: Range;
} {
  if (period === "week") {
    const to = dushanbeStartOfToday(now);
    const from = new Date(to.getTime() - 7 * 86400_000);
    return {
      current: { from, to },
      previous: { from: new Date(from.getTime() - 7 * 86400_000), to: from },
    };
  }
  const thisMonth = dushanbeStartOfMonth(now);
  const from = shiftMonths(thisMonth, -1);
  return {
    current: { from, to: thisMonth },
    previous: { from: shiftMonths(from, -1), to: from },
  };
}

/** Сдвиг на N календарных месяцев по НАСТЕННОМУ календарю Душанбе: складывать
 *  «тридцать суток» нельзя — февраль и июль разной длины, и отчёты поехали бы. */
function shiftMonths(monthStart: Date, delta: number): Date {
  const wall = dushanbeWallClock(monthStart);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + delta, 1) - DUSHANBE_OFFSET_MS);
}

function metric(
  key: string,
  label: string,
  value: number,
  previous: number | null,
  href: string | null,
  hint?: string
): ProblemMetric {
  return { key, label, value, previous, href, ...(hint ? { hint } : {}) };
}

/** Насколько показатель изменился словами. Пустая строка — сравнивать не с чем. */
function trendPhrase(value: number, previous: number | null, ago: string): string {
  if (previous === null) return "";
  const diff = value - previous;
  if (diff === 0) return `столько же, сколько ${ago}`;
  const word = diff > 0 ? "больше" : "меньше";
  return `на ${Math.abs(diff)} ${word}, чем ${ago}`;
}

/**
 * Собирает раздел: направление считается ТОЛЬКО по сравнимым показателям.
 *
 * Показатели «на сейчас» (объекты в подготовке, объекты без спроса) в сумму не
 * входят: их прошлое значение восстановить нечем, и подмешивание их текущего
 * значения в обе чаши весов делало бы динамику всегда «так же».
 */
function assembleSection(input: {
  key: ProblemSectionKey;
  title: string;
  metrics: ProblemMetric[];
  links: ProblemLink[];
  breakdown?: ProblemBreakdown | null;
  /** Вывод фразой: получает самый крупный сравнимый показатель раздела. */
  headline: (worst: ProblemMetric | null, trend: string) => string;
  ago: string;
}): ProblemSection {
  const comparable = input.metrics.filter((m) => m.previous !== null);
  const total = comparable.reduce((s, m) => s + m.value, 0);
  const previousTotal = comparable.reduce((s, m) => s + (m.previous ?? 0), 0);
  const worst = [...input.metrics].sort((a, b) => b.value - a.value)[0] ?? null;
  const direction = total === previousTotal ? "same" : total > previousTotal ? "worse" : "better";
  return {
    key: input.key,
    title: input.title,
    headline: input.headline(worst && worst.value > 0 ? worst : null, trendPhrase(total, previousTotal, input.ago)),
    total,
    previousTotal,
    direction,
    metrics: input.metrics,
    links: input.links,
    breakdown: input.breakdown ?? null,
  };
}

/* ────────────────────────── 1. Где теряются клиенты ────────────────────────── */

/** Виды событий журнала, означающие сорванный первый звонок (второй — устаревший
 *  синоним, но в старых записях он ещё встречается и терять его нельзя). */
const MISSED_FIRST_CALL: ScoreEventKind[] = ["call_15min_missed", "lead_missed"];
const CLIENT_LOST: ScoreEventKind[] = ["client_lost_agent_fault", "client_lost_no_fault"];
/** Не строка переопределения (sourceId может быть null — NOT по nullable-полю его бы потерял). */
const NOT_OVERRIDE_ROW = {
  OR: [{ sourceId: null }, { NOT: { sourceId: { startsWith: SCORE_OVERRIDE_PREFIX } } }],
};

async function buildClientsSection(ctx: BuildContext): Promise<ProblemSection> {
  const cur = within(ctx.current);
  const prev = within(ctx.previous);

  const [
    botLost,
    botLostPrev,
    unaccepted,
    unacceptedPrev,
    missedCalls,
    missedCallsPrev,
    refusals,
    refusalsPrev,
    escalated,
    escalatedPrev,
    lost,
    lostPrev,
    refusalRows,
    escalatedClients,
  ] = await Promise.all([
    // Оборванные диалоги бота — уже разобраны ночным джобом (lostConversations.ts),
    // считать их заново нечем и незачем.
    prisma.lostConversation.count({ where: { lastMessageAt: cur } }),
    prisma.lostConversation.count({ where: { lastMessageAt: prev } }),
    // Лид пришёл и остался непринятым: карточка есть, а работы по ней не начиналось.
    // kind OTHER не считается — такие обращения агентам не раздаются вовсе.
    // assignedAgentId: not null — иначе сюда попадали лиды, которые просто ждут
    // раздачи волной в 10:00 (см. dashboard.ts team-live, тот же баг был там).
    prisma.client.count({ where: { createdAt: cur, acceptedAt: null, assignedAgentId: { not: null }, deletedAt: null, kind: { not: "OTHER" } } }),
    prisma.client.count({ where: { createdAt: prev, acceptedAt: null, assignedAgentId: { not: null }, deletedAt: null, kind: { not: "OTHER" } } }),
    prisma.royalScoreEvent.count({ where: { kind: { in: MISSED_FIRST_CALL }, at: cur } }),
    prisma.royalScoreEvent.count({ where: { kind: { in: MISSED_FIRST_CALL }, at: prev } }),
    // Отказы берём из журнала действий: у Client.refusalReason нет времени, и по
    // нему нельзя сказать, в каком периоде отказ случился.
    prisma.auditLog.count({ where: { action: "CLIENT_REFUSE", createdAt: cur } }),
    prisma.auditLog.count({ where: { action: "CLIENT_REFUSE", createdAt: prev } }),
    prisma.client.count({ where: { escalatedAt: cur, deletedAt: null } }),
    prisma.client.count({ where: { escalatedAt: prev, deletedAt: null } }),
    // Строки переопределения директором (отмена + новый вид) — поправка той же
    // потери, а не ещё две: без фильтра один клиент считался трижды (C3, 02.10.2026).
    prisma.royalScoreEvent.count({ where: { kind: { in: CLIENT_LOST }, at: cur, ...NOT_OVERRIDE_ROW } }),
    prisma.royalScoreEvent.count({ where: { kind: { in: CLIENT_LOST }, at: prev, ...NOT_OVERRIDE_ROW } }),
    prisma.auditLog.findMany({
      where: { action: "CLIENT_REFUSE", createdAt: cur },
      select: { meta: true },
      orderBy: { createdAt: "desc" },
      take: REFUSAL_SAMPLE,
    }),
    prisma.client.findMany({
      where: { escalatedAt: cur, deletedAt: null },
      select: { shortId: true, fullName: true, refusalReason: true, status: true, escalatedAt: true },
      orderBy: { escalatedAt: "desc" },
      take: LINKS_PER_SECTION,
    }),
  ]);

  // Топ причин отказов. Причина лежит в meta записи журнала — ключ из REFUSAL_REASONS.
  const reasonCounts = new Map<string, number>();
  for (const row of refusalRows) {
    const reason = (row.meta as { reason?: string } | null)?.reason;
    if (!reason) continue;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const breakdown: ProblemBreakdown | null = reasonCounts.size
    ? {
        title: "Почему отказывались",
        rows: [...reasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => ({
            label: REFUSAL_REASON_LABELS[reason as RefusalReason] ?? reason,
            count,
          })),
      }
    : null;

  const metrics = [
    metric("botLost", "Диалоги бота оборвались без заявки", botLost, botLostPrev, "/settings?tab=bot",
      "Человек написал, поговорил и ушёл, не оставив номер"),
    metric("unaccepted", "Лиды так и не приняты агентом", unaccepted, unacceptedPrev, "/clients",
      "Карточка заведена, но работа по ней не начиналась"),
    metric("missedCalls", "Первый звонок не сделан вовремя", missedCalls, missedCallsPrev, null,
      "Лид принят, но за отведённые минуты агент не позвонил"),
    metric("refusals", "Отказы клиентов", refusals, refusalsPrev, null),
    metric("escalated", "Переданы руководству (никто не взял)", escalated, escalatedPrev, "/lost-clients"),
    metric("lost", "Клиенты потеряны окончательно", lost, lostPrev, "/lost-clients"),
  ];

  return assembleSection({
    key: "clients",
    title: "Где теряются клиенты",
    metrics,
    breakdown,
    links: escalatedClients.map((c) => ({
      label: c.fullName,
      hint: c.refusalReason
        ? `Передан руководству — ${REFUSAL_REASON_LABELS[c.refusalReason as RefusalReason] ?? c.refusalReason}`
        : "Передан руководству — никто не принял лид",
      href: `/clients/${c.shortId}`,
    })),
    ago: ctx.ago,
    headline: (worst, trend) =>
      worst
        ? `Больше всего теряем здесь: ${worst.label.toLowerCase()} — ${worst.value}. Всего потерь ${trend || "не с чем сравнить"}.`
        : "Потерь за период не зафиксировано — ни оборванных диалогов, ни непринятых лидов.",
  });
}

/* ─────────────────────── 2. Кто из агентов проседает ─────────────────────── */

/** Просрочки и отказы агента — то, из чего складывается «проседает». */
const AGENT_FAIL_KINDS: Record<string, ScoreEventKind[]> = {
  windows: ["mandatory_window_overdue"],
  tasks: ["task_overdue", "showing_missed", "meeting_overdue"],
  declines: ["lead_declined_2", "lead_declined_3", "lead_declined_4plus"],
  missedCalls: MISSED_FIRST_CALL,
};

async function buildAgentsSection(ctx: BuildContext): Promise<ProblemSection> {
  const cur = within(ctx.current);
  const prev = within(ctx.previous);

  const [events, eventsPrev, stale, points, agents, prevReport, overrideReverts] = await Promise.all([
    // groupBy, а не выборка строк: событий за месяц тысячи, и тянуть их в память
    // ради подсчёта нельзя. Один запрос на всю команду вместо запроса на агента.
    prisma.royalScoreEvent.groupBy({ by: ["agentId", "kind"], where: { at: cur }, _count: { _all: true } }),
    prisma.royalScoreEvent.groupBy({ by: ["agentId", "kind"], where: { at: prev }, _count: { _all: true } }),
    // Клиенты без движения: в работе у агента, а последнего касания не было за
    // весь период. Именно это владелец и называет «потерей контакта».
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: {
        deletedAt: null,
        assignedAgentId: { not: null },
        acceptedAt: { not: null },
        status: { in: ["NEW", "CONTACTED", "HOT"] },
        lastContactAt: { lt: ctx.current.from },
      },
      _count: { _all: true },
    }),
    loadEventPoints(),
    prisma.agent.findMany({ where: { role: { in: [...RATED_ROLES] } }, select: { id: true, fullName: true } }),
    /**
     * «Прошлое» значение показателя stale — из СОХРАНЁННОГО отчёта за прошлый
     * период, а не пересчётом по сегодняшним карточкам (26.08.2026). Прежний
     * groupBy с lastContactAt < previous.from читал ТЕКУЩИЕ статусы и назначения
     * клиентов: карточка, закрытая или переданная на этой неделе, задним числом
     * выпадала из «прошлого», и тренд better/worse искажался. Отчёта за прошлый
     * период нет (первый запуск) — previous честно null, как у показателей
     * «на сейчас».
     */
    prisma.problemReport.findFirst({
      where: { period: ctx.period, periodStart: ctx.previous.from },
      orderBy: { createdAt: "desc" },
      select: { metrics: true },
    }),
    // Строки-отмены переопределения вины (C3): в groupBy выше они того же вида,
    // что исходная потеря, и по цене вида считались бы ещё одним штрафом.
    prisma.royalScoreEvent.groupBy({
      by: ["agentId", "kind"],
      where: { at: cur, sourceId: { startsWith: SCORE_OVERRIDE_REVERT_PREFIX } },
      _count: { _all: true },
    }),
  ]);

  const prevStale = (() => {
    const saved = prevReport?.metrics as {
      sections?: { key?: string; metrics?: { key?: string; value?: number }[] }[];
    } | null;
    const m = saved?.sections?.find((s) => s.key === "agents")?.metrics?.find((mm) => mm.key === "stale");
    return typeof m?.value === "number" ? m.value : null;
  })();

  const nameById = new Map(agents.map((a) => [a.id, a.fullName]));

  /** Сколько раз событие каждого вида случилось у каждого агента. */
  function countBy(rows: typeof events, kinds: ScoreEventKind[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of rows) {
      if (!kinds.includes(row.kind as ScoreEventKind)) continue;
      out.set(row.agentId, (out.get(row.agentId) ?? 0) + row._count._all);
    }
    return out;
  }
  function total(map: Map<string, number>): number {
    let sum = 0;
    for (const v of map.values()) sum += v;
    return sum;
  }

  const windows = countBy(events, AGENT_FAIL_KINDS.windows);
  const tasks = countBy(events, AGENT_FAIL_KINDS.tasks);
  const declines = countBy(events, AGENT_FAIL_KINDS.declines);
  const missed = countBy(events, AGENT_FAIL_KINDS.missedCalls);
  const staleByAgent = new Map(stale.map((s) => [s.assignedAgentId!, s._count._all]));

  /**
   * ПРОСЕВШАЯ КАТЕГОРИЯ ROYAL SCORE — за отчётный период, а не за скользящее окно.
   *
   * computeRoyalScoreBreakdown считает по окну из Настроек (30 дней), и в недельном
   * отчёте это была бы цифра про другой отрезок времени. Категории и цены событий
   * берём оттуда же (CATEGORY_OF, loadEventPoints) — вторая копия таблицы разошлась
   * бы с оригиналом при первом же новом виде события.
   */
  const worstCategory = new Map<string, { category: RoyalScoreCategoryKey; sum: number }>();
  const byAgentCategory = new Map<string, Map<RoyalScoreCategoryKey, number>>();
  for (const row of events) {
    const category = CATEGORY_OF[row.kind as ScoreEventKind];
    if (!category) continue;
    const sums = byAgentCategory.get(row.agentId) ?? new Map<RoyalScoreCategoryKey, number>();
    sums.set(category, (sums.get(category) ?? 0) + (points[row.kind as ScoreEventKind] ?? 0) * row._count._all);
    byAgentCategory.set(row.agentId, sums);
  }
  // Отмена гасит исходное событие (scoreEventPoints в scoreJournal.ts): выше она
  // прибавлена по цене вида, а должна вычитать её — поправка на две цены.
  for (const row of overrideReverts) {
    const category = CATEGORY_OF[row.kind as ScoreEventKind];
    const sums = byAgentCategory.get(row.agentId);
    if (!category || !sums) continue;
    sums.set(category, (sums.get(category) ?? 0) - 2 * (points[row.kind as ScoreEventKind] ?? 0) * row._count._all);
  }
  for (const [agentId, sums] of byAgentCategory) {
    let worst: { category: RoyalScoreCategoryKey; sum: number } | null = null;
    for (const [category, sum] of sums) {
      if (sum < 0 && (worst === null || sum < worst.sum)) worst = { category, sum };
    }
    if (worst) worstCategory.set(agentId, worst);
  }

  // Кто проседает сильнее: считаем по числу нарушений, а не по баллам — балл
  // зависит от цен в Настройках, а «шесть просроченных окон» не зависит ни от чего.
  const ranked = [...nameById.keys()]
    .map((agentId) => {
      const failures =
        (windows.get(agentId) ?? 0) +
        (tasks.get(agentId) ?? 0) +
        (declines.get(agentId) ?? 0) +
        (missed.get(agentId) ?? 0) +
        (staleByAgent.get(agentId) ?? 0);
      return { agentId, failures };
    })
    .filter((a) => a.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, LINKS_PER_SECTION);

  const links: ProblemLink[] = ranked.map(({ agentId }) => {
    const parts = [
      windows.get(agentId) ? `просрочено окон: ${windows.get(agentId)}` : null,
      tasks.get(agentId) ? `сорвано задач и показов: ${tasks.get(agentId)}` : null,
      declines.get(agentId) ? `отказов от лидов: ${declines.get(agentId)}` : null,
      missed.get(agentId) ? `не позвонил вовремя: ${missed.get(agentId)}` : null,
      staleByAgent.get(agentId) ? `клиентов без движения: ${staleByAgent.get(agentId)}` : null,
    ].filter(Boolean);
    const category = worstCategory.get(agentId);
    if (category) {
      const label = ROYAL_SCORE_CATEGORIES.find((c) => c.key === category.category)?.label ?? category.category;
      parts.push(`просела «${label}» (${Math.round(category.sum)})`);
    }
    return {
      label: nameById.get(agentId) ?? "Агент",
      hint: parts.join(", "),
      href: `/team?agent=${agentId}`,
    };
  });

  const metrics = [
    metric("windows", "Обязательные окна просрочены", total(windows), total(countBy(eventsPrev, AGENT_FAIL_KINDS.windows)), null,
      "Итог разговора, встречи или объекта так и не записан"),
    metric("tasks", "Задачи, показы и встречи сорваны", total(tasks), total(countBy(eventsPrev, AGENT_FAIL_KINDS.tasks)), "/calendar"),
    metric("declines", "Отказы агентов от лидов", total(declines), total(countBy(eventsPrev, AGENT_FAIL_KINDS.declines)), null,
      "Считаются со второго подряд — первый отказ штрафом не считается"),
    metric("missedCalls", "Первый звонок не сделан вовремя", total(missed), total(countBy(eventsPrev, AGENT_FAIL_KINDS.missedCalls)), null),
    metric(
      "stale",
      "Клиенты без единого касания за период",
      total(staleByAgent),
      prevStale,
      "/clients",
      "Карточка в работе, а связи с человеком нет — это и есть потеря контакта"
    ),
  ];

  return assembleSection({
    key: "agents",
    title: "Кто из агентов проседает",
    metrics,
    links,
    ago: ctx.ago,
    headline: (worst, trend) => {
      const first = ranked[0];
      if (!first) return "У команды за период нет ни просрочек, ни брошенных клиентов.";
      const name = nameById.get(first.agentId) ?? "Агент";
      return `${name} — больше всего нарушений за период (${first.failures}). Чаще всего проседает: ${
        worst?.label.toLowerCase() ?? "—"
      }. Всего ${trend || "сравнить не с чем"}.`;
    },
  });
}

/* ────────────────────────────── 3. Звонки ────────────────────────────── */

async function buildCallsSection(ctx: BuildContext): Promise<ProblemSection> {
  const cur = within(ctx.current);
  const prev = within(ctx.previous);

  // То же определение «ждёт разбора», что в журнале звонков, на дашборде и в утренних
  // цифрах: разговор с карточкой ИЛИ сообщение автоответчика без неё (CHANNEL-NEW-13).
  const unqualifiedWhere = AWAITING_REVIEW_WHERE;

  const [
    missed,
    missedPrev,
    unqualified,
    unqualifiedPrev,
    noNextStep,
    noNextStepPrev,
    analyzed,
    noNeed,
    noObjection,
    weakCalls,
  ] = await Promise.all([
    prisma.incomingCall.count({ where: { startedAt: cur, answered: false } }),
    prisma.incomingCall.count({ where: { startedAt: prev, answered: false } }),
    prisma.incomingCall.count({ where: { startedAt: cur, ...unqualifiedWhere } }),
    prisma.incomingCall.count({ where: { startedAt: prev, ...unqualifiedWhere } }),
    prisma.callAnalysis.count({ where: { createdAt: cur, agreedNextStep: false } }),
    prisma.callAnalysis.count({ where: { createdAt: prev, agreedNextStep: false } }),
    prisma.callAnalysis.count({ where: { createdAt: cur } }),
    prisma.callAnalysis.count({ where: { createdAt: cur, foundNeed: false } }),
    prisma.callAnalysis.count({ where: { createdAt: cur, handledObjection: false } }),
    // Разговоры без договорённости о следующем шаге — с кем именно, чтобы из
    // отчёта открыть карточку клиента, а не искать её по фамилии агента.
    prisma.callAnalysis.findMany({
      where: { createdAt: cur, agreedNextStep: false },
      select: {
        summary: true,
        agent: { select: { fullName: true } },
        interaction: { select: { client: { select: { shortId: true, fullName: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: LINKS_PER_SECTION,
    }),
  ]);

  const metrics = [
    metric("missed", "Входящие звонки пропущены", missed, missedPrev, "/calls",
      "До агентства не дозвонились — каждый такой звонок это несостоявшееся обращение"),
    metric("unqualified", "Разговоры не разобраны оператором", unqualified, unqualifiedPrev, "/calls",
      "Трубку сняли (или оставили сообщение на автоответчике), но тип обращения так и не указали — карточка никуда не пошла"),
    metric("noNextStep", "Разговоры без договорённости о следующем шаге", noNextStep, noNextStepPrev, null,
      analyzed > 0 ? `Из ${analyzed} разобранных разговоров за период` : undefined),
  ];

  const breakdown: ProblemBreakdown | null = analyzed
    ? {
        title: "Что чаще всего пропускают в разговоре",
        rows: [
          { label: "Не выяснили потребность", count: noNeed },
          { label: "Не отработали возражение", count: noObjection },
          { label: "Не договорились о следующем шаге", count: noNextStep },
        ].filter((r) => r.count > 0),
      }
    : null;

  return assembleSection({
    key: "calls",
    title: "Звонки",
    metrics,
    breakdown,
    links: weakCalls
      .filter((c) => c.interaction?.client)
      .map((c) => ({
        label: c.interaction!.client.fullName,
        hint: `${c.agent.fullName}: разговор закончился без следующего шага — ${c.summary.slice(0, 120)}`,
        href: `/clients/${c.interaction!.client.shortId}`,
      })),
    ago: ctx.ago,
    headline: (worst, trend) =>
      worst
        ? `Телефон: ${worst.label.toLowerCase()} — ${worst.value}. Всего потерь на звонках ${trend || "сравнить не с чем"}.`
        : "Со звонками за период всё чисто: ничего не пропустили и всё разобрали.",
  });
}

/* ────────────────────────────── 4. Объекты ────────────────────────────── */

async function buildPropertiesSection(ctx: BuildContext): Promise<ProblemSection> {
  const cur = within(ctx.current);
  const prev = within(ctx.previous);
  const notFinished: PropertyStatus[] = ["SOLD", "WITHDRAWN"];

  const [deadlines, inPipeline, freshCurrent, freshPrevious, shownRows, available] = await Promise.all([
    loadPipelineDeadlines(),
    prisma.property.findMany({
      where: { deletedAt: null, status: { in: [...PROPERTY_PIPELINE_STATUSES] } },
      select: { id: true, shortId: true, title: true, status: true, stageEnteredAt: true },
      // Сначала самые старые: если объектов больше потолка, показать надо именно
      // тех, кто стоит дольше всех, а не произвольных.
      orderBy: { stageEnteredAt: "asc" },
      take: PROPERTY_SCAN_LIMIT,
    }),
    prisma.property.findMany({
      where: { createdAt: cur, deletedAt: null, status: { notIn: notFinished } },
      select: { shortId: true, title: true, instagramUrl: true, _count: { select: { photos: true } } },
      orderBy: { createdAt: "desc" },
      take: PROPERTY_SCAN_LIMIT,
    }),
    prisma.property.findMany({
      where: { createdAt: prev, deletedAt: null, status: { notIn: notFinished } },
      select: { instagramUrl: true, _count: { select: { photos: true } } },
      take: PROPERTY_SCAN_LIMIT,
    }),
    // По каким объектам показы вообще были — за оба периода сразу, одним запросом.
    prisma.interaction.groupBy({
      by: ["propertyId"],
      where: {
        type: "SHOWING",
        ...COUNTED_SHOWING_WHERE,
        propertyId: { not: null },
        createdAt: { gte: ctx.previous.from, lt: ctx.current.to },
      },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.property.findMany({
      where: { deletedAt: null, status: "AVAILABLE" },
      select: {
        id: true,
        shortId: true,
        title: true,
        price: true,
        currency: true,
        districtId: true,
        rooms: true,
        areaSqm: true,
        floor: true,
        totalFloors: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: PROPERTY_SCAN_LIMIT,
    }),
  ]);

  const stuck = inPipeline.filter((p) => stageState(p.status, p.stageEnteredAt, deadlines, ctx.current.to).overdue);

  // Ссылка не на Instagram — это ТОЖЕ «нет видео-обзора» (правило владельца
  // 13.08.2026, см. lib/instagramLink.ts): иначе объект с телеграм-ссылкой считался
  // бы упакованным, а бот не смог бы ни показать его, ни узнать в пересылке.
  const noMaterials = freshCurrent.filter(
    (p) => p._count.photos < MIN_PROPERTY_PHOTOS || !isInstagramLink(p.instagramUrl)
  );
  const noMaterialsPrev = freshPrevious.filter(
    (p) => p._count.photos < MIN_PROPERTY_PHOTOS || !isInstagramLink(p.instagramUrl)
  ).length;

  // Показы периода — множествами: объект, который никто не смотрел, и есть «висит».
  const shownCurrent = new Set(
    shownRows.filter((r) => (r._max.createdAt?.getTime() ?? 0) >= ctx.current.from.getTime()).map((r) => r.propertyId!)
  );
  const shownPrevious = new Set(
    shownRows.filter((r) => (r._min.createdAt?.getTime() ?? Infinity) < ctx.current.from.getTime()).map((r) => r.propertyId!)
  );
  const idleNow = available.filter((p) => p.createdAt < ctx.current.from && !shownCurrent.has(p.id));
  const idlePrev = available.filter((p) => p.createdAt < ctx.previous.from && !shownPrevious.has(p.id)).length;

  // Спрос — «на сейчас»: считается по нынешним активным клиентам, и восстановить
  // его на прошлую неделю нечем (запросы клиентов с тех пор изменились).
  const demand = await computeDemandCounts(available);
  const noDemand = available.filter((p) => (demand.get(p.id) ?? 0) === 0);

  const metrics = [
    metric("stuck", "Застряли в подготовке дольше срока", stuck.length, null, "/properties",
      "Срок этапа (фото, видео, монтаж) вышел, а объект с места не сдвинулся"),
    metric("noMaterials", "Заведены без фото или видео-обзора", noMaterials.length, noMaterialsPrev, "/properties",
      `Меньше ${MIN_PROPERTY_PHOTOS} снимков или нет ссылки на Reels — показывать клиенту нечего`),
    metric("idle", "В продаже, но за период ни одного показа", idleNow.length, idlePrev, "/properties"),
    metric("noDemand", "В продаже, но их никто не ищет", noDemand.length, null, "/properties",
      "Ни один активный клиент не подходит по району, бюджету и параметрам"),
  ];

  const links: ProblemLink[] = [
    ...stuck.slice(0, 3).map((p) => ({
      label: `№${p.shortId} — ${p.title}`,
      hint: `Стоит на этапе с ${formatDay(p.stageEnteredAt)}`,
      href: `/properties/${p.shortId}`,
    })),
    ...noMaterials.slice(0, 3).map((p) => ({
      label: `№${p.shortId} — ${p.title}`,
      hint:
        p._count.photos < MIN_PROPERTY_PHOTOS
          ? `Фотографий ${p._count.photos} из ${MIN_PROPERTY_PHOTOS}`
          : "Нет ссылки на видео-обзор",
      href: `/properties/${p.shortId}`,
    })),
  ].slice(0, LINKS_PER_SECTION);

  return assembleSection({
    key: "properties",
    title: "Объекты",
    metrics,
    links,
    ago: ctx.ago,
    headline: (worst, trend) =>
      worst
        ? `Объекты: ${worst.label.toLowerCase()} — ${worst.value}. По сравнимым показателям ${trend || "сравнить не с чем"}.`
        : "С объектами за период всё в порядке: подготовка идёт в срок, показы есть.",
  });
}

/** «12.08» по Душанбе — подпись даты внутри отчёта. */
function formatDay(at: Date): string {
  const wall = dushanbeWallClock(at);
  return `${String(wall.getUTCDate()).padStart(2, "0")}.${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ────────────────────────────── Сборка ────────────────────────────── */

/**
 * Главный вывод всего отчёта (одна фраза для шапки и пуша директорам).
 */
export function overallHeadline(sections: ProblemSection[], ago: string): string {
  // Главный вывод отчёта — раздел с самой большой сравнимой суммой потерь. Не
  // среднее и не «всё сразу»: владельцу нужен один адрес, куда идти в первую очередь.
  const worstSection = [...sections].sort((a, b) => b.total - a.total)[0];
  if (!(worstSection && worstSection.total > 0)) {
    // `total` — только сравнимые показатели (previous !== null), а «на сейчас»
    // (застряли в подготовке, объекты без спроса) в него не входят. Нулевой total
    // не значит «проблем нет»: фразу «не нашлось» говорим, только когда нет и
    // текущих (аудит Codex 04.10.2026, ACCESS-12). Поле total и direction не меняем.
    const currentOf = (sec: ProblemSection) => sec.metrics.reduce((sum, m) => sum + m.value, 0);
    const heaviest = [...sections].sort((a, b) => currentOf(b) - currentOf(a))[0];
    if (heaviest && currentOf(heaviest) > 0) {
      return `Потерь за период не накопилось, но прямо сейчас есть что разобрать: «${heaviest.title}» — ${heaviest.headline.replace(/[.\s]+$/, "")}.`;
    }
    return "Проблемных мест за период не нашлось — ни потерянных клиентов, ни просрочек, ни пропущенных звонков.";
  }
  return `Больше всего теряем здесь: «${worstSection.title}» — ${worstSection.total} ${pluralizeRu(worstSection.total, [
    "случай",
    "случая",
    "случаев",
  ])} за период (${
    worstSection.direction === "worse"
      ? "хуже, чем " + ago
      : worstSection.direction === "better"
        ? "лучше, чем " + ago
        : "как и " + ago
  }).`;
}

/**
 * Считает все четыре раздела за период. Разделы независимы, поэтому идут
 * параллельно: последовательно это было бы четыре круга ожидания базы подряд.
 */
export async function buildProblemMetrics(
  period: ProblemPeriod,
  now: Date = new Date()
): Promise<ProblemReportMetrics> {
  const { current, previous } = problemPeriodRanges(period, now);
  const ctx: BuildContext = {
    period,
    current,
    previous,
    ago: period === "week" ? "неделей раньше" : "месяцем раньше",
  };

  const sections = await Promise.all([
    buildClientsSection(ctx),
    buildAgentsSection(ctx),
    buildCallsSection(ctx),
    buildPropertiesSection(ctx),
  ]);

  const headline = overallHeadline(sections, ctx.ago);

  return {
    period,
    periodStart: current.from.toISOString(),
    periodEnd: current.to.toISOString(),
    headline,
    sections,
  };
}

/** Включён ли этот отчёт в Настройках. Выключенный не собирается вовсе — ни
 *  кроном, ни кнопкой: иначе выключатель означал бы «не присылать пуш». */
export async function isProblemReportEnabled(period: ProblemPeriod): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { problemReportWeeklyEnabled: true, problemReportMonthlyEnabled: true },
  });
  if (!settings) return true;
  return period === "week" ? settings.problemReportWeeklyEnabled : settings.problemReportMonthlyEnabled;
}

export interface GenerateProblemReportResult {
  created: boolean;
  /** Почему не создан: выключен в Настройках либо уже собран за этот период. */
  reason: "created" | "disabled" | "exists";
  period: ProblemPeriod;
  periodStart: Date;
  periodEnd: Date;
  id: string | null;
}

/**
 * Собирает отчёт за прошедший период и уведомляет директоров.
 *
 * ИДЕМПОТЕНТНО: уникальность (period, periodStart) в базе — арбитр, а не проверка
 * «а нет ли уже такого»: два тика подряд оба увидели бы пустоту. Повторный вызов
 * не перетирает уже написанные заметки владельца — иначе перезапуск контейнера
 * стирал бы его работу.
 */
/**
 * `immediate` (владелец 07.09.2026, часы алармов): крон (по расписанию,
 * cron.ts) ставит уведомление в общую очередь алармов — директор его не ждёт
 * именно сейчас. Кнопка «Собрать сейчас» (routes/reports.ts) — наоборот,
 * директор сам только что нажал и ждёт результат немедленно, откладывать
 * ответ на собственное действие было бы неверно понятым «не будить ночью».
 */
export async function generateProblemReport(
  period: ProblemPeriod,
  now: Date = new Date(),
  immediate = false
): Promise<GenerateProblemReportResult> {
  const { current } = problemPeriodRanges(period, now);
  const base = { period, periodStart: current.from, periodEnd: current.to };

  if (!(await isProblemReportEnabled(period))) {
    return { ...base, created: false, reason: "disabled", id: null };
  }

  const existing = await prisma.problemReport.findUnique({
    where: { period_periodStart: { period, periodStart: current.from } },
    select: { id: true },
  });
  if (existing) return { ...base, created: false, reason: "exists", id: existing.id };

  const metrics = await buildProblemMetrics(period, now);
  let created;
  try {
    created = await prisma.problemReport.create({
      data: { period, periodStart: current.from, periodEnd: current.to, metrics: metrics as never },
    });
  } catch (err) {
    // Гонка двух сборок (крон и кнопка «Собрать сейчас» в одну секунду): вторая
    // получает отказ по уникальности — это не ошибка, отчёт уже есть.
    if ((err as { code?: string }).code === "P2002") {
      const saved = await prisma.problemReport.findUnique({
        where: { period_periodStart: { period, periodStart: current.from } },
        select: { id: true },
      });
      return { ...base, created: false, reason: "exists", id: saved?.id ?? null };
    }
    throw err;
  }

  await notifyDirectors(period, metrics, immediate);
  return { ...base, created: true, reason: "created", id: created.id };
}

/** Пуш «отчёт готов» со ссылкой прямо на нужную вкладку Отчётов. Без него отчёт
 *  тихо лежал бы в разделе, и о нём вспоминали бы раз в квартал. */
async function notifyDirectors(period: ProblemPeriod, metrics: ProblemReportMetrics, immediate: boolean): Promise<void> {
  const title = period === "week" ? "🧭 Разбор недели готов" : "🧭 Разбор месяца готов";
  const tag = `problem-report-${period}-${metrics.periodStart.slice(0, 10)}`;
  if (!immediate) {
    await enqueueDirectorAlert({
      title,
      body: metrics.headline,
      url: `/reports?problems=${period}`,
      tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
    return;
  }

  const directors = await prisma.agent.findMany({
    where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
    select: { id: true },
  });
  for (const d of directors) {
    await sendPushToAgent(d.id, {
      title,
      // Тело пуша — главный вывод отчёта, а не «отчёт готов, откройте»: половина
      // решений принимается прямо из шторки уведомлений, не открывая CRM.
      body: metrics.headline,
      url: `/reports?problems=${period}`,
      tag,
      // "oversight" — решение владельца 24.08.2026: отчёт продолжает собираться
      // и лежать в Отчётах независимо от этого пуша (см. isProblemReportEnabled
      // выше — тот тумблер про сам отчёт, этот про push), но сам push теперь
      // личная настройка каждого директора (routes/push.ts, PUSH_KINDS),
      // а не обязательный сигнал.
      kind: "oversight",
    }).catch(() => {});
  }
}
