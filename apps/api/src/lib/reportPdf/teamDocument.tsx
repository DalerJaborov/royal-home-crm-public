import { View } from "@react-pdf/renderer";
import { CLIENT_SOURCE_LABELS, type ClientSource } from "@royal-home/shared";
import type { AgentReportRow, FunnelCohortStep, FunnelStep, SourcesReport } from "../teamReports.js";
import { BarList, DataTable, FunnelBars, KpiGrid, Note, ReportDocument, Section } from "./kit.js";
import { C, money, num, percent } from "./theme.js";

/**
 * ОТЧЁТ ПО КОМАНДЕ И ЗАЯВКАМ В PDF: воронка, агенты, источники за период —
 * те же расчёты, что на экране «Отчёты» (lib/teamReports.ts). Денежные колонки
 * печатаются только тому, у кого есть право на финансы (seesMoney); без него
 * сервер и не передаёт суммы — здесь колонка просто исчезает.
 */
export const AGENT_ROWS_LIMIT = 300;

/** Простые слова вместо внутренних (лид → заявка). */
export interface TeamReportInput {
  periodLabel: string;
  preparedBy: string;
  generatedAtLabel: string;
  seesMoney: boolean;
  funnel: FunnelStep[];
  /** Путь заявок периода: шаг не больше предыдущего (teamReports.buildFunnelCohort). */
  cohort: FunnelCohortStep[];
  agents: AgentReportRow[];
  sources: SourcesReport;
}

export function TeamReport({ periodLabel, preparedBy, generatedAtLabel, seesMoney, funnel, cohort, agents, sources }: TeamReportInput) {
  const step = (key: string) => funnel.find((x) => x.key === key);
  const leads = step("leads")?.count ?? 0;
  const deals = step("deals");
  const commission = deals?.commission ?? null;
  const cohortLeads = cohort.find((x) => x.key === "leads")?.count ?? 0;
  const cohortDeals = cohort.find((x) => x.key === "deals")?.count ?? 0;
  const ranked = [...agents].sort((a, b) => b.dealsClosed - a.dealsClosed || b.showings - a.showings || a.agentName.localeCompare(b.agentName));
  const shown = ranked.slice(0, AGENT_ROWS_LIMIT);
  const withResult = ranked.filter((a) => a.dealsClosed > 0 || a.showings > 0);

  return (
    <ReportDocument title="Отчёт по команде и заявкам" coverTitle={"Отчёт по команде\nи заявкам"} periodLabel={periodLabel} preparedBy={preparedBy} generatedAtLabel={generatedAtLabel}>
      <Section title="Главное за период" hint="Считается по фактическим записям CRM; вручную ничего не правится.">
        <KpiGrid
          items={[
            seesMoney && commission !== null
              ? { label: "Комиссия по сделкам", value: money(commission), main: true, hint: `Закрыто сделок: ${num(deals?.count ?? 0)}` }
              : { label: "Закрыто сделок", value: num(deals?.count ?? 0), main: true },
            { label: "Новые заявки", value: num(leads) },
            { label: "Показы", value: num(step("showings")?.count ?? 0) },
            { label: "Заявки периода дошли до сделки", value: percent(cohortLeads > 0 ? (cohortDeals / cohortLeads) * 100 : null), hint: sources.avgDaysNewToClosed !== null ? `В среднем от заявки до сделки: ${num(sources.avgDaysNewToClosed)} дн.` : undefined },
          ]}
        />
      </Section>

      <Section
        title="Воронка"
        hint="Заявки, пришедшие за период, и сколько из них дошло до каждого шага к сегодняшнему дню. Шаг засчитан, если клиент дошёл до него или дальше, поэтому каждый шаг не больше предыдущего."
        lead={<FunnelBars steps={cohort.map((x) => ({ label: x.label, count: x.count }))} />}
      />

      <Section title="Команда" hint="Показы и закрытые сделки каждого агента за период. Ушедшие сотрудники со сделками в периоде остаются в списке.">
        {withResult.length > 0 ? (
          <>
            <BarList items={withResult.slice(0, 12).map((a) => ({ label: a.agentName, value: a.dealsClosed }))} color={C.accent} format={(v) => `${num(v)} сд.`} />
            <View style={{ height: 12 }} />
          </>
        ) : null}
        <DataTable
          columns={[
            { title: "Агент", flex: 2.2 },
            { title: "Показы", flex: 0.8, align: "right" },
            { title: "Сделки", flex: 0.8, align: "right" },
            ...(seesMoney ? [{ title: "Комиссия", flex: 1.2, align: "right" as const }] : []),
          ]}
          rows={shown.map((a) => [a.agentName, num(a.showings), num(a.dealsClosed), ...(seesMoney ? [a.commission === null ? "—" : money(a.commission)] : [])])}
          totals={[
            "Итого",
            num(agents.reduce((s, a) => s + a.showings, 0)),
            num(agents.reduce((s, a) => s + a.dealsClosed, 0)),
            ...(seesMoney ? [money(agents.reduce((s, a) => s + (a.commission ?? 0), 0))] : []),
          ]}
          note={agents.length > AGENT_ROWS_LIMIT ? `Показаны первые ${AGENT_ROWS_LIMIT} из ${agents.length}; итог — по всем.` : undefined}
          emptyText="Сотрудников с показами или сделками за период нет."
        />
      </Section>

      <Section title="Откуда приходят клиенты" hint="«Написали» — сколько человек начали переписку в канале; «Заявок» — сколько оставили контакт. Для сайта и звонков это одно и то же, поэтому там «—».">
        <DataTable
          columns={[
            { title: "Канал", flex: 1.8 },
            { title: "Написали", flex: 0.9, align: "right" },
            { title: "Заявок", flex: 0.9, align: "right" },
            { title: "Сделок", flex: 0.8, align: "right" },
            { title: "Заявка → сделка", flex: 1.1, align: "right" },
          ]}
          rows={sources.sources.map((x) => [
            CLIENT_SOURCE_LABELS[x.source as ClientSource] ?? x.source,
            x.wrote > 0 ? num(x.wrote) : "—",
            num(x.total),
            num(x.closed),
            percent(x.total > 0 ? (x.closed / x.total) * 100 : null),
          ])}
          totals={[
            "Итого",
            num(sources.sources.reduce((s, x) => s + x.wrote, 0)),
            num(sources.sources.reduce((s, x) => s + x.total, 0)),
            num(sources.sources.reduce((s, x) => s + x.closed, 0)),
            "",
          ]}
          emptyText="За период новых обращений нет."
        />
        {!seesMoney ? <Note>Денежные колонки скрыты: у этой учётной записи нет доступа к финансам.</Note> : null}
      </Section>
    </ReportDocument>
  );
}
