import { z } from "zod";
import type { PermissionId } from "./permissions.js";

/**
 * PDF-ОТЧЁТЫ (14.11.2026, просьба владельца: «большой отчёт по деньгам …
 * отправить в PDF, красиво оформленный в стиле Royal Home»).
 *
 * Один договор на сервер (маршрут /report-pdf, рассылка по крону) и экраны
 * (кнопка «PDF»): какие отчёты бывают, какое право открывает каждый и какие
 * параметры периода он принимает. Право — то же, что открывает сам экран
 * отчёта: PDF не может показать больше, чем человек видит в CRM.
 */
export const REPORT_PDF_KINDS = ["finance", "team"] as const;
export const reportPdfKindSchema = z.enum(REPORT_PDF_KINDS);
export type ReportPdfKind = z.infer<typeof reportPdfKindSchema>;

/** Право, без которого отчёт не отдаётся ни файлом, ни в Telegram. */
export const REPORT_PDF_PERMISSION: Readonly<Record<ReportPdfKind, PermissionId>> = {
  finance: "finance.view",
  team: "reports.view",
};

export const REPORT_PDF_TITLES: Readonly<Record<ReportPdfKind, string>> = {
  finance: "Финансовый отчёт",
  team: "Отчёт по команде и заявкам",
};

const monthKey = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/, "Месяц указывается как ГГГГ-ММ");
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата указывается как ГГГГ-ММ-ДД");

/** Финансы: отчётный месяц (по Душанбе) и сколько месяцев истории показать на графике. */
export const financeReportPdfQuerySchema = z.object({
  month: monthKey.optional(),
  months: z.coerce.number().int().min(1).max(24).default(6),
});

/** Команда и заявки: тот же период from/to, что у экрана «Отчёты». */
export const teamReportPdfQuerySchema = z
  .object({ from: dayKey.optional(), to: dayKey.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "Начало периода позже конца", path: ["from"] });

export type FinanceReportPdfQuery = z.infer<typeof financeReportPdfQuerySchema>;
export type TeamReportPdfQuery = z.infer<typeof teamReportPdfQuerySchema>;

/** Имя файла без пробелов и кириллицы — его показывает и браузер, и Telegram. */
export function reportPdfFilename(kind: ReportPdfKind, periodKey: string): string {
  const safe = periodKey.replace(/[^0-9a-zA-Z_-]+/g, "_").slice(0, 40);
  return `royal-home-${kind}-${safe}.pdf`;
}
