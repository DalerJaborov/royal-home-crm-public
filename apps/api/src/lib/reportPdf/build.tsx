import {
  REPORT_PDF_PERMISSION,
  financeReportPdfQuerySchema,
  reportPdfFilename,
  teamReportPdfQuerySchema,
  type PermissionId,
  type ReportPdfKind,
} from "@royal-home/shared";
import { investigationRoleFor } from "../../auth/investigations.js";
import { buildExpenseSummary } from "../expenseQueries.js";
import { buildCommissionForecast, currentDushanbeMonth } from "../financeForecast.js";
import { dushanbeDateString } from "../dushanbeTime.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { buildAgentsReport, buildFunnelReport, buildSourcesReport, parseReportRange } from "../teamReports.js";
import { FinanceReport } from "./financeDocument.js";
import { TeamReport } from "./teamDocument.js";
import { renderReportPdf } from "./render.js";
import { dayTitle, dushanbeStamp, monthTitle } from "./theme.js";

/**
 * ОДНА ДВЕРЬ «СОБРАТЬ PDF-ОТЧЁТ»: и кнопка на экране (routes/reportPdf.ts), и
 * рассылка по расписанию (lib/reportPdf/monthlyFinance.ts) зовут только её.
 * Здесь же — проверка права: тот, кто не открывает экран отчёта, не получит
 * и его PDF, какой бы дорогой он ни пришёл.
 */
export interface ReportPdfViewer {
  agentId: string;
  name: string;
  role: string | null;
  can: (permission: PermissionId) => boolean;
}

export class ReportPdfInputError extends Error {
  constructor(
    public readonly status: 400 | 403,
    message: string,
  ) {
    super(message);
  }
}

export interface BuiltReportPdf {
  buffer: Buffer;
  filename: string;
  periodLabel: string;
  /** Ключ периода для журнала действий: «2026-11» или «2026-11-01..2026-11-14». */
  periodKey: string;
}

export function canExportReportPdf(kind: ReportPdfKind, viewer: Pick<ReportPdfViewer, "can">): boolean {
  return viewer.can(REPORT_PDF_PERMISSION[kind]);
}

export async function buildReportPdf(kind: ReportPdfKind, rawQuery: unknown, viewer: ReportPdfViewer, now = new Date()): Promise<BuiltReportPdf> {
  if (!canExportReportPdf(kind, viewer)) throw new ReportPdfInputError(403, "Недостаточно прав");
  const generatedAtLabel = dushanbeStamp(now);

  if (kind === "finance") {
    const parsed = financeReportPdfQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) throw new ReportPdfInputError(400, parsed.error.issues[0]?.message ?? "Неверный период");
    const month = parsed.data.month ?? currentDushanbeMonth(now);
    if (month > currentDushanbeMonth(now)) throw new ReportPdfInputError(400, "Этот месяц ещё не наступил");
    const summary = await buildExpenseSummary({ months: parsed.data.months, through: month });
    // Прогноз — только для текущего месяца (для прошлого исторического снимка нет,
    // как и на экране). Не посчитался — отчёт всё равно нужен, без этого блока.
    let forecast = null;
    if (month === currentDushanbeMonth(now)) {
      try {
        forecast = await buildCommissionForecast(month);
      } catch (err) {
        void logSystemError("api", `PDF финансов: прогноз не посчитан, блок пропущен — ${describeError(err)}`);
      }
    }
    const buffer = await renderReportPdf(
      <FinanceReport month={month} summary={summary} forecast={forecast} preparedBy={viewer.name} generatedAtLabel={generatedAtLabel} />,
    );
    return { buffer, filename: reportPdfFilename(kind, month), periodLabel: monthTitle(month), periodKey: month };
  }

  const parsed = teamReportPdfQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ReportPdfInputError(400, parsed.error.issues[0]?.message ?? "Неверный период");
  let range: { from: Date; to: Date };
  try {
    range = parseReportRange({ from: parsed.data.from, to: parsed.data.to });
  } catch {
    throw new ReportPdfInputError(400, "Неверный период");
  }
  const fromKey = dushanbeDateString(range.from);
  const toKey = dushanbeDateString(range.to);
  const reportViewer = {
    investigationRole: investigationRoleFor(viewer.role, viewer.can("clients.securityReview")),
    seesMoney: viewer.can("finance.view"),
  };
  const [funnel, agents, sources] = await Promise.all([
    buildFunnelReport(range, reportViewer),
    buildAgentsReport(range, reportViewer),
    buildSourcesReport(range),
  ]);
  const periodLabel = fromKey === toKey ? dayTitle(fromKey) : `${dayTitle(fromKey)} – ${dayTitle(toKey)}`;
  const buffer = await renderReportPdf(
    <TeamReport
      periodLabel={periodLabel}
      preparedBy={viewer.name}
      generatedAtLabel={generatedAtLabel}
      seesMoney={reportViewer.seesMoney}
      funnel={funnel}
      agents={agents}
      sources={sources}
    />,
  );
  const periodKey = `${fromKey}..${toKey}`;
  return { buffer, filename: reportPdfFilename(kind, `${fromKey}_${toKey}`), periodLabel, periodKey };
}
