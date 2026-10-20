import {
  DEAL_STAGE_LABELS,
  OPEN_DEAL_STAGES,
  resolveStageWinProbability,
  type CommissionForecast,
  type CommissionForecastStage,
  type OpenDealStage,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "./money.js";

/**
 * ПРОГНОЗ КОМИССИИ К КОНЦУ МЕСЯЦА (задание F2, 14.09.2026).
 *
 * Рядом уже живёт buildExpenseForecast() (lib/financeAutomation.ts) — прогноз
 * РАСХОДОВ по темпу месяца. Здесь зеркальная половина: прогноз ДОХОДОВ.
 *
 * Три слагаемых, каждое объяснимо словами:
 *   факт    — закрытые сделки месяца, деньги уже получены;
 *   воронка — открытые сделки × вероятность их стадии;
 *   темп    — средняя комиссия за рабочий день трёх прошлых месяцев ×
 *             оставшиеся рабочие дни, и только в верхнюю оценку.
 *
 * ЧТО ИМЕННО ПРОГНОЗИРУЕТСЯ. Валовая комиссия сделок — ровно та величина,
 * которую показывает блок «Деньги» (lib/dashboardInsights.ts) и с которой
 * сравнивается Settings.monthlyCommissionPlan. Иначе на одной карточке
 * оказались бы два числа с разной базой и разными процентами плана. Долю
 * компании от ожидаемой оценки отдаём отдельным полем expectedCompanyTjs.
 *
 * РЕШЕНИЯ ПО УМОЛЧАНИЮ (владелец недоступен, зафиксированы здесь):
 *  1) Поля «ожидаемая дата закрытия» у сделки нет вовсе и истории переходов по
 *     стадиям тоже нет. Поэтому дата закрытия открытой сделки оценивается как
 *     startedAt + средний срок сделки за 3 месяца (startedAt→closedAt по
 *     закрытым). Сделки, чья оценка уехала за конец месяца, в воронку не идут.
 *     Просроченные (оценка уже в прошлом) остаются: они закрываются со дня на
 *     день, и выбрасывать их было бы занижением.
 *  2) Комиссии у открытой сделки обычно ещё нет (commissionAmount заполняет
 *     агент только на PENDING_APPROVAL). Тогда берём цену объекта × суммарный
 *     процент агентства из Настроек — тем же способом, что «потенциальная
 *     комиссия портфеля» на дашборде.
 *  3) Рабочие дни — понедельник-пятница по Душанбе, без календаря праздников:
 *     праздников в CRM нет ни одной таблицей, придумывать их нельзя.
 *  4) Меньше 30 дней истории закрытых сделок — темп не считаем вовсе
 *     (lowHistory), верхняя оценка равна ожидаемой.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Границы месяца «YYYY-MM» как реальные моменты времени, отбитые по Душанбе. */
export function dushanbeMonthBounds(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, mon - 1, 1) - DUSHANBE_OFFSET_MS),
    end: new Date(Date.UTC(year, mon, 1) - DUSHANBE_OFFSET_MS),
  };
}

