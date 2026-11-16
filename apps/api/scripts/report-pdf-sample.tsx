/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * ОБРАЗЕЦ PDF-ОТЧЁТОВ на вымышленных цифрах — чтобы смотреть оформление без базы.
 *   npx tsx apps/api/scripts/report-pdf-sample.tsx <папка>
 * Цифры и имена ниже придуманы и помечены «Образец»; в настоящий отчёт они не попадают.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { FinanceReport, type FinanceSummary } from "../src/lib/reportPdf/financeDocument.js";
import { TeamReport } from "../src/lib/reportPdf/teamDocument.js";
import { renderReportPdf } from "../src/lib/reportPdf/render.js";
import { dushanbeStamp } from "../src/lib/reportPdf/theme.js";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });

const keys = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
const base = [41000, 52000, 38000, 61000, 57000, 73500];
const months = keys.map((month, i) => {
  const revenue = base[i]!;
  const realtorPayouts = Math.round(revenue / 3);
  const companyRevenue = revenue - realtorPayouts;
  const expenses = { ADVERTISING: 9800 + i * 600, OFFICE: 7000, SALARY: 12000 + realtorPayouts, OTHER: 1500 + i * 200 };
  const totalExpenses = Object.values(expenses).reduce((s, v) => s + v, 0);
  const operatingExpenses = totalExpenses - realtorPayouts;
  return {
    month,
    revenue,
    realtorPayouts,
    companyRevenue,
    payouts: ["Образец Агент А", "Образец Агент Б", "Образец Агент В"].map((name, k) => ({
      agentId: `a${k}`,
      name,
      realtor: Math.round(realtorPayouts / 3),
      total: Math.round(realtorPayouts / 3),
      deals: Array.from({ length: 3 - k }, (_, d) => ({ dealId: `d${k}${d}`, clientName: null, propertyTitle: "Образец", realtor: 100, payoutAt: d === 0 ? new Date().toISOString() : null })),
    })),
    expenses,
    totalExpenses,
    dealSalaryExpenses: realtorPayouts,
    operatingExpenses,
    profit: companyRevenue - operatingExpenses,
    leads: 80 + i * 9,
    costPerLead: [
      { source: "INSTAGRAM", spent: 6200 + i * 400, leads: 48 + i * 5, costPerLead: 129, deals: 2, costPerDeal: 3100 },
      { source: "FACEBOOK", spent: 3600 + i * 200, leads: 21 + i * 3, costPerLead: 171, deals: 0, costPerDeal: null },
    ],
  };
}) as unknown as FinanceSummary["months"];

const summary = { months, usdToTjsRate: 10.9, truncated: false } as unknown as FinanceSummary;
const stamp = dushanbeStamp(new Date());

(async () => {
  const fin = await renderReportPdf(<FinanceReport month="2026-11" summary={summary} forecast={{ month: "2026-11", factTjs: 73500, lowTjs: 76000, expectedTjs: 84000, highTjs: 93000, expectedCompanyTjs: 56000, planTjs: 90000, percentOfPlan: 93, stages: [], paceTjs: 80000, workdaysLeft: 12 } as never} preparedBy="Образец на вымышленных цифрах" generatedAtLabel={stamp} />);
  writeFileSync(path.join(out, "sample-finance.pdf"), fin);
  const team = await renderReportPdf(
    <TeamReport
      periodLabel="1 – 14 ноября 2026"
      preparedBy="Образец на вымышленных цифрах"
      generatedAtLabel={stamp}
      seesMoney
      funnel={[
        { key: "leads", label: "Новые заявки", count: 118 },
        { key: "contacted", label: "На контакте", count: 87 },
        { key: "showings", label: "Показы", count: 41 },
        { key: "negotiations", label: "Переговоры", count: 14 },
        { key: "deals", label: "Сделки", count: 6, commission: 73500 },
      ]}
      agents={["Образец Агент А", "Образец Агент Б", "Образец Агент В", "Образец Агент Г"].map((n, i) => ({ agentId: `a${i}`, agentName: n, isActive: true, avatarUrl: null, showings: 14 - i * 3, dealsClosed: 3 - Math.min(i, 3), commission: (3 - Math.min(i, 3)) * 12000 }))}
      sources={{ sources: [
        { source: "INSTAGRAM", total: 64, closed: 3, wrote: 212 },
        { source: "FACEBOOK", total: 22, closed: 1, wrote: 75 },
        { source: "WEBSITE", total: 18, closed: 1, wrote: 0 },
        { source: "PHONE_CALL", total: 14, closed: 1, wrote: 0 },
      ], avgDaysNewToClosed: 23 }}
    />,
  );
  writeFileSync(path.join(out, "sample-team.pdf"), team);
  console.log("ok", fin.length, team.length);
})();
