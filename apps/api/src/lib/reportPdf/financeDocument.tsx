import { View } from "@react-pdf/renderer";
import { CLIENT_SOURCE_LABELS, EXPENSE_CATEGORY_LABELS, type ClientSource, type CommissionForecast, type ExpenseCategory } from "@royal-home/shared";
import type { buildExpenseSummary } from "../expenseQueries.js";
import { BarChart, BarList, DataTable, KpiGrid, Note, ReportDocument, Section } from "./kit.js";
import { C, money, monthShort, monthTitle, num, percent } from "./theme.js";

/**
 * ФИНАНСОВЫЙ ОТЧЁТ В PDF. Цифры не считаются здесь заново: на вход идёт ровно
 * тот ответ, что отдаёт экрану «Финансы» GET /expenses/summary
 * (buildExpenseSummary), и прогноз GET /finance/forecast. PDF только раскладывает
 * их по страницам — правило денег одно (lib/money.ts, lib/companyProfit.ts).
 */
export type FinanceSummary = Awaited<ReturnType<typeof buildExpenseSummary>>;
type FinanceMonth = FinanceSummary["months"][number];

/** Сколько строк выплат печатать: дальше — пометка «показаны первые N». */
export const PAYOUT_ROWS_LIMIT = 200;

export interface FinanceReportInput {
  month: string;
  summary: FinanceSummary;
  /** Только для текущего месяца — для прошлого исторического прогноза нет. */
  forecast: CommissionForecast | null;
  preparedBy: string;
  generatedAtLabel: string;
}

function categoryLabel(key: string): string {
  return EXPENSE_CATEGORY_LABELS[key as ExpenseCategory] ?? key;
}

function sourceLabel(key: string): string {
  return CLIENT_SOURCE_LABELS[key as ClientSource] ?? key;
}

