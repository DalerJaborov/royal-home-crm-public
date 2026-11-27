import { createElement } from "react";
import { FinanceReport } from "../../src/lib/reportPdf/financeDocument.js";
import { TeamReport } from "../../src/lib/reportPdf/teamDocument.js";

/**
 * ТЕСТОВЫЕ ДАННЫЕ ДЛЯ ОБРАЗЦОВ PDF-ОТЧЁТОВ (цифры и имена выдуманные, правдоподобные).
 * Нужны и стражу вёрстки (report-pdf-layout.test.ts), и сборке образцов для владельца.
 * Имена с таджикскими буквами — чтобы шрифт проверялся на ӣ ӯ қ ғ ҳ ҷ.
 */
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
const REVENUE = [412000, 468500, 391200, 527800, 604300, 689450.5];
export const SAMPLE_AGENTS = ["Фарҳод Рустамов", "Мадина Ҷӯраева", "Шарифҷон Қодиров", "Зарина Ғаффорова", "Ӯрунбой Ҳакимов", "Нигина Саидова", "Дилшод Назаров", "Сабрина Каримова", "Бахтиёр Мирзоев", "Парвина Одинаева", "Комрон Раҳимов", "Лайло Юсупова"];

function buildMonths() {
  return MONTHS.map((m, i) => {
    const rev = REVENUE[i]!;
    const half = Math.round(rev * 0.5 * 100) / 100;
    const adv = 38000 + i * 4100.25;
    const sal = 52000 + i * 1500;
    const opex = adv + sal + 14500 + 6200 + i * 310.4;
    const payouts = m === "2026-11"
      ? SAMPLE_AGENTS.map((name, k) => {
          const nd = 1 + ((k * 5) % 4);
          const deals = Array.from({ length: nd }, (_, d) => ({ dealId: `d${k}-${d}`, clientName: null, propertyTitle: "Тестовый объект", realtor: 0, payoutAt: d < nd - (k % 3 === 0 ? 1 : 0) ? "2026-11-20T10:00:00Z" : null }));
          const total = Math.round((half / 36) * (1.9 - k * 0.12) * 100) / 100;
          return { agentId: `a${k}`, name, realtor: total, total, deals };
        })
      : [];
    const channel = (source: string, share: number, leads: number, deals: number) => ({ source, spent: adv * share, leads, costPerLead: adv * share / leads, deals, costPerDeal: deals ? adv * share / deals : null });
    return {
      month: m, revenue: rev, realtorPayouts: half, companyRevenue: half, payouts,
      expenses: { ADVERTISING: adv, SALARY: sal + half, OFFICE: 14500, OTHER: 6200 + i * 310.4 },
      totalExpenses: opex + half, dealSalaryExpenses: half, operatingExpenses: opex, profit: half - opex, leads: 140 + i * 17,
      costPerLead: [channel("INSTAGRAM", 0.55, 62 + i * 5, 5), channel("FACEBOOK", 0.3, 31 + i, 2), channel("TIKTOK", 0.15, 12, 0)],
    };
  });
}

const founders = { month: "2026-11", monthTjs: 60000, allTimeTjs: 480000, founders: [
  { founderId: "f1", name: "Учредитель Первый", deleted: false, monthTjs: 40000, allTimeTjs: 300000, monthCount: 1, allTimeCount: 6 },
  { founderId: "f2", name: "Учредитель Второй", deleted: false, monthTjs: 20000, allTimeTjs: 180000, monthCount: 1, allTimeCount: 5 },
] };
const forecast = { expectedTjs: 742000, lowTjs: 610000, highTjs: 860000, expectedCompanyTjs: 371000, planTjs: 800000, percentOfPlan: 93, stages: [], paceTjs: 120000, workdaysLeft: 3, lowHistory: false, reasons: [] };

/** Финансовый отчёт ровно в том виде, в каком он уходит по ежемесячной рассылке. */
export function sampleFinanceSent() {
  const summary = { months: buildMonths(), currency: "TJS" as const, usdToTjsRate: 10.9, truncated: false };
  return createElement(FinanceReport as never, { month: "2026-11", summary, forecast: null, founders, inProgress: false, preparedBy: "CRM Royal Home, ежемесячная рассылка", generatedAtLabel: "1 декабря 2026, 09:10" });
}

/** Выгрузка кнопкой за идущий месяц: с прогнозом и без сравнения с прошлым месяцем. */
export function sampleFinanceInProgress() {
  const summary = { months: buildMonths(), currency: "TJS" as const, usdToTjsRate: 10.9, truncated: false };
  return createElement(FinanceReport as never, { month: "2026-11", summary, forecast, founders, inProgress: true, preparedBy: "Тестовый Директор", generatedAtLabel: "27 ноября 2026, 14:05" });
}

export function sampleTeam() {
  const agents = SAMPLE_AGENTS.map((a, k) => ({ agentId: `a${k}`, agentName: a, isActive: k !== 9, avatarUrl: null, showings: 18 - k, dealsClosed: Math.max(0, 4 - Math.floor(k / 3)), commission: Math.max(0, 4 - Math.floor(k / 3)) * 21300.5 }));
  return createElement(TeamReport as never, {
    periodLabel: "1 ноября 2026 – 30 ноября 2026", preparedBy: "Тестовый Директор", generatedAtLabel: "1 декабря 2026, 09:10", seesMoney: true,
    funnel: [{ key: "leads", label: "Заявки", count: 340 }, { key: "showings", label: "Показы", count: 96 }, { key: "deals", label: "Сделки", count: 17, commission: 689450.5 }],
    cohort: [{ key: "leads", label: "Заявки", count: 312 }, { key: "contacted", label: "Связались", count: 254 }, { key: "showings", label: "Показы", count: 88 }, { key: "negotiations", label: "Переговоры", count: 31 }, { key: "deals", label: "Сделки", count: 17 }],
    agents,
    sources: { avgDaysNewToClosed: 23, sources: [
      { source: "INSTAGRAM", total: 142, closed: 7, wrote: 310 }, { source: "WEBSITE", total: 64, closed: 4, wrote: 0 }, { source: "WHATSAPP", total: 48, closed: 3, wrote: 90 },
      { source: "FACEBOOK", total: 37, closed: 2, wrote: 80 }, { source: "TIKTOK", total: 21, closed: 0, wrote: 44 }, { source: "TELEGRAM", total: 12, closed: 1, wrote: 20 },
    ] },
  });
}