/** «2026-09» текущего месяца по Душанбе. */
export function currentDushanbeMonth(at: Date = new Date()): string {
  const wall = dushanbeWallClock(at);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Рабочих дней (пн-пт) в отрезке [from, to) по настенному времени Душанбе.
 * Шагаем по календарным суткам Душанбе, а не по UTC: у границы суток (после
 * 19:00 UTC) UTC-день уже другой, и счёт уезжал бы на день.
 */
function workdaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  const startWall = dushanbeWallClock(from);
  let cursor = Date.UTC(startWall.getUTCFullYear(), startWall.getUTCMonth(), startWall.getUTCDate());
  const endWall = dushanbeWallClock(new Date(to.getTime() - 1));
  const last = Date.UTC(endWall.getUTCFullYear(), endWall.getUTCMonth(), endWall.getUTCDate());
  for (; cursor <= last; cursor += MS_PER_DAY) {
    const wd = new Date(cursor).getUTCDay();
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return count;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function somoni(value: number): string {
  return `${Math.round(value).toLocaleString("ru-RU")} с.`;
}

/**
 * Прогноз комиссии за месяц «YYYY-MM» по Душанбе.
 *
 * Запросов к базе ровно четыре и все они плоские: закрытые сделки месяца,
 * закрытые за три предыдущих месяца (на средний срок и темп), открытые сделки
 * с ценой объекта одним include, и настройки. Никаких await внутри map.
 */
export async function buildCommissionForecast(
  month: string = currentDushanbeMonth(),
  now: Date = new Date(),
): Promise<CommissionForecast> {
  const { start: monthStart, end: monthEnd } = dushanbeMonthBounds(month);
  // Три полных месяца до текущего — база и для среднего срока сделки, и для темпа.
  const historyStart = new Date(monthStart.getTime() - 92 * MS_PER_DAY);

  const [settings, money, factDeals, historyDeals, openDeals] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        monthlyCommissionPlan: true,
        commissionCompanyPercent: true,
        commissionIntakePercent: true,
        commissionRealtorPercent: true,
        dealStageWinProbability: true,
      },
    }),
    loadMoneyContext(),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: monthStart, lt: monthEnd } },
      select: { commissionAmount: true, currency: true },
    }),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: historyStart, lt: monthStart } },
      select: { commissionAmount: true, currency: true, startedAt: true, closedAt: true },
    }),
    prisma.deal.findMany({
      where: { stage: { in: [...OPEN_DEAL_STAGES] } },
      select: {
        stage: true,
        startedAt: true,
        commissionAmount: true,
        currency: true,
        property: { select: { price: true, currency: true } },
      },
      // Предел выборки, как требует правило маршрутов с массивами. Открытых
      // сделок у агентства десятки; 1000 — потолок от аварии, а не рабочий режим.
      take: 1000,
    }),
  ]);

  const planTjs = Number(settings?.monthlyCommissionPlan ?? 8000);
  const companyPercent =
    Number(settings?.commissionCompanyPercent ?? 1) + Number(settings?.commissionIntakePercent ?? 0.5);
  const realtorPercent = Number(settings?.commissionRealtorPercent ?? 0.5);
  const totalPercent = companyPercent + realtorPercent;
  const probability = resolveStageWinProbability(settings?.dealStageWinProbability ?? null);

  // Всё в целых сотых сомони: суммы отсюда встают рядом с числами «Финансов»,
  // и расходиться с ними не должны (см. lib/money.ts).
  const factCents = factDeals.reduce(
    (acc, d) => acc + centsToTjs(toCents(d.commissionAmount), d.currency, money),
    0,
  );

  // ── средний срок сделки и темп за три месяца ───────────────────────────────
  let durationSum = 0;
  let durationCount = 0;
  let historyCents = 0;
  let earliestClose: Date | null = null;
  for (const d of historyDeals) {
    historyCents += centsToTjs(toCents(d.commissionAmount), d.currency, money);
    if (!d.closedAt) continue;
    if (!earliestClose || d.closedAt < earliestClose) earliestClose = d.closedAt;
    const days = (d.closedAt.getTime() - d.startedAt.getTime()) / MS_PER_DAY;
    if (days >= 0) {
      durationSum += days;
      durationCount += 1;
    }
  }
  const avgCloseDays = durationCount > 0 ? durationSum / durationCount : null;

  // «Мало истории» — это про длину наблюдения, а не про число сделок: месяц с
  // одной сделкой — уже месяц, а три сделки за неделю темпом не являются.
  const historySpanDays = earliestClose ? (monthStart.getTime() - earliestClose.getTime()) / MS_PER_DAY : 0;
  const lowHistory = historySpanDays < 30;
  const historyWorkdays = workdaysBetween(historyStart, monthStart);
  const perWorkdayCents = !lowHistory && historyWorkdays > 0 ? historyCents / historyWorkdays : null;

  // ── воронка ────────────────────────────────────────────────────────────────
  const byStage = new Map<OpenDealStage, { count: number; cents: number }>();
  for (const d of openDeals) {
    const stage = d.stage as OpenDealStage;
    // Комиссия открытой сделки чаще всего ещё не названа — оцениваем по цене
    // объекта и суммарному проценту агентства из Настроек.
    const cents =
      d.commissionAmount !== null
        ? centsToTjs(toCents(d.commissionAmount), d.currency, money)
        : Math.round((centsToTjs(toCents(d.property.price), d.property.currency, money) * totalPercent) / 100);
    if (cents <= 0) continue;

    // Попадает ли сделка в этот месяц. Без среднего срока фильтровать нечем —
    // тогда берём все открытые: занижать молча хуже, чем показать шире и сказать
    // об этом строкой «мало истории».
    if (avgCloseDays !== null) {
      const projectedClose = d.startedAt.getTime() + avgCloseDays * MS_PER_DAY;
      if (projectedClose >= monthEnd.getTime()) continue;
    }

    const entry = byStage.get(stage) ?? { count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += cents;
    byStage.set(stage, entry);
  }

  const stages: CommissionForecastStage[] = OPEN_DEAL_STAGES.filter((s) => byStage.has(s))
    .map((stage) => {
      const entry = byStage.get(stage)!;
      const p = probability[stage];
      return {
        stage,
        count: entry.count,
        amountTjs: fromCents(entry.cents),
        probability: p,
        weightedTjs: fromCents(Math.round(entry.cents * p)),
      };
    })
    .sort((a, b) => b.weightedTjs - a.weightedTjs);

  const funnelWeightedCents = stages.reduce((acc, s) => acc + toCents(s.weightedTjs), 0);
  // Нижняя оценка — только то, что почти наверняка дойдёт: стадии с вероятностью
  // не ниже 0.8, и без множителя вероятности их сумма не берётся.
  const funnelSafeCents = stages
    .filter((s) => s.probability >= 0.8)
    .reduce((acc, s) => acc + toCents(s.weightedTjs), 0);

  const workdaysLeft = workdaysBetween(now > monthStart ? now : monthStart, monthEnd);
  const paceCents = perWorkdayCents !== null ? Math.round(perWorkdayCents * workdaysLeft * 0.5) : null;

  const expectedCents = factCents + funnelWeightedCents;
  const lowCents = factCents + funnelSafeCents;
  const highCents = expectedCents + (paceCents ?? 0);

  const expectedTjs = fromCents(expectedCents);
  const percentOfPlan = planTjs > 0 ? Math.round((expectedTjs / planTjs) * 100) : 0;

  // ── причины словами ────────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (factCents > 0) {
    const n = factDeals.length;
    reasons.push(
      `${n} ${plural(n, "закрытая сделка", "закрытые сделки", "закрытых сделок")} месяца на ${somoni(fromCents(factCents))}.`,
    );
  }
  for (const s of stages.slice(0, 2)) {
    reasons.push(
      `${s.count} ${plural(s.count, "сделка", "сделки", "сделок")} на стадии «${DEAL_STAGE_LABELS[s.stage].toLowerCase()}» на ${somoni(s.amountTjs)} — считаем ${Math.round(s.probability * 100)} %.`,
    );
  }
  if (reasons.length < 3) {
    if (lowHistory) {
      reasons.push("Истории меньше месяца — темп не считали, верхняя оценка без него.");
    } else if (paceCents !== null && paceCents > 0) {
      reasons.push(
        `Темп трёх месяцев за оставшиеся ${workdaysLeft} ${plural(workdaysLeft, "рабочий день", "рабочих дня", "рабочих дней")} даёт до ${somoni(fromCents(paceCents))} сверху.`,
      );
    } else if (reasons.length === 0) {
      reasons.push("Ни закрытых сделок, ни открытых с оценкой закрытия в этом месяце.");
    }
  }

  return {
    month,
    factTjs: fromCents(factCents),
    lowTjs: fromCents(lowCents),
    expectedTjs,
    highTjs: fromCents(highCents),
    expectedCompanyTjs: fromCents(
      totalPercent > 0 ? Math.round((expectedCents * companyPercent) / totalPercent) : expectedCents,
    ),
    planTjs,
    percentOfPlan,
    stages,
    paceTjs: paceCents === null ? null : fromCents(paceCents),
    workdaysLeft,
    lowHistory,
    reasons: reasons.slice(0, 3),
  };
}