export function FinanceReport({ month, summary, forecast, preparedBy, generatedAtLabel }: FinanceReportInput) {
  const months = summary.months;
  const idx = months.findIndex((m) => m.month === month);
  const cur: FinanceMonth | undefined = idx >= 0 ? months[idx] : undefined;
  const prev: FinanceMonth | undefined = idx > 0 ? months[idx - 1] : undefined;
  const periodLabel = monthTitle(month);

  const expenseItems = cur
    ? Object.entries(cur.expenses)
        .map(([k, v]) => ({ label: categoryLabel(k), value: Number(v ?? 0) }))
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];
  const payouts = cur ? [...cur.payouts].sort((a, b) => b.total - a.total) : [];
  const payoutRows = payouts.slice(0, PAYOUT_ROWS_LIMIT);
  const historyTotals = months.reduce(
    (acc, m) => ({ revenue: acc.revenue + m.revenue, company: acc.company + m.companyRevenue, opex: acc.opex + m.operatingExpenses, profit: acc.profit + m.profit }),
    { revenue: 0, company: 0, opex: 0, profit: 0 },
  );

  return (
    <ReportDocument title="Финансовый отчёт" periodLabel={periodLabel} preparedBy={preparedBy} generatedAtLabel={generatedAtLabel}>
      <Section title="Главное за месяц" hint="Всё в сомони; долларовые сделки и расходы пересчитаны по курсу из Настроек CRM.">
        {cur ? (
          <KpiGrid
            items={[
              { label: "Прибыль", value: money(cur.profit), current: cur.profit, previous: prev?.profit, main: true, hint: "Доход компании минус операционные расходы" },
              { label: "Валовая комиссия", value: money(cur.revenue), current: cur.revenue, previous: prev?.revenue, hint: "Всё, что заплатили клиенты по закрытым сделкам" },
              { label: "Доход компании", value: money(cur.companyRevenue), current: cur.companyRevenue, previous: prev?.companyRevenue, hint: `Выплаты риелторам: ${money(cur.realtorPayouts)}` },
              { label: "Операционные расходы", value: money(cur.operatingExpenses), current: cur.operatingExpenses, previous: prev?.operatingExpenses, upIsGood: false, hint: "Без зарплат из сделок — они уже вычтены из дохода" },
            ]}
          />
        ) : (
          <Note>За выбранный месяц сводки нет. Это отсутствие данных, а не нулевой результат.</Note>
        )}
        {cur ? <Note>{`Новых заявок за месяц: ${num(cur.leads)}. Все расходы месяца с зарплатами из сделок: ${money(cur.totalExpenses)}.`}</Note> : null}
      </Section>

      {forecast ? (
        <Section title="Прогноз до конца месяца" hint="Считается по открытым сделкам и темпу месяца — тот же прогноз, что в разделе «Финансы».">
          <KpiGrid
            items={[
              { label: "Ожидаемая валовая комиссия", value: money(forecast.expectedTjs), hint: `Коридор: ${money(forecast.lowTjs)} – ${money(forecast.highTjs)}` },
              { label: "План месяца", value: money(forecast.planTjs), hint: `Прогноз — ${percent(forecast.percentOfPlan)} плана · рабочих дней осталось: ${forecast.workdaysLeft}` },
            ]}
          />
        </Section>
      ) : null}

      <Section
        title={`Динамика за ${months.length} мес.`}
        hint="Доход компании, операционные расходы и прибыль по месяцам."
        lead={<BarChart
          labels={months.map((m) => monthShort(m.month))}
          series={[
            { name: "Доход компании", color: C.accent, values: months.map((m) => m.companyRevenue) },
            { name: "Операционные расходы", color: C.gray, values: months.map((m) => m.operatingExpenses) },
            { name: "Прибыль", color: C.good, values: months.map((m) => m.profit) },
          ]}
        />}
      >
        <View16 />
        <DataTable
          columns={[
            { title: "Месяц", flex: 1.4 },
            { title: "Валовая комиссия", flex: 1.2, align: "right" },
            { title: "Доход компании", flex: 1.2, align: "right" },
            { title: "Расходы", flex: 1.2, align: "right" },
            { title: "Прибыль", flex: 1.2, align: "right" },
            { title: "Заявок", flex: 0.7, align: "right" },
          ]}
          rows={months.map((m) => [monthTitle(m.month), money(m.revenue), money(m.companyRevenue), money(m.operatingExpenses), money(m.profit), num(m.leads)])}
          totals={["Итого", money(historyTotals.revenue), money(historyTotals.company), money(historyTotals.opex), money(historyTotals.profit), num(months.reduce((s, m) => s + m.leads, 0))]}
          note={summary.truncated ? "Внимание: выборка за старые месяцы окна упёрлась в потолок строк — цифры по ним могут быть неполными." : undefined}
        />
      </Section>

      <Section title="Расходы по статьям" hint={`Все оплаченные расходы за ${periodLabel.toLowerCase()}, включая зарплаты из сделок.`} breakBefore>
        {expenseItems.length > 0 ? (
          <>
            <BarList items={expenseItems} format={money} />
            <View16 />
            <DataTable
              columns={[{ title: "Статья", flex: 2 }, { title: "Сумма", flex: 1, align: "right" }, { title: "Доля", flex: 0.7, align: "right" }]}
              rows={expenseItems.map((x) => [x.label, money(x.value), percent(cur && cur.totalExpenses > 0 ? (x.value / cur.totalExpenses) * 100 : null)])}
              totals={["Итого", money(cur?.totalExpenses ?? 0), "100 %"]}
            />
          </>
        ) : (
          <DataTable columns={[]} rows={[]} emptyText="Оплаченных расходов за месяц нет." />
        )}
      </Section>

      <Section title="Выплаты агентам" hint="Доля риелтора по закрытым сделкам месяца: кому сколько причитается и сколько сделок уже выплачено.">
        <DataTable
          columns={[
            { title: "Агент", flex: 2 },
            { title: "Сделок", flex: 0.7, align: "right" },
            { title: "Выплачено", flex: 0.9, align: "right" },
            { title: "К выплате всего", flex: 1.2, align: "right" },
          ]}
          rows={payoutRows.map((p) => [p.name, num(p.deals.length), `${p.deals.filter((d) => d.payoutAt).length} из ${p.deals.length}`, money(p.total)])}
          totals={payoutRows.length > 0 ? ["Итого", num(payouts.reduce((s, p) => s + p.deals.length, 0)), "", money(payouts.reduce((s, p) => s + p.total, 0))] : undefined}
          note={payouts.length > PAYOUT_ROWS_LIMIT ? `Показаны первые ${PAYOUT_ROWS_LIMIT} из ${payouts.length}; итог — по всем.` : undefined}
          emptyText="За месяц нет начисленных долей в закрытых сделках."
        />
      </Section>

      <Section title="Реклама: цена заявки и сделки" hint="Только каналы с рекламным расходом в этом месяце. «—» — заявок или сделок по каналу не было.">
        <DataTable
          columns={[
            { title: "Канал", flex: 1.6 },
            { title: "Расход", flex: 1.1, align: "right" },
            { title: "Заявок", flex: 0.7, align: "right" },
            { title: "Цена заявки", flex: 1, align: "right" },
            { title: "Сделок", flex: 0.7, align: "right" },
            { title: "Цена сделки", flex: 1, align: "right" },
          ]}
          rows={(cur?.costPerLead ?? [])
            .slice()
            .sort((a, b) => b.spent - a.spent)
            .map((r) => [sourceLabel(r.source), money(r.spent), num(r.leads), r.costPerLead === null ? "—" : money(r.costPerLead), num(r.deals), r.costPerDeal === null ? "—" : money(r.costPerDeal)])}
          emptyText="Рекламных расходов по каналам в этом месяце нет."
        />
      </Section>
    </ReportDocument>
  );
}

function View16() {
  return <View style={{ height: 14 }} />;
}
